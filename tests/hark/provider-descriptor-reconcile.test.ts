/**
 * PROVIDER-RECONCILE (docs/hark-lane/PROVIDER_DESCRIPTOR_RECONCILE.md) — regression for the
 * 2026-11-05 Windows black-window report: an existing user database (created by v0.1.x /
 * earlier source runs) refused to start because
 *   "Provider "model.openai-compatible" is persisted with a different descriptor (models);
 *    refusing to replace it silently."
 *
 * Root cause: the rebind check compared the PERSISTED catalogue snapshot (which only ever grew:
 * registration + every models() call upserted, nothing ever removed) with the LIVE upstream
 * GET /models list. The first time the endpoint retired or renamed a model (or the user pointed
 * COS_MODEL_BASE_URL at another endpoint) the composition threw and goals could not start.
 *
 * Through the REAL production composition over a real durable database seeded with the
 * descriptor shape every released build wrote (kind openai-compatible, displayName
 * "OpenAI-compatible endpoint", one provider_models row per upstream id). Loopback fake
 * endpoint only: no network beyond 127.0.0.1, CNY 0.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { ok, type DomainError, type ModelProviderPort, type Result } from '@companyos/core';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;
const PROVIDER_ID = 'model.openai-compatible';
const root = mkdtempSync(join(tmpdir(), 'companyos-provider-reconcile-'));
const dbs: DurableDatabase[] = [];
const servers: Server[] = [];
afterAll(async () => {
  for (const db of dbs) { try { db.close(); } catch { /* already closed */ } }
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  rmSync(root, { recursive: true, force: true });
});

