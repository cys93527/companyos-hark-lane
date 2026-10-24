/**
 * Supervisor decision sink (Sprint 18 / Task-18-03) — the ONE durable decision writer.
 *
 * Before this task `DecisionStore` existed with ZERO production writers. This service is the
 * first: a trusted orchestration layer records a decision, the record is immutable, and the
 * write is idempotent PERMANENTLY — not through the bounded command ledger, which can be
 * trimmed, but through the decision table's own primary key.
 *
 * Identity design (no migration, no new table, no new authority):
 *   - `decisionId` is DERIVED from the caller's trusted command identity, so one logical
 *     decision has exactly one durable row, forever (`PRIMARY KEY(decision_id, version)`).
 *   - the decision fingerprint is stored inside the existing `metadata` versioned payload
 *     seam, so a replayed command with the same identity but different content is a
 *     `CONFLICT` even after the ledger entry was trimmed.
 *
 * It RECORDS ONLY. It never executes: no task creation, no run/stage/task transition, no
 * approval, no notification, no repository mutation, no model call. Execution semantics
 * belong to T18-06/T18-07.
 */
import {
  DECISION_EVENT_TYPES,
  FAULT_CHECKPOINTS,
  createDecisionRecord,
  domainError,
  err,
  ok,
  sha256Hex,
  type Clock,
  type CreateDecisionInput,
  type DecisionStatus,
  type DecisionRecord,
  type DecisionStorePort,
  DomainError,
  type EntityStore,
  type FaultCheckpointPort,
  type IdFactory,
  type Result,
  type Task,
  type UnitOfWork,
  type WorkflowRun,
  type WorkflowTemplate,
} from '@companyos/core';

import type { RunGoalReader } from '../goal/run-goal-service.js';
import type {
  RunModelBindingReader,
  RunModelBindingResolver,
} from '../lifecycle/run-model-bindings.js';
import type { RunSnapshotVerifier } from '../lifecycle/run-snapshot-verifier.js';

/** Envelope version of the supervisor decision payload carried in `DecisionRecord.metadata`. */
export const SUPERVISOR_DECISION_SCHEMA = 'companyos/supervisor-decision/1';

/**
 * V1 action vocabulary (T18-01 §7). Closed set; anything else is a domain refusal.
 * `REQUEST_CORRECTIVE` records the INTENT — creating corrective work is T18-05's job.
 */
export const SUPERVISOR_DECISION_ACTIONS = [
  'CONTINUE',
  'REQUEST_CORRECTIVE',
  'ESCALATE',
  'COMPLETE',
] as const;
export type SupervisorDecisionAction = (typeof SUPERVISOR_DECISION_ACTIONS)[number];

/**
 * Reason codes, converging on the existing domain taxonomy so no second vocabulary appears.
 * Reused where a code already exists (`VALIDATION_FAILED`, `NOT_FOUND`, …); the remaining
 * names describe the decision's SOURCE CLASS, which no existing code carries.
 */
export const SUPERVISOR_DECISION_REASONS = [
  'VALIDATION_FAILED',
  'REVIEW_FINDING',
  'TASK_FAILED',
  'TOOL_FAILED',
  'GOAL_SATISFIED',
  'HUMAN_REQUIRED',
  'NO_LEGAL_ACTION',
] as const;
export type SupervisorDecisionReason = (typeof SUPERVISOR_DECISION_REASONS)[number];

/** Actions that may not be recorded without durable evidence (§53). */
const EVIDENCE_REQUIRED: readonly SupervisorDecisionAction[] = [
  'REQUEST_CORRECTIVE',
  'ESCALATE',
  'COMPLETE',
];

export const SUPERVISOR_DECISION_COMMAND_PREFIX = 'supervisor-decision';

/** Trusted command identity: `supervisor-decision:<runId>:<logicalDecisionIdentity>`. */
export const supervisorDecisionCommandId = (runId: string, logicalIdentity: string): string =>
  `${SUPERVISOR_DECISION_COMMAND_PREFIX}:${runId}:${logicalIdentity}`;

