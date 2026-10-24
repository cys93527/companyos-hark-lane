/**
 * Model Router CONTRACT (Sprint 10A) — design only.
 *
 * WHAT THIS FILE IS: the frozen vocabulary and the *pure* decision rules the future router must
 * obey: a closed reason-code catalog, the request/recommendation shapes, the ordered candidate
 * pipeline, the hard-vs-ranking separation, the fallback/override/diversity contracts and the
 * deterministic tie-break contract.
 *
 * WHAT THIS FILE IS NOT: a router. There is no scoring, no ranking execution, no selection, no
 * provider call, no runtime call and no LLM-as-router. `applyHardFilters` only *filters* (it
 * never orders), `compareTieBreak` only compares declared keys of equally-placed candidates,
 * and every "decision" function returns a declarative outcome for a caller to act on later.
 * Sprint 10B implements, and may only implement, what is written here.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import { evaluateManualSelection, type FallbackMode, type ModelSelectionPolicy, type PolicyScopeType, type SelectionExclusionCode } from './model-selection-policy.js';
import { stableHash } from './prompt-assembly.js';
import type { ModelRecord } from './model-registry.js';

/** Bumped whenever the rules below change; recorded on every recommendation (§十七). */
export const ROUTER_VERSION = 'model-router/v1';

export const ROUTER_DECISIONS = [
  /** A recommendation was produced (AUTO/HYBRID). */
  'RECOMMENDED',
  /** Nothing survived the hard filters. Never guessed around (§十三). */
  'NO_ELIGIBLE_MODEL',
  /** The router service is not available; the caller must decide (§十四). */
  'ROUTER_NOT_AVAILABLE',
  /** MANUAL: the user named the model, so the router does not participate at all (§二). */
  'MANUAL_NOT_ROUTED',
  /** ASK: a recommendation exists but nothing may run until a human confirms (§十二). */
  'AWAITING_CONFIRMATION',
  /** A named model hit a hard block (blockedModels / diversity / policy): refused (§三). */
  'REFUSED_HARD_BLOCK',
] as const;
export type RouterDecision = (typeof ROUTER_DECISIONS)[number];

/* ------------------------------------------------------------ reason catalog --- */

/** WHY a model was recommended. Closed set: no free-text justifications (§七). */
export const ROUTER_POSITIVE_REASONS = [
  'MANUAL_EXPLICIT_CHOICE',
  'TASK_OVERRIDE',
  'ROLE_POLICY',
  'WORKFLOW_POLICY',
  'COMPANY_POLICY',
  'GLOBAL_DEFAULT',
  'REQUIRED_CAPABILITIES_MATCH',
  'PREFERRED_MODEL',
  'ALLOWED_PROVIDER',
  'PROVIDER_HEALTHY',
  'PROVIDER_DEGRADED',
  'CONTEXT_HEADROOM',
  'OUTPUT_LIMIT_SATISFIED',
  'WITHIN_COST_LIMIT',
  'LOWER_ESTIMATED_COST',
  'LOWER_ESTIMATED_LATENCY',
  'HISTORICAL_SUCCESS_RATE',
  'REVIEW_PASS_RATE',
  'LOW_REWORK_RATE',
  'BENCHMARK_SIGNAL',
  'NO_BENCHMARK_DATA',
  'SMALL_SAMPLE_DOWNWEIGHTED',
  'TIE_BREAK_APPLIED',
  /** Emitted when the latency stage has no comparable metadata: it filters nothing (§四). */
  'LATENCY_DATA_UNAVAILABLE',
] as const;
export type RouterPositiveReason = (typeof ROUTER_POSITIVE_REASONS)[number];

/** WHY a model was rejected. Every rejection carries at least one of these (§六). */
export const ROUTER_REJECTION_REASONS = [
  'MODEL_NOT_REGISTERED',
  'MODEL_DISABLED',
  'MODEL_UNAVAILABLE',
  'PROVIDER_NOT_ALLOWED',
  'PROVIDER_UNAVAILABLE',
  'MODEL_BLOCKED',
  'CAPABILITY_MISSING',
  'CONTEXT_TOO_SMALL',
  'OUTPUT_LIMIT_TOO_SMALL',
  'COST_LIMIT_EXCEEDED',
  'LATENCY_LIMIT_EXCEEDED',
  'DIVERSITY_CONFLICT',
  'RISK_CONSTRAINT_UNSATISFIED',
  'NOT_IN_CANDIDATE_SET',
] as const;
export type RouterRejectionReason = (typeof ROUTER_REJECTION_REASONS)[number];

export type RouterReasonCode = RouterPositiveReason | RouterRejectionReason;

/* ------------------------------------------------------- reason code producers --- */

/**
 * Who is allowed to PRODUCE a reason code (Closeout-10A.0.2 §八). A catalog entry is not a
 * promise that the Router produces it - three entries are explicitly not Router v1 output.
 */
export const REASON_CODE_PRODUCERS = [
  'POLICY',
  'HARD_FILTER',
  'RANKING',
  'ROUTER_SERVICE',
  'PROVIDER_LAYER',
  'RUNTIME',
  'FUTURE',
] as const;
export type ReasonCodeProducer = (typeof REASON_CODE_PRODUCERS)[number];

export const ROUTER_REASON_PRODUCERS: Readonly<Record<RouterReasonCode, ReasonCodeProducer>> = {
  // --- positive reasons -----------------------------------------------------------------
  MANUAL_EXPLICIT_CHOICE: 'POLICY',
  TASK_OVERRIDE: 'POLICY',
  ROLE_POLICY: 'POLICY',
  WORKFLOW_POLICY: 'POLICY',
  COMPANY_POLICY: 'POLICY',
  GLOBAL_DEFAULT: 'POLICY',
  REQUIRED_CAPABILITIES_MATCH: 'HARD_FILTER',
  PREFERRED_MODEL: 'RANKING',
  ALLOWED_PROVIDER: 'HARD_FILTER',
  PROVIDER_HEALTHY: 'RANKING',
  PROVIDER_DEGRADED: 'RANKING',
  CONTEXT_HEADROOM: 'RANKING',
  OUTPUT_LIMIT_SATISFIED: 'HARD_FILTER',
  WITHIN_COST_LIMIT: 'HARD_FILTER',
  LOWER_ESTIMATED_COST: 'RANKING',
  LOWER_ESTIMATED_LATENCY: 'RANKING',
  HISTORICAL_SUCCESS_RATE: 'RANKING',
  REVIEW_PASS_RATE: 'RANKING',
  LOW_REWORK_RATE: 'RANKING',
  BENCHMARK_SIGNAL: 'RANKING',
  NO_BENCHMARK_DATA: 'RANKING',
  SMALL_SAMPLE_DOWNWEIGHTED: 'RANKING',
  TIE_BREAK_APPLIED: 'RANKING',
  LATENCY_DATA_UNAVAILABLE: 'HARD_FILTER',
  // --- rejection reasons ----------------------------------------------------------------
  MODEL_NOT_REGISTERED: 'PROVIDER_LAYER',
  MODEL_DISABLED: 'HARD_FILTER',
  MODEL_UNAVAILABLE: 'HARD_FILTER',
  PROVIDER_NOT_ALLOWED: 'HARD_FILTER',
  PROVIDER_UNAVAILABLE: 'PROVIDER_LAYER',
  MODEL_BLOCKED: 'HARD_FILTER',
  CAPABILITY_MISSING: 'HARD_FILTER',
  CONTEXT_TOO_SMALL: 'HARD_FILTER',
  OUTPUT_LIMIT_TOO_SMALL: 'HARD_FILTER',
  COST_LIMIT_EXCEEDED: 'HARD_FILTER',
  /** Needs a comparable per-candidate latency source, which does not exist yet (§四). */
  LATENCY_LIMIT_EXCEEDED: 'FUTURE',
  DIVERSITY_CONFLICT: 'HARD_FILTER',
  RISK_CONSTRAINT_UNSATISFIED: 'HARD_FILTER',
  NOT_IN_CANDIDATE_SET: 'HARD_FILTER',
};

