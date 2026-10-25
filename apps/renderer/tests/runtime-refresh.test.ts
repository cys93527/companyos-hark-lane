/**
 * DRA-05 — the current Goal's runtime read chain under the controlled refresh.
 *
 * Defect (DRA-01 evidence): the 4s refresh tick updated the goal list / recent /
 * approvals projections but NOT the open Goal's runtime projections — the effect
 * that loads `goal.workspace` / `run.timeline` / `run.artifacts` did not depend on
 * `refreshKey`, so the runtime panel only ever reflected the moment a Goal was
 * opened.
 *
 * The fixed contract pinned here behaves over a REAL React mount (real root, real
 * effects, real unmount; see ./support/mini-dom.ts — no new dependency), with fake
 * timers and DELAYED bridge responses (ordering is controlled by the test):
 *
 *   - a tick re-reads the OPEN Goal's projections and a durable state change
 *     reaches the runtime panel;
 *   - a late Goal-A response never lands on Goal B (per-read generation + Goal
 *     ownership; the discarded chain stops immediately);
 *   - repeated ticks never pile up: at most ONE read per Goal is in flight and a
 *     tick during a pending read is coalesced;
 *   - every request the renderer makes is a READ of the canonical control-plane
 *     surface (polling never mutates: no goal.create / advance / approval response);
 *   - a terminal Goal stops the polling;
 *   - unmounting stops everything and late responses land nowhere;
 *   - a task detail belongs to ONE Goal: switching Goals clears it and a late
 *     detail response is dropped.
 */
import './support/mini-dom.js';

import { createElement as h, StrictMode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App.js';
import { MAX_PENDING_RUNTIME_READS, RUNTIME_READ_TIMEOUT_MS } from '../src/runtime-read-budget.js';
import {
  clickableWithText,
  createContainer,
  dispatchMiniEvent,
  removeContainer,
  type MiniElement,
} from './support/mini-dom.js';

/* ------------------------------------------------------------- fake bridge --- */

interface CallRecord {
  readonly operation: string;
  readonly payload: Record<string, unknown>;
}
interface PendingCall {
  readonly operation: string;
  readonly payload: Record<string, unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

type GoalRow = { readonly runId: string; readonly state: string; readonly objective: string };

const makeHarness = () => {
  const calls: CallRecord[] = [];
  const pending: PendingCall[] = [];
  let summary: readonly GoalRow[] = [];

  const bridge = {
    appVersion: async () => '0.0.0-dra05',
    platformInfo: async () => ({ platform: 'win32', arch: 'x64', electron: '0.0.0', node: '0.0.0', chrome: '0.0.0' }),
    databaseStatus: async () => ({ path: 'C:/tmp/db.sqlite', journalMode: 'wal', schemaVersion: 1 }),
    channels: () => ['goal.workspace'],
    workflowRequest: async (request: { readonly operation: string }) =>
      request.operation === 'models.selection' ? { ok: true, value: {} } : { ok: true, value: [] },
    workspaceSelect: async () => null,
    workspaceOpen: async (root: string) => ({ ok: true, root }),
    workspaceCurrent: async () => '/test-workspace',
    workspaceSwitch: async (root: string) => ({ ok: true, root }),
    artifactAction: async () => ({ ok: true, value: null }),
    controlPlaneRequest: (request: { readonly operation: string; readonly payload?: unknown }) =>
      new Promise((resolve, reject) => {
        const payload = (request.payload ?? {}) as Record<string, unknown>;
        calls.push({ operation: request.operation, payload });
        if (request.operation === 'home.summary') {
          resolve({ ok: true, value: { goals: summary } });
          return;
        }
        if (request.operation === 'decisions.pending') {
          resolve({ ok: true, value: { pending: [] } });
          return;
        }
        if (request.operation === 'run.usage' || request.operation === 'run.budget') {
          // H11: run.budget is a read-only projection like run.usage (null => renders nothing).
          resolve({ ok: true, value: null });
          return;
        }
        pending.push({ operation: request.operation, payload, resolve, reject });
      }),
  };

  return {
    bridge,
    calls,
    pending,
    setSummary: (goals: readonly GoalRow[]): void => {
      summary = goals;
    },
    callsOf: (operation: string): readonly CallRecord[] => calls.filter((call) => call.operation === operation),
  };
};
type Harness = ReturnType<typeof makeHarness>;

/* ------------------------------------------------------------ canonical data --- */

const workspaceOf = (
  runId: string,
  state: string,
  options: {
    readonly objective?: string;
    readonly tasks?: readonly { readonly taskId: string; readonly stageId: string; readonly kind: string }[];
    readonly artifactIds?: readonly string[];
  } = {},
) => ({
  runId,
  goal: { objective: options.objective ?? '(未命名目标)' },
  planningRun: { state: 'COMPLETED', revision: 1 },
  overview: {
    runId,
    state,
    revision: 1,
    reworkCount: 0,
    maxRework: 3,
    failureReason: null,
    resumePoint: null,
    pinnedVersion: null,
    stages: [],
    executing: (options.tasks ?? []).map((task) => ({ ...task, attempt: null })),
    attempts: { active: 0, interrupted: 0, completed: 0, failed: 0 },
    validation: { requiredValidatorIds: [], completed: [], failed: false, missing: [] },
    correctiveActivity: null,
    handoffCount: 0,
    progress: { stagesTotal: 0, stagesTerminalSuccessful: 0, tasksTotal: 0, tasksDone: 0, tasksActive: 0, tasksBlocked: 0 },
    artifacts: (options.artifactIds ?? []).map((id) => ({ id, kind: 'text', taskId: null })),
  },
  blockers: [],
  executionRuns: [],
});

const taskObservationOf = (taskId: string, state: string) => ({
  taskId,
  stageId: 'stg_1',
  roleId: 'rol.worker',
  kind: 'work',
  state,
  attempts: 1,
  maxAttempts: 3,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:01.000Z',
  executionAttempts: [],
  provenance: [{ executionId: 'exe_1', status: 'COMPLETED', modelKey: 'model.fixture', providerId: 'model.openai-compatible' }],
  provider: { providerKey: 'dsh-headless', state: 'READY' },
  blockers: [],
});

/* ------------------------------------------------------------------ the mount --- */

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
};

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
};

