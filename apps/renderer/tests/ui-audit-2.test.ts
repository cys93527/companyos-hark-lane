/**
 * UI-AUDIT-2 (user report 2026-11-11, installed v0.1.4): "这里模型不是，应该显示的是我注册并且
 * 填写apikey的模型显示，而不是所有模型". Renderer root fixes pinned here:
 *  - the composer lists only the models the user set up that can run a Goal (no catalogue,
 *    no "待注册", no image/video/embedding model); adding a model is a Settings action;
 *  - a pinned non-chat model is replaced by the configured chat model, said in plain words;
 *  - "预算为 0" is known BEFORE Send (main's budget.readiness) and blocks it with the fix;
 *  - POLICY_REFUSED / GOAL_ADMISSION_BOUND_UNPROVEN read as plain Chinese with a fix action;
 *  - raw enums, run ids and the raw timeline are behind 详情 / 技术记录, never the main text.
 */
import './support/mini-dom.js';

import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { ModelSelectorView } from '../src/composer.js';
import { goalModelOptions, modelUnusableText, soleModelOption, toModelOptionRows, ModelOnboardingView, type ModelOptionRow } from '../src/models.js';
import { budgetGateFor, budgetRows, parseBudgetReadiness, type BudgetReadiness } from '../src/budget.js';
import { attemptFailureLabel, failureRemedyOf } from '../src/failure-labels.js';
import { ChatView, projectConversation } from '../src/chat.js';
import { plainActivity } from '../src/activity.js';
import { RuntimePanelView, goalRanModels } from '../src/runtime-panel.js';
import { actorWord } from '../src/format.js';
import { SettingsView, budgetSettingsLines } from '../src/shell.js';
import { TypedErrorLine } from '../src/typed-error.js';
import { mountApp, settle, unmountApp } from './support/audit-app-harness.js';
import type { MiniElement, MiniNode } from './support/mini-dom.js';

const byTestId = (root: MiniNode, id: string): MiniElement | null => {
  for (const child of root.childNodes) {
    const element = child as MiniElement;
    if (typeof element.getAttribute === 'function' && element.getAttribute('data-testid') === id) return element;
    const found = byTestId(child, id);
    if (found !== null) return found;
  }
  return null;
};

afterEach(() => unmountApp());

const P = 'model.openai-compatible';
/** What main sends for the user's provider: one configured chat model + the provider's catalogue. */
const USER_CATALOGUE = [
  { providerId: P, providerModelId: 'chat-1', displayName: 'chat-1', contextWindow: 128000, configured: true, goalUsable: true, modality: 'chat' },
  { providerId: P, providerModelId: 'acc-image-v8.2-hd', displayName: 'acc-image-v8.2-hd', contextWindow: 128000, goalUsable: false, unusableReason: 'NOT_CHAT_MODEL', modality: 'image' },
  { providerId: P, providerModelId: 'seedance-2.5', displayName: 'seedance-2.5', contextWindow: 128000, goalUsable: false, unusableReason: 'NOT_CHAT_MODEL', modality: 'video' },
  { providerId: P, providerModelId: 'text-embedding-v4', displayName: 'text-embedding-v4', contextWindow: 128000, goalUsable: false, unusableReason: 'NOT_CHAT_MODEL', modality: 'embedding' },
  { providerId: P, providerModelId: 'qwen-max', displayName: 'qwen-max', contextWindow: 128000, goalUsable: true, modality: 'unknown' },
];
const REGISTERED_IMAGE = { modelKey: 'mdl_img', providerId: P, providerModelId: 'acc-image-v8.2-hd', displayName: 'acc-image-v8.2-hd', enabled: true, modality: 'image' };

const APPROVED: BudgetReadiness = { state: 'APPROVED', currency: 'CNY', capCostMicros: 5_000_000, source: 'provider-setup', covered: [{ providerId: P, modelId: 'chat-1', validUntilMs: Date.UTC(2026, 11, 10), valid: true }] };
const NOT_APPROVED: BudgetReadiness = { state: 'NOT_APPROVED', currency: null, capCostMicros: null, source: null, covered: [] };

