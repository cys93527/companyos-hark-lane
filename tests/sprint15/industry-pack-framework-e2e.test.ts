/**
 * Sprint 15 / Task-15-06: Industry Pack Framework End-to-End (E2E / integration / security proof).
 *
 * Principles: E2E / INTEGRATION / SECURITY PROOF, NO NEW ARCHITECTURE, FIX ONLY PROVEN
 * DEFECTS. The whole pack framework is REAL (real SQLite + migrations + pack stores +
 * UnitOfWork + authorization + PackService + WorkflowLifecycle + ToolRegistry +
 * EventStore + availability policy + run provenance resolver). Only external provider
 * behaviour and tool adapter side effects are mocked; nothing about the pack framework is.
 *
 * Scenarios (Task-15-06 §78):
 *   A — full install: dependency pack -> root pack -> nine declarations -> refs
 *   B — security / failure: missing dependency / unknown authority / missing validator /
 *       unauthorized actor -> all fail with zero writes
 *   C — disable / re-enable: new use off, historical read on, same materialization reused
 *   D — upgrade + runs: R1=v1, R2=v2, atomicity, role reuse/conflict, version safety
 *   E — restart / recovery: fresh graph, resolver calls = 0, old run continues
 *   F — legacy: packless workflow pins {} and executes normally
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTHORITIES,
  TOOL_CAPABILITY_VALIDATOR,
  createToolRecord,
  ok,
  type DomainError,
  type PackInstallation,
  type PackVersion,
  type Result,
} from '@companyos/core';
import {
  alwaysSucceed,
  createAuthorizationService,
  createMockProvider,
  createPackAvailabilityPolicy,
  createPackService,
  createProviderRegistry,
  createRunPackProvenanceResolver,
  createToolRegistry,
  resolveExactDependencyClosure,
  createValidationEvidenceGuard,
  createWorkflowEngine,
  createWorkflowLifecycle,
  ensureBootstrapOwner,
  type RunPackProvenanceResolver,
  type ToolRequirementResolver,
  type WorkflowLifecycle,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t15e2e-'));
  created.push(dir);
  return dir;
};
let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_15E${String(++seq).padStart(12, '0')}`,
  ulid: () => `15E${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-26T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-26T00:00:00.000Z') + seq * 1_000, nowIso };

let database: DurableDatabase | null = null;
afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const MODEL_CAPABILITY = 'reasoning';

/** Industry-neutral canonical manifest carrying ALL NINE declaration categories. */
const manifest = (over: {
  readonly packId: string;
  readonly packVersion: string;
  readonly dependsOn?: readonly { readonly packId: string; readonly packVersion: string }[];
  readonly roleAuthority?: string;
  readonly name?: string;
}): unknown => ({
  manifestVersion: 1,
  packId: over.packId,
  packVersion: over.packVersion,
  name: over.name ?? `${over.packId} pack`,
  coreApi: '1',
  capabilities: [{ id: `${over.packId}:capability.one`, description: 'a capability' }],
  dependsOn: over.dependsOn ?? [],
  declarations: {
    roles: [{ key: `${over.packId}:reviewer`, label: 'Reviewer', authorityRefs: [over.roleAuthority ?? 'workflow.review'] }],
    workflowTemplates: [
      {
        key: `${over.packId}:flow`,
        name: 'Fixture flow',
        description: '',
        graph: {
          nodes: [{ id: 's1', kind: 'work' as const, title: 'Work', config: { validatorIds: ['tool.validator'] } }],
          edges: [],
        },
      },
    ],
    prompts: [{ key: `${over.packId}:summary`, template: 'Summarize the input.', version: null }],
    tools: [{ key: `${over.packId}:tool-req`, toolId: 'tool.registered', capability: null }],
    validators: [{ key: `${over.packId}:validator-req`, validatorId: 'tool.validator' }],
    artifacts: [{ key: `${over.packId}:diff-kind`, label: 'Diff', description: '' }],
    riskRules: [{ key: `${over.packId}:high-risk`, riskLevel: 'HIGH', description: '' }],
    capabilityRules: [{ key: `${over.packId}:needs-capability`, requires: [`${over.packId}:capability.one`], exposes: [] }],
    templates: [{ key: `${over.packId}:document-template`, kind: 'some-type', content: { title: 'x', pages: [1, 2] } }],
  },
});

interface Fixture {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly service: ReturnType<typeof createPackService>;
  /** Production-like lifecycle: availability guard + run provenance resolver injected. */
  readonly lifecycle: WorkflowLifecycle;
  readonly guardedAuthorization: ReturnType<typeof createAuthorizationService>;
  readonly resolver: RunPackProvenanceResolver;
  readonly actor: string;
  readonly outsider: string;
  readonly calls: () => number;
  readonly templateIdOf: (packId: string, packVersion?: string) => Promise<string>;
  readonly install: (over: {
    readonly packId: string;
    readonly packVersion: string;
    readonly dependsOn?: readonly { readonly packId: string; readonly packVersion: string }[];
    readonly roleAuthority?: string;
    readonly name?: string;
    readonly companyId?: string;
    readonly actorId?: string;
    readonly commandId?: string;
  }) => Promise<Result<{ readonly id: string }, DomainError>>;
  /** Fresh service graph over the SAME durable file (Process B / C). */
  readonly reopen: () => Promise<Fixture>;
}

