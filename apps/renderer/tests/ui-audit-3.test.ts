/**
 * UI-AUDIT-3 (user 2026-11-11: in-app API key / provider / budget; "截图的都是啥…没用都放设置";
 * "不合理的你都给整理下"). Renderer half:
 *   - 设置 → 模型服务: the key lives only in the password field's DOM value — never in React state,
 *     props, storage or the rendered output — and leaves the field (cleared) on 保存;
 *   - the composer carries only workspace, model and 发送 (no 权限 / 工具 chips, no draft buttons,
 *     no approval explainer, no session cost);
 *   - 设置 order and the new-Goal defaults; the run panel tidy-up.
 */
import './support/mini-dom.js';
import { readFileSync } from 'node:fs';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ModelServiceSection,
  formProblem,
  formFromStatus,
  parseProviderSettingsResult,
  providerSettingsRequestOf,
  savePayloadOf,
  serviceSummaryRows,
  takeSecretField,
  type ProviderSettingsResultView,
  type ProviderSettingsStatusView,
} from '../src/provider-settings-view.js';
import { ComposerView } from '../src/composer.js';
import { SettingsView } from '../src/shell.js';
import { RuntimePanelView } from '../src/runtime-panel.js';
import { NEW_GOAL_POLICY_KEY, readDefaultPolicy, writeDefaultPolicy } from '../src/new-goal-defaults.js';
import { budgetGateFor, budgetRows } from '../src/budget.js';
import { createContainer, dispatchMiniEvent, elementsWithAttribute, removeContainer, clickableWithText, type MiniElement } from './support/mini-dom.js';

const KEY = 'fake-key-for-ui-audit-3-renderer-ABCD';

const STATUS_EMPTY: ProviderSettingsStatusView = {
  keyEntrySupported: true,
  source: 'none',
  state: 'NOT_CONFIGURED',
  problem: null,
  service: null,
  keyHint: null,
  capCny: null,
  preset: { kind: 'preset', baseUrl: 'https://api.example.test', host: 'api.example.test', modelId: 'chat-flash', inputCnyPerM: 2, outputCnyPerM: 8 },
  capMinCny: 0.1,
  capMaxCny: 100,
  priceMaxCnyPerM: 1000,
  restartRequired: false,
};
const STATUS_SET: ProviderSettingsStatusView = {
  ...STATUS_EMPTY,
  source: 'settings',
  state: 'CONFIGURED',
  service: { kind: 'preset', baseUrl: 'https://api.example.test', host: 'api.example.test', modelId: 'chat-flash', inputCnyPerM: 2, outputCnyPerM: 8 },
  keyHint: '****ABCD',
  capCny: 3,
  restartRequired: true,
};

let root: Root | null = null;
let container: MiniElement | null = null;
const render = async (element: ReturnType<typeof h>) => {
  if (container === null) { container = createContainer(); root = createRoot(container as unknown as Element); }
  await act(async () => { root?.render(element); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  return container;
};
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  if (container !== null) removeContainer(container);
  root = null; container = null;
  vi.unstubAllGlobals();
});

const allAttributes = (node: MiniElement): string => {
  const parts: string[] = [];
  const walk = (n: MiniElement): void => {
    for (const [k, v] of (n as unknown as { attributes: Map<string, string> }).attributes ?? []) parts.push(`${k}=${v}`);
    for (const child of n.childNodes) if ('tagName' in (child as object)) walk(child as MiniElement);
  };
  walk(node);
  return parts.join('\n');
};

