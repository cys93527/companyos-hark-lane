/**
 * V1 EFFICIENCY STAGE E3 — attempt resilience & execution supervision (DERIVED ONLY).
 *
 * E3-A — POLICY OWNER: execution/attempt supervision. This module owns the
 * interpretation of attempt evidence (elapsed time, runtime state, provider result,
 * process liveness, observed activity, failure code, retryability) as TYPED
 * OBSERVATIONAL CLASSIFICATIONS. Routing profiles / the planner / roles / validators
 * may be INPUTS to supervision; they are never the policy authority. The module has
 * NO termination authority of any kind:
 *
 *   - NO silence-only kill: observed silence alone NEVER terminates an attempt. The
 *     600 000 ms production safety cap remains the only timeout, unchanged.
 *   - NO progress inference: observed activity != meaningful progress (E1 invariant);
 *     repeated tool calls are activity, never progress. No progress percentages exist.
 *
 * E3-B — TYPED CLASSIFICATIONS: only mechanically supportable states. Unsupported
 * labels (MODEL_STUCK / PROVIDER_STUCK / NO_PROGRESS) do not exist here.
 *
 * E3-C — RETRY CONTINUATION ENVELOPE: when a retryable task creates a NEW
 * ExecutionAttempt, a BOUNDED retry context is derived from existing durable truth
 * (previous attempt rows + E1 activity events). It is DERIVED CONTEXT handed to the
 * executor, never canonical truth: the previous failed attempt's output is NOT
 * authority, nothing is auto-promoted, and the retry must verify workspace state
 * against the canonical task acceptance criteria before reuse.
 */

/** The supervision policy identity (audit surface; data, never an authority token). */
export const ATTEMPT_SUPERVISION_POLICY_OWNER = 'execution:attempt-supervision' as const;
export const ATTEMPT_SUPERVISION_POLICY_VERSION = 1 as const;

/* ------------------------------------------------- E3-B: typed classification */

/**
 * Observational attempt classifications. Every member is mechanically supportable:
 * a CONFIRMED member requires a confirmed terminal signal; the OBSERVED members are
 * derived from E1 activity evidence; anything else is UNKNOWN.
 */
export type AttemptSupervisionClassification =
  | 'ACTIVE_OBSERVED'
  | 'SILENT_OBSERVED_WINDOW'
  | 'PROVIDER_FAILURE_CONFIRMED'
  | 'EXECUTOR_FAILURE_CONFIRMED'
  | 'PROCESS_EXIT_CONFIRMED'
  | 'TIMEOUT_CAP_REACHED'
  | 'UNKNOWN';

/** The complete set of labels the policy may emit (frozen; no stuck/progress labels). */
export const ATTEMPT_SUPERVISION_CLASSIFICATIONS: readonly AttemptSupervisionClassification[] = [
  'ACTIVE_OBSERVED',
  'SILENT_OBSERVED_WINDOW',
  'PROVIDER_FAILURE_CONFIRMED',
  'EXECUTOR_FAILURE_CONFIRMED',
  'PROCESS_EXIT_CONFIRMED',
  'TIMEOUT_CAP_REACHED',
  'UNKNOWN',
];

export interface AttemptOutcomeInput {
  /** The executor provider outcome kind, when the attempt already settled ('provider-failed', 'timeout', ...). */
  readonly outcomeKind?: string | null;
  /** The canonical ExecutionAttempt failure code (attempt row truth). */
  readonly failureCode?: string | null;
  /** True only when a process exit was CONFIRMED by the executor (not inferred). */
  readonly processExitConfirmed?: boolean;
}

/**
 * Classify a SETTLED (or settling) attempt from confirmed signals only.
 * - provider-failed            → PROVIDER_FAILURE_CONFIRMED
 * - transport-failed / executor-crash-family → EXECUTOR_FAILURE_CONFIRMED
 * - timeout                    → TIMEOUT_CAP_REACHED (the safety cap fired)
 * - confirmed process exit without provider/executor failure → PROCESS_EXIT_CONFIRMED
 * - anything else              → UNKNOWN
 * Silence, activity, or elapsed time are DELIBERATELY not inputs here: they never
 * produce a failure classification.
 */
