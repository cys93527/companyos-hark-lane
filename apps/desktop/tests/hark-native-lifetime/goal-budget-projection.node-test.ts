// H11 — read-only Goal budget projection (boss view). Offline, pure.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatMicros, projectGoalBudget } from '../../src/efficiency/goal-budget-projection.js';

const NOW = Date.UTC(2026, 9, 25, 4, 0, 0);
const bound = { modelKey: 'h10.live', inputTokens: 24000, outputTokens: 8000, costMicros: 112000, evidenceRef: 'sha256:x', validUntilMs: NOW + 1e9 };
const policy = { policyId: 'p', maxCalls: 6, maxTokens: 200000, maxCostMicros: 1_000_000, deadlineMs: NOW + 600000 };
const r = (status: 'KNOWN' | 'UNKNOWN' | 'RESERVED', i: number, usage: { tokens: number; costMicros: number } | null = null) =>
  ({ callId: `c${String(i)}`, runId: 'run_g', ownerId: 'e', bound, status, usage });

test('B1 no budget => NO_BUDGET, nothing remaining', () => {
  const p = projectGoalBudget('run_g', null, { nowMs: NOW, currency: 'CNY' });
  assert.equal(p.state, 'NO_BUDGET');
  assert.equal(p.remaining, null);
  assert.equal(p.worstCaseCostMicros, 0);
});

test('B2 the H10b live run: one KNOWN call settles exactly (1769 tokens, 5740 micro-CNY)', () => {
  const p = projectGoalBudget('run_g', { goalRunId: 'run_g', policy, cancellation: null, reservations: [r('KNOWN', 1, { tokens: 1769, costMicros: 5740 })] }, { nowMs: NOW, currency: 'CNY' });
  assert.equal(p.state, 'ACTIVE');
  assert.deepEqual(p.settled, { calls: 1, tokens: 1769, costMicros: 5740 });
  assert.deepEqual(p.unknown, { calls: 0, tokens: 0, costMicros: 0 });
  assert.deepEqual(p.remaining, { calls: 5, tokens: 200000 - 1769, costMicros: 1_000_000 - 5740 });
  assert.equal(formatMicros(p.settled.costMicros, 'CNY'), '¥0.00574');
});

test('B3 UNKNOWN is never shown as zero: counted at its full bound and noted', () => {
  const p = projectGoalBudget('run_g', { goalRunId: 'run_g', policy, cancellation: null, reservations: [r('UNKNOWN', 1)] }, { nowMs: NOW, currency: 'CNY' });
  assert.deepEqual(p.unknown, { calls: 1, tokens: 32000, costMicros: 112000 });
  assert.equal(p.settled.costMicros, 0);
  assert.equal(p.worstCaseCostMicros, 112000);
  assert.equal(p.remaining?.costMicros, 888000);
  assert.ok(p.notes.some((n) => n.includes('unproven charge') && n.includes('never replayed')));
});

test('B4 RESERVED in flight is held at its bound; remaining never negative', () => {
  const many = Array.from({ length: 6 }, (_, i) => r(i % 2 === 0 ? 'RESERVED' : 'UNKNOWN', i));
  const p = projectGoalBudget('run_g', { goalRunId: 'run_g', policy: { ...policy, maxCostMicros: 700000 }, cancellation: null, reservations: many }, { nowMs: NOW, currency: 'CNY' });
  assert.equal(p.held.calls, 3);
  assert.equal(p.unknown.calls, 3);
  assert.deepEqual(p.remaining, { calls: 0, tokens: 200000 - 6 * 32000, costMicros: 700000 - 6 * 112000 });
  const over = projectGoalBudget('run_g', { goalRunId: 'run_g', policy: { ...policy, maxCalls: 2, maxCostMicros: 100000 }, cancellation: null, reservations: [r('UNKNOWN', 1)] }, { nowMs: NOW });
  assert.equal(over.remaining?.costMicros, 0);
});

test('B5 states: cancelled > expired > zero-cost policy', () => {
  const base = { goalRunId: 'run_g', reservations: [] };
  assert.equal(projectGoalBudget('run_g', { ...base, policy, cancellation: { requestedAtMs: NOW, requestId: 'x' } }, { nowMs: NOW }).state, 'CANCELLED');
  assert.equal(projectGoalBudget('run_g', { ...base, policy, cancellation: null }, { nowMs: policy.deadlineMs }).state, 'EXPIRED');
  assert.equal(projectGoalBudget('run_g', { ...base, policy: { ...policy, maxCostMicros: 0 }, cancellation: null }, { nowMs: NOW }).state, 'ZERO_COST_POLICY');
});

test('B6 no declared currency => raw units, said plainly', () => {
  const p = projectGoalBudget('run_g', { goalRunId: 'run_g', policy, cancellation: null, reservations: [] }, { nowMs: NOW });
  assert.equal(p.currency, null);
  assert.ok(p.notes.some((n) => n.includes('raw micro-units')));
  assert.equal(formatMicros(1_000_000, null), '1.00 units');
  assert.equal(formatMicros(112000, 'CNY'), '¥0.112');
});
