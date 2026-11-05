/**
 * LIVE-CONTRACT-FILL (hark-live-goal 42075419348) — three UI defects the boss saw on a real
 * failed goal, pinned:
 *  (a) "失败 阶段 0/4 终态成功" — a failed goal read as if stages had succeeded;
 *  (b) "RUN_FAILED · Run is FAILED (execution_failed)." — raw code + English, and the real
 *      cause (the model hit its per-response output limit) was nowhere;
 *  (c) "先选择公司模型…" with exactly one model configured.
 */
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BlockerList, GoalWorkspaceView } from '../src/workspace.js';
import { RuntimePanelView } from '../src/runtime-panel.js';
import { ChatView, projectConversation } from '../src/chat.js';
import {
  attemptFailureLabel, blockerLabel, blockerText, BLOCKER_LABELS, failureDetailLabel, runFailureReasonLabel,
  type CanonicalAttemptFailure,
} from '../src/failure-labels.js';
import { soleModelOption, type ModelOptionRow } from '../src/models.js';

const CEILING: CanonicalAttemptFailure = {
  runId: 'run_exec', taskId: 'tsk_1', attemptId: 'exa_3', failureCode: 'PROVIDER_FAILED',
  detailCode: 'EXECUTOR_KERNEL_OUTPUT_CEILING', settledAt: '2026-11-06T01:36:00+08:00',
};
const RUN_FAILED = { code: 'RUN_FAILED', scope: 'RUN', explanation: 'Run is FAILED (execution_failed).' };

const panel = (extra: Record<string, unknown>) => renderToString(h(RuntimePanelView, {
  open: true, expanded: true, tab: 'run', lifecycle: null, artifacts: [], timeline: [], taskDetail: null,
  blockers: [RUN_FAILED], pendingApproval: null, onToggleExpanded: () => {}, onSelectTab: () => {}, onSelectTask: () => {},
  ...extra,
} as never));

describe('UI defect (a): stage progress wording', () => {
  it('a failed goal shows "阶段 0/4 完成", never "终态成功"', () => {
    const html = panel({
      lifecycle: { runId: 'run_goal', phase: 'failed', runState: 'FAILED', objective: 'x', planningState: 'FAILED', tasks: [], validation: { completed: 0, failed: 0, missing: 0 }, correctiveRounds: 0, handoffCount: 0, outcomeDelivered: false, failureReason: 'execution_failed' },
      stageProgress: { done: 0, total: 4 },
    });
    expect(html).toContain('阶段 0/4 完成');
    expect(html).not.toContain('终态成功');
  });
  it('the goal workspace task progress says 完成', () => {
    const html = renderToString(h(GoalWorkspaceView, {
      goalObjective: 'x', planningRunState: 'FAILED', planningRunId: 'run_goal', blockers: [RUN_FAILED], executionRuns: [], deliverableArtifacts: [],
      overview: { runId: 'run_goal', state: 'FAILED', failureReason: 'execution_failed', progress: { stagesTotal: 4, stagesTerminalSuccessful: 0, tasksTotal: 4, tasksDone: 0 } },
      attemptFailure: CEILING,
    }));
    expect(html).toContain('阶段 0/4 完成');
    expect(html).not.toContain('终态成功');
    expect(html).toContain('模型单次回复达到输出上限');
  });
});

