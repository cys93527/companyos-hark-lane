/**
 * STAGE 8 PART B — SMART MODEL ROUTING V1 targeted tests (Boss Stage 8 §B).
 *
 * Covers: hard-filter pipeline and reject reasons, ordinal-tier weighted
 * scoring, the three policy fixtures, tie-breakers, complexity/risk
 * adjustments, pack routing preferences (hint-only, never a pin), operator pin
 * (audit-visible, fail-closed), per-attempt model lock, RETRY ≠ REROUTE,
 * estimated-cost labelling, no hidden fallback / no tournament / no LLM / no
 * adaptive signal, and the three E2E proofs with per-attempt routing.
 */
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

import {
  ROUTING_POLICIES,
  ROUTING_SELECTED_REASONS,
  classifyRoutingChange,
  estimateCost,
  isDeterministicRoute,
  routeModelForAttempt,
  type ModelRoutingPolicyV1,
  type RoutingDecision,
  type RoutingTieBreaker,
} from '../src/executor/smart-model-router.js';
import {
  ModelPool,
  type ModelProfile,
  type ModelRoutingTraits,
  type RoutingProfileId,
} from '../src/executor/model-pool.js';
import {
  RoleCatalog,
  createRoleInstance,
  resolveRole,
  type ProfessionalResponsibilityRequirement,
  type RoleDefinition,
  type RoleInstance,
} from '../src/executor/role-orchestration.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRAITS = (overrides: Partial<ModelRoutingTraits> = {}): ModelRoutingTraits => ({
  qualityTier: 'BALANCED',
  costTier: 'MEDIUM',
  latencyTier: 'BALANCED',
  reliabilityClass: 'STANDARD',
  ...overrides,
});

const PROFILE = (id: string, overrides: Partial<ModelProfile> = {}): Omit<ModelProfile, 'configurationVersion'> => ({
  modelProfileId: id,
  providerId: `prov-${id}`,
  modelId: `model-${id}`,
  displayName: id,
  endpointURL: 'http://127.0.0.1:1/v1',
  credentialRef: 'vault://test/key',
  enabled: true,
  capabilities: new Set(['tool-calling', 'structured-output', 'streaming'] as const),
  contextWindowTokens: 8192,
  maxOutputTokens: 4096,
  supportsTools: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  ...overrides,
});

/** A profile WITH routing traits (the Smart Router's eligible unit). */
const ROUTABLE = (id: string, traits: Partial<ModelRoutingTraits>, overrides: Partial<ModelProfile> = {}): Omit<ModelProfile, 'configurationVersion'> =>
  PROFILE(id, {routingTraits: TRAITS(traits), ...overrides});

/** A full deterministic pool used by most tests. */
const routingPool = (): ModelPool => {
  const pool = new ModelPool();
  pool.register(ROUTABLE('econ-model', {qualityTier: 'ECONOMY', costTier: 'LOW', latencyTier: 'FAST', reliabilityClass: 'STANDARD'}));
  pool.register(ROUTABLE('mid-model', {qualityTier: 'BALANCED', costTier: 'MEDIUM', latencyTier: 'BALANCED', reliabilityClass: 'STANDARD'}));
  pool.register(ROUTABLE('strong-model', {qualityTier: 'STRONG', costTier: 'HIGH', latencyTier: 'BALANCED', reliabilityClass: 'HIGH'}));
  pool.register(ROUTABLE('prem-model', {qualityTier: 'PREMIUM', costTier: 'HIGH', latencyTier: 'SLOW', reliabilityClass: 'CRITICAL'}));
  // A Stage 6 profile with NO routing traits: Stage 6 selection still works,
  // Smart Routing rejects it loudly instead of guessing.
  pool.register(PROFILE('legacy-model'));
  return pool;
};

const ROLE = (id: string, overrides: Partial<RoleDefinition> = {}): Omit<RoleDefinition, 'version'> => ({
  roleDefinitionId: id,
  displayName: id.replace(/-/g, ' '),
  professionalResponsibility: `Responsibility of ${id}`,
  responsibilityDescription: `${id} professional work`,
  requiredCapabilities: ['read', 'write'],
  preferredCapabilities: [],
  toolNeeds: ['fs'],
  contextNeeds: ['goal', 'task'],
  validationResponsibilities: [],
  independenceClass: 'implementer',
  defaultExecutionBudget: {maxTurns: 10, maxToolCalls: 30},
  packOwner: 'software-pack',
  domain: 'software',
  ...overrides,
});

const REQ = (intent: string, caps: readonly string[], overrides: Partial<ProfessionalResponsibilityRequirement> = {}): ProfessionalResponsibilityRequirement => ({
  responsibilityIntent: intent,
  requiredCapabilities: caps,
  expectedOutputKind: 'artifact',
  validationExpectation: 'validated',
  independenceRequired: false,
  riskLevel: 'low',
  ...overrides,
});