let activeRoot: Root | null = null;
let activeContainer: MiniElement | null = null;

const mountApp = async (harness: Harness, strict = false): Promise<MiniElement> => {
  (globalThis as unknown as Record<string, unknown>)['companyos'] = harness.bridge;
  const container = createContainer();
  const root = createRoot(container as unknown as Element);
  activeRoot = root;
  activeContainer = container;
  await act(async () => {
    root.render(strict ? h(StrictMode, null, h(App)) : h(App));
  });
  await settle();
  return container;
};

const openGoal = async (container: MiniElement, objective: string): Promise<void> => {
  const button = clickableWithText(container, objective);
  expect(button, `no clickable goal row for "${objective}"`).not.toBeNull();
  await act(async () => {
    dispatchMiniEvent(button as MiniElement, 'click');
  });
  await settle();
};

const expandPanel = async (container: MiniElement): Promise<void> => {
  const button = clickableWithText(container, '展开');
  expect(button, 'no expand control on the runtime panel').not.toBeNull();
  await act(async () => {
    dispatchMiniEvent(button as MiniElement, 'click');
  });
  await settle();
};

/** Resolve the OLDEST pending call of `operation` (optionally narrowed by runId). */
const respond = async (harness: Harness, operation: string, value: unknown, runId?: string): Promise<void> => {
  const index = harness.pending.findIndex(
    (call) => call.operation === operation && (runId === undefined || call.payload['runId'] === runId),
  );
  expect(index, `no pending "${operation}"${runId === undefined ? '' : ` for ${runId}`}`).toBeGreaterThanOrEqual(0);
  const call = harness.pending.splice(index, 1)[0] as PendingCall;
  await act(async () => {
    call.resolve({ ok: true, value });
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
};

/** Resolve the full read chain (workspace → timeline → artifacts) for one response. */
const respondRuntimeChain = async (harness: Harness, runId: string, workspace: unknown): Promise<void> => {
  await respond(harness, 'goal.workspace', workspace, runId);
  await respond(harness, 'run.timeline', { entries: [] }, runId);
  await respond(harness, 'run.artifacts', { artifacts: [] }, runId);
};

const READ_OPERATIONS = [
  'home.summary',
  'decisions.pending',
  'goal.workspace',
  'run.timeline',
  'run.artifacts',
  'run.task',
  'run.usage',
  'run.budget',
];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  if (activeRoot !== null) {
    const root = activeRoot;
    act(() => {
      root.unmount();
    });
    activeRoot = null;
  }
  if (activeContainer !== null) {
    removeContainer(activeContainer);
    activeContainer = null;
  }
  delete (globalThis as unknown as Record<string, unknown>)['companyos'];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The polling cadence of the renderer (App + GoalList share GOAL_POLL_INTERVAL_MS). */
const TICK_MS = 4_000;

/* -------------------------------------------------------------------- tests --- */

describe('DRA-05 P1 — task ownership across Goal/Run selections (real React)', () => {
  const setup = async () => {
    const harness = makeHarness();
    harness.setSummary([
      { runId: 'run_A', state: 'EXECUTING', objective: '目标 A' },
      { runId: 'run_B', state: 'EXECUTING', objective: '目标 B' },
    ]);
    const container = await mountApp(harness);
    await openGoal(container, '目标 A');
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'EXECUTING', {
      tasks: [
        { taskId: 'tsk_A1', stageId: 'stg_1', kind: 'work' },
        { taskId: 'tsk_A2', stageId: 'stg_1', kind: 'work' },
      ],
    }));
    await expandPanel(container);
    return { harness, container };
  };
  const selectTask = async (container: MiniElement, taskId: string) => {
    const button = clickableWithText(container, taskId);
    expect(button).not.toBeNull();
    await act(async () => { dispatchMiniEvent(button as MiniElement, 'click'); });
    await settle();
  };

  it('rejects old A tasks clicked while B workspace is pending — original P1 reproduction', async () => {
    const { harness, container } = await setup();
    await openGoal(container, '目标 B');
    const oldTask = clickableWithText(container, 'tsk_A1');
    if (oldTask !== null) {
      await act(async () => { dispatchMiniEvent(oldTask, 'click'); });
      await settle();
    }
    await respondRuntimeChain(harness, 'run_B', workspaceOf('run_B', 'RECOVERING'));
    if (harness.pending.some((call) => call.operation === 'run.task')) {
      await respond(harness, 'run.task', taskObservationOf('tsk_A1', 'RUNNING'));
    }
    expect(container.textContent).not.toContain('tsk_A1');
    expect(harness.callsOf('run.task')).toHaveLength(0);
  });

  it('drops A detail after B loads, including A → B → A selection generations', async () => {
    const { harness, container } = await setup();
    await selectTask(container, 'tsk_A1');
    await openGoal(container, '目标 B');
    await respondRuntimeChain(harness, 'run_B', workspaceOf('run_B', 'RECOVERING'));
    await openGoal(container, '目标 A');
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'EXECUTING'));
    await respond(harness, 'run.task', taskObservationOf('tsk_A1', 'RUNNING'));
    expect(container.textContent).not.toContain('tsk_A1');
  });

  it('only commits the newest selected task when same-Goal details return out of order', async () => {
    const { harness, container } = await setup();
    await selectTask(container, 'tsk_A1');
    // The run tab remains available while the first detail is pending.
    await openGoal(container, '目标 A');
    const runTab = clickableWithText(container, '运行');
    expect(runTab).not.toBeNull();
    await act(async () => { dispatchMiniEvent(runTab as MiniElement, 'click'); });
    await settle();
    await selectTask(container, 'tsk_A2');
    const second = harness.pending.splice(harness.pending.findIndex((call) => call.payload['taskId'] === 'tsk_A2'), 1)[0]!;
    await act(async () => { second.resolve({ ok: true, value: taskObservationOf('tsk_A2', 'DONE') }); });
    await settle();
    await respond(harness, 'run.task', taskObservationOf('tsk_A1', 'RUNNING'));
    expect(container.textContent).toContain('tsk_A2');
    expect(container.textContent).not.toContain('tsk_A1');
  });

  it('rejects a mismatching task/stage response and clears detail on a rejected request', async () => {
    const { harness, container } = await setup();
    await selectTask(container, 'tsk_A1');
    await respond(harness, 'run.task', taskObservationOf('tsk_B1', 'RUNNING'));
    expect(container.textContent).not.toContain('tsk_B1');
    const runTab = clickableWithText(container, '运行');
    await act(async () => { dispatchMiniEvent(runTab as MiniElement, 'click'); });
    await settle();
    await selectTask(container, 'tsk_A1');
    const call = harness.pending.splice(harness.pending.findIndex((item) => item.operation === 'run.task'), 1)[0]!;
    await act(async () => { call.reject(new Error('fixture IPC failure')); });
    await settle();
    expect(container.textContent).toContain('选择运行页中的任务以查看 canonical 明细。');
  });

  it('does not commit a task detail after unmount', async () => {
    const { harness, container } = await setup();
    await selectTask(container, 'tsk_A1');
    await act(async () => { activeRoot!.unmount(); });
    activeRoot = null;
    const callsAtUnmount = harness.calls.length;
    await respond(harness, 'run.task', taskObservationOf('tsk_A1', 'RUNNING'));
    expect(container.textContent).toBe('');
    expect(harness.calls).toHaveLength(callsAtUnmount);
  });

  it('binds details to the execution Run as well as the distinct Goal identity', async () => {
    const { harness, container } = await setup();
    await advance(TICK_MS);
    const next = workspaceOf('run_A', 'EXECUTING', {
      tasks: [{ taskId: 'tsk_A1', stageId: 'stg_1', kind: 'work' }],
    });
    next.overview.runId = 'execution_1';
    await respondRuntimeChain(harness, 'run_A', next);
    await selectTask(container, 'tsk_A1');
    await advance(TICK_MS);
    next.overview.runId = 'execution_2';
    await respondRuntimeChain(harness, 'run_A', next);
    await respond(harness, 'run.task', taskObservationOf('tsk_A1', 'RUNNING'));
    expect(container.textContent).toContain('选择运行页中的任务以查看 canonical 明细。');
  });
});

