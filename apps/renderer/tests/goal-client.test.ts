/**
 * DESKTOP STAGE 1 — CLIENT-01..CLIENT-12 acceptance tests (renderer slice).
 *
 * Strategy: the PURE VIEW components are rendered with react-dom/server
 * renderToString — structural assertions over what the UI shows for a given
 * canonical projection. The pure loaders are called directly to prove every read
 * crosses the ONE canonical control-plane seam (CLIENT-04/12). Written with
 * createElement (no JSX) so the canonical root vitest glob runs it unchanged.
 *
 * Coverage map:
 *   CLIENT-02/03  workspace gating + GoalEntry canonical submission controls
 *   CLIENT-05     GoalList renders home.summary durable data newest-first (loader verified)
 *   CLIENT-06     Goal detail reflects run state + task progress
 *   CLIENT-07     Outcome: deliverable artifact list + validation on COMPLETED
 *   CLIENT-08     Failed goal stays FAILED with its canonical failureReason visible
 *   CLIENT-10     no secret shape, no fake percentage, no failure-to-success softening
 *   CLIENT-11     covered by the sibling no-node-builtins suite (import hygiene)
 *   CLIENT-12     views render exclusively from canonical projections
 */
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  BlockerList,
  ControlPlaneErrorView,
  GoalEntry,
  GoalListView,
  GoalWorkspaceView,
  ValidationSummaryViewBlock,
  WorkspaceSelector,
  loadGoalWorkspace,
  loadHomeSummary,
  loadRunArtifacts,
  sortGoalsNewestFirst,
} from '../src/workspace.js';

const COMPLETED_OVERVIEW = {
  runId: 'run_exec_1',
  state: 'COMPLETED',
  failureReason: null,
  taskSummary: { total: 3, done: 3 },
  attempts: { active: 0, interrupted: 0, completed: 3, failed: 0 },
  validation: {
    requiredValidatorIds: ['oracle'],
    completed: [{ validatorId: 'oracle', status: 'pass' }],
    failed: false,
    missing: [],
  },
  progress: { tasksTotal: 3, tasksDone: 3, stagesTotal: 2, stagesTerminalSuccessful: 2 },
  artifacts: [{ id: 'art_1', kind: 'companyos:executor-output' }],
  handoffCount: 1,
};

const FAILED_OVERVIEW = {
  runId: 'run_exec_1',
  state: 'FAILED',
  failureReason: 'terminal execution failure: the execution run reached the engine terminal FAILED state',
  taskSummary: { total: 3, done: 1 },
  attempts: { active: 0, interrupted: 0, completed: 0, failed: 3 },
  validation: { requiredValidatorIds: ['oracle'], completed: [], failed: true, missing: ['oracle'] },
  progress: { tasksTotal: 3, tasksDone: 1, stagesTotal: 2, stagesTerminalSuccessful: 0 },
  artifacts: [],
  handoffCount: 0,
};

const GOALS = [
  { runId: 'run_b', state: 'COMPLETED', objective: 'older completed', createdAt: '2026-10-04T01:00:00.000Z' },
  { runId: 'run_a', state: 'FAILED', objective: 'newer failed', createdAt: '2026-10-04T02:00:00.000Z' },
];

const WORKSPACE_VIEW = (overview: unknown) => ({
  runId: 'run_goal_1',
  goal: { objective: '把这份调研变成一份数据报告。' },
  planningRun: { state: 'COMPLETED', revision: 4 },
  overview,
  blockers: [],
  executionRuns: [{ runId: 'run_exec_1', state: 'COMPLETED' }],
});
const WORKSPACE_VIEW_PLACEHOLDER = WORKSPACE_VIEW(COMPLETED_OVERVIEW);

const makeControlPlane = (responses: Record<string, unknown>) => {
  const calls: { operation: string; payload: unknown }[] = [];
  return {
    calls,
    bridge: {
      controlPlaneRequest: async (request: { operation: string; payload?: unknown }) => {
        calls.push({ operation: request.operation, payload: request.payload });
        return { ok: true, value: responses[request.operation] };
      },
    },
  };
};

describe('CLIENT-05 — recent Goal list: durable home.summary projection, newest-first', () => {
  it('sorts the canonical projection newest-first and renders every goal with its state', () => {
    const sorted = sortGoalsNewestFirst(GOALS);
    expect(sorted[0]?.runId).toBe('run_a');
    const html = renderToString(h(GoalListView, { goals: sorted, failure: null, onOpen: () => undefined }));
    expect(html.indexOf('newer failed')).toBeLessThan(html.indexOf('older completed'));
    expect(html).toContain('FAILED');
    expect(html).toContain('COMPLETED');
    expect(html).toContain('run_a'); // short stable identifier rendered (first 14 chars)
  });

  it('CLIENT-05b — loadHomeSummary reads through the ONE canonical control-plane seam', async () => {
    const { bridge, calls } = makeControlPlane({ 'home.summary': { goals: GOALS } });
    const envelope = await loadHomeSummary(bridge, 'company_default');
    expect(envelope.ok).toBe(true);
    expect(calls).toEqual([{ operation: 'home.summary', payload: { companyId: 'company_default' } }]);
    if (envelope.ok) expect(envelope.value?.goals.length).toBe(2);
  });
});