/** A loopback OpenAI-compatible endpoint whose /models list the test changes between starts. */
const startEndpoint = async (): Promise<{ url: string; models: string[]; setDown(down: boolean): void }> => {
  const state = { models: [] as string[], down: false };
  const server = createServer((req, res) => {
    if (state.down) { res.writeHead(503); res.end(); return; }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: state.models.map((id) => ({ id, object: 'model' })) }));
      return;
    }
    res.writeHead(404); res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/v1`, models: state.models, setDown: (down) => { state.down = down; } };
};

const envFor = (url: string): Record<string, string> => ({
  COS_MODEL_BASE_URL: url,
  COS_MODEL_ID: 'deepseek-chat',
  COS_MODEL_AUTHENTICATION: 'NONE',
});

const compose = async (dataDir: string, env: Record<string, string>) => {
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  dbs.push(db);
  const foundation = await openArtifactFoundation({ casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, { artifactFoundation: foundation as never, runtimeEnv: env } as never);
  return { db, core };
};

const catalogue = (db: DurableDatabase): string[] =>
  (db.db.prepare('SELECT model_id AS m FROM provider_models WHERE provider_id = ? ORDER BY model_id').all(PROVIDER_ID) as { m: string }[]).map((row) => row.m);

const events = (db: DurableDatabase, type: string): Record<string, unknown>[] =>
  (db.db.prepare('SELECT payload AS p FROM events WHERE type = ? ORDER BY global_position').all(type) as { p: string }[]).map((row) => JSON.parse(row.p) as Record<string, unknown>);

/** Seed the descriptor + catalogue exactly as v0.1.0–v0.1.3 persisted them (same row shapes). */
const seedReleasedShape = async (dataDir: string, models: readonly string[], over: { kind?: string; displayName?: string } = {}): Promise<void> => {
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  const at = '2026-10-31T12:00:00.000Z';
  await db.providers.put({ id: PROVIDER_ID, providerId: PROVIDER_ID, kind: over.kind ?? 'openai-compatible', displayName: over.displayName ?? 'OpenAI-compatible endpoint', enabled: true, lastHealth: null, registeredAt: at, updatedAt: at });
  for (const modelId of models) {
    await db.providerModels.put({ id: `${PROVIDER_ID}:${modelId}`, providerId: PROVIDER_ID, modelId, displayName: modelId, contextWindow: 128_000, maxOutputTokens: null, capabilities: { structuredOutput: true } as never, pricing: null, metadata: {}, updatedAt: at });
  }
  db.close();
};

describe('PROVIDER-RECONCILE: an existing user database starts after the upstream catalogue changed', () => {
  it('R1 a released-shape DB whose catalogue the endpoint no longer offers rebinds and reconciles (audited)', async () => {
    const dataDir = join(root, 'r1');
    // What an older run accumulated: the ids the endpoint offered then (incl. a retired one).
    await seedReleasedShape(dataDir, ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']);
    const endpoint = await startEndpoint();
    endpoint.models.push('deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash');
    const { db, core } = await compose(dataDir, envFor(endpoint.url));
    expect(core).not.toBeNull();
    expect(core!.compositionError).toBeNull();
    expect(core!.modelAdapterStatus.state).toBe('BOUND');
    expect(core!.providers.get(PROVIDER_ID)).not.toBeNull();
    expect(catalogue(db)).toEqual(['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash']);
    const reconciled = events(db, 'provider.catalogue_reconciled');
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({ providerId: PROVIDER_ID, phase: 'rebind', added: ['deepseek-v4-flash'], removed: ['deepseek-coder'] });
    expect(events(db, 'provider.rebound').at(-1)).toMatchObject({ providerId: PROVIDER_ID, catalogueVerified: true, models: 3 });
    db.close();
  });

  it('R2 an unchanged catalogue rebinds with no reconcile event; an unreachable endpoint keeps the snapshot and still starts', async () => {
    const dataDir = join(root, 'r2');
    const endpoint = await startEndpoint();
    endpoint.models.push('deepseek-chat');
    const first = await compose(dataDir, envFor(endpoint.url));
    expect(first.core?.modelAdapterStatus.state).toBe('BOUND');
    expect(events(first.db, 'provider.registered')).toHaveLength(1);
    first.db.close();

    const second = await compose(dataDir, envFor(endpoint.url));
    expect(second.core?.modelAdapterStatus.state).toBe('BOUND');
    expect(events(second.db, 'provider.catalogue_reconciled')).toHaveLength(0);
    second.db.close();

    endpoint.setDown(true); // offline / 5xx at startup used to refuse the rebind -> dead composition
    const third = await compose(dataDir, envFor(endpoint.url));
    expect(third.core).not.toBeNull();
    expect(third.core!.modelAdapterStatus.state).toBe('BOUND');
    expect(catalogue(third.db)).toEqual(['deepseek-chat']);
    expect(events(third.db, 'provider.rebound').at(-1)).toMatchObject({ catalogueVerified: false, models: null });
    third.db.close();
  });

  it('R3 descriptor drift is refused unless this build deliberately supersedes exactly the persisted descriptor (audited update)', async () => {
    const dataDir = join(root, 'r3');
    await seedReleasedShape(dataDir, ['deepseek-chat'], { displayName: 'OpenAI compatible (old build)' });
    const endpoint = await startEndpoint();
    endpoint.models.push('deepseek-chat');
    // The shipped adapter does not declare that descriptor: drift stays a refusal (T18-07 B6) -> DEGRADED, not dead.
    const refusedRun = await compose(dataDir, envFor(endpoint.url));
    expect(refusedRun.core!.modelAdapterStatus).toMatchObject({ state: 'REFUSED', code: 'CONFLICT' });
    expect(refusedRun.core!.modelAdapterStatus.message).toMatch(/displayName/u);
    refusedRun.db.close();

    // A newer build that names the exact earlier descriptor it supersedes is re-bound and the row updated.
    const { db, core } = await compose(dataDir, {});
    const actor = (await db.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
    const adapter = (supersedes: { kind: string; displayName: string }[]): ModelProviderPort => ({
      describe: () => ({ providerId: PROVIDER_ID, kind: 'openai-compatible', displayName: 'OpenAI-compatible endpoint', version: '2', supersedes }),
      listModels: () => Promise.resolve(ok([{ modelId: 'deepseek-chat', displayName: 'deepseek-chat', contextWindow: 128_000, capabilities: { structuredOutput: true } }])),
      health: () => Promise.resolve(ok(undefined as never)),
      invoke: () => { throw new Error('never invoked'); },
      stream(): AsyncIterable<Result<never, DomainError>> { return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true as const, value: undefined }) }) }; },
    });
    const wrongClaim = await core!.providers.register(adapter([{ kind: 'openai-compatible', displayName: 'something else' }]), { actorId: actor });
    expect(wrongClaim.ok).toBe(false);
    const accepted = await core!.providers.register(adapter([{ kind: 'openai-compatible', displayName: 'OpenAI compatible (old build)' }]), { actorId: actor });
    expect(accepted.ok).toBe(true);
    expect((await db.providers.get(PROVIDER_ID))?.displayName).toBe('OpenAI-compatible endpoint');
    expect(events(db, 'provider.descriptor_updated')).toEqual([
      expect.objectContaining({ providerId: PROVIDER_ID, version: '2', fields: ['displayName'], from: { kind: 'openai-compatible', displayName: 'OpenAI compatible (old build)' }, to: { kind: 'openai-compatible', displayName: 'OpenAI-compatible endpoint' } }),
    ]);
    db.close();
  });

  it('R4 a different adapter KIND under the persisted id is still refused - but the app composes DEGRADED with a clear reason', async () => {
    const dataDir = join(root, 'r4');
    await seedReleasedShape(dataDir, ['x'], { kind: 'some-other-adapter' });
    const endpoint = await startEndpoint();
    endpoint.models.push('deepseek-chat');
    const { db, core } = await compose(dataDir, envFor(endpoint.url));
    expect(core).not.toBeNull(); // used to be null: whole composition failed -> no goals, no runs
    expect(core!.compositionError).toBeNull();
    expect(core!.modelAdapterStatus).toMatchObject({ state: 'REFUSED', providerId: PROVIDER_ID, code: 'CONFLICT' });
    expect(core!.modelAdapterStatus.message).toMatch(/model\.openai-compatible/u);
    expect(core!.modelAdapterStatus.message).toMatch(/kind/u);
    expect(core!.providers.get(PROVIDER_ID)).toBeNull();
    // Nothing persisted was replaced.
    expect((await db.providers.get(PROVIDER_ID))?.kind).toBe('some-other-adapter');
    expect(catalogue(db)).toEqual(['x']);
    expect(events(db, 'provider.failed').at(-1)).toMatchObject({ providerId: PROVIDER_ID, phase: 'register' });
    db.close();
  });

  it('R5 a live catalogue read during the session replaces (not unions) the snapshot', async () => {
    const dataDir = join(root, 'r5');
    const endpoint = await startEndpoint();
    endpoint.models.push('a', 'b');
    const { db, core } = await compose(dataDir, envFor(endpoint.url));
    expect(catalogue(db)).toEqual(['a', 'b']);
    endpoint.models.splice(0, endpoint.models.length, 'b', 'c');
    const listed = await core!.providers.models(PROVIDER_ID);
    expect(listed.ok).toBe(true);
    expect(catalogue(db)).toEqual(['b', 'c']);
    expect(events(db, 'provider.catalogue_reconciled').at(-1)).toMatchObject({ phase: 'catalogue', added: ['c'], removed: ['a'] });
    db.close();
  });
});
