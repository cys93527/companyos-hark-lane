import { describe, expect, it } from 'vitest';

import { createOpenAiCompatibleProvider } from '../../apps/desktop/src/models/openai-compatible-provider.js';
import { createDurableUsageReader } from '../../apps/desktop/src/efficiency/durable-usage-reader.js';

const invoke = (usage: unknown) => createOpenAiCompatibleProvider({
  config: { providerId: 'fixture', baseUrl: 'http://127.0.0.1', modelId: 'fixture', timeoutMs: 1000, apiKeyEnv: 'FIXTURE_KEY', authentication: 'NONE', source: {} },
  resolveSecret: async () => null,
  fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'fixture output' } }], usage }), { status: 200 }),
}).invoke({ modelId: 'fixture', messages: [{ role: 'user', content: 'fixture' }] });

describe('execution safety: usage is measured or unknown', () => {
  it.each([undefined, {}, { prompt_tokens: 2 }, { completion_tokens: 3 }, { prompt_tokens: -1, completion_tokens: 3 }, { prompt_tokens: 2.5, completion_tokens: 3 }, { prompt_tokens: '2', completion_tokens: 3 }])('fails closed for incomplete or invalid usage %j', async (usage) => {
    const result = await invoke(usage);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details['usageStatus']).toBe('UNKNOWN');
      expect(result.error.details['retryable']).toBe(false);
    }
  });
  it('retains measured zero and leaves unreported cost unknown', async () => {
    const result = await invoke({ prompt_tokens: 0, completion_tokens: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalCost: null });
  });
  it('reads actual completed input usage, not the initial zero placeholder', async () => {
    const reader = createDurableUsageReader({
      db: { prepare: () => ({ get: () => undefined, all: () => [{ execution_id: 'execution', status: 'COMPLETED', input_usage: '{"inputTokens":0,"outputTokens":0,"totalTokens":0}', output_usage: '{"inputTokens":111,"outputTokens":7,"totalTokens":118}' }] }) },
      runs: { get: async () => null },
    }, 'company');
    expect((await reader.agentExecutions(['run']))[0]).toMatchObject({ inputTokens: 111, outputTokens: 7 });
  });
  it.each(['CREATED', 'RUNNING', 'FAILED', 'CANCELLED', 'INTERRUPTED'])('does not count %s placeholders as measured zero', async (status) => {
    const reader = createDurableUsageReader({
      db: { prepare: () => ({ get: () => undefined, all: () => [{ execution_id: 'execution', status, input_usage: '{"inputTokens":0}', output_usage: '{"outputTokens":0}' }] }) },
      runs: { get: async () => null },
    }, 'company');
    expect((await reader.agentExecutions(['run']))[0]).toMatchObject({ inputTokens: null, outputTokens: null });
  });
});
