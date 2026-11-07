/**
 * LIVE-CONTRACT-FILL run 5 (hark-live-goal 42367067423) — the Goal stopped on
 * GOAL_USAGE_UNKNOWN (EXTERNAL_PRECONDITION_BLOCKED) while its run rows stayed EXECUTING:
 *  - the header read 执行中 -> a goal-scoped standing blocker makes the phase 已阻塞;
 *  - step 1 read 待开始 (its task was READY between attempts) -> 已阻塞;
 *  - 「已用 tokens」 read 4,438 (planner/supervisor rows only) while the ledger had settled
 *    478 108 tokens -> cumulative over every admitted model call of the Goal.
 */
import { describe, expect, it } from 'vitest';

import { blockerText } from '../src/failure-labels.js';
import { projectPlanSteps } from '../src/plan-steps.js';
import { PHASE_LABELS, projectRuntimeLifecycle, type CanonicalGoalWorkspace } from '../src/runtime-panel.js';
import { goalUsedTokens } from '../src/telemetry.js';

const workspace = (blockers: CanonicalGoalWorkspace['blockers']): CanonicalGoalWorkspace => ({
  runId: 'run_goal',
  goal: { objective: '合同自动填写' },
  planningRun: { state: 'EXECUTING', revision: 3 },
  overview: { state: 'EXECUTING', validation: { completed: [], failed: false, missing: [] } } as unknown as CanonicalGoalWorkspace['overview'],
  blockers,
  executionRuns: [{ runId: 'run_exec', state: 'EXECUTING' }],
});

const USAGE_UNKNOWN = { code: 'GOAL_USAGE_UNKNOWN', scope: 'RUN', subjectId: 'run_goal', explanation: 'standing admission refusal' };

describe('run 5: a blocked Goal reads 已阻塞 with its reason', () => {
  it('a standing goal blocker turns the phase to blocked, labelled 已阻塞 (not 执行中)', () => {
    const lifecycle = projectRuntimeLifecycle(workspace([USAGE_UNKNOWN]));
    expect(lifecycle.phase).toBe('blocked');
    expect(PHASE_LABELS[lifecycle.phase]).toBe('已阻塞');
    expect(projectRuntimeLifecycle(workspace([])).phase).toBe('executing');
  });

  it('the blocker strip names the reason in Chinese', () => {
    expect(blockerText(USAGE_UNKNOWN, null)).toBe('已阻塞 · 一次模型调用的用量未知，核对后才能继续');
    expect(blockerText({ code: 'GOAL_BUDGET_EXHAUSTED' }, null)).toBe('已阻塞 · 本目标的预算已用完');
  });

  it('the step the work stopped at reads 已阻塞; later steps stay 待开始; done steps stay 已完成', () => {
    const steps = projectPlanSteps({
      items: [
        { planItemId: 'scaffold', objective: '搭建项目', taskKind: null, stageId: 's0' },
        { planItemId: 'docx', objective: '导入模板', taskKind: null, stageId: 's1' },
        { planItemId: 'fill', objective: '自动填写', taskKind: null, stageId: 's2' },
      ],
      execution: {
        runId: 'run_exec',
        stages: [
          { stageId: 's0', taskCounts: { DONE: 1 }, terminalSuccessful: true },
          { stageId: 's1', taskCounts: { READY: 1 }, terminalSuccessful: false },
          { stageId: 's2', taskCounts: { PENDING: 1 }, terminalSuccessful: false },
        ],
        executing: [],
      },
      phase: 'blocked',
      outcome: null,
    });
    expect(steps.map((step) => step.label)).toEqual(['已完成', '已阻塞', '待开始']);
  });

  it('a live, unblocked Goal keeps its ordinary step words', () => {
    const steps = projectPlanSteps({
      items: [{ planItemId: 'docx', objective: '导入模板', taskKind: null, stageId: 's1' }],
      execution: { runId: 'run_exec', stages: [{ stageId: 's1', taskCounts: { READY: 1 }, terminalSuccessful: false }], executing: [] },
      phase: 'executing',
      outcome: null,
    });
    expect(steps[0]!.label).toBe('待开始');
  });
});

describe('run 5: 已用 tokens is cumulative over every model call of the Goal', () => {
  it('the budget ledger settled tokens win over the planner/supervisor-only usage rows', () => {
    expect(goalUsedTokens({ state: 'ACTIVE', settled: { tokens: 478_108 } }, 4_000, 438)).toBe(478_108);
  });
  it('without a budget envelope the KNOWN usage sum stays the source; unknown stays null', () => {
    expect(goalUsedTokens(null, 4_000, 438)).toBe(4_438);
    expect(goalUsedTokens({ state: 'NO_BUDGET', settled: { tokens: 0 } }, 10, 5)).toBe(15);
    expect(goalUsedTokens(undefined, null, null)).toBeNull();
  });
});
