import { describe, expect, it } from 'vitest';

import { computeWorkflowMetrics, emptyMetrics, percentile, type RunOutcomeSample } from '@companyos/core';

const WINDOW = { from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' };
const NOW = '2026-03-01T00:00:00.000Z';

const sample = (overrides: Partial<RunOutcomeSample>): RunOutcomeSample => ({
  runId: `run_${Math.random().toString(36).slice(2, 8)}`,
  workflowVersionId: 'ver_1',
  outcome: 'succeeded',
  durationMs: 1000,
  costUsd: 0.1,
  tokensIn: 100,
  tokensOut: 200,
  humanInterventions: 0,
  startedAt: '2026-02-10T00:00:00.000Z',
  ...overrides,
});

describe('performance metrics (10th lifecycle capability)', () => {
  it('computes nearest-rank percentiles deterministically', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([10, 1, 5], 0)).toBe(1);
    expect(percentile([10, 1, 5], 100)).toBe(10);
  });

  it('rolls up success rate, latency, cost and node failure rates', () => {
    const samples: RunOutcomeSample[] = [
      sample({ outcome: 'succeeded', durationMs: 1000, costUsd: 0.5, tokensIn: 100, tokensOut: 200 }),
      sample({ outcome: 'succeeded', durationMs: 2000, costUsd: 0.25, humanInterventions: 1 }),
      sample({ outcome: 'failed', durationMs: 3000, costUsd: 0.25, failedNodeIds: ['n2', 'n3'] }),
      sample({ outcome: 'cancelled', durationMs: 4000, costUsd: 0, failedNodeIds: ['n2'] }),
    ];
    const result = computeWorkflowMetrics('ver_1', samples, WINDOW, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metrics = result.value;
    expect(metrics.runCount).toBe(4);
    expect(metrics.succeeded).toBe(2);
    expect(metrics.failed).toBe(1);
    expect(metrics.cancelled).toBe(1);
    expect(metrics.successRate).toBe(0.5);
    expect(metrics.p50DurationMs).toBe(2000);
    expect(metrics.p95DurationMs).toBe(4000);
    expect(metrics.totalCostUsd).toBe(1);
    expect(metrics.costPerSuccessUsd).toBe(0.5);
    expect(metrics.tokensIn).toBe(400);
    expect(metrics.tokensOut).toBe(800);
    expect(metrics.humanInterventions).toBe(1);
    expect(metrics.nodeFailureRates).toEqual({ n2: 0.5, n3: 0.25 });
    expect(metrics.computedAt).toBe(NOW);
  });

  it('refuses to mix samples from another workflow version', () => {
    const result = computeWorkflowMetrics(
      'ver_1',
      [sample({ workflowVersionId: 'ver_other' })],
      WINDOW,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns zeroed metrics for a version that has never run', () => {
    const metrics = emptyMetrics('ver_never', WINDOW, NOW);
    expect(metrics.runCount).toBe(0);
    expect(metrics.successRate).toBe(0);
    expect(metrics.costPerSuccessUsd).toBe(0);
    expect(metrics.nodeFailureRates).toEqual({});
  });
});
