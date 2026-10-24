/**
 * PerformanceMetrics — read-only projections per workflow version (the 10th
 * lifecycle capability). Metrics NEVER mutate workflow state.
 *
 * Formulas (frozen in Sprint 0, mirrored by docs/WORKFLOW_LIFECYCLE.md):
 *   successRate    = succeeded / (succeeded + failed + cancelled)
 *   p50 / p95      = nearest-rank percentile over ALL samples' durationMs
 *   costPerSuccess = totalCostUsd / succeeded        (0 when succeeded = 0)
 *   nodeFailureRate= failures attributed to a node / total samples
 * All rollups are rounded to 4 decimal places to stay diff-stable.
 */
import { err, ok, type Result } from '../kernel/result.js';
import { LifecycleError } from '../kernel/errors.js';

export const RUN_OUTCOMES = ['succeeded', 'failed', 'cancelled'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export interface RunOutcomeSample {
  readonly runId: string;
  readonly workflowVersionId: string;
  readonly outcome: RunOutcome;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly humanInterventions: number;
  readonly startedAt: string;
  /** nodeId list for the nodes that failed during this run. */
  readonly failedNodeIds?: readonly string[];
}

export interface MetricsWindow {
  readonly from: string;
  readonly to: string;
}

export interface WorkflowMetrics {
  readonly workflowVersionId: string;
  readonly window: MetricsWindow;
  readonly runCount: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly successRate: number;
  readonly p50DurationMs: number;
  readonly p95DurationMs: number;
  readonly totalCostUsd: number;
  readonly costPerSuccessUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly humanInterventions: number;
  readonly nodeFailureRates: Readonly<Record<string, number>>;
  readonly computedAt: string;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Nearest-rank percentile (no interpolation) — deterministic across runtimes. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  if (p <= 0) return Math.min(...values);
  if (p >= 100) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? 0;
}

export function computeWorkflowMetrics(
  workflowVersionId: string,
  samples: readonly RunOutcomeSample[],
  window: MetricsWindow,
  computedAt: string,
): Result<WorkflowMetrics, LifecycleError> {
  const foreign = samples.find((sample) => sample.workflowVersionId !== workflowVersionId);
  if (foreign !== undefined) {
    return err(
      new LifecycleError('VALIDATION_FAILED', 'Refusing to mix samples from another version.', {
        expected: workflowVersionId,
        actual: foreign.workflowVersionId,
        runId: foreign.runId,
      }),
    );
  }
  const succeeded = samples.filter((s) => s.outcome === 'succeeded').length;
  const failed = samples.filter((s) => s.outcome === 'failed').length;
  const cancelled = samples.filter((s) => s.outcome === 'cancelled').length;
  const finished = succeeded + failed + cancelled;

  const failureCounts = new Map<string, number>();
  for (const sample of samples) {
    for (const nodeId of sample.failedNodeIds ?? []) {
      failureCounts.set(nodeId, (failureCounts.get(nodeId) ?? 0) + 1);
    }
  }
  const nodeFailureRates: Record<string, number> = {};
  for (const [nodeId, count] of [...failureCounts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    nodeFailureRates[nodeId] = round4(samples.length === 0 ? 0 : count / samples.length);
  }

  const durations = samples.map((s) => s.durationMs);
  const totalCostUsd = round4(samples.reduce((sum, s) => sum + s.costUsd, 0));

  return ok({
    workflowVersionId,
    window,
    runCount: samples.length,
    succeeded,
    failed,
    cancelled,
    successRate: round4(finished === 0 ? 0 : succeeded / finished),
    p50DurationMs: Math.round(percentile(durations, 50)),
    p95DurationMs: Math.round(percentile(durations, 95)),
    totalCostUsd,
    costPerSuccessUsd: round4(succeeded === 0 ? 0 : totalCostUsd / succeeded),
    tokensIn: samples.reduce((sum, s) => sum + s.tokensIn, 0),
    tokensOut: samples.reduce((sum, s) => sum + s.tokensOut, 0),
    humanInterventions: samples.reduce((sum, s) => sum + s.humanInterventions, 0),
    nodeFailureRates,
    computedAt,
  });
}

/** Empty metrics — used by the UI before a version has ever run. */
export const emptyMetrics = (
  workflowVersionId: string,
  window: MetricsWindow,
  computedAt: string,
): WorkflowMetrics =>
  ({
    workflowVersionId,
    window,
    runCount: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    successRate: 0,
    p50DurationMs: 0,
    p95DurationMs: 0,
    totalCostUsd: 0,
    costPerSuccessUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    humanInterventions: 0,
    nodeFailureRates: {},
    computedAt,
  }) satisfies WorkflowMetrics;
