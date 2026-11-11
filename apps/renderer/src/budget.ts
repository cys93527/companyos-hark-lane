/**
 * H11 — the boss's budget / spend / previewed-plan read model.
 *
 * Reads the main-process `run.budget` projection (durable admission facts, never
 * re-derived here). Display rules:
 *   - settled spend is shown exactly (KNOWN);
 *   - UNKNOWN calls are shown as "up to <bound>" and never as zero, never as settled;
 *   - remaining is the worst-case allowance the main process computed;
 *   - a read failure renders nothing rather than a guessed number.
 */
import type { ControlPlaneBridge } from './workspace.js';

export type BudgetCurrency = 'USD' | 'CNY' | 'EUR' | 'CREDIT';

interface Bucket { readonly calls: number; readonly tokens: number; readonly costMicros: number }

export interface GoalBudgetView {
  readonly state: 'NO_BUDGET' | 'ZERO_COST_POLICY' | 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  readonly currency: BudgetCurrency | null;
  readonly cap: (Bucket & { readonly deadlineMs: number }) | null;
  readonly settled: Bucket;
  readonly unknown: Bucket;
  readonly held: Bucket;
  /** H12c: part of `settled` the operator reconciled from UNKNOWN (absent in older payloads = 0). */
  readonly reconciled: Bucket;
  readonly remaining: Bucket | null;
  readonly worstCaseCostMicros: number;
}

export interface PreviewPlanView {
  readonly artifactId: string;
  readonly items: readonly { readonly planItemId: string; readonly objective: string; readonly taskKind: string | null; readonly stageId: string | null }[];
  readonly criteria: readonly { readonly criterionId: string; readonly requirement: string }[];
}

