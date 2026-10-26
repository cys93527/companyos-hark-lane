import { describe, expect, it } from 'vitest';

import { ok } from '@companyos/core';

import { createGoalOutcomeAutonomyDriver } from '../../apps/desktop/src/autonomy/goal-outcome-autonomy-driver.js';

/*
 * H15c (hark-live-goal 40266877047): one kernel exchange settled UNKNOWN; the driver then
 * advanced 19 more times, every supervisor turn refused at admission (GOAL_USAGE_UNKNOWN),
 * until the stall detector fired AUTONOMY_STALLED. A standing admission refusal must stop
 * the Goal at once as an operator-actionable EXTERNAL_PRECONDITION_BLOCKED, without advancing.
 */
const state = (n: number) => ok({
  goalRunId: 'run_h15c', goalRunState: 'EXECUTING', executionRuns: [{ runId: 'run_h15c', state: 'EXECUTING' }],
  tasks: [], totalAttempts: 0, failedAttempts: 0, correctiveCycles: 0, pendingApproval: null,
  decisionCount: 0, eventCount: n, fingerprint: `fp-${String(n)}`,
});

const harness = (refusals: readonly (string | null)[]) => {
  let advances = 0;
  let reads = 0;
  let checks = 0;
  const driver = createGoalOutcomeAutonomyDriver({
    advanceGoal: async () => { advances += 1; return ok(undefined); },
    loadGoalState: async () => state(reads++) as never,
    preflightChecks: async () => [],
    projectOutcome: async () => ({}) as never,
    standingAdmissionRefusal: async () => refusals[Math.min(checks++, refusals.length - 1)] ?? null,
    budgets: { maxAutonomySteps: 10 },
  });
  return { driver, counts: () => ({ advances, checks }) };
};

describe('H15c standing admission refusal ends the Goal as an external block', () => {
  it('GOAL_USAGE_UNKNOWN after two good steps: no further advance, typed block with the reason', async () => {
    const h = harness([null, null, 'GOAL_USAGE_UNKNOWN']);
    const result = await h.driver.run({ companyId: 'c', runId: 'run_h15c' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.terminal).toBe('EXTERNAL_PRECONDITION_BLOCKED');
    expect(result.value.terminalReason).toBe('GOAL_USAGE_UNKNOWN');
    expect(result.value.externalBlockCount).toBe(1);
    expect(h.counts().advances).toBe(2);
  });
  it('GOAL_DEADLINE_EXCEEDED blocks before the first advance', async () => {
    const h = harness(['GOAL_DEADLINE_EXCEEDED']);
    const result = await h.driver.run({ companyId: 'c', runId: 'run_h15c' });
    expect(result.ok && result.value.terminal).toBe('EXTERNAL_PRECONDITION_BLOCKED');
    expect(h.counts().advances).toBe(0);
  });
  it('a non-standing reason (cancellation has its own path) never short-circuits the loop', async () => {
    const h = harness(['GOAL_CANCEL_REQUESTED']);
    const result = await h.driver.run({ companyId: 'c', runId: 'run_h15c' });
    expect(result.ok && result.value.terminal).toBe('AUTONOMY_BUDGET_EXHAUSTED');
    expect(h.counts().advances).toBe(10);
  });
});
