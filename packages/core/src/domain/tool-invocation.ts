/**
 * Tool invocation domain (Sprint 9 §三/§七): one bounded call of one named tool inside one
 * agent execution.
 *
 * This is NOT an agent loop. There is no "plan", no "next tool", no retry-until-success: the
 * lifecycle below covers exactly one attempt, and a replay is resolved by idempotency rather
 * than by calling the adapter again.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import { stableHash } from './prompt-assembly.js';
import type { IdempotencyMode, ToolRiskLevel } from './tool.js';

export const TOOL_INVOCATION_STATES = [
  'REQUESTED',
  /** HIGH/CRITICAL: waiting for a human decision before anything is executed. */
  'WAITING_APPROVAL',
  'STARTED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  /**
   * The process ended while the invocation was in flight (Sprint 9.1 §一). NOT a success and
   * NOT a retry: a non-idempotent tool must never be replayed automatically after this.
   */
  'INTERRUPTED',
] as const;
export type ToolInvocationStatus = (typeof TOOL_INVOCATION_STATES)[number];

export const TOOL_TERMINAL_STATES: readonly ToolInvocationStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
];
export const isTerminalToolStatus = (status: ToolInvocationStatus): boolean =>
  TOOL_TERMINAL_STATES.includes(status);

const TRANSITIONS: Readonly<Record<ToolInvocationStatus, readonly ToolInvocationStatus[]>> = {
  REQUESTED: ['WAITING_APPROVAL', 'STARTED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  WAITING_APPROVAL: ['STARTED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  STARTED: ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: [],
};

export const canTransitionToolInvocation = (
  from: ToolInvocationStatus,
  to: ToolInvocationStatus,
): boolean => TRANSITIONS[from].includes(to);

export const TOOL_ERROR_KINDS = [
  'TOOL_NOT_FOUND',
  'TOOL_DISABLED',
  'PERMISSION_DENIED',
  'INPUT_INVALID',
  'OUTPUT_INVALID',
  'APPROVAL_REQUIRED',
  'APPROVAL_DENIED',
  'TIMEOUT',
  'TOOL_FAILED',
  'IDEMPOTENT_REPLAY',
  'CANCELLED',
  'INTERRUPTED',
  'INTERNAL',
] as const;
export type ToolErrorKind = (typeof TOOL_ERROR_KINDS)[number];

export const TOOL_ERROR_CODES: Readonly<Record<ToolErrorKind, string>> = {
  TOOL_NOT_FOUND: 'NOT_FOUND',
  TOOL_DISABLED: 'POLICY_DENIED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INPUT_INVALID: 'INVALID_ARGUMENT',
  OUTPUT_INVALID: 'VALIDATION_FAILED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_DENIED: 'APPROVAL_DENIED',
  TIMEOUT: 'TIMEOUT',
  TOOL_FAILED: 'AGENT_UNAVAILABLE',
  IDEMPOTENT_REPLAY: 'ALREADY_EXISTS',
  CANCELLED: 'CANCELLED',
  /** A process died mid-invocation: not a tool failure, and deliberately not retryable. */
  INTERRUPTED: 'INTERRUPTED',
  INTERNAL: 'PERSISTENCE_FAILED',
};

export const RETRYABLE_TOOL_KINDS: readonly ToolErrorKind[] = ['TIMEOUT', 'TOOL_FAILED'];

export interface ToolError {
  readonly kind: ToolErrorKind;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

export function normalizeToolError(input: {
  readonly kind?: string;
  readonly code?: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}): ToolError {
  const kind: ToolErrorKind = (TOOL_ERROR_KINDS as readonly string[]).includes(input.kind ?? '')
    ? (input.kind as ToolErrorKind)
    : ((): ToolErrorKind => {
        const byCode = (Object.entries(TOOL_ERROR_CODES) as [ToolErrorKind, string][]).find(
          ([, code]) => code === input.code,
        );
        return byCode?.[0] ?? 'INTERNAL';
      })();
  return {
    kind,
    code: input.code ?? TOOL_ERROR_CODES[kind],
    message: input.message,
    retryable: RETRYABLE_TOOL_KINDS.includes(kind),
    details: { ...(input.details ?? {}) },
  };
}

export interface ToolInvocation {
  readonly id: string;
  readonly toolId: string;
  /**
   * Durable execution provenance (ADR-0019): the ToolRecord.version this invocation was
   * created against — captured at invocation creation (never caller/validator-supplied,
   * never re-read from the registry on replay). NULL only on pre-0005 historical rows
   * whose original version is UNKNOWN (never backfilled — ADR-0019 §Legacy).
   */
  readonly toolVersion: string | null;
  readonly executionId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly actorId: string;
  readonly traceId: string;
  readonly status: ToolInvocationStatus;
  readonly riskLevel: ToolRiskLevel;
  readonly idempotencyMode: IdempotencyMode;
  /** Caller-supplied key (IDEMPOTENT_KEY) or a digest of the input (COMMAND_ID). */
  readonly idempotencyKey: string | null;
  /* ----------------------------------------------------------- attempt chain --- */
  /** The invocation this attempt retries (null for the first attempt). */
  readonly parentInvocationId: string | null;
  /** The first attempt of the chain (always set; equals `id` for the first attempt). */
  readonly rootInvocationId: string;
  /** 1 for the first attempt, then strictly increasing across explicit retries. */
  readonly attemptNumber: number;
  /** Stable digest of the input: recorded so a replay is detectable without storing secrets. */
  readonly inputDigest: string;
  /** The recorded (already redacted) request payload: an approval replays exactly this. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly inputKeys: readonly string[];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly latencyMs: number | null;
  readonly outputDigest: string | null;
  /**
   * Durable replay snapshot of the successful output (ADR-0018): null until the
   * terminal COMPLETED write, and null forever for FAILED/pre-migration rows. The
   * registry verifies this snapshot against `outputDigest` on every replay — a
   * snapshot that cannot be restored losslessly is never persisted in the first place.
   */
  readonly replayOutput: unknown;
  readonly artifactRefs: readonly string[];
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly errorCode: string | null;
  readonly errorKind: ToolErrorKind | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Deterministic digest of an input payload (key order independent). */
export function digestInput(input: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return stableHash(JSON.stringify(canonical(input ?? null)));
}

export interface CreateToolInvocationInput {
  readonly id: string;
  readonly toolId: string;
  /** ADR-0019: captured from the executing ToolRecord at creation time. */
  readonly toolVersion?: string | null;
  readonly executionId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly actorId: string;
  readonly traceId: string;
  readonly riskLevel: ToolRiskLevel;
  readonly idempotencyMode: IdempotencyMode;
  readonly idempotencyKey?: string | null;
  readonly input: Readonly<Record<string, unknown>>;
  /** Attempt-chain wiring (Sprint 9.1.2): omitted for a first attempt. */
  readonly attempt?: {
    readonly parentInvocationId: string;
    readonly rootInvocationId: string;
    readonly attemptNumber: number;
  };
  readonly now: string;
}

export function createToolInvocation(
  input: CreateToolInvocationInput,
): Result<ToolInvocation, DomainError> {
  for (const [field, value] of [
    ['id', input.id],
    ['toolId', input.toolId],
    ['executionId', input.executionId],
    ['agentId', input.agentId],
    ['taskId', input.taskId],
    ['runId', input.runId],
    ['actorId', input.actorId],
    ['traceId', input.traceId],
  ] as const) {
    if (value.trim().length === 0) {
      return err(domainError('VALIDATION_FAILED', `A tool invocation needs a non-empty ${field}.`, { field }));
    }
  }
  if (input.idempotencyMode === 'IDEMPOTENT_KEY' && (input.idempotencyKey ?? '').trim().length === 0) {
    return err(
      domainError('VALIDATION_FAILED', 'IDEMPOTENT_KEY requires a caller-supplied key.', {
        toolId: input.toolId,
      }),
    );
  }
  if (input.attempt !== undefined) {
    if (input.attempt.attemptNumber < 2) {
      return err(
        domainError('VALIDATION_FAILED', 'A retry attempt must have attemptNumber >= 2.', {
          attemptNumber: input.attempt.attemptNumber,
        }),
      );
    }
    if (input.attempt.parentInvocationId.trim().length === 0 || input.attempt.rootInvocationId.trim().length === 0) {
      return err(
        domainError('VALIDATION_FAILED', 'A retry attempt needs both parent and root invocation ids.', {
          toolId: input.toolId,
        }),
      );
    }
  }

  const inputKeys = Object.keys(input.input).sort();

  return ok({
    id: input.id,
    toolId: input.toolId,
    executionId: input.executionId,
    agentId: input.agentId,
    taskId: input.taskId,
    runId: input.runId,
    actorId: input.actorId,
    traceId: input.traceId,
    status: 'REQUESTED',
    riskLevel: input.riskLevel,
    idempotencyMode: input.idempotencyMode,
    idempotencyKey:
      input.idempotencyMode === 'NONE'
        ? null
        : (input.idempotencyKey ??
            `${input.toolId}:${input.executionId}:${digestInput(input.input)}`),
    parentInvocationId: input.attempt?.parentInvocationId ?? null,
    rootInvocationId: input.attempt?.rootInvocationId ?? input.id,
    attemptNumber: input.attempt?.attemptNumber ?? 1,
    inputDigest: digestInput(input.input),
    input: { ...input.input },
    toolVersion: input.toolVersion ?? null,
    replayOutput: null,
    inputKeys,
    startedAt: null,
    finishedAt: null,
    latencyMs: null,
    outputDigest: null,
    artifactRefs: [],
    approvedBy: null,
    approvedAt: null,
    errorCode: null,
    errorKind: null,
    errorMessage: null,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

const transition = (
  invocation: ToolInvocation,
  to: ToolInvocationStatus,
  now: string,
  patch: Partial<ToolInvocation> = {},
): Result<ToolInvocation, DomainError> => {
  if (!canTransitionToolInvocation(invocation.status, to)) {
    return err(
      domainError('CONFLICT', `Cannot move a tool invocation from ${invocation.status} to ${to}.`, {
        invocationId: invocation.id,
        from: invocation.status,
        to,
      }),
    );
  }
  return ok({ ...invocation, ...patch, status: to, updatedAt: now });
};

export const markWaitingApproval = (invocation: ToolInvocation, now: string): Result<ToolInvocation, DomainError> =>
  transition(invocation, 'WAITING_APPROVAL', now);

export const markInvocationStarted = (invocation: ToolInvocation, now: string): Result<ToolInvocation, DomainError> =>
  transition(invocation, 'STARTED', now, { startedAt: now });

/**
 * Record the approval. The status stays WAITING_APPROVAL: the execution path itself moves the
 * invocation to STARTED (and only it may), so an approval cannot be mistaken for a running call.
 */
export const markInvocationApproved = (
  invocation: ToolInvocation,
  approvedBy: string,
  now: string,
): Result<ToolInvocation, DomainError> => {
  if (invocation.status !== 'WAITING_APPROVAL') {
    return err(
      domainError('CONFLICT', `Only a WAITING_APPROVAL invocation can be approved (it is ${invocation.status}).`, {
        invocationId: invocation.id,
        status: invocation.status,
      }),
    );
  }
  if (approvedBy.trim().length === 0) {
    return err(domainError('APPROVAL_DENIED', 'An approval needs an approver.', { invocationId: invocation.id }));
  }
  if (invocation.approvedBy !== null) {
    // Two approvers racing must not both believe they authorised the call (Closeout HIGH-1).
    return err(
      domainError('CONFLICT', `Invocation "${invocation.id}" was already approved by ${invocation.approvedBy}.`, {
        invocationId: invocation.id,
        approvedBy: invocation.approvedBy,
      }),
    );
  }
  return ok({ ...invocation, approvedBy, approvedAt: now, updatedAt: now });
};

export const markInvocationCompleted = (
  invocation: ToolInvocation,
  input: {
    readonly outputDigest: string;
    readonly artifactRefs: readonly string[];
    readonly latencyMs: number;
    readonly now: string;
    /** Verified-lossless JSON snapshot of the output (ADR-0018); null = not restorable. */
    readonly replayOutput?: unknown;
  },
): Result<ToolInvocation, DomainError> =>
  transition(invocation, 'COMPLETED', input.now, {
    outputDigest: input.outputDigest,
    artifactRefs: [...input.artifactRefs],
    latencyMs: input.latencyMs,
    finishedAt: input.now,
    errorCode: null,
    errorKind: null,
    errorMessage: null,
    ...(input.replayOutput === undefined ? {} : { replayOutput: input.replayOutput }),
  });

export const markInvocationFailed = (
  invocation: ToolInvocation,
  error: ToolError,
  input: { readonly latencyMs: number | null; readonly now: string },
): Result<ToolInvocation, DomainError> =>
  transition(invocation, 'FAILED', input.now, {
    errorCode: error.code,
    errorKind: error.kind,
    errorMessage: error.message,
    latencyMs: input.latencyMs,
    finishedAt: input.now,
  });

export const markInvocationCancelled = (
  invocation: ToolInvocation,
  now: string,
): Result<ToolInvocation, DomainError> =>
  transition(invocation, 'CANCELLED', now, {
    finishedAt: now,
    errorCode: TOOL_ERROR_CODES.CANCELLED,
    errorKind: 'CANCELLED',
    errorMessage: 'Cancelled by the caller.',
  });

/**
 * Recovery verdict (Sprint 9.1 §一): an in-flight invocation whose process died.
 *
 * It is NEVER reported as COMPLETED and it is NEVER replayed here. For a non-idempotent tool
 * (`idempotencyMode === 'NONE'`) this is final: no automatic retry may ever happen, because a
 * second call could duplicate a side effect.
 */
export const markInvocationInterrupted = (
  invocation: ToolInvocation,
  now: string,
  reason = 'The process ended while this tool invocation was in flight.',
): Result<ToolInvocation, DomainError> =>
  transition(invocation, 'INTERRUPTED', now, {
    finishedAt: now,
    errorCode: TOOL_ERROR_CODES.INTERRUPTED,
    errorKind: 'INTERRUPTED',
    errorMessage: reason,
  });

/**
 * The idempotency key for attempt `n` of a chain (Sprint 9.1.2 §一).
 *
 * The FIRST attempt keeps the caller's base key; every retry derives
 * `<base>#retry-<attemptNumber>`, so each attempt is a distinct identity that can never
 * collide with (and therefore never "wrongly replay") a previous attempt.
 */
export function retryIdempotencyKey(baseKey: string, attemptNumber: number): string {
  return attemptNumber <= 1 ? baseKey : `${baseKey}#retry-${String(attemptNumber)}`;
}

/** Strip any retry suffix, so a chain always derives from the same pristine base key. */
export function baseIdempotencyKey(key: string | null): string | null {
  if (key === null) return null;
  const marker = key.indexOf('#retry-');
  return marker === -1 ? key : key.slice(0, marker);
}

/** Invocations a restart must repair (waiting for approval is NOT one of them). */
export const toolInvocationNeedsRecovery = (invocation: ToolInvocation): boolean =>
  invocation.status === 'STARTED';

/** Only an explicit, human-requested retry may re-run a tool - and only a replay-safe one. */
export const canRetryInvocation = (invocation: ToolInvocation): Result<true, DomainError> => {
  if (invocation.status !== 'INTERRUPTED') {
    return err(
      domainError('CONFLICT', `Only an INTERRUPTED invocation can be retried (it is ${invocation.status}).`, {
        invocationId: invocation.id,
        status: invocation.status,
      }),
    );
  }
  if (invocation.idempotencyMode === 'NONE') {
    return err(
      domainError('POLICY_DENIED', 'A non-idempotent tool is never retried, not even on request.', {
        kind: 'INTERRUPTED',
        invocationId: invocation.id,
        idempotencyMode: invocation.idempotencyMode,
      }),
    );
  }
  return ok(true);
};