describe('the model list is the user\'s models, not the provider catalogue', () => {
  const options = toModelOptionRows(USER_CATALOGUE, [REGISTERED_IMAGE]);
  it('only the configured chat model is a Goal choice (no catalogue rows, no image model)', () => {
    expect(goalModelOptions(options).map((option) => option.providerModelId)).toEqual(['chat-1']);
  });
  it('the composer popover never shows 待注册 / catalogue entries, and offers 管理模型', () => {
    const html = renderToStaticMarkup(h(ModelSelectorView, {
      options, selectedModelKey: null, open: true, busy: false, onToggle: () => {}, onChoose: () => {}, onOpenSettings: () => {}, providerConfigured: true,
    }));
    expect(html).toContain('chat-1');
    for (const hidden of ['待注册', 'acc-image-v8.2-hd', 'seedance-2.5', 'text-embedding-v4', 'qwen-max']) expect(html).not.toContain(hidden);
    expect(html).toContain('管理模型');
  });
  it('a pinned image model is unusable (plain reason) and the configured chat model replaces it', () => {
    const pinned = options.find((option) => option.modelKey === 'mdl_img')!;
    expect(modelUnusableText(pinned)).toBe('「acc-image-v8.2-hd」是图像模型，不能执行目标（目标需要对话模型）');
    expect(soleModelOption(options, { kind: 'selected', modelKey: 'mdl_img', displayName: 'acc-image-v8.2-hd' })?.providerModelId).toBe('chat-1');
  });
  it('a registered chat model from a provider that is no longer bound is not a choice', () => {
    const rows = toModelOptionRows(USER_CATALOGUE, [{ modelKey: 'mdl_old', providerId: 'model.deepseek', providerModelId: 'old-chat', displayName: 'old-chat', enabled: true }]);
    expect(goalModelOptions(rows).map((option) => option.providerModelId)).toEqual(['chat-1']);
  });
  it('the onboarding card lists only Goal models and never prints a policy enum', () => {
    const html = renderToStaticMarkup(h(ModelOnboardingView, {
      status: { kind: 'no-selection' }, options, selectedProviderModelId: null, busy: false, failure: null,
      explanation: { accepted: true, precedence: 'EXPLICIT_USER_CHOICE', fallback: 'NEVER', reasons: [] }, onSelect: () => {}, onOpenSettings: () => {},
    }));
    expect(html).toContain('chat-1');
    expect(html).not.toContain('EXPLICIT_USER_CHOICE');
    expect(html).not.toContain('acc-image');
  });
});

