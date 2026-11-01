/**
 * AUDIT R2 — a canonically refused goal.create must not lock the composer, and an
 * unconfirmed intent is never replayed silently: it is shown with explicit 重试 / 放弃.
 */
import './support/mini-dom.js';

import { afterEach, describe, expect, it } from 'vitest';

import { SUBMISSION_INTENT_STORAGE_KEY } from '../src/intent-store.js';
import { createLocalDraftStore } from '../src/local-draft-store.js';
import { createSubmissionController, type SubmissionIntentRecord } from '../src/submission-intent.js';
import { memoryStorage, mountApp, unmountApp, WORKSPACE } from './support/audit-app-harness.js';

afterEach(() => unmountApp());

const memStore = () => {
  let record: SubmissionIntentRecord | null = null;
  return { load: () => record, save: (next: SubmissionIntentRecord | null) => { record = next; } };
};

describe('AUDIT R2 — submission refusal vs unknown outcome', () => {
  it('a typed refusal clears the intent so the next submission is accepted', async () => {
    const seen: string[] = [];
    let n = 0;
    const controller = createSubmissionController({
      store: memStore(),
      submit: async ({ intentId }) => {
        seen.push(intentId);
        return { error: 'no model', code: 'MODEL_SELECTION_REQUIRED' };
      },
      now: () => '',
      newIntentId: () => `si-${String((n += 1))}`,
    });
    const first = await controller.submitObjective('A', WORKSPACE);
    expect(first).toMatchObject({ status: 'refused', code: 'MODEL_SELECTION_REQUIRED' });
    expect(controller.pending()).toBeNull();
    const second = await controller.submitObjective('B', WORKSPACE);
    expect(second.status).toBe('refused');
    expect(seen).toEqual(['si-1', 'si-2']);
  });

  it('an unknown outcome (IPC_FAILED / PERSISTENCE_FAILED / no code) keeps the intent pending', async () => {
    for (const code of ['IPC_FAILED', 'PERSISTENCE_FAILED', undefined]) {
      const controller = createSubmissionController({
        store: memStore(),
        submit: async () => (code === undefined ? { error: 'x' } : { error: 'x', code }),
        now: () => '',
        newIntentId: () => 'si-1',
      });
      expect((await controller.submitObjective('A', WORKSPACE)).status).toBe('failed');
      expect(controller.pending()?.intentId).toBe('si-1');
    }
  });

  it('App: after a refused goal.create the composer stays usable (no lock, no pending banner)', async () => {
    const storage = memoryStorage();
    createLocalDraftStore(storage).save('company_default', WORKSPACE, '写一份报告');
    const app = await mountApp({
      storage,
      control: (call) =>
        call.operation === 'goal.create'
          ? { ok: false, error: { code: 'GOAL_WORKSPACE_NOT_OPEN', message: '工作空间未打开' } }
          : undefined,
    });
    await app.click('提交并开始执行');
    expect(app.callsOf('goal.create')).toHaveLength(1);
    expect(app.view.textContent).not.toContain('上一次提交尚未确认');
    expect(app.button('提交并开始执行')?.getAttribute('disabled')).toBeNull();
    expect(storage.getItem(SUBMISSION_INTENT_STORAGE_KEY)).toBeNull();
    await app.click('提交并开始执行');
    const creates = app.callsOf('goal.create');
    expect(creates).toHaveLength(2);
    expect(creates[0]?.payload['commandId']).not.toBe(creates[1]?.payload['commandId']);
  });

  it('App: a pending intent from a previous session is NOT replayed on mount; 重试 replays the same id', async () => {
    const storage = memoryStorage();
    storage.setItem(
      SUBMISSION_INTENT_STORAGE_KEY,
      JSON.stringify({ intentId: 'si-old', objective: '旧目标', workspaceRoot: WORKSPACE, state: 'pending', createdAt: '', attempted: true }),
    );
    const app = await mountApp({
      storage,
      control: (call) => (call.operation === 'goal.create' ? { ok: true, value: { runId: 'run_goal_1' } } : undefined),
    });
    expect(app.callsOf('goal.create')).toHaveLength(0);
    expect(app.view.textContent).toContain('上一次提交尚未确认：「旧目标」');
    await app.click('重试');
    const creates = app.callsOf('goal.create');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.payload['commandId']).toBe('si-old');
    expect(app.view.textContent).not.toContain('上一次提交尚未确认');
  });

  it('App: 放弃 drops the pending intent without calling goal.create', async () => {
    const storage = memoryStorage();
    storage.setItem(
      SUBMISSION_INTENT_STORAGE_KEY,
      JSON.stringify({ intentId: 'si-old', objective: '旧目标', workspaceRoot: WORKSPACE, state: 'pending', createdAt: '' }),
    );
    const app = await mountApp({ storage, control: () => undefined });
    await app.click('放弃');
    expect(app.callsOf('goal.create')).toHaveLength(0);
    expect(app.view.textContent).not.toContain('上一次提交尚未确认');
    expect(storage.getItem(SUBMISSION_INTENT_STORAGE_KEY)).toBeNull();
  });
});
