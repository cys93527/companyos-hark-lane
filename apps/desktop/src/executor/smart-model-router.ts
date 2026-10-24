/**
 * STAGE 8 PART B — SMART MODEL ROUTING V1 (Boss Stage 8 §B).
 *
 * Deterministic, explainable, NON-ADAPTIVE routing inside the existing
 * CompanyOS selection seam (Stage 6 ModelPool, Stage 7B attempt ownership).
 *
 * Frozen properties (Boss Stage 8 §B):
 *   1. Router Uses LLM: NO. This module is a pure decision function over static
 *      metadata — no provider call, no model-calls-model, no fetch.
 *   2. Adaptive Learning: NO. OBSERVE YES / LEARN NO / ADAPT NO. Nothing here
 *      reads historical success rates, usage telemetry or outcomes.
 *   3. Model Tournament: NO. No voting, no parallel fan-out, no tournament —
 *      exactly ONE profile is selected per attempt.
 *   4. Hidden Fallback: NO. When the hard filters leave nothing eligible the
 *      router FAILS LOUD (MODEL_CAPABILITY_MISMATCH); it never falls back to
 *      "any enabled profile".
 *   5. Hard filter FIRST, deterministic weighted scoring second — rejected
 *      candidates never resurrect.
 *   6. Model lock stays ExecutionAttempt-owned (Stage 7B): this module returns
 *      a RoutingDecision + a snapshot for ONE attempt; it never mutates a role.
 *   7. RETRY ≠ REROUTE: a retry re-executes an attempt; a reroute happens only
 *      when the declared inputs (complexity, risk, requirements, policy) or the
 *      candidate set changed. `classifyRoutingChange` makes the difference
 *      mechanical.
 *   8. Packs never pin a commercial model: a Pack routing preference selects a
 *      policy fixture and may raise floors; the only pin is an operator/task
 *      level pin, recorded audit-visible in the decision.
 */
import { domainError, err, ok, type DomainError, type Result } from '@companyos/core';
import {
  type CostTier,
  type LatencyTier,
  type ModelCapability,
  type ModelPool,
  type ModelProfile,
  type ModelRoutingTraits,
  type QualityTier,
  type ReliabilityClass,
  type RoutingProfileId,
  type SelectedModelSnapshot,
  snapshotOf,
} from './model-pool.js';
import type { RoleInstance } from './role-orchestration.js';

// ---------------------------------------------------------------------------
// Routing inputs (Boss Stage 8 §B)
// ---------------------------------------------------------------------------

/** Generic task complexity — no software assumptions, no LLM inference. */
export type TaskComplexity = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';

/** Canonical risk class, sourced from the responsibility requirement data. */
export type RoutingRiskLevel = 'low' | 'medium' | 'high';

// ---------------------------------------------------------------------------
// Ordinal ladders — the ONLY numeric mapping (documented, deterministic)
// ---------------------------------------------------------------------------

export const QUALITY_LADDER: Readonly<Record<QualityTier, number>> = {ECONOMY: 1, BALANCED: 2, STRONG: 3, PREMIUM: 4};
export const COST_LADDER: Readonly<Record<CostTier, number>> = {LOW: 1, MEDIUM: 2, HIGH: 3};
export const LATENCY_LADDER: Readonly<Record<LatencyTier, number>> = {FAST: 1, BALANCED: 2, SLOW: 3};
export const RELIABILITY_LADDER: Readonly<Record<ReliabilityClass, number>> = {STANDARD: 1, HIGH: 2, CRITICAL: 3};

/** 0..100 per dimension. Ordinal tiers keep the router honest (no false precision). */
const dimensionScore = (ladder: Readonly<Record<string, number>>, tier: string, invert: boolean): number => {
  const values = Object.values(ladder);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const raw = (ladder[tier] ?? min) - min;
  const span = max - min;
  const normalized = span === 0 ? 0 : (raw / span) * 100;
  return Math.round(invert ? 100 - normalized : normalized);
};

export const qualityScoreOf = (traits: ModelRoutingTraits): number => dimensionScore(QUALITY_LADDER, traits.qualityTier, false);
export const costScoreOf = (traits: ModelRoutingTraits): number => dimensionScore(COST_LADDER, traits.costTier, true);
export const latencyScoreOf = (traits: ModelRoutingTraits): number => dimensionScore(LATENCY_LADDER, traits.latencyTier, true);
export const reliabilityScoreOf = (traits: ModelRoutingTraits): number => dimensionScore(RELIABILITY_LADDER, traits.reliabilityClass, false);