describe('budget is known before Send', () => {
  const chat = { providerId: P, providerModelId: 'chat-1', displayName: 'chat-1' };
  it('gates: approved+covered ok; none = 预算为 0; other model = not covered; expired; restart', () => {
    expect(budgetGateFor(APPROVED, chat)).toEqual({ ok: true, capText: '每个目标上限 ¥5.00' });
    expect(budgetGateFor(NOT_APPROVED, chat)).toMatchObject({ ok: false, kind: 'NOT_APPROVED', short: '预算为 0' });
    expect(budgetGateFor(APPROVED, { ...chat, providerModelId: 'qwen-max', displayName: 'qwen-max' })).toMatchObject({ ok: false, kind: 'NOT_COVERED' });
    expect(budgetGateFor({ ...APPROVED, covered: [{ ...APPROVED.covered[0]!, valid: false }] }, chat)).toMatchObject({ ok: false, kind: 'EXPIRED' });
    expect(budgetGateFor({ ...APPROVED, state: 'RESTART_REQUIRED' }, chat)).toMatchObject({ ok: false, kind: 'RESTART_REQUIRED' });
    expect(budgetGateFor(null, chat)).toBeNull();
  });
  it('parses main\'s answer strictly (malformed = unknown, nothing blocked on a guess)', () => {
    expect(parseBudgetReadiness(NOT_APPROVED)).toEqual(NOT_APPROVED);
    expect(parseBudgetReadiness({ state: 'MAYBE' })).toBeNull();
    expect(parseBudgetReadiness([])).toBeNull();
  });
  it('the App blocks Send with "预算为 0" and the fix, and 查看预算设置 opens the budget section', async () => {
    const app = await mountApp({
      control: () => undefined,
      workflow: (operation) => {
        if (operation === 'models.catalogue') return { ok: true, value: [{ providerId: 'p', providerModelId: 'm', displayName: 'Model One', configured: true, goalUsable: true, modality: 'chat' }] };
        if (operation === 'budget.readiness') return { ok: true, value: NOT_APPROVED };
        return undefined;
      },
    });
    expect(byTestId(app.view, 'composer-blocked')?.textContent).toContain('预算为 0：还没有批准每个目标的花费上限');
    expect(app.button('发送')?.getAttribute('disabled')).not.toBeNull();
    await app.click('查看预算设置');
    expect(byTestId(app.view, 'settings-budget')?.textContent).toContain('预算为 0');
  });
  it('the App replaces a pinned image model with the configured chat model and says so', async () => {
    const policies: unknown[] = [];
    const app = await mountApp({
      control: () => undefined,
      workflow: (operation, payload) => {
        if (operation === 'models.catalogue') return { ok: true, value: USER_CATALOGUE };
        if (operation === 'models.list') return { ok: true, value: [REGISTERED_IMAGE] };
        if (operation === 'models.selection') return { ok: true, value: { resolvedModelKey: 'mdl_img' } };
        if (operation === 'models.register') return { ok: true, value: { modelKey: 'mdl_chat' } };
        if (operation === 'models.policy') {
          policies.push(payload);
          return { ok: true, value: {} };
        }
        if (operation === 'models.policy.explain') return { ok: true, value: { accepted: true, precedence: 'EXPLICIT_USER_CHOICE', reasons: [] } };
        if (operation === 'budget.readiness') return { ok: true, value: APPROVED };
        return undefined;
      },
    });
    await settle();
    expect(policies).toMatchObject([{ manualModelKey: 'mdl_chat' }]);
    expect(app.view.textContent).toContain('原来选择的「acc-image-v8.2-hd」不能执行目标，已改用首次配置的「chat-1」');
    expect(app.view.textContent).not.toContain('EXPLICIT_USER_CHOICE');
  });
});

