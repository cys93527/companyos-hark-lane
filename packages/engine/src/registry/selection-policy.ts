/**
 * Model Selection Policy service (Sprint 7.5).
 *
 * Stores the RULES and explains them. It never chooses a model: no scoring, no ranking, no
 * automatic fallback execution. Its four jobs are:
 *   - save / read / resolve scoped policies (Company < Workflow < Role < Task);
 *   - explain whether a MANUAL choice is admissible, and if not, exactly why;
 *   - expose the HYBRID candidate set and the AUTO contract statement;
 *   - record Benchmark metadata (display only, never an input to the above).
 */
import {
  DomainError,
  createPolicy,
  defineEvent,
  deriveRouterPolicyView,
  describeAutoPolicy,
  domainError,
  err,
  evaluateManualSelection,
  hybridCandidates,
  ok,
  policyId,
  resolvePolicy,
  selectionRulesFromPolicy,
  summarizePerformance,
  validateBenchmarkResult,
  type AutoContractView,
  type BenchmarkResult,
  type Clock,
  type EntityStore,
  type EventStorePort,
  type HybridCandidateSet,
  type IdFactory,
  type Logger,
  type ManualSelectionVerdict,
  type ModelPerformanceMetadata,
  type ModelRecord,
  type ModelSelectionPolicy,
  type PolicyDraft,
  type PolicyScopeRef,
  type Result,
  type RouterPolicyView,
} from '@companyos/core';

export interface SelectionPolicyDeps {
  readonly ids: IdFactory;
  readonly clock: Clock;
  readonly policies: EntityStore<ModelSelectionPolicy>;
  readonly results: EntityStore<BenchmarkResult>;
  /** Reads the curated registry (derived availability included). */
  readonly readRecords: () => Promise<readonly ModelRecord[]>;
  readonly authorize?: (input: {
    readonly actorId: string;
    readonly authority: string;
    readonly scopeId?: string;
  }) => Promise<Result<true, DomainError>>;
  readonly events?: EventStorePort;
  readonly logger?: Logger;
}

export interface SavePolicyInput extends Omit<PolicyDraft, 'id' | 'createdBy' | 'now'> {
  readonly actorId: string;
}

export interface SelectionPolicyService {
  savePolicy(input: SavePolicyInput): Promise<Result<ModelSelectionPolicy, DomainError>>;
  getPolicy(scopeType: PolicyScopeRef['scopeType'], scopeId: string): Promise<ModelSelectionPolicy | null>;
  listPolicies(): Promise<readonly ModelSelectionPolicy[]>;
  deletePolicy(scopeType: PolicyScopeRef['scopeType'], scopeId: string, actorId: string): Promise<Result<boolean, DomainError>>;
  resolveFor(scopes: readonly PolicyScopeRef[]): Promise<ModelSelectionPolicy | null>;
  explainManual(input: {
    readonly modelKey: string;
    readonly scopes: readonly PolicyScopeRef[];
    readonly explicit?: boolean;
    readonly taskOverride?: boolean;
  }): Promise<Result<ManualSelectionVerdict, DomainError>>;
  hybridView(scopes: readonly PolicyScopeRef[]): Promise<Result<HybridCandidateSet, DomainError>>;
  autoView(scopes: readonly PolicyScopeRef[]): Promise<Result<AutoContractView, DomainError>>;
  recordBenchmarkResults(results: readonly BenchmarkResult[], actorId: string): Promise<Result<number, DomainError>>;
  performanceMetadata(): Promise<readonly ModelPerformanceMetadata[]>;
  /**
   * Closeout-10A STEP 3: the ONLY sanctioned way to obtain a `RouterPolicyView`.
   * The router consumes a resolved view; callers must not hand-assemble filter lists.
   */
  routerPolicyView(input: {
    readonly scopes: readonly PolicyScopeRef[];
    readonly requiredCapabilities?: readonly string[];
    readonly actorId: string;
  }): Promise<Result<RouterPolicyView, DomainError>>;
}