describe('DRA-05 P2 — uncancellable runtime IPC has bounded deadlines and recovery', () => {
  const setup = async () => {
    const harness = makeHarness();
    harness.setSummary([
      { runId: 'run_A', state: 'EXECUTING', objective: '目标 A' },
      { runId: 'run_B', state: 'EXECUTING', objective: '目标 B' },
      { runId: 'run_C', state: 'EXECUTING', objective: '目标 C' },
    ]);
    const container = await mountApp(harness);
    await openGoal(container, '目标 A');
    return { harness, container };
  };

  it('times out permanent pending requests, permits one replacement, then blocks without request growth', async () => {
    const { harness, container } = await setup();
    await advance(RUNTIME_READ_TIMEOUT_MS);
    expect(container.textContent).toContain('RUNTIME_READ_TIMEOUT');
    expect(container.textContent).not.toContain('读取 canonical 状态…');
    await advance(TICK_MS);
    expect(harness.callsOf('goal.workspace')).toHaveLength(2);
    await advance(RUNTIME_READ_TIMEOUT_MS);
    await advance(TICK_MS);
    expect(container.textContent).toContain('RUNTIME_READ_BLOCKED');
    for (let i = 0; i < 20; i += 1) await advance(TICK_MS);
    expect(harness.callsOf('goal.workspace')).toHaveLength(MAX_PENDING_RUNTIME_READS);
    expect(harness.pending.filter((call) => call.operation === 'goal.workspace')).toHaveLength(2);
  });

  it('drops a timed-out result and recovers once a physical slot actually settles', async () => {
    const { harness, container } = await setup();
    await advance(RUNTIME_READ_TIMEOUT_MS);
    await advance(TICK_MS);
    await advance(RUNTIME_READ_TIMEOUT_MS);
    await advance(TICK_MS);
    await respond(harness, 'goal.workspace', workspaceOf('run_A', 'FAILED'), 'run_A');
    expect(container.textContent).not.toContain('目标 · FAILED');
    expect(harness.callsOf('run.timeline')).toHaveLength(0);
    await advance(TICK_MS);
    expect(harness.callsOf('goal.workspace')).toHaveLength(3);
    // The second expired request also returns; neither expired response commits.
    await respond(harness, 'goal.workspace', workspaceOf('run_A', 'FAILED'), 'run_A');
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'EXECUTING'));
    await expandPanel(container);
    expect(container.textContent).toContain('目标 · EXECUTING');
    expect(container.textContent).not.toContain('RUNTIME_READ_');
  });

  it('keeps the physical cap across Goal switches and ignores old timeouts and responses', async () => {
    const { harness, container } = await setup();
    await openGoal(container, '目标 B');
    await openGoal(container, '目标 C');
    expect(harness.callsOf('goal.workspace')).toHaveLength(2);
    expect(container.textContent).toContain('RUNTIME_READ_BLOCKED');
    await advance(RUNTIME_READ_TIMEOUT_MS);
    expect(container.textContent).not.toContain('RUNTIME_READ_TIMEOUT');
    await respond(harness, 'goal.workspace', workspaceOf('run_A', 'FAILED'), 'run_A');
    await advance(TICK_MS);
    await respondRuntimeChain(harness, 'run_C', workspaceOf('run_C', 'RECOVERING'));
    await expandPanel(container);
    await respond(harness, 'goal.workspace', workspaceOf('run_B', 'FAILED'), 'run_B');
    expect(container.textContent).toContain('目标 · RECOVERING');
    expect(container.textContent).not.toContain('FAILED');
  });

  it('recovers from rejected requests and invalid envelopes without unhandled errors', async () => {
    const { harness, container } = await setup();
    const call = harness.pending.shift()!;
    await act(async () => { call.reject(new Error('fixture transport rejected')); });
    await settle();
    expect(container.textContent).toContain('RUNTIME_READ_FAILED');
    await advance(TICK_MS);
    const second = harness.pending.shift()!;
    await act(async () => { second.resolve({ ok: false, error: { code: 'FIXTURE' } }); });
    await settle();
    await advance(TICK_MS);
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'EXECUTING'));
    expect(container.textContent).not.toContain('RUNTIME_READ_FAILED');
  });

  it('applies deadlines to timeline/artifact awaits before accepting terminal state', async () => {
    const { harness, container } = await setup();
    await respond(harness, 'goal.workspace', workspaceOf('run_A', 'COMPLETED'), 'run_A');
    const expired = harness.pending.splice(harness.pending.findIndex((call) => call.operation === 'run.timeline'), 1)[0]!;
    await advance(RUNTIME_READ_TIMEOUT_MS);
    expect(container.textContent).toContain('RUNTIME_READ_TIMEOUT');
    await advance(TICK_MS);
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'COMPLETED'));
    await expandPanel(container);
    expect(container.textContent).toContain('目标 · COMPLETED');
    const calls = harness.callsOf('goal.workspace').length;
    // B and C keep GoalList polling; selected terminal A must still stop.
    await advance(TICK_MS * 4);
    expect(harness.callsOf('goal.workspace')).toHaveLength(calls);
    await act(async () => { expired.resolve({ ok: true, value: { entries: [{ kind: 'LATE', summary: 'expired', timestamp: '' }] } }); });
    await settle();
    expect(container.textContent).not.toContain('expired');
  });

  it('also times out artifact reads and discards their late values', async () => {
    const { harness, container } = await setup();
    await respond(harness, 'goal.workspace', workspaceOf('run_A', 'EXECUTING'), 'run_A');
    await respond(harness, 'run.timeline', { entries: [] }, 'run_A');
    await advance(RUNTIME_READ_TIMEOUT_MS);
    expect(container.textContent).toContain('RUNTIME_READ_TIMEOUT');
    await respond(harness, 'run.artifacts', { artifacts: [{ artifactId: 'expired-artifact', kind: 'text' }] }, 'run_A');
    expect(container.textContent).not.toContain('expired-artifact');
    await advance(TICK_MS);
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'EXECUTING'));
    expect(container.textContent).not.toContain('RUNTIME_READ_TIMEOUT');
  });

  it('StrictMode effect cleanup does not disable the next mounted read', async () => {
    const harness = makeHarness();
    harness.setSummary([{ runId: 'run_A', state: 'EXECUTING', objective: '目标 A' }]);
    const container = await mountApp(harness, true);
    await openGoal(container, '目标 A');
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'EXECUTING'));
    await advance(TICK_MS);
    expect(harness.callsOf('goal.workspace')).toHaveLength(2);
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'COMPLETED'));
    await expandPanel(container);
    expect(container.textContent).toContain('目标 · COMPLETED');
  });

  it('cleans local deadlines and polling on unmount without claiming IPC cancellation', async () => {
    const { harness, container } = await setup();
    await act(async () => { activeRoot!.unmount(); });
    activeRoot = null;
    const count = harness.calls.length;
    await advance(RUNTIME_READ_TIMEOUT_MS * 4);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.pending).toHaveLength(1);
    await respond(harness, 'goal.workspace', workspaceOf('run_A', 'FAILED'), 'run_A');
    expect(harness.calls).toHaveLength(count);
    expect(container.textContent).toBe('');
  });
});