describe('failures read as plain Chinese with the fix', () => {
  const failure = { runId: 'r', taskId: 't', attemptId: 'a', failureCode: 'POLICY_REFUSED', detailCode: 'GOAL_ADMISSION_BOUND_UNPROVEN', settledAt: null };
  it('POLICY_REFUSED + GOAL_ADMISSION_BOUND_UNPROVEN -> budget cause + budget remedy; bare POLICY_REFUSED is classified too', () => {
    expect(attemptFailureLabel(failure)).toBe('所选模型没有批准的预算（预算为 0），付费调用被拒绝');
    expect(failureRemedyOf(failure)).toBe('budget');
    expect(attemptFailureLabel({ ...failure, detailCode: null })).toBe('模型调用被公司规则拒绝（通常是预算未批准或模型不允许）');
    expect(attemptFailureLabel({ ...failure, failureCode: 'CAPABILITY_MISSING', detailCode: null })).toContain('所选模型不支持');
    expect(failureRemedyOf({ ...failure, failureCode: 'CAPABILITY_MISSING', detailCode: null })).toBe('model');
  });
  it('the conversation shows the cause and 查看预算设置; codes only inside 详情; no raw timeline as main text', () => {
    const workspace = {
      runId: 'run_01M746VR51DHKA5Z4BANBRB3C3', goal: { objective: '在吗' }, planningRun: { state: 'FAILED', revision: 3 },
      overview: { runId: 'run_01M746VR51DHKA5Z4BANBRB3C3', state: 'FAILED', revision: 3, reworkCount: 0, maxRework: 1, failureReason: 'execution_failed', terminalOutcome: 'FAILED', resumePoint: null, pinnedVersion: null, stages: [], executing: [], attempts: { active: 0, interrupted: 0, completed: 0, failed: 1 }, validation: { requiredValidatorIds: [], completed: [], failed: false, missing: [] }, correctiveActivity: null, handoffCount: 0, progress: { stagesTotal: 1, stagesTerminalSuccessful: 0, tasksTotal: 1, tasksDone: 0, tasksActive: 0, tasksBlocked: 0 }, artifacts: [{ id: 'art_1', kind: 'companyos:run-goal', taskId: null }] },
      blockers: [{ code: 'RUN_FAILED', scope: 'RUN', explanation: 'Run is FAILED (execution_failed).' }], executionRuns: [{ runId: 'run_exec', state: 'FAILED' }], attemptFailure: failure,
    };
    const timeline = [
      { key: 'k1', kind: 'run.transition', summary: 'IDLE → INITIALIZING (START)', occurredAt: '2026-11-11T02:26:00Z' },
      { key: 'k2', kind: 'event.run.snapshot_pinned', summary: 'run.snapshot_pinned', occurredAt: '2026-11-11T02:26:00Z' },
      { key: 'k3', kind: 'run.transition', summary: 'ROUTING → EXECUTING (ROUTE_RESOLVED)', occurredAt: '2026-11-11T02:26:00Z' },
    ];
    const html = renderToStaticMarkup(h(ChatView, {
      objective: '在吗', entries: projectConversation(workspace as never, '在吗', timeline), loading: false, failure: null,
      header: { stateWord: '失败', live: false, runId: workspace.runId, tasksText: '任务 0/1 完成', startedText: null }, onRemedy: () => {},
    }));
    const main = html.replace(/<details[\s\S]*?<\/details>/gu, '').replace(/title="[^"]*"/gu, '');
    expect(main).toContain('目标失败 · 所选模型没有批准的预算（预算为 0），付费调用被拒绝');
    expect(main).toContain('查看预算设置');
    expect(main).toContain('开始运行');
    expect(main).toContain('已锁定本次运行的配置');
    expect(main).toContain('产物 · 目标记录');
    for (const raw of ['POLICY_REFUSED', 'run.transition', 'IDLE →', 'run_01M746VR51DHKA5Z4BANBRB3C3', 'companyos:run-goal', '未归类']) expect(main).not.toContain(raw);
    expect(html).toContain('技术记录 · 3 条');
    expect(html).toMatch(/<summary>详情<\/summary><code class="tech__code">[^<]*POLICY_REFUSED/u);
  });
  it('plain activity folds duplicates and keeps unknown kinds technical only', () => {
    expect(plainActivity([
      { key: 'a', kind: 'artifact.created', summary: 'x' },
      { key: 'b', kind: 'artifact.created', summary: 'y' },
      { key: 'c', kind: 'event.something.internal', summary: 'z' },
      { key: 'd', kind: 'executionattempt.settled', summary: 'Attempt 1 settled FAILED' },
    ]).map((line) => line.text)).toEqual(['生成了产物', '任务的一次执行失败']);
  });
  it('the runtime panel: a zero budget reads 未批准预算 with the fix, the remedy button sits with the blockers', () => {
    const html = renderToStaticMarkup(h(RuntimePanelView, {
      open: true, expanded: true, tab: 'run', lifecycle: null, artifacts: [], timeline: [], taskDetail: null,
      blockers: [{ code: 'RUN_FAILED', scope: 'RUN', explanation: 'Run is FAILED (execution_failed).' }], attemptFailure: failure, pendingApproval: null,
      budget: { budget: { state: 'ZERO_COST_POLICY', currency: null, cap: { calls: 4, tokens: 32768, costMicros: 0, deadlineMs: 1 }, settled: { calls: 0, tokens: 0, costMicros: 0 }, unknown: { calls: 0, tokens: 0, costMicros: 0 }, held: { calls: 0, tokens: 0, costMicros: 0 }, reconciled: { calls: 0, tokens: 0, costMicros: 0 }, remaining: { calls: 4, tokens: 32768, costMicros: 0 }, worstCaseCostMicros: 0 }, plan: null },
      onToggleExpanded: () => {}, onSelectTab: () => {}, onSelectTask: () => {}, onRemedy: () => {},
    } as never));
    expect(html).toContain('/ 未批准预算');
    expect(html).not.toContain('0.00 单位');
    expect(html).toContain('查看预算设置');
    expect(html).not.toContain('部署未声明币种');
  });
  it('budget rows explain the zero cap instead of the currency', () => {
    const rows = budgetRows({ state: 'ZERO_COST_POLICY', currency: null, cap: null, settled: { calls: 0, tokens: 0, costMicros: 0 }, unknown: { calls: 0, tokens: 0, costMicros: 0 }, held: { calls: 0, tokens: 0, costMicros: 0 }, reconciled: { calls: 0, tokens: 0, costMicros: 0 }, remaining: null, worstCaseCostMicros: 0 });
    expect(rows.join('\n')).toContain('CompanyOS 首次配置');
  });
  it('a typed failure line shows plain text; the code is behind 详情', () => {
    const html = renderToStaticMarkup(h(TypedErrorLine, { failure: { code: 'IPC_FAILED', message: 'socket hang up' } }));
    expect(html.replace(/<details[\s\S]*?<\/details>/gu, '')).not.toContain('IPC_FAILED');
    expect(html).toContain('操作没有完成');
    expect(html).toContain('IPC_FAILED · socket hang up');
  });
});