export function createSelectionPolicyService(deps: SelectionPolicyDeps): SelectionPolicyService {
  const nowIso = (): string => deps.clock.nowIso();
  let warned = false;

  const permit = async (actorId: string, authority: string, scopeId?: string): Promise<Result<true, DomainError>> => {
    if (deps.authorize === undefined) {
      if (!warned) {
        warned = true;
        deps.logger?.warn('no authorization policy wired: selection policy permissions are not enforced');
      }
      return ok(true);
    }
    try {
      return await deps.authorize({ actorId, authority, ...(scopeId === undefined ? {} : { scopeId }) });
    } catch (error) {
      return err(
        error instanceof DomainError
          ? error
          : domainError('PERMISSION_DENIED', error instanceof Error ? error.message : String(error), {}),
      );
    }
  };

  const audit = async (
    type: string,
    aggregateId: string,
    actorId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    if (deps.events === undefined) return;
    await deps.events.append([
      defineEvent(
        { type, aggregateId, aggregateType: 'ModelSelectionPolicy', traceId: deps.ids.id('trace'), actorId, payload },
        deps.ids,
        nowIso(),
      ),
    ]);
  };

  const listPolicies = async (): Promise<readonly ModelSelectionPolicy[]> =>
    (await deps.policies.list({ limit: 200 })).items;

  const requirePolicy = async (
    scopes: readonly PolicyScopeRef[],
  ): Promise<Result<ModelSelectionPolicy, DomainError>> => {
    const policy = resolvePolicy(await listPolicies(), scopes);
    if (policy === null) {
      return err(
        domainError('NOT_FOUND', 'No selection policy applies to this scope.', { scopes }),
      );
    }
    return ok(policy);
  };

  return {
    async savePolicy(input: SavePolicyInput): Promise<Result<ModelSelectionPolicy, DomainError>> {
      const permitted = await permit(input.actorId, 'model.write', `${input.scopeType}:${input.scopeId}`);
      if (!permitted.ok) return permitted;
      const draft: PolicyDraft = {
        id: policyId(input.scopeType as PolicyScopeRef['scopeType'], input.scopeId),
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        mode: input.mode,
        manualModelKey: input.manualModelKey ?? null,
        allowedModels: input.allowedModels ?? [],
        preferredModels: input.preferredModels ?? [],
        blockedModels: input.blockedModels ?? [],
        allowedProviders: input.allowedProviders ?? [],
        requiredCapabilities: input.requiredCapabilities ?? [],
        maxCost: input.maxCost ?? null,
        maxLatency: input.maxLatency ?? null,
        allowFallback: input.allowFallback ?? 'NEVER',
        requireApprovalForOverride: input.requireApprovalForOverride ?? false,
        createdBy: input.actorId,
        now: nowIso(),
      };
      const built = createPolicy(draft);
      if (!built.ok) return built;
      const existing = await deps.policies.get(built.value.id);
      const stored: ModelSelectionPolicy =
        existing === null ? built.value : { ...built.value, createdAt: existing.createdAt };
      await deps.policies.put(stored);
      await audit('model.selection_policy_saved', stored.id, input.actorId, {
        scopeType: stored.scopeType,
        scopeId: stored.scopeId,
        mode: stored.mode,
        allowFallback: stored.allowFallback,
      });
      return ok(stored);
    },

    async getPolicy(scopeType, scopeId): Promise<ModelSelectionPolicy | null> {
      return deps.policies.get(policyId(scopeType, scopeId));
    },

    async listPolicies(): Promise<readonly ModelSelectionPolicy[]> {
      return (await listPolicies()).slice().sort((left, right) => (left.id < right.id ? -1 : 1));
    },

    async deletePolicy(scopeType, scopeId, actorId): Promise<Result<boolean, DomainError>> {
      const permitted = await permit(actorId, 'model.write', `${scopeType}:${scopeId}`);
      if (!permitted.ok) return permitted;
      return ok(await deps.policies.delete(policyId(scopeType, scopeId)));
    },

    async resolveFor(scopes: readonly PolicyScopeRef[]): Promise<ModelSelectionPolicy | null> {
      return resolvePolicy(await listPolicies(), scopes);
    },

    /** Explain a MANUAL choice. Never substitutes: refusal comes with reasons + fallback set. */
    async explainManual(input: {
      readonly modelKey: string;
      readonly scopes: readonly PolicyScopeRef[];
      readonly explicit?: boolean;
      readonly taskOverride?: boolean;
    }): Promise<Result<ManualSelectionVerdict, DomainError>> {
      const policy = resolvePolicy(await listPolicies(), input.scopes);
      const verdict = evaluateManualSelection({
        modelKey: input.modelKey,
        // 10A.0.3 §七: one shared rule shape - no local re-derivation of policy semantics.
        policy: selectionRulesFromPolicy(policy),
        records: await deps.readRecords(),
        ...(input.explicit === undefined ? {} : { explicit: input.explicit }),
        ...(input.taskOverride === undefined ? {} : { taskOverride: input.taskOverride }),
      });
      return ok(verdict);
    },

    async hybridView(scopes: readonly PolicyScopeRef[]): Promise<Result<HybridCandidateSet, DomainError>> {
      const policy = await requirePolicy(scopes);
      if (!policy.ok) return policy;
      return ok(
        hybridCandidates({ policy: selectionRulesFromPolicy(policy.value), records: await deps.readRecords() }),
      );
    },

    /** AUTO is a contract: the statement + the set a future router would be allowed to use. */
    async autoView(scopes: readonly PolicyScopeRef[]): Promise<Result<AutoContractView, DomainError>> {
      const policy = await requirePolicy(scopes);
      if (!policy.ok) return policy;
      return ok(
        describeAutoPolicy({ policy: selectionRulesFromPolicy(policy.value), records: await deps.readRecords() }),
      );
    },

    async recordBenchmarkResults(
      results: readonly BenchmarkResult[],
      actorId: string,
    ): Promise<Result<number, DomainError>> {
      const permitted = await permit(actorId, 'model.write', 'benchmark');
      if (!permitted.ok) return permitted;
      for (const result of results) {
        const valid = validateBenchmarkResult(result);
        if (!valid.ok) return valid;
      }
      for (const result of results) await deps.results.put(result);
      await audit('benchmark.result_recorded', 'benchmark', actorId, {
        count: results.length,
        models: [...new Set(results.map((result) => result.modelKey))].sort(),
      });
      return ok(results.length);
    },

    /** Display metadata only: no selection path reads this (ADR-0011). */
    async performanceMetadata(): Promise<readonly ModelPerformanceMetadata[]> {
      return summarizePerformance((await deps.results.list({ limit: 500 })).items);
    },

    /**
     * Policy Service -> RouterPolicyView -> Router (STEP 3). One interpretation of one policy,
     * produced in one place, content-digest-protected. 10A.0.3 §一: the wall clock is NOT part of
     * the semantic version - it only ever reaches `generatedAt`.
     */
    async routerPolicyView(input: {
      readonly scopes: readonly PolicyScopeRef[];
      readonly requiredCapabilities?: readonly string[];
      readonly actorId: string;
    }): Promise<Result<RouterPolicyView, DomainError>> {
      const permitted = await permit(input.actorId, 'model.read', 'router-policy-view');
      if (!permitted.ok) return permitted;
      const policy = resolvePolicy(await listPolicies(), input.scopes);
      return ok(
        deriveRouterPolicyView({
          policy,
          ...(input.requiredCapabilities === undefined ? {} : { requiredCapabilities: input.requiredCapabilities }),
          generatedAt: nowIso(),
        }),
      );
    },
  };
}