// ---------------------------------------------------------------------------
// Policy contract (Boss Stage 8 §B)
// ---------------------------------------------------------------------------

export interface ModelRoutingHardConstraints {
  readonly minimumQualityTier?: QualityTier;
  readonly maximumCostTier?: CostTier;
  readonly maximumLatencyTier?: LatencyTier;
  readonly minimumReliabilityClass?: ReliabilityClass;
  readonly minimumContextTokens?: number;
  readonly requiredCapabilities?: readonly ModelCapability[];
  readonly requiresTools?: boolean;
  readonly requiresStructuredOutput?: boolean;
  readonly allowedProviders?: readonly string[];
  readonly excludedProfileIds?: readonly string[];
}

export type RoutingTieBreaker = 'profile-id-asc' | 'cost-then-profile-id' | 'quality-then-profile-id';

/**
 * ModelRoutingPolicyV1 — the versioned, static routing rule set.
 *
 * `policyVersion` is part of every RoutingDecision so a decision is always
 * reproducible against the exact policy that produced it.
 */
export interface ModelRoutingPolicyV1 {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly hardConstraints: ModelRoutingHardConstraints;
  /** Static weights. Integer arithmetic only — no floating-point drift. */
  readonly weights: {
    readonly quality: number;
    readonly cost: number;
    readonly latency: number;
    readonly reliability: number;
  };
  readonly tieBreaker: RoutingTieBreaker;
  /** Risk raises the reliability floor and the quality weight — deterministic. */
  readonly riskAdjustment: {
    readonly minimumReliabilityByRisk: Readonly<Record<RoutingRiskLevel, ReliabilityClass>>;
    readonly qualityWeightBonusByRisk: Readonly<Record<RoutingRiskLevel, number>>;
  };
  /**
   * INTEGRATION BREADTH != MODEL INTELLIGENCE REQUIREMENT (LIVE-SMOKE-FIX-07 §2):
   * `taskComplexity` is STRUCTURAL — distinct pinned-DAG predecessor fan-in, how
   * many prerequisite work products the task integrates (plan-shape-invariant).
   * This complexity→quality floor is the ONLY seam that turns that structure
   * into a model-quality gate, so V1 decouples the two: HIGH (2–3 predecessors)
   * no longer implies STRONG merely because a task integrates several work
   * products; VERY_HIGH (4+ predecessors — broad multi-source integration)
   * still floors at STRONG. Genuine model-quality demands keep their OWN
   * canonical seams — required capabilities, tools, structured output, context
   * window, risk reliability, provider allowlist, authentication, pack floors —
   * none of which are re-counted through complexity.
   *
   * `qualityWeightBonusByComplexity` remains a soft SCORING preference (more
   * integration breadth still breaks ties toward higher quality when several
   * profiles clear the floor); it gates nothing.
   */
  readonly complexityAdjustment: {
    readonly minimumQualityByComplexity: Readonly<Record<TaskComplexity, QualityTier>>;
    readonly qualityWeightBonusByComplexity: Readonly<Record<TaskComplexity, number>>;
  };
}

export type RoutingRejectReason =
  | 'PROFILE_DISABLED'
  | 'ROUTING_TRAITS_ABSENT'
  | 'MISSING_REQUIRED_CAPABILITY'
  | 'TOOLS_UNSUPPORTED'
  | 'STRUCTURED_OUTPUT_UNSUPPORTED'
  | 'CONTEXT_WINDOW_TOO_SMALL'
  | 'PROVIDER_NOT_ALLOWED'
  | 'PROFILE_EXCLUDED'
  | 'QUALITY_BELOW_POLICY_MINIMUM'
  | 'COST_ABOVE_POLICY_MAXIMUM'
  | 'LATENCY_ABOVE_POLICY_MAXIMUM'
  | 'RELIABILITY_BELOW_RISK_MINIMUM'
  | 'QUALITY_BELOW_COMPLEXITY_MINIMUM'
  | 'QUALITY_BELOW_PACK_MINIMUM'
  | 'RELIABILITY_BELOW_PACK_MINIMUM';

