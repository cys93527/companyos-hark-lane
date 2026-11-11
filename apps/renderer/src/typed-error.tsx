/**
 * UI-AUDIT-2 — typed failures for a normal user. The main text is plain Chinese; internal
 * codes (POLICY_REFUSED, RUN_FAILED, INVALID_ARGUMENT …) and English evidence are kept, but
 * behind 详情, so support can still read them and the user is never handed an enum.
 */
import { createElement as h, type JSX } from 'react';

/**
 * UI-AUDIT-2: one typed failure line — the plain-Chinese text is what the user reads; the
 * internal code and the original message sit behind 详情 (support can still read them).
 */
export function TypedErrorLine(props: {
  readonly failure: { readonly code: string; readonly message: string };
  readonly text?: string | null;
  readonly className?: string;
}): JSX.Element {
  const text = props.text ?? plainFailureText(props.failure);
  const technical = props.failure.message === text ? props.failure.code : `${props.failure.code} · ${props.failure.message}`;
  return h(
    'div',
    { className: `typed-error__message ${props.className ?? ''}`.trim(), role: 'alert' },
    h('span', null, text),
    h('details', { className: 'tech' }, h('summary', null, '详情'), h('code', { className: 'tech__code' }, technical)),
  );
}

/** A typed failure's own message when it is Chinese; otherwise a plain fallback (never an English sentence as the main text). */
export const plainFailureText = (failure: { readonly code: string; readonly message: string }): string =>
  /[\u4e00-\u9fff]/u.test(failure.message) ? failure.message : '操作没有完成，请稍后重试。';