export const reasonProducerOf = (code: RouterReasonCode): ReasonCodeProducer => ROUTER_REASON_PRODUCERS[code];

/** The codes the frozen hard-filter rules actually emit (kept in sync by a test). */
export const HARD_FILTER_EMITTED_REASONS: readonly RouterRejectionReason[] = [
  'MODEL_DISABLED',
  'MODEL_UNAVAILABLE',
  'PROVIDER_NOT_ALLOWED',
  'NOT_IN_CANDIDATE_SET',
  'MODEL_BLOCKED',
  'CAPABILITY_MISSING',
  'CONTEXT_TOO_SMALL',
  'OUTPUT_LIMIT_TOO_SMALL',
  'COST_LIMIT_EXCEEDED',
  'RISK_CONSTRAINT_UNSATISFIED',
  'DIVERSITY_CONFLICT',
];

/* ----------------------------------------------------------------- latency mode --- */

/**
 * Sprint 10A.0.2 §四 — the honest latency contract.
 *
 * There is no comparable per-candidate latency metadata in v1, so `LATENCY_CONSTRAINT` is an
 * explicitly DECLARED NO-OP: it never eliminates a candidate and it never pretends `maxLatency`
 * was enforced. `LATENCY_LIMIT_EXCEEDED` is FUTURE-produced once such metadata exists.
 */
export const LATENCY_FILTER_MODE = 'NO_DATA_NO_HARD_FILTER' as const;

/* ----------------------------------------------------------- candidate pipeline --- */

/**
 * The FROZEN pipeline order (§四). Hard filters and ranking are separate stages:
 * everything up to `CandidateSet` is a hard filter (a rejection there is permanent), and only
 * the two stages after it may order what already survived.
 */
export const ROUTER_PIPELINE = [
  'ALL_REGISTERED_MODELS',
  'ENABLED_FILTER',
  'AVAILABILITY_FILTER',
  'PROVIDER_ALLOWED_FILTER',
  'BLOCKED_MODELS_FILTER',
  'REQUIRED_CAPABILITIES_FILTER',
  'CONTEXT_WINDOW_FILTER',
  'MAX_OUTPUT_FILTER',
  'COST_CONSTRAINT',
  'LATENCY_CONSTRAINT',
  'RISK_ROLE_CONSTRAINTS',
  'CANDIDATE_SET',
  'ROUTER_RANKING',
  'RECOMMENDATION',
] as const;
export type RouterPipelineStage = (typeof ROUTER_PIPELINE)[number];

/** The hard-filter stages, in order. Ranking may never undo one of these (§四/§二十一). */
export const ROUTER_HARD_FILTER_STAGES: readonly RouterPipelineStage[] = ROUTER_PIPELINE.slice(
  0,
  ROUTER_PIPELINE.indexOf('CANDIDATE_SET') + 1,
);

/** The stages that may only ORDER an already-filtered set. */
export const ROUTER_PRESENTATION_STAGES: readonly RouterPipelineStage[] = ['ROUTER_RANKING', 'RECOMMENDATION'];

/* --------------------------------------------------------------- ranking signals --- */

/**
 * Sprint 10A.0.2 MEDIUM-2: `ROUTER_V1_RANKING` below is the ONE authoritative signal catalog.
 * The older 10-key `RANKING_SIGNALS` list (with a conflicting `missing: 'NEUTRAL'` vocabulary)
 * was removed; signals that v1 does not rank are listed separately as `V1_NOT_RANKED_SIGNALS`.
 */
export const V1_NOT_RANKED_MARKER = 'V1_NOT_RANKED' as const;

export const V1_NOT_RANKED_SIGNALS = [
  {
    key: 'requiredCapabilityFit',
    marker: V1_NOT_RANKED_MARKER,
    note: 'Hard constraint, enforced by REQUIRED_CAPABILITIES_FILTER - never a ranking score.',
  },
  {
    key: 'reviewPassRate',
    marker: V1_NOT_RANKED_MARKER,
    note: 'Historical signal reserved for a later router version; not weighted in v1.',
  },
  {
    key: 'reworkRate',
    marker: V1_NOT_RANKED_MARKER,
    note: 'Historical signal reserved for a later router version; not weighted in v1.',
  },
] as const;
export type V1NotRankedSignal = (typeof V1_NOT_RANKED_SIGNALS)[number];

/** Hard constraints are NOT ranking signals: they remove candidates rather than rank them. */
export const RANKING_HARD_CONSTRAINTS: readonly string[] = [
  'ENABLED_FILTER',
  'AVAILABILITY_FILTER',
  'PROVIDER_ALLOWED_FILTER',
  'BLOCKED_MODELS_FILTER',
  'REQUIRED_CAPABILITIES_FILTER',
  'CONTEXT_WINDOW_FILTER',
  'MAX_OUTPUT_FILTER',
  'COST_CONSTRAINT',
  'RISK_ROLE_CONSTRAINTS',
];

/** A benchmark signal may never dominate: 15% of the total is the documented ceiling (§九). */
export const BENCHMARK_WEIGHT_CAP = 0.15;

/* ------------------------------------------------- Router v1 numeric policy (§STEP 2) --- */

/**
 * One row of the FROZEN Router v1 ranking policy. Every signal must declare all six facts, so
 * an implementer cannot invent semantics later (Closeout-10A STEP 2).
 */
export interface RankingSignalPolicyV1 {
  readonly key: string;
  /** Relative weight; all v1 weights sum to exactly 1 (see `ROUTER_V1_WEIGHTS`). */
  readonly weight: number;
  readonly source: string;
  /** Missing data always means "skip the signal and renormalise", never "score it zero". */
  readonly missing: 'SKIP_AND_RENORMALISE';
  readonly normalization: string;
  readonly maxWeight: number;
  /** Whether this signal may be used by the stable tie-break (§十一). */
  readonly tieBreak: boolean;
  /** FROZEN: no ranking signal may ever overcome a hard filter. */
  readonly canBreakHardFilter: false;
}

/** The order is the ranking order: user preference first, benchmark last (§八/STEP 2). */
export const ROUTER_V1_RANKING: readonly RankingSignalPolicyV1[] = [
  {
    key: 'preferredModelsPosition',
    weight: 0.25,
    source: 'RouterPolicyView.preferredModels (user/policy preference order)',
    missing: 'SKIP_AND_RENORMALISE',
    normalization: 'ordinal: position 0 → 1.0 · 1 → 0.6 · 2 → 0.3 · not preferred → 0',
    maxWeight: 0.25,
    tieBreak: true,
    canBreakHardFilter: false,
  },
  {
    key: 'providerHealth',
    weight: 0.2,
    source: 'ProviderRegistry registration lastHealth',
    missing: 'SKIP_AND_RENORMALISE',
    normalization: 'healthy → 1.0 · degraded → 0.5 · unknown → 0.25 (unavailable never reaches ranking)',
    maxWeight: 0.2,
    tieBreak: true,
    canBreakHardFilter: false,
  },
  {
    key: 'contextHeadroom',
    weight: 0.15,
    source: 'ModelRecord.contextWindow vs estimatedInputTokens + requiredOutputTokens',
    missing: 'SKIP_AND_RENORMALISE',
    normalization: 'min(1, (contextWindow − estimatedInput − requiredOutput) / contextWindow), clamped to [0,1]',
    maxWeight: 0.15,
    tieBreak: false,
    canBreakHardFilter: false,
  },
  {
    key: 'estimatedCost',
    weight: 0.15,
    source: 'ModelRecord.pricing.inputPerMillion (+ outputPerMillion)',
    missing: 'SKIP_AND_RENORMALISE',
    normalization: 'within the candidate set: 1 − (cost − min) / (max − min); all equal → 0.5 (neutral)',
    maxWeight: 0.15,
    tieBreak: true,
    canBreakHardFilter: false,
  },
  {
    key: 'estimatedLatency',
    weight: 0.1,
    source: 'historical avgLatencyMs, else provider health latency baseline',
    missing: 'SKIP_AND_RENORMALISE',
    normalization: 'same min/max inversion as cost; unknown for every candidate → 0.5 (neutral)',
    maxWeight: 0.1,
    tieBreak: true,
    canBreakHardFilter: false,
  },
  {
    key: 'historicalSuccessRate',
    weight: 0.05,
    source: 'HistoricalPerformanceSnapshot.successRate (+ reviewPassRate, reworkRate)',
    missing: 'SKIP_AND_RENORMALISE',
    normalization: 'successRate × sampleConfidence(sampleCount) (0 samples → signal skipped; <20 scaled)',
    maxWeight: 0.05,
    tieBreak: false,
    canBreakHardFilter: false,
  },
  {
    key: 'benchmarkMetadata',
    weight: 0.1,
    source: 'BenchmarkReference (harness vs external, with benchmarkVersion)',
    missing: 'SKIP_AND_RENORMALISE',
    normalization: 'score × effectiveBenchmarkWeight(base, reference) — capped at 0.15 of the total',
    maxWeight: BENCHMARK_WEIGHT_CAP,
    tieBreak: false,
    canBreakHardFilter: false,
  },
];

