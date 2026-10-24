/**
 * ExecutionAttempt — the GENERIC runtime execution-attempt owner (Sprint 21 final).
 *
 * Authority split (Boss ruling, frozen):
 *   Task            = business/work lifecycle truth.
 *   ExecutionAttempt= generic runtime attempt identity + active ownership +
 *                     orphan/interruption recovery + attempt settlement provenance.
 *   AgentExecution  = model/LLM invocation provenance ONLY (never broadened).
 *
 * An ExecutionAttempt answers exactly: which attempt owns this Task right now; was that
 * attempt interrupted; was it settled; may it be recovered. It NEVER owns workflow
 * readiness, DAG, business status, validation/finding/artifact truth. No model fields
 * exist in the generic contract.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { canonicalJson, sha256Hex } from '../kernel/hash.js';
import { err, ok, type Result } from '../kernel/result.js';

export const EXECUTION_ATTEMPT_SCHEMA = 'companyos/execution-attempt/1';

/** The smallest generic state machine — deliberately NOT the Task lifecycle. */
export const EXECUTION_ATTEMPT_STATES = ['ACTIVE', 'INTERRUPTED', 'COMPLETED', 'FAILED'] as const;
export type ExecutionAttemptState = (typeof EXECUTION_ATTEMPT_STATES)[number];

const TRANSITIONS: Readonly<Record<ExecutionAttemptState, readonly ExecutionAttemptState[]>> = {
  ACTIVE: ['INTERRUPTED', 'COMPLETED', 'FAILED'],
  INTERRUPTED: ['ACTIVE', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

/**
 * Permanent deterministic identity: one canonical row per (companyId, runId, taskId,
 * attemptNumber) forever; no timestamp identity. The DB PRIMARY KEY on this id (and the
 * UNIQUE(task_id, attempt_number) index) is the final arbitration — find-then-create is
 * only the friendly path.
 */
export const executionAttemptIdOf = (input: {
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
}): string =>
  `exa_${sha256Hex(
    canonicalJson({
      purpose: EXECUTION_ATTEMPT_SCHEMA,
      companyId: input.companyId,
      runId: input.runId,
      taskId: input.taskId,
      attemptNumber: input.attemptNumber,
    }),
  ).slice(0, 26)}`;

/** The immutable creation seed — pinned execution semantics only. */
export interface ExecutionAttemptSeed {
  readonly schema: typeof EXECUTION_ATTEMPT_SCHEMA;
  readonly id: string;
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  /** The pinned execution semantic (from the WorkflowVersion taskProfile). */
  readonly roleId: string;
  readonly taskKind: string;
  /** The seed fingerprint — recomputable from the immutable fields alone. */
  readonly fingerprint: string;
}

/**
 * LIVE-SMOKE-FIX-04B — the attempt-scoped CANONICAL failure truth: what a terminal
 * FAILED attempt settled with, persisted on the attempt row itself (append-only history
 * per (task, attempt_number); never overwritten by a later attempt). Absent on legacy
 * rows and on every non-FAILED terminal — absence is reported, never fabricated.
 */
export interface ExecutionAttemptFailure {
  /** Frozen typed failure code (UPPER_SNAKE, e.g. MODEL_CAPABILITY_MISMATCH). */
  readonly code: string;
  /** The lifecycle phase the failure occurred in, when known (e.g. 'workspace-trusted'). */
  readonly phase: string | null;
  /** Sanitized bounded summary — never a payload, secret, prompt or stack. */
  readonly summary: string | null;
  /** false = deterministic (fail-fast, one attempt); true = existing retry semantics. */
  readonly retryable: boolean;
}

export interface ExecutionAttempt {
  readonly seed: ExecutionAttemptSeed;
  readonly state: ExecutionAttemptState;
  /**
   * Generic owner token of the runtime instance that claimed the attempt. NOT business
   * truth; used only under the supported V1 single-runtime boundary.
   */
  readonly runtimeInstanceId: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
  /** The canonical attempt-scoped failure of a terminal FAILED attempt, when settled. */
  readonly failure?: ExecutionAttemptFailure;
}

export const executionAttemptSeedFingerprint = (
  seed: Omit<ExecutionAttemptSeed, 'fingerprint'>,
): string =>
  sha256Hex(
    canonicalJson({
      purpose: EXECUTION_ATTEMPT_SCHEMA,
      companyId: seed.companyId,
      runId: seed.runId,
      taskId: seed.taskId,
      attemptNumber: seed.attemptNumber,
      roleId: seed.roleId,
      taskKind: seed.taskKind,
    }),
  );

export const createExecutionAttempt = (
  input: Omit<ExecutionAttemptSeed, 'schema' | 'fingerprint'> & {
    readonly runtimeInstanceId?: string | null;
    readonly now: string;
  },
): Result<ExecutionAttempt, DomainError> => {
  if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1) {
    return err(
      domainError('INVALID_ARGUMENT', 'An execution attempt number must be a positive integer.', {
        attemptNumber: input.attemptNumber,
      }),
    );
  }
  if (input.roleId.trim() === '' || input.taskKind.trim() === '') {
    return err(
      domainError('INVALID_ARGUMENT', 'An execution attempt seed needs the pinned roleId and taskKind.', {}),
    );
  }
  const id = input.id;
  const base: Omit<ExecutionAttemptSeed, 'fingerprint' | 'schema'> & { schema: typeof EXECUTION_ATTEMPT_SCHEMA } = {
    schema: EXECUTION_ATTEMPT_SCHEMA,
    id,
    companyId: input.companyId,
    runId: input.runId,
    taskId: input.taskId,
    attemptNumber: input.attemptNumber,
    roleId: input.roleId,
    taskKind: input.taskKind,
  };
  const fingerprint = executionAttemptSeedFingerprint(base);
  const seed: ExecutionAttemptSeed = { ...base, fingerprint };
  const attempt: ExecutionAttempt = {
    seed,
    state: 'ACTIVE',
    runtimeInstanceId: input.runtimeInstanceId ?? null,
    createdAt: input.now,
    settledAt: null,
  };
  return ok(attempt);
};

export const nextExecutionAttemptState = (
  to: ExecutionAttemptState,
  from: ExecutionAttemptState,
): Result<ExecutionAttemptState, DomainError> => {
  if (!TRANSITIONS[from].includes(to)) {
    return err(
      domainError('ILLEGAL_TRANSITION', `Execution attempt cannot move "${from}" → "${to}".`, { from, to }),
    );
  }
  return ok(to);
};

export const applyExecutionAttemptTransition = (
  attempt: ExecutionAttempt,
  to: ExecutionAttemptState,
  now: string,
): Result<ExecutionAttempt, DomainError> => {
  const next = nextExecutionAttemptState(to, attempt.state);
  if (!next.ok) return next;
  const terminal = to === 'COMPLETED' || to === 'FAILED';
  return ok({
    ...attempt,
    state: to,
    settledAt: terminal ? now : attempt.settledAt,
  });
};