export const classifyAttemptOutcome = (input: AttemptOutcomeInput): AttemptSupervisionClassification => {
  const kind = String(input.outcomeKind ?? input.failureCode ?? '').toLowerCase();
  if (kind === 'provider-failed') return 'PROVIDER_FAILURE_CONFIRMED';
  if (kind === 'timeout') return 'TIMEOUT_CAP_REACHED';
  if (kind === 'transport-failed' || kind === 'executor_crash' || kind === 'execution_failed') return 'EXECUTOR_FAILURE_CONFIRMED';
  if (input.processExitConfirmed === true && kind === '') return 'PROCESS_EXIT_CONFIRMED';
  if (kind === '') return 'UNKNOWN';
  return 'UNKNOWN';
};

export interface ObservedActivityInput {
  /** Last observed activity timestamp (E1 activity/tool event) for THIS attempt, if any. */
  readonly lastObservedActivityAt?: string | null;
  /** The observation instant (injected clock; never sampled inside). */
  readonly now: string;
}

/**
 * Classify the OBSERVED activity window of a RUNNING attempt — observation labels
 * only. No SILENT classification terminates anything; it is evidence for readers.
 */
export const classifyObservedActivity = (input: ObservedActivityInput): AttemptSupervisionClassification => {
  if (input.lastObservedActivityAt === null || input.lastObservedActivityAt === undefined) return 'UNKNOWN';
  const elapsedMs = Date.parse(input.now) - Date.parse(input.lastObservedActivityAt);
  if (Number.isNaN(elapsedMs)) return 'UNKNOWN';
  return elapsedMs <= SILENT_OBSERVED_WINDOW_MS ? 'ACTIVE_OBSERVED' : 'SILENT_OBSERVED_WINDOW';
};

/**
 * The observational silence window (evidence label threshold). This constant has NO
 * termination semantics — it only bounds when a reader may call a window "silent".
 */
export const SILENT_OBSERVED_WINDOW_MS = 120_000;

/* --------------------------------------- E3-C: retry continuation envelope */

export const RETRY_CONTINUATION_SCHEMA = 'companyos/retry-continuation/1' as const;

/** Bounded prior-activity summary (no raw arguments, no transcripts, no output). */
export interface RetryPriorActivitySummary {
  readonly toolCallCount: number;
  readonly activityEventCount: number;
  /** Last ≤5 observed tool kinds (names only, e.g. 'pwsh'). */
  readonly lastToolKinds: readonly string[];
  /** Last observed activity timestamp (activity, NOT progress). */
  readonly lastObservedActivityAt: string | null;
}

/**
 * The derived retry context for a NEW attempt of a previously failed task.
 * DERIVED CONTEXT — never canonical truth, never persisted as its own row.
 */
export interface RetryContinuationEnvelope {
  readonly schemaVersion: typeof RETRY_CONTINUATION_SCHEMA;
  readonly taskId: string;
  readonly previousAttemptId: string;
  /** 1 = second attempt of the task, 2 = third, ... (attemptNumber - 1). */
  readonly retryOrdinal: number;
  readonly previousFailureCode: string | null;
  readonly previousFailureRetryable: boolean | null;
  readonly previousAttemptDurationS: number | null;
  readonly previousSettlementOutcome: string | null;
  readonly workspaceReuse: true;
  readonly priorActivity: RetryPriorActivitySummary;
}

export interface RetryDerivationInput {
  readonly taskId: string;
  readonly attemptNumber: number;
  /** Prior settled attempts of the SAME task (any order; derivation sorts deterministically). */
  readonly priorAttempts: readonly {
    readonly id: string;
    readonly attemptNumber: number;
    readonly state: string;
    readonly failureCode?: string | null;
    readonly failureRetryable?: boolean | null;
    readonly createdAt: string;
    readonly settledAt: string | null;
  }[];
  /** E1 activity events for the immediately previous attempt (bounded by the caller). */
  readonly previousAttemptEvents?: readonly {
    readonly type: string;
    readonly occurredAt: string;
    readonly payload?: unknown;
  }[];
}