describe('DRA-05 — the controlled refresh drives the open Goal\'s runtime reads', () => {
  it('a tick re-reads the open Goal and a durable state change reaches the runtime panel', async () => {
    const harness = makeHarness();
    harness.setSummary([
      { runId: 'run_A', state: 'EXECUTING', objective: '目标 A' },
      { runId: 'run_B', state: 'EXECUTING', objective: '目标 B' },
    ]);
    const container = await mountApp(harness);

    await openGoal(container, '目标 A');
    expect(harness.callsOf('goal.workspace').length).toBe(1);
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'EXECUTING', { objective: '目标 A' }));
    await expandPanel(container);
    expect(container.textContent).toContain('目标 · EXECUTING');

    // The controlled refresh (same 4s tick as every other projection) must re-read
    // the OPEN Goal's canonical projections…
    await advance(TICK_MS);
    const afterTick = harness.callsOf('goal.workspace');
    expect(afterTick.length).toBe(2);
    expect(afterTick[1]?.payload['runId']).toBe('run_A');
    expect(harness.pending.some((call) => call.operation === 'goal.workspace')).toBe(true);

    // …and the durable change it returns must reach the panel.
    await respondRuntimeChain(
      harness,
      'run_A',
      workspaceOf('run_A', 'COMPLETED', { objective: '目标 A', artifactIds: ['art_9'] }),
    );
    expect(container.textContent).toContain('目标 · COMPLETED');

    // Every request the renderer made is a READ of the canonical surface.
    for (const call of harness.calls) expect(READ_OPERATIONS).toContain(call.operation);
  });

  it('a late Goal-A response never lands on Goal B', async () => {
    const harness = makeHarness();
    harness.setSummary([
      { runId: 'run_A', state: 'EXECUTING', objective: '目标 A' },
      { runId: 'run_B', state: 'EXECUTING', objective: '目标 B' },
    ]);
    const container = await mountApp(harness);

    // Goal A opens and its workspace read stays PENDING (a slow response).
    await openGoal(container, '目标 A');
    expect(harness.callsOf('goal.workspace').length).toBe(1);

    // The user switches to Goal B while A's read is still in flight.
    await openGoal(container, '目标 B');
    const workspaceCalls = harness.callsOf('goal.workspace');
    expect(workspaceCalls.length).toBe(2);
    expect(workspaceCalls[1]?.payload['runId']).toBe('run_B');
    await respondRuntimeChain(harness, 'run_B', workspaceOf('run_B', 'RECOVERING', { objective: '目标 B' }));
    await expandPanel(container);
    expect(container.textContent).toContain('目标 · RECOVERING');

    // Goal A's response arrives LATE — it must be dropped entirely: no panel
    // overwrite, and the discarded chain must not continue to timeline/artifacts.
    await respond(harness, 'goal.workspace', workspaceOf('run_A', 'FAILED', { objective: '目标 A' }), 'run_A');
    await settle();
    expect(container.textContent).toContain('目标 · RECOVERING');
    expect(container.textContent).not.toContain('FAILED');
    expect(harness.callsOf('run.timeline').some((call) => call.payload['runId'] === 'run_A')).toBe(false);
    const runtimeOps = ['goal.workspace', 'run.timeline', 'run.artifacts'];
    expect(harness.pending.some((call) => runtimeOps.includes(call.operation) && call.payload['runId'] === 'run_A')).toBe(
      false,
    );
  });

  it('repeated ticks never pile up: one read in flight per Goal, coalesced', async () => {
    const harness = makeHarness();
    harness.setSummary([{ runId: 'run_A', state: 'EXECUTING', objective: '目标 A' }]);
    const container = await mountApp(harness);

    await openGoal(container, '目标 A');
    expect(harness.callsOf('goal.workspace').length).toBe(1);

    // Three ticks while the first read is still pending: the latch coalesces them.
    await advance(TICK_MS * 3);
    expect(harness.callsOf('goal.workspace').length).toBe(1);

    // Once the read settles, the next tick reads again (the chain is alive).
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'EXECUTING', { objective: '目标 A' }));
    await advance(TICK_MS);
    expect(harness.callsOf('goal.workspace').length).toBe(2);
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'EXECUTING', { objective: '目标 A' }));

    for (const call of harness.calls) expect(READ_OPERATIONS).toContain(call.operation);
  });

  it('a terminal Goal stops the polling', async () => {
    const harness = makeHarness();
    harness.setSummary([{ runId: 'run_A', state: 'EXECUTING', objective: '目标 A' }]);
    const container = await mountApp(harness);

    await openGoal(container, '目标 A');
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'EXECUTING', { objective: '目标 A' }));
    await expandPanel(container);
    expect(container.textContent).toContain('目标 · EXECUTING');

    // The durable truth turns terminal; the one tick that was already scheduled
    // still runs and delivers it…
    harness.setSummary([{ runId: 'run_A', state: 'COMPLETED', objective: '目标 A' }]);
    await advance(TICK_MS);
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'COMPLETED', { objective: '目标 A' }));
    expect(container.textContent).toContain('目标 · COMPLETED');

    // …and then NO further reads happen, however long time runs.
    const settled = harness.callsOf('goal.workspace').length;
    await advance(TICK_MS * 5);
    expect(harness.callsOf('goal.workspace').length).toBe(settled);
  });

  it('unmounting stops everything and late responses land nowhere', async () => {
    const harness = makeHarness();
    harness.setSummary([{ runId: 'run_A', state: 'EXECUTING', objective: '目标 A' }]);
    const container = await mountApp(harness);

    await openGoal(container, '目标 A');
    await respondRuntimeChain(harness, 'run_A', workspaceOf('run_A', 'EXECUTING', { objective: '目标 A' }));

    // A tick starts a read that is still in flight when the component unmounts.
    await advance(TICK_MS);
    expect(harness.callsOf('goal.workspace').length).toBe(2);

    const root = activeRoot as Root;
    await act(async () => {
      root.unmount();
    });
    activeRoot = null;
    const callsAtUnmount = harness.calls.length;

    // The late response resolves into a dead view: it must neither throw nor
    // trigger any further request (intervals are gone too).
    await respond(harness, 'goal.workspace', workspaceOf('run_A', 'COMPLETED', { objective: '目标 A' }), 'run_A');
    await advance(TICK_MS * 5);
    expect(harness.calls.length).toBe(callsAtUnmount);
  });

  it('a task detail from Goal A is cleared on a Goal switch and its late response is dropped', async () => {
    const harness = makeHarness();
    harness.setSummary([
      { runId: 'run_A', state: 'EXECUTING', objective: '目标 A' },
      { runId: 'run_B', state: 'EXECUTING', objective: '目标 B' },
    ]);
    const container = await mountApp(harness);

    await openGoal(container, '目标 A');
    await respondRuntimeChain(
      harness,
      'run_A',
      workspaceOf('run_A', 'EXECUTING', {
        objective: '目标 A',
        tasks: [{ taskId: 'tsk_A1', stageId: 'stg_1', kind: 'work' }],
      }),
    );
    await expandPanel(container);
    expect(container.textContent).toContain('tsk_A1');

    // Open the task detail (its read stays in flight), then switch to Goal B.
    const taskButton = clickableWithText(container, 'tsk_A1');
    expect(taskButton).not.toBeNull();
    await act(async () => {
      dispatchMiniEvent(taskButton as MiniElement, 'click');
    });
    await settle();
    expect(harness.callsOf('run.task').length).toBe(1);

    await openGoal(container, '目标 B');
    await respondRuntimeChain(harness, 'run_B', workspaceOf('run_B', 'EXECUTING', { objective: '目标 B' }));
    await settle();
    // The detail belongs to ONE Goal: under Goal B the detail view is empty again.
    expect(container.textContent).toContain('选择运行页中的任务以查看 canonical 明细。');
    expect(container.textContent).not.toContain('tsk_A1');

    // Goal A's late detail response must not appear under Goal B.
    await respond(harness, 'run.task', taskObservationOf('tsk_A1', 'RUNNING'));
    await settle();
    expect(container.textContent).not.toContain('tsk_A1');
  });
});
