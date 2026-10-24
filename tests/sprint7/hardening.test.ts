/**
 * Sprint 7.1 — the four hardening items, each with a regression that would fail if the
 * debt were reintroduced.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AUTHORITIES, DomainError, FixedClock, SequenceIdFactory, domainError, type Result } from '@companyos/core';
import {
  createAuthorizationService,
  createEnvSecretVault,
  createMockProvider,
  createModelRegistry,
  createProviderRegistry,
  ensureBootstrapOwner,
  type ModelRegistryService,
  type ProviderRegistry,
  type SecretVault,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const EPOCH = Date.parse('2026-10-01T00:00:00.000Z');
const API_KEY = 'sk-mock-hardening-0123456789';

const MODEL = () => ({
  modelId: 'standard',
  displayName: 'Standard',
  contextWindow: 1000,
  maxOutputTokens: 100,
  capabilities: { streaming: true },
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
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-hardening-'));
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();
  const denied = new Set<string>();

  const open = (): DurableDatabase =>
    openDurableDatabase({ dataDir, appliedAt: clock.nowIso(), chains: ['core', 'engine', 'provider', 'registry'] });

  let database = open();

  const authorize = async ({ authority }: { readonly authority: string; readonly actorId: string }) =>
    denied.has(authority)
      ? { ok: false as const, error: domainError('PERMISSION_DENIED', `denied: ${authority}`, { authority }) }
      : { ok: true as const, value: true as const };

  const vault = createEnvSecretVault({ env: { COMPANYOS_KEY: API_KEY }, authorize });

  const build = (db: DurableDatabase) => {
    const auth = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
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
      scope: 'default',
    });
    return { auth, providers, models };
  };

  let built = build(database);

  return {
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
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Windows may still hold -wal/-shm briefly; a leftover temp dir is harmless.
      }
    },
  };
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

describe('7.1-1. bootstrap is explicit, not fail-open', () => {
  it('denies everything until the owner role is provisioned, then closes the window', async () => {
    const f = fixture();
    // No roles yet: the decision must be a denial, not an implicit allow.
    const before = await f.auth().decide({ actorId: 'user_owner', authority: 'secret.write' });
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.error.code).toBe('PERMISSION_DENIED');

    const bootstrapped = await ensureBootstrapOwner(f.auth(), { actorId: 'user_owner' });
    expect(bootstrapped.ok).toBe(true);
    if (!bootstrapped.ok) return;
    expect(bootstrapped.value).toMatchObject({ provisioned: true, reason: 'provisioned' });

    for (const authority of AUTHORITIES) {
      const decision = await f.auth().decide({ actorId: 'user_owner', authority });
      expect(decision.ok, `owner should hold ${authority}`).toBe(true);
    }
    // Other actors gain nothing from the bootstrap window.
    expect((await f.auth().decide({ actorId: 'user_other', authority: 'secret.write' })).ok).toBe(false);

    // Second call does nothing: the window is closed for good.
    const again = await ensureBootstrapOwner(f.auth(), { actorId: 'user_intruder' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value).toMatchObject({ provisioned: false, reason: 'roles_already_defined' });
    expect((await f.auth().decide({ actorId: 'user_intruder', authority: 'secret.write' })).ok).toBe(false);

    // The bootstrap state is durable.
    f.restart();
    expect((await f.auth().listRoles()).map((role) => role.key)).toEqual(['owner']);
    expect((await f.auth().decide({ actorId: 'user_owner', authority: 'model.write' })).ok).toBe(true);
    expect((await f.auth().decide({ actorId: 'user_intruder', authority: 'model.write' })).ok).toBe(false);
  });
});

describe('7.1-2. secret access is authority-bound', () => {
  it('the view enforces read/write and never leaks a value', async () => {
    const f = fixture();
    const view = f.vault.forActor('user_agent');

    f.denied.add('secret.read');
    const readDenied = await view.read('COMPANYOS_KEY');
    expect(readDenied.ok).toBe(false);
    if (!readDenied.ok) {
      expect(readDenied.error.code).toBe('PERMISSION_DENIED');
      expect(JSON.stringify(readDenied.error)).not.toContain(API_KEY);
    }
    const resolveDenied = await view.resolve({ id: 's1', providerId: 'p', purpose: 'api_key', source: 'env', envName: 'COMPANYOS_KEY' });
    expect(resolveDenied.ok).toBe(false);
    const namesDenied = await view.names();
    expect(namesDenied.ok).toBe(false);

    f.denied.delete('secret.read');
    expect(await view.read('COMPANYOS_KEY')).toEqual({ ok: true, value: API_KEY });
    expect(view.actorId).toBe('user_agent');

    f.denied.add('secret.write');
    const writeDenied = await view.write('K', 'sk-mock-view-9876543210');
    expect(writeDenied.ok).toBe(false);
    if (!writeDenied.ok) expect(writeDenied.error.code).toBe('PERMISSION_DENIED');
    const removeDenied = await view.remove('COMPANYOS_KEY');
    expect(removeDenied.ok).toBe(false);
    expect(await f.vault.get('COMPANYOS_KEY')).toBe(API_KEY);

    f.denied.delete('secret.write');
    expect(await view.write('K', 'sk-mock-view-9876543210')).toEqual({ ok: true, value: true });
  });
});

describe('7.1-3. every provider failure mode is audited', () => {
  it('audits a plain Error, a marked DomainError and a stream failure', async () => {
    const f = fixture();
    const base = createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL()] } });
    let mode: 'plain' | 'unmarked' | 'ok' = 'plain';
    const adapter = {
      describe: () => base.describe(),
      listModels: () => base.listModels(),
      health: () => base.health(),
      stream: base.stream,
      invoke: async (): Promise<Result<never, DomainError>> => {
        if (mode === 'plain') throw new Error('socket hang up: ECONNRESET');
        if (mode === 'unmarked') {
          return { ok: false, error: new DomainError('AGENT_UNAVAILABLE', 'adapter gave up', { details: {} }) };
        }
        return { ok: false, error: new DomainError('TIMEOUT', 'timed out after 30s', { details: {} }) };
      },
    };
    await f.providers().register(adapter as never, { actorId: 'user_owner' });

    const request = { modelId: 'standard', messages: [{ role: 'user', content: 'x' }] } as const;

    mode = 'plain';
    const plain = await f.providers().invoke({ providerId: 'mock-a', actorId: 'user_owner' }, request);
    expect(plain.ok).toBe(false);

    mode = 'unmarked';
    const unmarked = await f.providers().invoke({ providerId: 'mock-a', actorId: 'user_owner' }, request);
    expect(unmarked.ok).toBe(false);

    mode = 'ok';
    const timeout = await f.providers().invoke({ providerId: 'mock-a', actorId: 'user_owner' }, request);
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) expect(timeout.error.code).toBe('TIMEOUT');

    // A failing stream is audited too.
    const failing = createMockProvider({
      providerId: 'mock-b',
      kind: 'mock',
      displayName: 'B',
      script: { models: [MODEL()], streamError: 'rate_limited' },
    });
    await f.providers().register(failing, { actorId: 'user_owner' });
    const chunks = [];
    for await (const chunk of f.providers().stream({ providerId: 'mock-b', actorId: 'user_owner' }, request)) {
      chunks.push(chunk);
    }
    expect(chunks.every((chunk) => !chunk.ok)).toBe(true);

    const failures = (await f.database().events.all())
      .filter((entry) => entry.event.type === 'provider.failed')
      .map((entry) => entry.event.payload as Record<string, unknown>);
    expect(failures).toHaveLength(4);
    const phases = failures.map((payload) => String(payload['phase']));
    expect(phases.filter((phase) => phase === 'invoke')).toHaveLength(3);
    expect(phases.filter((phase) => phase === 'stream')).toHaveLength(1);
    const kinds = failures.map((payload) => String(payload['kind']));
    // Classified, not "unknown": a socket error reads as unavailable, a timeout as timeout.
    expect(kinds).toContain('unavailable');
    expect(kinds).toContain('timeout');
    expect(kinds).toContain('rate_limited');
    // Nothing in the audit trail may carry a credential.
    expect(JSON.stringify(await f.database().events.all())).not.toContain(API_KEY);
  });
});

describe('Closeout-7.5 MEDIUM-1/MEDIUM-4. remaining audit paths and the role conflict', () => {
  it('audits a preflight refusal and a failed registration', async () => {
    const f = fixture();
    const mock = createMockProvider({
      providerId: 'mock-a',
      kind: 'mock',
      displayName: 'A',
      script: { models: [MODEL()] },
    });
    await f.providers().register(mock, { actorId: 'user_owner' });

    const refused = await f.providers().invoke(
      { providerId: 'mock-a', actorId: 'user_owner' },
      { modelId: 'nope', messages: [{ role: 'user', content: 'x' }] },
    );
    expect(refused.ok).toBe(false);

    const duplicate = await f.providers().register(mock, { actorId: 'user_owner' });
    expect(duplicate.ok).toBe(false);

    const phases = (await f.database().events.all())
      .filter((entry) => entry.event.type === 'provider.failed')
      .map((entry) => String((entry.event.payload as Record<string, unknown>)['phase']));
    expect(phases).toEqual(['preflight', 'register']);
    // A preflight refusal never reached the adapter.
    expect(mock.calls).toHaveLength(0);
  });

  it('turns a duplicate role key into a CONFLICT instead of a raw storage error', async () => {
    const f = fixture();
    const input = {
      companyId: 'company_default',
      key: 'owner',
      name: 'Owner',
      description: '',
      authorities: ['model.read'] as const,
    };
    expect((await f.auth().defineRole(input)).ok).toBe(true);
    const second = await f.auth().defineRole({ ...input, name: 'Owner again' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('CONFLICT');
  });

  it('bootstrap twice in a row provisions once and grants nobody else', async () => {
    const f = fixture();
    const first = await ensureBootstrapOwner(f.auth(), { actorId: 'user_owner' });
    expect(first.ok && first.value.provisioned).toBe(true);
    const second = await ensureBootstrapOwner(f.auth(), { actorId: 'user_intruder' });
    expect(second.ok && second.value.provisioned).toBe(false);
    expect((await f.auth().listRoles()).filter((role) => role.key === 'owner')).toHaveLength(1);
    expect((await f.auth().decide({ actorId: 'user_intruder', authority: 'model.write' })).ok).toBe(false);
  });
});

describe('7.1-4. availability reads never probe; refresh is explicit', () => {
  it('list/get use persisted health only, and refreshHealth is authorized + audited', async () => {
    const f = fixture();
    const mock = createMockProvider({
      providerId: 'mock-a',
      kind: 'mock',
      displayName: 'A',
      script: { models: [MODEL()], health: { status: 'degraded', checkedAt: 'now', latencyMs: 5, detail: null } },
    });
    await f.providers().register(mock, { actorId: 'user_owner' });
    await f.models().registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: 'user_owner' });

    // Reads must not touch the provider.
    await f.models().list();
    await f.models().get('mock-a.standard');
    await f.models().availability('mock-a.standard');
    expect(mock.healthCalls).toBe(0);
    expect(await f.models().get('mock-a.standard')).toMatchObject({ availability: 'available' });

    // Explicit refresh: exactly one probe, audited.
    const refreshed = await f.models().refreshHealth('mock-a', 'user_owner');
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) expect(refreshed.value[0]?.availability).toBe('degraded');
    expect(mock.healthCalls).toBe(1);
    const audits = (await f.database().events.all()).filter(
      (entry) => entry.event.type === 'provider.health_checked',
    );
    // One from the provider registry itself, one from the registry's refresh trigger.
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // A denied `provider.read` refuses the refresh and probes nothing further.
    f.denied.add('provider.read');
    const denied = await f.models().refreshHealth('mock-a', 'user_owner');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('PERMISSION_DENIED');
    expect(mock.healthCalls).toBe(1);

    // `get` now derives from the persisted (degraded) health, with no extra probe.
    f.denied.delete('provider.read');
    expect(await f.models().get('mock-a.standard')).toMatchObject({ availability: 'degraded' });
    expect(mock.healthCalls).toBe(1);

    // Provider removal still reports unavailable - derived, never probed, never deleted.
    await f.providers().unregister('mock-a', { actorId: 'user_owner' });
    expect(await f.models().get('mock-a.standard')).toMatchObject({ availability: 'unavailable' });
    expect(mock.healthCalls).toBe(1);
  });
});
