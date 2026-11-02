/**
 * AUDIT R7 — IPC rejections are typed, never unhandled, and never leave a busy flag
 * or a 「加载中…」 spinner stuck.
 */
import './support/mini-dom.js';

import { createElement as h } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../src/App.js';
import { IPC_FAILED, safeRequest } from '../src/bridge.js';
import { controlPlaneRead } from '../src/workspace.js';
import { clickableWithText, createContainer, dispatchMiniEvent, removeContainer, type MiniElement } from './support/mini-dom.js';

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  });
};

let root: Root | null = null;
let container: MiniElement | null = null;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

afterEach(() => {
  if (root !== null) {
    const r = root;
    act(() => r.unmount());
    root = null;
  }
  if (container !== null) removeContainer(container);
  container = null;
  delete (globalThis as unknown as Record<string, unknown>)['companyos'];
  process.off('unhandledRejection', onUnhandled);
  unhandled.length = 0;
});

const baseBridge = (controlPlaneRequest: (request: { operation: string; payload?: unknown }) => Promise<unknown>) => ({
  appVersion: async () => '0.0.0-audit',
  platformInfo: async () => ({ platform: 'win32', arch: 'x64', electron: '0', node: '0', chrome: '0' }),
  databaseStatus: async () => ({ path: 'C:/db.sqlite', journalMode: 'wal', schemaVersion: 1 }),
  channels: () => [],
  workflowRequest: async (request: { operation: string }) =>
    request.operation === 'models.selection' ? { ok: true, value: {} } : { ok: true, value: [] },
  workspaceSelect: async () => null,
  workspaceOpen: async (r: string) => ({ ok: true, root: r }),
  workspaceCurrent: async () => '/ws',
  workspaceSwitch: async (r: string) => ({ ok: true, root: r }),
  artifactAction: async () => ({ ok: true, value: null }),
  controlPlaneRequest,
});

const mount = async (bridge: unknown): Promise<MiniElement> => {
  process.on('unhandledRejection', onUnhandled);
  (globalThis as unknown as Record<string, unknown>)['companyos'] = bridge;
  container = createContainer();
  root = createRoot(container as unknown as Element);
  const r = root;
  await act(async () => {
    r.render(h(App));
  });
  await settle();
  return container;
};

describe('AUDIT R7 — IPC rejection handling', () => {
  it('safeRequest turns a rejection (and a synchronous throw) into a typed IPC_FAILED envelope', async () => {
    const rejected = await safeRequest(() => Promise.reject(new Error('SQLITE_BUSY')));
    expect(rejected).toMatchObject({ ok: false, error: { code: IPC_FAILED } });
    expect((rejected as { error: { message: string } }).error.message).toContain('SQLITE_BUSY');
    const thrown = await safeRequest((): Promise<unknown> => {
      throw new Error('boom');
    });
    expect(thrown).toMatchObject({ ok: false, error: { code: IPC_FAILED } });
    const read = await controlPlaneRead({ controlPlaneRequest: () => Promise.reject(new Error('x')) }, 'home.summary', {});
    expect(read).toMatchObject({ ok: false, error: { code: IPC_FAILED } });
  });

  it('a rejected approval.respond releases the busy flag and shows a typed failure (no stuck 批准/拒绝)', async () => {
    const approval = {
      id: 'apr_1', runId: 'run_exec_1', taskId: null, riskLevel: 'HIGH', status: 'pending', reason: 'write file',
      requestedBy: 'agent', requestedAt: 'now', decidedBy: null, decidedAt: null, decisionNote: null,
    };
    // AUDIT-R9: the approval card belongs to the OPEN Goal (its execution run), so the Goal is opened first.
    const workspace = {
      runId: 'run_goal_1', goal: { objective: 'Goal 1' }, planningRun: { state: 'COMPLETED', revision: 1 },
      overview: {
        runId: 'run_exec_1', state: 'WAITING_APPROVAL', revision: 1, reworkCount: 0, maxRework: 3, failureReason: null, resumePoint: null,
        pinnedVersion: null, stages: [], executing: [], attempts: { active: 0, interrupted: 0, completed: 0, failed: 0 },
        validation: { requiredValidatorIds: [], completed: [], failed: false, missing: [] }, correctiveActivity: null, handoffCount: 0,
        progress: { stagesTotal: 0, stagesTerminalSuccessful: 0, tasksTotal: 0, tasksDone: 0, tasksActive: 0, tasksBlocked: 0 }, artifacts: [],
      },
      blockers: [], executionRuns: [{ runId: 'run_exec_1', state: 'WAITING_APPROVAL' }],
    };
    const bridge = baseBridge(async (request) => {
      if (request.operation === 'home.summary') return { ok: true, value: { goals: [{ runId: 'run_goal_1', state: 'EXECUTING', objective: 'Goal 1' }] } };
      if (request.operation === 'decisions.pending') {
        return { ok: true, value: { pending: [{ runId: 'run_exec_1', runState: 'WAITING_APPROVAL', approvals: [approval] }] } };
      }
      if (request.operation === 'goal.workspace') return { ok: true, value: workspace };
      if (request.operation === 'run.timeline') return { ok: true, value: { entries: [] } };
      if (request.operation === 'run.artifacts') return { ok: true, value: { artifacts: [] } };
      if (request.operation === 'approval.respond') throw new Error('main threw');
      return { ok: true, value: null };
    });
    const view = await mount(bridge);
    await act(async () => {
      dispatchMiniEvent(clickableWithText(view, 'Goal 1') as MiniElement, 'click');
    });
    await settle();
    const approve = clickableWithText(view, '批准');
    expect(approve).not.toBeNull();
    await act(async () => {
      dispatchMiniEvent(approve as MiniElement, 'click');
    });
    await settle();
    const after = clickableWithText(view, '批准') as MiniElement;
    expect(after.getAttribute('disabled')).toBeNull();
    expect(view.textContent).toContain('APPROVAL_RESPOND_FAILED');
    expect(unhandled).toEqual([]);
  });

  it('a rejected home.summary renders a typed failure in the goal list instead of a permanent 加载中…', async () => {
    const bridge = baseBridge(async (request) => {
      if (request.operation === 'home.summary') throw new Error('persistence down');
      if (request.operation === 'decisions.pending') return { ok: true, value: { pending: [] } };
      return { ok: true, value: null };
    });
    const view = await mount(bridge);
    const list = view.textContent;
    expect(list).toContain(IPC_FAILED);
    expect(list).not.toContain('加载中');
    expect(unhandled).toEqual([]);
  });
});
