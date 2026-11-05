/**
 * AUDIT R8 — Goal-scoped state (artifact preview/failure, budget, usage, approval failure)
 * never survives a Goal switch, and a late artifact response for Goal A never lands on B.
 */
import './support/mini-dom.js';

import { afterEach, describe, expect, it } from 'vitest';

import { mountApp, unmountApp, waitFor } from './support/audit-app-harness.js';

afterEach(() => unmountApp());

const bucket = (calls: number, tokens: number, costMicros: number) => ({ calls, tokens, costMicros });
const budgetOf = (goalRunId: string) => ({
  budget: {
    state: 'ACTIVE', goalRunId, currency: 'CNY',
    cap: { ...bucket(6, 200000, 1_000_000), deadlineMs: 1 },
    settled: bucket(1, 1769, 5740), unknown: bucket(0, 0, 0), held: bucket(0, 0, 0),
    remaining: bucket(5, 198231, 994260), worstCaseCostMicros: 5740, notes: [],
  },
  plan: null,
});

const workspaceOf = (runId: string, objective: string) => ({
  runId,
  goal: { objective },
  planningRun: { state: 'COMPLETED', revision: 1 },
  overview: {
    runId, state: 'EXECUTING', revision: 1, reworkCount: 0, maxRework: 3, failureReason: null, resumePoint: null,
    pinnedVersion: null, stages: [], executing: [],
    attempts: { active: 0, interrupted: 0, completed: 0, failed: 0 },
    validation: { requiredValidatorIds: [], completed: [], failed: false, missing: [] },
    correctiveActivity: null, handoffCount: 0,
    progress: { stagesTotal: 0, stagesTerminalSuccessful: 0, tasksTotal: 0, tasksDone: 0, tasksActive: 0, tasksBlocked: 0 },
    artifacts: [{ id: 'art_a', kind: 'text', taskId: null }],
  },
  blockers: [],
  executionRuns: [],
});

const never = new Promise<unknown>(() => undefined);

const setup = async (artifactAction: (request: { operation: string; artifactId: string }) => Promise<unknown>) => {
  const app = await mountApp({
    artifactAction,
    control: (call) => {
      const runId = call.payload['runId'];
      if (call.operation === 'home.summary') {
        return {
          ok: true,
          value: {
            goals: [
              { runId: 'run_goal_a', state: 'EXECUTING', objective: 'Goal A' },
              { runId: 'run_goal_b', state: 'EXECUTING', objective: 'Goal B' },
            ],
          },
        };
      }
      if (runId === 'run_goal_b' && call.operation !== 'decisions.pending') return never;
      if (call.operation === 'goal.workspace') return { ok: true, value: workspaceOf('run_goal_a', 'Goal A') };
      if (call.operation === 'run.timeline') return { ok: true, value: { entries: [] } };
      if (call.operation === 'run.artifacts') return { ok: true, value: { artifacts: [{ artifactId: 'art_a', kind: 'text' }] } };
      if (call.operation === 'run.budget') return { ok: true, value: budgetOf('run_goal_a') };
      return undefined;
    },
  });
  await app.click('Goal A');
  // UI-PAPER-INK: the runtime view is open by default (收起 / 展开 still toggles it).
  if (app.button('展开') !== null) await app.click('展开');
  return app;
};

describe('AUDIT R8 — Goal-scoped state on Goal switch', () => {
  it("Goal A's preview and spend rows are gone once Goal B is opened", async () => {
    const app = await setup(async () => ({ ok: true, value: { text: 'A-PREVIEW-TEXT', truncated: false, kind: 'text' } }));
    expect(app.view.textContent).toContain('已结算');
    await app.click('文件');
    await app.click('预览');
    expect(app.view.textContent).toContain('A-PREVIEW-TEXT');
    await app.click('Goal B');
    await app.click('文件');
    expect(app.view.textContent).not.toContain('A-PREVIEW-TEXT');
    await app.click('运行');
    expect(app.view.textContent).not.toContain('已结算');
  });

  it("a late Goal-A preview response does not land on Goal B", async () => {
    let release: (value: unknown) => void = () => undefined;
    const app = await setup(() => new Promise((resolve) => { release = resolve; }));
    await app.click('文件');
    await app.click('预览');
    await app.click('Goal B');
    await app.click('文件');
    release({ ok: true, value: { text: 'LATE-A-TEXT', truncated: false, kind: 'text' } });
    await waitFor(() => false, 5);
    expect(app.view.textContent).not.toContain('LATE-A-TEXT');
  });
});
