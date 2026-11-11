/**
 * LIVE-CONTRACT-FILL run 4 (hark-live-goal 42346111946): "目标 · FAILED · 规划 · FAILED" and
 * "失败 阶段 0/5 完成" although planning had produced its plan (DONE) and only EXECUTION failed.
 */
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { planningPhaseStateOf, projectRuntimeLifecycle, RuntimePanelView } from '../src/runtime-panel.js';

const GOAL = 'run_01M6TB5T7B9MXV78FGTGG8K61Y';
const EXEC = 'run_5d4b94ef44e84fa2eef0baf1b3';

describe('phase status: planning DONE, execution FAILED', () => {
  const workspace = {
    runId: GOAL, goal: { objective: '开发一个跨平台的合同自动填写软件' }, planningRun: { state: 'FAILED', revision: 7 },
    overview: { runId: GOAL, state: 'FAILED', failureReason: 'execution_failed', executing: [], validation: { completed: [], failed: false, missing: [] } }, blockers: [],
    executionRuns: [{ runId: EXEC, state: 'FAILED' }],
  };
  it('a compiled execution run proves planning completed; no execution run keeps the planning run state', () => {
    expect(planningPhaseStateOf(workspace as never)).toBe('DONE');
    expect(planningPhaseStateOf({ ...workspace, executionRuns: [] } as never)).toBe('FAILED');
    expect(planningPhaseStateOf({ planningRun: { state: 'PLANNING', revision: 1 }, executionRuns: [] } as never)).toBe('PLANNING');
    const lifecycle = projectRuntimeLifecycle(workspace as never, []);
    expect(lifecycle.planningState).toBe('DONE');
    expect(lifecycle.executionState).toBe('FAILED');
  });
  it('the panel shows 规划 · DONE and puts the failure on the execution phase', () => {
    const html = renderToString(h(RuntimePanelView, {
      open: true, expanded: true, tab: 'run', lifecycle: projectRuntimeLifecycle(workspace as never, []), artifacts: [], timeline: [], taskDetail: null,
      blockers: [], pendingApproval: null, onToggleExpanded: () => {}, onSelectTab: () => {}, onSelectTask: () => {},
      stageProgress: { done: 0, total: 5 },
    } as never));
    // UI-AUDIT-3: the per-run state words are the phase tooltip.
    expect(html).toContain('title="目标 失败 · 规划 已完成 · 执行 失败');
    expect(html).not.toContain('规划 失败');
    expect(html).toContain('执行 · 阶段 0/5 完成');
  });
});
