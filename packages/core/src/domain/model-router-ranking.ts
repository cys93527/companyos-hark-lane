/**
 * Router v1 RANKING ENGINE (Sprint 10B) - pure, deterministic, frozen weights.
 *
 * It consumes ONLY a `FilteredCandidateSet` (so a hard-filtered model cannot re-enter ranking),
 * uses ONLY `ROUTER_V1_RANKING` / `ROUTER_V1_WEIGHTS`, and never reads a clock, a random source or
 * a database. Missing metadata means "skip the signal and renormalise the remaining weights" -
 * never "score it zero" - so a candidate set with no optional metadata still ranks deterministically.
 */
import {
  BENCHMARK_WEIGHT_CAP,
  HISTORICAL_MIN_SAMPLE,
  ROUTER_V1_RANKING,
  ROUTER_V1_WEIGHTS,
  compareTieBreak,
  sampleConfidence,
  type BenchmarkReference,
  type CandidateEvaluation,
  type FilteredCandidateSet,
  type HistoricalPerformanceSnapshot,
  type RouterPositiveReason,
  type TieBreakFacts,
} from './model-router.js';
import { assertRankingInput } from './model-router.js';
import type { ModelRecord } from './model-registry.js';

export const PROVIDER_HEALTH_VALUES = ['healthy', 'degraded', 'unknown'] as const;
export type ProviderHealthValue = (typeof PROVIDER_HEALTH_VALUES)[number];

export interface RankingContext {
  readonly estimatedInputTokens: number;
  readonly requiredOutputTokens: number | null;
  /** Per-provider health. When omitted entirely, the health signal is MISSING for every candidate. */
  readonly providerHealth?: Readonly<Record<string, ProviderHealthValue>>;
  /** Optional per-model latency (ms). No data -> the latency signal is skipped, never faked. */
  readonly latencyByModelKey?: Readonly<Record<string, number>>;
  readonly performanceByModelKey?: Readonly<Record<string, HistoricalPerformanceSnapshot>>;
  readonly benchmarkByModelKey?: Readonly<Record<string, BenchmarkReference>>;
  /** ORDER SEMANTICS: index 0 is the highest preference (1.0 / 0.6 / 0.3 / 0). */
  readonly preferredModels: readonly string[];
  /**
   * How many capabilities the policy required. `0` means "nothing was required", so the
   * recommendation must NOT claim REQUIRED_CAPABILITIES_MATCH (10B.1 §十四).
   */
  readonly requiredCapabilityCount?: number;
  /**
   * 10B.2 §十: WHEN the health map was observed (ms) and the current time. Once the observation is
   * older than `providerHealthMaxAgeMs` the health signal degrades to `unknown` (0.25) instead of
   * pretending a startup snapshot is live health.
   */
  readonly providerHealthObservedAt?: number;
  readonly providerHealthMaxAgeMs?: number;
  readonly nowMs?: number;
}

/** Health observations older than this are treated as `unknown` (5 minutes). */
export const DEFAULT_PROVIDER_HEALTH_MAX_AGE_MS = 300_000;

/**
 * Stale/source adjustment for a benchmark reference (10B.1 §十): the RAW score is adjusted here
 * and the 0.10 ranking weight is applied exactly ONCE, in the weighted total. Folding the weight
 * into the signal score (as 10B did) multiplied it twice and made the declared weight unreachable.
 */
export const benchmarkAdjustment = (reference: BenchmarkReference): number =>
  reference.stale ? 0.5 : reference.source === 'external' ? 0.75 : 1;

/** Why a signal was skipped (audit only - never a decision input). */
export const SIGNAL_SKIP_REASONS = ['NO_DATA'] as const;
export type SignalSkipReason = (typeof SIGNAL_SKIP_REASONS)[number];

export interface RankingSignalResult {
  readonly key: string;
  readonly weight: number;
  readonly score: number | null;
  readonly skipped: SignalSkipReason | null;
}

export interface RankedCandidateEvaluation extends CandidateEvaluation {
  /** Per-signal score details, so a score can always be explained (§十六). */
  readonly signalScores: readonly RankingSignalResult[];
  /** Sum of the weights of the signals that had data. */
  readonly availableWeights: number;
  readonly normalisedScore: number;
  readonly reasonCodes: readonly RouterPositiveReason[];
  readonly tieBreakFacts: TieBreakFacts;
  readonly estimatedCost: number | null;
  readonly estimatedLatencyMs: number | null;
}

const HEALTH_SCORE: Readonly<Record<ProviderHealthValue, number>> = {
  healthy: 1,
  degraded: 0.5,
  unknown: 0.25,
};

