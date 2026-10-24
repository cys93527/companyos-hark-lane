/**
 * Agent Execution domain (Sprint 8).
 *
 * An AgentExecution is ONE attempt by one agent (a role filled for one task) to produce a
 * result with ONE explicitly named model. It is deliberately a separate state machine:
 *
 *   Role   != Agent      (a role is a job description; an agent fills it)
 *   Agent  != Model      (an agent may run on any allowed model - and switching models
 *                         must NOT require a new role or a new agent)
 *   Model  != Provider   (a model is registered from a provider catalogue)
 *   Runtime != Router    (the runtime never chooses a model)
 *
 * These states are Agent Execution states ONLY. They must never be mixed with the workflow
 * L1 (17 run states), the L2 template lifecycle states, or L3 Task/Stage states.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';

/** Agent Execution lifecycle - a closed set, disjoint from every other layer. */
export const AGENT_EXECUTION_STATES = [
  'CREATED',
  'READY',
  'RUNNING',
  'WAITING_EXTERNAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  /** Recovery verdict for a process that died mid-run - never COMPLETED. */
  'INTERRUPTED',
] as const;

export type AgentExecutionStatus = (typeof AGENT_EXECUTION_STATES)[number];

export const TERMINAL_EXECUTION_STATES: readonly AgentExecutionStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
];

export const isTerminalStatus = (status: AgentExecutionStatus): boolean =>
  TERMINAL_EXECUTION_STATES.includes(status);