/**
 * TENANT-SCOPED deterministic decision identity (T18-03 corrective).
 *
 * Why the company is part of the hash: `command_ledger.command_id` is a global PRIMARY KEY,
 * but it is BOUNDED (trimmable) and this sink never writes a ledger row — so a supervisor
 * decision command identity is a plain string chosen by the trusted orchestration layer with
 * NO enforceable global uniqueness. Two companies may legitimately pick the same identity
 * (`supervisor-decision:<runId>:intent` with colliding run-id spaces, or a copied identity),
 * and a company-scoped hash must then produce DIFFERENT decision ids so that neither a primary
 * key collision nor a cross-tenant existence leak is possible. The `dec_` prefix keeps the
 * existing id convention; the length keeps the row well inside the column.
 */
export const SUPERVISOR_DECISION_ID_NAMESPACE = 'companyos/supervisor-decision/1';

export const supervisorDecisionIdOf = (companyId: string, commandId: string): string =>
  `dec_${sha256Hex(`${SUPERVISOR_DECISION_ID_NAMESPACE}:${companyId}:${commandId}`).slice(0, 26)}`;

/**
 * Canonical, deterministic fingerprint over every input that changes the decision's meaning —
 * company first, so a same-command replay from another tenant can never match a fingerprint.
 */
export const supervisorDecisionFingerprint = (input: {
  readonly companyId: string;
  readonly commandId: string;
  readonly runId: string;
  readonly stageId: string | null;
  readonly taskId: string | null;
  readonly action: SupervisorDecisionAction;
  readonly reasonCode: SupervisorDecisionReason;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly modelBindingKey: string | null;
}): string =>
  sha256Hex(
    JSON.stringify({
      purpose: 'supervisor.decision.record',
      namespace: SUPERVISOR_DECISION_ID_NAMESPACE,
      companyId: input.companyId,
      commandId: input.commandId,
      runId: input.runId,
      stageId: input.stageId,
      taskId: input.taskId,
      action: input.action,
      reasonCode: input.reasonCode,
      summary: input.summary,
      evidenceRefs: [...input.evidenceRefs].sort(),
      modelBindingKey: input.modelBindingKey,
    }),
  );

/** One validated evidence reference, carrying the kind the durable resolver resolved it to. */
export interface ResolvedEvidenceRef {
  readonly kind: string;
  readonly ref: string;
  readonly id: string;
}
export interface RecordSupervisorDecisionCommand {
  /** Trusted orchestration identity — see `supervisorDecisionCommandId`. */
  readonly commandId: string;
  readonly companyId: string;
  readonly runId: string;
  readonly stageId?: string | null;
  readonly taskId?: string | null;
  readonly action: SupervisorDecisionAction;
  readonly reasonCode: SupervisorDecisionReason;
  readonly summary: string;
  /** Durable evidence: `artifact:art_<id>` / `art_<id>` / `val_<id>` only (existing grammar). */
  readonly evidenceRefs?: readonly string[];
  /** Run-pinned binding name; resolved through `RunSnapshot.modelBindings` — never a model id. */
  readonly modelBindingKey?: string | null;
  /**
   * F5-C — COMMIT AUTHORITY anchor: the AgentExecution that owns this decision turn.
   * When supplied, the sink commits ONLY while that execution is still RUNNING; once
   * a deadline/cancellation canonically won (execution terminal), the uncommitted
   * decision has LOST its authority to commit and is refused — inside the same
   * transaction as the insert, so the execution state and the decision row can never
   * disagree about the winner.
   */
  readonly authorizedExecutionId?: string;
  /** The decision maker (trusted orchestration identity), reused from the existing field. */
  readonly decidedBy: string;
  readonly traceId?: string;
}

