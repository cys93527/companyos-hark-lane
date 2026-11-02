/**
 * AUDIT R1 — the shipped app can cancel the open Goal: 取消目标 -> in-app confirm -> ONE goal.cancel for the open
 * Goal; the durable intent shows "已请求取消…正在收尾"; ended Goals show no control.
 */
import './support/mini-dom.js';

import { afterEach, describe, expect, it } from 'vitest';

import { projectConversation } from '../src/chat.js';
import { mountApp, unmountApp, waitFor } from './support/audit-app-harness.js';

afterEach(() => unmountApp());

const workspaceOf = (runId: string, state: string, cancellationRequested = false) => ({
  runId,
  cancellationRequested,
  goal: { objective: 'Goal A' },
  planningRun: { state: 'COMPLETED', revision: 1 },
  overview: {
    runId, state, revision: 1, reworkCount: 0, maxRework: 3, failureReason: null, resumePoint: null,
    pinnedVersion: null, stages: [], executing: [],
    attempts: { active: 0, interrupted: 0, completed: 0, failed: 0 },
    validation: { requiredValidatorIds: [], completed: [], failed: false, missing: [] },
    correctiveActivity: null, handoffCount: 0,
    progress: { stagesTotal: 0, stagesTerminalSuccessful: 0, tasksTotal: 0, tasksDone: 0, tasksActive: 0, tasksBlocked: 0 },
    artifacts: [],
  },
  blockers: [],
  executionRuns: [],
});

const setup = async (state: string, onCancel: () => unknown = () => ({ ok: true, value: { accepted: true, stopped: false, stopEvidence: 'NOT_CONFIRMED' } })) => {
  let requested = false;
  const app = await mountApp({
    control: (call) => {
      if (call.operation === 'home.summary') return { ok: true, value: { goals: [{ runId: 'run_goal_a', state, objective: 'Goal A' }] } };
      if (call.operation === 'goal.workspace') return { ok: true, value: workspaceOf('run_goal_a', state, requested) };
      if (call.operation === 'run.timeline') return { ok: true, value: { entries: [] } };
      if (call.operation === 'run.artifacts') return { ok: true, value: { artifacts: [] } };
      if (call.operation === 'goal.cancel') { const r = onCancel(); if ((r as { ok?: boolean }).ok === true) requested = true; return r; }
      return undefined;
    },
  });
  await app.click('Goal A');
  await waitFor(() => app.view.textContent.includes('阶段'));
  return app;
};

describe('AUDIT R1 — cancel control', () => {
  it('confirm sends exactly one goal.cancel for the open Goal and shows the pending-cancel state', async () => {
    const app = await setup('EXECUTING');
    await app.click('取消目标');
    expect(app.view.textContent).toContain('确定取消这个目标吗');
    expect(app.callsOf('goal.cancel')).toHaveLength(0);
    await app.click('确认取消');
    await waitFor(() => app.view.textContent.includes('已请求取消，不再启动新的工作；正在收尾'));
    expect(app.callsOf('goal.cancel')).toHaveLength(1);
    expect(app.callsOf('goal.cancel')[0]!.payload).toMatchObject({ runId: 'run_goal_a' });
    expect(app.view.textContent).not.toContain('取消目标');
  });

  it('继续执行 dismisses without a request; a refused cancel shows its typed error', async () => {
    const app = await setup('EXECUTING', () => ({ ok: false, error: { code: 'CONFLICT', message: '目标已结束' } }));
    await app.click('取消目标');
    await app.click('继续执行');
    expect(app.callsOf('goal.cancel')).toHaveLength(0);
    await app.click('取消目标');
    await app.click('确认取消');
    await waitFor(() => app.view.textContent.includes('CONFLICT 目标已结束'));
  });

  it('an ended Goal has no cancel control', async () => {
    const app = await setup('COMPLETED');
    expect(app.view.textContent).not.toContain('取消目标');
  });

  it('the conversation shows the durable cancel intent until the Goal ends', () => {
    const live = projectConversation(workspaceOf('r', 'EXECUTING', true) as never, 'x', []);
    expect(live.some((e) => e.kind === 'cancel-requested')).toBe(true);
    const ended = projectConversation({ ...workspaceOf('r', 'FAILED', true), overview: { ...workspaceOf('r', 'FAILED', true).overview, failureReason: 'cancelled' } } as never, 'x', []);
    expect(ended.some((e) => e.kind === 'cancel-requested')).toBe(false);
    expect(ended.some((e) => e.kind === 'cancelled')).toBe(true);
  });
});

describe('AUDIT R4 — access chip shows the next Goal policy', () => {
  it('a fresh app shows the default 询问权限 (what the next Goal gets), not 只读', async () => {
    const app = await mountApp({ control: (call) => (call.operation === 'home.summary' ? { ok: true, value: { goals: [] } } : undefined) });
    const chips = app.view.textContent;
    expect(chips).toContain('询问权限 ▾');
    expect(chips).not.toContain('只读 ▾');
  });
  it('the selection drives the chip even while an executing Goal is open', async () => {
    const app = await setup('EXECUTING');
    expect(app.view.textContent).not.toContain('工作区操作 ▾');
    await app.click('询问权限 ▾');
    await app.click('只读');
    expect(app.view.textContent).toContain('只读 ▾');
  });
});
