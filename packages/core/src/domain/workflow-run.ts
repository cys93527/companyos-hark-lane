/**
 * WorkflowRun — one real business execution (规划书 §四 Core 概念 6 "Workflow Run").
 *
 * A run:
 *   - is pinned to exactly one immutable Workflow Version + Run Snapshot (§十一);
 *   - advances ONLY through the L1 machine (`run-state.ts`) — never through ad-hoc
 *     state writes, which is what keeps the Orchestrator a deterministic system
 *     (规划书 §二原则 6);
 *   - records every transition in `history` so recovery can replay it (§四十五).
 *
 * Sprint 1 scope: the aggregate + the machine + the accounting. No executor, no
 * router, no provider call (AGENTS.md §3).
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { IdFactory } from '../ports/id-factory.js';
import {
  makeId,
  type CompanyId,
  type RunSnapshotId,
  type WorkflowId,
  type WorkflowRunId,
  type WorkflowTemplateId,
  type WorkflowVersionId,
} from '../kernel/identifiers.js';
import { isRunTerminal, nextRunState, type RunEvent, type RunState } from './run-state.js';

/** Default rework ceiling (规划书 §三十五: 默认最大 3 次，超过则 PAUSED). */
export const DEFAULT_REWORK_LIMIT = 3;

export const RUN_FAILURE_REASONS = [
  'cancelled',
  'timed_out',
  'route_failed',
  'execution_failed',
  'approval_denied',
  'delivery_failed',
  'recovery_failed',
] as const;
export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];

/** Which failure reason an event implies (used to keep `failureReason` honest). */
const IMPLIED_FAILURE_REASON: Partial<Record<RunEvent, RunFailureReason>> = {
  ROUTE_FAILED: 'route_failed',
  APPROVAL_DENIED: 'approval_denied',
  EXECUTION_FAILED: 'execution_failed',
  DELIVERY_FAILED: 'delivery_failed',
  RECOVERY_FAILED: 'recovery_failed',
  CANCEL: 'cancelled',
  TIMEOUT: 'timed_out',
};

export interface RunStateChange {
  readonly from: RunState;
  readonly to: RunState;
  readonly event: RunEvent;
  readonly at: string;
}

