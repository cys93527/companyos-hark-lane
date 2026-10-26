/**
 * H15d (hark-live-goal 40308697073): an answered planner call whose JSON was cut at
 * max_tokens settled UNKNOWN-at-bound although DeepSeek reported its usage. The agent
 * runtime now settles the provider's observed usage (KNOWN) from the typed failure.
 */
import { describe, expect, it } from 'vitest';
import { domainError } from '@companyos/core';
import { observedUsageOf } from '../../packages/engine/src/runtime/agent-runtime.js';

describe('observedUsageOf', () => {
  it('reads KNOWN observed usage from a typed provider failure', () => {
    const e = domainError('CAPABILITY_MISSING', 'cut', { usageStatus: 'KNOWN', observedUsage: { inputTokens: 1500, outputTokens: 2048 } });
    expect(observedUsageOf(e)).toEqual({ inputTokens: 1500, outputTokens: 2048, totalCost: null });
  });
  it('never invents usage: UNKNOWN, missing or invalid values settle null', () => {
    expect(observedUsageOf(domainError('CAPABILITY_MISSING', 'x', { usageStatus: 'UNKNOWN' }))).toBeNull();
    expect(observedUsageOf(domainError('CAPABILITY_MISSING', 'x', { usageStatus: 'KNOWN', observedUsage: { inputTokens: -1, outputTokens: 2 } }))).toBeNull();
    expect(observedUsageOf(new Error('plain'))).toBeNull();
    expect(observedUsageOf(null)).toBeNull();
  });
});