/** The hard-filter pipeline, in contract order (rejected candidates never resurrect). */
export const ROUTING_HARD_FILTER_STAGES: readonly RoutingRejectReason[] = [
  'PROFILE_DISABLED',
  'ROUTING_TRAITS_ABSENT',
  'MISSING_REQUIRED_CAPABILITY',
  'TOOLS_UNSUPPORTED',
  'STRUCTURED_OUTPUT_UNSUPPORTED',
  'CONTEXT_WINDOW_TOO_SMALL',
  'PROVIDER_NOT_ALLOWED',
  'PROFILE_EXCLUDED',
  'QUALITY_BELOW_POLICY_MINIMUM',
  'COST_ABOVE_POLICY_MAXIMUM',
  'LATENCY_ABOVE_POLICY_MAXIMUM',
  'RELIABILITY_BELOW_RISK_MINIMUM',
  'QUALITY_BELOW_COMPLEXITY_MINIMUM',
  'QUALITY_BELOW_PACK_MINIMUM',
  'RELIABILITY_BELOW_PACK_MINIMUM',
];

// ---------------------------------------------------------------------------
// Three deterministic policy fixtures (Boss Stage 8 §B)
// ---------------------------------------------------------------------------

export const ROUTING_POLICIES: Readonly<Record<RoutingProfileId, ModelRoutingPolicyV1>> = {
  QUALITY_FIRST: {
    policyId: 'QUALITY_FIRST',
    policyVersion: 1,
    hardConstraints: {minimumQualityTier: 'BALANCED'},
    weights: {quality: 6, cost: 1, latency: 1, reliability: 3},
    tieBreaker: 'quality-then-profile-id',
    riskAdjustment: {
      minimumReliabilityByRisk: {low: 'STANDARD', medium: 'STANDARD', high: 'HIGH'},
      qualityWeightBonusByRisk: {low: 0, medium: 1, high: 3},
    },
    complexityAdjustment: {
      // FIX-07: HIGH no longer floors at STRONG (integration breadth != model
      // intelligence); VERY_HIGH (4+ predecessors) still does.
      minimumQualityByComplexity: {LOW: 'ECONOMY', MEDIUM: 'BALANCED', HIGH: 'BALANCED', VERY_HIGH: 'STRONG'},
      qualityWeightBonusByComplexity: {LOW: 0, MEDIUM: 1, HIGH: 2, VERY_HIGH: 4},
    },
  },
  BALANCED: {
    policyId: 'BALANCED',
    policyVersion: 1,
    hardConstraints: {minimumQualityTier: 'ECONOMY'},
    weights: {quality: 3, cost: 2, latency: 2, reliability: 2},
    tieBreaker: 'profile-id-asc',
    riskAdjustment: {
      minimumReliabilityByRisk: {low: 'STANDARD', medium: 'STANDARD', high: 'HIGH'},
      qualityWeightBonusByRisk: {low: 0, medium: 1, high: 2},
    },
    complexityAdjustment: {
      // FIX-07: HIGH no longer floors at STRONG (integration breadth != model
      // intelligence); VERY_HIGH (4+ predecessors) still does.
      minimumQualityByComplexity: {LOW: 'ECONOMY', MEDIUM: 'BALANCED', HIGH: 'BALANCED', VERY_HIGH: 'STRONG'},
      qualityWeightBonusByComplexity: {LOW: 0, MEDIUM: 1, HIGH: 2, VERY_HIGH: 4},
    },
  },
  COST_AWARE: {
    policyId: 'COST_AWARE',
    policyVersion: 1,
    hardConstraints: {minimumQualityTier: 'ECONOMY', maximumCostTier: 'MEDIUM'},
    weights: {quality: 1, cost: 6, latency: 2, reliability: 1},
    tieBreaker: 'cost-then-profile-id',
    riskAdjustment: {
      minimumReliabilityByRisk: {low: 'STANDARD', medium: 'STANDARD', high: 'HIGH'},
      qualityWeightBonusByRisk: {low: 0, medium: 1, high: 1},
    },
    complexityAdjustment: {
      minimumQualityByComplexity: {LOW: 'ECONOMY', MEDIUM: 'ECONOMY', HIGH: 'BALANCED', VERY_HIGH: 'BALANCED'},
      qualityWeightBonusByComplexity: {LOW: 0, MEDIUM: 1, HIGH: 1, VERY_HIGH: 2},
    },
  },
};

// ---------------------------------------------------------------------------
// Routing decision (Boss Stage 8 §B — the audit-visible output)
// ---------------------------------------------------------------------------