export interface GoalBudgetRead {
  readonly budget: GoalBudgetView;
  readonly plan: PreviewPlanView | null;
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const bucket = (v: unknown): Bucket | null => {
  const r = rec(v);
  if (r === null) return null;
  const calls = n(r['calls']); const tokens = n(r['tokens']); const costMicros = n(r['costMicros']);
  return calls === null || tokens === null || costMicros === null ? null : { calls, tokens, costMicros };
};
const STATES = ['NO_BUDGET', 'ZERO_COST_POLICY', 'ACTIVE', 'CANCELLED', 'EXPIRED'] as const;
const CURRENCIES = ['USD', 'CNY', 'EUR', 'CREDIT'] as const;

/** Strict parse: any malformed field => null (render nothing, never a guess). */
export const parseGoalBudgetRead = (value: unknown): GoalBudgetRead | null => {
  const root = rec(value);
  const b = rec(root?.['budget']);
  if (root === null || b === null) return null;
  const state = STATES.find((s) => s === b['state']);
  const currency = b['currency'] === null ? null : CURRENCIES.find((c) => c === b['currency']);
  const settled = bucket(b['settled']); const unknown = bucket(b['unknown']); const held = bucket(b['held']);
  const reconciled = b['reconciled'] === undefined ? { calls: 0, tokens: 0, costMicros: 0 } : bucket(b['reconciled']);
  const remaining = b['remaining'] === null ? null : bucket(b['remaining']);
  const capRaw = rec(b['cap']);
  const capBucket = capRaw === null ? null : bucket(capRaw);
  const deadlineMs = capRaw === null ? null : n(capRaw['deadlineMs']);
  const worst = n(b['worstCaseCostMicros']);
  if (state === undefined || currency === undefined || settled === null || unknown === null || held === null || reconciled === null
    || (b['remaining'] !== null && remaining === null) || (capRaw !== null && (capBucket === null || deadlineMs === null)) || worst === null) return null;
  const p = rec(root['plan']);
  let plan: PreviewPlanView | null = null;
  if (p !== null && typeof p['artifactId'] === 'string' && Array.isArray(p['items']) && Array.isArray(p['criteria'])) {
    plan = {
      artifactId: p['artifactId'],
      items: (p['items'] as unknown[]).flatMap((i) => { const r = rec(i); return r === null ? [] : [{ planItemId: String(r['planItemId'] ?? ''), objective: String(r['objective'] ?? ''), taskKind: typeof r['taskKind'] === 'string' ? r['taskKind'] : null, stageId: typeof r['stageId'] === 'string' && r['stageId'] !== '' ? r['stageId'] : null }]; }),
      criteria: (p['criteria'] as unknown[]).flatMap((c) => { const r = rec(c); return r === null ? [] : [{ criterionId: String(r['criterionId'] ?? ''), requirement: String(r['requirement'] ?? '') }]; }),
    };
  }
  return {
    budget: { state, currency, cap: capBucket === null || deadlineMs === null ? null : { ...capBucket, deadlineMs }, settled, unknown, held, reconciled, remaining, worstCaseCostMicros: worst },
    plan,
  };
};

export const loadGoalBudget = async (bridge: ControlPlaneBridge, runId: string | null): Promise<GoalBudgetRead | null> => {
  if (runId === null) return null;
  const response = (await bridge.controlPlaneRequest({ operation: 'run.budget', payload: { companyId: 'company_default', runId } })) as { readonly ok: boolean; readonly value?: unknown };
  return response.ok ? parseGoalBudgetRead(response.value) : null;
};

export const formatMoney = (micros: number, currency: BudgetCurrency | null): string => {
  const value = (micros / 1_000_000).toFixed(6).replace(/0{1,4}$/u, '');
  if (currency === null) return `${value} 单位`;
  if (currency === 'CREDIT') return `${value} 点`;
  return `${currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '€'}${value}`;
};

const STATE_LABEL: Record<GoalBudgetView['state'], string> = {
  NO_BUDGET: '未设预算（不会调用付费模型）',
  ZERO_COST_POLICY: '预算为 0（付费调用被拒绝）',
  ACTIVE: '预算生效中',
  CANCELLED: '已取消（不再调用）',
  EXPIRED: '预算时间窗已过（不再调用）',
};

/** The rows the runtime panel shows, in order. Pure — tested without a DOM. */
export const budgetRows = (view: GoalBudgetView): readonly string[] => {
  const m = (x: number): string => formatMoney(x, view.currency);
  const rows = [`费用 · ${STATE_LABEL[view.state]}`];
  // UI-AUDIT-2: a zero cap (no budget approved) is said once in words, not as "0.00 单位" amounts.
  const zero = view.state === 'ZERO_COST_POLICY';
  if (view.cap !== null && !zero) rows.push(`上限 · ${m(view.cap.costMicros)} · ${String(view.cap.calls)} 次调用 · ${String(view.cap.tokens)} tokens`);
  rows.push(zero && view.settled.costMicros === 0
    ? `已结算 · ${String(view.settled.calls)} 次调用`
    : `已结算 · ${m(view.settled.costMicros)} · ${String(view.settled.calls)} 次 · ${String(view.settled.tokens)} tokens`);
  if (view.reconciled.calls > 0) rows.push(`其中运营者凭证对账 · ${String(view.reconciled.calls)} 次 · ${m(view.reconciled.costMicros)}`);
  if (view.unknown.calls > 0) rows.push(`未确认 · ${String(view.unknown.calls)} 次 · 最多 ${m(view.unknown.costMicros)}（不会自动重试）`);
  if (view.held.calls > 0) rows.push(`进行中预留 · ${String(view.held.calls)} 次 · 最多 ${m(view.held.costMicros)}`);
  if (view.remaining !== null && !zero) rows.push(`最坏情况下剩余 · ${m(view.remaining.costMicros)} · ${String(view.remaining.calls)} 次`);
  // UI-AUDIT-2: a zero cap is the fail-closed default (no budget approved), not a currency question.
  if (view.state === 'ZERO_COST_POLICY') rows.push('怎么解决 · 在开始菜单运行「CompanyOS 首次配置」设置每个目标的预算，然后重新打开 CompanyOS');
  else if (view.currency === null) rows.push('未声明币种，金额按原始单位显示');
  return rows;
};

/* ------------------------------------------------- UI-AUDIT-2: budget before send --- */

/**
 * UI-AUDIT-2 (user report 2026-11-11): the boss learned "预算为 0（付费调用被拒绝）" only
 * from a FAILED Goal. Main's `budget.readiness` says, before anything is sent, whether a
 * per-Goal cap is approved and which (provider, model) pairs it covers; a Goal on a model
 * with no approved budget is refused at its first paid call, so Send is blocked with the
 * reason and the fix instead.
 */
export interface BudgetReadiness {
  readonly state: 'APPROVED' | 'NOT_APPROVED' | 'RESTART_REQUIRED';
  readonly currency: BudgetCurrency | null;
  readonly capCostMicros: number | null;
  readonly source: 'provider-setup' | 'operator' | null;
  readonly covered: readonly { readonly providerId: string; readonly modelId: string; readonly validUntilMs: number; readonly valid: boolean }[];
}

/** Strict parse; anything malformed => null (unknown: nothing is blocked on a guess). */
export const parseBudgetReadiness = (value: unknown): BudgetReadiness | null => {
  const r = rec(value);
  if (r === null) return null;
  const state = (['APPROVED', 'NOT_APPROVED', 'RESTART_REQUIRED'] as const).find((s) => s === r['state']);
  const currency = r['currency'] === null ? null : CURRENCIES.find((c) => c === r['currency']);
  const cap = r['capCostMicros'] === null ? null : n(r['capCostMicros']);
  const source = r['source'] === null ? null : (['provider-setup', 'operator'] as const).find((s) => s === r['source']);
  if (state === undefined || currency === undefined || (r['capCostMicros'] !== null && cap === null) || source === undefined || !Array.isArray(r['covered'])) return null;
  const covered = (r['covered'] as unknown[]).flatMap((entry) => {
    const c = rec(entry);
    if (c === null || typeof c['providerId'] !== 'string' || typeof c['modelId'] !== 'string' || n(c['validUntilMs']) === null || typeof c['valid'] !== 'boolean') return [];
    return [{ providerId: c['providerId'], modelId: c['modelId'], validUntilMs: c['validUntilMs'] as number, valid: c['valid'] }];
  });
  return { state, currency, capCostMicros: cap, source, covered };
};

export const loadBudgetReadiness = async (bridge: { readonly workflowRequest: (request: { readonly operation: string; readonly payload?: unknown }) => Promise<unknown> }): Promise<BudgetReadiness | null> => {
  const response = (await bridge.workflowRequest({ operation: 'budget.readiness' })) as { readonly ok?: boolean; readonly value?: unknown } | null;
  return response?.ok === true ? parseBudgetReadiness(response.value) : null;
};

export type BudgetGate =
  | { readonly ok: true; readonly capText: string | null }
  | { readonly ok: false; readonly kind: 'NOT_APPROVED' | 'NOT_COVERED' | 'EXPIRED' | 'RESTART_REQUIRED'; readonly text: string; readonly short: string };

const SETUP_HINT = '在开始菜单运行「CompanyOS 首次配置」设置每个目标的预算，完成后重新打开 CompanyOS。';

/** Can a Goal on this (provider, model) spend money at all? `null` readiness = unknown = not blocked. */
export const budgetGateFor = (
  readiness: BudgetReadiness | null,
  model: { readonly providerId: string; readonly providerModelId: string; readonly displayName: string } | null,
): BudgetGate | null => {
  if (readiness === null || model === null) return null;
  if (readiness.state === 'NOT_APPROVED') {
    return { ok: false, kind: 'NOT_APPROVED', short: '预算为 0', text: `预算为 0：还没有批准每个目标的花费上限，发送后所有付费模型调用都会被拒绝。${SETUP_HINT}` };
  }
  const match = readiness.covered.filter((entry) => entry.providerId === model.providerId && entry.modelId === model.providerModelId);
  if (match.length === 0) {
    return { ok: false, kind: 'NOT_COVERED', short: '未批准预算', text: `「${model.displayName}」没有批准的预算（预算只对首次配置时填写的模型生效），发送后付费调用会被拒绝。请改用已批准预算的模型，或${SETUP_HINT}` };
  }
  if (!match.some((entry) => entry.valid)) {
    return { ok: false, kind: 'EXPIRED', short: '预算已过期', text: `「${model.displayName}」的价格确认已过期（30 天有效），付费调用会被拒绝。${SETUP_HINT}` };
  }
  if (readiness.state === 'RESTART_REQUIRED') {
    return { ok: false, kind: 'RESTART_REQUIRED', short: '重启后生效', text: '预算已设置，但要重新打开 CompanyOS 后才生效。' };
  }
  return { ok: true, capText: readiness.capCostMicros === null ? null : `每个目标上限 ${formatMoney(readiness.capCostMicros, readiness.currency)}` };
};
