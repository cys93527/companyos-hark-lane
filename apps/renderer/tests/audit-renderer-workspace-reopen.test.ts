/**
 * AUDIT R10 — a persisted workspace root that main could not re-open is not treated as
 * open: the renderer confirms it through workspaceOpen and only then shows the composer.
 */
import './support/mini-dom.js';

import { afterEach, describe, expect, it } from 'vitest';

import { mountApp, unmountApp, WORKSPACE } from './support/audit-app-harness.js';

afterEach(() => unmountApp());

describe('AUDIT R10 — workspaceCurrent root is confirmed before use', () => {
  it('a root that fails to re-open keeps the chooser and shows a typed failure', async () => {
    const opened: string[] = [];
    const app = await mountApp({
      control: () => undefined,
      workspaceOpen: async (root) => {
        opened.push(root);
        return { ok: false, root, error: 'WORKSPACE_OPEN_FAILED' };
      },
    });
    expect(opened).toEqual([WORKSPACE]);
    expect(app.button('提交并开始执行')).toBeNull();
    expect(app.view.textContent).toContain('WORKSPACE_OPEN_FAILED');
    expect(app.view.textContent).toContain('选择一个工作空间目录');
  });

  it('a root that re-opens is used as the current workspace', async () => {
    const app = await mountApp({ control: () => undefined });
    expect(app.button('提交并开始执行')).not.toBeNull();
  });
});