export const ROUTER_V1_WEIGHTS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(ROUTER_V1_RANKING.map((signal) => [signal.key, signal.weight])),
);

export interface RouterV1Policy {
  readonly version: string;
  readonly stageOrder: readonly string[];
  readonly signals: readonly RankingSignalPolicyV1[];
  readonly weights: Readonly<Record<string, number>>;
  readonly benchmarkWeightCap: number;
  readonly historicalMinSample: number;
}

/** The frozen v1 policy as data. Sprint 10B implements exactly this, nothing more. */
export const routerV1Policy = (): RouterV1Policy => ({
  version: ROUTER_VERSION,
  stageOrder: [
    'HARD_FILTERS',
    'USER_PREFERENCE',
    'PROVIDER_HEALTH',
    'CONTEXT_HEADROOM',
    'COST',
    'LATENCY',
    'HISTORICAL_PERFORMANCE',
    'BENCHMARK',
    'STABLE_TIE_BREAK',
  ],
  signals: ROUTER_V1_RANKING,
  weights: ROUTER_V1_WEIGHTS,
  benchmarkWeightCap: BENCHMARK_WEIGHT_CAP,
  historicalMinSample: HISTORICAL_MIN_SAMPLE,
});

/** Fewer than this many samples is a small sample and must be down-weighted (§十). */
export const HISTORICAL_MIN_SAMPLE = 20;

/** Signals that a model must satisfy rather than merely score better on (§十五). */
/** The order is the ranking order: user preference first, benchmark last (§八/STEP 2). */

/* ------------------------------------------------------------------- tie-breaks --- */

/**
 * The deterministic tie-break order (§十一). Applied only to candidates that already share the
 * same placement; it never re-ranks a rejected model. Lexical modelKey is the final key, so the
 * order is total and reproducible.
 */
export const TIE_BREAK_KEYS = [
  'PREFERRED_POSITION',
  'LOWER_ESTIMATED_COST',
  'LOWER_ESTIMATED_LATENCY',
  'HIGHER_PROVIDER_HEALTH',
  'LEXICAL_MODEL_KEY',
] as const;
export type TieBreakKey = (typeof TIE_BREAK_KEYS)[number];

export const tieBreakContract = (): readonly TieBreakKey[] => [...TIE_BREAK_KEYS];

export interface TieBreakFacts {
  readonly modelKey: string;
  readonly preferredPosition: number | null;
  readonly estimatedCost: number | null;
  readonly estimatedLatencyMs: number | null;
  readonly providerHealth: 'healthy' | 'degraded' | 'unavailable' | 'unknown';
}

const healthRank = (health: TieBreakFacts['providerHealth']): number =>
  health === 'healthy' ? 0 : health === 'degraded' ? 1 : health === 'unknown' ? 2 : 3;

/**
 * Total, deterministic comparator over tie-break facts. It is NOT a ranking model: it consumes
 * no scores, only the declared keys, and two identical inputs always produce the same ordering
 * (§十一, tests N/O).
 */
export function compareTieBreak(left: TieBreakFacts, right: TieBreakFacts): number {
  if (left.preferredPosition !== right.preferredPosition) {
    const leftRank = left.preferredPosition ?? Number.MAX_SAFE_INTEGER;
    const rightRank = right.preferredPosition ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }
  const cost = (left.estimatedCost ?? Number.MAX_SAFE_INTEGER) - (right.estimatedCost ?? Number.MAX_SAFE_INTEGER);
  if (cost !== 0) return cost;
  const latency =
    (left.estimatedLatencyMs ?? Number.MAX_SAFE_INTEGER) - (right.estimatedLatencyMs ?? Number.MAX_SAFE_INTEGER);
  if (latency !== 0) return latency;
  const health = healthRank(left.providerHealth) - healthRank(right.providerHealth);
  if (health !== 0) return health;
  return left.modelKey < right.modelKey ? -1 : left.modelKey > right.modelKey ? 1 : 0;
}

/* ------------------------------------------------------------------- contracts --- */

export interface HistoricalPerformanceSnapshot {
  readonly modelKey: string;
  readonly successRate: number | null;
  readonly reviewPassRate: number | null;
  readonly reworkRate: number | null;
  readonly failureRate: number | null;
  readonly avgLatencyMs: number | null;
  readonly avgCost: number | null;
  readonly sampleCount: number;
}

/**
 * Confidence in a historical snapshot (§十).
 * - no samples (or no snapshot) -> 0, i.e. NEUTRAL, never "bad";
 * - a small sample is scaled down, never treated as authoritative;
 * - at/above `HISTORICAL_MIN_SAMPLE` it is 1.
 */
export function sampleConfidence(snapshot: HistoricalPerformanceSnapshot | null | undefined): number {
  if (snapshot === null || snapshot === undefined) return 0;
  if (snapshot.sampleCount <= 0) return 0;
  if (snapshot.sampleCount >= HISTORICAL_MIN_SAMPLE) return 1;
  return Number((snapshot.sampleCount / HISTORICAL_MIN_SAMPLE).toFixed(4));
}

export interface BenchmarkReference {
  /** Absent when no benchmark data exists: the router must still work (§九/J). */
  readonly modelKey: string;
  readonly score: number;
  readonly suiteId: string;
  readonly benchmarkVersion: string;
  /** `external` numbers are unverified and must be distinguishable (§九). */
  readonly source: 'harness' | 'external';
  readonly recordedAt: string;
  readonly stale: boolean;
}

/**
 * DEPRECATED (Sprint 10B.1 §十): do NOT fold this into a benchmark signal score.
 *
 * The ranking engine applies the stale/source ADJUSTMENT to the raw score and multiplies the frozen
 * weight (0.10, cap 0.15) exactly ONCE in the weighted total. Folding this helper's result into the
 * signal score would multiply the weight twice and make the declared weight unreachable. It remains
 * exported only for the weight-cap documentation and existing importers.
 */
export function effectiveBenchmarkWeight(
  reference: BenchmarkReference | null | undefined,
  baseWeight: number,
): number {
  if (reference === null || reference === undefined) return 0;
  const capped = Math.min(Math.max(baseWeight, 0), BENCHMARK_WEIGHT_CAP);
  // Stale or externally-sourced numbers contribute less, never more.
  if (reference.stale) return Number((capped * 0.5).toFixed(4));
  return reference.source === 'external' ? Number((capped * 0.75).toFixed(4)) : capped;
}