describe('UI defect (b): Chinese blocker labels + the real typed failure reason', () => {
  it('every canonical engine blocker code has a Chinese label', () => {
    for (const code of ['RUN_PAUSED', 'RUN_FAILED', 'RUN_CANCELLED', 'RUN_TIMED_OUT', 'APPROVAL_REQUIRED', 'UNRESOLVED_FINDING', 'VALIDATION_FAILED',
      'VALIDATION_REQUIREMENTS_MISSING', 'ROUND_LIMIT_EXHAUSTED', 'EXECUTION_FAILURE', 'CAUSAL_CORRECTIVE_WAIT', 'UNRECONCILED_CARRIER']) {
      expect(BLOCKER_LABELS[code], code).toMatch(/[\u4e00-\u9fff]/u);
    }
    expect(blockerLabel('SOMETHING_NEW')).toBe('阻塞（SOMETHING_NEW）');
  });
  it('a failed run names the typed provider reason, falling back to the run failure reason', () => {
    expect(blockerText(RUN_FAILED, CEILING, 'execution_failed')).toBe('运行失败 · 模型单次回复达到输出上限（一次写入的文件或回复过大）');
    expect(blockerText(RUN_FAILED, { ...CEILING, detailCode: null }, 'execution_failed')).toBe('运行失败 · 执行器（智能体内核）运行失败');
    expect(blockerText(RUN_FAILED, null, 'execution_failed')).toBe('运行失败 · 执行失败');
    expect(blockerText({ code: 'RUN_PAUSED' }, CEILING)).toBe('运行已暂停');
    expect(failureDetailLabel('EXECUTOR_KERNEL_TURN_ERROR')).toBe('智能体内核异常结束（error）');
    expect(failureDetailLabel('X_NEW')).toBe('未归类的失败原因（X_NEW）');
    expect(runFailureReasonLabel('route_failed')).toBe('没有可用的执行路线');
    expect(attemptFailureLabel(null)).toBeNull();
  });
  it('the runtime blocker strip shows Chinese text; code + English evidence only in the tooltip', () => {
    const html = panel({ attemptFailure: CEILING });
    expect(html).toContain('运行失败 · 模型单次回复达到输出上限');
    expect(html).not.toMatch(/>RUN_FAILED ·/u);
    expect(html).not.toMatch(/>[^<]*Run is FAILED/u);
  });
  it('the goal workspace blocker list uses the same labels (and no longer drops the explanation)', () => {
    const html = renderToString(h(BlockerList, { blockers: [RUN_FAILED], attemptFailure: CEILING, failureReason: 'execution_failed' }));
    expect(html).toContain('运行失败 · 模型单次回复达到输出上限');
    expect(html).toContain('Run is FAILED (execution_failed).'); // evidence kept in the tooltip
  });
  it('the conversation failure row names the real cause in Chinese', () => {
    const workspace = {
      runId: 'run_goal', goal: { objective: 'x' }, planningRun: { state: 'FAILED', revision: 5 },
      overview: { runId: 'run_goal', state: 'FAILED', revision: 5, reworkCount: 0, maxRework: 1, failureReason: 'execution_failed', terminalOutcome: 'FAILED', resumePoint: null, pinnedVersion: null, stages: [], executing: [], attempts: { active: 0, interrupted: 0, completed: 0, failed: 3 }, validation: { requiredValidatorIds: [], completed: [], failed: false, missing: [] }, correctiveActivity: null, handoffCount: 0, progress: { stagesTotal: 4, stagesTerminalSuccessful: 0, tasksTotal: 4, tasksDone: 0, tasksActive: 0, tasksBlocked: 0 }, artifacts: [] },
      blockers: [RUN_FAILED], executionRuns: [{ runId: 'run_exec', state: 'FAILED' }], attemptFailure: CEILING,
    };
    const entries = projectConversation(workspace as never, 'x', []);
    const html = renderToString(h(ChatView, { objective: 'x', entries, loading: false, failure: null }));
    expect(html).toContain('目标失败 · 模型单次回复达到输出上限');
    expect(html).not.toContain('execution_failed');
  });
});

describe('UI defect (c): a single configured model is selected automatically', () => {
  const row = (key: string): ModelOptionRow => ({ providerId: 'deepseek', providerModelId: key, displayName: key, contextWindow: null, registered: true, modelKey: key, priceInput: null, priceOutput: null });
  it('exactly one option and no company selection -> that option', () => {
    expect(soleModelOption([row('deepseek-v4-flash')], { kind: 'no-selection' })?.modelKey).toBe('deepseek-v4-flash');
  });
  it('several options keep the explicit choice; an existing selection is never replaced', () => {
    expect(soleModelOption([row('a'), row('b')], { kind: 'no-selection' })).toBeNull();
    expect(soleModelOption([row('a')], { kind: 'selected', modelKey: 'a', displayName: 'a' })).toBeNull();
    expect(soleModelOption([], { kind: 'provider-not-configured' })).toBeNull();
  });
  it('App wires the sole-option selection through the canonical chooseModel path, once', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/soleModelOption\(modelOptions, modelStatus\)/u);
    expect(source).toMatch(/soleModelTried\.current = true;\s*void chooseModel\(sole\);/u);
  });
});
