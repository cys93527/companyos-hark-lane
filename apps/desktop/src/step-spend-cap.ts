/**
 * LIVE-CONTRACT-FILL run 6 (hark-live-goal 42385697784) — per-step spend cap.
 *
 * One step (task) burned CNY 6.5 of the CNY 8 run across three failing attempts before the
 * goal stopped. A step now has its own share of the goal's money cap (default 35%,
 * COS_STEP_SPEND_CAP_RATIO): a model call is admitted only while the step's spend (settled
 * KNOWN cost + the bound of every still-open or UNKNOWN call) plus this call's bound fits the
 * share. A step at its share is a STANDING block (GOAL_STEP_SPEND_CAP_REACHED) with a reason
 * the boss sees, never a silent drain of the whole run. Pure over the durable ledger.
 */
import type { BudgetReservation } from '@companyos/core';

export const STEP_SPEND_CAP_REACHED = 'GOAL_STEP_SPEND_CAP_REACHED' as const;
export const DEFAULT_STEP_SPEND_CAP_RATIO = 0.35;

/** A ratio in (0, 1]; anything else (absent, NaN, <= 0, > 1) falls back to the default. */
export const stepSpendCapRatioOf = (raw: string | number | undefined | null): number => {
  const value = typeof raw === 'number' ? raw : raw === undefined || raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : DEFAULT_STEP_SPEND_CAP_RATIO;
};

export const stepSpendCapMicros = (goalMaxCostMicros: number, ratio: number): number =>
  Math.max(0, Math.floor(goalMaxCostMicros * stepSpendCapRatioOf(ratio)));

/** Spend charged to the given attempts: KNOWN usage cost, otherwise the reserved bound. */
export const stepSpendMicros = (reservations: readonly BudgetReservation[], attemptIds: ReadonlySet<string>): number => {
  let total = 0;
  for (const reservation of reservations) {
    if (!attemptIds.has(reservation.ownerId)) continue;
    total += reservation.status === 'KNOWN' && reservation.usage !== null ? reservation.usage.costMicros : reservation.bound.costMicros;
  }
  return total;
};

/** True when the step cannot admit one more call of `nextBoundMicros` within its cap. */
export const stepCapReached = (spentMicros: number, nextBoundMicros: number, capMicros: number): boolean =>
  capMicros > 0 && spentMicros + nextBoundMicros > capMicros;

/**
 * The goal-level standing check: an unfinished step whose spend leaves no room for one more
 * call at the largest bound this goal has reserved. Returns that step's id, else null.
 */
export const stepAtSpendCap = (input: {
  readonly reservations: readonly BudgetReservation[];
  /** attempt id -> its task id and the task's state. */
  readonly attempts: ReadonlyMap<string, { readonly taskId: string; readonly taskState: string }>;
  readonly capMicros: number;
}): string | null => {
  if (input.capMicros <= 0 || input.reservations.length === 0) return null;
  const nextBound = Math.max(...input.reservations.map((reservation) => reservation.bound.costMicros));
  const byTask = new Map<string, Set<string>>();
  for (const [attemptId, attempt] of input.attempts) {
    if (attempt.taskState === 'DONE' || attempt.taskState === 'SKIPPED' || attempt.taskState === 'CANCELLED') continue;
    const set = byTask.get(attempt.taskId) ?? new Set<string>();
    set.add(attemptId);
    byTask.set(attempt.taskId, set);
  }
  for (const [taskId, attemptIds] of [...byTask.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (stepCapReached(stepSpendMicros(input.reservations, attemptIds), nextBound, input.capMicros)) return taskId;
  }
  return null;
};