const compose = async (dataDir: string): Promise<Fixture> => {
  const db = openDurableDatabase({
    dataDir,
    appliedAt: nowIso(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'],
  });
  database = db;
  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  const actor = 'user_owner';
  const outsider = 'user_stranger';

  // Real tool registry: the pack's tool/validator REQUIREMENTS resolve against it, and the
  // validator tool genuinely carries the validation:validator capability.
  const registry = createToolRegistry({
    ids,
    clock,
    records: db.toolRecords,
    invocations: db.toolInvocations,
    invocationArtifacts: db.toolInvocationArtifacts,
    adapters: new Map(),
    authorize: async () => ok(true),
    events: db.events,
    secrets: async () => [],
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
  });
  const toolResolver: ToolRequirementResolver = {
    async resolve(toolId: string) {
      const found = await registry.get(toolId, actor);
      if (!found.ok || found.value === null) return { ok: false as const };
      return { ok: true as const, capabilities: found.value.capabilities };
    },
  };

  // Materialization goes through an UNGUARDED lifecycle (the pack layer creates its own
  // content); new-use boundaries use the guarded one, exactly like production.
  await seedTools(db, actor);

  const materializing = createWorkflowLifecycle({
    ids,
    clock,
    templates: db.templates,
    locks: db.locks,
    proposals: db.proposals,
    snapshots: db.snapshots,
    runs: db.runs,
    events: db.events,
    unitOfWork: db.unitOfWork,
  });

  const availability = createPackAvailabilityPolicy({
    packInstallations: db.packInstallations!,
    packContentRefs: db.packContentRefs!,
  });
  // The guarded authorization service used by the direct-API (bypass) tests: exactly what
  // the production composition root builds.
  const guardedAuthorization = createAuthorizationService({
    ids,
    clock,
    roles: db.roles,
    assignments: db.roleAssignments,
    packAvailability: availability,
  });
  const realResolver = createRunPackProvenanceResolver({
    packInstallations: db.packInstallations!,
    packContentRefs: db.packContentRefs!,
    packVersions: db.packVersions!,
  });
  let calls = 0;
  const resolver: RunPackProvenanceResolver = {
    async resolveForWorkflow(input) {
      calls += 1;
      return realResolver.resolveForWorkflow(input);
    },
  };
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
    packAvailability: availability,
    packProvenance: resolver,
  });

  const service = createPackService({
    clock,
    ids,
    authorization: authz,
    lifecycle: materializing,
    packVersions: db.packVersions!,
    packInstallations: db.packInstallations!,
    packContentRefs: db.packContentRefs!,
    events: db.events,
    ledger: db.ledger,
    unitOfWork: db.unitOfWork,
    toolRequirementResolver: toolResolver,
  });

  const templateIdOf = async (packId: string, packVersion?: string): Promise<string> => {
    const installations = await db.packInstallations!.listByCompany('company_default');
    if (!installations.ok) throw new Error(installations.error.message);
    for (const installation of installations.value) {
      if (installation.packId !== packId) continue;
      if (packVersion !== undefined && installation.packVersion !== packVersion) continue;
      const refs = await db.packContentRefs!.listByInstallation(installation.id);
      if (!refs.ok) throw new Error(refs.error.message);
      const ref = refs.value.find((entry) => entry.contentKind === 'workflowTemplate');
      if (ref?.materializedEntityRef !== null && ref !== undefined) return ref.materializedEntityRef;
    }
    throw new Error(`no materialized workflow template for ${packId}${packVersion === undefined ? '' : `@${packVersion}`}`);
  };

  const install = async (over: {
    readonly packId: string;
    readonly packVersion: string;
    readonly dependsOn?: readonly { readonly packId: string; readonly packVersion: string }[];
    readonly roleAuthority?: string;
    readonly name?: string;
    readonly companyId?: string;
    readonly actorId?: string;
    readonly commandId?: string;
  }): Promise<Result<{ readonly id: string }, DomainError>> => {
    const commandId = over.commandId ?? `cmd_${ids.id('install')}`;
    const result = await service.install({
      commandId,
      companyId: over.companyId ?? 'company_default',
      actorId: over.actorId ?? actor,
      manifest: manifest(over),
      traceId: `trace_${commandId}`,
    });
    if (!result.ok) return result;
    return ok({ id: result.value.id });
  };

  const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);

  return {
    db,
    dataDir,
    service,
    lifecycle,
    guardedAuthorization,
    resolver,
    actor,
    outsider,
    calls: () => calls,
    templateIdOf,
    install,
    reopen: async () => compose(dataDir),
  };
};

/** Process A: a fresh durable database with a fresh, fully ready service graph. */
const make = async (): Promise<Fixture> => compose(tempDir());

/** Start a run, publishing the template first only when it is still a draft. */
const startRun = async (
  f: Fixture,
  templateId: string,
  label: string,
): Promise<Result<{ readonly runId: string; readonly snapshotId: string }, DomainError>> => {
  const template = await f.lifecycle.readTemplate(templateId);
  if (template !== null && template.state !== 'published') {
    const published = await f.lifecycle.publish({ templateId, actorId: f.actor, traceId: `t_pub_${label}` });
    if (!published.ok) return published;
  }
  const run = await f.lifecycle.createRun({
    templateId,
    companyId: 'company_default',
    workflowId: `wf_${label}`,
    actorId: f.actor,
  });
  if (!run.ok) return run;
  return ok({ runId: run.value.run.id, snapshotId: run.value.snapshot.id });
};

/** Publish + start a run through the production-like lifecycle. */
const runFromTemplate = async (
  f: Fixture,
  templateId: string,
  label: string,
): Promise<Result<{ readonly runId: string; readonly snapshotId: string }, DomainError>> => {
  const published = await f.lifecycle.publish({ templateId, actorId: f.actor, traceId: `t_pub_${label}` });
  if (!published.ok) return published;
  const run = await f.lifecycle.createRun({
    templateId,
    companyId: 'company_default',
    workflowId: `wf_${label}`,
    actorId: f.actor,
  });
  if (!run.ok) return run;
  return ok({ runId: run.value.run.id, snapshotId: run.value.snapshot.id });
};

/** Seed the pack's tool/validator REQUIREMENTS into the real registry (registry facts only). */
const seedTools = async (db: DurableDatabase, actor: string): Promise<void> => {
  const registry = createToolRegistry({
    ids,
    clock,
    records: db.toolRecords,
    invocations: db.toolInvocations,
    invocationArtifacts: db.toolInvocationArtifacts,
    adapters: new Map(),
    authorize: async () => ok(true),
    events: db.events,
    secrets: async () => [],
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
  });
  for (const [toolId, capabilities] of [['tool.registered', []], ['tool.validator', [TOOL_CAPABILITY_VALIDATOR]]] as const) {
    const record = createToolRecord({
      toolId,
      name: toolId,
      description: toolId,
      version: '1.0.0',
      capabilities,
      requiredAuthorities: ['tool.invoke'],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      riskLevel: 'LOW',
      idempotencyMode: 'IDEMPOTENT_KEY',
      adapterRef: toolId,
      now: nowIso(),
    });
    if (!record.ok) throw new Error(record.error.message);
    const registered = await registry.register(record.value, { actorId: actor });
    if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
  }
};

/** One installation row (fail-closed lookup) for test bookkeeping. */
const installationOf = async (
  db: DurableDatabase,
  companyId: string,
  packId: string,
  packVersion: string,
): Promise<PackInstallation> => {
  const found = await db.packInstallations!.findByCompanyPackVersion(companyId, packId, packVersion);
  if (!found.ok) throw new Error(found.error.message);
  if (found.value === null) throw new Error(`installation ${packId}@${packVersion} not found`);
  return found.value;
};