/** Allowed transitions. Recovery goes RUNNING -> INTERRUPTED, never RUNNING -> COMPLETED. */
const TRANSITIONS: Readonly<Record<AgentExecutionStatus, readonly AgentExecutionStatus[]>> = {
  CREATED: ['READY', 'FAILED', 'CANCELLED'],
  READY: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['WAITING_EXTERNAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  WAITING_EXTERNAL: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: [],
};

export const canTransitionExecution = (
  from: AgentExecutionStatus,
  to: AgentExecutionStatus,
): boolean => TRANSITIONS[from].includes(to);

/** Structured execution error kinds (Sprint 8 §九). */
export const EXECUTION_ERROR_KINDS = [
  /** No model was named and no router exists: the caller must decide. */
  'MODEL_SELECTION_REQUIRED',
  'MODEL_DISABLED',
  'MODEL_UNAVAILABLE',
  'CAPABILITY_MISSING',
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'QUOTA_EXHAUSTED',
  'TIMEOUT',
  'CONTEXT_LIMIT',
  'CONTENT_REJECTED',
  'INVALID_OUTPUT',
  'CANCELLED',
  /** A policy refused the named model (blocked / not-in-range / provider / cost / latency). */
  'POLICY_REFUSED',
  /**
   * The process ended while this attempt was in flight. NOT a provider timeout: it says
   * "we do not know how this ended", so it must not look retryable (Closeout: MEDIUM-3).
   */
  'INTERRUPTED',
  'INTERNAL',
] as const;
export type ExecutionErrorKind = (typeof EXECUTION_ERROR_KINDS)[number];

/** Kind -> Core error code. One place, so the runtime never improvises. */
export const EXECUTION_ERROR_CODES: Readonly<Record<ExecutionErrorKind, string>> = {
  MODEL_SELECTION_REQUIRED: 'MODEL_SELECTION_REQUIRED',
  MODEL_DISABLED: 'POLICY_DENIED',
  MODEL_UNAVAILABLE: 'AGENT_UNAVAILABLE',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
  PROVIDER_UNAVAILABLE: 'AGENT_UNAVAILABLE',
  RATE_LIMITED: 'LIMIT_EXCEEDED',
  QUOTA_EXHAUSTED: 'LIMIT_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  CONTEXT_LIMIT: 'VALIDATION_FAILED',
  CONTENT_REJECTED: 'POLICY_DENIED',
  INVALID_OUTPUT: 'VALIDATION_FAILED',
  CANCELLED: 'CANCELLED',
  POLICY_REFUSED: 'POLICY_DENIED',
  INTERRUPTED: 'INTERRUPTED',
  INTERNAL: 'PERSISTENCE_FAILED',
};

/** Which kinds a caller may retry unchanged (metadata only - the runtime never retries). */
export const RETRYABLE_EXECUTION_KINDS: readonly ExecutionErrorKind[] = [
  'RATE_LIMITED',
  'TIMEOUT',
  'PROVIDER_UNAVAILABLE',
];

/** Provider error `kind` (Sprint 6 vocabulary) -> execution error kind. */
const PROVIDER_KIND_TO_EXECUTION: Readonly<Record<string, ExecutionErrorKind>> = {
  rate_limited: 'RATE_LIMITED',
  quota_exhausted: 'QUOTA_EXHAUSTED',
  timeout: 'TIMEOUT',
  context_limit: 'CONTEXT_LIMIT',
  content_rejected: 'CONTENT_REJECTED',
  unavailable: 'PROVIDER_UNAVAILABLE',
  not_found: 'MODEL_UNAVAILABLE',
  auth_failed: 'PROVIDER_UNAVAILABLE',
  invalid_request: 'CAPABILITY_MISSING',
  invalid_output: 'INVALID_OUTPUT',
  capability_missing: 'CAPABILITY_MISSING',
  cancelled: 'CANCELLED',
};

export interface ExecutionError {
  readonly kind: ExecutionErrorKind;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface NormalizeExecutionErrorInput {
  readonly kind?: string;
  readonly message: string;
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Normalize any failure into the execution error shape that is persisted and audited.
 * The message is never allowed to carry a credential (callers redact before persisting).
 */
export function normalizeExecutionError(input: NormalizeExecutionErrorInput): ExecutionError {
  const kind = ((): ExecutionErrorKind => {
    if (input.kind !== undefined) {
      if ((EXECUTION_ERROR_KINDS as readonly string[]).includes(input.kind)) {
        return input.kind as ExecutionErrorKind;
      }
      const mapped = PROVIDER_KIND_TO_EXECUTION[input.kind];
      if (mapped !== undefined) return mapped;
    }
    if (input.code !== undefined) {
      const fromCode: Readonly<Record<string, ExecutionErrorKind>> = {
        MODEL_SELECTION_REQUIRED: 'MODEL_SELECTION_REQUIRED',
        TIMEOUT: 'TIMEOUT',
        LIMIT_EXCEEDED: 'RATE_LIMITED',
        AGENT_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
        CAPABILITY_MISSING: 'CAPABILITY_MISSING',
        POLICY_DENIED: 'CONTENT_REJECTED',
        CANCELLED: 'CANCELLED',
      };
      const mapped = fromCode[input.code];
      if (mapped !== undefined) return mapped;
    }
    return 'INTERNAL';
  })();

  return {
    kind,
    code: input.code ?? EXECUTION_ERROR_CODES[kind],
    message: input.message,
    retryable: RETRYABLE_EXECUTION_KINDS.includes(kind),
    details: { ...(input.details ?? {}) },
  };
}

export function executionErrorToDomainError(error: ExecutionError): DomainError {
  return domainError(
    (EXECUTION_ERROR_CODES[error.kind] ?? 'PERSISTENCE_FAILED') as Parameters<typeof domainError>[0],
    error.message,
    { kind: error.kind, retryable: error.retryable, ...error.details },
  );
}

/** A model binding is MODEL-level and explicit: it is never derived from a role. */
export interface ModelBinding {
  readonly modelKey: string;
  readonly providerId: string;
  readonly providerModelId: string;
  /** Where the binding came from - the runtime records it, it never invents one. */
  readonly source: 'MANUAL' | 'EXPLICIT_BINDING' | 'ROUTER' | 'TASK_OVERRIDE';
}

export interface ExecutionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export const EMPTY_USAGE: ExecutionUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export interface AgentExecution {
  /** `EntityStore` key - always identical to `executionId` (kept for port compatibility). */
  readonly id: string;
  readonly executionId: string;
  readonly agentId: string;
  readonly roleId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly modelKey: string;
  readonly providerId: string;
  readonly providerModelId: string;
  readonly status: AgentExecutionStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly traceId: string;
  readonly attempt: number;
  readonly inputUsage: ExecutionUsage;
  readonly outputUsage: ExecutionUsage;
  readonly latencyMs: number | null;
  readonly resultRef: string | null;
  readonly artifactRefs: readonly string[];
  readonly errorCode: string | null;
  readonly errorKind: ExecutionErrorKind | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * POST-CODEX 40d7892 re-audit (F5-C-R1) — the durable POST-COMMIT ownership marker:
   * set (non-null ISO timestamp) by the trusted writer whose durable commit makes THIS
   * execution's outcome authoritative (the supervisor Decision sink stamps it in the
   * same transaction as its Decision, while the row is still RUNNING). Once stamped,
   * generic failure/cancel/timeout settlements are refused — they may not reinterpret
   * the committed turn — and recovery converges the row to the committed COMPLETED
   * state. Absent/undefined is the ordinary state for every other execution.
   */
  readonly outcomeCommittedAt?: string | null;
  /**
   * POST-CODEX 9dc9943 re-audit — the EXACT Decision that made this execution
   * outcome-committed (stronger commit identity: the marker timestamp alone never
   * becomes ambiguous truth). NULL/absent = no committed outcome.
   */
  readonly outcomeDecisionId?: string | null;
  /**
   * POST-CODEX 9dc9943 re-audit — the DURABLE decision-authority expiry (absolute
   * ISO-8601 UTC, written at start from the canonical clock = started_at + the turn's
   * whole-turn timeout). A Decision may only commit while this instant is still in the
   * future; NULL/absent = no authority bound (generic non-supervisor executions).
   */
  readonly decisionAuthorityExpiresAt?: string | null;
  /**
   * POST-CODEX 25b98d1 re-audit — the logical supervisor turn this execution was
   * ADMITTED for (the frozen supervisor-decision command identity). The partial
   * unique index over ACTIVE rows is the durable single-flight arbiter.
   */
  readonly logicalTurnId?: string | null;
}

export interface CreateExecutionInput {
  readonly executionId: string;
  readonly agentId: string;
  readonly roleId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly binding: ModelBinding;
  readonly traceId: string;
  readonly attempt?: number;
  readonly now: string;
}

export function createExecution(input: CreateExecutionInput): Result<AgentExecution, DomainError> {
  for (const [field, value] of [
    ['executionId', input.executionId],
    ['agentId', input.agentId],
    ['roleId', input.roleId],
    ['taskId', input.taskId],
    ['runId', input.runId],
    ['traceId', input.traceId],
    ['modelKey', input.binding.modelKey],
  ] as const) {
    if (value.trim().length === 0) {
      return err(domainError('VALIDATION_FAILED', `An agent execution needs a non-empty ${field}.`, { field }));
    }
  }
  return ok({
    id: input.executionId,
    executionId: input.executionId,
    agentId: input.agentId,
    roleId: input.roleId,
    taskId: input.taskId,
    runId: input.runId,
    modelKey: input.binding.modelKey,
    providerId: input.binding.providerId,
    providerModelId: input.binding.providerModelId,
    status: 'CREATED',
    startedAt: null,
    finishedAt: null,
    traceId: input.traceId,
    attempt: input.attempt ?? 1,
    inputUsage: EMPTY_USAGE,
    outputUsage: EMPTY_USAGE,
    latencyMs: null,
    resultRef: null,
    artifactRefs: [],
    errorCode: null,
    errorKind: null,
    errorMessage: null,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

const transition = (
  execution: AgentExecution,
  to: AgentExecutionStatus,
  now: string,
  patch: Partial<AgentExecution> = {},
): Result<AgentExecution, DomainError> => {
  if (!canTransitionExecution(execution.status, to)) {
    return err(
      domainError('CONFLICT', `Cannot move an execution from ${execution.status} to ${to}.`, {
        executionId: execution.executionId,
        from: execution.status,
        to,
      }),
    );
  }
  return ok({ ...execution, ...patch, status: to, updatedAt: now });
};

export const markReady = (execution: AgentExecution, now: string): Result<AgentExecution, DomainError> =>
  transition(execution, 'READY', now);

export const markRunning = (execution: AgentExecution, now: string): Result<AgentExecution, DomainError> =>
  transition(execution, 'RUNNING', now, { startedAt: now });

export const markWaitingExternal = (
  execution: AgentExecution,
  now: string,
): Result<AgentExecution, DomainError> => transition(execution, 'WAITING_EXTERNAL', now);

export interface CompleteExecutionInput {
  readonly resultRef: string | null;
  readonly artifactRefs: readonly string[];
  readonly inputUsage: ExecutionUsage;
  readonly outputUsage: ExecutionUsage;
  readonly latencyMs: number;
  readonly now: string;
}

export const markCompleted = (
  execution: AgentExecution,
  input: CompleteExecutionInput,
): Result<AgentExecution, DomainError> =>
  transition(execution, 'COMPLETED', input.now, {
    resultRef: input.resultRef,
    artifactRefs: [...input.artifactRefs],
    inputUsage: input.inputUsage,
    outputUsage: input.outputUsage,
    latencyMs: input.latencyMs,
    finishedAt: input.now,
    errorCode: null,
    errorKind: null,
    errorMessage: null,
  });

export const markFailed = (
  execution: AgentExecution,
  error: ExecutionError,
  input: {
    readonly latencyMs: number | null;
    readonly now: string;
    /**
     * OPTIONAL provider-reported usage of a call whose CONTENT failed (LIVE-SMOKE-FIX-06
     * §14): recorded faithfully when supplied, left untouched (zeros) when not.
     */
    readonly outputUsage?: ExecutionUsage;
  },
): Result<AgentExecution, DomainError> =>
  transition(execution, 'FAILED', input.now, {
    errorCode: error.code,
    errorKind: error.kind,
    errorMessage: error.message,
    latencyMs: input.latencyMs,
    finishedAt: input.now,
    ...(input.outputUsage === undefined ? {} : {outputUsage: input.outputUsage}),
  });

export const markCancelled = (execution: AgentExecution, now: string): Result<AgentExecution, DomainError> =>
  transition(execution, 'CANCELLED', now, {
    finishedAt: now,
    errorCode: EXECUTION_ERROR_CODES.CANCELLED,
    errorKind: 'CANCELLED',
    errorMessage: 'Cancelled by the caller.',
  });

/**
 * Recovery (Sprint 8 §十二): a process that died while RUNNING/WAITING_EXTERNAL leaves an
 * execution that must NOT be reported as COMPLETED. It becomes INTERRUPTED, with an explicit
 * error record, and the runtime never re-invokes the provider on its own.
 */
export const markInterrupted = (
  execution: AgentExecution,
  now: string,
  reason = 'The process ended while this execution was in flight.',
): Result<AgentExecution, DomainError> =>
  transition(execution, 'INTERRUPTED', now, {
    finishedAt: now,
    errorCode: 'INTERRUPTED',
    errorKind: 'INTERRUPTED',
    errorMessage: reason,
  });

/** Executions that a restart must repair. */
export const needsRecovery = (execution: AgentExecution): boolean =>
  execution.status === 'RUNNING' || execution.status === 'WAITING_EXTERNAL';
