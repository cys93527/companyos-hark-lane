/**
 * Corrective task provisioner (Sprint 18 / Task-18-05).
 *
 * Turns an already-durable `REQUEST_CORRECTIVE` Decision into ONE durable corrective Task with
 * parent/root/round/cause lineage. It CREATES THE WORK ITEM ONLY: it never executes it, never
 * drives the engine, never captures a repository baseline, never creates a Validation, a Review
 * Report, a Decision or an AgentExecution (T18-06 decides when work runs).
 *
 * Invariants frozen here (Boss rulings):
 *   - the ONLY trigger is a durable, ACTIVE, current-version REQUEST_CORRECTIVE Decision;
 *   - one Decision version → at most one corrective Task, permanently (the derived task id IS
 *     the permanent identity, so a trimmed command ledger cannot cause a duplicate);
 *   - the parent is the WORK task that requires correction, never the review task;
 *   - lineage is derived, never caller-supplied (parent / root / round);
 *   - the child inherits only the parent's execution contract (kind / stage / role /
 *     maxAttempts / work payload) — never status, attempts, outputs, failure, timestamps,
 *     execution ids, baseline, QA or review PASS;
 *   - the frozen WorkflowVersion / RunSnapshot / stage graph are untouched.
 */
import {
  CORRECTIVE_TASK_CAUSES,
  CORRECTIVE_TASK_INPUTS_KEY,
  CORRECTIVE_TASK_SCHEMA,
  correctiveLineageFingerprint,
  correctiveTaskIdOf,
  descendantReassessmentTaskIdOf,
  reassessmentTaskIdOf,
  createTask,
  decodeReviewReport,
  domainError,
  err,
  ok,
  validateCorrectiveLineage,
  workPayloadOf,
  type CorrectiveTaskCause,
  type CorrectiveTaskLineage,
  type DecisionRecord,
  type DomainError,
  type EntityStore,
  type Result,
  type Task,
  type UnitOfWork,
  type WorkflowRun,
  type WorkflowTemplate,
} from '@companyos/core';
import { stageSubjectTaskOf } from '../projection/work-package-projector.js';

export type { CorrectiveTaskLineage };

/** The durable kind of a T17-06 QA evidence report artifact. */
const QA_EVIDENCE_REPORT_KIND = 'companyos/repository-qa-evidence';
/**
 * STAGE 4 P1 closure — the durable report kind the GENERIC validator
 * (`evidence.grounding-check`) materializes through the ValidationService. The corrective
 * cause resolver accepts it alongside the legacy repository QA evidence report, so a
 * VALIDATION.FAIL from a dynamically planned work item is actionable without any
 * software-specific validator.
 */
const EVIDENCE_GROUNDING_REPORT_KIND = 'companyos/evidence-grounding-report';
const ACTIONABLE_VALIDATION_REPORT_KINDS: readonly string[] = [
  QA_EVIDENCE_REPORT_KIND,
  EVIDENCE_GROUNDING_REPORT_KIND,
];
/** The durable kind of a T18-04 review findings artifact. */
const REVIEW_FINDINGS_KIND = 'companyos:review-findings';

/** One resolved cause: the work task that needs correction plus its evidence. */
interface ResolvedCause {
  readonly reasonCode: CorrectiveTaskCause;
  readonly parentTaskId: string;
  readonly causeEvidenceRefs: readonly string[];
  /**
   * Sprint21 final corrective: the task whose canonical FINDING triggered the correction
   * (the finding's producer). The provisioner provisions the next REASSESSMENT round on the
   * producer's own stage, so the loop is autonomous — no external caller, no test helper.
   */
  readonly producerTaskId?: string;
}

export interface ProvisionCorrectiveTaskCommand {
  readonly companyId: string;
  readonly runId: string;
  /** The durable Decision that authorizes the corrective work. */
  readonly decisionId: string;
  /**
   * The exact Decision version to honor. Omitted ⇒ the current (highest) version is used, which
   * is the only version a caller may implicitly rely on.
   */
  readonly decisionVersion?: number | null;
  /** The trusted orchestration identity requesting the work item. */
  readonly actorId: string;
  readonly traceId?: string;
}

export interface ProvisionedTask {
  readonly taskId: string;
  readonly lineage: CorrectiveTaskLineage;
  /** True when this call replayed an already-provisioned task (idempotent). */
  readonly replayed: boolean;
  /**
   * Sprint21 final corrective: the GENERIC REASSESSMENT task provisioned (or found by
   * replay) on the finding producer's stage for this corrective round — the autonomous
   * next re-check step. Null when the cause has no producer task to re-run
   * (VALIDATION_FAILED causes re-run validators through validatorIds instead).
   */
  readonly reassessmentTaskId: string | null;
}

/** Narrow port: the current actionable review report of one review task (T18-04 reader). */
export interface LatestReviewReportPort {
  latestReviewReport(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly reviewTaskId: string;
    readonly actorId: string;
  }): Promise<
    Result<{ readonly artifactId: string; readonly verdict: string } | null, DomainError>
  >;
}

/** The durable rows the provisioner reads (existing stores only). */
interface ArtifactRow {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly contentRef: string;
  readonly createdAt: string;
}

