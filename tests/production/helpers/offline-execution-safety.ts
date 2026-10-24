import type { GoalSafetyConfiguration } from '../../../apps/desktop/src/execution-safety-coordinator.js';

/**
 * ONLY for deterministic in-process / loopback fixtures with no paid backend.
 * Their fixed outputs and reported usage establish the fixture bounds. This is
 * not a production tariff, and missing usage still becomes UNKNOWN.
 */
export const offlineExecutionSafety: GoalSafetyConfiguration = {
  policyId: 'OFFLINE_LOCAL_FIXTURE_ONLY',
  maxCalls: 128,
  maxTokens: 33_554_432,
  maxCostMicros: 0,
  durationMs: 600_000,
  boundOf: ({ modelKey, maxOutputTokens }) => ({
    modelKey, inputTokens: 128_000, outputTokens: maxOutputTokens ?? 16_384,
    costMicros: 0, evidenceRef: 'DETERMINISTIC_OFFLINE_FIXTURE_NOT_PROVIDER_PRICE',
    validUntilMs: Date.now() + 600_000,
  }),
  costOf: () => 0,
};
