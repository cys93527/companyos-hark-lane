import { domainError, type CostAdmissionBound, type InvocationResult } from '@companyos/core';
import { createGoalExecutionBudget } from '@companyos/engine';
import type { SelectedModelRoute } from '@companyos/engine';
import type { DurableDatabase } from '@companyos/persistence';
import { pinnedBudgetCost, readTrustedBudgetProof, trustedBudgetBound, trustedBudgetPolicyId, type ObservedBudgetBinding, type TrustedBudgetProofSource } from './trusted-budget-proof.js';

export interface GoalSafetyConfiguration {
  /** Opt-in trusted deployment ports. No fallback to legacy callbacks on proof failure. */
  readonly trustedProofs?: TrustedBudgetProofSource;
  readonly policyId: string;
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly maxCostMicros: number;
  readonly durationMs: number;
  /** Trusted deployment proof of upstream enforced token/price bounds; no inferred prices. */
  readonly boundOf?: (input: { readonly modelKey: string; readonly maxOutputTokens: number | null }) => CostAdmissionBound | null;
  /** Exact billing reconciliation; missing evidence keeps the reservation UNKNOWN. */
  readonly costOf?: (modelKey: string, usage: InvocationResult['usage']) => number | null;
}

/** Controllers/timers are transport handles ONLY. Every admission reads durable truth. */
export function createExecutionSafetyCoordinator(database: DurableDatabase, config: GoalSafetyConfiguration, now: () => number) {
  const budget = createGoalExecutionBudget(database.executionBudget, now);
  const proofSource = config.trustedProofs === undefined ? undefined : Object.freeze({ ...config.trustedProofs,
    billingScope: Object.freeze({ ...config.trustedProofs.billingScope }) });
  const controllers = new Map<string, Set<AbortController>>();
  const enroll = (goalId: string, deadlineMs: number) => {
    const controller = new AbortController();
    const members = controllers.get(goalId) ?? new Set<AbortController>();
    controllers.set(goalId, members); members.add(controller);
    const timer = setTimeout(() => controller.abort(domainError('TIMEOUT', 'Goal execution deadline reached.')), Math.max(0, Math.min(deadlineMs - now(), 2_147_483_647)));
    return { signal: controller.signal, release() { clearTimeout(timer); members.delete(controller); if (members.size === 0) controllers.delete(goalId); } };
  };
  const boundFor = async (input: { runId: string; executionId: string; modelKey: string; maxOutputTokens: number | null; binding?: ObservedBudgetBinding }) => {
    const source = proofSource;
    if (source === undefined) return config.boundOf?.(input) ?? null;
    await budget.check(input.runId);
    const state = await budget.read(input.runId);
    if (config.policyId !== source.policyId || state.policy.policyId !== trustedBudgetPolicyId(source)) return null;
    let binding = input.binding;
    if (binding === undefined) {
      const execution = await database.agentExecutions.get(input.executionId);
      if (execution === null || String(execution.runId) !== input.runId || execution.modelKey !== input.modelKey) return null;
      binding = { modelKey: execution.modelKey, providerId: execution.providerId, modelId: execution.providerModelId };
    }
    if (binding.modelKey !== input.modelKey) return null;
    const bound = await trustedBudgetBound(source, binding, input.maxOutputTokens, now());
    if (bound === null) return null;
    const nextProof = await readTrustedBudgetProof(source, bound.evidenceRef);
    if (nextProof === null) return null;
    // One Goal cannot silently aggregate currencies or billing accounts after a deployment update.
    for (const reservation of state.reservations) {
      const original = await readTrustedBudgetProof(source, reservation.bound.evidenceRef);
      if (original === null || original.identity.providerId !== nextProof.identity.providerId
        || original.identity.billingAccount !== nextProof.identity.billingAccount
        || original.identity.billingOrganization !== nextProof.identity.billingOrganization) return null;
    }
    return bound;
  };
  const coordinator = {
    budget,
    async initialize(goalRunId: string): Promise<void> {
      const run = await database.runs.get(goalRunId);
      if (run === null) throw domainError('NOT_FOUND', 'Goal Run does not exist.');
      const createdAt = Date.parse(run.createdAt);
      const policyId = proofSource === undefined ? config.policyId : trustedBudgetPolicyId(proofSource);
      if (policyId === null || (proofSource !== undefined && config.policyId !== proofSource.policyId)) throw domainError('POLICY_DENIED', 'Trusted budget policy identity is incomplete.');
      await budget.initialize(goalRunId, { policyId, maxCalls: config.maxCalls, maxTokens: config.maxTokens, maxCostMicros: config.maxCostMicros, deadlineMs: createdAt + config.durationMs });
    },
    async recover(): Promise<void> {
      const ids = await database.db.writeFence.serialize(async () => database.db.prepare('SELECT id FROM runs WHERE execution_goal_run_id = id AND execution_budget_json IS NOT NULL').all() as { id: string }[]);
      for (const { id } of ids) await budget.recover(id);
    },
    async requestCancel(runId: string): Promise<void> {
      await budget.requestCancel(runId, `cancel:${runId}`);
      const state = await budget.read(runId);
      for (const controller of controllers.get(state.goalRunId) ?? []) controller.abort(domainError('CANCELLED', 'Goal cancellation requested; remote stop is not proven.'));
    },
    async lease(runId: string) {
      await budget.check(runId);
      const state = await budget.read(runId);
      const handle = enroll(state.goalRunId, state.policy.deadlineMs);
      // Close the enrollment race: cancel may have committed between check and enroll.
      try { await budget.check(runId); } catch (error) { handle.release(); throw error; }
      return handle;
    },
    async prepareExecutor(input: { readonly runId: string; readonly attemptId: string; readonly route?: SelectedModelRoute; readonly fallback?: { readonly providerId: string; readonly modelId: string; readonly maxTokens?: number; readonly baseURL?: string; readonly apiKeyEnv?: string } }) {
      const modelKey = input.route?.modelProfileId ?? (input.fallback === undefined ? '' : `${input.fallback.providerId}:${input.fallback.modelId}`);
      const modelId = input.route?.modelId ?? input.fallback?.modelId;
      const maxOutputTokens = input.route?.maxTokens ?? input.fallback?.maxTokens ?? null;
      const binding: ObservedBudgetBinding = input.route === undefined
        ? { modelKey, providerId: input.fallback?.providerId ?? '', modelId: modelId ?? '',
          ...(input.fallback?.baseURL === undefined ? {} : { endpoint: input.fallback.baseURL }),
          ...(input.fallback?.apiKeyEnv === undefined ? {} : { credentialRef: `env:${input.fallback.apiKeyEnv}` }) }
        : { modelKey, providerId: input.route.providerId, modelId: input.route.modelId, endpoint: input.route.baseURL, credentialRef: input.route.credentialRef };
      // A trusted executor route must include the actual endpoint/credential reference.
      if (proofSource !== undefined && (binding.endpoint === undefined || binding.credentialRef === undefined)) throw domainError('POLICY_DENIED', 'Executor identity is incomplete.', { reason: 'GOAL_ADMISSION_IDENTITY_UNPROVEN', retryable: false });
      const proof = await boundFor({ runId: input.runId, executionId: input.attemptId, modelKey, maxOutputTokens, binding });
      if (proof === null || modelId === undefined || proof.modelKey !== modelKey || maxOutputTokens === null || maxOutputTokens > proof.outputTokens) throw domainError('POLICY_DENIED', 'Executor external cost admission is not established.', { reason: 'GOAL_ADMISSION_BOUND_UNPROVEN', retryable: false });
      const lease = await coordinator.lease(input.runId);
      let networkAttempt = 0;
      return {
        ...lease,
        async admitBody(bytes: Uint8Array) {
          const body = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
          const requestedMax = body['max_completion_tokens'] ?? body['max_tokens'];
          if (body['model'] !== modelId || typeof requestedMax !== 'number' || !Number.isSafeInteger(requestedMax) || requestedMax < 1 || requestedMax > maxOutputTokens) throw domainError('POLICY_DENIED', 'Kernel request violates the pinned model/token bound.', { reason: 'GOAL_KERNEL_REQUEST_BOUND_MISMATCH', retryable: false });
          return coordinator.admit({ runId: input.runId, executionId: input.attemptId, modelKey, networkAttempt: ++networkAttempt, maxOutputTokens: requestedMax, binding });
        },
      };
    },
    async admit(input: { readonly runId: string; readonly executionId: string; readonly modelKey: string; readonly networkAttempt: number; readonly maxOutputTokens: number | null; readonly binding?: ObservedBudgetBinding }) {
      const bound = await boundFor(input);
      if (bound === null || bound.modelKey !== input.modelKey || bound.outputTokens < 1 || (input.maxOutputTokens !== null && input.maxOutputTokens > bound.outputTokens)) throw domainError('POLICY_DENIED', 'No verified token and financial admission bound is configured.', { reason: 'GOAL_ADMISSION_BOUND_UNPROVEN', retryable: false });
      const callId = `${input.executionId}:network:${input.networkAttempt}`;
      await budget.reserve({ runId: input.runId, callId, ownerId: input.executionId, bound });
      let handle;
      try {
        await budget.check(input.runId);
        const state = await budget.read(input.runId);
        handle = enroll(state.goalRunId, state.policy.deadlineMs);
        await budget.check(input.runId);
      } catch (error) { handle?.release(); await budget.settle(input.runId, callId, null); throw error; }
      let settled = false;
      return {
        ...handle,
        maxOutputTokens: input.maxOutputTokens ?? bound.outputTokens,
        async settle(usage: InvocationResult['usage'] | null): Promise<void> {
          if (settled && proofSource === undefined) return;
          // Missing/invalid reconciliation does NOT become zero or an estimated charge.
          let cost: number | null = null;
          try {
            if (usage !== null && proofSource !== undefined) {
              const state = await budget.read(input.runId);
              const original = state.reservations.find(r => r.callId === callId && r.runId === input.runId && r.ownerId === input.executionId);
              if (original !== undefined && original.bound.modelKey === input.modelKey && original.bound.evidenceRef === bound.evidenceRef) {
                cost = await pinnedBudgetCost(proofSource, original, usage);
              }
            } else if (usage !== null) cost = config.costOf?.(input.modelKey, usage) ?? null;
          } catch { /* Missing original proof/accounting evidence remains UNKNOWN. */ }
          const known = usage !== null && cost !== null && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 && usage.inputTokens <= bound.inputTokens && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0 && usage.outputTokens <= bound.outputTokens;
          await budget.settle(input.runId, callId, known && usage !== null && cost !== null ? { tokens: usage.inputTokens + usage.outputTokens, costMicros: cost } : null);
          settled = true;
          // Accounting is retained even if an uncooperative caller returns after
          // cancellation/deadline. Such a response is not permission to publish.
          // Preserve the original typed provider failure when usage is unknown;
          // the next admission is blocked by the durable UNKNOWN reservation.
          if (known) await budget.check(input.runId);
        },
      };
    },
  };
  return coordinator;
}
