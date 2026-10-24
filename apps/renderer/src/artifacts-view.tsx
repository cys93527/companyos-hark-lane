/**
 * STAGE 3 — the bounded artifact actions from the renderer side.
 *
 * The renderer names a CANONICAL ARTIFACT ID and nothing else. It never sees, builds or
 * sends a path: the main process resolves the id against the artifact CAS, enforces
 * containment, and refuses anything it cannot prove.
 */
import { createElement as h, type JSX } from 'react';

export type ArtifactOperation = 'preview' | 'open' | 'reveal';

export interface ArtifactActionBridge {
  artifactAction(request: { readonly operation: ArtifactOperation; readonly artifactId: string }): Promise<unknown>;
}

export interface ArtifactActionResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly code?: string;
  readonly message?: string;
}

export interface ArtifactRow {
  readonly artifactId: string;
  readonly kind: string;
}

export const runArtifactAction = async (
  bridge: ArtifactActionBridge | null,
  operation: ArtifactOperation,
  artifact: ArtifactRow,
): Promise<ArtifactActionResult<{ readonly text: string; readonly truncated: boolean; readonly kind: string }>> => {
  if (bridge === null) {
    return { ok: false, code: 'ARTIFACT_SURFACE_UNAVAILABLE', message: '产物表面需要桌面外壳。' };
  }
  const response = (await bridge.artifactAction({ operation, artifactId: artifact.artifactId })) as ArtifactActionResult<{
    readonly text: string;
    readonly truncated: boolean;
    readonly kind: string;
  }>;
  return response;
};

export interface ArtifactActionsViewProps {
  readonly artifact: ArtifactRow;
  readonly busy: boolean;
  readonly preview: { readonly text: string; readonly truncated: boolean; readonly kind: string } | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly onPreview: () => void;
  readonly onOpen: () => void;
  readonly onReveal: () => void;
}

/** Pure view: preview / open / reveal for ONE canonical artifact. */
export function ArtifactActionsView(props: ArtifactActionsViewProps): JSX.Element {
  return h(
    'div',
    { className: 'artifact-actions', 'aria-label': 'artifact-actions' },
    h(
      'div',
      { className: 'artifact-actions__buttons' },
      h('button', { type: 'button', disabled: props.busy, onClick: props.onPreview }, '预览'),
      h('button', { type: 'button', disabled: props.busy, onClick: props.onOpen }, '打开'),
      h('button', { type: 'button', disabled: props.busy, onClick: props.onReveal }, '在资源管理器中显示'),
    ),
    props.preview === null
      ? null
      : h(
          'pre',
          { className: 'artifact-actions__preview' },
          props.preview.text,
          props.preview.truncated ? h('span', { className: 'muted' }, '\n…（已截断，仅显示前 16 KiB）') : null,
        ),
    props.failure === null
      ? null
      : h('p', { className: 'typed-error__message', role: 'alert' }, `${props.failure.code} ${props.failure.message}`),
  );
}