describe('CLIENT-06/07 — Goal detail reflects canonical run status + Outcome', () => {
  it('COMPLETED: task progress, validation rows, deliverable artifacts, handoff count', () => {
    const html = renderToString(
      h(GoalWorkspaceView, {
        goalObjective: '把这份调研变成一份数据报告。',
        planningRunState: 'COMPLETED',
        planningRunId: 'run_goal_1',
        overview: COMPLETED_OVERVIEW,
        blockers: [],
        executionRuns: [{ runId: 'run_exec_1', state: 'COMPLETED' }],
        deliverableArtifacts: [
          { artifactId: 'art_1', kind: 'companyos:executor-output' },
          { artifactId: 'art_2', kind: 'companyos:run-goal' },
        ],
      }),
    );
    expect(html).toContain('COMPLETED');
    expect(html).toMatch(/3\/3/); // canonical done/total — never a percentage
    expect(html).toContain('oracle'); // validation summary rows
    expect(html).toContain('companyos:executor-output'); // deliverable artifact refs
    expect(html).toContain('art_2');
    expect(html).toContain('移交记录：'); // React SSR comment node separates text/value
    expect(html).toContain('>1</p>');
  });

  it('CLIENT-08 — FAILED stays FAILED with its canonical failureReason and failed validation', () => {
    const html = renderToString(
      h(GoalWorkspaceView, {
        goalObjective: '把这份调研变成一份数据报告。',
        planningRunState: 'COMPLETED',
        planningRunId: 'run_goal_1',
        overview: FAILED_OVERVIEW,
        blockers: [],
        executionRuns: [{ runId: 'run_exec_1', state: 'FAILED' }],
        deliverableArtifacts: [],
      }),
    );
    expect(html).toContain('FAILED');
    expect(html).toContain('terminal execution failure');
    expect(html).toContain('oracle'); // the missing validator stays surfaced
    expect(html).toContain('该目标已失败'); // explicit failure banner — never softened
    expect(html).not.toContain('已完成'); // no completed badge on a failed goal
  });

  it('CLIENT-06b — a failed validation is visible even when the run itself has not failed', () => {
    const html = renderToString(
      h(
        'div',
        null,
        h(ControlPlaneErrorView, { failure: null }),
        h(ValidationSummaryViewBlock, {
          validation: { requiredValidatorIds: ['oracle'], completed: [], failed: true, missing: ['oracle'] },
        }),
      ),
    );
    expect(html).toContain('missing');
    expect(html).toContain('oracle');
  });
});

describe('CLIENT-02/03 — workspace selection gates canonical Goal submission', () => {
  it('GoalEntry is disabled with the explicit reason until a workspace is opened', () => {
    const { bridge } = makeControlPlane({});
    const html = renderToString(h(GoalEntry, { bridge, workspaceReady: false, onGoalCreated: () => undefined }));
    expect(html).toContain('先选择工作空间');
    expect(html).toContain('disabled');
  });

  it('an opened workspace enables the canonical submission control (goal.create path)', () => {
    const { bridge } = makeControlPlane({ 'goal.create': { runId: 'run_new_1' } });
    const html = renderToString(h(GoalEntry, { bridge, workspaceReady: true, onGoalCreated: () => undefined }));
    expect(html).not.toContain('先选择工作空间');
    expect(html).toContain('开始目标'); // the control renders ready (text-empty disable is independent)
  });

  it('CLIENT-02 — WorkspaceSelector renders the selection surface (native chooser behind IPC)', () => {
    const selection = {
      workspaceSelect: async () => null,
      workspaceOpen: async (root: string) => ({ ok: true, root }),
      workspaceCurrent: async () => null,
      workspaceSwitch: async (root: string) => ({ ok: true, root }),
    };
    const html = renderToString(h(WorkspaceSelector, { selection, onWorkspaceOpened: () => undefined }));
    expect(html).toContain('工作空间');
    expect(html).toContain('选择工作空间目录');
  });
});

describe('CLIENT-04/11/12 — the renderer owns no truth and reaches no forbidden surface', () => {
  it('loaders cross the canonical seam exactly once each — no other reads exist', async () => {
    const { bridge, calls } = makeControlPlane({
      'goal.workspace': WORKSPACE_VIEW_PLACEHOLDER,
      'run.artifacts': { artifacts: [] },
    });
    await loadGoalWorkspace(bridge, 'company_default', 'run_goal_1');
    await loadRunArtifacts(bridge, 'company_default', 'run_goal_1');
    const operations = calls.map((call) => call.operation);
    expect(operations).toContain('goal.workspace');
    expect(operations).toContain('run.artifacts');
    expect(operations.length).toBe(2);
  });

  it('blockers render truthfully in durable order — none hidden', () => {
    const html = renderToString(
      h(BlockerList, {
        blockers: [
          { code: 'BB1', message: 'older unresolved' },
          { code: 'BB2', message: 'newer' },
        ],
      }),
    );
    expect(html.indexOf('older unresolved')).toBeLessThan(html.indexOf('newer'));
  });
});

describe('CLIENT-10 — no fake progress, no secret surface, no softening', () => {
  it('renders canonical counts, never invented percentages or time estimates', () => {
    const html = renderToString(
      h(GoalWorkspaceView, {
        goalObjective: '把这份调研变成一份数据报告。',
        planningRunState: 'COMPLETED',
        planningRunId: 'run_goal_1',
        overview: COMPLETED_OVERVIEW,
        blockers: [],
        executionRuns: [{ runId: 'run_exec_1', state: 'COMPLETED' }],
        deliverableArtifacts: [],
      }),
    );
    expect(html).toMatch(/3\/3/); // canonical done/total
    expect(html).not.toMatch(/\d+%/); // NO percentage anywhere
    expect(html).not.toMatch(/剩余|remaining|ETA/i);
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{10,}/); // no credential shape
  });
});
