/**
 * AUDIT R9 — the approval card/badge/authority belong to the OPEN Goal: Goal B's pending approval is never shown
 * as Goal A's card (批准 would approve B's action), it is listed as 其他目标待批准 instead.
 */
import './support/mini-dom.js';

import { afterEach, describe, expect, it } from 'vitest';

import { mountApp, unmountApp, waitFor } from './support/audit-app-harness.js';

afterEach(() => unmountApp());

const approval = (runId: string, reason: string) => ({
  id: `apr_${runId}`, runId, taskId: null, riskLevel: 'HIGH', status: 'pending', reason,
  requestedBy: 'agent', requestedAt: 'now', decidedBy: null, decidedAt: null, decisionNote: null,
});
const workspaceOf = (goal: string, exec: string) => ({
  runId: goal, goal: { objective: goal }, planningRun: { state: 'COMPLETED', revision: 1 },
  overview: {
    runId: exec, state: 'EXECUTING', revision: 1, reworkCount: 0, maxRework: 3, failureReason: null, resumePoint: null,
    pinnedVersion: null, stages: [], executing: [], attempts: { active: 0, interrupted: 0, completed: 0, failed: 0 },
    validation: { requiredValidatorIds: [], completed: [], failed: false, missing: [] }, correctiveActivity: null, handoffCount: 0,
    progress: { stagesTotal: 0, stagesTerminalSuccessful: 0, tasksTotal: 0, tasksDone: 0, tasksActive: 0, tasksBlocked: 0 }, artifacts: [],
  },
  blockers: [], executionRuns: [{ runId: exec, state: 'EXECUTING' }],
});

const setup = async () => {
  const app = await mountApp({
    control: (call) => {
      const runId = call.payload['runId'];
      if (call.operation === 'home.summary') {
        return { ok: true, value: { goals: [{ runId: 'goal_a', state: 'EXECUTING', objective: 'Goal A' }, { runId: 'goal_b', state: 'EXECUTING', objective: 'Goal B' }] } };
      }
      if (call.operation === 'decisions.pending') {
        return { ok: true, value: { pending: [{ runId: 'exec_b', runState: 'WAITING_APPROVAL', approvals: [approval('exec_b', 'B 要写文件')] }] } };
      }
      if (call.operation === 'goal.workspace') return { ok: true, value: runId === 'goal_b' ? workspaceOf('goal_b', 'exec_b') : workspaceOf('goal_a', 'exec_a') };
      if (call.operation === 'run.timeline') return { ok: true, value: { entries: [] } };
      if (call.operation === 'run.artifacts') return { ok: true, value: { artifacts: [] } };
      return undefined;
    },
  });
  return app;
};

describe('AUDIT R9 — approvals scoped to the open Goal', () => {
  it("Goal A does not show Goal B's approval card; B's approval is listed as another Goal's", async () => {
    const app = await setup();
    await app.click('Goal A');
    await waitFor(() => app.view.textContent.includes('其他目标待批准'));
    expect(app.view.textContent).toContain('其他目标待批准 · 1 项');
    expect(app.view.textContent).not.toContain('拒绝'); // no approval card (批准 / 拒绝) on Goal A
    expect(app.view.textContent).not.toContain('需要批准 · B');
  });

  it("opening Goal B shows its own approval card", async () => {
    const app = await setup();
    await app.click('Goal B');
    await waitFor(() => app.view.textContent.includes('拒绝'));
    expect(app.view.textContent).toContain('B 要写文件');
    expect(app.view.textContent).not.toContain('其他目标待批准');
  });
});
