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
  readonly items: readonly { readonly planItemId: string; readonly objective: string; readonly taskKind: string | null }[];
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
      items: (p['items'] as unknown[]).flatMap((i) => { const r = rec(i); return r === null ? [] : [{ planItemId: String(r['planItemId'] ?? ''), objective: String(r['objective'] ?? ''), taskKind: typeof r['taskKind'] === 'string' ? r['taskKind'] : null }]; }),
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
  if (view.cap !== null) rows.push(`上限 · ${m(view.cap.costMicros)} · ${String(view.cap.calls)} 次调用 · ${String(view.cap.tokens)} tokens`);
  rows.push(`已结算 · ${m(view.settled.costMicros)} · ${String(view.settled.calls)} 次 · ${String(view.settled.tokens)} tokens`);
  if (view.reconciled.calls > 0) rows.push(`其中运营者凭证对账 · ${String(view.reconciled.calls)} 次 · ${m(view.reconciled.costMicros)}`);
  if (view.unknown.calls > 0) rows.push(`未确认 · ${String(view.unknown.calls)} 次 · 最多 ${m(view.unknown.costMicros)}（不会自动重试）`);
  if (view.held.calls > 0) rows.push(`进行中预留 · ${String(view.held.calls)} 次 · 最多 ${m(view.held.costMicros)}`);
  if (view.remaining !== null) rows.push(`最坏情况下剩余 · ${m(view.remaining.costMicros)} · ${String(view.remaining.calls)} 次`);
  if (view.currency === null) rows.push('部署未声明币种，金额为原始单位');
  return rows;
};
