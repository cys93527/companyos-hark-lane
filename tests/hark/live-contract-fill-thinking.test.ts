/**
 * LIVE-CONTRACT-FILL run 3 (hark-live-goal 42085454360): the planner's single call reasoned
 * through the whole 4096-token ceiling (thinking is on by default upstream) and returned
 * no answer -> the goal failed before any work. Root fix pinned here:
 *  - the deployment declares the control-plane thinking control explicitly (COS_MODEL_THINKING,
 *    provider profile `thinking`), and the adapter sends it;
 *  - an empty answer cut by max_tokens after reasoning is typed PROVIDER_REASONING_EXHAUSTED.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createOpenAiCompatibleProvider, resolveOpenAiCompatibleConfig, MODEL_PROVIDER_ENV } from '../../apps/desktop/src/models/openai-compatible-provider.js';
import { parseProviderSetupModel, providerSetupEnvValues } from '../../apps/desktop/src/provider-setup.js';
import { readProviderSetupProfile, parseProviderSetupProfile } from '../../apps/desktop/src/provider-setup-write.js';

const ENV = { COS_MODEL_BASE_URL: 'https://example.invalid', COS_MODEL_ID: 'fixture', COMPANYOS_MODEL_API_KEY: 'fixture-key-12345' };

const run = async (thinking: string | undefined, answer: Record<string, unknown>) => {
  const resolved = resolveOpenAiCompatibleConfig({ ...ENV, ...(thinking === undefined ? {} : { COS_MODEL_THINKING: thinking }) });
  if (!resolved.ok || resolved.value === null) throw new Error('config');
  const bodies: Record<string, unknown>[] = [];
  const provider = createOpenAiCompatibleProvider({
    config: resolved.value,
    resolveSecret: async () => 'fixture-key-12345',
    fetchImpl: async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(answer), { status: 200 });
    },
  } as never);
  const result = await provider.invoke({ modelId: 'fixture', messages: [{ role: 'user', content: 'plan' }], maxOutputTokens: 4096 });
  return { result, body: bodies[0]! };
};

const OK = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };

describe('control-plane thinking control', () => {
  it('disabled -> thinking {type: disabled}; low/high -> enabled + reasoning_effort; absent -> nothing sent', async () => {
    expect((await run('disabled', OK)).body['thinking']).toEqual({ type: 'disabled' });
    const low = (await run('low', OK)).body;
    expect(low['thinking']).toEqual({ type: 'enabled' });
    expect(low['reasoning_effort']).toBe('low');
    const none = (await run(undefined, OK)).body;
    expect(none['thinking']).toBeUndefined();
    expect(none['reasoning_effort']).toBeUndefined();
  });
  it('an invalid value is a typed config error, never guessed', () => {
    const resolved = resolveOpenAiCompatibleConfig({ ...ENV, COS_MODEL_THINKING: 'off' });
    expect(resolved.ok).toBe(false);
  });
  it('reasoning that exhausts max_tokens with no answer is typed PROVIDER_REASONING_EXHAUSTED with known usage', async () => {
    const { result } = await run(undefined, { choices: [{ message: { content: '', reasoning_content: 'long thoughts' }, finish_reason: 'length' }], usage: { prompt_tokens: 1543, completion_tokens: 4096 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/^The model spent the declared max_tokens on reasoning and returned no answer/u);
    expect(result.error.details['reason']).toBe('PROVIDER_REASONING_EXHAUSTED');
    expect(result.error.details['usageStatus']).toBe('KNOWN');
  });
  it('the shipped provider profile declares thinking disabled and it reaches the app environment', () => {
    const profile = readProviderSetupProfile(join(__dirname, '../../scripts/hark/setup/provider-profile.json'));
    expect(profile.thinking).toBe('disabled');
    expect(parseProviderSetupProfile({ ...profile, thinking: 'maybe' })).toBeNull();
    const { thinking: _omit, ...without } = profile;
    expect(parseProviderSetupProfile(without)).not.toBeNull(); // optional key
    const model = parseProviderSetupModel({ schema: 'companyos:provider-setup:1', providerId: profile.providerId, baseUrl: profile.baseUrl, modelId: profile.modelId, maxOutputTokens: 4096, timeoutMs: 120000, structuredOutput: 'json_object', thinking: 'disabled', configuredAt: new Date(0).toISOString() });
    expect(model).not.toBeNull();
    expect(providerSetupEnvValues({ state: 'CONFIGURED', model: model!, apiKey: 'fixture-key-12345' })[MODEL_PROVIDER_ENV.thinking]).toBe('disabled');
  });
  it('the live custom harness mirrors the shipped profile', () => {
    const yml = readFileSync(join(__dirname, '../../.github/workflows/hark-live-goal.yml'), 'utf8');
    expect(yml).toContain('COS_MODEL_THINKING: disabled');
  });
});

describe('UI defect c (main side): the catalogue marks the deployment-configured model', () => {
  it('main.ts derives configured from the private runtime env and workflows passes it through', () => {
    const main = readFileSync(join(__dirname, '../../apps/desktop/src/main.ts'), 'utf8');
    const workflows = readFileSync(join(__dirname, '../../apps/desktop/src/workflows.ts'), 'utf8');
    expect(main).toMatch(/configured: configured !== null && row\.providerId === configured\.providerId && row\.modelId === configured\.modelId/u);
    expect(workflows).toContain("configured: row.configured === true");
  });
});