export const ROUTING_SELECTED_REASONS = [
  'OPERATOR_PIN',
  'ONLY_ELIGIBLE_CANDIDATE',
  'HIGHEST_WEIGHTED_SCORE',
  'TIE_BREAK_PROFILE_ID',
  'TIE_BREAK_COST',
  'TIE_BREAK_QUALITY',
] as const;

export type RoutingSelectedReason = (typeof ROUTING_SELECTED_REASONS)[number];

export interface RoutingCandidateScore {
  readonly profileId: string;
  readonly quality: number;
  readonly cost: number;
  readonly latency: number;
  readonly reliability: number;
  readonly total: number;
  readonly appliedWeights: {
    readonly quality: number;
    readonly cost: number;
    readonly latency: number;
    readonly reliability: number;
  };
}

export interface RoutingCostEstimate {
  /** Always labelled — an estimate is NEVER presented as an authoritative price. */
  readonly classification: 'ESTIMATED' | 'UNAVAILABLE';
  readonly estimatedUSD: number | null;
  readonly basis: string;
}

export interface RoutingDecision {
  /** Deterministic id (no randomness): route-<attemptId>. */
  readonly decisionId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly roleInstanceId: string;
  readonly selectedModelProfileId: string;
  /** The per-attemptSelectedModelSnapshot (Stage 7B: the ATTEMPT owns this). */
  readonly selectedModel: SelectedModelSnapshot;
  readonly policyId: string;
  readonly policyVersion: number;
  /** The policy fixture actually applied: the pack hint's fixture id, or the operator override's id. */
  readonly routingProfile: string;
  readonly taskComplexity: TaskComplexity;
  readonly riskLevel: RoutingRiskLevel;
  readonly decisionPolicy: 'pinned' | 'hard-filter-and-weighted-score';
  readonly requiredCapabilities: readonly ModelCapability[];
  readonly eligibleCandidates: readonly string[];
  readonly rejectedCandidates: readonly {readonly profileId: string; readonly reason: RoutingRejectReason}[];
  readonly scoreBreakdown: readonly RoutingCandidateScore[];
  readonly selectedReason: RoutingSelectedReason;
  readonly estimatedCost: RoutingCostEstimate;
}

// ---------------------------------------------------------------------------
// The router (Boss Stage 8 §B)
// ---------------------------------------------------------------------------

const tierAtLeast = (ladder: Readonly<Record<string, number>>, tier: string, minimum: string): boolean =>
  (ladder[tier] ?? 0) >= (ladder[minimum] ?? 0);

const tierAtMost = (ladder: Readonly<Record<string, number>>, tier: string, maximum: string): boolean =>
  (ladder[tier] ?? 0) <= (ladder[maximum] ?? 0);

/**
 * Route ONE ExecutionAttempt to exactly ONE ModelProfile.
 *
 * Deterministic pipeline: hard filters (in ROUTING_HARD_FILTER_STAGES order) →
 * integer weighted scoring → declared tie-breaker. No LLM, no tournament, no
 * adaptive signal, no hidden fallback, no random tie-breaking.
 */