export interface SupervisorDecisionSinkDeps {
  readonly runs: EntityStore<WorkflowRun>;
  readonly tasks: EntityStore<Task>;
  readonly templates: EntityStore<WorkflowTemplate>;
  readonly decisions: DecisionStorePort;
  readonly runGoal: RunGoalReader;
  readonly runSnapshotVerifier: RunSnapshotVerifier;
  /**
   * 9dc9943 — the durable POST-COMMIT stamp: it lands ONLY while the owning execution
   * is still RUNNING, NOT already committed, and its DURABLE decision-authority expiry
   * is still valid — all inside the SAME transaction as the Decision insert. TRUE =
   * this transaction holds the commit authority; FALSE = the owner is terminal, already
   * committed, or its authority EXPIRED (the late sink can never create Decision truth).
   * Optional: without it the gate is inert (fixture-grade sinks only).
   */
  readonly commitOutcomeOf?: (
    executionId: string,
    decisionId: string,
    at: string,
    nowIso: string,
  ) => Promise<boolean>;
  readonly modelBindings: RunModelBindingReader;
  readonly modelRegistry: RunModelBindingResolver;
  /**
   * Optional: when wired, evidence refs are resolved durably before the write. Structurally the
   * shared resolver of Sprint 13 (Task-13-09) — identity + the row's durable run anchor.
   */
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
  readonly authorize: (input: {
    readonly actorId: string;
    readonly authority: 'decision.create' | 'decision.read';
    readonly scopeId?: string;
  }) => Promise<Result<true, DomainError>>;
  readonly unitOfWork?: UnitOfWork;
  /** 4a6e362 (N4-A1) — the INSIDE-TRANSACTION checkpoints: the sink write window and the pre-COMMIT tail. */
  readonly faultCheckpoints?: FaultCheckpointPort;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly audit?: {
    emit(
      type: string,
      payload: {
        decisionId: string;
        version: number;
        actorId: string;
        status: string;
        traceId: string;
      },
    ): Promise<void>;
  };
}

export interface SupervisorDecisionReader {
  /** One decision by identity — tenant-scoped; a foreign tenant is indistinguishable from absent. */
  getDecision(input: {
    readonly decisionId: string;
    readonly companyId: string;
    readonly actorId: string;
  }): Promise<Result<DecisionRecord, DomainError>>;
  /**
   * The FULL run decision history for audit and future Supervisor recovery: every legal status
   * the Decision domain has (ACTIVE, SUPERSEDED, REVOKED — whatever the store still holds), in
   * deterministic chronological order. Never active-only.
   */
  listRunDecisionHistory(input: {
    readonly runId: string;
    readonly companyId: string;
    readonly actorId: string;
  }): Promise<Result<readonly DecisionRecord[], DomainError>>;
  /** The ACTIVE decisions of one run, as a separately named query — never a synonym for history. */
  listActiveRunDecisions(input: {
    readonly runId: string;
    readonly companyId: string;
    readonly actorId: string;
  }): Promise<Result<readonly DecisionRecord[], DomainError>>;
}

export interface SupervisorDecisionSink extends SupervisorDecisionReader {
  record(command: RecordSupervisorDecisionCommand): Promise<Result<DecisionRecord, DomainError>>;
  decisionIdOf(companyId: string, commandId: string): string;
}

/* ------------------------------------------------------------------ helpers */

const isRecordShape = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Read the versioned payload back out of a durable record (or null when absent/foreign). */
export const supervisorDecisionPayloadOf = (
  record: DecisionRecord,
): {
  readonly fingerprint: string;
  readonly runId: string;
  readonly companyId: string;
  /** F5-A: the exact execution that produced the Decision (null on pre-F5-A rows). */
  readonly executionId: string | null;
} | null => {
  const metadata = record.metadata;
  if (!isRecordShape(metadata)) return null;
  const envelope = metadata['supervisor'];
  if (!isRecordShape(envelope)) return null;
  if (envelope['schema'] !== SUPERVISOR_DECISION_SCHEMA) return null;
  const fingerprint = envelope['fingerprint'];
  const runId = envelope['runId'];
  const companyId = envelope['companyId'];
  if (typeof fingerprint !== 'string' || typeof runId !== 'string' || typeof companyId !== 'string')
    return null;
  const executionId = envelope['executionId'];
  return {
    fingerprint,
    runId,
    companyId,
    executionId: typeof executionId === 'string' && executionId !== '' ? executionId : null,
  };
};

