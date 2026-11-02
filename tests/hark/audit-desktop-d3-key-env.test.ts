import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { captureRuntimeEnv, createProviderRuntimeEnv, isSecretEnvName, PROVIDER_SETUP_SCHEMA, type ProviderSetupState } from '../../apps/desktop/src/provider-setup.js';
import { MODEL_PROVIDER_ENV } from '../../apps/desktop/src/models/openai-compatible-provider.js';

/*
 * AUDIT-D3: the decrypted model API key must never be written into the MAIN process environment
 * (inherited by ShellExecute 打开/链接, execFile without env, Chromium children). It lives only
 * in a private runtime env handed to composition (vault, model config, attempt timeout).
 */
const KEY = 'sk-AUDITSECRET123456';
const CONFIGURED: ProviderSetupState = {
  state: 'CONFIGURED',
  apiKey: KEY,
  model: {
    schema: PROVIDER_SETUP_SCHEMA, providerId: 'p1', baseUrl: 'https://model.invalid/v1', modelId: 'm1', timeoutMs: 60000, maxOutputTokens: 2048, structuredOutput: 'json_object', configuredAt: '2026-11-01T00:00:00.000Z',
  },
};

describe('AUDIT-D3 provider key stays out of the host environment', () => {
  it('the configured key lands only in the private runtime env, never in the host env', () => {
    const host: Record<string, string | undefined> = { PATH: '/bin', COMPANYOS_ACTOR: 'user_owner' };
    const { runtimeEnv, result } = createProviderRuntimeEnv(host, CONFIGURED);
    expect(result.source).toBe('provider-setup');
    expect(runtimeEnv[MODEL_PROVIDER_ENV.apiKey]).toBe(KEY);
    expect(runtimeEnv[MODEL_PROVIDER_ENV.modelId]).toBe('m1');
    expect(runtimeEnv['PATH']).toBe('/bin');
    expect(JSON.stringify(host)).not.toContain(KEY);
    expect(host[MODEL_PROVIDER_ENV.apiKey]).toBeUndefined();
    expect(host['COMPANYOS_ACTOR']).toBe('user_owner'); // non-secret names stay
  });

  it('a deployment-declared key is moved out of the host env (still wins whole in the runtime env)', () => {
    const host: Record<string, string | undefined> = {
      [MODEL_PROVIDER_ENV.apiKey]: 'deploy-key-0123456789', [MODEL_PROVIDER_ENV.baseUrl]: 'https://d.invalid', [MODEL_PROVIDER_ENV.modelId]: 'dm',
      COMPANYOS_OTHER_TOKEN: 'tok-xyz', COMPANYOS_TEST_MODE: 'OFFLINE',
    };
    const runtime = captureRuntimeEnv(host);
    const { runtimeEnv, result } = createProviderRuntimeEnv(runtime, CONFIGURED);
    expect(result.source).toBe('environment');
    expect(runtimeEnv[MODEL_PROVIDER_ENV.apiKey]).toBe('deploy-key-0123456789');
    expect(runtimeEnv['COMPANYOS_OTHER_TOKEN']).toBe('tok-xyz');
    expect(host[MODEL_PROVIDER_ENV.apiKey]).toBeUndefined();
    expect(host['COMPANYOS_OTHER_TOKEN']).toBeUndefined();
    expect(host['COMPANYOS_TEST_MODE']).toBe('OFFLINE');
    expect(host[MODEL_PROVIDER_ENV.baseUrl]).toBe('https://d.invalid');
  });

  it('secret-name classification', () => {
    expect(isSecretEnvName('COMPANYOS_MODEL_API_KEY')).toBe(true);
    expect(isSecretEnvName('COMPANYOS_MODEL_ROUTE_ACCESS')).toBe(true);
    for (const n of ['COMPANYOS_ACTOR', 'COMPANYOS_RENDERER_URL', 'COMPANYOS_TEST_MODE', 'COMPANYOS_EXECUTOR_PROVIDER', 'COMPANYOS_DSH_EXTERNAL_RUNTIME', 'COMPANYOS_STOP_EXIT_CODE', 'COS_MODEL_ID', 'PATH']) {
      expect(isSecretEnvName(n)).toBe(false);
    }
  });

  it('main.ts never overlays process.env and hands the private env to every composition', () => {
    const main = readFileSync(join(__dirname, '../../apps/desktop/src/main.ts'), 'utf8');
    expect(main).not.toMatch(/applyProviderSetupOverlay\(\s*process\.env/);
    expect(main).not.toMatch(/productionCompositionOptions\(\s*process\.env/);
    expect(main).toMatch(/captureRuntimeEnv\(process\.env\)/);
    expect((main.match(/productionCompositionOptions\(runtimeEnv/g) ?? []).length).toBe(1); // AUDIT-D8: one composition site
    const core = readFileSync(join(__dirname, '../../apps/desktop/src/core-services.ts'), 'utf8');
    expect(core).not.toMatch(/env:\s*process\.env/);
    expect(core).not.toMatch(/resolveOpenAiCompatibleConfig\(\)/);
  });
});
