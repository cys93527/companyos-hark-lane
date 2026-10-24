/**
 * Review findings sink (Sprint 18 / Task-18-04).
 *
 * Turns a validated reviewer payload into ONE immutable run-owned Artifact, and reads it back:
 *
 *   reviewer (model output → schema parser → trusted runtime)
 *     ↓
 *   this sink                            ← trusted application service, never a Tool, never IPC
 *     ↓
 *   ArtifactService (CAS + permanent creation idempotency)
 *
 * REVIEW IS SEMANTIC EVIDENCE. Recording a report NEVER mutates a task, a stage, a run, a
 * Validation or an Approval, and a PASS verdict is not a QA pass: the six QA evidence slots and
 * the EvidenceGuard remain untouched by this file.
 */
import {
  REVIEW_FINDINGS_ARTIFACT_KIND,
  REVIEW_FINDINGS_LIMITS,
  REVIEW_FINDINGS_SCHEMA,
  decodeReviewReport,
  domainError,
  encodeReviewReport,
  err,
  ok,
  reviewFindingFingerprint,
  reviewFindingIdOf,
  reviewFindingsArtifactFingerprint,
  reviewFindingsCommandId,
  sha256Hex,
  validateReviewFinding,
  validateReviewReport,
  type AgentExecution,
  type Artifact,
  type ArtifactContentStore,
  type ArtifactStorePort,
  type Clock,
  type DomainError,
  type EntityStore,
  type IdFactory,
  type Result,
  type ReviewFinding,
  type ReviewReportPayload,
  type ReviewVerdict,
  type Task,
  type UnitOfWork,
  type WorkflowRun,
  type WorkflowTemplate,
} from '@companyos/core';

import type { ArtifactService } from '../artifact/artifact-service.js';
import type { RunGoalReader } from '../goal/run-goal-service.js';
import type {
  RunModelBindingReader,
  RunModelBindingResolver,
} from '../lifecycle/run-model-bindings.js';
import type { RunSnapshotVerifier } from '../lifecycle/run-snapshot-verifier.js';

export interface DraftFindingInput {
  readonly code: string;
  readonly summary: string;
  readonly detail: string;
  readonly blocking: boolean;
  readonly subject?: string | null;
  readonly locator?: {
    readonly path: string;
    readonly line?: number;
    readonly endLine?: number;
    readonly symbol?: string;
  } | null;
  readonly evidenceRefs?: readonly string[];
}

export interface RecordReviewReportCommand {
  readonly companyId: string;
  readonly runId: string;
  readonly reviewStageId: string;
  readonly reviewTaskId: string;
  readonly subjectTaskId: string;
  /**
   * The durable AgentExecution that produced this review. REQUIRED: a canonical review report
   * may only be recorded for a REAL, COMPLETED reviewer execution. Everything the execution
   * row already owns (attempt, agent, role, the binding actually used) is DERIVED from it —
   * a caller may not state it.
   */
  readonly executionId: string;
  readonly verdict: ReviewVerdict;
  readonly findings: readonly DraftFindingInput[];
  /**
   * Optional CLAIM about which run-pinned binding produced the execution. When supplied it must
   * resolve to exactly the binding the execution record actually used; when omitted the
   * execution’s own binding is used and must still be pinned by this run.
   */
  readonly modelBindingKey?: string | null;
  readonly evidenceRefs?: readonly string[];
  /** The trusted orchestration identity that records the report (the artifact producer). */
  readonly decidedBy: string;
  readonly traceId?: string;
}

