// H15d acceptance run 5 (hark-live-goal 40359081704): 134 calls settled KNOWN for 2 981 170 of the
// 3 200 000 money cap; every further call (bound 224 768) was refused, but the driver's standing check
// only looked at maxCalls (160), so 13 refused supervisor turns ended as AUTONOMY_STALLED. The standing
// check now uses goalEnvelopeExhausted, the same arithmetic as reserve().
import { describe, expect, it } from 'vitest';

import { goalEnvelopeExhausted } from '../../packages/engine/src/runtime/goal-execution-budget.js';

const bound = { modelKey: 'model.deepseek:deepseek-flash', inputTokens: 96000, outputTokens: 4096, costMicros: 224768, evidenceRef: 'sha256:x', validUntilMs: 1 };
const policy = { policyId: 'p', maxCalls: 160, maxTokens: 16015360, maxCostMicros: 3200000, deadlineMs: 2 };
const envelope = (settled: readonly number[], inFlight = 0) => ({
  goalRunId: 'g', policy, cancellation: null,
  reservations: [
    ...settled.map((costMicros, i) => ({ callId: `c${String(i)}`, runId: 'r', ownerId: 'o', bound, status: 'KNOWN' as const, usage: { tokens: 10000, costMicros } })),
    ...Array.from({ length: inFlight }, (_, i) => ({ callId: `f${String(i)}`, runId: 'r', ownerId: 'o', bound, status: 'RESERVED' as const, usage: null })),
  ],
});

describe('H15d goal envelope exhaustion (money, tokens, call slots)', () => {
  it('run 5 shape: 134 KNOWN calls totalling 2 981 170 -> exhausted (next 224 768 bound exceeds 3 200 000)', () => {
    const settled = Array.from({ length: 133 }, () => 22000);
    settled.push(2981170 - 22000 * 133);
    expect(goalEnvelopeExhausted(envelope(settled) as never)).toBe(true);
  });
  it('still admits when the cheapest seen bound fits', () => {
    expect(goalEnvelopeExhausted(envelope([1000000]) as never)).toBe(false);
  });
  it('in-flight reservations count at their bound', () => {
    expect(goalEnvelopeExhausted(envelope([2600000], 2) as never)).toBe(true);
  });
  it('all call slots spent -> exhausted; empty envelope -> not exhausted', () => {
    expect(goalEnvelopeExhausted(envelope(Array.from({ length: 160 }, () => 1)) as never)).toBe(true);
    expect(goalEnvelopeExhausted(envelope([]) as never)).toBe(false);
  });
});
