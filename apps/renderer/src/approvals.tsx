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
  input: { readonly runId: string; readonly decision: ApprovalDecision; readonly note?: string },
): Promise<{ readonly ok: boolean; readonly message: string | null }> => {
  const response = (await bridge.controlPlaneRequest({
    operation: 'approval.respond',
    payload: {
      companyId: 'company_default',
      runId: input.runId,
      decision: input.decision,
      ...(input.note === undefined || input.note === '' ? {} : { note: input.note }),
    },
  })) as { readonly ok: boolean; readonly error?: { readonly code?: string; readonly message?: string } };
  return response.ok
    ? { ok: true, message: null }
    : { ok: false, message: response.error?.message ?? '审批提交失败。' };
};

/** Only pending rows are decisions; a decided row is history and is never offered again. */
export const pendingApprovalOf = (decision: PendingDecision): PendingApprovalRow | null =>
  decision.approvals.find((row) => row.status === 'pending') ?? null;

export interface ApprovalCardViewProps {
  readonly decision: PendingDecision;
  readonly busy: boolean;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

/** Pure view: the approval card. Shows only safe canonical facts — never a raw secret or CoT. */
export function ApprovalCardView(props: ApprovalCardViewProps): JSX.Element {
  const approval = pendingApprovalOf(props.decision);
  if (approval === null) return h('div', { className: 'approval-card approval-card--none' });
  return h(
    'section',
    { className: 'approval-card', 'aria-label': 'approval-card', role: 'alertdialog' },
    h('h3', { className: 'approval-card__title' }, '需要你的批准'),
    h('dl', { className: 'kv approval-card__kv' },
      h('dt', null, '操作'),
      h('dd', null, approval.reason === '' ? '（未提供原因）' : approval.reason),
      h('dt', null, '风险等级'),
      h('dd', null, approval.riskLevel),
      h('dt', null, '范围'),
      h('dd', null, `Run ${approval.runId}${approval.taskId === null ? '' : ` · Task ${approval.taskId}`}`),
      h('dt', null, '请求方'),
      h('dd', null, approval.requestedBy === '' ? '—' : approval.requestedBy),
      h('dt', null, '请求时间'),
      h('dd', null, approval.requestedAt === '' ? '—' : approval.requestedAt),
    ),
    h(
      'div',
      { className: 'approval-card__actions' },
      h(
        'button',
        { type: 'button', className: 'approval-card__deny', disabled: props.busy, onClick: () => props.onDecide('deny') },
        '拒绝',
      ),
      h(
        'button',
        { type: 'button', className: 'approval-card__approve', disabled: props.busy, onClick: () => props.onDecide('approve') },
        '批准',
      ),
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