export interface ReviewFindingsSinkDeps {
  readonly runs: EntityStore<WorkflowRun>;
  readonly tasks: EntityStore<Task>;
  readonly templates: EntityStore<WorkflowTemplate>;
  readonly agentExecutions: EntityStore<AgentExecution>;
  readonly artifactService: ArtifactService;
  readonly artifactStore: ArtifactStorePort;
  readonly contentStore: ArtifactContentStore;
  readonly runGoal: RunGoalReader;
  readonly runSnapshotVerifier: RunSnapshotVerifier;
  readonly modelBindings: RunModelBindingReader;
  readonly modelRegistry: RunModelBindingResolver;
  readonly durableReferenceResolver?: (
    refs: readonly string[],
  ) => Promise<
    Result<
      readonly {
        readonly kind: string;
        readonly id: string;
        readonly ref: string;
        readonly runId: string;
      }[],
      DomainError
    >
  >;
  readonly unitOfWork?: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdFactory;
}

export interface ReviewReportView {
  readonly artifactId: string;
  readonly contentHash: string;
  /** Creation instant and author, read from the immutable artifact row (the durable source). */
  readonly createdAt: string;
  readonly producedBy: string;
  readonly payload: ReviewReportPayload;
}

export interface ReviewFindingsSink {
  record(command: RecordReviewReportCommand): Promise<Result<ReviewReportView, DomainError>>;
  getReviewReport(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly artifactId: string;
    readonly actorId: string;
  }): Promise<Result<ReviewReportView, DomainError>>;
  /** Every review execution of one review task, deterministic (never latest-pass only). */
  listReviewHistory(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly reviewTaskId: string;
    readonly actorId: string;
  }): Promise<Result<readonly ReviewReportView[], DomainError>>;
  /** The latest report of one review task — the latest report, not the latest PASSING one. */
  getLatestReviewReport(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly reviewTaskId: string;
    readonly actorId: string;
  }): Promise<Result<ReviewReportView | null, DomainError>>;
}

/** The authoritative review execution context, derived from the AgentExecution row. */
interface ReviewExecutionContext {
  readonly executionId: string;
  readonly identity: string;
  readonly attempt: number;
  readonly agentId: string;
  readonly roleId: string;
  readonly binding: {
    readonly modelKey: string;
    readonly providerId: string;
    readonly providerModelId: string;
  };
}

/** One validated evidence reference with its resolved kind. */
interface ResolvedRef {
  readonly kind: string;
  readonly ref: string;
  readonly id: string;
}