export interface CorrectiveProvisionerDeps {
  readonly runs: EntityStore<WorkflowRun>;
  readonly tasks: EntityStore<Task> & {
    /**
     * T20-03A corrective §12/§13: the creation-identity-guarded write. When the store
     * provides it, corrective creation REPLAYS only on identical creation identity and
     * fails closed on any disagreement (never silently preserving or overwriting).
     */
    putGuarded?(entity: Task): Promise<
      Result<{ readonly taskId: string; readonly replayed: boolean }, DomainError>
    >;
    /** Sprint21 stale-descendant: run-scoped read for descendant-stage inspection. */
    listByRun?(runId: string): Promise<readonly Task[]>;
  };
  readonly templates: EntityStore<WorkflowTemplate>;
  readonly decisions: {
    get(decisionId: string, version?: number | null): Promise<DecisionRecord | null>;
    listVersions(decisionId: string): Promise<readonly DecisionRecord[]>;
  };
  readonly artifacts: {
    get(artifactId: string): Promise<ArtifactRow | null>;
    listByRun(runId: string): Promise<readonly ArtifactRow[]>;
  };
  readonly content: { get(contentRef: string): Promise<Uint8Array> };
  /** Tool invocation rows carry the task that produced each piece of QA evidence. */
  readonly toolInvocations?: {
    get(invocationId: string): Promise<{ readonly id: string; readonly taskId: string } | null>;
  };
  /**
   * STAGE 4 FINAL: the canonical ValidationService batch rows (read-only). The generic
   * validator path resolves a VALIDATION_FAILED corrective cause from the cited failing
   * row itself — no QA evidence artifact required.
   */
  readonly validations?: {
    get(
      validationId: string,
    ): Promise<
      | {
          readonly status: string;
          readonly runId: string;
          readonly stageId: string | null;
          readonly targetRef: string | null;
        }
      | null
      | undefined
    >;
  };
  readonly runSnapshot: {
    verify(input: {
      readonly runId: string;
      readonly snapshotId: string;
    }): Promise<Result<true, DomainError>>;
  };
  readonly reviewReports: LatestReviewReportPort;
  readonly unitOfWork?: UnitOfWork;
  /**
   * Task-18-07: the trusted corrective round ceiling. It is enforced HERE, at the provisioning
   * boundary, so no caller — the autonomous orchestrator or a direct one — can mint a round
   * beyond the cap. Defaults to the V1 Boss ruling (3); trusted configuration may tighten it.
   */
  readonly maxCorrectiveRounds?: number;
}

/** V1 Boss ruling (T18-07 §7): T0 → round 1 → round 2 → round 3, and no round 4. */
export const DEFAULT_MAX_CORRECTIVE_ROUNDS = 3;

export interface CorrectiveProvisioner {
  provision(command: ProvisionCorrectiveTaskCommand): Promise<Result<ProvisionedTask, DomainError>>;
  /** The lineage of one task, cross-verified against its ancestors and its origin Decision. */
  getCorrectiveLineage(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
  }): Promise<Result<CorrectiveTaskLineage | null, DomainError>>;
  /** The corrective children of one work task, deterministic and tenant-scoped. */
  listCorrectiveChildren(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly parentTaskId: string;
  }): Promise<Result<readonly CorrectiveTaskLineage[], DomainError>>;
}

/** Payload shape the T18-03 decision sink stores under `metadata.supervisor`. */
const decisionEnvelopeOf = (
  record: DecisionRecord,
): {
  readonly runId: string;
  readonly action: string;
  readonly reasonCode: string;
  readonly evidenceRefs: readonly { kind: string; ref: string }[];
  /** The failing Validation row the decision cites, when it cites one. */
  readonly validationId?: string;
} | null => {
  const metadata = record.metadata;
  if (typeof metadata !== 'object' || metadata === null) return null;
  const envelope = (metadata as Record<string, unknown>)['supervisor'];
  if (typeof envelope !== 'object' || envelope === null) return null;
  const box = envelope as Record<string, unknown>;
  const refs = Array.isArray(box['evidenceRefs'])
    ? (box['evidenceRefs'] as unknown[]).map((entry) => {
        const item = entry as Record<string, unknown>;
        return { kind: String(item['kind'] ?? ''), ref: String(item['ref'] ?? '') };
      })
    : [];
  const validationId =
    typeof box['validationId'] === 'string'
      ? String(box['validationId'])
      : (refs.find((entry) => entry.kind === 'validation')?.ref ?? '');
  return {
    runId: String(box['runId'] ?? ''),
    action: String(box['action'] ?? record.decision),
    reasonCode: String(box['reasonCode'] ?? ''),
    evidenceRefs: refs,
    ...(validationId === '' ? {} : { validationId }),
  };
};

const lineageOf = (task: Task): CorrectiveTaskLineage | null => {
  const raw = task.inputs[CORRECTIVE_TASK_INPUTS_KEY];
  if (raw === undefined || raw === null) return null;
  const parsed = validateCorrectiveLineage(raw);
  return parsed.ok ? parsed.value : null;
};