const roleInstance = (
  id: string,
  capabilities: readonly string[],
  overrides: Partial<RoleDefinition> = {},
): RoleInstance => {
  const catalog = new RoleCatalog();
  catalog.register(ROLE(id, {...overrides, requiredCapabilities: [...capabilities]}));
  const spec = resolveRole(catalog, REQ(`work of ${id}`, capabilities));
  if (!spec.ok) throw new Error(`resolve failed for ${id}`);
  return createRoleInstance({roleInstanceId: `ri_${id}`, runId: 'run_s8r', companyId: 'co_s8r', specification: spec.value});
};

const ROUTE = (
  pool: ModelPool,
  role: RoleInstance,
  overrides: {
    attemptId?: string;
    taskId?: string;
    taskComplexity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';
    riskLevel?: 'low' | 'medium' | 'high';
    policy?: ModelRoutingPolicyV1;
    pinnedProfileId?: string;
  } = {},
) =>
  routeModelForAttempt(pool, {
    attemptId: overrides.attemptId ?? 'att_1',
    taskId: overrides.taskId ?? 'task_1',
    roleInstanceId: role.roleInstanceId,
    role,
    taskComplexity: overrides.taskComplexity ?? 'MEDIUM',
    riskLevel: overrides.riskLevel ?? 'low',
    policy: overrides.policy,
    pinnedProfileId: overrides.pinnedProfileId,
  });

/** A tie policy: qualityWeightBonus 0 everywhere so qw === weights.quality. */
const tiePolicy = (id: string, tieBreaker: RoutingTieBreaker): ModelRoutingPolicyV1 => ({
  policyId: id,
  policyVersion: 1,
  hardConstraints: {minimumQualityTier: 'ECONOMY'},
  weights: {quality: 1, cost: 1, latency: 1, reliability: 1},
  tieBreaker,
  riskAdjustment: {
    minimumReliabilityByRisk: {low: 'STANDARD', medium: 'STANDARD', high: 'HIGH'},
    qualityWeightBonusByRisk: {low: 0, medium: 0, high: 0},
  },
  complexityAdjustment: {
    minimumQualityByComplexity: {LOW: 'ECONOMY', MEDIUM: 'ECONOMY', HIGH: 'ECONOMY', VERY_HIGH: 'ECONOMY'},
    qualityWeightBonusByComplexity: {LOW: 0, MEDIUM: 0, HIGH: 0, VERY_HIGH: 0},
  },
});

// ---------------------------------------------------------------------------
// Hard filter pipeline (Boss §B — rejected candidates never resurrect)
// ---------------------------------------------------------------------------

