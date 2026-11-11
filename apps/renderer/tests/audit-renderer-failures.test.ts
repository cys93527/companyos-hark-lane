/**
 * AUDIT R3 — typed action failures are visible on Home (no Goal open), in Settings,
 * and model-selection failures reach the onboarding card.
 */
import './support/mini-dom.js';

import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatView } from '../src/chat.js';
import { createLocalDraftStore } from '../src/local-draft-store.js';
import { memoryStorage, mountApp,
  settle, unmountApp, WORKSPACE } from './support/audit-app-harness.js';

afterEach(() => unmountApp());

describe('AUDIT R3 — action failures have a visible surface', () => {
  it('ChatView empty state renders the failure instead of hiding it', () => {
    const html = renderToStaticMarkup(
      h(ChatView, { objective: null, entries: [], loading: false, failure: { code: 'GOAL_CREATE_FAILED', message: 'x' } }),
    );
    expect(html).toContain('GOAL_CREATE_FAILED');
    expect(html).toContain('role="alert"');
  });

  it('Home with no Goal open: a refused goal.create is shown in the composer dock', async () => {
    const storage = memoryStorage();
    createLocalDraftStore(storage).save('company_default', WORKSPACE, '整理文档');
    const app = await mountApp({
      storage,
      control: (call) =>
        call.operation === 'goal.create'
          ? { ok: false, error: { code: 'MODEL_SELECTION_REQUIRED', message: '请先选择模型' } }
          : undefined,
    });
    await app.click('发送');
    expect(app.view.textContent).toContain('MODEL_SELECTION_REQUIRED');
  });

  it('Settings: a refused workspace switch is shown (dock line is visible on every view)', async () => {
    const app = await mountApp({
      control: () => undefined,
      workspaceSelect: async () => '/other',
      workspaceSwitch: async (root) => ({ ok: false, root, error: 'BUSY' }),
    });
    await app.click('设置');
    await app.click('更换工作空间');
    expect(app.view.textContent).toContain('WORKSPACE_SWITCH_REFUSED');
  });

  it('a failed model choice reaches the onboarding card', async () => {
    const app = await mountApp({
      modelSelected: false,
      control: () => undefined,
      workflow: (operation) => {
        if (operation === 'models.catalogue') {
          return { ok: true, value: [{ providerId: 'p', providerModelId: 'm', displayName: 'Model X' }] };
        }
        if (operation === 'models.register') return { ok: false, error: { code: 'MODEL_REGISTER_FAILED', message: '注册失败' } };
        return undefined;
      },
    });
    // UI-AUDIT-2: the provider's only model is chosen automatically (no catalogue list is offered);
    // its failed registration shows in plain Chinese, the code stays under 详情.
    await settle();
    expect(app.view.textContent).toContain('无法注册该模型');
    expect(app.view.textContent).toContain('MODEL_REGISTER_FAILED');
    expect(app.button('Model X未注册')).toBeNull();
  });
});
