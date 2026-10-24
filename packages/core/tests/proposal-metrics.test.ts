/**
 * Sprint 0 guardrail test: the change-proposal / metrics path stays read-only and
 * separation of duties is enforced.
 */
import { describe, expect, it } from 'vitest';

import {
  SequenceIdFactory,
  acceptChangeProposal,
  computeWorkflowMetrics,
  emptyMetrics,
  openChangeProposal,
  percentile,
  rejectChangeProposal,
  requireAcceptedProposal,
  unwrap,
  type RunOutcomeSample,
} from '../src/index.js';

const proposal = () =>
  unwrap(
    openChangeProposal({
      targetTemplateId: 'tpl_1',
      baseVersionId: 'ver_1',
      subject: { summary: 'add a fact-check stage', ops: [{ op: 'add_node', path: '/nodes/2' }] },
      rationale: 'the same stage failed in three consecutive runs',
      authorId: 'chief_1',
      calledAt: '2026-01-01T00:00:00.000Z',
      ids: new SequenceIdFactory(),
    }),
  );

describe('change proposals', () => {
  it('only an accepted proposal on the current version may open a revision', () => {
    const open = proposal();
    expect(requireAcceptedProposal(open, 'tpl_1', 'ver_1').ok).toBe(false);

    const accepted = unwrap(
      acceptChangeProposal(open, { decidedBy: 'user_1', decidedAt: '2026-01-02T00:00:00.000Z' }),
    );
    expect(accepted.status).toBe('accepted');
    expect(requireAcceptedProposal(accepted, 'tpl_1', 'ver_1').ok).toBe(true);
    expect(requireAcceptedProposal(accepted, 'tpl_1', 'ver_2').ok).toBe(false);
    expect(requireAcceptedProposal(accepted, 'tpl_2', 'ver_1').ok).toBe(false);
  });

  it('refuses a second decision and self-approval', () => {
    const open = proposal();
    expect(
      acceptChangeProposal(open, { decidedBy: 'chief_1', decidedAt: '2026-01-02T00:00:00.000Z' }).ok,
    ).toBe(false);

    const accepted = unwrap(
      acceptChangeProposal(open, { decidedBy: 'user_1', decidedAt: '2026-01-02T00:00:00.000Z' }),
    );
    expect(rejectChangeProposal(accepted, { decidedBy: 'user_1', decidedAt: '2026-01-03T00:00:00.000Z' }).ok).toBe(
      false,
    );
  });
});

describe('workflow metrics', () => {
  const samples: readonly RunOutcomeSample[] = [
    {
      runId: 'run_1',
      workflowVersionId: 'ver_1',
      outcome: 'succeeded',
      durationMs: 1_000,
      costUsd: 0.5,
      tokensIn: 100,
      tokensOut: 200,
      humanInterventions: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      runId: 'run_2',
      workflowVersionId: 'ver_1',
      outcome: 'failed',
      durationMs: 3_000,
      costUsd: 0.25,
      tokensIn: 50,
      tokensOut: 50,
      humanInterventions: 1,
      startedAt: '2026-01-01T01:00:00.000Z',
      failedNodeIds: ['n2'],
    },
    {
      runId: 'run_3',
      workflowVersionId: 'ver_1',
      outcome: 'succeeded',
      durationMs: 2_000,
      costUsd: 0.25,
      tokensIn: 100,
      tokensOut: 100,
      humanInterventions: 0,
      startedAt: '2026-01-01T02:00:00.000Z',
    },
  ];

  it('rolls samples up deterministically', () => {
    const metrics = unwrap(
      computeWorkflowMetrics('ver_1', samples, { from: '2026-01-01', to: '2026-01-02' }, '2026-01-02T00:00:00.000Z'),
    );
    expect(metrics.runCount).toBe(3);
    expect(metrics.successRate).toBeCloseTo(0.6667, 4);
    expect(metrics.p50DurationMs).toBe(2_000);
    expect(metrics.p95DurationMs).toBe(3_000);
    expect(metrics.totalCostUsd).toBeCloseTo(1, 4);
    expect(metrics.costPerSuccessUsd).toBeCloseTo(0.5, 4);
    expect(metrics.humanInterventions).toBe(1);
    expect(metrics.nodeFailureRates).toEqual({ n2: 0.3333 });
  });

  it('refuses to mix samples from another version', () => {
    const foreign = [...samples, { ...samples[0]!, runId: 'run_9', workflowVersionId: 'ver_2' }];
    const result = computeWorkflowMetrics('ver_1', foreign, { from: 'a', to: 'b' }, 'now');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('uses nearest-rank percentiles and an empty baseline', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    const empty = emptyMetrics('ver_1', { from: 'a', to: 'b' }, 'now');
    expect(empty.runCount).toBe(0);
    expect(empty.successRate).toBe(0);
  });
});