describe('settings manage which models can run Goals, and show the budget', () => {
  it('lists the Goal models, offers chat models to add, lists non-chat models as not usable', () => {
    const options: readonly ModelOptionRow[] = toModelOptionRows(USER_CATALOGUE, []);
    const html = renderToStaticMarkup(h(SettingsView, {
      workspaceRoot: 'F:\\kongjian', modelStatus: { kind: 'selected', modelKey: 'mdl_chat', displayName: 'chat-1' }, catalogueCount: 5, registeredCount: 0,
      appVersion: '0.1.4', databasePath: null, schemaVersion: null, allowedChannels: [], models: options, budgetReadiness: APPROVED,
    }));
    expect(html).toContain('执行目标只会使用下面这些模型');
    expect(html).toContain('从模型服务添加对话模型（1 个可添加）');
    expect(html).toContain('qwen-max');
    expect(html).toContain('不能执行目标的模型（3 个');
    expect(html).toContain('acc-image-v8.2-hd · 图像模型');
    expect(html).toContain('每个目标最多花费 ¥5.00（首次配置设置）');
    expect(html).toContain('2 = 其他 OpenAI 兼容服务');
  });
  it('budget lines: none approved says 预算为 0', () => {
    expect(budgetSettingsLines(NOT_APPROVED)[0]).toContain('预算为 0');
    expect(budgetSettingsLines(null)).toEqual(['预算状态读取中…']);
  });
});

describe('UI-AUDIT-2 — follow-up items (raw ids out of the main text)', () => {
  it('approval requester reads as words; the raw actor id stays out', () => {
    expect(actorWord('system:dsh-executor')).toBe('执行器（代码执行）');
    expect(actorWord('engine.driver')).toBe('系统');
    expect(actorWord('agent.review')).toBe('AI 员工');
    expect(actorWord('user:local')).toBe('你');
    expect(actorWord('')).toBe('--');
  });

  it('runtime model row shows the model the goal ran on, not the company default', () => {
    const lifecycle = {
      tasks: [
        { modelKey: 'model.deepseek:deepseek-chat' },
        { modelKey: 'model.deepseek:deepseek-chat' },
        { modelKey: null },
        { modelKey: 'model.custom:qwen-plus' },
      ],
    } as unknown as Parameters<typeof goalRanModels>[0];
    expect(goalRanModels(lifecycle)).toEqual(['deepseek-chat', 'qwen-plus']);
    expect(goalRanModels(null)).toEqual([]);
  });
});
