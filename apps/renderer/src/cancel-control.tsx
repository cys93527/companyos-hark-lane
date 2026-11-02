/**
 * AUDIT-R1 — the cancel control of the open Goal. The shipped app had no way to stop a Goal (the main process
 * supports goal.cancel; GoalWorkspaceView with its cancel text was never rendered). Shown while the open Goal is
 * not ended: 取消目标 -> in-app confirmation (确认取消 / 继续执行) -> one goal.cancel request (single-flight).
 * A durable cancel intent is shown as "已请求取消…正在收尾" until the Goal reaches its terminal state.
 */
import { createElement as h, type JSX } from 'react';

export const CANCEL_REQUESTED_TEXT = '已请求取消，不再启动新的工作；正在收尾';

export interface GoalCancelControlProps {
  readonly visible: boolean;
  readonly requested: boolean;
  readonly confirming: boolean;
  readonly busy: boolean;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly onRequest: () => void;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
}

export function GoalCancelControl(props: GoalCancelControlProps): JSX.Element | null {
  if (!props.visible) return null;
  const failure = props.failure === null
    ? null
    : h('p', { className: 'typed-error__message', role: 'alert' }, `${props.failure.code} ${props.failure.message}`);
  if (props.requested) {
    return h('div', { className: 'goal-cancel goal-cancel--requested', 'data-testid': 'goal-cancel-requested', role: 'status' }, CANCEL_REQUESTED_TEXT, failure);
  }
  if (props.confirming) {
    return h(
      'div',
      { className: 'goal-cancel goal-cancel--confirm', role: 'alertdialog', 'aria-label': '确认取消目标' },
      h('p', null, '取消后 CompanyOS 不再启动新的工作或模型调用，正在进行的步骤会收尾。确定取消这个目标吗？'),
      h('button', { type: 'button', className: 'btn btn--danger', disabled: props.busy, onClick: props.onConfirm, 'data-testid': 'goal-cancel-confirm' }, props.busy ? '正在取消…' : '确认取消'),
      h('button', { type: 'button', className: 'btn', disabled: props.busy, onClick: props.onDismiss, 'data-testid': 'goal-cancel-dismiss' }, '继续执行'),
      failure,
    );
  }
  return h(
    'div',
    { className: 'goal-cancel' },
    h('button', { type: 'button', className: 'btn', onClick: props.onRequest, 'data-testid': 'goal-cancel' }, '取消目标'),
    failure,
  );
}