export const routeModelForAttempt = (
  pool: ModelPool,
  input: {
    readonly attemptId: string;
    readonly taskId: string;
    readonly roleInstanceId: string;
    readonly role: RoleInstance;
    readonly taskComplexity: TaskComplexity;
    readonly riskLevel: RoutingRiskLevel;
    /** Explicit policy override (operator level). Defaults to the pack hint's fixture. */
    readonly policy?: ModelRoutingPolicyV1;
    /** Operator/task-level pin. A Pack can never pin (PackRoutingPreference has no pin field). */
    readonly pinnedProfileId?: string;
    readonly estimatedTokens?: {readonly input: number; readonly output: number};
  },
): Result<RoutingDecision, DomainError> => {
  if (input.attemptId === '' || input.taskId === '' || input.roleInstanceId === '') {
    return err(domainError('VALIDATION_FAILED', 'Routing requires attemptId, taskId and roleInstanceId.'));
  }
  const packPreference = input.role.specification.routingPreference;
  const policy = input.policy ?? ROUTING_POLICIES[packPreference?.routingProfile ?? 'BALANCED'];
  const roleRequirements = input.role.modelSelectionRequirements;

  const decisionBase = {
    attemptId: input.attemptId,
    taskId: input.taskId,
    roleInstanceId: input.roleInstanceId,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    routingProfile: policy.policyId,
    taskComplexity: input.taskComplexity,
    riskLevel: input.riskLevel,
  };

  // --- Operator pin: audit-visible, validated, fail-closed (no silent fallback) ---
  if (input.pinnedProfileId !== undefined) {
    const pinned = pool.inspect(input.pinnedProfileId);
    if (!pinned.ok) {
      return err(domainError('VALIDATION_FAILED', `Pinned ModelProfile "${input.pinnedProfileId}" is not registered.`, {
        reason: 'MODEL_PROFILE_UNAVAILABLE',
      }));
    }
    if (!pinned.value.enabled) {
      return err(domainError('VALIDATION_FAILED', `Pinned ModelProfile "${input.pinnedProfileId}" is disabled.`, {
        reason: 'MODEL_PROFILE_UNAVAILABLE',
      }));
    }
    return ok({
      ...decisionBase,
      decisionId: `route-${input.attemptId}`,
      selectedModelProfileId: pinned.value.modelProfileId,
      selectedModel: snapshotOf(pinned.value),
      decisionPolicy: 'pinned',
      requiredCapabilities: requiredCapabilitiesOf(roleRequirements, policy),
      eligibleCandidates: [pinned.value.modelProfileId],
      rejectedCandidates: [],
      scoreBreakdown: [],
      selectedReason: 'OPERATOR_PIN',
      estimatedCost: estimateCost(pinned.value, input.estimatedTokens),
    });
  }

  const enabled = pool.listEnabled();
  if (enabled.length === 0) {
    return err(domainError('VALIDATION_FAILED', 'The model pool has no enabled profiles.', {reason: 'MODEL_POOL_EMPTY'}));
  }

  const rejectedCandidates: {profileId: string; reason: RoutingRejectReason}[] = [];
  const eligible: ModelProfile[] = [];

  const riskFloor = policy.riskAdjustment.minimumReliabilityByRisk[input.riskLevel];
  const complexityFloor = policy.complexityAdjustment.minimumQualityByComplexity[input.taskComplexity];
  const requiredCapabilities = requiredCapabilitiesOf(roleRequirements, policy);

  for (const profile of enabled) {
    const traits = profile.routingTraits;
    if (traits === undefined) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'ROUTING_TRAITS_ABSENT'});
      continue;
    }
    const missing = requiredCapabilities.filter((cap) => !profile.capabilities.has(cap));
    if (missing.length > 0) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'MISSING_REQUIRED_CAPABILITY'});
      continue;
    }
    if (roleRequirements.requiresTools === true && !profile.supportsTools) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'TOOLS_UNSUPPORTED'});
      continue;
    }
    if (roleRequirements.requiresStructuredOutput === true && !profile.supportsStructuredOutput) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'STRUCTURED_OUTPUT_UNSUPPORTED'});
      continue;
    }
    const minimumContext = [
      roleRequirements.minimumContextTokens,
      policy.hardConstraints.minimumContextTokens,
    ].filter((v): v is number => v !== undefined);
    const contextFloor = minimumContext.length > 0 ? Math.max(...minimumContext) : 0;
    if (profile.contextWindowTokens < contextFloor) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'CONTEXT_WINDOW_TOO_SMALL'});
      continue;
    }
    if (policy.hardConstraints.allowedProviders !== undefined && !policy.hardConstraints.allowedProviders.includes(profile.providerId)) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'PROVIDER_NOT_ALLOWED'});
      continue;
    }
    if (policy.hardConstraints.excludedProfileIds?.includes(profile.modelProfileId) === true) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'PROFILE_EXCLUDED'});
      continue;
    }
    if (policy.hardConstraints.minimumQualityTier !== undefined && !tierAtLeast(QUALITY_LADDER, traits.qualityTier, policy.hardConstraints.minimumQualityTier)) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'QUALITY_BELOW_POLICY_MINIMUM'});
      continue;
    }
    if (policy.hardConstraints.maximumCostTier !== undefined && !tierAtMost(COST_LADDER, traits.costTier, policy.hardConstraints.maximumCostTier)) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'COST_ABOVE_POLICY_MAXIMUM'});
      continue;
    }
    if (policy.hardConstraints.maximumLatencyTier !== undefined && !tierAtMost(LATENCY_LADDER, traits.latencyTier, policy.hardConstraints.maximumLatencyTier)) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'LATENCY_ABOVE_POLICY_MAXIMUM'});
      continue;
    }
    if (riskFloor !== undefined && !tierAtLeast(RELIABILITY_LADDER, traits.reliabilityClass, riskFloor)) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'RELIABILITY_BELOW_RISK_MINIMUM'});
      continue;
    }
    if (complexityFloor !== undefined && !tierAtLeast(QUALITY_LADDER, traits.qualityTier, complexityFloor)) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'QUALITY_BELOW_COMPLEXITY_MINIMUM'});
      continue;
    }
    if (packPreference?.minimumQualityTier !== undefined && !tierAtLeast(QUALITY_LADDER, traits.qualityTier, packPreference.minimumQualityTier)) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'QUALITY_BELOW_PACK_MINIMUM'});
      continue;
    }
    if (packPreference?.minimumReliabilityClass !== undefined && !tierAtLeast(RELIABILITY_LADDER, traits.reliabilityClass, packPreference.minimumReliabilityClass)) {
      rejectedCandidates.push({profileId: profile.modelProfileId, reason: 'RELIABILITY_BELOW_PACK_MINIMUM'});
      continue;
    }
    eligible.push(profile);
  }

  if (eligible.length === 0) {
    return err(domainError('VALIDATION_FAILED', 'No enabled model profile survives the routing hard filters.', {
      reason: 'MODEL_CAPABILITY_MISMATCH',
      rejectedCandidates,
    }));
  }

  // --- Deterministic weighted scoring (integer arithmetic, static weights) ---
  const qualityWeight =
    policy.weights.quality +
    policy.riskAdjustment.qualityWeightBonusByRisk[input.riskLevel] +
    policy.complexityAdjustment.qualityWeightBonusByComplexity[input.taskComplexity];

  const scoreBreakdown: RoutingCandidateScore[] = eligible.map((profile) => {
    const traits = profile.routingTraits!;
    const quality = qualityScoreOf(traits);
    const cost = costScoreOf(traits);
    const latency = latencyScoreOf(traits);
    const reliability = reliabilityScoreOf(traits);
    return {
      profileId: profile.modelProfileId,
      quality,
      cost,
      latency,
      reliability,
      total: quality * qualityWeight + cost * policy.weights.cost + latency * policy.weights.latency + reliability * policy.weights.reliability,
      appliedWeights: {quality: qualityWeight, cost: policy.weights.cost, latency: policy.weights.latency, reliability: policy.weights.reliability},
    };
  });

  const bestTotal = Math.max(...scoreBreakdown.map((s) => s.total));
  const tied = scoreBreakdown.filter((s) => s.total === bestTotal);
  const tieBreak = (candidates: readonly RoutingCandidateScore[]): RoutingCandidateScore => {
    if (policy.tieBreaker === 'cost-then-profile-id') {
      return [...candidates].sort((a, b) => b.cost - a.cost || a.profileId.localeCompare(b.profileId))[0]!;
    }
    if (policy.tieBreaker === 'quality-then-profile-id') {
      return [...candidates].sort((a, b) => b.quality - a.quality || a.profileId.localeCompare(b.profileId))[0]!;
    }
    return [...candidates].sort((a, b) => a.profileId.localeCompare(b.profileId))[0]!;
  };
  const selected = tieBreak(tied);
  const selectedReason: RoutingSelectedReason =
    tied.length === 1 && eligible.length === 1
      ? 'ONLY_ELIGIBLE_CANDIDATE'
      : tied.length === 1
        ? 'HIGHEST_WEIGHTED_SCORE'
        : policy.tieBreaker === 'cost-then-profile-id'
          ? 'TIE_BREAK_COST'
          : policy.tieBreaker === 'quality-then-profile-id'
            ? 'TIE_BREAK_QUALITY'
            : 'TIE_BREAK_PROFILE_ID';

  const selectedProfile = pool.inspect(selected.profileId);
  if (!selectedProfile.ok) return selectedProfile;

  return ok({
    ...decisionBase,
    decisionId: `route-${input.attemptId}`,
    selectedModelProfileId: selectedProfile.value.modelProfileId,
    selectedModel: snapshotOf(selectedProfile.value),
    decisionPolicy: 'hard-filter-and-weighted-score',
    requiredCapabilities,
    eligibleCandidates: [...eligible].map((p) => p.modelProfileId).sort((a, b) => a.localeCompare(b)),
    rejectedCandidates: [...rejectedCandidates].sort((a, b) => a.profileId.localeCompare(b.profileId)),
    scoreBreakdown: [...scoreBreakdown].sort((a, b) => b.total - a.total || a.profileId.localeCompare(b.profileId)),
    selectedReason,
    estimatedCost: estimateCost(selectedProfile.value, input.estimatedTokens),
  });
};

