import { describe, expect, it } from 'vitest';

import { createOpenAiCompatibleProvider } from '../../apps/desktop/src/models/openai-compatible-provider.js';
import { observedUsageOf } from '../../packages/engine/src/runtime/agent-runtime.js';

/*
 * AUDIT-E3 (desktop half): an answered 4xx refusal is KNOWN zero usage (nothing generated), so
 * the Goal budget settles KNOWN instead of UNKNOWN and the retry policy can retry a 429.
 * 5xx / 408 / transport failures stay UNKNOWN (the remote may have done billed work).
 */
const invokeWith = (fetchImpl: typeof fetch) => createOpenAiCompatibleProvider({
  config: { providerId: 'fixture', baseUrl: 'http://127.0.0.1', modelId: 'fixture', timeoutMs: 1000, apiKeyEnv: 'FIXTURE_KEY', authentication: 'NONE', source: {} },
  resolveSecret: async () => null,
  fetchImpl,
}).invoke({ modelId: 'fixture', messages: [{ role: 'user', content: 'fixture' }] });

const answered = (status: number) => (async () => new Response(JSON.stringify({ error: { message: 'x' } }), { status })) as unknown as typeof fetch;

describe('AUDIT-E3 answered 4xx refusals carry KNOWN zero usage', () => {
  it.each([400, 401, 403, 404, 429])('HTTP %i -> usageStatus KNOWN, observedUsage 0/0', async (status) => {
    const result = await invokeWith(answered(status));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['usageStatus']).toBe('KNOWN');
    expect(result.error.details['observedUsage']).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(observedUsageOf(result.error)).toEqual({ inputTokens: 0, outputTokens: 0, totalCost: null });
    expect(result.error.details['upstreamCode']).toBe(String(status));
  });

  it('429 stays retryable with its kind preserved', async () => {
    const result = await invokeWith(answered(429));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details['retryable']).toBe(true);
  });

  it.each([408, 500, 502, 503])('HTTP %i stays usage UNKNOWN', async (status) => {
    const result = await invokeWith(answered(status));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['usageStatus']).not.toBe('KNOWN');
    expect(observedUsageOf(result.error)).toBeNull();
  });

  it('a transport failure stays usage UNKNOWN', async () => {
    const result = await invokeWith((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(observedUsageOf(result.error)).toBeNull();
  });
});
