/**
 * Command vocabulary — the *intent* side of the boundary (Sprint 2).
 *
 * Boundary rule (AGENTS.md §1.3): the ENGINE may only depend on Core contracts and
 * ports. So the command vocabulary lives HERE, in Core, and the engine merely
 * interprets it. Commands are requests; events are facts — they are deliberately
 * two different vocabularies (see `docs/WORKFLOW_ENGINE.md`).
 *
 * Every command carries:
 *   - `commandId`         : the idempotency key (replay returns the first outcome);
 *   - `expectedRevision`  : optimistic concurrency guard against stale commands;
 *   - `traceId`/`actorId` : audit fields (规划书 §四十四).
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { WorkflowRunId } from '../kernel/identifiers.js';
import type { RunFailureReason } from './workflow-run.js';

/** Commands that may be dispatched against a run. */
export const RUN_COMMAND_TYPES = [
  'RUN.START',
  'TEMPLATE.RESOLVE',
  'TEMPLATE.MISSING',
  'DRAFT.SUBMIT',
  'DRAFT.APPROVE',
  'DRAFT.REJECT',
  'RUN.CREATE',
  'PLAN.COMPLETE',
  'ROUTE.RESOLVE',
  'ROUTE.FAIL',
  'APPROVAL.REQUEST',
  'APPROVAL.GRANT',
  'APPROVAL.DENY',
  'EXECUTION.COMPLETE',
  'EXECUTION.FAIL',
  'REVIEW.PASS',
  'REVIEW.REJECT',
  'REWORK.READY',
  'REWORK.EXHAUST',
  'VALIDATION.PASS',
  'VALIDATION.FAIL',
  'DELIVERY.COMPLETE',
  'GOAL.OUTCOME.DELIVER',
  'DELIVERY.FAIL',
  'RUN.PAUSE',
  'RUN.RESUME',
  'CRASH.DETECTED',
  'RECOVERY.COMPLETE',
  'RECOVERY.FAIL',
  'RUN.CANCEL',
  'RUN.TIMEOUT',
] as const;

export type RunCommandType = (typeof RUN_COMMAND_TYPES)[number];

export const isRunCommandType = (value: unknown): value is RunCommandType =>
  typeof value === 'string' && (RUN_COMMAND_TYPES as readonly string[]).includes(value);

export interface RunCommand {
  /** Idempotency key. Two dispatches with the same id are ONE effect. */
  readonly commandId: string;
  readonly runId: WorkflowRunId;
  readonly type: RunCommandType;
  /** The revision the issuer observed; a mismatch means the command is stale. */
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly traceId: string;
  readonly issuedAt: string;
  /** Required for the commands that carry a failure/decision reason. */
  readonly reason?: string;
  /** Command-specific data (e.g. `authorities` for APPROVAL.GRANT). */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** Commands that MUST carry a non-empty reason. */
export const COMMANDS_REQUIRING_REASON: readonly RunCommandType[] = [
  'RUN.PAUSE',
  'RUN.CANCEL',
  'RUN.TIMEOUT',
  'ROUTE.FAIL',
  'EXECUTION.FAIL',
  'GOAL.OUTCOME.DELIVER',
  'REVIEW.REJECT',
  'VALIDATION.FAIL',
  'DELIVERY.FAIL',
  'RECOVERY.FAIL',
  'REWORK.EXHAUST',
  'DRAFT.REJECT',
  'APPROVAL.DENY',
];

/** The run failure reason a command implies, when it implies one. */
export const COMMAND_FAILURE_REASON: Partial<Record<RunCommandType, RunFailureReason>> = {
  'ROUTE.FAIL': 'route_failed',
  'EXECUTION.FAIL': 'execution_failed',
  'DELIVERY.FAIL': 'delivery_failed',
  'RECOVERY.FAIL': 'recovery_failed',
  'APPROVAL.DENY': 'approval_denied',
  'RUN.CANCEL': 'cancelled',
  'RUN.TIMEOUT': 'timed_out',
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Validate an untrusted command envelope (the engine never trusts its caller). */
export function validateRunCommand(value: unknown): Result<RunCommand, DomainError> {
  const record = asRecord(value);
  if (record === null) {
    return err(domainError('INVALID_ARGUMENT', 'A command must be an object.', {}));
  }
  const commandId = record['commandId'];
  if (typeof commandId !== 'string' || commandId.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'commandId (idempotency key) is required.', {}));
  }
  const runId = record['runId'];
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'runId is required.', { commandId }));
  }
  const type = record['type'];
  if (!isRunCommandType(type)) {
    return err(domainError('INVALID_ARGUMENT', 'Unknown command type.', { commandId, type: String(type) }));
  }
  const expectedRevision = record['expectedRevision'];
  if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0) {
    return err(
      domainError('INVALID_ARGUMENT', 'expectedRevision must be a non-negative integer.', {
        commandId,
        expectedRevision,
      }),
    );
  }
  const actorId = record['actorId'];
  if (typeof actorId !== 'string' || actorId.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'actorId is required.', { commandId }));
  }
  const traceId = record['traceId'];
  if (typeof traceId !== 'string' || traceId.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'traceId is required.', { commandId }));
  }
  const issuedAt = record['issuedAt'];
  if (typeof issuedAt !== 'string' || issuedAt.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'issuedAt is required.', { commandId }));
  }

  const reason = record['reason'];
  if (reason !== undefined && (typeof reason !== 'string' || reason.trim().length === 0)) {
    return err(domainError('INVALID_ARGUMENT', 'reason must be a non-empty string when provided.', { commandId }));
  }
  if (COMMANDS_REQUIRING_REASON.includes(type) && reason === undefined) {
    return err(
      domainError('INVALID_ARGUMENT', `Command "${type}" requires a reason.`, { commandId, type }),
    );
  }

  const payload = record['payload'];
  if (payload !== undefined && asRecord(payload) === null) {
    return err(domainError('INVALID_ARGUMENT', 'payload must be an object when provided.', { commandId }));
  }

  return ok({
    commandId,
    runId: runId as WorkflowRunId,
    type,
    expectedRevision: expectedRevision as number,
    actorId,
    traceId,
    issuedAt,
    ...(reason === undefined ? {} : { reason }),
    ...(payload === undefined ? {} : { payload: payload as Readonly<Record<string, unknown>> }),
  });
}

/** Stable fingerprint used to detect idempotency-key reuse with different content. */
export const commandFingerprint = (command: RunCommand): string =>
  JSON.stringify([
    command.runId,
    command.type,
    command.expectedRevision,
    command.actorId,
    command.reason ?? null,
    command.payload ?? null,
  ]);
