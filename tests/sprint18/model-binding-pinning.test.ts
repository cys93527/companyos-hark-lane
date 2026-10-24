/**
 * Sprint 18 / Task-18-02 — run-pinned model bindings (§41 assertion matrix 19–27).
 *
 * The bindings are proven against the REAL ModelRegistry (real records over the real SQLite
 * layer) — no live model API, no provider call, no router. The only seam that is stubbed is the
 * provider health lookup the registry uses to derive availability, because a test must not
 * depend on a network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_MODEL_CAPABILITIES, createModelRecord, ok, type ModelRecord, type Result } from '@companyos/core';
import {
  createMockProvider,
  createModelRegistry,
  createProviderRegistry,
  createRunModelBindingReader,
  createWorkflowLifecycle,
  validateRunModelBindings,
  type ModelRegistryService,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18bind-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18B${String(++seq).padStart(12, '0')}`,
  ulid: () => `18B${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'] as const;
const COMPANY = 'company_default';

interface Fixture {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly providers: ReturnType<typeof createProviderRegistry>;
  readonly registry: ModelRegistryService;
  readonly lifecycle: ReturnType<typeof createWorkflowLifecycle>;
  reader(): ReturnType<typeof createRunModelBindingReader>;
  /** Drop the pinned model row the way storage loss would — the pin must stop resolving. */
  dropModelRecord(modelKey: string): void;
}

const make = (): Fixture => {
  const dataDir = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);

  const providers = createProviderRegistry({
    ids,
    clock,
    registrations: db.providers,
    models: db.providerModels,
    // No secret resolver is wired on purpose: the pin path must never need one.
    authorize: async (): Promise<Result<true, never>> => ok(true as const),
    events: db.events,
    systemActor: 'user_owner',
  } as never);

  const registry = createModelRegistry({
    ids,
    clock,
    records: db.modelRecords,
    aliases: db.modelAliases,
    providers,
    events: db.events,
    scope: 'default',
  });

  const lifecycle = createWorkflowLifecycle({
    ids,
    clock,
    templates: db.templates,
    locks: db.locks,
    proposals: db.proposals,
    snapshots: db.snapshots,
    runs: db.runs,
    events: db.events,
    unitOfWork: db.unitOfWork,
    modelRegistry: registry,
    authorize: async (): Promise<Result<true, never>> => ok(true as const),
  });

  return {
    db,
    dataDir,
    providers,
    registry,
    lifecycle,
    reader: () => createRunModelBindingReader({ runs: db.runs, snapshots: db.snapshots }),
    dropModelRecord(modelKey: string): void {
      db.db.prepare('DELETE FROM model_records WHERE model_key = ?').run(modelKey);
    },
  };
};

const PROVIDER_ID = 'prov_local';
const MODEL_ID = 'local-model-a';

const seedModel = async (f: Fixture, modelKey: string, enabled = true): Promise<ModelRecord> => {
  // A registered provider is required because `ModelRegistry.resolve` derives availability
  // from provider health: a model whose provider is gone must never be pinnable.
  const provider = await f.providers.register(
    createMockProvider({
      providerId: PROVIDER_ID,
      kind: 'mock',
      displayName: 'Local test provider',
      script: { models: [{ modelId: MODEL_ID, displayName: MODEL_ID, contextWindow: 8_192, capabilities: { streaming: false } }] },
    }),
    { actorId: 'user_owner' },
  );
  if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);

  const registered = await f.registry.registerFromProvider({
    providerId: PROVIDER_ID,
    providerModelId: MODEL_ID,
    modelKey,
    actorId: 'user_owner',
  });
  if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
  const stored = await f.registry.get(modelKey);
  if (stored === null) throw new Error(`seeded model ${modelKey} is missing`);
  if (!enabled) {
    const disabled = await f.registry.setEnabled(modelKey, false, 'user_owner');
    if (!disabled.ok) throw new Error(disabled.error.message);
    return disabled.value;
  }
  return stored;
};

/** A second, independent model on the same provider (never used as a default). */
const seedSecondModel = async (f: Fixture): Promise<ModelRecord> => {
  const made = await createModelRecord({
    id: ids.id('mdl'),
    modelKey: 'local.model-b',
    providerId: PROVIDER_ID,
    providerModelId: 'local-model-b',
    displayName: 'local.model-b',
    description: 'second test model',
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    contextWindow: 4_096,
    maxOutputTokens: null,
    pricing: null,
    now: nowIso(),
    actorId: 'user_owner',
  });
  if (!made.ok) throw new Error(made.error.message);
  const stored = await f.registry.get('local.model-b');
  if (stored !== null) return stored;
  await f.db.modelRecords.put(made.value);
  return made.value;
};

