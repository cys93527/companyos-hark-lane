import { domainError, type CostAdmissionBound, type ExecutionBudgetStore, type GoalBudgetPolicy, type GoalExecutionBudget } from '@companyos/core';

const refuse = (reason: string): never => { throw domainError('POLICY_DENIED', 'External dispatch admission was refused.', { reason, retryable: false }); };
const integer = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** ADR-A: the existing durable admission authority extended to a Goal-wide envelope. */
export function createGoalExecutionBudget(store: ExecutionBudgetStore, now: () => number) {
  const readRequired = async (runId: string): Promise<GoalExecutionBudget> => {
    const goalRunId = await store.goalOf(runId);
    if (goalRunId === null) return refuse('GOAL_BUDGET_NOT_BOUND');
    const state = await store.read(goalRunId);
    if (state === null) return refuse('GOAL_BUDGET_NOT_CONFIGURED');
    return state;
  };
  const available = (state: GoalExecutionBudget): void => {
    if (state.cancellation !== null) refuse('GOAL_CANCEL_REQUESTED');
    if (now() >= state.policy.deadlineMs) refuse('GOAL_DEADLINE_EXCEEDED');
    if (state.reservations.some((r) => r.status === 'UNKNOWN')) refuse('GOAL_USAGE_UNKNOWN');
  };
  return {
    async initialize(goalRunId: string, policy: GoalBudgetPolicy): Promise<void> {
      if (!policy.policyId || !integer(policy.maxCalls) || policy.maxCalls < 1 || policy.maxCalls > 1000 || !integer(policy.maxTokens) || !integer(policy.maxCostMicros) || !integer(policy.deadlineMs) || policy.deadlineMs <= now()) refuse('GOAL_BUDGET_POLICY_INVALID');
      await store.bind(goalRunId, goalRunId);
      await store.update(goalRunId, (current) => {
        if (current !== null && !same(current.policy, policy)) refuse('GOAL_BUDGET_POLICY_CONFLICT');
        return { next: current ?? { goalRunId, policy, cancellation: null, reservations: [] }, value: undefined };
      });
    },
    bind: store.bind,
    read: readRequired,
    async isCancelled(runId: string): Promise<boolean> {
      const goalRunId = await store.goalOf(runId);
      return goalRunId !== null && (await store.read(goalRunId))?.cancellation != null;
    },
    async check(runId: string): Promise<void> { available(await readRequired(runId)); },
    async reserve(input: { readonly runId: string; readonly callId: string; readonly ownerId: string; readonly bound: CostAdmissionBound }): Promise<void> {
      const goalRunId = await store.goalOf(input.runId);
      if (goalRunId === null) return refuse('GOAL_BUDGET_NOT_BOUND');
      const b = input.bound;
      if (!input.callId || !input.ownerId || !b.modelKey || !b.evidenceRef || !integer(b.inputTokens) || !integer(b.outputTokens) || !integer(b.costMicros) || !integer(b.validUntilMs) || b.validUntilMs <= now()) refuse('GOAL_ADMISSION_BOUND_UNPROVEN');
      await store.update(goalRunId, (state) => {
        if (state === null) return refuse('GOAL_BUDGET_NOT_CONFIGURED');
        available(state);
        // A prior reservation is proof of a possible dispatch, NEVER permission to send again.
        if (state.reservations.some((r) => r.callId === input.callId)) refuse('GOAL_CALL_ALREADY_RESERVED');
        const tokens = state.reservations.reduce((n, r) => n + (r.usage?.tokens ?? r.bound.inputTokens + r.bound.outputTokens), 0);
        const cost = state.reservations.reduce((n, r) => n + (r.usage?.costMicros ?? r.bound.costMicros), 0);
        if (state.reservations.length >= state.policy.maxCalls || !integer(tokens + b.inputTokens + b.outputTokens) || tokens + b.inputTokens + b.outputTokens > state.policy.maxTokens || !integer(cost + b.costMicros) || cost + b.costMicros > state.policy.maxCostMicros) refuse('GOAL_BUDGET_EXHAUSTED');
        return { next: { ...state, reservations: [...state.reservations, { callId: input.callId, runId: input.runId, ownerId: input.ownerId, bound: b, status: 'RESERVED', usage: null }] }, value: undefined };
      });
    },
    async settle(runId: string, callId: string, usage: { readonly tokens: number; readonly costMicros: number } | null): Promise<void> {
      const goalRunId = await store.goalOf(runId);
      if (goalRunId === null) return refuse('GOAL_BUDGET_NOT_BOUND');
      await store.update(goalRunId, (state) => {
        if (state === null) return refuse('GOAL_BUDGET_NOT_CONFIGURED');
        const reservation = state.reservations.find((r) => r.callId === callId && r.runId === runId);
        if (reservation === undefined) return refuse('GOAL_RESERVATION_NOT_FOUND');
        const known = usage !== null && integer(usage.tokens) && integer(usage.costMicros) && usage.tokens <= reservation.bound.inputTokens + reservation.bound.outputTokens && usage.costMicros <= reservation.bound.costMicros;
        const resolved = known ? usage : null;
        if (reservation.status !== 'RESERVED') {
          if (reservation.status === 'UNKNOWN' || !same(reservation.usage, resolved)) refuse('GOAL_SETTLEMENT_CONFLICT');
          return { next: state, value: undefined };
        }
        return { next: { ...state, reservations: state.reservations.map((r) => r === reservation ? { ...r, status: known ? 'KNOWN' : 'UNKNOWN', usage: resolved } : r) }, value: undefined };
      });
    },
    async recover(goalRunId: string): Promise<void> {
      await store.update(goalRunId, (state) => {
        if (state === null) return refuse('GOAL_BUDGET_NOT_CONFIGURED');
        return { next: { ...state, reservations: state.reservations.map((r) => r.status === 'RESERVED' ? { ...r, status: 'UNKNOWN', usage: null } : r) }, value: undefined };
      });
    },
    async requestCancel(runId: string, requestId: string): Promise<void> {
      const goalRunId = await store.goalOf(runId) ?? runId;
      if (!requestId) return refuse('GOAL_CANCEL_ID_REQUIRED');
      // Legacy runs can accept cancellation without acquiring permission to execute.
      await store.bind(goalRunId, goalRunId);
      await store.update(goalRunId, (state) => {
        const current = state ?? { goalRunId, policy: { policyId: 'LEGACY_CANCEL_ONLY', maxCalls: 0, maxTokens: 0, maxCostMicros: 0, deadlineMs: 0 }, cancellation: null, reservations: [] };
        return { next: { ...current, cancellation: current.cancellation ?? { requestedAtMs: now(), requestId } }, value: undefined };
      });
    },
  };
}