const payloadToolOf = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const tool = (payload as {tool?: unknown}).tool;
  return typeof tool === 'string' && tool.trim() !== '' ? tool : null;
};

/**
 * Derive the retry continuation envelope for a NEW attempt. Returns null for the
 * FIRST attempt of a task (attemptNumber <= 1): a first attempt must never carry
 * fake retry context. Deterministic from durable truth alone (restart-stable).
 */
export const deriveRetryContinuationEnvelope = (input: RetryDerivationInput): RetryContinuationEnvelope | null => {
  if (input.attemptNumber <= 1) return null;
  const settled = input.priorAttempts
    .filter((attempt) => attempt.settledAt !== null)
    .sort((a, b) => (a.attemptNumber - b.attemptNumber) || (a.id < b.id ? -1 : 1));
  const previous = settled[settled.length - 1] ?? null;
  if (previous === null) return null;

  const events = [...(input.previousAttemptEvents ?? [])].sort(
    (a, b) => (Date.parse(a.occurredAt) - Date.parse(b.occurredAt)) || (a.occurredAt < b.occurredAt ? -1 : 1),
  );
  const toolEvents = events.filter((event) => event.type === 'executor.tool_invocation_requested');
  const activityEvents = events.filter((event) => event.type === 'executor.attempt_activity');
  const lastObservedAt = events.length === 0 ? null : events[events.length - 1]!.occurredAt;
  const lastToolKinds: string[] = [];
  for (const event of [...toolEvents].reverse()) {
    const tool = payloadToolOf(event.payload);
    if (tool !== null && !lastToolKinds.includes(tool)) lastToolKinds.push(tool);
    if (lastToolKinds.length >= 5) break;
  }

  return {
    schemaVersion: RETRY_CONTINUATION_SCHEMA,
    taskId: input.taskId,
    previousAttemptId: previous.id,
    retryOrdinal: input.attemptNumber - 1,
    previousFailureCode: previous.failureCode ?? null,
    previousFailureRetryable: previous.failureRetryable ?? null,
    previousAttemptDurationS: previous.settledAt === null
      ? null
      : Math.max(0, Math.round((Date.parse(previous.settledAt) - Date.parse(previous.createdAt)) / 100) / 10),
    previousSettlementOutcome: previous.state,
    workspaceReuse: true,
    priorActivity: {
      toolCallCount: toolEvents.length,
      activityEventCount: activityEvents.length,
      lastToolKinds,
      lastObservedActivityAt: lastObservedAt,
    },
  };
};

/**
 * The workspace-continuity directive rendered into the retry attempt's work text.
 * Bounded; verification-first; the failed attempt is explicitly NOT authority.
 */
export const renderRetryDirective = (envelope: RetryContinuationEnvelope): string =>
  [
    `RETRY CONTEXT (attempt ${String(envelope.retryOrdinal + 1)} of this task; derived, non-authoritative):`,
    `the previous attempt (${String(envelope.previousAttemptId.slice(0, 18))}…) settled ${String(envelope.previousSettlementOutcome)}` +
      `${envelope.previousFailureCode === null ? '' : ` with failure ${envelope.previousFailureCode}`}` +
      `${envelope.previousAttemptDurationS === null ? '' : ` after ${String(envelope.previousAttemptDurationS)}s`}` +
      `. Prior observed activity: ${String(envelope.priorActivity.toolCallCount)} tool calls` +
      `${envelope.priorActivity.lastToolKinds.length === 0 ? '' : ` (${envelope.priorActivity.lastToolKinds.join(', ')})`}` +
      `${envelope.priorActivity.lastObservedActivityAt === null ? '' : `, last observed at ${envelope.priorActivity.lastObservedActivityAt}`}` +
      `.`,
    `This is a retry of the same canonical task. The existing workspace may contain partial work from the previous failed attempt.`,
    `Do not assume that partial work is correct, and do not trust the previous attempt's conclusions, PASS claims, validation claims, or partial output — a failed attempt's output is not authoritative.`,
    `Before starting from scratch: inspect the current workspace, identify reusable work, verify it against the task acceptance criteria, and continue from valid existing state where appropriate.`,
    `Canonical task, plan, and evidence remain the only authority.`,
  ].join(' ');