const requiredCapabilitiesOf = (
  roleRequirements: {requiredCapabilities?: readonly ModelCapability[]},
  policy: ModelRoutingPolicyV1,
): ModelCapability[] => {
  const merged = new Set<ModelCapability>([
    ...(roleRequirements.requiredCapabilities ?? []),
    ...(policy.hardConstraints.requiredCapabilities ?? []),
  ]);
  if (policy.hardConstraints.requiresTools === true) merged.add('tool-calling');
  if (policy.hardConstraints.requiresStructuredOutput === true) merged.add('structured-output');
  return [...merged].sort();
};

// ---------------------------------------------------------------------------
// Estimated cost contract (Boss Stage 8 §B — labelled, never authoritative)
// ---------------------------------------------------------------------------

export const estimateCost = (
  profile: ModelProfile,
  estimatedTokens: {readonly input: number; readonly output: number} | undefined,
): RoutingCostEstimate => {
  if (
    estimatedTokens === undefined ||
    profile.costPerMillionInputTokens === undefined ||
    profile.costPerMillionOutputTokens === undefined
  ) {
    return {
      classification: 'UNAVAILABLE',
      estimatedUSD: null,
      basis: 'cost metadata or token estimate absent — routing decisions never require a price',
    };
  }
  const usd =
    (estimatedTokens.input / 1_000_000) * profile.costPerMillionInputTokens +
    (estimatedTokens.output / 1_000_000) * profile.costPerMillionOutputTokens;
  return {
    classification: 'ESTIMATED',
    estimatedUSD: Math.round(usd * 1_000_000) / 1_000_000,
    basis: `static cost metadata x ${String(estimatedTokens.input)} in / ${String(estimatedTokens.output)} out estimated tokens`,
  };
};