export interface WorkflowRun {
  readonly id: WorkflowRunId;
  readonly companyId: CompanyId;
  readonly workflowId: WorkflowId;
  readonly templateId: WorkflowTemplateId;
  readonly versionId: WorkflowVersionId;
  readonly snapshotId: RunSnapshotId;
  readonly state: RunState;
  /**
   * Monotonic revision. Every applied event bumps it by exactly one, which is what
   * makes optimistic concurrency (stale-command rejection) and duplicate-command
   * detection possible without any clock or lock.
   */
  readonly revision: number;
  /** Rounds spent in REWORK (规划书 §十二 平均返工次数 的来源). */
  readonly reworkCount: number;
  /**
   * Maximum number of rework rounds that may return to execution. A run that enters
   * REWORK for the (maxRework + 1)-th time can only leave via `REWORK_EXHAUSTED`
   * (→ PAUSED), which is 规划书 §三十五「超过则 PAUSED」.
   */
  readonly maxRework: number;
  readonly failureReason: RunFailureReason | null;
  /** State recorded when the run was paused / crashed; a resume returns here. */
  readonly resumePoint: RunState | null;
  readonly history: readonly RunStateChange[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedBy: string;
}

export interface CreateWorkflowRunInput {
  readonly companyId: CompanyId;
  readonly workflowId: WorkflowId;
  readonly templateId: WorkflowTemplateId;
  readonly versionId: WorkflowVersionId;
  readonly snapshotId: RunSnapshotId;
  readonly startedBy: string;
  readonly now: string;
  readonly ids: IdFactory;
  readonly maxRework?: number;
  /**
   * Optional TRUSTED deterministic run identity (permanent idempotency identity for
   * trusted pipelines, e.g. plan compilation). When omitted the id is minted as usual.
   * The PRIMARY KEY of the run row is the final arbiter for same-id races.
   */
  readonly id?: WorkflowRunId;
}

export function createWorkflowRun(input: CreateWorkflowRunInput): Result<WorkflowRun, DomainError> {
  const maxRework = input.maxRework ?? DEFAULT_REWORK_LIMIT;
  if (!Number.isInteger(maxRework) || maxRework < 0) {
    return err(
      domainError('INVALID_ARGUMENT', 'maxRework must be a non-negative integer.', { maxRework }),
    );
  }
  return ok({
    id: input.id ?? makeId<'WorkflowRunId'>('workflowRun', input.ids),
    companyId: input.companyId,
    workflowId: input.workflowId,
    templateId: input.templateId,
    versionId: input.versionId,
    snapshotId: input.snapshotId,
    state: 'IDLE',
    revision: 0,
    reworkCount: 0,
    maxRework,
    failureReason: null,
    resumePoint: null,
    history: [],
    createdAt: input.now,
    updatedAt: input.now,
    startedBy: input.startedBy,
  });
}

export interface RunEventContext {
  readonly at: string;
  /** Optional explicit reason; must agree with the event when the event implies one. */
  readonly failureReason?: RunFailureReason;
  /**
   * Revision the caller observed. When provided and stale, the event is refused with
   * `CONFLICT` and **nothing** is written (Sprint 2 requirement 15).
   */
  readonly expectedRevision?: number;
}

const failureReasonFor = (
  event: RunEvent,
  explicit: RunFailureReason | undefined,
): Result<RunFailureReason | null, DomainError> => {
  const implied = IMPLIED_FAILURE_REASON[event] ?? null;
  if (implied === null) {
    if (explicit !== undefined) {
      return err(
        domainError('INVALID_ARGUMENT', `Event "${event}" does not carry a failure reason.`, {
          event,
          failureReason: explicit,
        }),
      );
    }
    return ok(null);
  }
  if (explicit !== undefined && explicit !== implied) {
    return err(
      domainError('INVALID_ARGUMENT', `Event "${event}" implies reason "${implied}", not "${explicit}".`, {
        event,
        expected: implied,
        actual: explicit,
      }),
    );
  }
  return ok(implied);
};

/**
 * Advance the run by one event.
 *
 * Guards (all failures return `DomainError`, nothing is written):
 *   - the edge must exist in the L1 machine, else `ILLEGAL_TRANSITION`;
 *   - terminal runs refuse everything;
 *   - `REWORK_READY` is refused once the run has entered REWORK more than
 *     `maxRework` times (`LIMIT_EXCEEDED`) — the caller sends `REWORK_EXHAUSTED`
 *     instead, which lands in `PAUSED` (规划书 §三十五);
 *   - `RESUME` / `RECOVERED` return to the recorded `resumePoint`, so a pause can
 *     never shortcut planning, routing or an approval gate (review finding HIGH-2).
 */
export function applyRunEvent(
  run: WorkflowRun,
  event: RunEvent,
  context: RunEventContext,
): Result<WorkflowRun, DomainError> {
  if (isRunTerminal(run.state)) {
    return err(
      domainError('ILLEGAL_TRANSITION', `Run ${run.id} is ${run.state} (terminal); "${event}" refused.`, {
        runId: run.id,
        state: run.state,
        event,
      }),
    );
  }

  if (context.expectedRevision !== undefined && context.expectedRevision !== run.revision) {
    return err(
      domainError('CONFLICT', `Stale command: run ${run.id} is at revision ${run.revision}.`, {
        runId: run.id,
        expectedRevision: context.expectedRevision,
        actualRevision: run.revision,
        reason: 'stale_revision',
      }),
    );
  }

  if (run.state === 'REWORK' && event === 'REWORK_READY' && run.reworkCount > run.maxRework) {
    return err(
      domainError('LIMIT_EXCEEDED', `Run ${run.id} exhausted its rework budget (${run.maxRework}).`, {
        runId: run.id,
        reworkCount: run.reworkCount,
        maxRework: run.maxRework,
        next: 'REWORK_EXHAUSTED',
      }),
    );
  }

  const next = nextRunState(event, run.state, { resumePoint: run.resumePoint });
  if (!next.ok) return next;

  const reason = failureReasonFor(event, context.failureReason);
  if (!reason.ok) return reason;

  const entersRework = next.value === 'REWORK';
  const pausedHere = event === 'PAUSE' || event === 'CRASH_DETECTED';
  const change: RunStateChange = { from: run.state, to: next.value, event, at: context.at };

  return ok({
    ...run,
    state: next.value,
    revision: run.revision + 1,
    reworkCount: entersRework ? run.reworkCount + 1 : run.reworkCount,
    failureReason: reason.value,
    resumePoint: pausedHere ? run.state : null,
    history: [...run.history, change],
    updatedAt: context.at,
  });
}

export const isRunFinished = (run: WorkflowRun): boolean => isRunTerminal(run.state);

/** Convenience: play a sequence of events, stopping at the first failure. */
export function replayRunEvents(
  run: WorkflowRun,
  events: readonly { readonly event: RunEvent; readonly at: string }[],
): Result<WorkflowRun, DomainError> {
  let current = run;
  for (const step of events) {
    const applied = applyRunEvent(current, step.event, { at: step.at });
    if (!applied.ok) return applied;
    current = applied.value;
  }
  return ok(current);
}

export const runSummary = (run: WorkflowRun): {
  readonly runId: string;
  readonly state: RunState;
  readonly revision: number;
  readonly reworkCount: number;
  readonly transitions: number;
} => ({
  runId: run.id,
  state: run.state,
  revision: run.revision,
  reworkCount: run.reworkCount,
  transitions: run.history.length,
});
