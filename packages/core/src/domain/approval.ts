/**
 * Approval — the human gate (规划书 §四 Core 概念 14; §十一原则 11; §三十六 Risk System).
 *
 * Four risk levels:
 *   LOW      → 自动执行
 *   MEDIUM   → 自动执行 + 强制 Review
 *   HIGH     → 执行前审批
 *   CRITICAL → 必须明确确认
 *
 * So an Approval record may only exist for HIGH/CRITICAL; requesting one for a LOW
 * or MEDIUM task is a policy error, not a workflow step.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { IdFactory } from '../ports/id-factory.js';
import { makeId, type ApprovalId, type TaskId, type WorkflowRunId } from '../kernel/identifiers.js';

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** HIGH needs approval; CRITICAL needs explicit confirmation (规划书 §三十六). */
export const requiresHumanApproval = (risk: RiskLevel): boolean =>
  risk === 'HIGH' || risk === 'CRITICAL';

export interface Approval {
  readonly id: ApprovalId;
  readonly runId: WorkflowRunId;
  readonly taskId: TaskId | null;
  readonly riskLevel: RiskLevel;
  readonly status: ApprovalStatus;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
}

export interface RequestApprovalInput {
  readonly runId: WorkflowRunId;
  readonly riskLevel: RiskLevel;
  readonly reason: string;
  readonly requestedBy: string;
  readonly now: string;
  readonly ids: IdFactory;
  readonly taskId?: TaskId;
}

export function requestApproval(input: RequestApprovalInput): Result<Approval, DomainError> {
  if (!requiresHumanApproval(input.riskLevel)) {
    return err(
      domainError('POLICY_DENIED', `${input.riskLevel} work must not block on human approval.`, {
        riskLevel: input.riskLevel,
        guidance: 'LOW runs automatically; MEDIUM runs automatically with a mandatory review.',
      }),
    );
  }
  if (input.reason.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'An approval request needs a reason.', {}));
  }
  return ok({
    id: makeId<'ApprovalId'>('approval', input.ids),
    runId: input.runId,
    taskId: input.taskId ?? null,
    riskLevel: input.riskLevel,
    status: 'pending',
    reason: input.reason,
    requestedBy: input.requestedBy,
    requestedAt: input.now,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
  });
}

/** The authority token a decider must hold (规划书 §四十四 Audit: 谁做的). */
export const APPROVAL_AUTHORITY = 'run.approve';

export interface ApprovalDecision {
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly approved: boolean;
  /**
   * Authority tokens held by the decider (taken from their Role). The decision is
   * refused unless it contains `run.approve` — a free-text actor id alone is not
   * proof of authority (review finding MEDIUM-4).
   */
  readonly authorities: readonly string[];
  readonly note?: string;
}

export function decideApproval(
  approval: Approval,
  decision: ApprovalDecision,
): Result<Approval, DomainError> {
  if (approval.status !== 'pending') {
    return err(
      domainError('CONFLICT', `Approval ${approval.id} is already "${approval.status}".`, {
        approvalId: approval.id,
        status: approval.status,
      }),
    );
  }
  if (!decision.authorities.includes(APPROVAL_AUTHORITY)) {
    return err(
      domainError('POLICY_DENIED', `Deciding an approval requires the "${APPROVAL_AUTHORITY}" authority.`, {
        approvalId: approval.id,
        decidedBy: decision.decidedBy,
        authority: APPROVAL_AUTHORITY,
      }),
    );
  }
  if (decision.decidedBy === approval.requestedBy) {
    return err(
      domainError('POLICY_DENIED', 'Separation of duties: the requester cannot decide their own approval.', {
        approvalId: approval.id,
        requestedBy: approval.requestedBy,
      }),
    );
  }
  return ok({
    ...approval,
    status: decision.approved ? 'approved' : 'rejected',
    decidedBy: decision.decidedBy,
    decidedAt: decision.decidedAt,
    decisionNote: decision.note ?? null,
  });
}

export function expireApproval(approval: Approval, decidedAt: string): Result<Approval, DomainError> {
  if (approval.status !== 'pending') {
    return err(
      domainError('CONFLICT', `Approval ${approval.id} is already "${approval.status}".`, {
        approvalId: approval.id,
      }),
    );
  }
  return ok({ ...approval, status: 'expired', decidedBy: null, decidedAt });
}

/** CRITICAL confirmation must be explicit and attributable. */
export const isExplicitConfirmation = (approval: Approval): boolean =>
  approval.riskLevel === 'CRITICAL' &&
  approval.status === 'approved' &&
  approval.decidedBy !== null &&
  approval.decisionNote !== null;

export const blocksExecution = (approval: Approval): boolean =>
  approval.status === 'pending' || approval.status === 'rejected' || approval.status === 'expired';