// ---------------------------------------------------------------------------
// RETRY ≠ REROUTE (Boss Stage 8 §B)
// ---------------------------------------------------------------------------

export const REROUTE_CAUSES = [
  'NONE',
  'PIN_CHANGED',
  'COMPLEXITY_CHANGED',
  'RISK_CHANGED',
  'REQUIREMENTS_CHANGED',
  'POLICY_CHANGED',
  'CANDIDATE_SET_CHANGED',
] as const;

export type RerouteCause = (typeof REROUTE_CAUSES)[number];

/**
 * Classify the relationship between two routing decisions.
 *
 * A RETRY keeps the same route (same profile, same declared inputs, same
 * policy). A REROUTE happened only when something declared changed. Because
 * selection is deterministic, "same inputs → same profile" is mechanical; a
 * different profile with identical declared inputs means the candidate set
 * itself changed (e.g. a profile was disabled or re-registered).
 */
export const classifyRoutingChange = (input: {
  readonly previous: RoutingDecision;
  readonly next: RoutingDecision;
}): RerouteCause => {
  const {previous, next} = input;
  if (previous.decisionPolicy !== next.decisionPolicy) return 'PIN_CHANGED';
  if (previous.taskComplexity !== next.taskComplexity) return 'COMPLEXITY_CHANGED';
  if (previous.riskLevel !== next.riskLevel) return 'RISK_CHANGED';
  if (previous.policyId !== next.policyId || previous.policyVersion !== next.policyVersion) return 'POLICY_CHANGED';
  if (
    previous.requiredCapabilities.length !== next.requiredCapabilities.length ||
    previous.requiredCapabilities.some((cap, index) => cap !== next.requiredCapabilities[index])
  ) {
    return 'REQUIREMENTS_CHANGED';
  }
  if (
    previous.selectedModelProfileId === next.selectedModelProfileId &&
    previous.eligibleCandidates.length === next.eligibleCandidates.length &&
    previous.eligibleCandidates.every((id, index) => id === next.eligibleCandidates[index])
  ) {
    return 'NONE';
  }
  return 'CANDIDATE_SET_CHANGED';
};

/** True when re-running the same declared inputs reproduces the same route. */
export const isDeterministicRoute = (input: {previous: RoutingDecision; next: RoutingDecision}): boolean =>
  input.previous.selectedModelProfileId === input.next.selectedModelProfileId &&
  classifyRoutingChange(input) === 'NONE';
