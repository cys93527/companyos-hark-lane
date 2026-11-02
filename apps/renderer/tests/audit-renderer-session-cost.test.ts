/**
 * AUDIT session cost: the cost shown to the user is only a number when it is provable.
 * Root causes: (1) the durable usage reader read pricing.input/pricing.output, but model_records
 * stores ModelPricing {inputPerMillion, outputPerMillion, currency}, so a declared price read as
 * null; (2) the projection and the renderer treated a missing per-direction price as 0 and called
 * the result a cost; (3) no currency travelled to the UI, which hard-coded "$".
 */
import { describe, expect, it } from 'vitest';

import { projectGoalUsage } from '../../desktop/src/efficiency/goal-usage-projection.js';
import { pricingFromRecord } from '../../desktop/src/efficiency/durable-usage-reader.js';
import { projectModelRuntime, sessionCost } from '../src/telemetry.js';
import { projectTelemetry, type GoalUsageProjection } from '../src/usage.js';

const reader = (pricing: { inputPerMillion: number | null; outputPerMillion: number | null; currency: string | null } | null) => ({
  runsOf: async (runId: string) => [{ id: runId, state: 'EXECUTING' }],
  agentExecutions: async () => [
    { executionId: 'exa_1', agentId: 'agent.worker', roleId: 'rol.worker', taskId: 't1', inputTokens: 1_000_000, outputTokens: 500_000, provenance: 'provider-reported' as const },
  ],
  providerDispatches: async () => [],
  providerInvocations: async () => [],
  modelKeyOf: async () => 'model.m',
  modelPricing: async () => pricing,
});

const USAGE: GoalUsageProjection = {
  goalRunId: 'run_1',
  usage: { knownInputTokens: 10, knownOutputTokens: 5, estimatedInputTokens: 0, estimatedOutputTokens: 0, unknownDispatchCount: 0, totalDispatchCount: 1, coverageRatio: 1, complete: true },
  speed: { state: 'UNKNOWN', samples: [], note: '' },
  cacheHit: { state: 'UNKNOWN', reason: '' },
  cost: { state: 'ESTIMATED', knownScopeCost: 1.5, currency: 'CNY', coverageComplete: true, note: '' },
  contextRemaining: { state: 'UNKNOWN', reason: '' },
};

describe('AUDIT session cost is never fabricated', () => {
  it('the durable reader reads the stored ModelPricing shape (and its currency)', () => {
    expect(pricingFromRecord({ inputPerMillion: 1, outputPerMillion: 2, currency: 'CNY' })).toEqual({ inputPerMillion: 1, outputPerMillion: 2, currency: 'CNY' });
    expect(pricingFromRecord({ inputPerMillion: 1, outputPerMillion: null, currency: 'USD' })).toEqual({ inputPerMillion: 1, outputPerMillion: null, currency: 'USD' });
    expect(pricingFromRecord({ inputPerMillion: 1, outputPerMillion: 2 })).toEqual({ inputPerMillion: 1, outputPerMillion: 2, currency: null });
    expect(pricingFromRecord(null)).toBeNull();
  });

  it('the projection carries the currency and refuses a partial price', async () => {
    const full = await projectGoalUsage(reader({ inputPerMillion: 1, outputPerMillion: 2, currency: 'CNY' }), 'run_1');
    expect(full.cost).toMatchObject({ state: 'ESTIMATED', knownScopeCost: 2, currency: 'CNY' });
    const partial = await projectGoalUsage(reader({ inputPerMillion: 1, outputPerMillion: null, currency: 'CNY' }), 'run_1');
    expect(partial.cost.state).toBe('UNKNOWN');
    expect(partial.cost.knownScopeCost).toBeNull();
    const noCurrency = await projectGoalUsage(reader({ inputPerMillion: 1, outputPerMillion: 2, currency: null }), 'run_1');
    expect(noCurrency.cost.state).toBe('UNKNOWN');
  });

  it('the popover shows the cost with its currency, never "$", and "--" without a currency', () => {
    expect(projectTelemetry(USAGE, null).cost).toBe('1.5 CNY');
    expect(projectTelemetry({ ...USAGE, cost: { ...USAGE.cost, currency: null } }, null).cost).toBe('--');
    expect(projectTelemetry({ ...USAGE, cost: { ...USAGE.cost, currency: null } }, null).costLabel).toBeNull();
  });

  it('the composer session cost is UNKNOWN on a missing price, a missing currency or incomplete coverage', () => {
    const price = { inputPerMillion: 1, outputPerMillion: 2, currency: 'CNY' };
    expect(sessionCost(1_000_000, 1_000_000, price, true)).toEqual({ state: 'KNOWN', value: 3, unit: ' CNY' });
    expect(sessionCost(1_000_000, 1_000_000, { ...price, outputPerMillion: null }, true).state).toBe('UNKNOWN');
    expect(sessionCost(1_000_000, 1_000_000, { ...price, currency: null }, true).state).toBe('UNKNOWN');
    expect(sessionCost(1_000_000, 1_000_000, price, false).state).toBe('UNKNOWN');
    const view = projectModelRuntime({
      model: { modelKey: 'k', displayName: 'm', providerId: 'p', contextWindow: null, price: { inputPerMillion: 1, outputPerMillion: null, currency: 'CNY' }, availability: 'available' },
      usedTokens: 10, cachedTokens: null, speedSamples: [], inputTokens: 10, outputTokens: 0, usageComplete: true,
    });
    expect(view.cost).toBe('--');
  });
});
