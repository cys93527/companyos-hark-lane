/**
 * Sprint 7 tests A–O: the Model Registry (curated, non-routing), the closed Sprint 6
 * debts (authorization execution points, classified context estimation, provider audit
 * events) and their persistence.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FixedClock, SequenceIdFactory, domainError, estimateText, type Result } from '@companyos/core';
import {
  createAuthorizationService,
  createEnvSecretVault,
  createMockProvider,
  createModelRegistry,
  createProviderRegistry,
  type ModelRegistryService,
  type ProviderRegistry,
  type SecretVault,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const EPOCH = Date.parse('2026-09-01T00:00:00.000Z');
const API_KEY = 'sk-mock-registry-0123456789';
const SCOPE = 'default';

const MODEL = (overrides: Record<string, unknown> = {}) => ({
  modelId: 'standard',
  displayName: 'Standard',
  contextWindow: 100,
  maxOutputTokens: 20,
  capabilities: { streaming: true, structuredOutput: true, toolCalling: true, vision: true },
  pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' as const },
  ...overrides,
});

interface Fixture {
  readonly clock: FixedClock;
  readonly ids: SequenceIdFactory;
  readonly vault: SecretVault;
  readonly denied: Set<string>;
  database(): DurableDatabase;
  providers(): ProviderRegistry;
  models(): ModelRegistryService;
  auth(): ReturnType<typeof createAuthorizationService>;
  restart(): void;
  cleanup(): void;
}

const make = (): Fixture => {
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-model-registry-'));
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();
  const denied = new Set<string>();

  const open = (): DurableDatabase =>
    openDurableDatabase({
      dataDir,
      appliedAt: clock.nowIso(),
      chains: ['core', 'engine', 'provider', 'registry'],
    });

  let database = open();

  const authorize = async ({
    actorId,
    authority,
  }: {
    readonly actorId: string;
    readonly authority: string;
    readonly scopeId?: string;
  }): Promise<Result<true, ReturnType<typeof domainError>>> => {
    void actorId;
    if (denied.has(authority)) {
      return { ok: false, error: domainError('PERMISSION_DENIED', `authority "${authority}" is denied`, { authority }) };
    }
    return { ok: true, value: true };
  };

  const vault = createEnvSecretVault({ env: { COMPANYOS_KEY: API_KEY }, authorize });

  const build = (db: DurableDatabase) => {
    const auth = createAuthorizationService({
      ids,
      clock,
      roles: db.roles,
      assignments: db.roleAssignments,
    });
    const providers = createProviderRegistry({
      ids,
      clock,
      registrations: db.providers,
      models: db.providerModels,
      secretResolver: vault,
      secrets: async () => vault.values(),
      authorize,
      events: db.events,
      systemActor: 'user_test',
    });
    const models = createModelRegistry({
      ids,
      clock,
      records: db.modelRecords,
      aliases: db.modelAliases,
      providers,
      authorize,
      events: db.events,
      scope: SCOPE,
    });
    return { auth, providers, models };
  };

  let built = build(database);

  const fixture: Fixture = {
    clock,
    ids,
    vault,
    denied,
    database: () => database,
    providers: () => built.providers,
    models: () => built.models,
    auth: () => built.auth,
    restart(): void {
      database.close();
      database = open();
      built = build(database);
    },
    cleanup(): void {
      try {
        database.close();
      } catch {
        // already closed
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return fixture;
};

const fixtures: Fixture[] = [];
const fixture = (): Fixture => {
  const created = make();
  fixtures.push(created);
  return created;
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

const keyOf = (modelId = 'standard', providerId = 'mock-a'): string => `${providerId}.${modelId}`;

describe('A/B. registering models', () => {
  it('A: registers a catalogue model as a curated record', async () => {
    const f = fixture();
    await f.providers().register(createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL()] } }));

    const registered = await f.models().registerFromProvider({
      providerId: 'mock-a',
      providerModelId: 'standard',
      actorId: 'user_owner',
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.value).toMatchObject({
      modelKey: keyOf(),
      providerId: 'mock-a',
      providerModelId: 'standard',
      displayName: 'Standard',
      contextWindow: 100,
      maxOutputTokens: 20,
      enabled: true,
      availability: 'available',
    });

    const listed = await f.models().list();
    expect(listed.map((entry) => entry.modelKey)).toEqual([keyOf()]);
    expect((await f.database().modelRecords.list()).items).toHaveLength(1);
  });

  it('B: refuses a duplicate model key and a duplicate provider binding', async () => {
    const f = fixture();
    await f.providers().register(createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL()] } }));
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', modelKey: 'fast', actorId: 'user_owner' });

    const sameKey = await f.models().registerFromProvider({
      providerId: 'mock-a',
      providerModelId: 'standard',
      modelKey: 'fast',
      actorId: 'user_owner',
    });
    expect(sameKey.ok).toBe(false);
    if (!sameKey.ok) expect(sameKey.error.code).toBe('CONFLICT');

    // Same provider model under a different key is refused too (unique binding).
    const sameBinding = await f.models().registerFromProvider({
      providerId: 'mock-a',
      providerModelId: 'standard',
      modelKey: 'other',
      actorId: 'user_owner',
    });
    expect(sameBinding.ok).toBe(false);
    if (!sameBinding.ok) expect(sameBinding.error.code).toBe('CONFLICT');

    // An unknown provider model is a NOT_FOUND, not a silent success.
    const unknown = await f.models().registerFromProvider({
      providerId: 'mock-a',
      providerModelId: 'nope',
      actorId: 'user_owner',
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND');
  });
});

describe('C/D. provider removal and enable/disable', () => {
  it('C: a model whose provider is gone becomes unavailable, never deleted', async () => {
    const f = fixture();
    await f.providers().register(createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL()] } }));
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: 'user_owner' });
    await f.models().bindAlias({ alias: 'fast', modelKey: keyOf(), actorId: 'user_owner' });

    await f.providers().unregister('mock-a');

    expect(await f.models().availability(keyOf())).toEqual({ ok: true, value: 'unavailable' });
    // The registry entry survives: only the binding is gone (outage != data loss).
    expect(await f.models().get(keyOf())).not.toBeNull();
    const resolved = await f.models().resolve('fast');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.code).toBe('AGENT_UNAVAILABLE');
  });

  it('D: disabling hides the model from the default list and refuses resolution', async () => {
    const f = fixture();
    await f.providers().register(createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL()] } }));
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: 'user_owner' });
    await f.models().bindAlias({ alias: 'fast', modelKey: keyOf(), actorId: 'user_owner' });

    const disabled = await f.models().setEnabled(keyOf(), false, 'user_owner');
    expect(disabled.ok).toBe(true);
    if (disabled.ok) expect(disabled.value.availability).toBe('disabled');

    expect(await f.models().list()).toHaveLength(0);
    expect(await f.models().list({ includeDisabled: true })).toHaveLength(1);
    const refused = await f.models().resolve('fast');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('POLICY_DENIED');

    const reenabled = await f.models().setEnabled(keyOf(), true, 'user_owner');
    expect(reenabled.ok).toBe(true);
    if (reenabled.ok) expect(reenabled.value.enabled).toBe(true);
    expect((await f.models().resolve('fast')).ok).toBe(true);
  });
});

describe('E/F/G/H. capability profile, pricing, context window, health', () => {
  it('E: exposes the capability profile from the catalogue', async () => {
    const f = fixture();
    await f.providers().register(
      createMockProvider({
        providerId: 'mock-a',
        kind: 'mock',
        displayName: 'A',
        script: { models: [MODEL({ capabilities: { streaming: true, vision: true } })] },
      }),
    );
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: 'user_owner' });

    const profile = await f.models().capabilityProfile(keyOf());
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;
    expect(profile.value).toMatchObject({
      streaming: true,
      vision: true,
      structuredOutput: false,
      toolCalling: false,
      reasoning: false,
      audio: false,
      contextWindow: 100,
      maxOutputTokens: 20,
    });
  });

  it('F: exposes pricing (and null when the provider publishes none)', async () => {
    const f = fixture();
    await f.providers().register(createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL()] } }));
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: 'user_owner' });
    const record = await f.models().get(keyOf());
    expect(record?.pricing).toEqual({ inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' });
  });

  it('G: carries the context window and max output tokens', async () => {
    const f = fixture();
    await f.providers().register(createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL({ contextWindow: 4096, maxOutputTokens: 512 })] } }));
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: 'user_owner' });
    const record = await f.models().get(keyOf());
    expect(record?.contextWindow).toBe(4096);
    expect(record?.maxOutputTokens).toBe(512);
  });

  it('H: availability follows the PERSISTED provider health', async () => {
    const f = fixture();
    await f.providers().register(
      createMockProvider({
        providerId: 'mock-a',
        kind: 'mock',
        displayName: 'A',
        script: { models: [MODEL()], health: { status: 'degraded', checkedAt: 'now', latencyMs: 9, detail: null } },
      }),
    );
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: 'user_owner' });
    // Sprint 7.1: reads never probe. Until a health check is run, health is unknown and the
    // model is reported available (provider registered, no adverse record).
    expect(await f.models().availability(keyOf())).toEqual({ ok: true, value: 'available' });

    const refreshed = await f.models().refreshHealth('mock-a', 'user_owner');
    expect(refreshed.ok).toBe(true);
    expect(await f.models().availability(keyOf())).toEqual({ ok: true, value: 'degraded' });
    const listed = await f.models().list();
    expect(listed[0]?.availability).toBe('degraded');
  });
});

describe('I/J. logical aliases', () => {
  it('I: binds an alias and resolves it to exactly one model', async () => {
    const f = fixture();
    await f.providers().register(createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL()] } }));
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: 'user_owner' });

    const bound = await f.models().bindAlias({ alias: 'Fast', modelKey: keyOf(), actorId: 'user_owner' });
    expect(bound.ok).toBe(true);
    if (bound.ok) expect(bound.value).toMatchObject({ alias: 'fast', modelKey: keyOf(), scope: SCOPE });

    const resolved = await f.models().resolve('FAST');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.modelKey).toBe(keyOf());

    const unknown = await f.models().resolve('nope');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND');
  });

  it('J: refuses an alias that already points at another model', async () => {
    const f = fixture();
    await f.providers().register(
      createMockProvider({
        providerId: 'mock-a',
        kind: 'mock',
        displayName: 'A',
        script: { models: [MODEL(), MODEL({ modelId: 'premium' })] },
      }),
    );
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: 'user_owner' });
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'premium', actorId: 'user_owner' });
    await f.models().bindAlias({ alias: 'fast', modelKey: keyOf(), actorId: 'user_owner' });

    const conflicting = await f.models().bindAlias({ alias: 'fast', modelKey: keyOf('premium'), actorId: 'user_owner' });
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) {
      expect(conflicting.error.code).toBe('CONFLICT');
      expect(conflicting.error.details['currentModelKey']).toBe(keyOf());
    }

    // Re-binding the SAME target is idempotent.
    const same = await f.models().bindAlias({ alias: 'fast', modelKey: keyOf(), actorId: 'user_owner' });
    expect(same.ok).toBe(true);
    expect(await f.models().aliasList()).toHaveLength(1);
  });
});

describe('K. restart persistence', () => {
  it('K: keeps records, enabled flags and aliases across a restart', async () => {
    const f = fixture();
    await f.providers().register(
      createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL(), MODEL({ modelId: 'premium' })] } }),
    );
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: 'user_owner' });
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'premium', modelKey: 'premium', actorId: 'user_owner' });
    await f.models().bindAlias({ alias: 'fast', modelKey: keyOf(), actorId: 'user_owner' });
    await f.models().setEnabled('premium', false, 'user_owner');

    f.restart();

    const records = await f.models().list({ includeDisabled: true });
    expect(records.map((entry) => entry.modelKey).sort()).toEqual([keyOf(), 'premium'].sort());
    expect(records.find((entry) => entry.modelKey === 'premium')?.enabled).toBe(false);
    expect(await f.models().aliasList()).toHaveLength(1);
    // Aliases survive; resolution now needs the provider to exist again.
    expect(await f.models().get(keyOf())).not.toBeNull();
  });
});

describe('L/M. authorization execution points (Sprint 6 debt, closed)', () => {
  it('L: provider.register / provider.invoke are enforced', async () => {
    const f = fixture();
    f.denied.add('provider.register');
    const refused = await f.providers().register(
      createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL()] } }),
      { actorId: 'user_owner' },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('PERMISSION_DENIED');
    // Nothing was persisted by the refused call.
    expect((await f.database().providers.list()).items).toHaveLength(0);

    f.denied.delete('provider.register');
    await f.providers().register(createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL()] } }), {
      actorId: 'user_owner',
    });

    f.denied.add('provider.invoke');
    const invoked = await f.providers().invoke(
      { providerId: 'mock-a', actorId: 'user_owner' },
      { modelId: 'standard', messages: [{ role: 'user', content: 'x' }] },
    );
    expect(invoked.ok).toBe(false);
    if (!invoked.ok) expect(invoked.error.code).toBe('PERMISSION_DENIED');

    f.denied.delete('provider.invoke');
    const allowed = await f.providers().invoke(
      { providerId: 'mock-a', actorId: 'user_owner' },
      { modelId: 'standard', messages: [{ role: 'user', content: 'x' }] },
    );
    expect(allowed.ok).toBe(true);
  });

  it('L: model.register / model.write are enforced', async () => {
    const f = fixture();
    await f.providers().register(createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL()] } }));
    f.denied.add('model.register');
    const refused = await f.models().registerFromProvider({
      providerId: 'mock-a',
      providerModelId: 'standard',
      actorId: 'user_owner',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('PERMISSION_DENIED');

    f.denied.delete('model.register');
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: 'user_owner' });
    f.denied.add('model.write');
    const toggle = await f.models().setEnabled(keyOf(), false, 'user_owner');
    expect(toggle.ok).toBe(false);
    if (!toggle.ok) expect(toggle.error.code).toBe('PERMISSION_DENIED');
  });

  it('M: secret.read / secret.write are enforced and never leak the value', async () => {
    const f = fixture();
    f.denied.add('secret.read');
    const refused = await f.vault.read('COMPANYOS_KEY', 'user_owner');
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('PERMISSION_DENIED');
      expect(JSON.stringify(refused.error)).not.toContain(API_KEY);
    }

    f.denied.delete('secret.read');
    const allowed = await f.vault.read('COMPANYOS_KEY', 'user_owner');
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.value).toBe(API_KEY);
    // Sprint 7.1 MEDIUM-2: adapters get the authority-bound view, never the raw resolver.
    const view = f.vault.forActor('user_owner');
    f.denied.add('secret.read');
    const viewDenied = await view.read('COMPANYOS_KEY');
    expect(viewDenied.ok).toBe(false);
    if (!viewDenied.ok) expect(JSON.stringify(viewDenied.error)).not.toContain(API_KEY);
    f.denied.delete('secret.read');
    expect(await view.read('COMPANYOS_KEY')).toEqual({ ok: true, value: API_KEY });
    expect(await view.names()).toEqual({ ok: true, value: expect.arrayContaining(['COMPANYOS_KEY']) });
    f.denied.add('secret.write');
    expect((await view.write('NEW_KEY', 'sk-mock-view-0123456789')).ok).toBe(false);
    f.denied.delete('secret.write');
    // The raw SecretResolver surface stays for the composition root only (documented).
    expect(await f.vault.get('COMPANYOS_KEY')).toBe(API_KEY);

    f.denied.add('secret.write');
    const write = await f.vault.write('NEW_KEY', 'sk-mock-another-0123456789', 'user_owner');
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.code).toBe('PERMISSION_DENIED');
    expect(await f.vault.get('NEW_KEY')).toBeNull();
  });
});

describe('N/O. provider audit events and context estimation', () => {
  it('N: writes provider audit events (registered / health_checked / invoked / failed)', async () => {
    const f = fixture();
    await f.providers().register(
      createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL()], outcomes: [{ outputText: 'ok' }, 'rate_limited'] } }),
      { actorId: 'user_owner' },
    );
    await f.providers().health('mock-a', { actorId: 'user_owner' });
    await f.providers().invoke(
      { providerId: 'mock-a', actorId: 'user_owner' },
      { modelId: 'standard', messages: [{ role: 'user', content: 'x' }] },
    );
    await f.providers().invoke(
      { providerId: 'mock-a', actorId: 'user_owner' },
      { modelId: 'standard', messages: [{ role: 'user', content: 'x' }] },
    );

    const types = (await f.database().events.all()).map((entry) => entry.event.type);
    expect(types).toEqual([
      'provider.registered',
      'provider.health_checked',
      'provider.invoked',
      'provider.failed',
    ]);
    // Audit payloads never carry credentials.
    expect(JSON.stringify(await f.database().events.all())).not.toContain(API_KEY);
  });

  it('N: writes model registry audit events', async () => {
    const f = fixture();
    await f.providers().register(createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL()] } }));
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: 'user_owner' });
    await f.models().bindAlias({ alias: 'fast', modelKey: keyOf(), actorId: 'user_owner' });
    await f.models().setEnabled(keyOf(), false, 'user_owner');
    await f.models().setEnabled(keyOf(), true, 'user_owner');

    const types = (await f.database().events.all())
      .map((entry) => entry.event.type)
      .filter((type) => type.startsWith('model.'));
    expect(types).toEqual(['model.registered', 'model.alias_bound', 'model.disabled', 'model.enabled']);
  });

  it('O: classifies CJK / emoji / code instead of assuming ASCII', () => {
    const ascii = estimateText('hello world');
    const cjk = estimateText('你好世界');
    const emoji = estimateText('🚀🚀');
    const code = estimateText('```\nconst x = 1;\n```');

    expect(ascii.breakdown.cjk).toBe(0);
    expect(cjk.tokens).toBeGreaterThanOrEqual(4); // 1 token/char, previously ~1
    expect(cjk.breakdown.cjk).toBe(4);
    expect(emoji.tokens).toBeGreaterThanOrEqual(4);
    expect(code.breakdown.code).toBeGreaterThan(0);
    expect(cjk.conservative).toBe(true);
    // The old heuristic would have said 4 chars / 4 = 1 token for "你好世界".
    expect(cjk.tokens).toBeGreaterThan(Math.ceil(cjk.characters / 4));
  });

  it('O: the pre-flight now refuses a CJK prompt that chars/4 would have allowed', async () => {
    const f = fixture();
    await f.providers().register(
      createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL({ contextWindow: 20, maxOutputTokens: 5 })] } }),
    );
    const refused = await f.providers().invoke(
      { providerId: 'mock-a', actorId: 'user_owner' },
      { modelId: 'standard', messages: [{ role: 'user', content: '这是一个很长的中文提示词，用来测试上下文估算是否准确。' }] },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.details['kind']).toBe('context_limit');
      expect(Number(refused.error.details['estimatedTokens'])).toBeGreaterThan(20);
      expect(refused.error.details['breakdown']).toBeDefined();
    }
  });
});