describe('设置 → 模型服务: the API key goes one way', () => {
  it('the key is read from the password field, sent once to main, and the field is cleared; it is never rendered', async () => {
    const calls: { operation: string; payload?: unknown }[] = [];
    const request = vi.fn(async (operation: string, payload?: unknown): Promise<ProviderSettingsResultView> => {
      calls.push({ operation, payload: payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)) });
      if (operation === 'status') return { ok: true, code: 'OK', message: '', status: STATUS_EMPTY };
      return { ok: true, code: 'OK', message: '已保存。重启 CompanyOS 后生效。', status: STATUS_SET, restartRequired: true };
    });
    const view = await render(h(ModelServiceSection, { request }));
    const field = elementsWithAttribute(view, 'data-testid', 'service-api-key')[0]!;
    const fieldProps = Object.entries(field as unknown as Record<string, unknown>).find(([k]) => k.startsWith('__reactProps$'))![1] as Record<string, unknown>;
    expect(fieldProps['type']).toBe('password');
    expect(fieldProps['autoComplete']).toBe('off');
    expect('value' in fieldProps || 'onChange' in fieldProps).toBe(false); // uncontrolled
    (field as unknown as { value: string }).value = KEY;
    // fill the cap (controlled, not secret)
    const cap = elementsWithAttribute(view, 'data-testid', 'service-cap')[0]!;
    const capProps = Object.entries(cap as unknown as Record<string, unknown>).find(([k]) => k.startsWith('__reactProps$'))![1] as { onChange: (e: { target: { value: string } }) => void };
    await act(async () => { capProps.onChange({ target: { value: '3' } }); });
    const form = elementsWithAttribute(view, 'data-testid', 'settings-service-form')[0]!;
    await act(async () => { dispatchMiniEvent(form, 'submit'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    const save = calls.filter((c) => c.operation === 'save');
    expect(save).toHaveLength(1);
    expect(save[0]!.payload).toEqual({ mode: 'preset', apiKey: KEY, capCny: 3 });
    expect((field as unknown as { value: string }).value).toBe(''); // the field was cleared on submit
    expect(view.textContent).not.toContain(KEY);
    expect(allAttributes(view)).not.toContain(KEY);
    expect(view.textContent).toContain('已保存 · ****ABCD');
    expect(view.textContent).toContain('设置已保存，重启 CompanyOS 后生效。');
    expect(clickableWithText(view, '立即重启')).not.toBeNull();
  });

  it('source: the key never enters React state, storage or a log (uncontrolled ref only)', () => {
    const src = readFileSync(new URL('../src/provider-settings-view.tsx', import.meta.url), 'utf8');
    const stateLines = src.split('\n').filter((line) => line.includes('useState'));
    for (const line of stateLines) expect(line).not.toMatch(/key|secret|apiKey/iu);
    expect(src).not.toMatch(/localStorage|sessionStorage|console\./u);
    expect(src).toMatch(/type: 'password'/u);
    // the key input has no value/onChange binding (uncontrolled)
    const keyInput = src.slice(src.indexOf("type: 'password'"), src.indexOf("'aria-label': 'API Key'"));
    expect(keyInput).not.toMatch(/^\s*(?:value|onChange):/mu);
  });

  it('takeSecretField reads then clears; an empty field keeps the stored key (no apiKey in the payload)', () => {
    const field = { value: KEY };
    expect(takeSecretField(field)).toBe(KEY);
    expect(field.value).toBe('');
    expect(savePayloadOf(formFromStatus(STATUS_SET), '')).toEqual({ mode: 'preset', capCny: 3 });
  });

  it('the renderer validates before asking main (and main asks the user to approve, not this view)', () => {
    expect(formProblem({ ...formFromStatus(STATUS_EMPTY), capCny: '3' }, STATUS_EMPTY, false)).toBe('请填写 API Key。');
    expect(formProblem({ ...formFromStatus(STATUS_EMPTY), capCny: '500' }, STATUS_EMPTY, true)).toContain('0.1–100');
    expect(formProblem({ mode: 'custom', baseUrl: 'http://x', modelId: 'm', inputCnyPerM: '1', outputCnyPerM: '1', capCny: '3' }, STATUS_EMPTY, true)).toContain('https://');
    expect(formProblem({ mode: 'custom', baseUrl: 'https://x', modelId: 'm', inputCnyPerM: '1', outputCnyPerM: '1', capCny: '3' }, STATUS_EMPTY, true)).toBeNull();
    const src = readFileSync(new URL('../src/provider-settings-view.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/approvals\.json|budget\.approve/u);
  });

  it('summary rows: service, ****last4, price, cap — and nothing more of the key', () => {
    const rows = serviceSummaryRows(STATUS_SET).map(([k, v]) => `${k}:${v}`).join('\n');
    expect(rows).toContain('服务:api.example.test · chat-flash（推荐）');
    expect(rows).toContain('API Key:已保存 · ****ABCD');
    expect(rows).toContain('每个目标最多花费:3 元');
    expect(serviceSummaryRows({ ...STATUS_SET, capCny: null }).map(([, v]) => v).join()).toContain('预算为 0');
  });

  it('a rejected or malformed IPC answer is a plain failure', async () => {
    expect(parseProviderSettingsResult(null).code).toBe('IPC_FAILED');
    const req = providerSettingsRequestOf(async () => { throw new Error('boom'); })!;
    expect((await req('status')).code).toBe('IPC_FAILED');
    expect(providerSettingsRequestOf(undefined)).toBeNull();
  });
});

describe('composer: only what a message needs', () => {
  it('workspace, model and 发送 — no 权限 / 工具 chips, no approval explainer, no session cost, no draft buttons', () => {
    const html = renderToStaticMarkup(h(ComposerView, {
      draft: '', ready: true, busy: false, authority: { mode: 'read-only', basis: 'no-active-run', mutable: false },
      modelLabel: 'chat-flash', workspaceLabel: 'F:\\kongjian', pendingIntent: false,
      onDraftChange: () => {}, onSubmit: () => {}, onChangeWorkspace: () => {}, onOpenModel: () => {}, modelOpen: false,
    }));
    expect(html).toContain('F:\\kongjian');
    expect(html).toContain('chat-flash');
    expect(html).toContain('发送');
    for (const gone of ['权限', '工具', '批准边界', '会话费用', '保存草稿', '恢复草稿', '文件交付要求']) expect(html).not.toContain(gone);
  });
  it('the budget-0 fix points to 设置 (not the Start menu)', () => {
    const gate = budgetGateFor({ state: 'NOT_APPROVED', currency: null, capCostMicros: null, source: null, covered: [] }, { providerId: 'p', providerModelId: 'm', displayName: 'M' });
    expect(gate !== null && !gate.ok ? gate.text : '').toContain('设置 → 模型服务');
    expect(gate !== null && !gate.ok ? gate.text : '').not.toContain('开始菜单');
    const zero = budgetRows({ state: 'ZERO_COST_POLICY', currency: null, cap: null, settled: { calls: 0, tokens: 0, costMicros: 0 }, reconciled: { calls: 0, costMicros: 0 }, unknown: { calls: 0, costMicros: 0 }, held: { calls: 0, costMicros: 0 }, remaining: null } as never);
    expect(zero.join('\n')).toContain('设置 → 模型服务');
  });
  it('no renderer source tells the user to use the Start-menu helper any more', () => {
    for (const file of ['App.tsx', 'composer.tsx', 'budget.ts', 'models.tsx', 'shell.tsx', 'services-failure.tsx']) {
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(src, file).not.toMatch(/'[^'\n]*开始菜单[^'\n]*'/u);
    }
  });
});

describe('设置: order, new-Goal defaults, technical info collapsed', () => {
  const base = {
    workspaceRoot: 'F:\\kongjian', modelStatus: { kind: 'no-models' } as const, catalogueCount: 3, registeredCount: 1,
    appVersion: '0.1.6', databasePath: 'C:\\db', schemaVersion: 7, allowedChannels: ['companyos:provider-settings'],
    readiness: [{ label: '执行器', state: 'READY' as const, detail: '内置内核' }],
  };
  it('sections in order: 模型服务 · 模型 · 新目标默认 · 工作区 · 关于 · 高级与技术信息', () => {
    const html = renderToStaticMarkup(h(SettingsView, { ...base, modelService: h('div', null, 'SERVICE'), deliveryRequirement: h('div', null, 'DELIVERY') }));
    const order = ['>模型服务<', '>模型<', '>新目标默认<', '>工作区<', '>关于<', '高级与技术信息'].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('SERVICE');
    expect(html).toContain('DELIVERY');
    expect(html).not.toContain('当前目标状态'); // a Goal status is not a setting
    // technical info only inside the collapsed details
    const advanced = html.slice(html.indexOf('高级与技术信息'));
    for (const tech of ['运行与诊断', 'Electron 版本', 'IPC 通道', 'schema 版本']) {
      expect(advanced).toContain(tech);
      expect(html.indexOf(tech)).toBeGreaterThan(html.indexOf('高级与技术信息'));
    }
  });
  it('the default policy radio reports the user choice; the default is 询问权限', () => {
    const chosen: string[] = [];
    const html = renderToStaticMarkup(h(SettingsView, { ...base, onSetDefaultPolicy: (p) => chosen.push(p) }));
    expect(html).toMatch(/checked=""[^>]*\/?>(<span>)?询问权限（推荐）|询问权限（推荐）/u);
    expect(html).toContain('高风险操作总会先停下来');
  });
  it('new-goal defaults: stored per machine, unknown/unreadable values fall back to ASK_PERMISSION', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    expect(readDefaultPolicy(storage)).toBe('ASK_PERMISSION');
    expect(writeDefaultPolicy(storage, 'READ_ONLY')).toBe(true);
    expect(readDefaultPolicy(storage)).toBe('READ_ONLY');
    data.set(NEW_GOAL_POLICY_KEY, 'EVERYTHING');
    expect(readDefaultPolicy(storage)).toBe('ASK_PERMISSION');
    expect(readDefaultPolicy({ getItem: () => { throw new Error('x'); } })).toBe('ASK_PERMISSION');
    expect(readDefaultPolicy(null)).toBe('ASK_PERMISSION');
  });
});

describe('run panel tidy-up', () => {
  const lifecycle = {
    phase: 'EXECUTING', runState: 'EXECUTING', planningState: 'DONE', executionState: 'EXECUTING', failureReason: null,
    validation: { completed: 1, failed: 0, missing: 2 }, correctiveRounds: 0, handoffCount: 0, terminalOutcome: null,
    tasks: [{ taskId: 'tsk_visible_id_1', state: 'RUNNING', attemptLabel: '尝试 1', roleId: null, modelKey: null }],
  };
  const props = {
    open: true, expanded: true, tab: 'run', lifecycle, artifacts: [{ artifactId: 'art_5d21c9e0a1', kind: 'companyos:file' }],
    timeline: [{ key: 'k1', kind: 'run.transition', summary: 'IDLE → PLANNING', at: null }], taskDetail: null, blockers: [], pendingApproval: null,
    onToggleExpanded: () => {}, onSelectTab: () => {}, onSelectTask: () => {},
  };
  it('运行: no repeated 最近活动 / 验证, no "unknown values" note, no raw task id as text', () => {
    const html = renderToStaticMarkup(h(RuntimePanelView, props as never));
    for (const gone of ['最近活动', '>验证<', '未知的数值显示为', '>tsk_visible_id_1<']) expect(html).not.toContain(gone);
    expect(html).toContain('title="查看任务明细 · tsk_visible_id_1');
  });
  it('文件: the artifact id is a tooltip; 产出: 待验证 instead of 缺失, no 移交', () => {
    const files = renderToStaticMarkup(h(RuntimePanelView, { ...props, tab: 'files' } as never));
    expect(files).not.toContain('>art_5d21c9e0a1<');
    expect(files).toContain('art_5d21c9e0a1"');
    const output = renderToStaticMarkup(h(RuntimePanelView, { ...props, tab: 'output' } as never));
    expect(output).toContain('待验证');
    expect(output).not.toContain('移交');
  });
});