export const MODEL_DIVERSITY_CONSTRAINTS = [
  'NONE',
  'DIFFERENT_FROM_PREVIOUS_ROLE',
  /**
   * Neutral name for the user's `DIFFERENT_FROM_DEVELOPER` (ADR-0014 §14): Core may not use
   * Industry-Pack vocabulary (ADR-0002), so the *role* name belongs to the upper layer / pack.
   */
  'DIFFERENT_FROM_PRIOR_ROLE_SELECTION',
  'DIFFERENT_PROVIDER',
] as const;
export type ModelDiversityConstraint = (typeof MODEL_DIVERSITY_CONSTRAINTS)[number];

export interface DiversityContext {
  readonly constraint: ModelDiversityConstraint;
  /** Model keys already chosen earlier in the same workflow run, in order. */
  readonly previousModelKeys: readonly string[];
  /** The provider of the reference role's selection (the role the constraint refers to). */
  readonly priorRoleProviderId: string | null;
}

/** Pure diversity check: returns the rejection reason, or null when the candidate is allowed. */
export function checkDiversity(
  candidate: Pick<ModelRecord, 'modelKey' | 'providerId'>,
  context: DiversityContext,
): RouterRejectionReason | null {
  switch (context.constraint) {
    case 'NONE':
      return null;
    case 'DIFFERENT_FROM_PREVIOUS_ROLE':
    case 'DIFFERENT_FROM_PRIOR_ROLE_SELECTION':
      return context.previousModelKeys.includes(candidate.modelKey) ? 'DIVERSITY_CONFLICT' : null;
    case 'DIFFERENT_PROVIDER':
      return context.priorRoleProviderId !== null && context.priorRoleProviderId === candidate.providerId
        ? 'DIVERSITY_CONFLICT'
        : null;
    default:
      return null;
  }
}

/** Risk -> router constraint hooks (§十五). Contract only: no business rules are hard-coded. */
export const ROUTER_RISK_CONSTRAINT_HOOKS = [
  'ALLOW_LOW_COST_MODELS',
  'REQUIRE_REASONING_CAPABILITY',
  'REQUIRE_MINIMUM_QUALITY_TIER',
  'REQUIRE_MANUAL_CONFIRMATION',
] as const;
export type RouterRiskConstraintHook = (typeof ROUTER_RISK_CONSTRAINT_HOOKS)[number];

export interface RouterRiskConstraint {
  readonly riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly hooks: readonly RouterRiskConstraintHook[];
}

/* ------------------------------------------------------------- request/response --- */

/** The provenance half of a policy view (kept for "why then" questions, §十七). */
export interface RouterPolicySnapshot {
  readonly policyId: string | null;
  readonly mode: 'MANUAL' | 'AUTO' | 'HYBRID' | null;
  /**
   * SEMANTIC version (10A.0.3 §一): always `<policyId|no-policy>@<contentDigest>`, computed by
   * `deriveRouterPolicyView`. It is content-bound, reproducible across clocks, and verified by
   * `assertDerivedPolicyView`. A wall clock must never reach this field.
   */
  readonly snapshotVersion: string;
  /** Provenance timestamp: excluded from the digest, the semantic version and routing. */
  readonly generatedAt: string;
}

/**
 * `RouterPolicyView` (Closeout-10A STEP 3) — the ONLY thing the router may consume as policy.
 *
 * It is produced by `deriveRouterPolicyView()` (and, in production, by the Model Selection
 * Policy service). Callers must NOT hand-assemble the filter lists: interpreting a policy in two
 * different places is exactly how two callers end up disagreeing about the same policy.
 */
export interface RouterPolicyView {
  readonly source: RouterPolicySnapshot;
  /** Authoritative scope fields (10A.0.3 §四): no consumer may invent a scope default. */
  readonly scopeType: PolicyScopeType | null;
  readonly scopeId: string | null;
  /** Authoritative fallback (10A.0.3 §四): the single field every consumer reads. */
  readonly fallback: FallbackMode;
  readonly allowedModels: readonly string[];
  readonly blockedModels: readonly string[];
  readonly allowedProviders: readonly string[];
  /** ORDER SEMANTICS: position 0 carries the highest preference (0.25 weight). Never sorted. */
  readonly preferredModels: readonly string[];
  /** Requirements that came from the policy itself (never a caller's free choice). */
  readonly requiredCapabilities: readonly string[];
  readonly maxCost: number | null;
  readonly maxLatency: number | null;
  /** Marks the view as derived; pure rules refuse a view that was not derived. */
  readonly derivedBy: typeof ROUTER_POLICY_VIEW_ORIGIN;
  /** Content digest over EVERY safety-relevant field (10A.0.3 §一/§三). */
  readonly digest: string;
}

/** The only sanctioned producer tag of a `RouterPolicyView`. */
export const ROUTER_POLICY_VIEW_ORIGIN = 'model-selection-policy-service';

export interface DeriveRouterPolicyViewInput {
  readonly policy: ModelSelectionPolicy | null;
  /** Declared at the call site by the Policy service (e.g. stage/role requirements). */
  readonly requiredCapabilities?: readonly string[];
  /**
   * Provenance timestamp only (10A.0.3 §一). It is NOT an input to the digest or the semantic
   * version, so callers may pass a clock without affecting determinism.
   */
  readonly generatedAt?: string;
  /**
   * DEPRECATED and IGNORED (10A.0.3 §一): kept only so older call sites still type-check. The
   * semantic version is always `<policyId|no-policy>@<contentDigest>`; a caller-supplied value is
   * never honored, so a wall clock cannot leak into provenance semantics.
   */
  readonly snapshotVersion?: string;
}

/**
 * The canonical digest input (10A.0.3 §二/§三): set-semantics lists are sorted, order-semantics
 * lists keep their order, and every safety-relevant scalar/scope field participates.
 */
interface DigestParts {
  readonly sets: readonly (readonly string[])[];
  readonly ordered: readonly (readonly string[])[];
  readonly numbers: readonly (number | null)[];
  readonly scalars: readonly (string | null)[];
}

/**
 * Typed canonical encoding (10A.0.4 §六): every token carries its type, so `null` / `"null"`,
 * `0` / `"0"` and `false` / `"false"` cannot collide. Strings are length-prefixed so that
 * concatenation can never be ambiguous either.
 */
const typedToken = (value: string | number | boolean | null | undefined): string => {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') return `num:${String(value)}`;
  if (typeof value === 'boolean') return `bool:${String(value)}`;
  return `str:${String(value.length)}:${value}`;
};

const canonicalDigest = (parts: DigestParts): string =>
  stableHash(
    [
      ...parts.sets.map((values) => `set:${[...values].map((value) => typedToken(value)).sort().join('|')}`),
      ...parts.ordered.map((values) => `ord:${[...values].map((value) => typedToken(value)).join('|')}`),
      ...parts.numbers.map((value) => `num-${typedToken(value)}`),
      ...parts.scalars.map((value) => `sca-${typedToken(value)}`),
    ].join('\u0000'),
  );

const digestPartsOf = (view: {
  readonly scopeType: PolicyScopeType | null;
  readonly scopeId: string | null;
  readonly fallback: FallbackMode;
  readonly allowedModels: readonly string[];
  readonly blockedModels: readonly string[];
  readonly allowedProviders: readonly string[];
  readonly preferredModels: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly maxCost: number | null;
  readonly maxLatency: number | null;
  readonly source: Pick<RouterPolicySnapshot, 'policyId' | 'mode'>;
}): DigestParts => ({
  sets: [view.allowedModels, view.blockedModels, view.allowedProviders, view.requiredCapabilities],
  ordered: [view.preferredModels],
  numbers: [view.maxCost, view.maxLatency],
  scalars: [view.source.policyId, view.source.mode, view.scopeType, view.scopeId, view.fallback],
});

/** Recompute a view's content digest - lets a caller cross-check `snapshotVersion` (§一 test E). */
export const contentDigestOf = (view: RouterPolicyView): string => canonicalDigest(digestPartsOf(view));

const snapshotVersionOf = (policyId: string | null, digest: string): string =>
  `${policyId ?? 'no-policy'}@${digest}`;