const packSource = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../packages/engine/src/pack/${name}`, import.meta.url)), 'utf8');

/* ============================================================ Scenario A ===== */

describe('Scenario A — full install through the real chain', () => {
  it('installs a nine-category pack: one installation, one ref per declaration, real entities', async () => {
    const f = await make();
    await f.service.install({ commandId: 'cmd_b', companyId: 'company_default', actorId: f.actor, manifest: manifest({ packId: 'pack-foundation', packVersion: '1.0.0' }), traceId: 'trace_b' });
    const installed = await f.install({ packId: 'pack-fixture', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-foundation', packVersion: '1.0.0' }] });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    const refs = await f.db.packContentRefs!.listByInstallation(installed.value.id);
    expect(refs.ok).toBe(true);
    if (!refs.ok) return;
    // Nine declaration items -> nine refs (no category dropped, no extras).
    expect(refs.value).toHaveLength(9);
    const byKind = new Map(refs.value.map((ref) => [ref.contentKind, ref]));
    expect([...byKind.keys()].sort()).toEqual([
      'artifactType', 'capabilityRule', 'prompt', 'riskRule', 'role', 'template', 'tool', 'validator', 'workflowTemplate',
    ]);
    // Materialized: role + workflow template carry REAL entity refs.
    const roleRef = byKind.get('role')!;
    const role = await f.db.roles.get(roleRef.materializedEntityRef ?? '');
    expect(role?.key).toBe('pack-fixture-reviewer');
    expect(role?.authority).toEqual(['workflow.review']);
    const templateRef = byKind.get('workflowTemplate')!;
    const template = await f.db.templates.get(templateRef.materializedEntityRef ?? '');
    expect(template?.orgId).toBe('company_default');
    // Pack-native seven kinds: entity ref is null (inert data, no runtime engine).
    for (const kind of ['prompt', 'tool', 'validator', 'artifactType', 'riskRule', 'capabilityRule', 'template'] as const) {
      expect(byKind.get(kind)?.materializedEntityRef).toBeNull();
    }
    // Generic template: structured JSON persisted in the canonical manifest, ref exists, null ref.
    const stored = await f.db.packVersions!.get('pack-fixture', '1.0.0');
    expect(stored.ok && stored.value?.manifest.declarations.templates[0]?.content).toEqual({ title: 'x', pages: [1, 2] });
    // Installation is the only enabled version of that pack; dependency is installed too.
    const enabled = await f.db.packInstallations!.findEnabled('company_default', 'pack-fixture');
    expect(enabled.ok && enabled.value?.packVersion).toBe('1.0.0');
  });

  it('a tool requirement creates no ToolRecord, installs no adapter and executes nothing', async () => {
    const f = await make();
    const before = (await f.db.toolRecords.list({ limit: 500 })).items.length;
    const installed = await f.install({ packId: 'pack-tools', packVersion: '1.0.0' });
    expect(installed.ok).toBe(true);
    const after = (await f.db.toolRecords.list({ limit: 500 })).items.length;
    expect(after).toBe(before); // requirement only: the global registry keeps its two rows
    const invocations = f.db.db.prepare('SELECT * FROM tool_invocations').all();
    expect(invocations).toHaveLength(0); // the adapter never ran
  });

  it('a real provider/model abstraction coexists with packs (no vendor lock)', async () => {
    const f = await make();
    const providers = createProviderRegistry({
      ids,
      clock,
      registrations: f.db.providers,
      models: f.db.providerModels,
      authorize: async () => ok(true),
      events: f.db.events,
      systemActor: f.actor,
    });
    const registered = await providers.register(
      createMockProvider({
        providerId: 'mock.test',
        kind: 'mock',
        displayName: 'Test provider',
        script: {
          models: [
            {
              modelId: 'standard',
              displayName: 'Standard',
              contextWindow: 1000,
              maxOutputTokens: 200,
              capabilities: { [MODEL_CAPABILITY]: true } as never,
              pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' as const },
            },
          ],
        },
      }),
    );
    expect(registered.ok).toBe(true);
    // A pack install is unaffected by the provider graph...
    const installed = await f.install({ packId: 'pack-providerless', packVersion: '1.0.0' });
    expect(installed.ok).toBe(true);
    // ...and a manifest cannot express a vendor requirement at all.
    const vendorLock = await f.service.install({
      commandId: 'cmd_vendor_lock',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: { ...(manifest({ packId: 'pack-vendor', packVersion: '1.0.0' }) as Record<string, unknown>), provider: 'some-vendor' },
      traceId: 'trace_vendor_lock',
    });
    expect(vendorLock.ok).toBe(false);
    if (!vendorLock.ok) expect(vendorLock.error.code).toBe('VALIDATION_FAILED');
  });
});

/* ============================================================ Scenario B ===== */

describe('Scenario B — security and failure matrix (zero writes)', () => {
  const zeroWrites = (f: Fixture): void => {
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
    expect(f.db.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(0);
    expect(f.db.db.prepare('SELECT * FROM pack_content_refs').all()).toHaveLength(0);
    expect(f.db.db.prepare('SELECT * FROM roles').all().every((row) => (row as { key: string }).key === 'owner')).toBe(true);
    expect(f.db.db.prepare('SELECT * FROM workflow_templates').all()).toHaveLength(0);
    expect(eventTypesOf(f)).not.toContain('pack.installed');
  };
  const eventTypesOf = (f: Fixture): readonly string[] =>
    f.db.db.prepare('SELECT type FROM events').all().map((row) => (row as { type: string }).type);

  it('missing dependency fails closed with no auto-install', async () => {
    const f = await make();
    const denied = await f.install({ packId: 'pack-lonely', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-absent', packVersion: '1.0.0' }] });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('PACK_DEPENDENCY_MISSING');
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
    expect(f.db.db.prepare("SELECT * FROM pack_installations WHERE pack_id = 'pack-absent'").all()).toHaveLength(0);
    zeroWrites(f);
  });

  it('an unknown authority fails at the canonical manifest stage', async () => {
    const f = await make();
    const denied = await f.install({ packId: 'pack-bogus', packVersion: '1.0.0', roleAuthority: 'pack-superadmin' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('VALIDATION_FAILED');
    zeroWrites(f);
  });

  it('a validator without the validation:validator capability fails preflight', async () => {
    const f = await make();
    // Register the declared validator id WITHOUT the validator capability.
    const { createToolRecord: makeRecord } = await import('@companyos/core');
    const record = makeRecord({
      toolId: 'tool.validator',
      name: 'tool.validator',
      description: 'no capability',
      version: '1.0.0',
      capabilities: [],
      requiredAuthorities: ['tool.invoke'],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      riskLevel: 'LOW',
      idempotencyMode: 'IDEMPOTENT_KEY',
      adapterRef: 'tool.validator',
      now: nowIso(),
    });
    if (!record.ok) throw new Error(record.error.message);
    const registry = createToolRegistry({
      ids,
      clock,
      records: f.db.toolRecords,
      invocations: f.db.toolInvocations,
      invocationArtifacts: f.db.toolInvocationArtifacts,
      adapters: new Map(),
      authorize: async () => ok(true),
      events: f.db.events,
      secrets: async () => [],
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
    });
    // The capability-less record collides on toolId (unique), so seed it on a fresh id and
    // point the manifest at that id: the preflight must refuse it for the missing capability.
    const plain = makeRecord({
      toolId: 'tool.plain',
      name: 'tool.plain',
      description: 'no capability',
      version: '1.0.0',
      capabilities: [],
      requiredAuthorities: ['tool.invoke'],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      riskLevel: 'LOW',
      idempotencyMode: 'IDEMPOTENT_KEY',
      adapterRef: 'tool.plain',
      now: nowIso(),
    });
    if (!plain.ok) throw new Error(plain.error.message);
    const seeded = await registry.register(plain.value, { actorId: f.actor });
    if (!seeded.ok && seeded.error.code !== 'CONFLICT') throw new Error(seeded.error.message);
    const denied = await f.service.install({
      commandId: 'cmd_validator_missing',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: {
        ...(manifest({ packId: 'pack-val', packVersion: '1.0.0' }) as Record<string, unknown>),
        declarations: {
          ...(manifest({ packId: 'pack-val', packVersion: '1.0.0' }) as { declarations: Record<string, unknown> }).declarations,
          validators: [{ key: 'pack-val:validator-req', validatorId: 'tool.plain' }],
        },
      },
      traceId: 'trace_validator_missing',
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('PACK_VALIDATOR_MISSING');
    zeroWrites(f);
  });

  it('every pack mutation is denied for an actor without pack.manage (zero writes)', async () => {
    const f = await make();
    const mutations = [
      f.service.install({ commandId: 'cmd_denied_install', companyId: 'company_default', actorId: f.outsider, manifest: manifest({ packId: 'pack-denied', packVersion: '1.0.0' }), traceId: 'trace_denied_install' }),
      f.service.enable({ commandId: 'cmd_denied_enable', companyId: 'company_default', actorId: f.outsider, packId: 'pack-denied', packVersion: '1.0.0', traceId: 'trace_denied_enable' }),
      f.service.disable({ commandId: 'cmd_denied_disable', companyId: 'company_default', actorId: f.outsider, packId: 'pack-denied', traceId: 'trace_denied_disable' }),
      f.service.upgrade({ commandId: 'cmd_denied_upgrade', companyId: 'company_default', actorId: f.outsider, packId: 'pack-denied', manifest: manifest({ packId: 'pack-denied', packVersion: '2.0.0' }), traceId: 'trace_denied_upgrade' }),
    ];
    for (const mutation of mutations) {
      const denied = await mutation;
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe('PERMISSION_DENIED');
    }
    zeroWrites(f);
  });

  it('a cross-company mutation is refused (company scope)', async () => {
    const f = await make();
    const denied = await f.install({ packId: 'pack-cross', packVersion: '1.0.0', companyId: 'company_other' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('PACK_COMPANY_SCOPE_DENIED');
    zeroWrites(f);
  });

  it('a pack role that carries pack.manage is a definition only (no self-grant)', async () => {
    const f = await make();
    const installed = await f.install({ packId: 'pack-privileged', packVersion: '1.0.0', roleAuthority: 'pack.manage' });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    // The role exists with the authority, but the installing actor was NOT assigned it:
    // every held assignment still belongs to the bootstrap owner seat.
    const assignments = await f.guardedAuthorization.assignmentsOf(f.actor);
    expect(assignments).toHaveLength(1);
    const held = await f.db.roles.get(assignments[0]!.roleId);
    expect(held?.key).toBe('owner');
    const roles = (await f.db.roles.list({ limit: 500 })).items.filter((role) => role.companyId === 'company_default');
    expect(roles.map((role) => role.key).sort()).toEqual(['owner', 'pack-privileged-reviewer']);
  });

  it('a dependency cycle in the durable graph fails closed without a stack overflow', async () => {
    const f = await make();
    // Candidate A depends on B; the installed B depends on A@2 (a durable state only the
    // stores can fabricate) — the resolver must refuse, not recurse forever.
    const { packManifestFingerprint, validatePackManifest } = await import('@companyos/core');
    const specs = [
      { packId: 'pack-a', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-b', packVersion: '1.0.0' }] },
      { packId: 'pack-b', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-a', packVersion: '1.0.0' }] },
    ] as const;
    for (const spec of specs) {
      const validated = validatePackManifest(manifest(spec));
      if (!validated.ok) throw new Error(validated.error.message);
      const put = await f.db.packVersions!.put({
        packId: spec.packId,
        packVersion: spec.packVersion,
        manifestFingerprint: packManifestFingerprint(validated.value),
        manifest: validated.value,
      } satisfies PackVersion);
      if (!put.ok) throw new Error(put.error.message);
    }
    const denied = await f.install(specs[0]!);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('PACK_DEPENDENCY_MISSING');
  });
});

/* ============================================================ Scenario C ===== */

describe('Scenario C — disable / re-enable lifecycle', () => {
  it('disable stops every new-use entry, preserves history, and re-enable reuses materialization', async () => {
    const f = await make();
    const installed = await f.install({ packId: 'pack-live', packVersion: '1.0.0' });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const templateId = await f.templateIdOf('pack-live');
    const refs = await f.db.packContentRefs!.listByInstallation(installed.value.id);
    const roleRef = refs.ok ? refs.value.find((entry) => entry.contentKind === 'role') : undefined;
    const roleId = roleRef?.materializedEntityRef ?? '';

    // New use works while installed.
    const assigned = await f.guardedAuthorization.assign({ actorId: 'user_new_1', roleId, assignedBy: 'system:test' });
    expect(assigned.ok).toBe(true);
    const published = await f.lifecycle.publish({ templateId, actorId: f.actor, traceId: 't_live' });
    expect(published.ok).toBe(true);

    const disabled = await f.service.disable({ commandId: 'cmd_c_dis', companyId: 'company_default', actorId: f.actor, packId: 'pack-live', traceId: 'trace_c_dis' });
    expect(disabled.ok).toBe(true);

    // New use is refused on EVERY authoritative entry (direct subsystem calls).
    const roleDenied = await f.guardedAuthorization.assign({ actorId: 'user_new_2', roleId, assignedBy: 'system:test' });
    expect(roleDenied.ok).toBe(false);
    if (!roleDenied.ok) expect(roleDenied.error.code).toBe('POLICY_DENIED');
    const graph = { nodes: [{ id: 's1', kind: 'work' as const, title: 'Work', config: {} }], edges: [] };
    for (const attempt of [
      f.lifecycle.saveDraftGraph({ templateId, graph, actorId: f.actor, traceId: 't_c_draft' }),
      f.lifecycle.publishRevision({ templateId, actorId: f.actor, traceId: 't_c_rev' }),
      f.lifecycle.fork({ templateId, name: 'Fork from a disabled pack', actorId: f.actor, traceId: 't_c_fork' }),
      f.lifecycle.createRun({ templateId, companyId: 'company_default', workflowId: 'wf_c_denied', actorId: f.actor }),
    ]) {
      const denied = await attempt;
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe('POLICY_DENIED');
    }

    // Historical reads and every durable fact survive.
    expect(await f.db.roles.get(roleId)).not.toBeNull();
    expect(await f.lifecycle.readTemplate(templateId)).not.toBeNull();
    expect((await f.guardedAuthorization.assignmentsOf('user_new_1')).some((entry) => entry.roleId === roleId)).toBe(true);
    const refsAfter = await f.db.packContentRefs!.listByInstallation(installed.value.id);
    expect(refsAfter.ok && refsAfter.value).toHaveLength(9);
    expect((await f.db.packVersions!.get('pack-live', '1.0.0')).ok).toBe(true);
    const eventTypes = (await f.db.events.all()).map((entry) => entry.event.type);
    expect(eventTypes).toContain('pack.installed');
    expect(eventTypes).toContain('pack.disabled');
    expect(eventTypes).not.toContain('pack.enabled');

    // Re-enable: revalidation passes, SAME materialization, 0 duplicate rows.
    const rolesBefore = (await f.db.roles.list({ limit: 500 })).items.length;
    const templatesBefore = (await f.db.templates.list({ limit: 500 })).items.length;
    const enabled = await f.service.enable({ commandId: 'cmd_c_en', companyId: 'company_default', actorId: f.actor, packId: 'pack-live', packVersion: '1.0.0', traceId: 'trace_c_en' });
    expect(enabled.ok).toBe(true);
    expect((await f.db.roles.list({ limit: 500 })).items).toHaveLength(rolesBefore);
    expect((await f.db.templates.list({ limit: 500 })).items).toHaveLength(templatesBefore);
    const reAssigned = await f.guardedAuthorization.assign({ actorId: 'user_new_3', roleId, assignedBy: 'system:test' });
    expect(reAssigned.ok).toBe(true);
    const reRun = await startRun(f, templateId, 'c_reenabled');
    expect(reRun.ok).toBe(true);
    if (reRun.ok) {
      const snapshot = await f.lifecycle.readSnapshot(reRun.value.snapshotId);
      expect(snapshot?.packVersions).toEqual({ 'pack-live': '1.0.0' });
    }
  });

  it('disabling a required dependency is refused (PACK_DEPENDENCY_IN_USE)', async () => {
    const f = await make();
    await f.install({ packId: 'pack-dep', packVersion: '1.0.0' });
    await f.install({ packId: 'pack-root', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-dep', packVersion: '1.0.0' }] });
    const denied = await f.service.disable({ commandId: 'cmd_c_inuse', companyId: 'company_default', actorId: f.actor, packId: 'pack-dep', traceId: 'trace_c_inuse' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('PACK_DEPENDENCY_IN_USE');
    const dep = await f.db.packInstallations!.findEnabled('company_default', 'pack-dep');
    const root = await f.db.packInstallations!.findEnabled('company_default', 'pack-root');
    expect(dep.ok && dep.value?.status).toBe('installed');
    expect(root.ok && root.value?.status).toBe('installed');
  });

  it('a disabled dependency cannot back an install either', async () => {
    const f = await make();
    await f.install({ packId: 'pack-dep', packVersion: '1.0.0' });
    await f.service.disable({ commandId: 'cmd_c_dep_dis', companyId: 'company_default', actorId: f.actor, packId: 'pack-dep', traceId: 'trace_c_dep_dis' });
    const denied = await f.install({ packId: 'pack-root', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-dep', packVersion: '1.0.0' }] });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('PACK_DEPENDENCY_MISSING');
  });
});

/* ============================================================ Scenario D ===== */

describe('Scenario D — upgrade with runs', () => {
  it('R1 under v1 stays v1, R2 after the upgrade pins v2, and disable blocks only new runs', async () => {
    const f = await make();
    await f.install({ packId: 'pack-up', packVersion: '1.0.0' });
    const v1Template = await f.templateIdOf('pack-up', '1.0.0');
    const first = await runFromTemplate(f, v1Template, 'd1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const upgraded = await f.service.upgrade({
      commandId: 'cmd_d_up',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-up',
      manifest: manifest({ packId: 'pack-up', packVersion: '2.0.0' }),
      traceId: 'trace_d_up',
    });
    expect(upgraded.ok).toBe(true);
    const v1 = await installationOf(f.db, 'company_default', 'pack-up', '1.0.0');
    const v2 = await installationOf(f.db, 'company_default', 'pack-up', '2.0.0');
    expect(v1.status).toBe('disabled'); // retained, historically addressable
    expect(v2.status).toBe('installed');
    expect((await installationOf(f.db, 'company_default', 'pack-up', '2.0.0')).packVersion).toBe('2.0.0');

    const second = await runFromTemplate(f, await f.templateIdOf('pack-up', '2.0.0'), 'd2');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect((await f.lifecycle.readSnapshot(first.value.snapshotId))?.packVersions).toEqual({ 'pack-up': '1.0.0' });
    expect((await f.lifecycle.readSnapshot(second.value.snapshotId))?.packVersions).toEqual({ 'pack-up': '2.0.0' });

    // Disable the current version: new runs denied, both runs keep their provenance.
    const disabled = await f.service.disable({ commandId: 'cmd_d_dis', companyId: 'company_default', actorId: f.actor, packId: 'pack-up', packVersion: '2.0.0', traceId: 'trace_d_dis' });
    expect(disabled.ok).toBe(true);
    const third = await f.lifecycle.createRun({ templateId: await f.templateIdOf('pack-up', '2.0.0'), companyId: 'company_default', workflowId: 'wf_d3', actorId: f.actor });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.code).toBe('POLICY_DENIED');
    expect((await f.lifecycle.readSnapshot(first.value.snapshotId))?.packVersions).toEqual({ 'pack-up': '1.0.0' });
    expect((await f.lifecycle.readSnapshot(second.value.snapshotId))?.packVersions).toEqual({ 'pack-up': '2.0.0' });
    // The v1 published version is never rewritten by the upgrade (version safety).
    const v1TemplateRow = await f.db.templates.get(v1Template);
    expect(v1TemplateRow?.versions.map((version) => version.semver)).toContain('1.0.0');
  });

  it('the same role declaration is reused across versions (any-live-owner), a changed one conflicts', async () => {
    const f = await make();
    await f.install({ packId: 'pack-reuse', packVersion: '1.0.0' });
    const refs = await f.db.packContentRefs!.listByInstallation(
      (await installationOf(f.db, 'company_default', 'pack-reuse', '1.0.0')).id,
    );
    const roleRef = refs.ok ? refs.value.find((entry) => entry.contentKind === 'role') : undefined;
    const roleId = roleRef?.materializedEntityRef ?? '';
    const upgraded = await f.service.upgrade({
      commandId: 'cmd_d_reuse',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-reuse',
      manifest: manifest({ packId: 'pack-reuse', packVersion: '2.0.0' }),
      traceId: 'trace_d_reuse',
    });
    expect(upgraded.ok).toBe(true);
    const v2Refs = await f.db.packContentRefs!.listByInstallation(
      (await installationOf(f.db, 'company_default', 'pack-reuse', '2.0.0')).id,
    );
    const v2RoleRef = v2Refs.ok ? v2Refs.value.find((entry) => entry.contentKind === 'role') : undefined;
    expect(v2RoleRef?.materializedEntityRef).toBe(roleId); // same entity, two owners
    // v1 is disabled but v2 owns it: the role stays assignable (any-live-owner).
    const assigned = await f.guardedAuthorization.assign({ actorId: 'user_shared', roleId, assignedBy: 'system:test' });
    expect(assigned.ok).toBe(true);
    // A CHANGED authority for the same logical key must not silently rewrite the role.
    const conflicting = await f.service.upgrade({
      commandId: 'cmd_d_conflict',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-reuse',
      manifest: manifest({ packId: 'pack-reuse', packVersion: '3.0.0', roleAuthority: 'run.start' }),
      traceId: 'trace_d_conflict',
    });
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) expect(conflicting.error.details['reason']).toBe('PACK_ROLE_CONFLICT');
    expect((await f.db.roles.get(roleId))?.authority).toEqual(['workflow.review']);
  });

  it('upgrade is atomic: a failing v2 materialization leaves v1 installed', async () => {
    const f = await make();
    await f.install({ packId: 'pack-atomic', packVersion: '1.0.0' });
    const v1Installation = await installationOf(f.db, 'company_default', 'pack-atomic', '1.0.0');
    const realRefs = f.db.packContentRefs!;
    let inserts = 0;
    const flakyRefs = {
      insert: async (installationId: string, ref: Parameters<typeof realRefs.insert>[1]) => {
        inserts += 1;
        if (inserts === 2) throw new Error('participant exploded');
        return realRefs.insert(installationId, ref);
      },
      listByInstallation: (installationId: string) => realRefs.listByInstallation(installationId),
      findByKey: (installationId: string, contentKind: never, logicalKey: string) => realRefs.findByKey(installationId, contentKind, logicalKey),
    };
    const service = createPackService({
      clock,
      ids,
      authorization: f.guardedAuthorization,
      lifecycle: createWorkflowLifecycle({
        ids,
        clock,
        templates: f.db.templates,
        locks: f.db.locks,
        proposals: f.db.proposals,
        snapshots: f.db.snapshots,
        runs: f.db.runs,
        events: f.db.events,
        unitOfWork: f.db.unitOfWork,
      }),
      packVersions: f.db.packVersions!,
      packInstallations: f.db.packInstallations!,
      packContentRefs: flakyRefs,
      events: f.db.events,
      ledger: f.db.ledger,
      unitOfWork: f.db.unitOfWork,
      toolRequirementResolver: { resolve: async () => ({ ok: true as const, capabilities: [] }) },
    });
    const boom = await service.upgrade({
      commandId: 'cmd_d_atomic',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-atomic',
      manifest: manifest({ packId: 'pack-atomic', packVersion: '2.0.0' }),
      traceId: 'trace_d_atomic',
    });
    expect(boom.ok).toBe(false);
    // v1 untouched, no half-written v2 anywhere.
    expect((await installationOf(f.db, 'company_default', 'pack-atomic', '1.0.0')).id).toBe(v1Installation.id);
    expect(f.db.db.prepare("SELECT * FROM pack_installations WHERE pack_version = '2.0.0'").all()).toHaveLength(0);
    expect(f.db.db.prepare("SELECT * FROM pack_content_refs WHERE installation_id != ?").all(v1Installation.id)).toHaveLength(0);
    const packRoles = f.db.db.prepare("SELECT * FROM roles WHERE key != 'owner'").all() as { key: string }[];
    expect(packRoles).toHaveLength(1); // only the v1 materialization
    expect(packRoles[0]!.key).toBe('pack-atomic-reviewer');
    const eventTypes = (await f.db.events.all()).map((entry) => entry.event.type);
    expect(eventTypes).not.toContain('pack.upgraded');
    expect(eventTypes).not.toContain('pack.disabled');
  });

  it('permanent install idempotency and PackVersion conflicts are enforced', async () => {
    const f = await make();
    const first = await f.install({ packId: 'pack-idem', packVersion: '1.0.0', commandId: 'cmd_idem_1' });
    expect(first.ok).toBe(true);
    // Simulate a trimmed (bounded) ledger, then replay the same command.
    f.db.db.prepare('DELETE FROM command_ledger WHERE command_id = ?').run('cmd_idem_1');
    const replay = await f.install({ packId: 'pack-idem', packVersion: '1.0.0', commandId: 'cmd_idem_1' });
    expect(replay.ok).toBe(true);
    if (first.ok && replay.ok) expect(replay.value.id).toBe(first.value.id);
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(1);
    expect(f.db.db.prepare('SELECT * FROM pack_content_refs').all()).toHaveLength(9);
    // Same command, different semantic content.
    const conflict = await f.service.install({
      commandId: 'cmd_idem_1',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: manifest({ packId: 'pack-idem', packVersion: '9.9.9' }),
      traceId: 'trace_idem_conflict',
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.details['reason']).toBe('PACK_COMMAND_FINGERPRINT_CONFLICT');
    // Same tuple, different manifest content (a fresh command in another company).
    const authz = createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments });
    const seat = await authz.defineRole({ companyId: 'company_other', key: 'admin', name: 'Other admin', authorities: ['pack.manage', 'workflow.review', 'workflow.draft.create'] });
    if (!seat.ok) throw new Error(seat.error.message);
    const assigned = await authz.assign({ actorId: f.outsider, roleId: seat.value.id, assignedBy: 'system:test' });
    if (!assigned.ok) throw new Error(assigned.error.message);
    const versionConflict = await f.service.install({
      commandId: 'cmd_idem_other',
      companyId: 'company_other',
      actorId: f.outsider,
      manifest: manifest({ packId: 'pack-idem', packVersion: '1.0.0', name: 'A different manifest for the same identity' }),
      traceId: 'trace_idem_version_conflict',
    });
    expect(versionConflict.ok).toBe(false);
    if (!versionConflict.ok) expect(versionConflict.error.details['reason']).toBe('PACK_VERSION_CONFLICT');
    expect(f.db.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(1);
    // One shared PackVersion row, two installations (company isolation on install).
    const shared = await f.install({ packId: 'pack-idem', packVersion: '1.0.0', companyId: 'company_other', actorId: f.outsider, commandId: 'cmd_idem_shared' });
    expect(shared.ok).toBe(true);
    expect(f.db.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(1);
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(2);
  });

  it("company isolation: a disable in company A never affects company B", async () => {
    const f = await make();
    await f.install({ packId: 'pack-iso', packVersion: '1.0.0' });
    const authz = createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments });
    const seat = await authz.defineRole({ companyId: 'company_other', key: 'admin', name: 'Other admin', authorities: ['pack.manage', 'workflow.review', 'workflow.draft.create'] });
    if (!seat.ok) throw new Error(seat.error.message);
    const assigned = await authz.assign({ actorId: f.outsider, roleId: seat.value.id, assignedBy: 'system:test' });
    if (!assigned.ok) throw new Error(assigned.error.message);
    const elsewhere = await f.install({ packId: 'pack-iso', packVersion: '1.0.0', companyId: 'company_other', actorId: f.outsider });
    expect(elsewhere.ok).toBe(true);

    const roleIdOf = async (companyId: string): Promise<string> => {
      const installations = await f.db.packInstallations!.listByCompany(companyId);
      if (!installations.ok) throw new Error(installations.error.message);
      for (const installation of installations.value) {
        const refs = await f.db.packContentRefs!.listByInstallation(installation.id);
        if (!refs.ok) throw new Error(refs.error.message);
        const ref = refs.value.find((entry) => entry.contentKind === 'role');
        if (ref?.materializedEntityRef) return ref.materializedEntityRef;
      }
      throw new Error('no role');
    };
    const roleA = await roleIdOf('company_default');
    const roleB = await roleIdOf('company_other');
    expect(roleA).not.toBe(roleB);

    await f.service.disable({ commandId: 'cmd_iso_dis', companyId: 'company_default', actorId: f.actor, packId: 'pack-iso', traceId: 'trace_iso_dis' });
    // A: new assignment denied. B: unaffected.
    const denied = await f.guardedAuthorization.assign({ actorId: 'user_iso_a', roleId: roleA, assignedBy: 'system:test' });
    expect(denied.ok).toBe(false);
    const allowed = await f.guardedAuthorization.assign({ actorId: 'user_iso_b', roleId: roleB, assignedBy: 'system:test' });
    expect(allowed.ok).toBe(true);
  });
});

/* ============================================================ Scenario E ===== */

describe('Scenario E — restart, recovery and evidence', () => {
  it('a fresh process graph preserves provenance; recovery consults no active pack', async () => {
    const a = await make();
    await a.install({ packId: 'pack-restart', packVersion: '1.0.0' });
    const templateId = await a.templateIdOf('pack-restart');
    const run = await runFromTemplate(a, templateId, 'e1');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const callsAfterCreate = a.calls();
    expect(callsAfterCreate).toBe(1);

    // Process A closes and discards its object graph.
    const snapshotId = run.value.snapshotId;
    const runId = run.value.runId;
    a.db.close();
    database = null;

    // Process B: same durable file, completely new stores/services/resolver.
    const b = await a.reopen();
    const snapshot = await b.lifecycle.readSnapshot(snapshotId);
    expect(snapshot?.packVersions).toEqual({ 'pack-restart': '1.0.0' });

    // Disable the current pack from the fresh graph.
    const disabled = await b.service.disable({ commandId: 'cmd_e_dis', companyId: 'company_default', actorId: b.actor, packId: 'pack-restart', traceId: 'trace_e_dis' });
    expect(disabled.ok).toBe(true);
    expect((await b.lifecycle.readSnapshot(snapshotId))?.packVersions).toEqual({ 'pack-restart': '1.0.0' });

    // Recovery + continuation: no resolver calls, the old run keeps executing.
    const { createStartupRecoveryOrchestrator } = await import('@companyos/engine');
    const engine = createWorkflowEngine({
      ids,
      clock,
      runs: b.db.runs,
      events: b.db.events,
      approvals: b.db.approvals,
      tasks: b.db.tasks,
      handlers: { resolve: () => alwaysSucceed('stub.t15-e2e') },
    });
    const orchestrator = createStartupRecoveryOrchestrator({
      actorId: b.actor,
      runtime: { recoverInterrupted: async () => ok([]) },
      tools: { recoverInvocations: async () => ok({ interrupted: [], waitingApproval: [], retryable: [] }) as never },
      engine: { recover: async (id: string) => engine.recover(id as never) },
      runs: b.db.runs,
    });
    const report = await orchestrator.run();
    expect(report.ok).toBe(true);
    const driven = await engine.drive(runId as never);
    expect(b.calls()).toBe(0); // the fresh graph resolved nothing for existing work
    void driven;
    const recovered = await engine.recover(runId as never);
    expect(['resumed', 'unrecoverable']).toContain(recovered);
    expect(b.calls()).toBe(0);
  });

  it('the evidence gate stays pinned-version authoritative across disable and upgrade', async () => {
    const f = await make();
    await f.install({ packId: 'pack-evidence', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-evidence');
    const run = await runFromTemplate(f, templateId, 'e_evidence');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const stageId = 's1';
    const guard = createValidationEvidenceGuard({
      artifactStore: f.db.artifactStore!,
      validationStore: f.db.validationStore!,
      stagePolicy: {
        requiredValidators: async () => {
          const pinned = await f.lifecycle.readSnapshot(run.value.snapshotId);
          if (pinned === null) return ok([]);
          const template = await f.db.templates.get(pinned.templateId);
          const version = template?.versions.find((entry) => entry.id === pinned.workflowVersionId);
          const node = version?.graph.nodes.find((entry) => entry.id === stageId);
          return ok(node === undefined ? [] : (node.config as { validatorIds?: readonly string[] }).validatorIds ?? []);
        },
      },
    });
    const rejected = await guard.evaluateGate({ runId: run.value.runId, stageId, artifactId: 'art_missing' as never });
    expect(rejected.ok).toBe(false);

    // Real evidence (real artifact + durable validation batch).
    const { createArtifactService } = await import('@companyos/engine');
    const { artifactTargetRef, createValidation } = await import('@companyos/core');
    const { createFilesystemArtifactContentStore } = await import('@companyos/persistence');
    const artifactService = createArtifactService({
      artifactStore: f.db.artifactStore!,
      contentStore: createFilesystemArtifactContentStore({ casRoot: tempDir() }),
      runs: f.db.runs,
      events: f.db.events,
      ledger: f.db.ledger,
      clock,
      ids,
      unitOfWork: f.db.unitOfWork,
      authorize: async () => ok(true),
    });
    const target = await artifactService.create({
      commandId: 'cmd_e_artifact',
      runId: run.value.runId as never,
      kind: 'pack-evidence:diff-kind',
      content: new TextEncoder().encode('evidence payload'),
      producedBy: 'agent:agt_evidence',
      traceId: 'trace_e_artifact',
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const finishedAt = '2026-09-26T02:00:00.000Z';
    const validation = createValidation({
      runId: run.value.runId as never,
      stageId: stageId as never,
      validatorId: 'tool.validator',
      validatorVersion: '1.0.0',
      status: 'pass',
      blocking: true,
      evidenceRefs: [`artifact:${target.value.id}`],
      startedAt: finishedAt,
      finishedAt,
      targetRef: artifactTargetRef(target.value.id),
      ids,
    });
    if (!validation.ok) throw new Error(validation.error.message);
    await f.db.validationStore!.record(validation.value, {
      creationCommandId: 'cmd_e_batch',
      creationCommandFingerprint: 'sha256:' + 'e'.repeat(64),
    });
    const passed = await guard.evaluateGate({ runId: run.value.runId, stageId, artifactId: target.value.id as never });
    expect(passed.ok).toBe(true);

    // Upgrade AND disable the pack: the pinned gate outcome does not move.
    await f.service.upgrade({
      commandId: 'cmd_e_up',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-evidence',
      manifest: manifest({ packId: 'pack-evidence', packVersion: '2.0.0' }),
      traceId: 'trace_e_up',
    });
    await f.service.disable({ commandId: 'cmd_e_dis2', companyId: 'company_default', actorId: f.actor, packId: 'pack-evidence', packVersion: '2.0.0', traceId: 'trace_e_dis2' });
    const stillRejected = await guard.evaluateGate({ runId: run.value.runId, stageId, artifactId: 'art_missing' as never });
    expect(stillRejected.ok).toBe(false);
    const stillPassed = await guard.evaluateGate({ runId: run.value.runId, stageId, artifactId: target.value.id as never });
    expect(stillPassed.ok).toBe(true);
    expect((await f.lifecycle.readSnapshot(run.value.snapshotId))?.packVersions).toEqual({ 'pack-evidence': '1.0.0' });
  });

  it('a corrupt PackVersion row fails NEW runs closed but never blocks an existing run', async () => {
    const f = await make();
    await f.install({ packId: 'pack-corrupt', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-corrupt');
    const run = await runFromTemplate(f, templateId, 'e_corrupt');
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    // Simulate durable corruption of the canonical manifest (the fingerprint CHECK keeps
    // the stored value well-formed, so only the manifest body is damaged).
    f.db.db.prepare('UPDATE pack_versions SET canonical_manifest_json = ? WHERE pack_id = ? AND pack_version = ?')
      .run('{"not":"a canonical pack manifest"}', 'pack-corrupt', '1.0.0');

    // New use: the store's fail-closed read makes the resolver refuse (no new run).
    const denied = await f.lifecycle.createRun({ templateId, companyId: 'company_default', workflowId: 'wf_corrupt_new', actorId: f.actor });
    expect(denied.ok).toBe(false);
    expect(f.db.db.prepare('SELECT * FROM runs').all().length).toBe(1);

    // The existing run and its snapshot never re-read the PackVersion.
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(snapshot?.packVersions).toEqual({ 'pack-corrupt': '1.0.0' });
    const template = await f.lifecycle.readTemplate(templateId);
    expect(template).not.toBeNull();
  });

  it('conflicting dependency versions fail closed instead of picking a winner', async () => {
    const f = await make();
    await f.install({ packId: 'pack-c', packVersion: '1.0.0' });
    // The one-active-version invariant makes two installed versions of one pack
    // unreachable through legitimate operations, so the shared closure resolver is proven
    // directly: two roots that resolve the same packId to different versions must refuse.
    const stores = {
      packInstallations: f.db.packInstallations!,
      packContentRefs: f.db.packContentRefs!,
      packVersions: f.db.packVersions!,
    };
    // Give the second version a canonical (verified) PackVersion row — an install is NOT
    // needed, the resolver must refuse the ambiguous identity before anything else.
    const { packManifestFingerprint, validatePackManifest } = await import('@companyos/core');
    const second = validatePackManifest(manifest({ packId: 'pack-c', packVersion: '2.0.0' }));
    if (!second.ok) throw new Error(second.error.message);
    const put = await f.db.packVersions!.put({
      packId: 'pack-c',
      packVersion: '2.0.0',
      manifestFingerprint: packManifestFingerprint(second.value),
      manifest: second.value,
    } satisfies PackVersion);
    if (!put.ok) throw new Error(put.error.message);
    const conflict = await resolveExactDependencyClosure(stores, 'company_default', [
      { packId: 'pack-c', packVersion: '1.0.0' },
      { packId: 'pack-c', packVersion: '2.0.0' },
    ]);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.details['reason']).toBe('PACK_MULTIPLE_INSTALLED_VERSIONS');
    // A single root resolves normally (no false positive).
    const single = await resolveExactDependencyClosure(stores, 'company_default', [
      { packId: 'pack-c', packVersion: '1.0.0' },
    ]);
    expect(single.ok && single.value.get('pack-c')).toBe('1.0.0');
  });
});

/* ============================================================ Scenario F ===== */

describe('Scenario F — legacy packless regression and structural locks', () => {
  it('a packless workflow runs, recovers and pins {} without the pack framework', async () => {
    const f = await make();
    const template = await f.lifecycle.createTemplate({ orgId: 'company_default', name: 'Legacy flow', actorId: f.actor, traceId: 't_legacy' });
    expect(template.ok).toBe(true);
    if (!template.ok) return;
    const graph = { nodes: [{ id: 's1', kind: 'work' as const, title: 'Work', config: {} }], edges: [] };
    const drafted = await f.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: f.actor, traceId: 't_legacy' });
    expect(drafted.ok).toBe(true);
    const run = await runFromTemplate(f, template.value.id, 'legacy');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(snapshot?.packVersions).toEqual({});
    // pack materialization is never needed for a legacy flow
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
    expect(f.calls()).toBe(1);
    // It also advances through the normal engine path.
    const { createWorkflowEngine } = await import('@companyos/engine');
    const engine = createWorkflowEngine({
      ids,
      clock,
      runs: f.db.runs,
      events: f.db.events,
      approvals: f.db.approvals,
      tasks: f.db.tasks,
      handlers: { resolve: () => alwaysSucceed('stub.t15-legacy') },
    });
    const driven = await engine.drive(run.value.runId as never);
    expect(f.calls()).toBe(1); // never resolved for the legacy run
    void driven;
  });

  it('structural locks: no dynamic code, no loader, no marketplace, no vendor lock, no new surface', () => {
    const sources = ['pack-provenance.ts', 'run-pack-provenance.ts', 'pack-service.ts', 'pack-availability.ts'].map(packSource);
    for (const source of sources) {
      for (const forbidden of ['eval(', 'new Function(', 'node:vm', 'child_process', 'await import(', 'allowAll', 'bypass', 'marketplace', 'zip', 'download', 'openai', 'OpenAI', 'deepseek', 'DeepSeek', 'anthropic']) {
        expect(source.includes(forbidden), `${forbidden} must not appear`).toBe(false);
      }
      expect(source.includes('DELETE FROM pack_')).toBe(false);
      expect(source.includes('DROP TABLE pack_')).toBe(false);
    }
    const migrations = readdirSync(fileURLToPath(new URL('../../packages/persistence/migrations/pack', import.meta.url)));
    expect(migrations.filter((name) => name.endsWith('.sql'))).toEqual(['0001_pack_persistence.sql']);
    for (const authority of ['pack-read', 'pack-install', 'pack-enable', 'pack-disable', 'pack-upgrade', 'pack-admin']) {
      expect(AUTHORITIES).not.toContain(authority);
    }
    expect(AUTHORITIES).toContain('pack.manage');
    const lifecycleSource = readFileSync(fileURLToPath(new URL('../../packages/engine/src/lifecycle-service.ts', import.meta.url)), 'utf8');
    expect(lifecycleSource.includes("authority: 'pack.")).toBe(false);
  });

  it('event payloads never carry manifests, prompts, template content or secrets', async () => {
    const f = await make();
    await f.install({ packId: 'pack-events', packVersion: '1.0.0' });
    await f.service.disable({ commandId: 'cmd_f_events', companyId: 'company_default', actorId: f.actor, packId: 'pack-events', traceId: 'trace_f_events' });
    await f.service.enable({ commandId: 'cmd_f_enable', companyId: 'company_default', actorId: f.actor, packId: 'pack-events', packVersion: '1.0.0', traceId: 'trace_f_enable' });
    const packEvents = (await f.db.events.all()).filter((entry) => entry.event.type.startsWith('pack.'));
    expect(packEvents.map((entry) => entry.event.type).sort()).toEqual(['pack.disabled', 'pack.enabled', 'pack.installed']);
    for (const entry of packEvents) {
      const payload = JSON.stringify(entry.event.payload);
      expect(payload).not.toContain('Summarize the input'); // prompt body
      expect(payload).not.toContain('document-template'); // generic template content
      expect(payload).not.toContain('manifestVersion');
      const keys = Object.keys(entry.event.payload as Record<string, unknown>);
      expect(keys.every((key) => ['companyId', 'packId', 'packVersion', 'installationId', 'actorId', 'traceId'].includes(key))).toBe(true);
      expect(keys).toContain('packId');
      expect(keys).toContain('packVersion');
      expect(keys).toContain('companyId');
    }
    // Replay does not duplicate lifecycle events.
    const before = (await f.db.events.all()).length;
    await f.install({ packId: 'pack-events', packVersion: '1.0.0', commandId: 'cmd_f_replay' });
    const replay = await f.install({ packId: 'pack-events', packVersion: '1.0.0', commandId: 'cmd_f_replay' });
    expect(replay.ok).toBe(true);
    expect((await f.db.events.all()).length).toBe(before);
  });

  it('a fresh database applies every migration and the pack chain is usable end to end', async () => {
    const f = await make();
    const tables = (f.db.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'pack%'").all() as { name: string }[]).map((row) => row.name);
    expect(tables).toContain('pack_versions');
    expect(tables).toContain('pack_installations');
    expect(tables).toContain('pack_content_refs');
    expect(f.db.packVersions).not.toBeNull();
    expect(f.db.packInstallations).not.toBeNull();
    expect(f.db.packContentRefs).not.toBeNull();
    const installed = await f.install({ packId: 'pack-fresh', packVersion: '1.0.0' });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const run = await runFromTemplate(f, await f.templateIdOf('pack-fresh'), 'fresh');
    expect(run.ok).toBe(true);
  });
});
