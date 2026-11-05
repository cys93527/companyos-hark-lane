/**
 * UI-PAPER-INK interaction audit (lane/evidence/UI-REDESIGN/INTERACTION_AUDIT.md) — renderer fixes.
 * Real React mount over the mini DOM (no new dependency).
 */
import './support/mini-dom.js';

import { act, createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { canSend, ComposerView, isSubmitShortcut, type ComposerViewProps } from '../src/composer.js';
import { ApprovalCardView } from '../src/approvals.js';
import { GoalCancelControl } from '../src/cancel-control.js';
import { goalStateWord, riskWord, elapsedText, sessionCostText } from '../src/format.js';
import { projectPlanSteps, type ExecutionOverviewInput } from '../src/plan-steps.js';
import { SettingsView, SidebarView } from '../src/shell.js';
import { ChatView, goalTitleOf } from '../src/chat.js';
import { createLocalDraftStore } from '../src/local-draft-store.js';
import { SUBMISSION_INTENT_STORAGE_KEY } from '../src/intent-store.js';
import { memoryStorage, mountApp, settle, unmountApp, waitFor, WORKSPACE } from './support/audit-app-harness.js';
import { miniDocument, type MiniElement } from './support/mini-dom.js';

afterEach(() => unmountApp());

const findByTestId = (root: MiniElement, id: string): MiniElement | null => {
  if (root.getAttribute?.('data-testid') === id) return root;
  for (const child of root.childNodes) {
    if ('tagName' in (child as object)) {
      const hit = findByTestId(child as MiniElement, id);
      if (hit !== null) return hit;
    }
  }
  return null;
};

const reactProps = (element: MiniElement): Record<string, unknown> => {
  const record = element as unknown as Record<string, unknown>;
  const key = Object.keys(record).find((name) => name.startsWith('__reactProps$'));
  if (key === undefined) throw new Error('no react props on element');
  return record[key] as Record<string, unknown>;
};

const withDraft = (text: string) => {
  const storage = memoryStorage();
  createLocalDraftStore(storage).save('company_default', WORKSPACE, text);
  return storage;
};

const workspaceOf = (goal: string, state: string, extra: Record<string, unknown> = {}) => ({
  runId: goal, goal: { objective: `objective of ${goal}` }, planningRun: { state: 'COMPLETED', revision: 1 },
  overview: {
    runId: goal, state, revision: 1, reworkCount: 0, maxRework: 3, failureReason: null, resumePoint: null,
    pinnedVersion: null, stages: [], executing: [], attempts: { active: 0, interrupted: 0, completed: 0, failed: 0 },
    validation: { requiredValidatorIds: [], completed: [], failed: false, missing: [] }, correctiveActivity: null, handoffCount: 0,
    progress: { stagesTotal: 0, stagesTerminalSuccessful: 0, tasksTotal: 0, tasksDone: 0, tasksActive: 0, tasksBlocked: 0 }, artifacts: [],
  },
  blockers: [], executionRuns: [], ...extra,
});

/* ----------------------------------------------------------- composer --- */

describe('UI-AUDIT-01/02 composer keyboard + empty input', () => {
  it('Ctrl/⌘+Enter sends; Enter, Shift+Enter and any IME-composition Enter never send', () => {
    expect(isSubmitShortcut({ key: 'Enter', ctrlKey: true })).toBe(true);
    expect(isSubmitShortcut({ key: 'Enter', metaKey: true })).toBe(true);
    expect(isSubmitShortcut({ key: 'Enter' })).toBe(false);
    expect(isSubmitShortcut({ key: 'Enter', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isSubmitShortcut({ key: 'Enter', ctrlKey: true, isComposing: true })).toBe(false);
    expect(isSubmitShortcut({ key: 'Enter', ctrlKey: true, nativeEvent: { isComposing: true } })).toBe(false);
    expect(isSubmitShortcut({ key: 'Enter', ctrlKey: true, keyCode: 229 })).toBe(false);
    expect(isSubmitShortcut({ key: 'a', ctrlKey: true })).toBe(false);
    expect(canSend({ ready: true, busy: false, draft: '   \n ' })).toBe(false);
    expect(canSend({ ready: true, busy: true, draft: 'x' })).toBe(false);
    expect(canSend({ ready: true, busy: false, draft: 'x' })).toBe(true);
  });

  it('App: a whitespace-only draft leaves 发送 disabled (no silent no-op)', async () => {
    const app = await mountApp({ storage: withDraft('   '), control: () => undefined });
    expect(app.button('发送')?.getAttribute('disabled')).not.toBeNull();
  });

  it('App: Ctrl+Enter in the field sends exactly once; a composing Enter sends nothing', async () => {
    const app = await mountApp({
      storage: withDraft('整理供应商对账'),
      control: (call) => (call.operation === 'goal.create' ? { ok: true, value: { runId: 'run_new' } } : undefined),
    });
    const field = findByTestId(app.view, 'goal-objective');
    expect(field).not.toBeNull();
    // The mini DOM has no native keyboard pipeline; drive the field's own React key handler.
    const press = async (init: Record<string, unknown>): Promise<void> => {
      const props = reactProps(field!);
      await act(async () => {
        (props['onKeyDown'] as (event: Record<string, unknown>) => void)({ preventDefault: () => undefined, ...init });
      });
      await settle();
    };
    await press({ key: 'Enter', ctrlKey: true, nativeEvent: { isComposing: true, keyCode: 229 } });
    await press({ key: 'Enter' });
    expect(app.callsOf('goal.create')).toHaveLength(0);
    await press({ key: 'Enter', ctrlKey: true, nativeEvent: { isComposing: false } });
    await waitFor(() => app.callsOf('goal.create').length > 0);
    expect(app.callsOf('goal.create')).toHaveLength(1);
    expect(app.callsOf('goal.create')[0]!.payload['objective']).toBe('整理供应商对账');
  });
});

/* ---------------------------------------------------------- new goal --- */

describe('UI-AUDIT-03 新建目标 keeps an unconfirmed submission and the typed text', () => {
  it('the pending intent survives 新建目标 (no silent discard → no duplicate Goal)', async () => {
    const storage = withDraft('一个会超时的目标');
    const app = await mountApp({
      storage,
      control: (call) => (call.operation === 'goal.create' ? { ok: false, error: { code: 'IPC_FAILED', message: 'timeout' } } : undefined),
    });
    await app.click('发送');
    expect(app.view.textContent).toContain('上一次提交尚未确认');
    const before = storage.getItem(SUBMISSION_INTENT_STORAGE_KEY);
    expect(before).not.toBeNull();
    await app.click('新建目标');
    expect(storage.getItem(SUBMISSION_INTENT_STORAGE_KEY)).toBe(before);
    expect(app.view.textContent).toContain('上一次提交尚未确认');
  });

  it('Ctrl+N opens a new goal page (no Goal open) and leaves the draft alone', async () => {
    const app = await mountApp({
      storage: withDraft('草稿内容'),
      control: (call) => {
        if (call.operation === 'home.summary') return { ok: true, value: { goals: [{ runId: 'goal_a', state: 'COMPLETED', objective: 'Goal A' }] } };
        if (call.operation === 'goal.workspace') return { ok: true, value: workspaceOf('goal_a', 'COMPLETED') };
        if (call.operation === 'run.timeline') return { ok: true, value: { entries: [] } };
        if (call.operation === 'run.artifacts') return { ok: true, value: { artifacts: [] } };
        return undefined;
      },
    });
    await app.click('Goal A');
    await waitFor(() => app.view.textContent.includes('objective of goal_a'));
    // window keydown listeners live on the mini document (no native keyboard pipeline here).
    const listeners = (miniDocument as unknown as { listenersFor: (type: string) => { bubble: Set<(event: unknown) => void> } | undefined })
      .listenersFor('keydown')?.bubble ?? new Set();
    expect(listeners.size).toBeGreaterThan(0);
    await act(async () => {
      for (const listener of [...listeners]) listener({ key: 'n', ctrlKey: true, preventDefault: () => undefined });
    });
    await settle();
    expect(app.view.textContent).toContain('你想把什么事情变成现实');
    expect(app.view.textContent).toContain('新目标');
    const field = findByTestId(app.view, 'goal-objective') as unknown as { value?: string } | null;
    expect(field?.value ?? (field as unknown as MiniElement | null)?.getAttribute?.('value')).toBe('草稿内容');
  });
});

/* ---------------------------------------------------------- approvals --- */

const approvalRow = (id: string) => ({
  id, runId: 'goal_a', taskId: 'tsk_3', riskLevel: 'MEDIUM', status: 'pending', reason: '安装开发依赖',
  requestedBy: 'agent', requestedAt: '2026-11-04T00:00:00.000Z', decidedBy: null, decidedAt: null, decisionNote: null,
});

const approvalSetup = async (options: { respond?: () => unknown; cancelled?: boolean } = {}) => {
  let release: ((value: unknown) => void) | null = null;
  const app = await mountApp({
    control: (call) => {
      if (call.operation === 'home.summary') return { ok: true, value: { goals: [{ runId: 'goal_a', state: 'WAITING_APPROVAL', objective: 'Goal A' }] } };
      if (call.operation === 'decisions.pending') return { ok: true, value: { pending: [{ runId: 'goal_a', runState: 'WAITING_APPROVAL', approvals: [approvalRow('apr_1')] }] } };
      if (call.operation === 'goal.workspace') {
        return { ok: true, value: workspaceOf('goal_a', 'WAITING_APPROVAL', { cancellationRequested: options.cancelled === true, blockers: [{ code: 'APPROVAL_REQUIRED', scope: 'RUN', explanation: '等待批准' }] }) };
      }
      if (call.operation === 'run.timeline') return { ok: true, value: { entries: [] } };
      if (call.operation === 'run.artifacts') return { ok: true, value: { artifacts: [] } };
      if (call.operation === 'approval.respond') {
        if (options.respond !== undefined) return options.respond();
        return new Promise((resolve) => { release = resolve; });
      }
      return undefined;
    },
  });
  await app.click('Goal A');
  await waitFor(() => app.view.textContent.includes('需要你的批准'));
  return { app, release: (value: unknown) => release?.(value) };
};

describe('UI-AUDIT-04/05/06 approval decisions', () => {
  it('批准 names the approval row the user saw; a double click sends ONE decision', async () => {
    const { app, release } = await approvalSetup();
    await app.click('批准');
    await app.click('提交中…').catch(() => undefined);
    expect(app.callsOf('approval.respond')).toHaveLength(1);
    expect(app.callsOf('approval.respond')[0]!.payload).toMatchObject({ runId: 'goal_a', decision: 'approve', approvalId: 'apr_1' });
    release({ ok: true, value: { runId: 'goal_a', decision: 'approve', resumed: true } });
    await settle();
  });

  it('a stale approval refusal is explained, not shown as a generic failure', async () => {
    const { app } = await approvalSetup({
      respond: () => ({ ok: false, error: { code: 'CONFLICT', message: 'stale', details: { reason: 'APPROVAL_STALE' } } }),
    });
    await app.click('批准');
    await waitFor(() => app.view.textContent.includes('APPROVAL_STALE'));
    expect(app.view.textContent).toContain('已被处理或已被新的请求取代');
  });

  it('after a cancel request the approval is shown but not actionable', async () => {
    const { app } = await approvalSetup({ cancelled: true });
    expect(app.view.textContent).toContain('无需处理');
    const card = findByTestId(app.view, 'approval-card');
    expect(card).not.toBeNull();
    const buttons: MiniElement[] = [];
    const walk = (node: MiniElement): void => {
      if (node.tagName === 'BUTTON') buttons.push(node);
      for (const child of node.childNodes) if ('tagName' in (child as object)) walk(child as MiniElement);
    };
    walk(card!);
    expect(buttons).toEqual([]);
  });

  it('the risk level is a word, the canonical level stays available', () => {
    expect(riskWord('MEDIUM')).toBe('中');
    expect(riskWord('HIGH')).toBe('高');
    expect(riskWord('')).toBe('--');
    expect(riskWord('UNKNOWN')).toBe('--');
  });
});

/* ------------------------------------------------- database / navigation --- */

describe('UI-AUDIT-09/10/11 database failure, objective, navigation', () => {
  it('a database failure is visible on every view and blocks 发送 with a reason', async () => {
    const app = await mountApp({
      storage: withDraft('写报告'),
      databaseFailure: { code: 'OPEN_FAILED', message: 'locked' },
      control: () => undefined,
    });
    expect(app.view.textContent).toContain('数据库无法打开');
    expect(app.button('发送')?.getAttribute('disabled')).not.toBeNull();
    expect(app.view.textContent).toContain('本地数据库不可用');
    await app.click('设置');
    expect(app.view.textContent).toContain('数据库无法打开');
  });

  it('an open Goal missing from the recent list still shows its own objective (never the empty prompt)', async () => {
    const app = await mountApp({
      storage: withDraft('新的目标'),
      control: (call) => {
        if (call.operation === 'goal.create') return { ok: true, value: { runId: 'goal_new' } };
        if (call.operation === 'home.summary') return { ok: true, value: { goals: [] } };
        if (call.operation === 'goal.workspace') return { ok: true, value: workspaceOf('goal_new', 'EXECUTING') };
        if (call.operation === 'run.timeline') return { ok: true, value: { entries: [] } };
        if (call.operation === 'run.artifacts') return { ok: true, value: { artifacts: [] } };
        return undefined;
      },
    });
    await app.click('发送');
    await waitFor(() => app.view.textContent.includes('objective of goal_new'));
    expect(app.view.textContent).not.toContain('你想把什么事情变成现实');
  });

  it('首页 shows the start prompt + goal list, 对话与任务 shows the open Goal', async () => {
    const app = await mountApp({
      control: (call) => {
        if (call.operation === 'home.summary') return { ok: true, value: { goals: [{ runId: 'goal_a', state: 'EXECUTING', objective: 'Goal A' }] } };
        if (call.operation === 'goal.workspace') return { ok: true, value: workspaceOf('goal_a', 'EXECUTING') };
        if (call.operation === 'run.timeline') return { ok: true, value: { entries: [] } };
        if (call.operation === 'run.artifacts') return { ok: true, value: { artifacts: [] } };
        return undefined;
      },
    });
    await app.click('Goal A');
    await waitFor(() => app.view.textContent.includes('objective of goal_a'));
    await app.click('首页');
    expect(app.view.textContent).not.toContain('objective of goal_a');
    expect(app.view.textContent).toContain('你想把什么事情变成现实');
    expect(findByTestId(app.view, 'goal-list')).not.toBeNull();
    await app.click('对话与任务');
    await waitFor(() => app.view.textContent.includes('objective of goal_a'));
  });
});

/* ------------------------------------------------------------ lists/words --- */

describe('UI-AUDIT-12 sidebar order and state words', () => {
  it('newest first, Chinese state words, never the raw enum', () => {
    const html = renderToStaticMarkup(h(SidebarView, {
      view: 'chat', activeGoalRunId: 'b', busy: false, onNewGoal: () => {}, onNavigate: () => {}, onOpenGoal: () => {},
      recent: [
        { runId: 'a', objective: '旧目标', state: 'COMPLETED', createdAt: '2026-11-01T00:00:00Z' },
        { runId: 'b', objective: '新目标', state: 'EXECUTING', createdAt: '2026-11-03T00:00:00Z' },
        { runId: 'c', objective: '取消的', state: 'FAILED', terminalOutcome: 'CANCELLED', createdAt: '2026-11-02T00:00:00Z' },
      ],
    }));
    expect(html.indexOf('新目标')).toBeLessThan(html.indexOf('取消的'));
    expect(html.indexOf('取消的')).toBeLessThan(html.indexOf('旧目标'));
    expect(html).toContain('执行中');
    expect(html).toContain('已取消');
    expect(html).not.toContain('EXECUTING');
    expect(goalStateWord({ state: 'WAITING_APPROVAL' })).toBe('待批准');
    expect(goalStateWord({ state: 'EXECUTING', approvalPending: true })).toBe('待批准');
    expect(goalStateWord({ state: 'FAILED', failureReason: 'timed_out' })).toBe('已超时');
  });

  it('elapsed time is measured, unknown start renders nothing', () => {
    expect(elapsedText('2026-11-04T00:00:00.000Z', Date.parse('2026-11-04T00:06:12.000Z'))).toBe('6 分 12 秒');
    expect(elapsedText(null, Date.now())).toBeNull();
    expect(elapsedText('not a date', Date.now())).toBeNull();
  });
});

/* ------------------------------------------------------------ plan steps --- */

describe('UI-PAPER-INK plan steps come from canonical stage truth only', () => {
  const items = [
    { planItemId: 'p1', objective: '定位缺陷', taskKind: null, stageId: 's1' },
    { planItemId: 'p2', objective: '修复缺陷', taskKind: null, stageId: 's2' },
    { planItemId: 'p3', objective: '写说明', taskKind: null, stageId: 's3' },
    { planItemId: 'p4', objective: '未编译', taskKind: null, stageId: null },
  ];
  const execution: ExecutionOverviewInput = {
    runId: 'exec',
    stages: [
      { stageId: 's1', taskCounts: { DONE: 1 }, terminalSuccessful: true },
      { stageId: 's2', taskCounts: { RUNNING: 1 }, terminalSuccessful: false },
      { stageId: 's3', taskCounts: { PENDING: 1 }, terminalSuccessful: false },
    ],
    executing: [{ taskId: 't2', stageId: 's2', attempt: { attemptNumber: 2 } }],
  };

  it('done / executing (with the live attempt) / pending', () => {
    const steps = projectPlanSteps({ items, execution, phase: 'executing', outcome: null });
    expect(steps.map((step) => step.state)).toEqual(['DONE', 'EXECUTING', 'PENDING', 'PENDING']);
    expect(steps[1]?.label).toBe('执行中 · 尝试 2');
  });

  it('awaiting approval marks the running step, never a guessed one', () => {
    const steps = projectPlanSteps({ items, execution, phase: 'awaiting-user', outcome: null });
    expect(steps.map((step) => step.state)).toEqual(['DONE', 'AWAITING', 'PENDING', 'PENDING']);
  });

  it('an ended Goal never shows 待开始 or 执行中', () => {
    const cancelled = projectPlanSteps({ items, execution: { ...execution, executing: [] }, phase: 'cancelled', outcome: 'CANCELLED' });
    expect(cancelled.map((step) => step.state)).toEqual(['DONE', 'CANCELLED', 'CANCELLED', 'CANCELLED']);
    const failed = projectPlanSteps({
      items,
      execution: { ...execution, executing: [], stages: [execution.stages[0]!, { stageId: 's2', taskCounts: { FAILED: 1 }, terminalSuccessful: false }, execution.stages[2]!] },
      phase: 'failed', outcome: 'FAILED',
    });
    expect(failed.map((step) => step.state)).toEqual(['DONE', 'FAILED', 'NOT_RUN', 'NOT_RUN']);
  });

  it('the goal page renders the steps with their state words and no duration/percentage', () => {
    const steps = projectPlanSteps({ items, execution, phase: 'executing', outcome: null });
    const html = renderToStaticMarkup(h(ChatView, {
      objective: '修复库存模块缺陷并新增补货计划', loading: false, failure: null,
      entries: [{ kind: 'goal-accepted', runId: 'g', objective: 'x' }],
      planSteps: steps, criteria: [{ criterionId: 'c1', requirement: '测试全部通过' }],
    }));
    expect(html).toContain('规划完成 · 4 步 · 1 条验收标准');
    expect(html).toContain('data-state="EXECUTING"');
    expect(html).toContain('执行中 · 尝试 2');
    expect(html).toContain('验收 · 测试全部通过');
    expect(html).not.toMatch(/\d+\s*%/u);
    expect(html).not.toContain('linear-gradient');
  });

  it('the H1 is the bounded first line; the full ask is kept in the quote', () => {
    expect(goalTitleOf('短目标')).toEqual({ title: '短目标', truncated: false });
    const long = goalTitleOf(`${'很'.repeat(60)}\n第二行`);
    expect(long.truncated).toBe(true);
    expect(long.title.endsWith('…')).toBe(true);
  });
});

/* --------------------------------------------- remaining audit findings --- */

type AnyElement = { readonly type?: unknown; readonly props?: Record<string, unknown> };
const collectElements = (node: unknown, out: AnyElement[] = []): AnyElement[] => {
  if (Array.isArray(node)) { for (const child of node) collectElements(child, out); return out; }
  if (node === null || typeof node !== 'object' || !('props' in (node as object))) return out;
  const element = node as AnyElement;
  out.push(element);
  collectElements(element.props?.['children'], out);
  return out;
};

describe('UI-AUDIT-07 approval card focus and emphasis', () => {
  it('no button is pre-focused; the card itself is focusable; 批准 primary, 拒绝 quiet; risk as a word', () => {
    const html = renderToStaticMarkup(h(ApprovalCardView, {
      decision: { runId: 'goal_a', runState: 'WAITING_APPROVAL', approvals: [approvalRow('apr_1')] } as never,
      busy: false, failure: null, onDecide: () => undefined,
    }));
    expect(html).not.toMatch(/autofocus/iu);
    expect(html).toContain('data-approval-id="apr_1"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toMatch(/btn--primary approval-card__approve[^>]*>批准</u);
    expect(html).toMatch(/btn--quiet approval-card__deny[^>]*>拒绝</u);
    expect(html).toContain('风险 · 中');
  });
});

describe('UI-AUDIT-08 cancel confirmation', () => {
  const base = { visible: true, requested: false, confirming: true, failure: null, onRequest: () => undefined, onConfirm: () => undefined };
  it('says a pending approval will not run, focuses 继续执行 and closes on Escape (not while busy)', () => {
    let dismissed = 0;
    const tree = collectElements(GoalCancelControl({ ...base, busy: false, approvalPending: true, onDismiss: () => { dismissed += 1; } }));
    const dialog = tree.find((el) => el.props?.['role'] === 'alertdialog')!;
    expect(renderToStaticMarkup(h(GoalCancelControl, { ...base, busy: false, approvalPending: true, onDismiss: () => undefined }))).toContain('等待批准的操作不会执行');
    const keep = tree.find((el) => el.props?.['data-testid'] === 'goal-cancel-dismiss')!;
    expect(keep.props?.['children']).toBe('继续执行');
    let focused = 0;
    (keep.props?.['ref'] as (el: { focus: () => void }) => void)({ focus: () => { focused += 1; } });
    expect(focused).toBe(1);
    const confirm = tree.find((el) => el.props?.['data-testid'] === 'goal-cancel-confirm')!;
    expect(confirm.props?.['ref']).toBeUndefined();
    (dialog.props?.['onKeyDown'] as (e: { key: string }) => void)({ key: 'Enter' });
    expect(dismissed).toBe(0);
    (dialog.props?.['onKeyDown'] as (e: { key: string }) => void)({ key: 'Escape' });
    expect(dismissed).toBe(1);
    const busyTree = collectElements(GoalCancelControl({ ...base, busy: true, onDismiss: () => { dismissed += 1; } }));
    (busyTree.find((el) => el.props?.['role'] === 'alertdialog')!.props?.['onKeyDown'] as (e: { key: string }) => void)({ key: 'Escape' });
    expect(dismissed).toBe(1);
  });
});

describe('UI-AUDIT-25 composer stays focusable while sending', () => {
  it('the field is read-only (not disabled) while busy', () => {
    const props = {
      draft: '写报告', ready: true, busy: true, authority: { mode: 'read-only', basis: 'x', mutable: false },
      modelLabel: 'Model One', workspaceLabel: null, pendingIntent: false,
      onDraftChange: () => undefined, onSubmit: () => undefined, onChangeWorkspace: () => undefined,
      onOpenTools: () => undefined, onOpenAuthority: () => undefined, onOpenModel: () => undefined,
      authorityOpen: false, modelOpen: false,
    } as unknown as ComposerViewProps;
    const textarea = collectElements(ComposerView(props)).find((el) => el.type === 'textarea')!;
    expect(textarea.props?.['readOnly']).toBe(true);
    expect(textarea.props?.['disabled']).toBeUndefined();
    expect(textarea.props?.['placeholder']).toContain('描述一个新目标');
  });
});

describe('UI-AUDIT-13/14 settings text', () => {
  it('names 「CompanyOS 首次配置」 and renders unknown values as --', () => {
    const html = renderToStaticMarkup(h(SettingsView, {
      workspaceRoot: null, modelStatus: { kind: 'provider-not-configured' }, catalogueCount: 0, registeredCount: 0,
      appVersion: '0.1.2', databasePath: null, schemaVersion: null, allowedChannels: [],
    }));
    expect(html).toContain('「CompanyOS 首次配置」');
    expect(html).toContain('<dd>--</dd>');
    expect(html).not.toMatch(/<dd>-<\/dd>|<dd>unknown<\/dd>|<dd>none<\/dd>/iu);
  });
});

describe('UI-AUDIT-13/15/19 goal page in the app', () => {
  const openGoal = async (modelSelected: boolean) => {
    const app = await mountApp({
      modelSelected,
      control: (call) => {
        if (call.operation === 'home.summary') return { ok: true, value: { goals: [{ runId: 'goal_a', state: 'EXECUTING', objective: 'Goal A' }] } };
        if (call.operation === 'goal.workspace') return { ok: true, value: workspaceOf('goal_a', 'EXECUTING') };
        if (call.operation === 'run.timeline') return { ok: true, value: { entries: [] } };
        if (call.operation === 'run.artifacts') return { ok: true, value: { artifacts: [] } };
        return undefined;
      },
    });
    await app.click('Goal A');
    await waitFor(() => app.view.textContent.includes('objective of goal_a'));
    return app;
  };

  it('a running Goal: right panel open (aria-expanded) and its result reads 进行中, never 未交付; no model card', async () => {
    const app = await openGoal(true);
    expect(app.view.textContent).toContain('进行中');
    expect(app.view.textContent).not.toContain('未交付');
    const collapse = (function find(node: MiniElement): MiniElement | null {
      if ((node.getAttribute?.('class') ?? '').includes('runtime-panel__collapse')) return node;
      for (const child of node.childNodes) if ('tagName' in (child as object)) { const hit = find(child as MiniElement); if (hit !== null) return hit; }
      return null;
    })(app.view);
    expect(collapse).not.toBeNull();
    expect(collapse!.getAttribute('aria-expanded')).toBe('true');
    expect(findByTestId(app.view, 'model-onboarding')).toBeNull();
  });

  it('the model card appears only when no model is selected', async () => {
    const app = await openGoal(false);
    expect(findByTestId(app.view, 'model-onboarding')).not.toBeNull();
  });
});

describe('UI-AUDIT-26 session cost', () => {
  const usage = {
    goalRunId: 'run_1',
    usage: { knownInputTokens: 10, knownOutputTokens: 5, estimatedInputTokens: 0, estimatedOutputTokens: 0, unknownDispatchCount: 0, totalDispatchCount: 1, coverageRatio: 1, complete: true },
    speed: { state: 'UNKNOWN', samples: [], note: '' },
    cacheHit: { state: 'UNKNOWN', reason: '' },
    cost: { state: 'ESTIMATED', knownScopeCost: 1.5, currency: 'CNY', coverageComplete: true, note: '' },
    contextRemaining: { state: 'UNKNOWN', reason: '' },
  } as const;
  it('shows the canonical cost with its currency, ≈ for an estimate, -- when unknown', () => {
    expect(sessionCostText(usage as never)).toBe('≈¥1.50');
    expect(sessionCostText({ ...usage, cost: { ...usage.cost, state: 'KNOWN' } } as never)).toBe('¥1.50');
    expect(sessionCostText({ ...usage, cost: { ...usage.cost, currency: null } } as never)).toBe('--');
    expect(sessionCostText({ ...usage, cost: { ...usage.cost, state: 'UNKNOWN', knownScopeCost: null } } as never)).toBe('--');
    expect(sessionCostText(null)).toBe('--');
  });
});