/** Derive the view from the RESOLVED policy. Pure, deterministic and content-bound. */
export function deriveRouterPolicyView(input: DeriveRouterPolicyViewInput): RouterPolicyView {
  const policy = input.policy;
  const allowedModels = [...(policy?.allowedModels ?? [])];
  const blockedModels = [...(policy?.blockedModels ?? [])];
  const allowedProviders = [...(policy?.allowedProviders ?? [])];
  const preferredModels = [...(policy?.preferredModels ?? [])]; // order preserved on purpose
  const requiredCapabilities = [
    ...new Set([...(policy?.requiredCapabilities ?? []), ...(input.requiredCapabilities ?? [])]),
  ];
  const draft = {
    scopeType: policy?.scopeType ?? null,
    scopeId: policy?.scopeId ?? null,
    fallback: policy?.allowFallback ?? 'NEVER',
    allowedModels,
    blockedModels,
    allowedProviders,
    preferredModels,
    requiredCapabilities,
    maxCost: policy?.maxCost ?? null,
    maxLatency: policy?.maxLatency ?? null,
    source: { policyId: policy?.id ?? null, mode: policy?.mode ?? null },
  };
  const digest = canonicalDigest(digestPartsOf(draft));
  // 10A.0.4 §七: the claim "immutable" is enforced, not documented: the derived view and its
  // arrays are actually frozen, so later mutation fails early instead of silently diverging.
  return Object.freeze({
    source: Object.freeze({
      policyId: draft.source.policyId,
      mode: draft.source.mode,
      snapshotVersion: snapshotVersionOf(draft.source.policyId, digest),
      generatedAt: input.generatedAt ?? '',
    }),
    scopeType: draft.scopeType,
    scopeId: draft.scopeId,
    fallback: draft.fallback,
    allowedModels: Object.freeze([...allowedModels]),
    blockedModels: Object.freeze([...blockedModels]),
    allowedProviders: Object.freeze([...allowedProviders]),
    preferredModels: Object.freeze([...preferredModels]),
    requiredCapabilities: Object.freeze([...requiredCapabilities]),
    maxCost: draft.maxCost,
    maxLatency: draft.maxLatency,
    derivedBy: ROUTER_POLICY_VIEW_ORIGIN,
    digest,
  });
}

/**
 * Selection exclusion fact -> Router reason code (10A.0.4 §二). One table, so MANUAL/HYBRID/AUTO
 * and the router can never disagree about the FACT for the same candidate and the same rules.
 */
export const SELECTION_EXCLUSION_TO_ROUTER_REASON: Readonly<
  Record<SelectionExclusionCode, RouterRejectionReason>
> = {
  MODEL_NOT_REGISTERED: 'MODEL_NOT_REGISTERED',
  MODEL_DISABLED: 'MODEL_DISABLED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  /** Hard block -> the router's blocked reason. */
  MODEL_BLOCKED_BY_POLICY: 'MODEL_BLOCKED',
  /** RANGE exclusion -> the router's "not in the candidate set" reason (crossable by explicit choice). */
  NOT_IN_ALLOWED_RANGE: 'NOT_IN_CANDIDATE_SET',
  PROVIDER_NOT_ALLOWED: 'PROVIDER_NOT_ALLOWED',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
  COST_LIMIT_EXCEEDED: 'COST_LIMIT_EXCEEDED',
};

const ROUTER_POLICY_VIEW_ENUMS = {
  mode: ['MANUAL', 'AUTO', 'HYBRID'],
  fallback: ['NEVER', 'ASK', 'AUTO_WITHIN_POLICY'],
  scopeType: ['COMPANY', 'WORKFLOW', 'ROLE', 'TASK'],
} as const;

/**
 * STRUCTURE FIRST (10A.0.4 §三/§四/§五): every required field is checked for presence, type and
 * enum membership BEFORE anything is canonicalised. A malformed view can therefore never reach
 * the digest (previously a missing list produced a native TypeError) and no consumer can invent
 * a default.
 */
export function validateRouterPolicyViewShape(view: unknown): Result<true, DomainError> {
  const fail = (reason: string, details: Readonly<Record<string, unknown>> = {}): Result<true, DomainError> =>
    err(domainError('VALIDATION_FAILED', `RouterPolicyView shape invalid: ${reason}`, { reason, ...details }));

  try {
    if (view === null || typeof view !== 'object') return fail('not an object');
    const candidate = view as Record<string, unknown>;
    const source = candidate['source'];
    if (source === null || typeof source !== 'object') return fail('missing source');
    const sourceRecord = source as Record<string, unknown>;

    for (const field of ['policyId', 'mode', 'snapshotVersion', 'generatedAt'] as const) {
      if (!(field in sourceRecord) || sourceRecord[field] === undefined) {
        return fail(`missing source.${field}`, { field: `source.${field}` });
      }
    }
    if (sourceRecord['policyId'] !== null && typeof sourceRecord['policyId'] !== 'string') {
      return fail('source.policyId must be a string or null');
    }
    if (typeof sourceRecord['snapshotVersion'] !== 'string') return fail('source.snapshotVersion must be a string');
    if (typeof sourceRecord['generatedAt'] !== 'string') return fail('source.generatedAt must be a string');
    if (sourceRecord['mode'] !== null && !ROUTER_POLICY_VIEW_ENUMS.mode.includes(sourceRecord['mode'] as never)) {
      return fail('source.mode is not a known selection mode', { value: sourceRecord['mode'] });
    }
    for (const field of ['derivedBy', 'digest'] as const) {
      if (typeof candidate[field] !== 'string') return fail(`missing ${field}`);
    }
    if (candidate['scopeType'] === undefined) return fail('missing scopeType');
    if (candidate['scopeId'] === undefined) return fail('missing scopeId');
    if (candidate['scopeId'] !== null) {
      if (typeof candidate['scopeId'] !== 'string') return fail('scopeId must be a string or null');
      if (candidate['scopeId'].trim().length === 0) return fail('scopeId must not be blank');
    }
    if (candidate['fallback'] === undefined) return fail('missing fallback');
    if (candidate['scopeType'] !== null && !ROUTER_POLICY_VIEW_ENUMS.scopeType.includes(candidate['scopeType'] as never)) {
      return fail('scopeType is not a known policy scope', { value: candidate['scopeType'] });
    }
    if (!ROUTER_POLICY_VIEW_ENUMS.fallback.includes(candidate['fallback'] as never)) {
      return fail('fallback is not a known fallback mode', { value: candidate['fallback'] });
    }
    for (const field of [
      'allowedModels',
      'blockedModels',
      'allowedProviders',
      'preferredModels',
      'requiredCapabilities',
    ] as const) {
      if (candidate[field] === undefined) return fail(`missing ${field}`, { field });
      if (!Array.isArray(candidate[field])) return fail(`${field} must be an array`, { field });
      for (const entry of candidate[field] as readonly unknown[]) {
        if (typeof entry !== 'string') return fail(`${field} must contain only strings`, { field });
      }
    }
    for (const field of ['maxCost', 'maxLatency'] as const) {
      if (candidate[field] === undefined) return fail(`missing ${field}`);
      const value = candidate[field];
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        return fail(`${field} must be a finite number or null`, { field });
      }
    }
    return ok(true);
  } catch (error) {
    // Defensive: a hostile/proxy object must not be able to throw past the validator (§四).
    return fail('threw while validating', { message: error instanceof Error ? error.message : String(error) });
  }
}

