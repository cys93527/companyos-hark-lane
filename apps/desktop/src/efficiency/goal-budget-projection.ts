/**
 * H11 — the read-only Goal BUDGET projection (boss view of spend, never an admission path).
 *
 * Derived ONLY from the durable GoalExecutionBudget (the same facts admission reads):
 *   - KNOWN reservations count their settled usage exactly;
 *   - UNKNOWN reservations are NEVER shown as spent-zero: they count at their full trusted
 *     bound and are listed separately ("may have been charged up to");
 *   - RESERVED (in flight) count at their bound as held;
 *   - remaining is the WORST-CASE allowance (cap - known - unknown bound - held bound),
 *     exactly what admission would still allow; never negative.
 * Currency comes from the trusted proof source of the deployment; absent => null (the UI
 * then shows raw micro-units and says so). Nothing here is guessed.
 */
import type { GoalExecutionBudget } from '@companyos/core';

export type BudgetCurrency = 'USD' | 'CNY' | 'EUR' | 'CREDIT';

export interface GoalBudgetBucket {
  readonly calls: number;
  readonly tokens: number;
  readonly costMicros: number;
}

export interface GoalBudgetProjection {
  readonly state: 'NO_BUDGET' | 'ZERO_COST_POLICY' | 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  readonly goalRunId: string;
  readonly currency: BudgetCurrency | null;
  readonly cap: GoalBudgetBucket & { readonly deadlineMs: number } | null;
  readonly settled: GoalBudgetBucket;
  /** Calls whose charge is not proven; counted at their trusted upper bound. */
  readonly unknown: GoalBudgetBucket;
  /** In-flight reservations held at their bound. */
  readonly held: GoalBudgetBucket;
  readonly remaining: GoalBudgetBucket | null;
  /** Worst-case total that may have been or may be charged so far (settled + unknown + held). */
  readonly worstCaseCostMicros: number;
  /** Plain-language notes for the boss; each corresponds to one fact above. */
  readonly notes: readonly string[];
}

const empty = (): { calls: number; tokens: number; costMicros: number } => ({ calls: 0, tokens: 0, costMicros: 0 });

export const projectGoalBudget = (
  goalRunId: string,
  budget: GoalExecutionBudget | null,
  options: { readonly nowMs: number; readonly currency?: BudgetCurrency | null },
): GoalBudgetProjection => {
  const currency = options.currency ?? null;
  const settled = empty();
  const unknown = empty();
  const held = empty();
  if (budget === null) {
    return {
      state: 'NO_BUDGET', goalRunId, currency, cap: null, settled, unknown, held, remaining: null, worstCaseCostMicros: 0,
      notes: ['No execution budget was initialised for this Goal; no model call can be admitted.'],
    };
  }
  for (const reservation of budget.reservations) {
    const boundTokens = reservation.bound.inputTokens + reservation.bound.outputTokens;
    if (reservation.status === 'KNOWN' && reservation.usage !== null) {
      settled.calls += 1; settled.tokens += reservation.usage.tokens; settled.costMicros += reservation.usage.costMicros;
    } else if (reservation.status === 'UNKNOWN') {
      unknown.calls += 1; unknown.tokens += boundTokens; unknown.costMicros += reservation.bound.costMicros;
    } else {
      held.calls += 1; held.tokens += boundTokens; held.costMicros += reservation.bound.costMicros;
    }
  }
  const policy = budget.policy;
  const cap = { calls: policy.maxCalls, tokens: policy.maxTokens, costMicros: policy.maxCostMicros, deadlineMs: policy.deadlineMs };
  const used = (key: 'calls' | 'tokens' | 'costMicros'): number => settled[key] + unknown[key] + held[key];
  const remaining = {
    calls: Math.max(0, cap.calls - used('calls')),
    tokens: Math.max(0, cap.tokens - used('tokens')),
    costMicros: Math.max(0, cap.costMicros - used('costMicros')),
  };
  const notes: string[] = [];
  let state: GoalBudgetProjection['state'] = 'ACTIVE';
  if (budget.cancellation !== null) { state = 'CANCELLED'; notes.push('The Goal was cancelled; no further calls are admitted.'); }
  else if (options.nowMs >= policy.deadlineMs) { state = 'EXPIRED'; notes.push('The budget window has expired; no further calls are admitted.'); }
  else if (policy.maxCostMicros === 0) { state = 'ZERO_COST_POLICY'; notes.push('The approved spend cap is zero: paid model calls are refused until a budget is approved.'); }
  if (unknown.calls > 0) {
    notes.push(`${String(unknown.calls)} call(s) have an unproven charge; they are counted at their approved upper bound and are never replayed automatically.`);
  }
  if (currency === null) notes.push('The deployment did not declare a currency; amounts are raw micro-units.');
  return {
    state, goalRunId, currency, cap, settled, unknown, held, remaining,
    worstCaseCostMicros: used('costMicros'),
    notes,
  };
};

/** Format micro-units for display (6 decimals trimmed to at least 2). */
export const formatMicros = (micros: number, currency: BudgetCurrency | null): string => {
  const value = (micros / 1_000_000).toFixed(6).replace(/0{1,4}$/u, '');
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '';
  return currency === null ? `${value} units` : currency === 'CREDIT' ? `${value} credits` : `${symbol}${value}`;
};