export function createReviewFindingsSink(deps: ReviewFindingsSinkDeps): ReviewFindingsSink {
  /* ------------------------------------------------------------------ context proof */

  const pinnedStageIds = async (
    run: WorkflowRun,
  ): Promise<Result<readonly string[], DomainError>> => {
    const template = await deps.templates.get(run.templateId as never);
    if (template === null) {
      return err(
        domainError('NOT_FOUND', `The template pinned by run "${run.id}" is missing.`, {
          reason: 'RUN_SNAPSHOT_TEMPLATE_MISSING',
          runId: run.id,
        }),
      );
    }
    const version = template.versions.find((entry) => entry.id === run.versionId);
    if (version === undefined) {
      return err(
        domainError('NOT_FOUND', `The version pinned by run "${run.id}" is missing.`, {
          reason: 'RUN_SNAPSHOT_VERSION_MISSING',
          runId: run.id,
        }),
      );
    }
    return ok(version.graph.nodes.map((node) => node.id));
  };

  /** A task must exist and belong to a stage of this run's PINNED version graph. */
  const requireTaskInRun = async (
    taskId: string,
    run: WorkflowRun,
    stages: readonly string[],
    role: 'review' | 'subject',
  ): Promise<Result<Task, DomainError>> => {
    const task = await deps.tasks.get(taskId as never);
    if (task === null) {
      // A missing task and a task of another company are indistinguishable here.
      return err(
        domainError(
          'NOT_FOUND',
          `The ${role} task "${taskId}" does not exist; a review report cannot anchor to it.`,
          {
            reason: role === 'review' ? 'REVIEW_TASK_MISSING' : 'REVIEW_SUBJECT_TASK_MISSING',
            runId: run.id,
            taskId,
          },
        ),
      );
    }
    if (!stages.includes(task.stageId)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `The ${role} task belongs to a stage that is not part of this run’s pinned version.`,
          {
            reason:
              role === 'review' ? 'REVIEW_TASK_STAGE_MISMATCH' : 'REVIEW_SUBJECT_STAGE_MISMATCH',
            runId: run.id,
            taskId,
            stageId: task.stageId,
          },
        ),
      );
    }
    return ok(task);
  };

  /**
   * THE canonical review execution identity (T18-04 corrective): the AgentExecution row.
   *
   * There is no TASK_ATTEMPT fallback: the AgentExecution contract durably owns runId, taskId,
   * roleId, agentId, attempt and the binding actually selected, so ownership IS provable and a
   * report without a real execution would be an unverifiable claim. Only a COMPLETED execution
   * may produce a report.
   */
  const resolveReviewExecution = async (
    command: RecordReviewReportCommand,
    reviewTask: Task,
    run: WorkflowRun,
  ): Promise<Result<ReviewExecutionContext, DomainError>> => {
    if (typeof command.executionId !== 'string' || command.executionId.trim() === '') {
      return err(
        domainError(
          'INVALID_ARGUMENT',
          'A canonical review report requires the AgentExecution that produced it.',
          {
            reason: 'REVIEW_EXECUTION_REQUIRED',
          },
        ),
      );
    }
    const execution = await deps.agentExecutions.get(command.executionId as never);
    if (execution === null) {
      return err(
        domainError('NOT_FOUND', `AgentExecution "${command.executionId}" does not exist.`, {
          reason: 'REVIEW_EXECUTION_MISSING',
          executionId: command.executionId,
        }),
      );
    }
    if (execution.runId !== run.id) {
      return err(
        domainError('VALIDATION_FAILED', 'The cited AgentExecution belongs to another run.', {
          reason: 'REVIEW_EXECUTION_RUN_MISMATCH',
          executionId: command.executionId,
          executionRunId: execution.runId,
          runId: run.id,
        }),
      );
    }
    if (execution.taskId !== reviewTask.id) {
      return err(
        domainError('VALIDATION_FAILED', 'The cited AgentExecution belongs to another task.', {
          reason: 'REVIEW_EXECUTION_TASK_MISMATCH',
          executionId: command.executionId,
          executionTaskId: execution.taskId,
          reviewTaskId: reviewTask.id,
        }),
      );
    }
    // A report may only describe an execution that actually produced a result.
    if (execution.status !== 'COMPLETED') {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `An AgentExecution in status "${execution.status}" cannot produce a review report.`,
          {
            reason: 'REVIEW_EXECUTION_NOT_COMPLETED',
            executionId: command.executionId,
            status: execution.status,
          },
        ),
      );
    }
    return ok({
      executionId: execution.executionId,
      identity: `execution:${execution.executionId}`,
      attempt: execution.attempt,
      agentId: execution.agentId,
      roleId: execution.roleId,
      binding: {
        modelKey: execution.modelKey,
        providerId: execution.providerId,
        providerModelId: execution.providerModelId,
      },
    });
  };

  /**
   * Model provenance derived from the execution, then proven against the run-pinned bindings.
   *
   * "The run also pins this model" is NOT enough: the report must be attributable to the model
   * that ACTUALLY ran the review, which only the execution row knows.
   */
  const resolveReviewBinding = async (
    command: RecordReviewReportCommand,
    run: WorkflowRun,
    execution: {
      readonly binding: {
        readonly modelKey: string;
        readonly providerId: string;
        readonly providerModelId: string;
      };
    },
  ): Promise<
    Result<{ readonly bindingKey: string | null; readonly resolvedModelKey: string }, DomainError>
  > => {
    const snapshot = await deps.runSnapshotVerifier.verify({
      runId: run.id,
      snapshotId: run.snapshotId,
    });
    if (!snapshot.ok) return snapshot;
    // Every run-pinned binding, resolved to its concrete model key.
    const bindings = await deps.modelBindings.get({ runId: run.id, companyId: command.companyId });
    if (!bindings.ok) return bindings;
    const pinned: { name: string; modelKey: string }[] = [];
    for (const [name] of Object.entries(bindings.value)) {
      const resolved = await deps.modelBindings.resolve(
        { runId: run.id, companyId: command.companyId, bindingName: name },
        deps.modelRegistry,
      );
      if (!resolved.ok) continue;
      pinned.push({ name, modelKey: resolved.value.modelKey });
    }
    const usedByExecution = pinned.find((entry) => entry.modelKey === execution.binding.modelKey);
    if (usedByExecution === undefined) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          'The AgentExecution ran a model this run never pinned; a review report cannot claim it.',
          {
            reason: 'REVIEW_EXECUTION_BINDING_NOT_PINNED',
            executionModelKey: execution.binding.modelKey,
            runId: run.id,
          },
        ),
      );
    }
    const claimed = command.modelBindingKey ?? null;
    if (claimed !== null) {
      const claimedEntry = pinned.find((entry) => entry.name === claimed);
      if (claimedEntry === undefined || claimedEntry.modelKey !== execution.binding.modelKey) {
        // Rejected even when the claimed name IS pinned: the execution did not use it.
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The claimed binding is not the binding the AgentExecution actually used.',
            {
              reason: 'REVIEW_EXECUTION_BINDING_MISMATCH',
              claimedBinding: claimed,
              executionModelKey: execution.binding.modelKey,
            },
          ),
        );
      }
      return ok({ bindingKey: claimed, resolvedModelKey: execution.binding.modelKey });
    }
    return ok({ bindingKey: usedByExecution.name, resolvedModelKey: execution.binding.modelKey });
  };
  const validateEvidence = async (
    refs: readonly string[],
    run: WorkflowRun,
    limit: number,
  ): Promise<Result<readonly ResolvedRef[], DomainError>> => {
    if (refs.length > limit) {
      return err(
        domainError(
          'INVALID_ARGUMENT',
          `A review report may carry at most ${limit} evidence refs.`,
          { reason: 'REVIEW_EVIDENCE_TOO_MANY' },
        ),
      );
    }
    for (const ref of refs) {
      if (typeof ref !== 'string' || ref.trim() === '') {
        return err(domainError('INVALID_ARGUMENT', 'Evidence refs must be non-empty strings.'));
      }
    }
    if (deps.durableReferenceResolver === undefined) {
      return err(
        domainError(
          'PERSISTENCE_FAILED',
          'Evidence refs were supplied but no durable reference resolver is wired; refusing to record unverified provenance.',
          {
            reason: 'DURABLE_REFERENCE_RESOLVER_UNAVAILABLE',
          },
        ),
      );
    }
    const resolved = await deps.durableReferenceResolver(refs);
    if (!resolved.ok) return resolved;
    for (const reference of resolved.value) {
      if (reference.runId !== run.id) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            `Evidence "${reference.ref}" belongs to another run; a review report may only cite its own run's evidence.`,
            {
              reason: 'REVIEW_EVIDENCE_CROSS_RUN',
              runId: run.id,
              reference: reference.ref,
              referenceRunId: reference.runId,
            },
          ),
        );
      }
    }
    return ok(
      resolved.value.map((reference) => ({
        kind: reference.kind,
        ref: reference.ref,
        id: reference.id,
      })),
    );
  };

  const rejectModelIdentity = (command: RecordReviewReportCommand): Result<true, DomainError> => {
    const raw = command as unknown as Record<string, unknown>;
    for (const forbidden of [
      'providerId',
      'providerModelId',
      'modelKey',
      'modelVersion',
      'model',
      'reviewer',
      'reviewAttempt',
      'roleId',
      'agentId',
    ]) {
      if (raw[forbidden] !== undefined) {
        return err(
          domainError(
            'INVALID_ARGUMENT',
            `A review report must not carry "${forbidden}"; supply the run-pinned binding name instead.`,
            {
              reason: 'REVIEW_MODEL_IDENTITY_REJECTED',
              field: forbidden,
            },
          ),
        );
      }
    }
    return ok(true);
  };

  /* ------------------------------------------------------------------------- record */

  const record = async (
    command: RecordReviewReportCommand,
  ): Promise<Result<ReviewReportView, DomainError>> => {
    const shape = validateReviewReport({ verdict: command.verdict, findings: command.findings });
    if (!shape.ok) return shape;
    const clean = rejectModelIdentity(command);
    if (!clean.ok) return clean;

    const run = await deps.runs.get(command.runId as never);
    if (run === null || run.companyId !== command.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${command.runId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: command.runId,
        }),
      );
    }

    // §33: a review belongs to a run that HAS a canonical goal.
    const goal = await deps.runGoal.get({ runId: run.id, companyId: command.companyId });
    if (!goal.ok) {
      return err(
        domainError(
          'NOT_FOUND',
          `Run "${run.id}" has no canonical goal; a review report cannot be recorded without one.`,
          { reason: 'RUN_GOAL_MISSING', runId: run.id },
        ),
      );
    }

    // §34: prove the run's execution context through the ONE canonical verifier.
    const pinned = await deps.runSnapshotVerifier.verify({
      runId: run.id,
      snapshotId: run.snapshotId,
    });
    if (!pinned.ok) return pinned;

    const stages = await pinnedStageIds(run);
    if (!stages.ok) return stages;

    const reviewTask = await requireTaskInRun(command.reviewTaskId, run, stages.value, 'review');
    if (!reviewTask.ok) return reviewTask;
    if (command.reviewStageId !== reviewTask.value.stageId) {
      return err(
        domainError('VALIDATION_FAILED', 'The review stage does not belong to the review task.', {
          reason: 'REVIEW_TASK_STAGE_MISMATCH',
          runId: run.id,
          reviewTaskId: command.reviewTaskId,
          reviewStageId: command.reviewStageId,
          taskStageId: reviewTask.value.stageId,
        }),
      );
    }

    const subjectTask = await requireTaskInRun(command.subjectTaskId, run, stages.value, 'subject');
    if (!subjectTask.ok) return subjectTask;
    if (subjectTask.value.id === reviewTask.value.id) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          'A review report must name a subject task other than the review task itself.',
          {
            reason: 'REVIEW_SUBJECT_TASK_IS_REVIEW_TASK',
            runId: run.id,
          },
        ),
      );
    }

    const execution = await resolveReviewExecution(command, reviewTask.value, run);
    if (!execution.ok) return execution;

    // Model provenance is DERIVED from the execution and then proven against the run pin.
    const binding = await resolveReviewBinding(command, run, execution.value);
    if (!binding.ok) return binding;

    const reportRefs = await validateEvidence(
      command.evidenceRefs ?? [],
      run,
      REVIEW_FINDINGS_LIMITS.maxEvidenceRefsPerReport,
    );
    if (!reportRefs.ok) return reportRefs;

    // Findings: validate each, derive identity + fingerprint, dedupe deterministically.
    const seen = new Map<string, ReviewFinding>();
    for (const [index, draft] of command.findings.entries()) {
      const validated = validateReviewFinding(draft, {
        runId: run.id,
        reviewTaskId: reviewTask.value.id,
        index,
      });
      if (!validated.ok) return validated;
      const findingRefs = await validateEvidence(
        validated.value.evidenceRefs,
        run,
        REVIEW_FINDINGS_LIMITS.maxEvidenceRefsPerFinding,
      );
      if (!findingRefs.ok) return findingRefs;
      const fingerprint = reviewFindingFingerprint({
        code: validated.value.code,
        blocking: validated.value.blocking,
        summary: validated.value.summary,
        detail: validated.value.detail,
        subject: validated.value.subject ?? null,
        locator: validated.value.locator ?? null,
        evidenceRefs: [...findingRefs.value.map((reference) => reference.ref)].sort(),
      });
      const previous = seen.get(fingerprint);
      if (previous !== undefined) {
        // Deterministic canonical dedupe: one semantic finding is one problem, never two.
        continue;
      }
      seen.set(fingerprint, {
        findingId: reviewFindingIdOf({
          runId: run.id,
          reviewTaskId: reviewTask.value.id,
          code: validated.value.code,
          blocking: validated.value.blocking,
          summary: validated.value.summary,
          detail: validated.value.detail,
          subject: validated.value.subject ?? null,
          locator: validated.value.locator ?? null,
          evidenceRefs: [...findingRefs.value.map((reference) => reference.ref)].sort(),
        }),
        code: validated.value.code,
        summary: validated.value.summary,
        detail: validated.value.detail,
        blocking: validated.value.blocking,
        subject: validated.value.subject ?? null,
        locator: validated.value.locator ?? null,
        evidenceRefs: [...findingRefs.value.map((reference) => reference.ref)].sort(),
        fingerprint,
      });
    }
    const findings = [...seen.values()];

    // The verdict rules are re-checked AFTER dedupe, so a report can never smuggle a blocking
    // finding past a PASS verdict.
    const rechecked = validateReviewReport({
      verdict: command.verdict,
      findings: findings.map((f) => ({ blocking: f.blocking })),
    });
    if (!rechecked.ok) return rechecked;

    const traceId = command.traceId ?? deps.ids.id('trace');
    const artifactRefs = reportRefs.value.map((reference) => reference.ref);
    const payload: ReviewReportPayload = {
      schemaVersion: REVIEW_FINDINGS_SCHEMA,
      companyId: command.companyId,
      runId: run.id,
      reviewStageId: reviewTask.value.stageId,
      reviewTaskId: reviewTask.value.id,
      reviewExecutionId: execution.value.executionId,
      reviewAttempt: execution.value.attempt,
      subjectTaskId: subjectTask.value.id,
      verdict: command.verdict,
      findings,
      // Everything authoritative about the reviewer comes from the execution row.
      reviewer: {
        agentId: execution.value.agentId,
        roleId: execution.value.roleId,
        executionId: execution.value.executionId,
        decidedBy: command.decidedBy,
      },
      executionBinding: execution.value.binding,
      modelBindingKey: binding.value.bindingKey,
      resolvedModelKey: binding.value.resolvedModelKey,
      evidenceRefs: artifactRefs,
    };

    // The report-level semantic fingerprint travels inside the payload for audit; the
    // ArtifactService computes the authoritative permanent fingerprint over this exact content.
    const content = encodeReviewReport(payload);
    const withSemanticFingerprint: ReviewReportPayload = {
      ...payload,
      reportFingerprint: reviewFindingsArtifactFingerprint({
        companyId: payload.companyId,
        runId: payload.runId,
        reviewStageId: payload.reviewStageId,
        reviewTaskId: payload.reviewTaskId,
        reviewExecutionId: payload.reviewExecutionId,
        reviewAttempt: payload.reviewAttempt,
        subjectTaskId: payload.subjectTaskId,
        verdict: payload.verdict,
        findings: payload.findings.map((finding) => ({
          findingId: finding.findingId,
          fingerprint: finding.fingerprint,
        })),
        reviewer: payload.reviewer,
        executionBinding: payload.executionBinding,
        modelBindingKey: payload.modelBindingKey,
        resolvedModelKey: payload.resolvedModelKey,
        evidenceRefs: payload.evidenceRefs,
        contentDigest: sha256Hex(new TextDecoder().decode(content)),
      }),
    };
    const bytes = encodeReviewReport(withSemanticFingerprint);
    const created = await deps.artifactService.create({
      // Tenant-scoped permanent identity: company first, then run, review task, execution.
      commandId: reviewFindingsCommandId(
        command.companyId,
        run.id,
        reviewTask.value.id,
        execution.value.identity,
      ),
      runId: run.id,
      taskId: reviewTask.value.id,
      kind: REVIEW_FINDINGS_ARTIFACT_KIND,
      content: bytes,
      producedBy: command.decidedBy,
      traceId,
    });
    if (!created.ok) return created;

    return ok({
      artifactId: created.value.id,
      contentHash: created.value.contentHash,
      createdAt: created.value.createdAt,
      producedBy: created.value.producedBy,
      payload: withSemanticFingerprint,
    });
  };

  /* -------------------------------------------------------------------------- reads */

  const readArtifact = async (
    artifact: Artifact,
    expected: { readonly companyId: string; readonly runId: string },
  ): Promise<Result<ReviewReportView, DomainError>> => {
    if (artifact.kind !== REVIEW_FINDINGS_ARTIFACT_KIND) {
      return err(
        domainError('VALIDATION_FAILED', 'The artifact is not a review report.', {
          reason: 'REVIEW_REPORT_KIND_MISMATCH',
        }),
      );
    }
    if (String(artifact.runId) !== expected.runId) {
      return err(
        domainError('VALIDATION_FAILED', 'The review report belongs to another run.', {
          reason: 'REVIEW_REPORT_RUN_MISMATCH',
        }),
      );
    }
    const bytes = await deps.contentStore.get(artifact.contentRef);
    const payload = decodeReviewReport(bytes, expected);
    if (!payload.ok) return payload;
    return ok({
      artifactId: artifact.id,
      contentHash: artifact.contentHash,
      createdAt: artifact.createdAt,
      producedBy: artifact.producedBy,
      payload: payload.value,
    });
  };

  const listForRun = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly actorId: string;
  }): Promise<Result<readonly Artifact[], DomainError>> => {
    const artifacts = await deps.artifactStore.listByRun(input.runId as never);
    const ofRun: Artifact[] = [];
    for (const artifact of artifacts) {
      if (artifact.kind !== REVIEW_FINDINGS_ARTIFACT_KIND) continue;
      const decoded = await readArtifact(artifact, {
        companyId: input.companyId,
        runId: input.runId,
      });
      // A report that does not belong to this company is invisible, never an error.
      if (!decoded.ok) continue;
      ofRun.push(artifact);
    }
    return ok(ofRun);
  };

  return {
    record,

    async getReviewReport(input) {
      // Reads are structurally scoped: the artifact must belong to this run AND decode to
      // this company (readArtifact), so a foreign tenant is indistinguishable from absent.
      const artifact = await deps.artifactStore.get(input.artifactId as never);
      if (artifact === null) {
        return err(
          domainError('NOT_FOUND', `Review report "${input.artifactId}" does not exist.`, {
            artifactId: input.artifactId,
          }),
        );
      }
      return readArtifact(artifact, { companyId: input.companyId, runId: input.runId });
    },

    async listReviewHistory(input) {
      const artifacts = await listForRun(input);
      if (!artifacts.ok) return artifacts;
      const views: ReviewReportView[] = [];
      for (const artifact of artifacts.value) {
        const decoded = await readArtifact(artifact, {
          companyId: input.companyId,
          runId: input.runId,
        });
        if (!decoded.ok) continue;
        if (decoded.value.payload.reviewTaskId !== input.reviewTaskId) continue;
        views.push(decoded.value);
      }
      // Deterministic: attempt/execution sequence, then createdAt, then artifactId.
      return ok(
        views.sort(
          (left, right) =>
            left.payload.reviewAttempt - right.payload.reviewAttempt ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.artifactId.localeCompare(right.artifactId),
        ),
      );
    },

    async getLatestReviewReport(input) {
      const history = await this.listReviewHistory(input);
      if (!history.ok) return history;
      // The LATEST report — never the latest passing one (anti-cherry-pick, §25/§26).
      return ok(history.value.length === 0 ? null : history.value[history.value.length - 1]!);
    },
  };
}