export function createCorrectiveProvisioner(
  deps: CorrectiveProvisionerDeps,
): CorrectiveProvisioner {
  /** Every stage of the run's PINNED version graph. */
  const pinnedStages = async (
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

  /**
   * A task must exist, belong to THIS run (T20-03A runId ownership), and sit on a stage of
   * this run's pinned graph (graph legality).
   */
  const requireTaskInRun = async (
    taskId: string,
    run: WorkflowRun,
    stages: readonly string[],
    role: 'parent' | 'chain',
  ): Promise<Result<Task, DomainError>> => {
    const task = await deps.tasks.get(taskId as never);
    if (task === null) {
      return err(
        domainError('NOT_FOUND', `The ${role} task "${taskId}" does not exist.`, {
          reason: 'CORRECTIVE_PARENT_MISSING',
          runId: run.id,
          taskId,
        }),
      );
    }
    // T20-03A (§20): ownership first — a subject task of ANOTHER run is refused even when
    // its stage id exists in this run's pinned graph (same-stage membership must not bypass
    // ownership). The pinned-stage check below stays as the second invariant (graph legality).
    if (String(task.runId) !== String(run.id)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `The ${role} task "${taskId}" belongs to another run.`,
          {
            reason: 'CORRECTIVE_PARENT_RUN_MISMATCH',
            runId: run.id,
            taskId,
            taskRunId: String(task.runId),
          },
        ),
      );
    }
    if (!stages.includes(task.stageId)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `The ${role} task belongs to a stage that is not part of this run's pinned version.`,
          {
            reason: 'CORRECTIVE_PARENT_STAGE_MISMATCH',
            runId: run.id,
            taskId,
          },
        ),
      );
    }
    return ok(task);
  };

  /** The exact, current, actionable Decision that authorizes the corrective work. */
  const loadAuthorizingDecision = async (
    command: ProvisionCorrectiveTaskCommand,
  ): Promise<
    Result<
      { readonly decision: DecisionRecord; readonly action: string; readonly reasonCode: string },
      DomainError
    >
  > => {
    const versions = await deps.decisions.listVersions(command.decisionId);
    if (versions.length === 0) {
      return err(
        domainError('NOT_FOUND', `Decision "${command.decisionId}" does not exist.`, {
          reason: 'CORRECTIVE_DECISION_MISSING',
          decisionId: command.decisionId,
        }),
      );
    }
    const requested = command.decisionVersion ?? null;
    const chosen =
      requested === null
        ? versions.reduce((latest, candidate) =>
            candidate.version > latest.version ? candidate : latest,
          )
        : (versions.find((candidate) => candidate.version === requested) ?? null);
    if (chosen === null) {
      return err(
        domainError(
          'NOT_FOUND',
          `Decision "${command.decisionId}" has no version ${String(requested)}.`,
          { reason: 'CORRECTIVE_DECISION_VERSION_MISSING', decisionId: command.decisionId },
        ),
      );
    }
    if (chosen.companyId !== command.companyId) {
      // Cross-company reads are indistinguishable from a missing decision.
      return err(
        domainError(
          'NOT_FOUND',
          `Decision "${command.decisionId}" does not exist for this company.`,
          { reason: 'CORRECTIVE_DECISION_MISSING', decisionId: command.decisionId },
        ),
      );
    }
    if (chosen.status !== 'ACTIVE') {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Decision "${command.decisionId}" version ${chosen.version} is ${chosen.status}; only the current actionable Decision may authorize corrective work.`,
          {
            reason: 'CORRECTIVE_DECISION_NOT_ACTIONABLE',
            decisionId: command.decisionId,
            version: chosen.version,
            status: chosen.status,
          },
        ),
      );
    }
    const envelope = decisionEnvelopeOf(chosen);
    if (envelope === null) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          'The Decision carries no supervisor envelope; it cannot authorize corrective work.',
          { reason: 'CORRECTIVE_DECISION_ENVELOPE_MISSING', decisionId: command.decisionId },
        ),
      );
    }
    if (envelope.action !== 'REQUEST_CORRECTIVE') {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Only a REQUEST_CORRECTIVE Decision may authorize corrective work (this one is "${envelope.action}").`,
          {
            reason: 'CORRECTIVE_DECISION_ACTION_INVALID',
            decisionId: command.decisionId,
            action: envelope.action,
          },
        ),
      );
    }
    if (envelope.runId !== command.runId) {
      return err(
        domainError('VALIDATION_FAILED', 'The Decision authorizes work for another run.', {
          reason: 'CORRECTIVE_DECISION_RUN_MISMATCH',
          decisionId: command.decisionId,
          decisionRunId: envelope.runId,
          runId: command.runId,
        }),
      );
    }
    if (!(CORRECTIVE_TASK_CAUSES as readonly string[]).includes(envelope.reasonCode)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Corrective cause "${envelope.reasonCode}" has no machine-verifiable V1 contract; it is refused rather than provisioned from free text.`,
          {
            reason: 'CORRECTIVE_CAUSE_UNSUPPORTED',
            decisionId: command.decisionId,
            reasonCode: envelope.reasonCode,
            supportedCauses: [...CORRECTIVE_TASK_CAUSES],
          },
        ),
      );
    }
    return ok({ decision: chosen, action: envelope.action, reasonCode: envelope.reasonCode });
  };

  /** The artifact ids a Decision cited (artifact-shaped refs only). */
  const citedArtifactIds = (decision: DecisionRecord): readonly string[] => {
    const envelope = decisionEnvelopeOf(decision);
    if (envelope === null) return [];
    return envelope.evidenceRefs
      .filter(
        (entry) =>
          entry.kind === 'artifact' &&
          (entry.ref.startsWith('artifact:') || entry.ref.startsWith('art_')),
      )
      .map((entry) =>
        entry.ref.startsWith('artifact:') ? entry.ref.slice('artifact:'.length) : entry.ref,
      );
  };

  /** REVIEW_FINDING: the cause is the current actionable review report of that review task. */
  const resolveReviewCause = async (
    decision: DecisionRecord,
    run: WorkflowRun,
  ): Promise<Result<ResolvedCause, DomainError>> => {
    const cited = citedArtifactIds(decision);
    if (cited.length === 0) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          'A REVIEW_FINDING corrective must cite the durable review report that caused it.',
          { reason: 'CORRECTIVE_CAUSE_EVIDENCE_MISSING', decisionId: decision.decisionId },
        ),
      );
    }
    let cause: ResolvedCause | null = null;
    for (const artifactId of cited) {
      const artifact = await deps.artifacts.get(artifactId);
      if (artifact === null) {
        return err(
          domainError('NOT_FOUND', `The cited review report "${artifactId}" does not exist.`, {
            reason: 'CORRECTIVE_CAUSE_EVIDENCE_MISSING',
            decisionId: decision.decisionId,
            reference: artifactId,
          }),
        );
      }
      if (artifact.kind !== REVIEW_FINDINGS_KIND) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            `The cited evidence "${artifactId}" is not a review report.`,
            {
              reason: 'CORRECTIVE_CAUSE_EVIDENCE_KIND_MISMATCH',
              decisionId: decision.decisionId,
              kind: artifact.kind,
            },
          ),
        );
      }
      if (artifact.runId !== run.id) {
        return err(
          domainError('VALIDATION_FAILED', 'The cited review report belongs to another run.', {
            reason: 'CORRECTIVE_CAUSE_EVIDENCE_CROSS_RUN',
            decisionId: decision.decisionId,
            referenceRunId: artifact.runId,
            runId: run.id,
          }),
        );
      }
      const report = decodeReviewReport(await deps.content.get(artifact.contentRef), {
        runId: run.id,
        companyId: decision.companyId,
      });
      if (!report.ok) return report;
      if (report.value.verdict !== 'CHANGES_REQUESTED') {
        // A PASS or BLOCKED report never authorizes corrective work.
        return err(
          domainError(
            'VALIDATION_FAILED',
            `The review report verdict is "${report.value.verdict}"; only CHANGES_REQUESTED authorizes corrective work.`,
            {
              reason: 'CORRECTIVE_CAUSE_NOT_ACTIONABLE',
              decisionId: decision.decisionId,
              verdict: report.value.verdict,
            },
          ),
        );
      }
      // Anti-cherry-pick: the cause report must still be the CURRENT actionable report of that
      // review task — a newer PASS must not be side-stepped by an older CHANGES_REQUESTED.
      const latest = await deps.reviewReports.latestReviewReport({
        companyId: decision.companyId,
        runId: run.id,
        reviewTaskId: report.value.reviewTaskId,
        actorId: decision.decidedBy,
      });
      if (!latest.ok) return latest;
      if (latest.value === null || latest.value.artifactId !== artifact.id) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The cited review report is no longer the current actionable report of that review task; a newer report supersedes it.',
            {
              reason: 'CORRECTIVE_CAUSE_REPORT_SUPERSEDED',
              decisionId: decision.decisionId,
              citedReport: artifact.id,
              latestReport: latest.value === null ? null : latest.value.artifactId,
            },
          ),
        );
      }
      cause = {
        reasonCode: 'REVIEW_FINDING',
        parentTaskId: report.value.subjectTaskId,
        producerTaskId: String(report.value.reviewTaskId),
        causeEvidenceRefs: [artifact.id],
      };
    }
    if (cause === null) {
      return err(
        domainError('VALIDATION_FAILED', 'No usable review report was cited.', {
          reason: 'CORRECTIVE_CAUSE_EVIDENCE_MISSING',
          decisionId: decision.decisionId,
        }),
      );
    }
    return ok(cause);
  };

  /**
   * VALIDATION_FAILED — the cause is either the failing canonical Validation ROW the decision
   * cites (STAGE 4 FINAL generic-validator path: any validator, e.g. evidence.grounding-check,
   * materialized through the ValidationService) or, for the legacy software QA flow, the
   * latest QA evidence report artifact. The decision's own citations select the path: a
   * validation-kind ref never masquerades as an artifact cause, and an artifact-only citation
   * keeps the frozen repo-QA contract.
   */
  const resolveValidationCause = async (
    decision: DecisionRecord,
    run: WorkflowRun,
    stages: readonly string[],
  ): Promise<Result<ResolvedCause, DomainError>> => {
    const envelope = decisionEnvelopeOf(decision);
    const citedValidationRef =
      envelope === null
        ? undefined
        : envelope.evidenceRefs.find((entry) => entry.kind === 'validation')?.ref;
    const genericValidationId =
      typeof envelope?.validationId === 'string' && envelope.validationId !== ''
        ? envelope.validationId
        : (citedValidationRef ?? undefined);
    if (genericValidationId !== undefined && deps.validations !== undefined) {
      return resolveValidationRowCause(decision, run, stages, genericValidationId);
    }
    return resolveQaEvidenceCause(decision, run, stages);
  };

  /** The generic path: the failing Validation row itself is the corrective cause. */
  const resolveValidationRowCause = async (
    decision: DecisionRecord,
    run: WorkflowRun,
    stages: readonly string[],
    validationId: string,
  ): Promise<Result<ResolvedCause, DomainError>> => {
    const row = await deps.validations?.get(validationId);
    if (row === undefined || row === null) {
      return err(
        domainError('NOT_FOUND', `The cited validation "${validationId}" does not exist.`, {
          reason: 'CORRECTIVE_CAUSE_EVIDENCE_MISSING',
          decisionId: decision.decisionId,
          reference: validationId,
        }),
      );
    }
    if (row.runId !== run.id) {
      return err(
        domainError('VALIDATION_FAILED', 'The cited validation belongs to another run.', {
          reason: 'CORRECTIVE_CAUSE_EVIDENCE_CROSS_RUN',
          decisionId: decision.decisionId,
        }),
      );
    }
    if (row.status !== 'fail' && row.status !== 'error') {
      return err(
        domainError(
          'VALIDATION_FAILED',
          'The cited validation did not fail; a VALIDATION_FAILED corrective is not actionable.',
          { reason: 'CORRECTIVE_CAUSE_NOT_ACTIONABLE', decisionId: decision.decisionId },
        ),
      );
    }
    const stageId = row.stageId ?? null;
    if (stageId === null || !stages.includes(stageId)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          'The cited validation gates a stage outside the pinned execution context.',
          {
            reason: 'CORRECTIVE_CAUSE_STAGE_MISMATCH',
            decisionId: decision.decisionId,
            stageId,
          },
        ),
      );
    }
    // The parent is the work task of that stage that PRODUCED the gated artifact (its
    // durable outputs carry it) — never a name heuristic; when the target ref is not
    // artifact-shaped, an UNAMBIGUOUS terminal stage task may stand in (exactly one).
    const targetArtifactId =
      typeof row.targetRef === 'string' && row.targetRef.startsWith('artifact:')
        ? row.targetRef.slice('artifact:'.length)
        : null;
    const listed = (await deps.tasks.listByRun?.(run.id)) ?? [];
    const runTasks: readonly { id: string; state: string; stageId: string; outputs?: unknown }[] =
      Array.isArray(listed) ? listed : ((listed as { items?: unknown }).items as never) ?? [];
    const inStage = runTasks.filter((task) => task.stageId === stageId);
    const terminal = inStage.filter(
      (task) => task.state === 'DONE' || task.state === 'FAILED',
    );
    const parentTask =
      targetArtifactId === null
        ? undefined
        : inStage.find((task) =>
            JSON.stringify(task.outputs ?? {}).includes(`"${targetArtifactId}"`),
          ) ?? (terminal.length === 1 ? terminal[0] : undefined);
    if (parentTask === undefined) {
      return err(
        domainError('NOT_FOUND', 'The cited validation does not resolve to a work task of this run.', {
          reason: 'CORRECTIVE_PARENT_MISSING',
          runId: run.id,
          decisionId: decision.decisionId,
        }),
      );
    }
    return ok({
      reasonCode: 'VALIDATION_FAILED',
      parentTaskId: parentTask.id,
      causeEvidenceRefs: [
        validationId,
        ...(targetArtifactId === null ? [] : [targetArtifactId]),
      ],
    });
  };

  /** The frozen legacy path: the latest QA evidence report artifact is the cause. */
  const resolveQaEvidenceCause = async (
    decision: DecisionRecord,
    run: WorkflowRun,
    stages: readonly string[],
  ): Promise<Result<ResolvedCause, DomainError>> => {
    const cited = citedArtifactIds(decision);
    if (cited.length === 0) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          'A VALIDATION_FAILED corrective must cite the durable QA evidence report that caused it.',
          { reason: 'CORRECTIVE_CAUSE_EVIDENCE_MISSING', decisionId: decision.decisionId },
        ),
      );
    }
    /*
     * Latest batch wins: the newest QA evidence report of the run is the only actionable one.
     */
    const reports = (await deps.artifacts.listByRun(run.id))
      .filter((artifact) => ACTIONABLE_VALIDATION_REPORT_KINDS.includes(artifact.kind))
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      );
    const latest = reports[0] ?? null;
    for (const artifactId of cited) {
      const artifact = await deps.artifacts.get(artifactId);
      if (artifact === null || !ACTIONABLE_VALIDATION_REPORT_KINDS.includes(artifact.kind)) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The cited evidence is not a durable QA evidence report.',
            {
              reason: 'CORRECTIVE_CAUSE_EVIDENCE_KIND_MISMATCH',
              decisionId: decision.decisionId,
              reference: artifactId,
            },
          ),
        );
      }
      if (artifact.runId !== run.id) {
        return err(
          domainError('VALIDATION_FAILED', 'The cited QA evidence report belongs to another run.', {
            reason: 'CORRECTIVE_CAUSE_EVIDENCE_CROSS_RUN',
            decisionId: decision.decisionId,
          }),
        );
      }
      if (latest === null || latest.id !== artifact.id) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The cited QA evidence report is no longer the latest one for this run; the latest evidence wins.',
            {
              reason: 'CORRECTIVE_CAUSE_REPORT_SUPERSEDED',
              decisionId: decision.decisionId,
              citedReport: artifact.id,
              latestReport: latest === null ? null : latest.id,
            },
          ),
        );
      }
      const parsed = JSON.parse(
        new TextDecoder().decode(await deps.content.get(artifact.contentRef)),
      ) as { verdict?: unknown };
      if (parsed.verdict === 'PASS') {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The latest QA evidence report passed; a VALIDATION_FAILED corrective is not actionable.',
            { reason: 'CORRECTIVE_CAUSE_NOT_ACTIONABLE', decisionId: decision.decisionId },
          ),
        );
      }
      // The parent is the work task the QA evidence was produced FOR: the invocation rows the
      // report cites are durable proof of it (never a stage heuristic).
      if (deps.toolInvocations === undefined) {
        return err(
          domainError(
            'PERSISTENCE_FAILED',
            'Tool invocation evidence is not wired; a VALIDATION_FAILED corrective cannot derive its parent task.',
            {
              reason: 'CORRECTIVE_CAUSE_EVIDENCE_UNAVAILABLE',
              decisionId: decision.decisionId,
            },
          ),
        );
      }
      const invocationIds = Array.isArray((parsed as { evidence?: unknown }).evidence)
        ? Object.values((parsed as { evidence: Record<string, unknown> }).evidence)
            .map((slot) =>
              slot === null ? null : ((slot as Record<string, unknown>)['invocationId'] ?? null),
            )
            .filter((value): value is string => typeof value === 'string')
        : [];
      let parentTaskId: string | null = null;
      for (const invocationId of invocationIds) {
        const invocation = await deps.toolInvocations.get(invocationId);
        if (invocation === null) continue;
        const task = await deps.tasks.get(invocation.taskId as never);
        if (task !== null && stages.includes(task.stageId)) {
          parentTaskId = task.id;
          break;
        }
      }
      if (parentTaskId === null) {
        return err(
          domainError(
            'NOT_FOUND',
            'The cited QA evidence does not resolve to a work task of this run.',
            { reason: 'CORRECTIVE_PARENT_MISSING', runId: run.id, decisionId: decision.decisionId },
          ),
        );
      }
      return ok({
        reasonCode: 'VALIDATION_FAILED',
        parentTaskId,
        causeEvidenceRefs: [artifact.id],
      });
    }
    return err(
      domainError('VALIDATION_FAILED', 'No usable QA evidence report was cited.', {
        reason: 'CORRECTIVE_CAUSE_EVIDENCE_MISSING',
        decisionId: decision.decisionId,
      }),
    );
  };

  const provision = async (
    command: ProvisionCorrectiveTaskCommand,
  ): Promise<Result<ProvisionedTask, DomainError>> => {
    const run = await deps.runs.get(command.runId as never);
    if (run === null || run.companyId !== command.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${command.runId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: command.runId,
        }),
      );
    }
    // The frozen execution context must still be provable before new work is provisioned.
    const pinned = await deps.runSnapshot.verify({ runId: run.id, snapshotId: run.snapshotId });
    if (!pinned.ok) return pinned;

    const stages = await pinnedStages(run);
    if (!stages.ok) return stages;

    const authorized = await loadAuthorizingDecision(command);
    if (!authorized.ok) return authorized;
    const decision = authorized.value.decision;

    const cause =
      authorized.value.reasonCode === 'REVIEW_FINDING'
        ? await resolveReviewCause(decision, run)
        : await resolveValidationCause(decision, run, stages.value);
    if (!cause.ok) return cause;

    const parent = await requireTaskInRun(cause.value.parentTaskId, run, stages.value, 'parent');
    if (!parent.ok) return parent;

    const parentLineage = lineageOf(parent.value);
    const rootTaskId = parentLineage === null ? parent.value.id : parentLineage.rootTaskId;
    const round = (parentLineage === null ? 0 : parentLineage.round) + 1;

    // Task-18-07 §8/§9: the round limit is a TRUSTED INVARIANT at this boundary, not a prompt
    // rule and not something the loop enforces on the caller's behalf. The check happens after
    // the round is derived from the durable lineage and BEFORE any Task row is constructed, so
    // an over-cap request leaves zero work items behind.
    const maxRounds = deps.maxCorrectiveRounds ?? DEFAULT_MAX_CORRECTIVE_ROUNDS;
    if (round > maxRounds) {
      return err(
        domainError(
          'LIMIT_EXCEEDED',
          `Corrective round ${String(round)} exceeds the configured maximum of ${String(maxRounds)}.`,
          {
            reason: 'CORRECTIVE_ROUND_LIMIT_EXCEEDED',
            runId: run.id,
            parentTaskId: parent.value.id,
            rootTaskId,
            derivedRound: round,
            maxCorrectiveRounds: maxRounds,
            decisionId: decision.decisionId,
          },
        ),
      );
    }

    const lineage: CorrectiveTaskLineage = {
      schemaVersion: CORRECTIVE_TASK_SCHEMA,
      companyId: command.companyId,
      runId: run.id,
      originDecisionId: decision.decisionId,
      originDecisionVersion: decision.version,
      reasonCode: cause.value.reasonCode,
      parentTaskId: parent.value.id,
      rootTaskId,
      round,
      causeEvidenceRefs: cause.value.causeEvidenceRefs,
      // Placeholder replaced below: the fingerprint covers every field but itself.
      fingerprint: '',
    };
    const fingerprinted: CorrectiveTaskLineage = {
      ...lineage,
      fingerprint: correctiveLineageFingerprint(lineage),
    };
    const taskId = correctiveTaskIdOf({
      companyId: command.companyId,
      runId: run.id,
      originDecisionId: decision.decisionId,
      originDecisionVersion: decision.version,
    });

    // Permanent idempotency: the derived id IS the identity, so a replay (even after a ledger
    // trim, and even concurrently) lands on the same row — never a second one.
    const work = async (): Promise<Result<ProvisionedTask, DomainError>> => {
      const existing = await deps.tasks.get(taskId as never);
      if (existing !== null) {
        const existingLineage = lineageOf(existing);
        if (existingLineage === null) {
          return err(
            domainError(
              'CONFLICT',
              'A task with this corrective identity carries no readable lineage.',
              {
                reason: 'CORRECTIVE_TASK_LINEAGE_UNREADABLE',
                taskId,
              },
            ),
          );
        }
        // Two independent comparisons, because a stored fingerprint alone is not proof:
        // (a) the stored lineage must be internally consistent — recomputing its own
        //     fingerprint from its fields must reproduce the stored value, otherwise the
        //     row was tampered with after provisioning;
        const recomputed = correctiveLineageFingerprint(existingLineage);
        // (b) it must equal the lineage THIS decision derives, otherwise the same identity
        //     is being asked to carry different content.
        if (
          recomputed !== existingLineage.fingerprint ||
          existingLineage.fingerprint !== fingerprinted.fingerprint
        ) {
          return err(
            domainError(
              'CONFLICT',
              'A corrective task with this identity exists with different lineage content.',
              {
                reason: 'CORRECTIVE_TASK_FINGERPRINT_MISMATCH',
                taskId,
              },
            ),
          );
        }
        const reassessment = await ensureReassessment();
        if (!reassessment.ok) return reassessment;
        const descendants = await ensureDescendantReassessments();
        if (!descendants.ok) return descendants;
        return ok({
          taskId,
          lineage: existingLineage,
          replayed: true,
          reassessmentTaskId: reassessment.value,
        });
      }
      // The child inherits ONLY the parent's execution contract; mutable state is never copied.
      const made = await createTask({
        runId: run.id as never,
        stageId: parent.value.stageId,
        roleId: parent.value.roleId,
        kind: parent.value.kind,
        maxAttempts: parent.value.maxAttempts,
        inputs: {
          ...workPayloadOf(parent.value.inputs),
          [CORRECTIVE_TASK_INPUTS_KEY]: fingerprinted,
        },
        now: new Date().toISOString(),
        ids: {
          id: (prefix?: string) =>
            prefix === undefined || prefix === 'tsk' ? taskId : `${prefix}_${taskId}`,
          ulid: () => taskId,
        },
      });
      if (!made.ok) return made;
      const created = { ...made.value, id: taskId as Task['id'] };
      if (deps.tasks.putGuarded !== undefined) {
        const guarded = await deps.tasks.putGuarded(created);
        if (!guarded.ok) return err(guarded.error);
      } else {
        await deps.tasks.put(created);
      }
      const reassessment = await ensureReassessment();
      if (!reassessment.ok) return reassessment;
      const descendants = await ensureDescendantReassessments();
      if (!descendants.ok) return descendants;
      return ok({
        taskId,
        lineage: fingerprinted,
        replayed: false,
        reassessmentTaskId: reassessment.value,
      });
    };

    /**
     * Sprint21 final corrective (Boss Blocker B): the GENERIC reassessment round. When a
     * canonical FINDING produced by `producerTaskId` triggered this corrective task, the
     * SAME owner provisions the next re-check task ON THE PRODUCER'S OWN STAGE with the
     * producer's pinned execution contract — the loop therefore re-evaluates the corrected
     * work autonomously: the pinned DAG orders it after the corrective task (the producer
     * stage stays non-ready until the subject stage's corrective work is terminal), the
     * next finding (or its absence) drives the next round, and the round cap / consumed-
     * verdict rules bound the loop exactly as before. Identity is derived (one row per
     * corrective, forever); nothing here names an industry, role or stage class.
     */
    const ensureReassessment = async (): Promise<Result<string | null, DomainError>> => {
      const producerId = cause.value.producerTaskId;
      if (producerId === undefined) return ok(null); // validator-driven causes re-run via validatorIds
      const producer = await deps.tasks.get(producerId as never);
      if (producer === null || String(producer.runId) !== String(run.id)) return ok(null);
      const reassessmentId = reassessmentTaskIdOf({
        companyId: command.companyId,
        runId: run.id,
        correctiveTaskId: taskId,
      });
      const existing = await deps.tasks.get(reassessmentId as never);
      if (existing !== null) return ok(reassessmentId); // idempotent: one row per corrective
      const made = await createTask({
        runId: run.id as never,
        stageId: producer.stageId,
        roleId: producer.roleId,
        kind: producer.kind,
        maxAttempts: producer.maxAttempts,
        inputs: {
          'companyos:reassessment': {
            correctiveTaskId: taskId,
            producerTaskId: producerId,
            round,
            originDecisionId: decision.decisionId,
            causeEvidenceRefs: [...cause.value.causeEvidenceRefs],
          },
        },
        now: new Date().toISOString(),
        ids: {
          id: (prefix?: string) =>
            prefix === undefined || prefix === 'tsk' ? reassessmentId : `${prefix}_${reassessmentId}`,
          ulid: () => reassessmentId,
        },
      });
      if (!made.ok) return made;
      const reassessmentTask = { ...made.value, id: reassessmentId as Task['id'] };
      if (deps.tasks.putGuarded !== undefined) {
        const guarded = await deps.tasks.putGuarded(reassessmentTask);
        if (!guarded.ok) return err(guarded.error);
      } else {
        await deps.tasks.put(reassessmentTask);
      }
      return ok(reassessmentId);
    };

    /**
     * Sprint21 stale-descendant ruling (§11-§33): when corrective C changes the canonical
     * output of subject stage S, EVERY strict descendant stage of S (derived from the
     * EXACT run-pinned WorkflowVersion DAG — never timestamps, creation order, current
     * template/pack, never a second graph) that ALREADY owns a canonical successful
     * result gets a deterministic DESCENDANT REASSESSMENT task — provisioned in this same
     * canonical unit, so the descendant stage immediately becomes non-terminal and blocks
     * ITS downstream successors from continuing on the stale result. The reassessment is
     * causally ineligible until C is DONE (same `companyos:reassessment` contract) and it
     * carries the EXISTING corrective lineage (parent = the descendant stage's current
     * canonical subject), so the existing stage-subject authority makes its result the
     * stage's canonical result once settled — no parallel winner hierarchy. Conservative
     * V1 policy: ALL already-authoritative strict descendants are reassessed.
     */
    const ensureDescendantReassessments = async (): Promise<Result<readonly string[], DomainError>> => {
      const template = await deps.templates.get(run.templateId as never);
      if (template === null) return ok([]);
      const version = template.versions.find((entry) => entry.id === run.versionId);
      if (version === undefined) return ok([]);
      const graph = version.graph as {
        nodes: readonly { id: string }[];
        edges: readonly { from: string; to: string }[];
      };
      // Strict descendants of the SUBJECT stage, transitively, from the pinned DAG alone.
      const descendants: string[] = [];
      const frontier = [String(parent.value.stageId)];
      const seen = new Set<string>([String(parent.value.stageId)]);
      while (frontier.length > 0) {
        const stage = frontier.shift() as string;
        for (const edge of graph.edges) {
          if (String(edge.from) !== stage || seen.has(String(edge.to))) continue;
          seen.add(String(edge.to));
          descendants.push(String(edge.to));
          frontier.push(String(edge.to));
        }
      }
      const runTasks =
        deps.tasks.listByRun !== undefined
          ? await deps.tasks.listByRun(run.id as never)
          : (await deps.tasks.list({ limit: 500 })).items.filter(
              (task) => String(task.runId) === String(run.id),
            );
      const created: string[] = [];
      for (const descendantStage of descendants) {
        const stageTasks = runTasks.filter((task) => String(task.stageId) === descendantStage);
        if (stageTasks.length === 0) continue;
        // §13: canonical stage-subject authority decides staleness — a stage that never
        // reached canonical successful completion needs no historical reassessment.
        const subject = stageSubjectTaskOf(stageTasks);
        if (subject === null || subject.state !== 'DONE') continue;
        const id = descendantReassessmentTaskIdOf({
          companyId: command.companyId,
          runId: run.id,
          correctiveTaskId: taskId,
          descendantStageId: descendantStage,
        });
        const existing = await deps.tasks.get(id as never);
        if (existing !== null) {
          created.push(id); // replay: one row per (corrective, descendant stage), forever
          continue;
        }
        // §22 preferred lineage: reuse the EXISTING corrective lineage so the frozen
        // stage-subject authority ("a child always wins over its ancestor") makes this
        // reassessment the stage's canonical subject once settled.
        const subjectLineage = lineageOf(subject);
        const lineageBase = {
          schemaVersion: CORRECTIVE_TASK_SCHEMA,
          companyId: command.companyId,
          runId: run.id,
          originDecisionId: decision.decisionId,
          originDecisionVersion: decision.version,
          reasonCode: cause.value.reasonCode,
          parentTaskId: String(subject.id),
          rootTaskId: subjectLineage === null ? String(subject.id) : String(subjectLineage.rootTaskId),
          round: (subjectLineage === null ? 0 : subjectLineage.round) + 1,
          causeEvidenceRefs: [
            ...cause.value.causeEvidenceRefs,
            `corrective:${String(taskId)}`,
          ],
          fingerprint: '',
        };
        const descendantLineage = {
          ...lineageBase,
          fingerprint: correctiveLineageFingerprint(lineageBase),
        };
        const made = await createTask({
          runId: run.id as never,
          stageId: descendantStage as never,
          roleId: subject.roleId,
          kind: subject.kind,
          maxAttempts: subject.maxAttempts,
          inputs: {
            [CORRECTIVE_TASK_INPUTS_KEY]: descendantLineage,
            'companyos:reassessment': {
              correctiveTaskId: taskId,
              invalidatedSubjectStageId: String(parent.value.stageId),
              previousCanonicalTaskId: String(subject.id),
              round: descendantLineage.round,
              originDecisionId: decision.decisionId,
              causeEvidenceRefs: [...cause.value.causeEvidenceRefs],
            },
          },
          now: new Date().toISOString(),
          ids: {
            id: (prefix?: string) => (prefix === undefined || prefix === 'tsk' ? id : `${prefix}_${id}`),
            ulid: () => id,
          },
        });
        if (!made.ok) return made;
        const reassessmentTask = { ...made.value, id: id as Task['id'] };
        if (deps.tasks.putGuarded !== undefined) {
          const guarded = await deps.tasks.putGuarded(reassessmentTask);
          if (!guarded.ok) return err(guarded.error);
        } else {
          await deps.tasks.put(reassessmentTask);
        }
        created.push(id);
      }
      return ok(created);
    };

    const committed =
      deps.unitOfWork === undefined ? ok(await work()) : await deps.unitOfWork.transaction(work);
    return committed.ok ? committed.value : err(committed.error);
  };

  const getCorrectiveLineage = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
  }): Promise<Result<CorrectiveTaskLineage | null, DomainError>> => {
    const run = await deps.runs.get(input.runId as never);
    if (run === null || run.companyId !== input.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: input.runId,
        }),
      );
    }
    const stages = await pinnedStages(run);
    if (!stages.ok) return stages;
    const task = await deps.tasks.get(input.taskId as never);
    if (task === null || !stages.value.includes(task.stageId)) {
      return err(
        domainError('NOT_FOUND', `Task "${input.taskId}" is not part of this run.`, {
          reason: 'CORRECTIVE_TASK_MISSING',
          runId: input.runId,
          taskId: input.taskId,
        }),
      );
    }
    const lineage = lineageOf(task);
    if (lineage === null) return ok(null);

    // Cross-verify the chain: parents exist, no cycles, rounds and root agree, and the origin
    // Decision really is a REQUEST_CORRECTIVE Decision of this company and run.
    const seen = new Set<string>([input.taskId]);
    let cursor: CorrectiveTaskLineage | null = lineage;
    let expectedRound = lineage.round;
    while (cursor !== null) {
      if (expectedRound !== cursor.round) {
        return err(
          domainError('VALIDATION_FAILED', 'The corrective chain disagrees about its round.', {
            reason: 'CORRECTIVE_LINEAGE_ROUND_MISMATCH',
            taskId: input.taskId,
          }),
        );
      }
      if (cursor.companyId !== input.companyId || cursor.runId !== input.runId) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The corrective lineage belongs to another company or run.',
            { reason: 'CORRECTIVE_LINEAGE_SCOPE_MISMATCH', taskId: input.taskId },
          ),
        );
      }
      const versions = await deps.decisions.listVersions(cursor.originDecisionId);
      const origin =
        versions.find((candidate) => candidate.version === cursor!.originDecisionVersion) ?? null;
      if (origin === null || origin.companyId !== input.companyId) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The corrective lineage cites an origin Decision that does not exist.',
            { reason: 'CORRECTIVE_LINEAGE_DECISION_MISSING', taskId: input.taskId },
          ),
        );
      }
      const originEnvelope = decisionEnvelopeOf(origin);
      if (originEnvelope === null || originEnvelope.action !== 'REQUEST_CORRECTIVE') {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The corrective lineage cites an origin Decision that is not a REQUEST_CORRECTIVE.',
            { reason: 'CORRECTIVE_LINEAGE_DECISION_INVALID', taskId: input.taskId },
          ),
        );
      }
      const parentTask = await deps.tasks.get(cursor.parentTaskId as never);
      if (parentTask === null) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The corrective chain references a parent task that does not exist.',
            { reason: 'CORRECTIVE_LINEAGE_PARENT_MISSING', taskId: input.taskId },
          ),
        );
      }
      if (seen.has(parentTask.id)) {
        return err(
          domainError('VALIDATION_FAILED', 'The corrective chain contains a cycle.', {
            reason: 'CORRECTIVE_LINEAGE_CYCLE',
            taskId: input.taskId,
          }),
        );
      }
      seen.add(parentTask.id);
      const parentLineage = lineageOf(parentTask);
      if (parentLineage === null) {
        // The root work task carries no lineage: the chain ends here.
        if (cursor.rootTaskId !== parentTask.id) {
          return err(
            domainError(
              'VALIDATION_FAILED',
              'The corrective chain root disagrees with its root work task.',
              { reason: 'CORRECTIVE_LINEAGE_ROOT_MISMATCH', taskId: input.taskId },
            ),
          );
        }
        if (cursor.round !== 1) {
          return err(
            domainError('VALIDATION_FAILED', 'A first corrective of the root must be round 1.', {
              reason: 'CORRECTIVE_LINEAGE_ROUND_MISMATCH',
              taskId: input.taskId,
            }),
          );
        }
        cursor = null;
        continue;
      }
      if (parentLineage.rootTaskId !== cursor.rootTaskId) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The corrective chain root disagrees with its parent lineage.',
            { reason: 'CORRECTIVE_LINEAGE_ROOT_MISMATCH', taskId: input.taskId },
          ),
        );
      }
      expectedRound = parentLineage.round;
      cursor = parentLineage;
    }
    return ok(lineage);
  };

  const listCorrectiveChildren = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly parentTaskId: string;
  }): Promise<Result<readonly CorrectiveTaskLineage[], DomainError>> => {
    const run = await deps.runs.get(input.runId as never);
    if (run === null || run.companyId !== input.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: input.runId,
        }),
      );
    }
    const stages = await pinnedStages(run);
    if (!stages.ok) return stages;
    const parent = await deps.tasks.get(input.parentTaskId as never);
    if (parent === null || !stages.value.includes(parent.stageId)) {
      return err(
        domainError('NOT_FOUND', `Task "${input.parentTaskId}" is not part of this run.`, {
          reason: 'CORRECTIVE_TASK_MISSING',
          runId: input.runId,
          taskId: input.parentTaskId,
        }),
      );
    }
    const children: CorrectiveTaskLineage[] = [];
    for (const task of (await deps.tasks.list({ limit: 500 })).items) {
      if (!stages.value.includes(task.stageId)) continue;
      const lineage = lineageOf(task);
      if (lineage === null) continue;
      if (lineage.companyId !== input.companyId || lineage.runId !== input.runId) continue;
      if (lineage.parentTaskId !== input.parentTaskId) continue;
      children.push(lineage);
    }
    // Deterministic: round, then the lineage fingerprint.
    return ok(
      children.sort(
        (left, right) =>
          left.round - right.round || left.fingerprint.localeCompare(right.fingerprint),
      ),
    );
  };

  return { provision, getCorrectiveLineage, listCorrectiveChildren };
}