describe('STAGE 8 Router Hard Filters (Boss §B)', () => {
  it('rejects a profile without routing traits with an explanation', () => {
    const pool = new ModelPool();
    pool.register(PROFILE('only-legacy'));
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details.reason).toBe('MODEL_CAPABILITY_MISMATCH');
      const rejected = result.error.details.rejectedCandidates as {profileId: string; reason: string}[];
      expect(rejected[0]).toEqual({profileId: 'only-legacy', reason: 'ROUTING_TRAITS_ABSENT'});
    }
  });

  it('MODEL_POOL_EMPTY when nothing is enabled', () => {
    const pool = new ModelPool();
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details.reason).toBe('MODEL_POOL_EMPTY');
  });

  it('capability/tool/structured-output/context floors reject with closed reasons', () => {
    const pool = new ModelPool();
    // Has the capability but the boolean support flag is false → TOOLS_UNSUPPORTED.
    pool.register(ROUTABLE('no-tools', {qualityTier: 'PREMIUM'}, {supportsTools: false}));
    pool.register(ROUTABLE('no-structured', {qualityTier: 'PREMIUM'}, {supportsStructuredOutput: false}));
    pool.register(ROUTABLE('tiny-context', {qualityTier: 'PREMIUM'}, {contextWindowTokens: 512}));
    const policy: ModelRoutingPolicyV1 = {...tiePolicy('FLOORS2', 'profile-id-asc'), hardConstraints: {minimumContextTokens: 4096}};
    const result = ROUTE(pool, roleInstance('engineer', ['tool-calling', 'structured-output']), {policy});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const rejected = result.error.details.rejectedCandidates as {profileId: string; reason: string}[];
      const byId = new Map(rejected.map((r) => [r.profileId, r.reason]));
      expect(byId.get('no-tools')).toBe('TOOLS_UNSUPPORTED');
      expect(byId.get('no-structured')).toBe('STRUCTURED_OUTPUT_UNSUPPORTED');
      expect(byId.get('tiny-context')).toBe('CONTEXT_WINDOW_TOO_SMALL');
    }
  });

  it('provider allow-list and profile exclusion are enforced', () => {
    const pool = new ModelPool();
    pool.register(ROUTABLE('good-model', {}));
    pool.register(ROUTABLE('other-provider', {}, {providerId: 'prov-elsewhere'}));
    const policy: ModelRoutingPolicyV1 = {
      ...tiePolicy('FILTERS', 'profile-id-asc'),
      hardConstraints: {allowedProviders: ['prov-good-model'], excludedProfileIds: ['good-model']},
    };
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']), {policy});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const rejected = result.error.details.rejectedCandidates as {profileId: string; reason: string}[];
      const byId = new Map(rejected.map((r) => [r.profileId, r.reason]));
      expect(byId.get('good-model')).toBe('PROFILE_EXCLUDED');
      expect(byId.get('other-provider')).toBe('PROVIDER_NOT_ALLOWED');
    }
  });

  it('policy quality/cost/latency floors reject with closed reasons', () => {
    const pool = routingPool();
    const policy: ModelRoutingPolicyV1 = {
      ...tiePolicy('FLOORS', 'profile-id-asc'),
      hardConstraints: {minimumQualityTier: 'STRONG', maximumCostTier: 'MEDIUM', maximumLatencyTier: 'FAST'},
    };
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']), {policy});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const rejected = result.error.details.rejectedCandidates as {profileId: string; reason: string}[];
      const byId = new Map(rejected.map((r) => [r.profileId, r.reason]));
      expect(byId.get('econ-model')).toBe('QUALITY_BELOW_POLICY_MINIMUM');
      expect(byId.get('mid-model')).toBe('QUALITY_BELOW_POLICY_MINIMUM');
      expect(byId.get('strong-model')).toBe('COST_ABOVE_POLICY_MAXIMUM');
      expect(byId.get('prem-model')).toBe('COST_ABOVE_POLICY_MAXIMUM');
      expect(byId.get('legacy-model')).toBe('ROUTING_TRAITS_ABSENT');
    }
  });

  it('NO hidden fallback: nothing eligible fails loud, never "any enabled profile"', () => {
    const pool = new ModelPool();
    pool.register(ROUTABLE('econ', {qualityTier: 'ECONOMY', costTier: 'LOW'}));
    const policy: ModelRoutingPolicyV1 = {
      ...tiePolicy('STRICT', 'profile-id-asc'),
      hardConstraints: {minimumQualityTier: 'PREMIUM'},
    };
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']), {policy});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details.reason).toBe('MODEL_CAPABILITY_MISMATCH');
      // No decision object exists at all when the filters reject everything.
      expect((result.error.details as Record<string, unknown>).selectedModelProfileId).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic weighted scoring + policy fixtures (Boss §B)
// ---------------------------------------------------------------------------

describe('STAGE 8 Router Scoring + Policy Fixtures (Boss §B)', () => {
  it('QUALITY_FIRST prefers the stronger profile', () => {
    const pool = routingPool();
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']), {policy: ROUTING_POLICIES.QUALITY_FIRST, taskComplexity: 'MEDIUM'});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedModelProfileId).toBe('prem-model');
    expect(result.value.selectedReason).toBe('HIGHEST_WEIGHTED_SCORE');
    expect(result.value.policyId).toBe('QUALITY_FIRST');
    // scoreBreakdown is sorted, explained, and integer.
    expect(result.value.scoreBreakdown[0]!.profileId).toBe('prem-model');
    expect(result.value.scoreBreakdown.every((s) => Number.isInteger(s.total))).toBe(true);
    expect(result.value.scoreBreakdown.every((s) => Number.isInteger(s.quality))).toBe(true);
  });

  it('COST_AWARE prefers the cheapest eligible profile and blocks premium cost', () => {
    const pool = routingPool();
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']), {policy: ROUTING_POLICIES.COST_AWARE, taskComplexity: 'LOW'});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedModelProfileId).toBe('econ-model');
    expect(result.value.rejectedCandidates.find((r) => r.profileId === 'prem-model')!.reason).toBe('COST_ABOVE_POLICY_MAXIMUM');
    expect(result.value.rejectedCandidates.find((r) => r.profileId === 'strong-model')!.reason).toBe('COST_ABOVE_POLICY_MAXIMUM');
  });

  it('BALANCED weighs quality and cost together', () => {
    const pool = routingPool();
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']), {policy: ROUTING_POLICIES.BALANCED, taskComplexity: 'MEDIUM'});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedModelProfileId).toBe('prem-model');
    // Quality dominates cost for the eligible mid-tier profiles under LOW risk.
    const scores = new Map(result.value.scoreBreakdown.map((s) => [s.profileId, s.total]));
    expect(scores.get('prem-model')!).toBeGreaterThan(scores.get('strong-model')!);
    expect(scores.get('strong-model')!).toBeGreaterThan(scores.get('mid-model')!);
    // ECONOMY is rejected by the MEDIUM-complexity quality floor — it has no score at all.
    expect(scores.has('econ-model')).toBe(false);
  });

  it('tie-break knobs decide genuine ties deterministically (id / cost / quality)', () => {
    const pool = new ModelPool();
    // Equal totals: ECONOMY/LOW/FAST/HIGH vs PREMIUM/HIGH/FAST/HIGH
    // with unit weights → 0+100+100+50 = 100+0+100+50.
    pool.register(ROUTABLE('aaa-cost-cheap', {qualityTier: 'ECONOMY', costTier: 'LOW', latencyTier: 'FAST', reliabilityClass: 'HIGH'}));
    pool.register(ROUTABLE('bbb-quality-rich', {qualityTier: 'PREMIUM', costTier: 'HIGH', latencyTier: 'FAST', reliabilityClass: 'HIGH'}));
    const role = roleInstance('engineer', ['read', 'write']);

    const byId = ROUTE(pool, role, {policy: tiePolicy('TIE_ID', 'profile-id-asc')});
    expect(byId.ok && byId.value.selectedModelProfileId).toBe('aaa-cost-cheap');
    expect(byId.ok && byId.value.selectedReason).toBe('TIE_BREAK_PROFILE_ID');

    const byCost = ROUTE(pool, role, {policy: tiePolicy('TIE_COST', 'cost-then-profile-id')});
    expect(byCost.ok && byCost.value.selectedModelProfileId).toBe('aaa-cost-cheap');
    expect(byCost.ok && byCost.value.selectedReason).toBe('TIE_BREAK_COST');

    const byQuality = ROUTE(pool, role, {policy: tiePolicy('TIE_QUALITY', 'quality-then-profile-id')});
    expect(byQuality.ok && byQuality.value.selectedModelProfileId).toBe('bbb-quality-rich');
    expect(byQuality.ok && byQuality.value.selectedReason).toBe('TIE_BREAK_QUALITY');

    // All three decisions explain the same eligible set.
    for (const result of [byId, byCost, byQuality]) {
      if (!result.ok) throw new Error('route failed');
      expect(result.value.eligibleCandidates).toEqual(['aaa-cost-cheap', 'bbb-quality-rich']);
    }
  });

  it('ONLY_ELIGIBLE_CANDIDATE when the filters leave exactly one', () => {
    const pool = new ModelPool();
    pool.register(ROUTABLE('solo', {qualityTier: 'BALANCED'}));
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.eligibleCandidates).toEqual(['solo']);
    expect(result.value.selectedReason).toBe('ONLY_ELIGIBLE_CANDIDATE');
  });

  it('selected reasons form the frozen closed set of six', () => {
    expect([...ROUTING_SELECTED_REASONS]).toEqual([
      'OPERATOR_PIN',
      'ONLY_ELIGIBLE_CANDIDATE',
      'HIGHEST_WEIGHTED_SCORE',
      'TIE_BREAK_PROFILE_ID',
      'TIE_BREAK_COST',
      'TIE_BREAK_QUALITY',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Complexity and risk adjustments (Boss §B)
// ---------------------------------------------------------------------------

describe('STAGE 8 Complexity + Risk Adjustments (Boss §B)', () => {
  it('VERY_HIGH complexity raises the quality floor (ECONOMY/BALANCED rejected)', () => {
    const pool = routingPool();
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']), {policy: ROUTING_POLICIES.BALANCED, taskComplexity: 'VERY_HIGH'});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rejected = new Map(result.value.rejectedCandidates.map((r) => [r.profileId, r.reason]));
    expect(rejected.get('econ-model')).toBe('QUALITY_BELOW_COMPLEXITY_MINIMUM');
    expect(rejected.get('mid-model')).toBe('QUALITY_BELOW_COMPLEXITY_MINIMUM');
    expect(result.value.eligibleCandidates).toEqual(['prem-model', 'strong-model']);
  });

  it('high risk raises the reliability floor (STANDARD rejected)', () => {
    const pool = routingPool();
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']), {policy: ROUTING_POLICIES.BALANCED, riskLevel: 'high', taskComplexity: 'LOW'});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rejected = new Map(result.value.rejectedCandidates.map((r) => [r.profileId, r.reason]));
    expect(rejected.get('econ-model')).toBe('RELIABILITY_BELOW_RISK_MINIMUM');
    expect(rejected.get('mid-model')).toBe('RELIABILITY_BELOW_RISK_MINIMUM');
    expect(result.value.eligibleCandidates).toEqual(['prem-model', 'strong-model']);
  });

  it('risk raises the quality weight: same pool, different risk → different winner', () => {
    const pool = new ModelPool();
    pool.register(ROUTABLE('cheap-fast', {qualityTier: 'BALANCED', costTier: 'LOW', latencyTier: 'BALANCED', reliabilityClass: 'HIGH'}));
    pool.register(ROUTABLE('rich-slow', {qualityTier: 'PREMIUM', costTier: 'MEDIUM', latencyTier: 'BALANCED', reliabilityClass: 'HIGH'}));
    const role = roleInstance('engineer', ['read', 'write']);
    // Custom fixture: cost weight 3 vs quality weight 2, so the quality-weight
    // bonus decides the winner as risk rises (low → cheap-fast, medium → rich-slow).
    const policy: ModelRoutingPolicyV1 = {
      policyId: 'RISK_WEIGHT_TEST',
      policyVersion: 1,
      hardConstraints: {minimumQualityTier: 'ECONOMY'},
      weights: {quality: 2, cost: 3, latency: 1, reliability: 1},
      tieBreaker: 'profile-id-asc',
      riskAdjustment: {
        minimumReliabilityByRisk: {low: 'STANDARD', medium: 'STANDARD', high: 'HIGH'},
        qualityWeightBonusByRisk: {low: 0, medium: 2, high: 4},
      },
      complexityAdjustment: {
        minimumQualityByComplexity: {LOW: 'ECONOMY', MEDIUM: 'ECONOMY', HIGH: 'ECONOMY', VERY_HIGH: 'ECONOMY'},
        qualityWeightBonusByComplexity: {LOW: 0, MEDIUM: 0, HIGH: 0, VERY_HIGH: 0},
      },
    };
    const low = ROUTE(pool, role, {policy, riskLevel: 'low', taskComplexity: 'LOW'});
    const medium = ROUTE(pool, role, {policy, riskLevel: 'medium', taskComplexity: 'LOW'});
    expect(low.ok && medium.ok).toBe(true);
    if (!low.ok || !medium.ok) return;
    expect(low.value.selectedModelProfileId).toBe('cheap-fast');
    expect(medium.value.selectedModelProfileId).toBe('rich-slow');
    expect(medium.value.scoreBreakdown.find((s) => s.profileId === 'rich-slow')!.appliedWeights.quality).toBe(
      low.value.scoreBreakdown.find((s) => s.profileId === 'rich-slow')!.appliedWeights.quality + 2,
    );
  });
});

// ---------------------------------------------------------------------------
// Pack routing preferences + operator pin (Boss §B)
// ---------------------------------------------------------------------------

describe('STAGE 8 Pack Preference + Operator Pin (Boss §B)', () => {
  it('pack routing preference selects the policy fixture (role-aware routing)', () => {
    const pool = routingPool();
    const qualityRole = roleInstance('designer', ['read'], {
      packOwner: 'design-pack',
      routingPreference: {routingProfile: 'QUALITY_FIRST'},
    });
    const costRole = roleInstance('clerk', ['read'], {
      packOwner: 'office-pack',
      routingPreference: {routingProfile: 'COST_AWARE'},
    });
    const fromQuality = ROUTE(pool, qualityRole);
    const fromCost = ROUTE(pool, costRole);
    expect(fromQuality.ok && fromCost.ok).toBe(true);
    if (!fromQuality.ok || !fromCost.ok) return;
    expect(fromQuality.value.routingProfile).toBe('QUALITY_FIRST');
    expect(fromCost.value.routingProfile).toBe('COST_AWARE');
    // The same pool routes differently purely from the pack hint.
    expect(fromQuality.value.selectedModelProfileId).toBe('prem-model');
    expect(fromCost.value.selectedModelProfileId).toBe('econ-model');
  });

  it('a pack can NEVER pin a commercial model — the preference has no pin field', () => {
    const pool = routingPool();
    // Even a smuggled pin key on the preference is ignored by the router.
    const smuggled = roleInstance('smuggler', ['read'], {
      packOwner: 'rogue-pack',
      routingPreference: {routingProfile: 'BALANCED'},
    });
    const preference = smuggled.specification.routingPreference as unknown as Record<string, unknown>;
    preference.pinnedProfileId = 'prem-model';
    const result = ROUTE(pool, smuggled, {policy: ROUTING_POLICIES.BALANCED, taskComplexity: 'MEDIUM'});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // BALANCED/MEDIUM selects prem-model on merit here; the point is the path:
    // decisionPolicy is scoring, never a pack-driven pin.
    expect(result.value.decisionPolicy).toBe('hard-filter-and-weighted-score');
    expect(result.value.selectedReason).not.toBe('OPERATOR_PIN');
  });

  it('pack minimum floors are enforced with pack-specific reasons', () => {
    const pool = routingPool();
    const role = roleInstance('designer', ['read'], {
      packOwner: 'design-pack',
      routingPreference: {routingProfile: 'BALANCED', minimumQualityTier: 'STRONG', minimumReliabilityClass: 'HIGH'},
    });
    // LOW complexity keeps the policy's own complexity floor at ECONOMY so the
    // PACK floor is the binding constraint (reason attribution stays sharp).
    const result = ROUTE(pool, role, {policy: ROUTING_POLICIES.BALANCED, taskComplexity: 'LOW'});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rejected = new Map(result.value.rejectedCandidates.map((r) => [r.profileId, r.reason]));
    expect(rejected.get('econ-model')).toBe('QUALITY_BELOW_PACK_MINIMUM');
    expect(rejected.get('mid-model')).toBe('QUALITY_BELOW_PACK_MINIMUM');
    expect(result.value.eligibleCandidates).toEqual(['prem-model', 'strong-model']);
  });

  it('operator pin is audit-visible and fail-closed (no silent fallback)', () => {
    const pool = routingPool();
    const role = roleInstance('engineer', ['read', 'write']);
    const pinned = ROUTE(pool, role, {pinnedProfileId: 'strong-model'});
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.value.decisionPolicy).toBe('pinned');
    expect(pinned.value.selectedReason).toBe('OPERATOR_PIN');
    expect(pinned.value.selectedModelProfileId).toBe('strong-model');
    expect(pinned.value.eligibleCandidates).toEqual(['strong-model']);
    expect(pinned.value.decisionId).toBe('route-att_1');

    const unknown = ROUTE(pool, role, {pinnedProfileId: 'ghost-model'});
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.details.reason).toBe('MODEL_PROFILE_UNAVAILABLE');

    pool.setEnabled('strong-model', false);
    const disabled = ROUTE(pool, role, {pinnedProfileId: 'strong-model'});
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.details.reason).toBe('MODEL_PROFILE_UNAVAILABLE');
  });

  it('an explicit operator policy overrides the pack hint', () => {
    const pool = routingPool();
    const role = roleInstance('clerk', ['read'], {
      packOwner: 'office-pack',
      routingPreference: {routingProfile: 'COST_AWARE'},
    });
    const result = ROUTE(pool, role, {policy: ROUTING_POLICIES.QUALITY_FIRST, taskComplexity: 'MEDIUM'});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.routingProfile).toBe('QUALITY_FIRST');
    expect(result.value.selectedModelProfileId).toBe('prem-model');
  });
});

// ---------------------------------------------------------------------------
// Per-attempt model lock + RETRY ≠ REROUTE (Boss §B)
// ---------------------------------------------------------------------------

describe('STAGE 8 Per-Attempt Lock + Retry/Reroute (Boss §B)', () => {
  it('routing returns a snapshot for ONE attempt and never mutates the role', () => {
    const pool = routingPool();
    const role = roleInstance('engineer', ['read', 'write']);
    const result = ROUTE(pool, role);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attemptId).toBe('att_1');
    expect(result.value.selectedModel.modelProfileId).toBe(result.value.selectedModelProfileId);
    // STAGE 7B ownership: the RoleInstance gains no model truth from routing.
    expect(Object.hasOwn(role as unknown as Record<string, unknown>, 'modelLock')).toBe(false);
    expect(Object.hasOwn(role as unknown as Record<string, unknown>, 'selectedModel')).toBe(false);
    expect(Object.hasOwn(role as unknown as Record<string, unknown>, 'modelProfileId')).toBe(false);
  });

  it('deterministic: identical declared inputs reproduce the identical route', () => {
    const pool = routingPool();
    const role = roleInstance('engineer', ['read', 'write']);
    const first = ROUTE(pool, role, {attemptId: 'att_a'});
    const second = ROUTE(pool, role, {attemptId: 'att_a'});
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.selectedModelProfileId).toBe(first.value.selectedModelProfileId);
    expect(isDeterministicRoute({previous: first.value, next: second.value})).toBe(true);
    expect(classifyRoutingChange({previous: first.value, next: second.value})).toBe('NONE');
  });

  it('RETRY keeps the route; REROUTE names its declared cause', () => {
    const pool = routingPool();
    const role = roleInstance('engineer', ['read', 'write']);
    const base = ROUTE(pool, role, {attemptId: 'att_base'});
    expect(base.ok).toBe(true);
    if (!base.ok) return;

    // A retry: same inputs, new attempt id → same route.
    const retry = ROUTE(pool, role, {attemptId: 'att_retry'});
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(classifyRoutingChange({previous: base.value, next: retry.value})).toBe('NONE');

    const complexity = ROUTE(pool, role, {attemptId: 'att_c', taskComplexity: 'VERY_HIGH'});
    const risk = ROUTE(pool, role, {attemptId: 'att_r', riskLevel: 'high'});
    const otherPolicy = ROUTE(pool, role, {attemptId: 'att_p', policy: ROUTING_POLICIES.COST_AWARE});
    const pinned = ROUTE(pool, role, {attemptId: 'att_pin', pinnedProfileId: 'prem-model'});
    for (const result of [complexity, risk, otherPolicy, pinned]) expect(result.ok).toBe(true);
    if (!complexity.ok || !risk.ok || !otherPolicy.ok || !pinned.ok) return;

    expect(classifyRoutingChange({previous: base.value, next: complexity.value})).toBe('COMPLEXITY_CHANGED');
    expect(classifyRoutingChange({previous: base.value, next: risk.value})).toBe('RISK_CHANGED');
    expect(classifyRoutingChange({previous: base.value, next: otherPolicy.value})).toBe('POLICY_CHANGED');
    expect(classifyRoutingChange({previous: base.value, next: pinned.value})).toBe('PIN_CHANGED');

    // Candidate-set change: disable the selected profile, re-route identical inputs.
    const before = ROUTE(pool, role, {attemptId: 'att_x', policy: ROUTING_POLICIES.QUALITY_FIRST, taskComplexity: 'MEDIUM'});
    if (!before.ok) throw new Error('route failed');
    pool.setEnabled(before.value.selectedModelProfileId, false);
    const after = ROUTE(pool, role, {attemptId: 'att_y', policy: ROUTING_POLICIES.QUALITY_FIRST, taskComplexity: 'MEDIUM'});
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.selectedModelProfileId).not.toBe(before.value.selectedModelProfileId);
    expect(classifyRoutingChange({previous: before.value, next: after.value})).toBe('CANDIDATE_SET_CHANGED');
  });
});

