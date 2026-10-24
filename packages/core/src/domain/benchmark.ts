/**
 * Benchmark metadata (Sprint 7.5).
 *
 * A benchmark produces **Model Performance Metadata** and nothing else. It is explicitly
 * NOT an input to model selection: `domain/model-selection-policy.ts` does not import this
 * module, and `tests/sprint7-5/benchmark.test.ts` asserts both facts structurally.
 *
 * The categories are the ones the user listed (A–N) and map onto IDs so results stay
 * readable in SQLite and in the UI without renumbering.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';

/** A–N: the frozen benchmark categories. */
export const BENCHMARK_CATEGORIES = [
  'CODING',
  'BUG_FIX',
  'REFACTOR',
  'ARCHITECTURE',
  'REVIEW',
  'REASONING',
  'CHINESE',
  'TOOL_CALLING',
  'STRUCTURED_OUTPUT',
  'LONG_CONTEXT',
  'INSTRUCTION_FOLLOWING',
  'LATENCY',
  'COST',
  'LOCAL_DEPLOYMENT',
] as const;

export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number];
export const isBenchmarkCategory = (value: unknown): value is BenchmarkCategory =>
  typeof value === 'string' && (BENCHMARK_CATEGORIES as readonly string[]).includes(value);

/** How one case decides a score. Deterministic by construction (no LLM-as-judge). */
export type BenchmarkExpectation =
  | { readonly kind: 'contains'; readonly text: string }
  | { readonly kind: 'not_contains'; readonly text: string }
  | { readonly kind: 'regex'; readonly pattern: string }
  | { readonly kind: 'json_keys'; readonly keys: readonly string[] }
  | { readonly kind: 'manual'; readonly note: string };

export interface BenchmarkCase {
  readonly id: string;
  readonly category: BenchmarkCategory;
  readonly prompt: string;
  readonly expectation: BenchmarkExpectation;
  /** Relative weight inside the category (default 1). */
  readonly weight?: number;
}

export interface BenchmarkSuite {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly cases: readonly BenchmarkCase[];
}

export interface BenchmarkResult {
  /** `EntityStore` key. */
  readonly id: string;
  readonly modelKey: string;
  readonly suiteId: string;
  readonly caseId: string;
  readonly category: BenchmarkCategory;
  /** 0..1; `null` means "measured but not scored" (e.g. LATENCY/COST samples). */
  readonly score: number | null;
  readonly measuredValue: number | null;
  readonly notes: string;
  /** Where the number came from - our harness, or an external report. */
  readonly source: 'harness' | 'external';
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface ModelPerformanceMetadata {
  readonly modelKey: string;
  readonly byCategory: Readonly<Partial<Record<BenchmarkCategory, number>>>;
  readonly overall: number | null;
  readonly sampleCount: number;
  readonly sources: readonly ('harness' | 'external')[];
  /** True when any sample is external: the UI must label it as unverified. */
  readonly includesExternal: boolean;
}

/**
 * Aggregate results into display metadata.
 *
 * Deterministic: sorted by model key, ties broken by category name; no scoring model, no
 * ranking, no "best" flag. `overall` is a plain unweighted mean of the scored categories.
 */
export function summarizePerformance(
  results: readonly BenchmarkResult[],
): readonly ModelPerformanceMetadata[] {
  const byModel = new Map<string, BenchmarkResult[]>();
  for (const result of results) {
    const bucket = byModel.get(result.modelKey) ?? [];
    bucket.push(result);
    byModel.set(result.modelKey, bucket);
  }

  const metadata: ModelPerformanceMetadata[] = [];
  for (const [modelKey, samples] of [...byModel.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const byCategory: Partial<Record<BenchmarkCategory, number>> = {};
    for (const category of BENCHMARK_CATEGORIES) {
      const scored = samples.filter((sample) => sample.category === category && sample.score !== null);
      if (scored.length === 0) continue;
      const total = scored.reduce((sum, sample) => sum + (sample.score ?? 0), 0);
      byCategory[category] = Number((total / scored.length).toFixed(4));
    }
    const categoryValues = Object.values(byCategory).filter((value): value is number => typeof value === 'number');
    metadata.push({
      modelKey,
      byCategory,
      overall:
        categoryValues.length === 0
          ? null
          : Number((categoryValues.reduce((sum, value) => sum + value, 0) / categoryValues.length).toFixed(4)),
      sampleCount: samples.length,
      sources: [...new Set(samples.map((sample) => sample.source))].sort(),
      includesExternal: samples.some((sample) => sample.source === 'external'),
    });
  }
  return metadata;
}

/** The only sanctioned use of benchmark numbers (Sprint 7.5 §九). */
export const PERFORMANCE_METADATA_PURPOSE = 'display-and-planning-only' as const;

export function validateBenchmarkResult(
  result: BenchmarkResult,
): Result<true, DomainError> {
  if (!isBenchmarkCategory(result.category)) {
    return err(domainError('VALIDATION_FAILED', `Unknown benchmark category "${result.category}".`, {
      allowed: BENCHMARK_CATEGORIES,
    }));
  }
  if (result.score !== null && (result.score < 0 || result.score > 1)) {
    return err(domainError('VALIDATION_FAILED', 'A benchmark score must be within 0..1.', { score: result.score }));
  }
  if (result.modelKey.trim().length === 0) {
    return err(domainError('VALIDATION_FAILED', 'A benchmark result needs a modelKey.', {}));
  }
  return ok(true);
}