const PREFERENCE_SCORE = [1, 0.6, 0.3] as const;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** 10B.2 §十: a stale observation is NOT live health - it degrades to `unknown`. */
const isHealthFresh = (context: RankingContext): boolean => {
  const observedAt = context.providerHealthObservedAt;
  const now = context.nowMs;
  if (observedAt === undefined || now === undefined) return true;
  const maxAge = context.providerHealthMaxAgeMs ?? DEFAULT_PROVIDER_HEALTH_MAX_AGE_MS;
  return now - observedAt <= maxAge;
};

const estimatedCostOf = (record: ModelRecord, context: RankingContext): number | null => {
  const pricing = record.pricing;
  if (pricing === null || pricing === undefined) return null;
  const input = pricing.inputPerMillion;
  const output = pricing.outputPerMillion;
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  const outputTokens = context.requiredOutputTokens ?? 0;
  return (input * context.estimatedInputTokens) / 1_000_000 + (output * outputTokens) / 1_000_000;
};

/** Min/max inversion inside the candidate set; all equal -> 0.5 neutral (§十二/§十三). */
const invertWithinSet = (values: readonly (number | null)[]): readonly (number | null)[] => {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return values.map(() => null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  return values.map((value) => {
    if (value === null) return null;
    if (max === min) return 0.5;
    return clamp01(1 - (value - min) / (max - min));
  });
};

/** The full per-candidate signal table (frozen weight order, frozen normalisation). */
export function evaluateRankingSignals(
  record: ModelRecord,
  context: RankingContext,
  normalisedCost: number | null,
  normalisedLatency: number | null,
): readonly RankingSignalResult[] {
  const health = context.providerHealth;
  const performance = context.performanceByModelKey?.[record.modelKey];
  const benchmark = context.benchmarkByModelKey?.[record.modelKey];
  const preferenceIndex = context.preferredModels.indexOf(record.modelKey);

  const signal = (key: string, score: number | null): RankingSignalResult => ({
    key,
    weight: ROUTER_V1_WEIGHTS[key] ?? 0,
    score,
    skipped: score === null ? 'NO_DATA' : null,
  });

  const contextScore =
    record.contextWindow > 0
      ? clamp01(
          (record.contextWindow - context.estimatedInputTokens - (context.requiredOutputTokens ?? 0)) /
            record.contextWindow,
        )
      : null;

  return [
    signal(
      'preferredModelsPosition',
      context.preferredModels.length === 0
        ? null
        : (PREFERENCE_SCORE[preferenceIndex] ?? (preferenceIndex >= 0 ? 0 : 0)),
    ),
    signal(
      'providerHealth',
      health === undefined
        ? null
        : isHealthFresh(context)
          ? HEALTH_SCORE[health[record.providerId] ?? 'unknown']
          : HEALTH_SCORE.unknown,
    ),
    signal('contextHeadroom', contextScore),
    signal('estimatedCost', normalisedCost),
    signal('estimatedLatency', normalisedLatency),
    signal(
      'historicalSuccessRate',
      performance === undefined || performance.successRate === null || performance.sampleCount <= 0
        ? null
        : clamp01(performance.successRate * sampleConfidence(performance)),
    ),
    signal(
      'benchmarkMetadata',
      benchmark === undefined ? null : clamp01(benchmark.score * benchmarkAdjustment(benchmark)),
    ),
  ];
}

const reasonsFor = (
  record: ModelRecord,
  context: RankingContext,
  signals: readonly RankingSignalResult[],
  chosen: RankedCandidateEvaluation,
): readonly RouterPositiveReason[] => {
  const reasons: RouterPositiveReason[] = [];
  if ((context.requiredCapabilityCount ?? 0) > 0) reasons.push('REQUIRED_CAPABILITIES_MATCH');
  const byKey = (key: string): RankingSignalResult | undefined => signals.find((entry) => entry.key === key);
  const preference = byKey('preferredModelsPosition');
  if (preference !== undefined && preference.score !== null && preference.score > 0) reasons.push('PREFERRED_MODEL');
  const health = byKey('providerHealth');
  if (health?.score === 1) reasons.push('PROVIDER_HEALTHY');
  else if (health?.score === 0.5) reasons.push('PROVIDER_DEGRADED');
  const headroom = byKey('contextHeadroom');
  if (headroom !== undefined && headroom.score !== null) reasons.push('CONTEXT_HEADROOM');
  const cost = byKey('estimatedCost');
  if (cost?.score !== null && cost !== undefined && cost.score > 0.5) reasons.push('LOWER_ESTIMATED_COST');
  else if (cost !== undefined && cost.score !== null) reasons.push('WITHIN_COST_LIMIT');
  const latency = byKey('estimatedLatency');
  if (latency !== undefined && latency.score !== null) {
    if (latency.score > 0.5) reasons.push('LOWER_ESTIMATED_LATENCY');
  } else {
    reasons.push('LATENCY_DATA_UNAVAILABLE');
  }
  const historical = byKey('historicalSuccessRate');
  if (historical !== undefined && historical.score !== null) {
    reasons.push('HISTORICAL_SUCCESS_RATE');
    const snapshot = context.performanceByModelKey?.[record.modelKey];
    if (snapshot !== undefined && snapshot.sampleCount < HISTORICAL_MIN_SAMPLE) reasons.push('SMALL_SAMPLE_DOWNWEIGHTED');
  }
  const benchmark = byKey('benchmarkMetadata');
  if (benchmark !== undefined && benchmark.score !== null) reasons.push('BENCHMARK_SIGNAL');
  else reasons.push('NO_BENCHMARK_DATA');
  // Never claim a tie-break here: the caller appends TIE_BREAK_APPLIED only when scores really tie.
  if (reasons.length === 0) reasons.push('WITHIN_COST_LIMIT');
  void chosen;
  return reasons;
};

/**
 * Rank the survivors. Deterministic: same input -> same evaluations in the same order
 * (sorted by normalisedScore desc, then the frozen tie-break).
 */
export function rankCandidates(
  set: FilteredCandidateSet,
  context: RankingContext,
): readonly RankedCandidateEvaluation[] {
  const records = assertRankingInput(set);
  const costs = records.map((record) => estimatedCostOf(record, context));
  const latencies = records.map((record) => {
    const value = context.latencyByModelKey?.[record.modelKey];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });
  const normalisedCosts = invertWithinSet(costs);
  const normalisedLatencies = invertWithinSet(latencies);

  const evaluations = records.map((record, index) => {
    const signals = evaluateRankingSignals(record, context, normalisedCosts[index] ?? null, normalisedLatencies[index] ?? null);
    const availableWeights = signals.reduce((sum, entry) => (entry.score === null ? sum : sum + entry.weight), 0);
    const weighted = signals.reduce((sum, entry) => (entry.score === null ? sum : sum + entry.weight * entry.score), 0);
    const normalisedScore = availableWeights === 0 ? 0 : weighted / availableWeights;
    const health = context.providerHealth?.[record.providerId] ?? 'unknown';
    const tieBreakFacts: TieBreakFacts = {
      modelKey: record.modelKey,
      preferredPosition: context.preferredModels.indexOf(record.modelKey) === -1 ? null : context.preferredModels.indexOf(record.modelKey),
      estimatedCost: costs[index] ?? null,
      estimatedLatencyMs: latencies[index] ?? null,
      providerHealth: context.providerHealth === undefined ? 'unknown' : health,
    };
    const base: RankedCandidateEvaluation = {
      modelKey: record.modelKey,
      eligible: true,
      reasons: [],
      rejections: [],
      signalScores: signals,
      availableWeights: Number(availableWeights.toFixed(10)),
      normalisedScore: Number(normalisedScore.toFixed(10)),
      reasonCodes: [],
      tieBreakFacts,
      estimatedCost: costs[index] ?? null,
      estimatedLatencyMs: latencies[index] ?? null,
    };
    return { ...base, reasonCodes: reasonsFor(record, context, signals, base) };
  });

  return [...evaluations].sort((left, right) => {
    if (right.normalisedScore !== left.normalisedScore) return right.normalisedScore - left.normalisedScore;
    return compareTieBreak(left.tieBreakFacts, right.tieBreakFacts);
  });
}

export interface RankingOutcome {
  readonly ranked: readonly RankedCandidateEvaluation[];
  readonly winner: RankedCandidateEvaluation | null;
  /** True when the winner was decided by the tie-break rather than by a strictly higher score. */
  readonly decidedByTieBreak: boolean;
}

/** Pick the winner with the frozen tie-break; never random, never clock-dependent. */
export function selectWinner(ranked: readonly RankedCandidateEvaluation[]): RankingOutcome {
  const winner = ranked[0] ?? null;
  if (winner === null) return { ranked, winner: null, decidedByTieBreak: false };
  const runnerUp = ranked[1] ?? null;
  return {
    ranked,
    winner,
    decidedByTieBreak: runnerUp !== null && runnerUp.normalisedScore === winner.normalisedScore,
  };
}

/** The benchmark cap is exported again so tests can assert the frozen bound next to the weights. */
export const ROUTER_BENCHMARK_CAP_REFERENCE = BENCHMARK_WEIGHT_CAP;

/** The signal keys the engine may score, in the frozen order. */
export const RANKED_SIGNAL_KEYS: readonly string[] = ROUTER_V1_RANKING.map((signal) => signal.key);