// ---------------------------------------------------------------------------
// Estimated cost contract (Boss §B)
// ---------------------------------------------------------------------------

describe('STAGE 8 Estimated Cost Contract (Boss §B)', () => {
  it('ESTIMATED when static metadata exists, UNAVAILABLE when it does not', () => {
    const priced: ModelProfile = {
      ...PROFILE('priced', {
        routingTraits: TRAITS(),
        costPerMillionInputTokens: 3,
        costPerMillionOutputTokens: 15,
      }),
      configurationVersion: 1,
    };
    const unpriced: ModelProfile = {...PROFILE('unpriced', {routingTraits: TRAITS()}), configurationVersion: 1};

    const estimated = estimateCost(priced, {input: 1_000_000, output: 2_000_000});
    expect(estimated.classification).toBe('ESTIMATED');
    expect(estimated.estimatedUSD).toBe(33); // 3 + 2*15

    const unavailable = estimateCost(unpriced, {input: 1000, output: 1000});
    expect(unavailable.classification).toBe('UNAVAILABLE');
    expect(unavailable.estimatedUSD).toBeNull();

    const noTokens = estimateCost(priced, undefined);
    expect(noTokens.classification).toBe('UNAVAILABLE');
    expect(noTokens.basis.length).toBeGreaterThan(0);
  });

  it('every RoutingDecision labels its cost estimate', () => {
    const pool = routingPool();
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.estimatedCost.classification).toBe('UNAVAILABLE');
    expect(result.value.estimatedCost.estimatedUSD).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Negative claims (Boss §B)
// ---------------------------------------------------------------------------

describe('STAGE 8 Router negative claims (Boss §B)', () => {
  it('the router API exposes no LLM / vote / tournament / adaptive surface', async () => {
    const module = await import('../src/executor/smart-model-router.js');
    const exported = Object.keys(module);
    for (const forbidden of ['routeWithLLM', 'askModelToChoose', 'vote', 'holdTournament', 'tournament', 'learn', 'adapt', 'fallback']) {
      expect(exported).not.toContain(forbidden);
    }
  });

  it('the router source contains no provider call, no LLM seam, no adaptive read', () => {
    const source = readFileSync(new URL('../src/executor/smart-model-router.ts', import.meta.url), 'utf8');
    // No network/provider/LLM machinery at all — this is a pure decision function.
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('dsh-executor-provider');
    expect(source).not.toContain('provider-dispatch');
    expect(source).not.toContain('native-process-provider');
    expect(source).not.toContain('registry/model-registry');
    // No adaptive/historical inputs: usage records and history are never read here.
    expect(source).not.toContain('ModelUsageRecord');
    expect(source).not.toContain('historicalSuccess');
    expect(source).not.toContain('successRate');
  });

  it('no tournament: exactly one profile is selected per attempt', () => {
    const pool = routingPool();
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value.selectedModelProfileId).toBe('string');
    expect(Array.isArray(result.value.selectedModel)).toBe(false);
    expect(result.value.scoreBreakdown.filter((s) => s.profileId === result.value.selectedModelProfileId).length).toBe(1);
  });

  it('role requirements merge into the declared capability set (role-aware)', () => {
    const pool = new ModelPool();
    pool.register(ROUTABLE('tool-model', {}, {capabilities: new Set(['tool-calling', 'structured-output', 'streaming'] as const)}));
    pool.register(ROUTABLE('plain-model', {}, {capabilities: new Set(['streaming'] as const)}));
    const result = ROUTE(pool, roleInstance('engineer', ['tool-calling', 'structured-output']));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requiredCapabilities).toEqual(['structured-output', 'tool-calling']);
    expect(result.value.rejectedCandidates).toEqual([{profileId: 'plain-model', reason: 'MISSING_REQUIRED_CAPABILITY'}]);
  });
});

// ---------------------------------------------------------------------------
// E2E proofs with per-attempt routing (Boss §B)
// ---------------------------------------------------------------------------

describe('STAGE 8 E2E A — Software chain with per-attempt routing', () => {
  it('architect → engineer → test → reviewer, each attempt routed independently', () => {
    const pool = routingPool();
    const roles = [
      roleInstance('architect', ['design', 'structured-output'], {independenceClass: 'analyst', packOwner: 'software-pack'}),
      roleInstance('engineer', ['tool-calling', 'structured-output']),
      roleInstance('test-engineer', ['tool-calling', 'test'], {packOwner: 'software-pack'}),
      roleInstance('reviewer', ['read', 'review'], {independenceClass: 'independent-reviewer'}),
    ];
    const decisions: RoutingDecision[] = roles.map((role, index) => {
      const result = ROUTE(pool, role, {
        attemptId: `att_e2e_${String(index)}`,
        taskId: `task_e2e_${String(index)}`,
        taskComplexity: index === 3 ? 'HIGH' : 'MEDIUM',
        riskLevel: index === 3 ? 'medium' : 'low',
        policy: ROUTING_POLICIES.BALANCED,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('route failed');
      return result.value;
    });
    // Distinct attempts, distinct decisions.
    expect(new Set(decisions.map((d) => d.attemptId)).size).toBe(4);
    // Every decision is explainable and audit-visible.
    for (const decision of decisions) {
      expect(decision.policyVersion).toBe(1);
      expect(decision.rejectedCandidates.every((r) => r.reason.length > 0)).toBe(true);
      expect(decision.eligibleCandidates.length).toBeGreaterThan(0);
    }
    /*
     * LIVE-SMOKE-FIX-07: the reviewer is structurally HIGH with medium risk. The
     * complexity→quality calibration decoupled integration breadth from model
     * intelligence, so HIGH floors at BALANCED (mid-model is now eligible; the
     * per-attempt risk floor still excludes ECONOMY). STRONG-only floors live at
     * VERY_HIGH — proven in the dedicated FIX-07 negative fixtures.
     */
    expect(decisions[3]!.eligibleCandidates).toEqual(['mid-model', 'prem-model', 'strong-model']);
  });
});

describe('STAGE 8 E2E B — Non-software chain with routing', () => {
  it('researcher → analyst → reviewer routed without software vocabulary', () => {
    const pool = routingPool();
    const roles = [
      roleInstance('researcher', ['read', 'research'], {packOwner: 'research-pack', domain: 'research'}),
      roleInstance('analyst', ['read', 'structured-output'], {packOwner: 'research-pack', domain: 'research', independenceClass: 'analyst'}),
      roleInstance('contract-reviewer', ['read', 'review'], {packOwner: 'legal-pack', domain: 'legal', independenceClass: 'independent-reviewer'}),
    ];
    const decisions = roles.map((role, index) => {
      const result = ROUTE(pool, role, {attemptId: `att_ns_${String(index)}`, taskId: `task_ns_${String(index)}`});
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('route failed');
      return result.value;
    });
    expect(new Set(decisions.map((d) => d.selectedModelProfileId)).size).toBeGreaterThan(0);
    // The reviewer (HIGH risk of a wrong legal call) reroutes to the reliable tier.
    const reviewed = ROUTE(pool, roles[2]!, {attemptId: 'att_ns_rev_risk', taskId: 'task_ns_2', riskLevel: 'high', taskComplexity: 'LOW'});
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.eligibleCandidates).toEqual(['prem-model', 'strong-model']);
  });
});

describe('STAGE 8 E2E C — Minimal team and late specialist with routing', () => {
  it('a minimal single-role task still routes with a full explanation', () => {
    const pool = new ModelPool();
    pool.register(ROUTABLE('solo-model', {qualityTier: 'BALANCED'}));
    const result = ROUTE(pool, roleInstance('engineer', ['read', 'write']));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedReason).toBe('ONLY_ELIGIBLE_CANDIDATE');
    expect(result.value.rejectedCandidates).toEqual([]);
  });

  it('a late specialist reroutes only for its own attempt (risk-driven)', () => {
    const pool = routingPool();
    const engineer = roleInstance('engineer', ['read', 'write']);
    const ordinary = ROUTE(pool, engineer, {attemptId: 'att_ord', taskComplexity: 'MEDIUM'});
    const specialist = roleInstance('security-specialist', ['read', 'review'], {
      independenceClass: 'independent-reviewer',
      packOwner: 'security-pack',
      domain: 'security',
    });
    const late = ROUTE(pool, specialist, {attemptId: 'att_late', taskComplexity: 'MEDIUM', riskLevel: 'high'});
    expect(ordinary.ok && late.ok).toBe(true);
    if (!ordinary.ok || !late.ok) return;
    expect(late.value.eligibleCandidates).toEqual(['prem-model', 'strong-model']);
    expect(classifyRoutingChange({previous: ordinary.value, next: late.value})).toBe('RISK_CHANGED');
    // Policy fixtures are keyed by pack preference; the security pack hint is honored.
    expect(late.value.routingProfile).toBe('BALANCED');
    const securityPack = roleInstance('security-specialist', ['read', 'review'], {
      independenceClass: 'independent-reviewer',
      packOwner: 'security-pack',
      domain: 'security',
      routingPreference: {routingProfile: 'QUALITY_FIRST' as RoutingProfileId},
    });
    const lateQuality = ROUTE(pool, securityPack, {attemptId: 'att_late_q', taskComplexity: 'MEDIUM', riskLevel: 'high'});
    expect(lateQuality.ok).toBe(true);
    if (!lateQuality.ok) return;
    expect(lateQuality.value.routingProfile).toBe('QUALITY_FIRST');
  });
});