const publishedTemplate = async (f: Fixture, label: string): Promise<string> => {
  const template = await f.lifecycle.createTemplate({
    orgId: COMPANY,
    name: `Binding flow ${label}`,
    actorId: 'user_owner',
    traceId: `t18b_tpl_${label}`,
  });
  if (!template.ok) throw new Error(template.error.message);
  const graph = { nodes: [{ id: 's1', kind: 'work' as const, title: 'Work', config: {} }], edges: [] };
  const saved = await f.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: 'user_owner', traceId: `t18b_graph_${label}` });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await f.lifecycle.publish({ templateId: template.value.id, actorId: 'user_owner', traceId: `t18b_pub_${label}` });
  if (!published.ok) throw new Error(published.error.message);
  return template.value.id;
};

describe('T18-02 run-pinned model bindings (trusted, fail closed)', () => {
  it('19. a trusted binding is pinned at run creation', async () => {
    const f = make();
    await seedModel(f, 'local.model-a');
    const templateId = await publishedTemplate(f, 'pinned');
    const run = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_bind',
      actorId: 'user_owner',
      modelBindings: { default: 'local.model-a' },
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.snapshot.modelBindings).toEqual({ default: 'local.model-a' });
  });

  it('20. the binding is durable in the RunSnapshot', async () => {
    const f = make();
    await seedModel(f, 'local.model-a');
    const templateId = await publishedTemplate(f, 'durable');
    const run = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_bind',
      actorId: 'user_owner',
      modelBindings: { default: 'local.model-a' },
    });
    if (!run.ok) throw new Error(run.error.message);
    const stored = await f.db.snapshots.get(run.value.snapshot.snapshotId as never);
    expect(stored?.modelBindings).toEqual({ default: 'local.model-a' });
    expect(stored?.snapshotHash.length).toBe(64);
  });

  it('21. a restart recovers the same binding identity', async () => {
    const f = make();
    await seedModel(f, 'local.model-a');
    const templateId = await publishedTemplate(f, 'restart');
    const run = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_bind',
      actorId: 'user_owner',
      modelBindings: { default: 'local.model-a' },
    });
    if (!run.ok) throw new Error(run.error.message);

    f.db.close();
    const tracked = openDatabases.indexOf(f.db);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const reopened = openDurableDatabase({ dataDir: f.dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
    openDatabases.push(reopened);
    const reader = createRunModelBindingReader({ runs: reopened.runs, snapshots: reopened.snapshots });
    const bindings = await reader.get({ runId: run.value.run.id, companyId: COMPANY });
    expect(bindings.ok).toBe(true);
    if (!bindings.ok) return;
    expect(bindings.value).toEqual({ default: 'local.model-a' });
  });

  it('22. an unknown binding is refused at run creation (no run, no snapshot)', async () => {
    const f = make();
    const templateId = await publishedTemplate(f, 'unknown');
    const run = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_bind',
      actorId: 'user_owner',
      modelBindings: { default: 'no.such-model' },
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.details?.['reason']).toBe('RUN_BINDING_UNKNOWN');
    expect((await f.db.runs.list({ limit: 10 })).items.length).toBe(0);
    expect((await f.db.snapshots.list({ limit: 10 })).items.length).toBe(0);
  });

  it('23. a missing required binding fails closed on read (no default, no latest model)', async () => {
    const f = make();
    await seedModel(f, 'local.model-a');
    const templateId = await publishedTemplate(f, 'missing');
    const run = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_bind',
      actorId: 'user_owner',
      // A run may declare nothing; a consumer that then needs one is refused.
    });
    if (!run.ok) throw new Error(run.error.message);

    const bindings = await f.reader().get({ runId: run.value.run.id, companyId: COMPANY });
    expect(bindings.ok).toBe(true);
    if (!bindings.ok) return;
    expect(bindings.value).toEqual({});

    const resolved = await f.reader().resolve(
      { runId: run.value.run.id, companyId: COMPANY, bindingName: 'default' },
      f.registry,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe('NOT_FOUND');
    expect(resolved.error.details?.['reason']).toBe('RUN_BINDING_MISSING');
  });

  it('24. the runtime can never silently choose a default or latest model', async () => {
    const f = make();
    // Two models exist; nothing in the pin path may look at either of them.
    await seedModel(f, 'local.model-a');
    await seedSecondModel(f);
    const templateId = await publishedTemplate(f, 'no-default');
    const run = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_bind',
      actorId: 'user_owner',
    });
    if (!run.ok) throw new Error(run.error.message);

    const withoutName = await f.reader().resolve(
      { runId: run.value.run.id, companyId: COMPANY, bindingName: 'anything' },
      f.registry,
    );
    expect(withoutName.ok).toBe(false);
    if (withoutName.ok) return;
    expect(withoutName.error.details?.['reason']).toBe('RUN_BINDING_MISSING');

    // And an invalid binding NAME never falls back to the registry listing either.
    const badName = await f.reader().resolve(
      { runId: run.value.run.id, companyId: COMPANY, bindingName: 'local.model-b' },
      f.registry,
    );
    expect(badName.ok).toBe(false);
    if (badName.ok) return;
    expect(badName.error.details?.['reason']).toBe('RUN_BINDING_MISSING');
  });

  it('25. an agent/task payload cannot overwrite the pin', async () => {
    const f = make();
    await seedModel(f, 'local.model-a');
    await seedSecondModel(f);
    const templateId = await publishedTemplate(f, 'no-override');

    // The pin comes from the trusted application configuration only. A "payload" that tries to
    // supply a different map simply produces a different run — never a mutation of this one.
    const pinned = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_bind',
      actorId: 'user_owner',
      modelBindings: { default: 'local.model-a' },
    });
    if (!pinned.ok) throw new Error(pinned.error.message);

    const other = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_bind',
      actorId: 'user_owner',
      modelBindings: { default: 'local.model-b' },
    });
    if (!other.ok) throw new Error(other.error.message);

    const first = await f.reader().get({ runId: pinned.value.run.id, companyId: COMPANY });
    const second = await f.reader().get({ runId: other.value.run.id, companyId: COMPANY });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toEqual({ default: 'local.model-a' });
    expect(second.value).toEqual({ default: 'local.model-b' });

    // There is no writer for an existing run: the only mutation surface is a new run.
    const lifecycleMutations = Object.keys(f.lifecycle).filter((key) => /binding/i.test(key));
    expect(lifecycleMutations).toEqual([]);
  });

  it('26. the binding is immutable after run creation', async () => {
    const f = make();
    await seedModel(f, 'local.model-a');
    const templateId = await publishedTemplate(f, 'immutable');
    const run = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_bind',
      actorId: 'user_owner',
      modelBindings: { default: 'local.model-a' },
    });
    if (!run.ok) throw new Error(run.error.message);
    const snapshotId = run.value.snapshot.snapshotId;

    // Storage-level rewrite: the run's own pin stays what it was.
    const stored = await f.db.snapshots.get(snapshotId as never);
    await f.db.snapshots.put({ ...stored!, modelBindings: { default: 'local.model-b' } });
    const after = await f.db.snapshots.get(snapshotId as never);
    expect(after?.modelBindings).toEqual({ default: 'local.model-a' });
    const bindings = await f.reader().get({ runId: run.value.run.id, companyId: COMPANY });
    if (!bindings.ok) throw new Error(bindings.error.message);
    expect(bindings.value).toEqual({ default: 'local.model-a' });
  });

  it('27. no live network model is needed anywhere in the pin path', async () => {
    const f = make();
    await seedModel(f, 'local.model-a');
    const templateId = await publishedTemplate(f, 'offline');
    const run = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_bind',
      actorId: 'user_owner',
      modelBindings: { default: 'local.model-a' },
    });
    if (!run.ok) throw new Error(run.error.message);
    const resolved = await f.reader().resolve(
      { runId: run.value.run.id, companyId: COMPANY, bindingName: 'default' },
      f.registry,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.modelKey).toBe('local.model-a');
    expect(resolved.value.providerId).toBe('prov_local');
  });

  it('28. a disabled model cannot be pinned', async () => {
    const f = make();
    await seedModel(f, 'local.model-off', false);
    const templateId = await publishedTemplate(f, 'disabled');
    const run = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_bind',
      actorId: 'user_owner',
      modelBindings: { default: 'local.model-off' },
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(['RUN_BINDING_DISABLED', 'RUN_BINDING_UNAVAILABLE']).toContain(run.error.details?.['reason']);
  });

  it('29. the validator refuses an unusable binding name or key', async () => {
    const f = make();
    await seedModel(f, 'local.model-a');
    const badName = await validateRunModelBindings({ 'not a name!': 'local.model-a' }, f.registry);
    expect(badName.ok).toBe(false);
    if (badName.ok) return;
    expect(badName.error.details?.['reason']).toBe('RUN_BINDING_NAME_INVALID');

    const badKey = await validateRunModelBindings({ default: 'NOT A MODEL KEY' }, f.registry);
    expect(badKey.ok).toBe(false);
    if (badKey.ok) return;
    expect(badKey.error.details?.['reason']).toBe('RUN_BINDING_KEY_INVALID');
  });

  it('30. a pinned binding whose model disappears stops resolving (never a substitute)', async () => {
    const f = make();
    await seedModel(f, 'local.model-a');
    await seedSecondModel(f);
    const templateId = await publishedTemplate(f, 'vanished');
    const run = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_bind',
      actorId: 'user_owner',
      modelBindings: { default: 'local.model-a' },
    });
    if (!run.ok) throw new Error(run.error.message);

    f.dropModelRecord('local.model-a');
    const resolved = await f.reader().resolve(
      { runId: run.value.run.id, companyId: COMPANY, bindingName: 'default' },
      f.registry,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.details?.['reason']).toBe('RUN_BINDING_UNKNOWN');

    // The pin itself is untouched: the run still records what it was frozen on.
    const bindings = await f.reader().get({ runId: run.value.run.id, companyId: COMPANY });
    if (!bindings.ok) throw new Error(bindings.error.message);
    expect(bindings.value).toEqual({ default: 'local.model-a' });
  });
});
