/**
 * STAGE 3 — the approval experience.
 *
 * The card renders canonical pending-approval truth (run blocker `APPROVAL_REQUIRED` plus
 * the canonical `approvals` row behind it) and offers exactly two actions, both of which
 * go through the canonical `approval.respond` seam. The renderer never resumes a run,
 * settles a task, forces a retry or edits blocker state itself: it asks, and the engine
 * decides.
 */
import { createElement as h, type JSX } from 'react';

import { clockStamp, orUnknown, riskWord } from './format.js';

import type { ControlPlaneBridge } from './workspace.js';

/** The canonical approval row as projected by `decisions.pending`. */
export interface PendingApprovalRow {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly riskLevel: string;
  readonly status: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
}

export interface PendingDecision {
  readonly runId: string;
  readonly runState: string;
  readonly approvals: readonly PendingApprovalRow[];
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Read the canonical pending decisions for the company (read-only). */
export const loadPendingDecisions = async (bridge: ControlPlaneBridge): Promise<readonly PendingDecision[]> => {
  const response = (await bridge.controlPlaneRequest({
    operation: 'decisions.pending',
    payload: { companyId: 'company_default' },
  })) as { readonly ok: boolean; readonly value?: unknown };
  if (!response.ok || response.value === undefined) return [];
  const pending = asArray(asRecord(response.value)?.['pending']);
  return pending.map((entry) => {
    const row = asRecord(entry) ?? {};
    return {
      runId: text(row['runId']),
      runState: text(row['runState']),
      approvals: asArray(row['approvals']).map((approval) => {
        const approvalRow = asRecord(approval) ?? {};
        return {
          id: text(approvalRow['id']),
          runId: text(approvalRow['runId']),
          taskId: typeof approvalRow['taskId'] === 'string' ? (approvalRow['taskId'] as string) : null,
          riskLevel: text(approvalRow['riskLevel']) || 'UNKNOWN',
          status: text(approvalRow['status']) || 'pending',
          reason: text(approvalRow['reason']),
          requestedBy: text(approvalRow['requestedBy']),
          requestedAt: text(approvalRow['requestedAt']),
          decidedBy: typeof approvalRow['decidedBy'] === 'string' ? (approvalRow['decidedBy'] as string) : null,
          decidedAt: typeof approvalRow['decidedAt'] === 'string' ? (approvalRow['decidedAt'] as string) : null,
          decisionNote: typeof approvalRow['decisionNote'] === 'string' ? (approvalRow['decisionNote'] as string) : null,
        };
      }),
    };
  });
};

export type ApprovalDecision = 'approve' | 'deny';

/** The ONE canonical command: `approval.respond`. Nothing else can resume the run. */
export const respondToApproval = async (
  bridge: ControlPlaneBridge,
  input: { readonly runId: string; readonly decision: ApprovalDecision; readonly note?: string; readonly approvalId?: string },
): Promise<{ readonly ok: boolean; readonly message: string | null; readonly code?: string }> => {
  const response = (await bridge.controlPlaneRequest({
    operation: 'approval.respond',
    payload: {
      companyId: 'company_default',
      runId: input.runId,
      decision: input.decision,
      // UI-AUDIT-04: the decision is bound to the approval row the user saw.
      ...(input.approvalId === undefined || input.approvalId === '' ? {} : { approvalId: input.approvalId }),
      ...(input.note === undefined || input.note === '' ? {} : { note: input.note }),
    },
  })) as { readonly ok: boolean; readonly error?: { readonly code?: string; readonly message?: string; readonly details?: { readonly reason?: unknown } } };
  if (response.ok) return { ok: true, message: null };
  const reason = typeof response.error?.details?.reason === 'string' ? response.error.details.reason : undefined;
  // Only the two typed decision refusals get their own code; everything else stays the generic one.
  const code = reason === 'APPROVAL_STALE' || reason === 'APPROVAL_GOAL_CANCELLED' ? reason : undefined;
  const message = reason === 'APPROVAL_STALE'
    ? '这条审批已被处理或已被新的请求取代，未做任何决定；已刷新为最新的请求，请重新确认。'
    : reason === 'APPROVAL_GOAL_CANCELLED'
      ? '目标已请求取消，批准不会再恢复执行。'
      : response.error?.message ?? '审批提交失败。';
  return { ok: false, message, ...(code === undefined ? {} : { code }) };
};

/** Only pending rows are decisions; a decided row is history and is never offered again. */
export const pendingApprovalOf = (decision: PendingDecision): PendingApprovalRow | null =>
  decision.approvals.find((row) => row.status === 'pending') ?? null;

export interface ApprovalCardViewProps {
  readonly decision: PendingDecision;
  readonly busy: boolean;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly onDecide: (decision: ApprovalDecision) => void;
  /** UI-AUDIT-05: the Goal has a durable cancel intent — the request is shown, not actionable. */
  readonly cancelRequested?: boolean;
  /** The open Goal's access policy (scope line), when known. */
  readonly scopeNote?: string | null;
}

/**
 * Pure view: the inline approval block. Shows only safe canonical facts — never a raw
 * secret or CoT. UI-AUDIT-07: no button is focused by default and there is no global
 * approve shortcut (a stray Enter/shortcut must never approve); the block itself takes
 * focus once per new request (App) so it is announced, and 批准 is the one primary
 * action, 拒绝 the quiet one.
 */
export function ApprovalCardView(props: ApprovalCardViewProps): JSX.Element {
  const approval = pendingApprovalOf(props.decision);
  if (approval === null) return h('div', { className: 'approval-card approval-card--none' });
  const cancelled = props.cancelRequested === true;
  return h(
    'section',
    {
      className: 'approval-card',
      'data-testid': 'approval-card',
      'data-approval-id': approval.id,
      'aria-label': '待批准事项',
      'aria-describedby': `approval-reason-${approval.id}`,
      role: 'group',
      tabIndex: -1,
    },
    h(
      'div',
      { className: 'approval-card__head' },
      h('h3', { className: 'approval-card__title' }, '需要你的批准'),
      h('span', { className: 'approval-card__risk', title: `风险等级 ${approval.riskLevel}` }, `风险 · ${riskWord(approval.riskLevel)}`),
    ),
    h('p', { className: 'approval-card__reason', id: `approval-reason-${approval.id}` }, approval.reason === '' ? '（未提供原因）' : approval.reason),
    h('dl', { className: 'kv approval-card__kv' },
      h('dt', null, '范围'),
      h('dd', { className: 'num' }, `Run ${approval.runId}${approval.taskId === null ? '' : ` · Task ${approval.taskId}`}${props.scopeNote == null ? '' : ` · ${props.scopeNote}`}`),
      h('dt', null, '请求方'),
      h('dd', null, orUnknown(approval.requestedBy)),
      h('dt', null, '请求时间'),
      h('dd', { className: 'num', title: approval.requestedAt === '' ? undefined : approval.requestedAt }, approval.requestedAt === '' ? '--' : clockStamp(approval.requestedAt) === '--' ? approval.requestedAt : clockStamp(approval.requestedAt)),
    ),
    cancelled
      ? h('p', { className: 'approval-card__hint', role: 'status' }, '目标已请求取消：这条请求不会再被执行，无需处理。')
      : h(
          'div',
          { className: 'approval-card__actions' },
          h(
            'button',
            { type: 'button', className: 'btn btn--primary approval-card__approve', disabled: props.busy, onClick: () => props.onDecide('approve') },
            props.busy ? '提交中…' : '批准',
          ),
          h(
            'button',
            { type: 'button', className: 'btn btn--quiet approval-card__deny', disabled: props.busy, onClick: () => props.onDecide('deny') },
            '拒绝',
          ),
          h('span', { className: 'approval-card__hint' }, '目标已暂停，等待你的决定；不会启动新的模型调用'),
        ),
    props.failure === null
      ? null
      : h('p', { className: 'typed-error__message', role: 'alert' }, `${props.failure.code} ${props.failure.message}`),
  );
}

/**
 * The effective access mode shown by the composer. Mode selection itself is DISPLAY-ONLY:
 * no canonical per-Goal access-mode write seam exists, so the renderer must not invent one.
 * What IS actionable is the canonical approval boundary, which this projection reports.
 */
export interface AuthorityModeView {
  readonly mode: 'ask-permission' | 'read-only' | 'workspace-operations';
  readonly basis: string;
  readonly pendingApprovalRunId: string | null;
}

export const projectAuthorityMode = (input: {
  readonly runState: string | null;
  readonly approvalPending: boolean;
}): AuthorityModeView =>
  input.approvalPending
    ? { mode: 'ask-permission', basis: 'canonical approval pending', pendingApprovalRunId: null }
    : input.runState !== null && ['EXECUTING', 'RUNNING'].includes(input.runState)
      ? { mode: 'workspace-operations', basis: `runState:${input.runState}`, pendingApprovalRunId: null }
      : { mode: 'read-only', basis: input.runState === null ? 'no-active-run' : `runState:${input.runState}`, pendingApprovalRunId: null };