/** Control characters other than tab/newline/carriage return: a summary is prose. */
const hasControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x7f) return true;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
};
export function createSupervisorDecisionSink(
  deps: SupervisorDecisionSinkDeps,
): SupervisorDecisionSink {
  /* ------------------------------------------------------------- validation */

  const validateShape = (command: RecordSupervisorDecisionCommand): Result<true, DomainError> => {
    if (typeof command.commandId !== 'string' || command.commandId.trim() === '') {
      return err(
        domainError('INVALID_ARGUMENT', 'A supervisor decision needs a trusted command identity.'),
      );
    }
    if (!command.commandId.startsWith(`${SUPERVISOR_DECISION_COMMAND_PREFIX}:`)) {
      return err(
        domainError(
          'INVALID_ARGUMENT',
          `A supervisor decision command identity must start with "${SUPERVISOR_DECISION_COMMAND_PREFIX}:".`,
          {
            reason: 'SUPERVISOR_DECISION_COMMAND_ID_INVALID',
          },
        ),
      );
    }
    if (typeof command.companyId !== 'string' || command.companyId.trim() === '') {
      return err(domainError('INVALID_ARGUMENT', 'A supervisor decision must name its company.'));
    }
    if (typeof command.runId !== 'string' || command.runId.trim() === '') {
      return err(domainError('INVALID_ARGUMENT', 'A supervisor decision must name its run.'));
    }
    if (typeof command.decidedBy !== 'string' || command.decidedBy.trim() === '') {
      return err(
        domainError('INVALID_ARGUMENT', 'A supervisor decision must name its decision maker.'),
      );
    }
    if (!(SUPERVISOR_DECISION_ACTIONS as readonly string[]).includes(command.action)) {
      return err(
        domainError(
          'INVALID_ARGUMENT',
          `Unknown supervisor decision action "${String(command.action)}".`,
          {
            reason: 'SUPERVISOR_DECISION_ACTION_INVALID',
            action: String(command.action),
          },
        ),
      );
    }
    if (!(SUPERVISOR_DECISION_REASONS as readonly string[]).includes(command.reasonCode)) {
      return err(
        domainError(
          'INVALID_ARGUMENT',
          `Unknown supervisor decision reason "${String(command.reasonCode)}".`,
          {
            reason: 'SUPERVISOR_DECISION_REASON_INVALID',
            reasonCode: String(command.reasonCode),
          },
        ),
      );
    }
    const summary = typeof command.summary === 'string' ? command.summary.trim() : '';
    if (summary === '' || summary.length > 4_000) {
      return err(
        domainError(
          'INVALID_ARGUMENT',
          'A supervisor decision needs a non-empty summary of at most 4000 characters.',
          {
            reason: 'SUPERVISOR_DECISION_SUMMARY_INVALID',
          },
        ),
      );
    }
    if (hasControlCharacters(summary)) {
      return err(
        domainError('INVALID_ARGUMENT', 'A supervisor decision summary must be plain text.'),
      );
    }
    return ok(true);
  };

  /**
   * A caller must never be able to hand the sink a model identity: the only accepted form is
   * a run-pinned binding NAME, which is then resolved through the run's own snapshot.
   */
  const rejectModelIdentityFields = (
    command: RecordSupervisorDecisionCommand,
  ): Result<true, DomainError> => {
    const raw = command as unknown as Record<string, unknown>;
    for (const forbidden of [
      'providerId',
      'providerModelId',
      'modelKey',
      'modelVersion',
      'model',
    ]) {
      if (raw[forbidden] !== undefined) {
        return err(
          domainError(
            'INVALID_ARGUMENT',
            `A supervisor decision must not carry "${forbidden}"; supply the run-pinned binding name instead.`,
            {
              reason: 'SUPERVISOR_DECISION_MODEL_IDENTITY_REJECTED',
              field: forbidden,
            },
          ),
        );
      }
    }
    return ok(true);
  };

  /** Every stage of the run's PINNED version graph, so a foreign stage id is refused. */
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

  const validateStageAndTask = async (
    command: RecordSupervisorDecisionCommand,
    run: WorkflowRun,
  ): Promise<
    Result<{ readonly stageId: string | null; readonly taskId: string | null }, DomainError>
  > => {
    const stageId = command.stageId ?? null;
    const taskId = command.taskId ?? null;
    if (stageId === null && taskId === null) return ok({ stageId: null, taskId: null });

    const stages = await pinnedStageIds(run);
    if (!stages.ok) return stages;

    if (taskId !== null) {
      const task = await deps.tasks.get(taskId as never);
      if (task === null) {
        // A task that does not exist and a task of another company are indistinguishable here.
        return err(
          domainError(
            'NOT_FOUND',
            `Task "${taskId}" does not exist; a supervisor decision cannot anchor to it.`,
            {
              reason: 'SUPERVISOR_DECISION_TASK_MISSING',
              runId: run.id,
              taskId,
            },
          ),
        );
      }
      /*
       * T20-03A: ownership is exact runId equality — checked BEFORE any stage/graph test.
       * A task of another run (even one sharing this company, this WorkflowVersion and this
       * very stage id) fails closed here; the pinned-stage check below remains what it
       * always was: graph legality.
       */
      if (String(task.runId) !== String(run.id)) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            `Task "${taskId}" belongs to another run; a supervisor decision cannot anchor to it.`,
            {
              reason: 'SUPERVISOR_DECISION_TASK_RUN_MISMATCH',
              runId: run.id,
              taskId,
              taskRunId: String(task.runId),
            },
          ),
        );
      }
      if (!stages.value.includes(task.stageId)) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The task belongs to a stage that is not part of this run’s pinned version.',
            {
              reason: 'SUPERVISOR_DECISION_TASK_STAGE_MISMATCH',
              runId: run.id,
              taskId,
              stageId: task.stageId,
            },
          ),
        );
      }
      if (stageId !== null && stageId !== task.stageId) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'The decision names a stage the task does not belong to.',
            {
              reason: 'SUPERVISOR_DECISION_TASK_STAGE_MISMATCH',
              runId: run.id,
              taskId,
              stageId,
              taskStageId: task.stageId,
            },
          ),
        );
      }
      return ok({ stageId: task.stageId, taskId });
    }

    if (!stages.value.includes(stageId as string)) {
      return err(
        domainError('VALIDATION_FAILED', 'The stage is not part of this run’s pinned version.', {
          reason: 'SUPERVISOR_DECISION_STAGE_MISMATCH',
          runId: run.id,
          stageId: String(stageId),
        }),
      );
    }
    return ok({ stageId, taskId: null });
  };

  /**
   * Validate every evidence ref through the shared durable resolver (existing grammar only:
   * `artifact:art_<id>` / `art_<id>` / `val_<id>` — nothing invented), and require each resolved
   * reference to belong to THIS run. The result carries the resolved kind, because
   * `DecisionRecord.relatedArtifactRefs` is contractually an ARTIFACT-only field: a Validation
   * identity must never be disguised as an artifact ref, it is carried in the payload seam
   * instead (T18-03 corrective §Q/§S).
   */
  const validateEvidence = async (
    command: RecordSupervisorDecisionCommand,
    run: WorkflowRun,
  ): Promise<Result<readonly ResolvedEvidenceRef[], DomainError>> => {
    const refs = [...(command.evidenceRefs ?? [])];
    if (refs.length === 0) {
      if (EVIDENCE_REQUIRED.includes(command.action)) {
        return err(
          domainError(
            'INVALID_ARGUMENT',
            `A "${command.action}" supervisor decision requires durable evidence refs.`,
            {
              reason: 'SUPERVISOR_DECISION_EVIDENCE_REQUIRED',
              action: command.action,
            },
          ),
        );
      }
      return ok([]);
    }
    if (refs.length > 64) {
      return err(
        domainError(
          'INVALID_ARGUMENT',
          'A supervisor decision may reference at most 64 evidence refs.',
          {
            reason: 'SUPERVISOR_DECISION_EVIDENCE_TOO_MANY',
          },
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
            `Evidence "${reference.ref}" belongs to another run; a supervisor decision may only cite its own run's evidence.`,
            {
              reason: 'SUPERVISOR_DECISION_EVIDENCE_CROSS_RUN',
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

  const validateBinding = async (
    command: RecordSupervisorDecisionCommand,
    run: WorkflowRun,
  ): Promise<Result<string | null, DomainError>> => {
    const key = command.modelBindingKey ?? null;
    if (key === null) return ok(null);
    if (typeof key !== 'string' || key.trim() === '') {
      return err(
        domainError(
          'INVALID_ARGUMENT',
          'A model binding name must be a non-empty string when supplied.',
        ),
      );
    }
    const resolved = await deps.modelBindings.resolve(
      { runId: run.id, companyId: command.companyId, bindingName: key },
      deps.modelRegistry,
    );
    if (!resolved.ok) return resolved;
    return ok(resolved.value.modelKey);
  };

  /* ------------------------------------------------------------------ write */

  const record = async (
    command: RecordSupervisorDecisionCommand,
  ): Promise<Result<DecisionRecord, DomainError>> => {
    const permitted = await deps.authorize({
      actorId: command.decidedBy,
      authority: 'decision.create',
      scopeId: command.runId,
    });
    if (!permitted.ok) return permitted;

    const shaped = validateShape(command);
    if (!shaped.ok) return shaped;
    const clean = rejectModelIdentityFields(command);
    if (!clean.ok) return clean;

    const run = await deps.runs.get(command.runId as never);
    if (run === null || run.companyId !== command.companyId) {
      // Cross-company reads are indistinguishable from a missing run: no existence oracle.
      return err(
        domainError('NOT_FOUND', `Run "${command.runId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: command.runId,
        }),
      );
    }

    // §11: a decision belongs to a run that HAS a canonical goal. No goal ⇒ no guessing.
    const goal = await deps.runGoal.get({ runId: run.id, companyId: command.companyId });
    if (!goal.ok) {
      return err(
        domainError(
          'NOT_FOUND',
          `Run "${run.id}" has no canonical goal; a supervisor decision cannot be recorded without one.`,
          {
            reason: 'RUN_GOAL_MISSING',
            runId: run.id,
          },
        ),
      );
    }

    // §12: prove the run's execution context through the ONE canonical verifier (T18-02).
    const pinned = await deps.runSnapshotVerifier.verify({
      runId: run.id,
      snapshotId: run.snapshotId,
    });
    if (!pinned.ok) return pinned;

    const anchors = await validateStageAndTask(command, run);
    if (!anchors.ok) return anchors;
    const evidenceRefs = await validateEvidence(command, run);
    if (!evidenceRefs.ok) return evidenceRefs;
    const bindingModelKey = await validateBinding(command, run);
    if (!bindingModelKey.ok) return bindingModelKey;

    const summary = command.summary.trim();
    const evidenceRefStrings = evidenceRefs.value.map((reference) => reference.ref);
    const fingerprint = supervisorDecisionFingerprint({
      companyId: command.companyId,
      commandId: command.commandId,
      runId: run.id,
      stageId: anchors.value.stageId,
      taskId: anchors.value.taskId,
      action: command.action,
      reasonCode: command.reasonCode,
      summary,
      evidenceRefs: evidenceRefStrings,
      modelBindingKey: bindingModelKey.value,
    });
    const decisionId = supervisorDecisionIdOf(command.companyId, command.commandId);
    const traceId = command.traceId ?? deps.ids.id('trace');

    const payload: Record<string, unknown> = {
      schema: SUPERVISOR_DECISION_SCHEMA,
      companyId: command.companyId,
      runId: run.id,
      stageId: anchors.value.stageId,
      taskId: anchors.value.taskId,
      action: command.action,
      reasonCode: command.reasonCode,
      summary,
      // Each ref keeps its resolved kind, so a Validation identity is never disguised as an
      // artifact reference (§Q/§S).
      evidenceRefs: evidenceRefs.value.map((reference) => ({
        kind: reference.kind,
        ref: reference.ref,
        id: reference.id,
      })),
      modelBindingKey: command.modelBindingKey ?? null,
      resolvedModelKey: bindingModelKey.value,
      commandId: command.commandId,
      fingerprint,
      /*
       * F5-A — EXECUTION PROVENANCE: the exact AgentExecution that produced this Decision.
       * The single-flight exemption and the durable illegal-proposal budget prove "this
       * execution is decision-bearing" through THIS field — never through the run-level
       * traceId, which ONE autonomy call shares across ALL of its turns (a different turn's
       * Decision must never authorize, nor reset the budget of, another execution).
       */
      executionId: command.authorizedExecutionId ?? null,
      // Explicit: a recorded decision is a durable fact, never an executed effect (§55).
      executionStatus: 'RECORDED_ONLY',
    };

    const draft: Omit<CreateDecisionInput, 'decisionId' | 'decidedAt' | 'version'> & {
      decisionId: string;
    } = {
      decisionId,
      companyId: command.companyId,
      scope:
        anchors.value.taskId === null
          ? { type: 'WORKFLOW', id: run.id }
          : { type: 'TASK', id: anchors.value.taskId },
      subjectKey: command.commandId,
      title: `${command.action} — ${command.reasonCode}`,
      question: goal.value.objective,
      decision: command.action,
      rationale: `${command.reasonCode}: ${summary}`,
      alternativesConsidered: [],
      constraints: [],
      consequences: [],
      relatedMemoryRefs: [],
      relatedHandoffRefs: [],
      // Contractually artifact-only: every entry here resolved to an Artifact row of this run.
      relatedArtifactRefs: evidenceRefs.value
        .filter((reference) => reference.kind === 'artifact')
        .map((reference) => reference.ref),
      decidedBy: command.decidedBy,
      traceId,
      provenance: {
        sourceType: 'WORKFLOW',
        sourceRefs: [`run:${run.id}`, `snapshot:${run.snapshotId}`, ...evidenceRefStrings],
      },
      metadata: { supervisor: payload },
    };

    /*
     * 9dc9943 — THE ATOMIC DECISION TRANSACTION. The work function either returns ok
     * (COMMIT) or THROWS a typed DomainError (ROLLBACK): a Result.err returned from
     * inside the callback is a normal completion to the UnitOfWork and would COMMIT —
     * that is how an orphan outcome marker used to survive a failed Decision insert.
     * The outer `record` maps the abort back to Result.err OUTSIDE the boundary.
     */
    const work = async (): Promise<Result<DecisionRecord, DomainError>> => {
      // Permanent idempotency: read the durable row by derived identity FIRST. A second
      // insert can never happen for the same logical decision, even with an empty ledger.
      const existing = await deps.decisions.get(decisionId, 1);
      if (existing !== null) {
        const replayed = replayOrConflict(existing, fingerprint, run.id);
        if (!replayed.ok) throw replayed.error;
        return replayed;
      }

      /*
       * F5-C-R1 — COMMIT AUTHORITY (durable post-commit ownership). Inside the SAME
       * transaction as the insert, STAMP the owning execution's outcome-committed
       * marker while the row is still RUNNING. The stamp is the durable fact later
       * settlement arbitration reads:
       *   - stamped    → this Decision committed while the owner had authority; a later
       *                  generic cancel/timeout/failure can never reinterpret the turn
       *                  (it converges to the committed COMPLETED state instead);
       *   - not stamped→ the owner is terminal/lost: the uncommitted decision has LOST
       *                  its authority and is refused — no Decision can ever appear.
       * A read-only status check would leave a window between check and commit; the
       * single conditional UPDATE closes it (one SQL statement decides the winner).
       */
      if (command.authorizedExecutionId !== undefined && deps.commitOutcomeOf !== undefined) {
        const nowIso = deps.clock.nowIso();
        const stamped = await deps.commitOutcomeOf(
          command.authorizedExecutionId,
          decisionId,
          nowIso,
          nowIso,
        );
        if (!stamped) {
          throw domainError(
            'CONFLICT',
            'The execution that owns this decision is no longer RUNNING (or its decision authority expired); the uncommitted decision has lost its authority to commit.',
            {
              reason: 'SUPERVISOR_DECISION_EXECUTION_TERMINAL',
              executionId: command.authorizedExecutionId,
              decisionId,
            },
          );
        }
      }

      const made = createDecisionRecord({ ...draft, version: 1 });
      if (!made.ok) throw made.error;
      try {
        await deps.decisions.create(made.value);
      } catch (error) {
        // A concurrent writer won the race: recover that row and apply the same rule.
        const raced = await deps.decisions.get(decisionId, 1);
        if (raced !== null) {
          const resolution = replayOrConflict(raced, fingerprint, run.id);
          if (!resolution.ok) throw resolution.error; // rollback: no marker survives
          return resolution;
        }
        throw domainError(
          'PERSISTENCE_FAILED',
          'The decision row could not be written; the transaction ABORTS so no committed-outcome marker can survive without its Decision.',
          { cause: String(error) },
        );
      }
      return ok(made.value);
    };

    // One transaction for the decision row (and, through it, the event/ledger outcome the
    // audit seam emits). The UnitOfWork envelope is unwrapped exactly once here.
    /*
     * 4a6e362 (N4-A1) — the two diagnostic checkpoints AROUND the ONE decision-commit
     * transaction. They exist so a harness can slow THIS commit (the canonical "slow
     * sink" shape) without touching any other transaction on the shared connection:
     *   - before: the sink has not yet OBTAINED its write window (no transaction open,
     *     no write order held) — the deadline race proceeds immediately;
     *   - after: the transaction has finished (committed or rolled back) and the caller
     *     has not resumed yet.
     * Production wires no port and executes exactly the code it always executed.
     */
    await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.decisionCommitBeforeTransaction);
    let committed: Result<Result<DecisionRecord, DomainError>, DomainError>;
    try {
      committed =
        deps.unitOfWork === undefined
          ? await (async (): Promise<Result<Result<DecisionRecord, DomainError>, DomainError>> => {
              try {
                return ok(await work());
              } catch (error) {
                return err(
                  error instanceof DomainError
                    ? error
                    : domainError('PERSISTENCE_FAILED', error instanceof Error ? error.message : String(error)),
                );
              }
            })()
          : await deps.unitOfWork.transaction(work);
    } finally {
      // Fires on EVERY exit of the commit (success, replay or abort) so an observer can
      // always pair the two windows.
      await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.decisionCommitAfterTransaction);
    }
    const written = committed.ok ? committed.value : err(committed.error);
    if (written.ok) {
      await deps.audit?.emit(DECISION_EVENT_TYPES[0], {
        decisionId: written.value.decisionId,
        version: written.value.version,
        actorId: command.decidedBy,
        status: written.value.status,
        traceId,
      });
    }
    return written;
  };

  /** Same identity + same fingerprint ⇒ the original record; different ⇒ CONFLICT (§30/§31). */
  const replayOrConflict = (
    existing: DecisionRecord,
    fingerprint: string,
    runId: string,
  ): Result<DecisionRecord, DomainError> => {
    const payload = supervisorDecisionPayloadOf(existing);
    if (payload === null) {
      return err(
        domainError(
          'CONFLICT',
          'A decision with this identity exists and was not written by the supervisor sink.',
          {
            reason: 'SUPERVISOR_DECISION_IDENTITY_FOREIGN',
            decisionId: existing.decisionId,
          },
        ),
      );
    }
    if (payload.runId !== runId) {
      return err(
        domainError('CONFLICT', 'A decision with this identity exists for a different run.', {
          reason: 'SUPERVISOR_DECISION_IDENTITY_CROSS_RUN',
          decisionId: existing.decisionId,
        }),
      );
    }
    if (payload.fingerprint !== fingerprint) {
      return err(
        domainError('CONFLICT', 'Supervisor decision command reused with different content.', {
          reason: 'SUPERVISOR_DECISION_FINGERPRINT_MISMATCH',
          decisionId: existing.decisionId,
        }),
      );
    }
    return ok(existing);
  };

  /* ------------------------------------------------------------------ reads */

  const getDecision = async (input: {
    readonly decisionId: string;
    readonly companyId: string;
    readonly actorId: string;
  }): Promise<Result<DecisionRecord, DomainError>> => {
    const permitted = await deps.authorize({
      actorId: input.actorId,
      authority: 'decision.read',
      scopeId: input.decisionId,
    });
    if (!permitted.ok) return permitted;
    const found = await deps.decisions.get(input.decisionId, 1);
    if (found === null || found.companyId !== input.companyId) {
      return err(
        domainError(
          'NOT_FOUND',
          `Decision "${input.decisionId}" does not exist for this company.`,
          { decisionId: input.decisionId },
        ),
      );
    }
    return ok(found);
  };

  const listRunDecisions = async (
    input: {
      readonly runId: string;
      readonly companyId: string;
      readonly actorId: string;
    },
    statuses: readonly DecisionStatus[],
  ): Promise<Result<readonly DecisionRecord[], DomainError>> => {
    const permitted = await deps.authorize({
      actorId: input.actorId,
      authority: 'decision.read',
      scopeId: input.runId,
    });
    if (!permitted.ok) return permitted;
    // TENANT FIRST: the store read is a whole-database scan, so the company filter must come
    // before any run judgement, and no row of another company may ever reach the caller.
    const allowed = new Set(statuses);
    const ofRun = (await deps.decisions.listAll()).filter((row) => {
      if (row.companyId !== input.companyId) return false;
      if (!allowed.has(row.status)) return false;
      const payload = supervisorDecisionPayloadOf(row);
      return payload !== null && payload.runId === input.runId;
    });
    // Deterministic order from the record's own keys (never SQLite's incidental row order):
    // chronological, then decision identity, then version.
    return ok(
      ofRun.sort(
        (left, right) =>
          left.decidedAt.localeCompare(right.decidedAt) ||
          left.decisionId.localeCompare(right.decisionId) ||
          left.version - right.version,
      ),
    );
  };

  return {
    record,
    getDecision,
    listRunDecisionHistory: (input) => listRunDecisions(input, ['ACTIVE', 'SUPERSEDED', 'REVOKED']),
    listActiveRunDecisions: (input) => listRunDecisions(input, ['ACTIVE']),
    decisionIdOf: supervisorDecisionIdOf,
  };
}
