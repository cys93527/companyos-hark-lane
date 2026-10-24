/**
 * Command → Event routing (Sprint 2 requirement 2: the execution boundary).
 *
 * A command expresses INTENT ("complete planning"); an event records the FACT that
 * happened in the L1 machine ("run.plan_ready"). The engine owns exactly this
 * mapping, so the two vocabularies stay separate and every intent has exactly one
 * legal fact.
 */
import { COMMANDS_REQUIRING_REASON, COMMAND_FAILURE_REASON, domainError, err, ok } from '@companyos/core';
import type {
  DomainError,
  Result,
  RunCommand,
  RunCommandType,
  RunEvent,
  RunFailureReason,
} from '@companyos/core';

/** Total mapping: every command type routes to exactly one L1 event. */
export const COMMAND_TO_EVENT: Readonly<Record<RunCommandType, RunEvent>> = {
  'RUN.START': 'START',
  'TEMPLATE.RESOLVE': 'TEMPLATE_RESOLVED',
  'TEMPLATE.MISSING': 'TEMPLATE_MISSING',
  'DRAFT.SUBMIT': 'SUBMIT_DRAFT',
  'DRAFT.APPROVE': 'DRAFT_APPROVED',
  'DRAFT.REJECT': 'DRAFT_REJECTED',
  'RUN.CREATE': 'RUN_CREATED',
  'PLAN.COMPLETE': 'PLAN_READY',
  'ROUTE.RESOLVE': 'ROUTE_RESOLVED',
  'ROUTE.FAIL': 'ROUTE_FAILED',
  'APPROVAL.REQUEST': 'APPROVAL_REQUIRED',
  'APPROVAL.GRANT': 'APPROVAL_GRANTED',
  'APPROVAL.DENY': 'APPROVAL_DENIED',
  'EXECUTION.COMPLETE': 'EXECUTION_DONE',
  'EXECUTION.FAIL': 'EXECUTION_FAILED',
  'REVIEW.PASS': 'REVIEW_PASSED',
  'REVIEW.REJECT': 'REVIEW_REJECTED',
  'REWORK.READY': 'REWORK_READY',
  'REWORK.EXHAUST': 'REWORK_EXHAUSTED',
  'VALIDATION.PASS': 'VALIDATION_PASSED',
  'VALIDATION.FAIL': 'VALIDATION_FAILED',
  'DELIVERY.COMPLETE': 'DELIVERED',
  'GOAL.OUTCOME.DELIVER': 'OUTCOME_DELIVERED',
  'DELIVERY.FAIL': 'DELIVERY_FAILED',
  'RUN.PAUSE': 'PAUSE',
  'RUN.RESUME': 'RESUME',
  'CRASH.DETECTED': 'CRASH_DETECTED',
  'RECOVERY.COMPLETE': 'RECOVERED',
  'RECOVERY.FAIL': 'RECOVERY_FAILED',
  'RUN.CANCEL': 'CANCEL',
  'RUN.TIMEOUT': 'TIMEOUT',
};

export interface RoutedCommand {
  readonly event: RunEvent;
  /** `null` when the command does not imply a run failure. */
  readonly failureReason: RunFailureReason | null;
}

/**
 * Route one command to its event.
 *
 * `RunEvent` sanity: the mapping is exhaustive by construction (`Record` over the
 * command union), so a new command type cannot be added without deciding its event.
 */
export function routeCommand(command: RunCommand): Result<RoutedCommand, DomainError> {
  const event = COMMAND_TO_EVENT[command.type];
  if (event === undefined) {
    return err(
      domainError('NOT_IMPLEMENTED', `Command "${command.type}" has no routing yet.`, {
        commandId: command.commandId,
        type: command.type,
      }),
    );
  }
  return ok({ event, failureReason: COMMAND_FAILURE_REASON[command.type] ?? null });
}

/** Commands that need a reason carry it; the router proves the pair is consistent. */
export function assertReasonConsistency(command: RunCommand): Result<true, DomainError> {
  if (!COMMANDS_REQUIRING_REASON.includes(command.type)) return ok(true);
  if (command.reason === undefined || command.reason.trim().length === 0) {
    return err(
      domainError('INVALID_ARGUMENT', `Command "${command.type}" must carry a reason.`, {
        commandId: command.commandId,
        type: command.type,
      }),
    );
  }
  return ok(true);
}