/** Refuse a hand-assembled, incomplete, malformed or tampered view (STEP 3 / 10A.0.3 / 10A.0.4). */
export function assertDerivedPolicyView(view: RouterPolicyView): Result<true, DomainError> {
  // One safety boundary around EVERY step (10A.0.5 §六): shape -> derivedBy -> digest -> version.
  // A hostile object (including a stateful Proxy whose getter throws on a later read) must always
  // come back as VALIDATION_FAILED, never as a native exception.
  try {
    const shape = validateRouterPolicyViewShape(view);
    if (!shape.ok) return shape;
    if (view.derivedBy !== ROUTER_POLICY_VIEW_ORIGIN) {
      return err(
        domainError('VALIDATION_FAILED', 'A RouterPolicyView must be derived, not hand-assembled.', {
          derivedBy: view.derivedBy,
        }),
      );
    }
    const expected = contentDigestOf(view);
    if (expected !== view.digest) {
      return err(
        domainError('VALIDATION_FAILED', 'This RouterPolicyView was modified after it was derived.', {
          expected,
          actual: view.digest,
        }),
      );
    }
    const expectedVersion = snapshotVersionOf(view.source.policyId, expected);
    if (view.source.snapshotVersion !== expectedVersion) {
      return err(
        domainError('VALIDATION_FAILED', 'This RouterPolicyView carries a snapshotVersion that is not content-bound.', {
          expected: expectedVersion,
          actual: view.source.snapshotVersion,
        }),
      );
    }
    return ok(true);
  } catch (error) {
    return err(
      domainError('VALIDATION_FAILED', 'The RouterPolicyView could not be validated safely.', {
        reason: 'threw while validating',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export interface RouterRequest {
  readonly requestId: string;
  readonly companyId: string;
  readonly workflowId?: string | null;
  readonly workflowVersionId?: string | null;
  readonly runId?: string | null;
  readonly stageId?: string | null;
  readonly taskId: string;
  readonly roleId: string;
  readonly selectionMode: 'MANUAL' | 'AUTO' | 'HYBRID';
  /** The resolved policy view (STEP 3): never hand-assembled by the caller. */
  readonly policyView: RouterPolicyView;
  readonly estimatedInputTokens: number;
  readonly requiredOutputTokens?: number | null;
  readonly maxCost?: number | null;
  readonly maxLatency?: number | null;
  readonly riskConstraint?: RouterRiskConstraint | null;
  readonly diversity?: DiversityContext | null;
  /** Set only for MANUAL (or an explicit override): the router must not touch it. */
  readonly manualModelKey?: string | null;
  /** The models the caller may consider (already registered in the registry). */
  readonly candidateModels: readonly ModelRecord[];
  readonly performanceMetadata?: readonly HistoricalPerformanceSnapshot[] | null;
  readonly benchmarkMetadata?: readonly BenchmarkReference[] | null;
  readonly traceId: string;
}

export interface CandidateEvaluation {
  readonly modelKey: string;
  readonly eligible: boolean;
  readonly reasons: readonly RouterPositiveReason[];
  readonly rejections: readonly RouterRejectionReason[];
  /**
   * Ranking detail (Sprint 10B, additive): present for candidates that survived the hard filters,
   * so a score can always be explained signal by signal (§十六). Hard-filter-only evaluations carry
   * empty/zero detail (no signal was computed for them).
   */
  readonly signalScores: readonly {
    readonly key: string;
    readonly weight: number;
    readonly score: number | null;
    readonly skipped?: string | null;
  }[];
  readonly availableWeights: number;
  readonly normalisedScore: number;
  readonly reasonCodes: readonly RouterPositiveReason[];
  readonly tieBreakFacts: TieBreakFacts;
}

export interface RejectedCandidate {
  readonly modelKey: string;
  readonly reasons: readonly RouterRejectionReason[];
}

/** The "no candidate" explanation the UI may show verbatim (§十三). */
export interface RejectionSummary {
  readonly checked: number;
  readonly byReason: Readonly<Partial<Record<RouterRejectionReason, number>>>;
  readonly summaryText: string;
}

export interface ModelRecommendation {
  readonly selectedModelKey: string | null;
  readonly decision: RouterDecision;
  readonly reasonCodes: readonly RouterReasonCode[];
  readonly rejectedCandidates: readonly RejectedCandidate[];
  readonly candidateEvaluations: readonly CandidateEvaluation[];
  /** Required for `NO_ELIGIBLE_MODEL`: the audit narrative of why nothing was eligible (§十三). */
  readonly rejectionSummary: RejectionSummary | null;
  readonly policySource: RouterPolicySnapshot;
  readonly selectionMode: RouterRequest['selectionMode'];
  readonly fallbackPolicy: FallbackMode;
  readonly estimatedCost: number | null;
  readonly estimatedLatency: number | null;
  readonly confidence: number | null;
  readonly routerVersion: string;
  readonly traceId: string;
  /** Provenance for the "why then" question (§十七). */
  readonly provenance: RouterProvenance;
}

export interface RouterProvenance {
  readonly routerVersion: string;
  readonly policySnapshotVersion: string;
  readonly modelRegistryRevision: string;
  readonly benchmarkVersion: string | null;
  readonly performanceSnapshot: string | null;
}

/* --------------------------------------------------------------- pure rules --- */

/** MANUAL never reaches the router (§二/§二十 A). */
export const routerAppliesTo = (mode: RouterRequest['selectionMode']): boolean => mode !== 'MANUAL';

/**
 * HIGH-1 (Closeout-10A.0.2): the FIRST rule any `ModelRouterPort.recommend()` implementation must
 * run. MANUAL is not "discouraged" - it is refused, and a request that carries a manual model key
 * is refused even if its mode claims AUTO/HYBRID.
 */
export function assertRouterRequestAllowed(request: RouterRequest): Result<true, DomainError> {
  if (request.selectionMode === 'MANUAL') {
    return err(
      domainError('MANUAL_NOT_ROUTED', 'MANUAL is never routed: the user named the model.', {
        decision: 'MANUAL_NOT_ROUTED',
        selectionMode: request.selectionMode,
      }),
    );
  }
  if ((request.manualModelKey ?? '').trim().length > 0) {
    return err(
      domainError('MANUAL_NOT_ROUTED', 'This request carries an explicit model, so the router must not run.', {
        decision: 'MANUAL_NOT_ROUTED',
        manualModelKey: request.manualModelKey ?? null,
      }),
    );
  }
  if (request.policyView.source.mode === 'MANUAL') {
    return err(
      domainError('MANUAL_NOT_ROUTED', 'The policy snapshot is MANUAL, so there is nothing to route.', {
        decision: 'MANUAL_NOT_ROUTED',
        policyId: request.policyView.source.policyId,
      }),
    );
  }
  return ok(true);
}

declare const FILTERED_CANDIDATE_SET: unique symbol;

/**
 * A nominally-branded candidate set (10A.0.3 §六). The runtime value is a plain frozen array, but
 * the brand symbol is NOT exported, so only `applyHardFilters` can produce the type: a raw
 * `ModelRecord[]` cannot be passed to the ranking entry point by typo or by design.
 */
export type FilteredCandidateSet = readonly ModelRecord[] & {
  readonly [FILTERED_CANDIDATE_SET]: 'FilteredCandidateSet';
};

const brandCandidateSet = (models: readonly ModelRecord[]): FilteredCandidateSet =>
  models as unknown as FilteredCandidateSet;

/** The ranking entry point: it accepts the branded set and nothing else. */
export const assertRankingInput = (set: FilteredCandidateSet): readonly ModelRecord[] => set;

export interface HardFilterOutcome {
  /** The survivors, branded (10A.0.3 §六): the ONLY candidate list this module exposes. */
  readonly candidates: FilteredCandidateSet;
  readonly rejected: readonly RejectedCandidate[];
  readonly evaluations: readonly CandidateEvaluation[];
  readonly checked: number;
  /** Honest statement about the latency stage (see `LATENCY_FILTER_MODE`). */
  readonly latencyFilter: typeof LATENCY_FILTER_MODE;
}

const reject = (map: Map<string, RouterRejectionReason[]>, modelKey: string, reason: RouterRejectionReason): void => {
  const existing = map.get(modelKey) ?? [];
  if (!existing.includes(reason)) existing.push(reason);
  map.set(modelKey, existing);
};

/**
 * The hard-filter stage (§四). Pure, ordered, deterministic — and it NEVER orders, scores or
 * selects: it only removes models that must not be considered, recording why.
 *
 * Entrance order (Closeout-10A.0.2):
 *   assertRouterRequestAllowed  →  assertDerivedPolicyView  →  hard filters
 */
export function applyHardFilters(request: RouterRequest): Result<HardFilterOutcome, DomainError> {
  const allowed = assertRouterRequestAllowed(request);
  if (!allowed.ok) return allowed;
  const derived = assertDerivedPolicyView(request.policyView);
  if (!derived.ok) return derived;

  const rejections = new Map<string, RouterRejectionReason[]>();
  const view = request.policyView;
  const allowedModels = new Set(view.allowedModels);
  const blockedModels = new Set(view.blockedModels);
  const allowedProviders = new Set(view.allowedProviders);

  const candidates: ModelRecord[] = [];
  for (const model of request.candidateModels) {
    const before = rejections.get(model.modelKey)?.length ?? 0;

    // ENABLED_FILTER
    if (!model.enabled) reject(rejections, model.modelKey, 'MODEL_DISABLED');
    // AVAILABILITY_FILTER
    if (model.availability === 'unavailable') reject(rejections, model.modelKey, 'MODEL_UNAVAILABLE');
    // PROVIDER_ALLOWED_FILTER
    if (allowedProviders.size > 0 && !allowedProviders.has(model.providerId)) {
      reject(rejections, model.modelKey, 'PROVIDER_NOT_ALLOWED');
    }
    // BLOCKED_MODELS_FILTER (hard block: even an explicit user choice is refused, ADR-0011 §3)
    if (blockedModels.has(model.modelKey)) reject(rejections, model.modelKey, 'MODEL_BLOCKED');
    // The allowed-model set is a range, not a hard block (ADR-0011 §3 distinguishes the two).
    if (allowedModels.size > 0 && !allowedModels.has(model.modelKey)) {
      reject(rejections, model.modelKey, 'NOT_IN_CANDIDATE_SET');
    }
    // REQUIRED_CAPABILITIES_FILTER
    for (const capability of view.requiredCapabilities) {
      const value = (model.capabilities as unknown as Record<string, unknown>)[capability];
      if (value !== true) reject(rejections, model.modelKey, 'CAPABILITY_MISSING');
    }
    // CONTEXT_WINDOW_FILTER
    if (model.contextWindow < request.estimatedInputTokens) reject(rejections, model.modelKey, 'CONTEXT_TOO_SMALL');
    // MAX_OUTPUT_FILTER
    if (
      request.requiredOutputTokens !== undefined &&
      request.requiredOutputTokens !== null &&
      model.maxOutputTokens !== null &&
      model.maxOutputTokens < request.requiredOutputTokens
    ) {
      reject(rejections, model.modelKey, 'OUTPUT_LIMIT_TOO_SMALL');
    }
    // COST_CONSTRAINT
    const price = model.pricing?.inputPerMillion ?? null;
    if (view.maxCost !== null && price !== null && price > view.maxCost) {
      reject(rejections, model.modelKey, 'COST_LIMIT_EXCEEDED');
    }
    // RISK / ROLE CONSTRAINTS (hooks are declared by the caller; no business rule lives here)
    const hooks = request.riskConstraint?.hooks ?? [];
    if (hooks.includes('REQUIRE_REASONING_CAPABILITY') && model.capabilities.reasoning !== true) {
      reject(rejections, model.modelKey, 'RISK_CONSTRAINT_UNSATISFIED');
    }
    // DIVERSITY
    if (request.diversity !== null && request.diversity !== undefined) {
      const conflict = checkDiversity(model, request.diversity);
      if (conflict !== null) reject(rejections, model.modelKey, conflict);
    }

    const after = rejections.get(model.modelKey)?.length ?? 0;
    if (after === before) candidates.push(model);
  }

  // A hard-filtered model can never come back: the candidate list is exactly what survived.
  const rejected: RejectedCandidate[] = [...rejections.entries()]
    .filter(([modelKey]) => !candidates.some((candidate) => candidate.modelKey === modelKey))
    .map(([modelKey, reasons]) => ({ modelKey, reasons: [...reasons].sort() }))
    .sort((left, right) => (left.modelKey < right.modelKey ? -1 : 1));

  const evaluations: CandidateEvaluation[] = [
    ...candidates.map((model) => ({
      modelKey: model.modelKey,
      eligible: true,
      reasons: [] as RouterPositiveReason[],
      rejections: [] as RouterRejectionReason[],
      signalScores: [] as CandidateEvaluation['signalScores'],
      availableWeights: 0,
      normalisedScore: 0,
      reasonCodes: [] as RouterPositiveReason[],
      tieBreakFacts: {
        modelKey: model.modelKey,
        preferredPosition: null,
        estimatedCost: null,
        estimatedLatencyMs: null,
        providerHealth: 'unknown' as const,
      },
    })),
    ...rejected.map((entry) => ({
      modelKey: entry.modelKey,
      eligible: false,
      reasons: [] as RouterPositiveReason[],
      rejections: entry.reasons,
      signalScores: [] as CandidateEvaluation['signalScores'],
      availableWeights: 0,
      normalisedScore: 0,
      reasonCodes: [] as RouterPositiveReason[],
      tieBreakFacts: {
        modelKey: entry.modelKey,
        preferredPosition: null,
        estimatedCost: null,
        estimatedLatencyMs: null,
        providerHealth: 'unknown' as const,
      },
    })),
  ].sort((left, right) => (left.modelKey < right.modelKey ? -1 : 1));

  // LATENCY_CONSTRAINT is DECLARED NO-OP in v1: no comparable per-candidate latency metadata
  // exists, so it never eliminates a candidate and never pretends maxLatency was enforced.
  return ok({
    candidates: brandCandidateSet(candidates),
    rejected,
    evaluations,
    checked: request.candidateModels.length,
    latencyFilter: LATENCY_FILTER_MODE,
  });
}

/** Pure CONTRACT: what the caller must do with a recommendation (§十二). It executes nothing. */
export type FallbackAction = 'STOP' | 'ASK_USER' | 'AUTOMATIC_WITHIN_CANDIDATES';

export interface FallbackDecision {
  readonly action: FallbackAction;
  readonly fallbackPolicy: FallbackMode;
  /** Only meaningful for AUTOMATIC_WITHIN_CANDIDATES: the same, already-filtered set. */
  readonly candidateSet: readonly string[];
  readonly reason: RouterPositiveReason | RouterRejectionReason;
}

export function decideFallback(input: {
  readonly fallbackPolicy: FallbackMode;
  readonly candidates: readonly ModelRecord[];
}): FallbackDecision {
  const keys = input.candidates.map((model) => model.modelKey).sort();
  if (input.fallbackPolicy === 'NEVER') {
    return { action: 'STOP', fallbackPolicy: 'NEVER', candidateSet: [], reason: 'MANUAL_EXPLICIT_CHOICE' };
  }
  if (input.fallbackPolicy === 'ASK') {
    return { action: 'ASK_USER', fallbackPolicy: 'ASK', candidateSet: [], reason: 'MANUAL_EXPLICIT_CHOICE' };
  }
  // AUTO_WITHIN_POLICY: only inside the set the policy already allowed - never across policy.
  return {
    action: 'AUTOMATIC_WITHIN_CANDIDATES',
    fallbackPolicy: 'AUTO_WITHIN_POLICY',
    candidateSet: keys,
    reason: 'ALLOWED_PROVIDER',
  };
}

/** Pure CONTRACT: the router service is unavailable (§十四). */
export function routerUnavailableOutcome(input: {
  readonly selectionMode: RouterRequest['selectionMode'];
  readonly manualModelKey?: string | null;
}): ModelRecommendation['decision'] {
  if (input.selectionMode === 'MANUAL') return 'MANUAL_NOT_ROUTED';
  if ((input.manualModelKey ?? '').trim().length > 0) return 'MANUAL_NOT_ROUTED';
  return 'ROUTER_NOT_AVAILABLE';
}

/** Pure CONTRACT: nothing survived the hard filters (§十三). */
export function noCandidateOutcome(outcome: HardFilterOutcome): {
  readonly decision: 'NO_ELIGIBLE_MODEL';
  readonly summary: RejectionSummary;
} {
  const byReason: Partial<Record<RouterRejectionReason, number>> = {};
  for (const entry of outcome.rejected) {
    for (const reason of entry.reasons) byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  const parts = Object.entries(byReason)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([reason, count]) => `${String(count)} ${reason.toLowerCase().replace(/_/g, ' ')}`);
  return {
    decision: 'NO_ELIGIBLE_MODEL',
    summary: {
      checked: outcome.checked,
      byReason,
      summaryText:
        outcome.checked === 0
          ? 'No models are registered.'
          : `${String(outcome.checked)} models checked: ${parts.join(', ')}.`,
    },
  };
}

/** Pure CONTRACT: a manual choice is never routed, never overridden, and may be refused. */
export function manualOutcome(input: {
  readonly request: RouterRequest;
  readonly explicit?: boolean;
}): Result<{ readonly selectedModelKey: string; readonly decision: 'MANUAL_NOT_ROUTED'; readonly reasons: readonly RouterPositiveReason[] }, DomainError> {
  const key = (input.request.manualModelKey ?? '').trim();
  if (key.length === 0) {
    return err(
      domainError('MODEL_SELECTION_REQUIRED', 'MANUAL requires an explicit modelKey; the router does not choose.', {
        taskId: input.request.taskId,
        roleId: input.request.roleId,
      }),
    );
  }
  // MEDIUM-5: the MANUAL path reads the SAME derived view the router would read - not a second
  // interpretation of a `ModelSelectionPolicy`.
  const verdict = evaluateManualSelection({
    modelKey: key,
    policy: input.request.policyView,
    records: input.request.candidateModels,
    explicit: input.explicit ?? true,
  });
  if (!verdict.accepted) {
    return err(
      domainError(
        verdict.refusals.includes('MODEL_NOT_REGISTERED') ? 'NOT_FOUND' : 'POLICY_DENIED',
        `The manually selected model "${key}" cannot be used.`,
        { kind: 'MANUAL_REFUSED', refusals: verdict.refusals, reasons: verdict.reasons },
      ),
    );
  }
  return ok({ selectedModelKey: key, decision: 'MANUAL_NOT_ROUTED', reasons: ['MANUAL_EXPLICIT_CHOICE'] });
}

/* ----------------------------------------------------- recommendation invariants --- */

/**
 * MEDIUM-4 (Closeout-10A.0.2): a recommendation must be internally consistent. The type alone
 * allows contradictory states (e.g. `NO_ELIGIBLE_MODEL` with a selected model), and an
 * inconsistent recommendation is worse than no recommendation because a UI cannot explain it.
 */
export function validateRecommendation(recommendation: ModelRecommendation): Result<true, DomainError> {
  const fail = (reason: string, details: Readonly<Record<string, unknown>> = {}): Result<true, DomainError> =>
    err(domainError('RECOMMENDATION_INVALID', `Inconsistent recommendation: ${reason}`, { reason, ...details }));

  switch (recommendation.decision) {
    case 'RECOMMENDED': {
      if (recommendation.selectedModelKey === null || recommendation.selectedModelKey.trim().length === 0) {
        return fail('RECOMMENDED requires a selectedModelKey');
      }
      if (!recommendation.reasonCodes.some((code) => ROUTER_POSITIVE_REASONS.includes(code as RouterPositiveReason))) {
        return fail('RECOMMENDED requires at least one positive reason code', {
          reasonCodes: recommendation.reasonCodes,
        });
      }
      return ok(true);
    }
    case 'NO_ELIGIBLE_MODEL': {
      if (recommendation.selectedModelKey !== null) {
        return fail('NO_ELIGIBLE_MODEL must not carry a selected model');
      }
      // 10A.0.3 §五: candidate evaluations are NOT evidence of "no eligible model" - the decision
      // must be backed by real rejections or an explicit no-candidate summary.
      if (recommendation.rejectedCandidates.length === 0 && recommendation.rejectionSummary === null) {
        return fail('NO_ELIGIBLE_MODEL requires rejected candidates or a no-candidate summary');
      }
      return ok(true);
    }
    case 'AWAITING_CONFIRMATION': {
      if (recommendation.fallbackPolicy !== 'ASK') {
        return fail('AWAITING_CONFIRMATION requires fallbackPolicy ASK', {
          fallbackPolicy: recommendation.fallbackPolicy,
        });
      }
      return ok(true);
    }
    case 'MANUAL_NOT_ROUTED': {
      if (recommendation.selectedModelKey !== null) {
        return fail('MANUAL_NOT_ROUTED must not carry a router-selected model');
      }
      return ok(true);
    }
    case 'ROUTER_NOT_AVAILABLE': {
      if (recommendation.selectedModelKey !== null) {
        return fail('ROUTER_NOT_AVAILABLE must not fabricate a recommendation');
      }
      return ok(true);
    }
    case 'REFUSED_HARD_BLOCK': {
      if (recommendation.rejectedCandidates.length === 0) {
        return fail('REFUSED_HARD_BLOCK requires the rejected candidate that was refused');
      }
      return ok(true);
    }
    default:
      return fail('unknown decision', { decision: String(recommendation.decision) });
  }
}

/* ------------------------------------------------------------- human override --- */

export interface HumanOverrideInput {
  readonly recommendation: Pick<ModelRecommendation, 'selectedModelKey' | 'traceId' | 'routerVersion'>;
  readonly userModelKey: string;
  /** MEDIUM-5: the derived view, so override and router cannot drift apart. */
  readonly policyView: RouterPolicyView;
  readonly records: readonly ModelRecord[];
}

export interface HumanOverrideOutcome {
  readonly accepted: boolean;
  readonly userFinalSelection: string;
  readonly routerRecommendation: string | null;
  readonly reasons: readonly RouterPositiveReason[];
  readonly refusals: readonly string[];
  readonly agreement: 'SAME_AS_RECOMMENDATION' | 'DIFFERENT_FROM_RECOMMENDATION' | 'NO_RECOMMENDATION';
}

/**
 * Human override (§十九). The router must never block a legitimate manual choice: this function
 * only re-uses the policy verdict, and it records `routerRecommendation` + `userFinalSelection`
 * so "AI recommended vs user chose" can be measured later.
 */
export function applyHumanOverride(input: HumanOverrideInput): HumanOverrideOutcome {
  const verdict = evaluateManualSelection({
    modelKey: input.userModelKey,
    policy: input.policyView,
    records: input.records,
    explicit: true,
  });
  const agreement: HumanOverrideOutcome['agreement'] =
    input.recommendation.selectedModelKey === null
      ? 'NO_RECOMMENDATION'
      : input.recommendation.selectedModelKey === input.userModelKey
        ? 'SAME_AS_RECOMMENDATION'
        : 'DIFFERENT_FROM_RECOMMENDATION';
  return {
    accepted: verdict.accepted,
    userFinalSelection: input.userModelKey,
    routerRecommendation: input.recommendation.selectedModelKey,
    reasons: verdict.accepted ? ['MANUAL_EXPLICIT_CHOICE'] : [],
    refusals: verdict.refusals,
    agreement,
  };
}

/** The persisted override record (§十九): both sides of the decision, for later analysis. */
export interface OverrideRecord {
  readonly traceId: string;
  readonly routerVersion: string;
  readonly routerRecommendation: string | null;
  readonly userFinalSelection: string;
  readonly agreement: HumanOverrideOutcome['agreement'];
}

export const overrideRecord = (input: HumanOverrideInput, outcome: HumanOverrideOutcome): OverrideRecord => ({
  traceId: input.recommendation.traceId,
  routerVersion: input.recommendation.routerVersion,
  routerRecommendation: outcome.routerRecommendation,
  userFinalSelection: outcome.userFinalSelection,
  agreement: outcome.agreement,
});
