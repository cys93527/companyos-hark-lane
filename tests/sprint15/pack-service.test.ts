/**
 * Sprint 15 / Task-15-04: PackService & dependency resolution (application layer).
 *
 * Real SQLite (pack + provider + agent + tools chains), real authorization service
 * (roles live in the durable store), real workflow lifecycle, real store set and the
 * real UnitOfWork. One industry-neutral fixture carries ALL NINE declaration kinds.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTHORITIES,
  ok,
  type DomainError,
  type PackAvailabilityPolicy,
  type PackInstallation,
  type Result,
} from '@companyos/core';
import {
  createAuthorizationService,
  createPackAvailabilityPolicy,
  createPackService,
  createToolRegistry,
  createWorkflowLifecycle,
  ensureBootstrapOwner,
  type AuthorizationService,
  type PackService,
  type ToolRequirementResolver,
  type WorkflowLifecycle,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t15srv-'));
  created.push(dir);
  return dir;
};
let nowMs = 0;
const nowIso = (): string => {
  nowMs += 1_000;
  return new Date(Date.parse('2026-09-26T00:00:00.000Z') + nowMs).toISOString();
};
let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_15S${String(++seq).padStart(5, '0')}`,
  ulid: () => `15S${String(++seq).padStart(23, '0')}`,
};
const clock = { now: (): number => Date.parse('2026-09-26T00:00:00.000Z') + nowMs, nowIso };

let database: DurableDatabase | null = null;
afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly db: DurableDatabase;
  readonly lifecycle: WorkflowLifecycle;
  /** Lifecycle with the pack availability guard injected (production composition). */
  readonly guardedLifecycle: WorkflowLifecycle;
  /** Authorization with the pack availability guard injected (production composition). */
  readonly guardedAuthorization: AuthorizationService;
  readonly availability: PackAvailabilityPolicy;
  readonly service: PackService;
  readonly actor: string;
  readonly outsider: string;
  readonly toolResolver: ToolRequirementResolver;
  readonly install: (overrides?: { readonly packId?: string; readonly packVersion?: string; readonly companyId?: string; readonly dependsOn?: readonly { packId: string; packVersion: string }[]; readonly commandId?: string; readonly actorId?: string }) => Promise<Result<{ readonly id: string }, DomainError>>;
}

const make = async (): Promise<Fixture> => {
  const db = openDurableDatabase({
    dataDir: tempDir(),
    appliedAt: nowIso(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'agent', 'tools', 'artifact', 'pack'],
  });
  database = db;
  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  const actor = 'user_owner';
  const outsider = 'user_stranger';
  const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);

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
  });

  // A real tool registry whose requirement resolver answers registry facts (no adapter execution).
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
      const record = await registry.get(toolId, 'user_owner');
      if (!record.ok || record.value === null) return { ok: false as const };
      return { ok: true as const, capabilities: record.value.capabilities };
    },
  };

  // Production-like composition: ONE availability policy shared by the guarded
  // authorization and lifecycle services (T15-04 corrective).
  const availability = createPackAvailabilityPolicy({
    packInstallations: db.packInstallations!,
    packContentRefs: db.packContentRefs!,
  });
  const guardedAuthorization = createAuthorizationService({
    ids,
    clock,
    roles: db.roles,
    assignments: db.roleAssignments,
    packAvailability: availability,
  });
  const guardedLifecycle = createWorkflowLifecycle({
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
  });

  const service = createPackService({
    clock,
    ids,
    authorization: authz,
    lifecycle,
    packVersions: db.packVersions!,
    packInstallations: db.packInstallations!,
    packContentRefs: db.packContentRefs!,
    events: db.events,
    ledger: db.ledger,
    unitOfWork: db.unitOfWork,
    toolRequirementResolver: toolResolver,
  });

  const install = async (overrides: {
    readonly packId?: string;
    readonly packVersion?: string;
    readonly companyId?: string;
    readonly dependsOn?: readonly { readonly packId: string; readonly packVersion: string }[];
    readonly commandId?: string;
    readonly actorId?: string;
  } = {}): Promise<Result<{ readonly id: string }, DomainError>> => {
    const commandId = overrides.commandId ?? `cmd_${ids.id('install')}`;
    const result = await service.install({
      commandId,
      companyId: overrides.companyId ?? 'company_default',
      actorId: overrides.actorId ?? actor,
      manifest: manifest({
        packId: overrides.packId ?? 'pack-fixture',
        packVersion: overrides.packVersion ?? '1.0.0',
        dependsOn: overrides.dependsOn,
      }),
      traceId: `trace_${commandId}`,
    });
    if (!result.ok) return result;
    return ok({ id: result.value.id });
  };

  return { db, lifecycle, guardedLifecycle, guardedAuthorization, availability, service, actor, outsider, toolResolver, install };
};

/** Industry-neutral fixture: ALL NINE canonical declaration categories. */
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
        graph: { nodes: [{ id: 's1', kind: 'work', title: 'Work', config: {} }], edges: [] },
      },
    ],
    prompts: [{ key: `${over.packId}:summary`, template: 'Summarize the input.', version: null }],
    tools: [{ key: `${over.packId}:tool-req`, toolId: 'tool.registered', capability: null }],
    validators: [{ key: `${over.packId}:validator-req`, validatorId: 'tool.validator' }],
    artifacts: [{ key: `${over.packId}:diff-kind`, label: 'Diff', description: '' }],
    riskRules: [{ key: `${over.packId}:high-risk`, riskLevel: 'HIGH', description: '' }],
    capabilityRules: [{ key: `${over.packId}:needs-capability`, requires: [`${over.packId}:capability.one`], exposes: [] }],
    templates: [{ key: `${over.packId}:document-template`, kind: 'some-type', content: { title: 'x' } }],
  },
});

/** Seed the tool registry with the two tools the fixture manifest requires (registry facts only). */
const seedTools = async (f: Fixture): Promise<void> => {
  const { createToolRecord } = await import('@companyos/core');
  for (const [toolId, capabilities] of [['tool.registered', []], ['tool.validator', ['validation:validator']]] as const) {
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
    const registered = await registry.register(record.value, { actorId: f.actor });
    if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
  }
};

describe('pack.manage lifecycle (authorized install)', () => {
  it('installs: nine declarations → one installation, nine refs, materialized entities', async () => {
    const f = await make();
    await seedTools(f);
    const createdInstall = await f.install();
    expect(createdInstall.ok).toBe(true);
    if (!createdInstall.ok) return;
    const installation = await f.db.packInstallations!.get(createdInstall.value.id);
    expect(installation.ok).toBe(true);
    if (installation.ok && installation.value) {
      expect(installation.value.status).toBe('installed');
      expect(installation.value.companyId).toBe('company_default');
      expect(installation.value.packVersion).toBe('1.0.0');
    }
    // Nine canonical declarations → exactly nine PackContentRefs.
    const refs = await f.db.packContentRefs!.listByInstallation(createdInstall.value.id);
    if (refs.ok) {
      expect(refs.value).toHaveLength(9);
      const kinds = refs.value.map((ref) => ref.contentKind).sort();
      expect(kinds).toEqual([
        'artifactType', 'capabilityRule', 'prompt', 'riskRule', 'role', 'template', 'tool', 'validator', 'workflowTemplate',
      ]);
      const roleRef = refs.value.find((ref) => ref.contentKind === 'role');
      expect(roleRef?.materializedEntityRef).not.toBeNull(); // materialized via the authorization service
      const role = await f.db.roles.get(roleRef?.materializedEntityRef ?? '');
      expect(role?.key).toBe('pack-fixture-reviewer'); // namespaced, flattened to the Role key contract
      const templateRef = refs.value.find((ref) => ref.contentKind === 'workflowTemplate');
      const template = await f.db.templates.get(templateRef?.materializedEntityRef ?? '');
      expect(template?.name).toBe('Fixture flow');
      const templateRef2 = refs.value.find((ref) => ref.contentKind === 'template');
      expect(templateRef2?.materializedEntityRef).toBeNull(); // pack-native
    }
    // Role definition created; the actor is NOT assigned by the pack.
    const roles = await f.db.roles.list({ limit: 200 });
    expect(roles.items.some((role) => role.key === 'pack-fixture-reviewer' && role.companyId === 'company_default')).toBe(true);
    const assignments = await f.db.roleAssignments.list({ limit: 200 });
    expect(assignments.items.filter((a) => a.actorId === f.actor).length).toBe(1); // bootstrap owner only
    // Lifecycle events.
    const types = (await f.db.events.all()).map((entry) => entry.event.type);
    expect(types).toContain('pack.installed');
    // Availability source: only installed installations.
    const installed = await f.service.listInstalled('company_default');
    if (installed.ok) expect(installed.value).toHaveLength(1);
  });

  it('unauthorized install is denied with zero writes', async () => {
    const f = await make();
    const denied = await f.install({ actorId: f.outsider });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('PERMISSION_DENIED');
    const count = await f.db.packInstallations!.listByCompany('company_default');
    if (count.ok) expect(count.value).toHaveLength(0);
    expect(f.db.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(0);
    expect(f.db.db.prepare('SELECT * FROM pack_content_refs').all()).toHaveLength(0);
  });

  it('cross-company mutation is denied (company scope)', async () => {
    const f = await make();
    const denied = await f.install({ companyId: 'company_other' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('PACK_COMPANY_SCOPE_DENIED');
  });
});

describe('dependency resolution (exact, transitive, cycle-safe)', () => {

  it('transitive closure: A requires B, B requires C — installing A validates the whole chain', async () => {
    const f = await make();
    await seedTools(f);
    // C (no dependencies), then B (requires C), then A (requires B) — with real deps.
    const c = await f.install({ packId: 'pack-c', packVersion: '1.0.0' });
    expect(c.ok).toBe(true);
    const bDep = [{ packId: 'pack-c', packVersion: '1.0.0' }];
    const b = await f.install({ packId: 'pack-b', packVersion: '1.0.0', dependsOn: bDep });
    expect(b.ok).toBe(true);
    const aDep = [{ packId: 'pack-b', packVersion: '1.0.0' }];
    const a = await f.install({ packId: 'pack-a', packVersion: '1.0.0', dependsOn: aDep });
    expect(a.ok).toBe(true);
  });

  it('missing exact dependency → CONFLICT with zero writes; no auto-install', async () => {
    const f = await make();
    await seedTools(f);
    // The dependency IS known durably — but only installed in ANOTHER company.
    const authz = createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments });
    const elsewhereRole = await authz.defineRole({
      companyId: 'company_other',
      key: 'admin',
      name: 'Other company admin',
      authorities: ['pack.manage', 'workflow.review', 'workflow.draft.create'],
    });
    if (!elsewhereRole.ok) throw new Error(elsewhereRole.error.message);
    const assigned = await authz.assign({ actorId: f.actor, roleId: elsewhereRole.value.id, assignedBy: 'system:test' });
    if (!assigned.ok) throw new Error(assigned.error.message);
    const elsewhere = await f.install({ packId: 'pack-absent', packVersion: '1.0.0', companyId: 'company_other' });
    expect(elsewhere.ok).toBe(true);
    const missing = await f.install({ packId: 'pack-lonely', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-absent', packVersion: '1.0.0' }] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.details['reason']).toBe('PACK_DEPENDENCY_MISSING');
      // Dependency failure must not leak other companies' installation details.
      expect(JSON.stringify(missing.error.details)).not.toContain('company_other');
    }
    // Zero writes in the requesting company (the other company's durable row stays untouched).
    const own = await f.db.packInstallations!.listByCompany('company_default');
    expect(own.ok && own.value).toHaveLength(0);
    expect(f.db.db.prepare('SELECT * FROM pack_installations WHERE company_id = ?').all('company_default')).toHaveLength(0);
  });

  it('a version mismatch is not a range match (exact versions only)', async () => {
    const f = await make();
    await seedTools(f);
    await f.install({ packId: 'pack-c', packVersion: '1.0.0' });
    // A requires pack-c@2.0.0 but only 1.0.0 is installed → fail closed (no auto resolution).
    const wrong = await f.install({ packId: 'pack-a', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-c', packVersion: '2.0.0' }] });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.details['reason']).toBe('PACK_DEPENDENCY_MISSING');
  });

  it('a candidate that depends on itself is rejected before any write', async () => {
    const f = await make();
    await seedTools(f);
    const selfDep = await f.service.install({
      commandId: 'cmd_self_dep',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: manifest({
        packId: 'pack-self',
        packVersion: '1.0.0',
        dependsOn: [{ packId: 'pack-self', packVersion: '1.0.0' }],
      }),
      traceId: 'trace_self_dep',
    });
    expect(selfDep.ok).toBe(false);
    // The canonical manifest stage rejects a self-edge before resolution even starts
    // (the resolver keeps its own defence).
    if (!selfDep.ok) {
      expect(selfDep.error.code).toBe('VALIDATION_FAILED');
      expect(selfDep.error.message).toContain('cannot depend on itself');
    }
    expect(f.db.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(0);
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
  });

  it('a durable cycle that only the stores can fabricate is still rejected (candidate is in the graph)', async () => {
    const f = await make();
    await seedTools(f);
    // The public API cannot produce this state (every edge requires the target to be
    // installed first), so fabricate it through the durable stores: an installed
    // pack-b@1.0.0 whose canonical manifest requires the candidate pack-a@2.0.0.
    const { packManifestFingerprint, validatePackManifest } = await import('@companyos/core');
    const fabricated = manifest({ packId: 'pack-b', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-a', packVersion: '2.0.0' }] });
    const validated = validatePackManifest(fabricated);
    if (!validated.ok) throw new Error(validated.error.message);
    const version = {
      packId: 'pack-b',
      packVersion: '1.0.0',
      manifestFingerprint: packManifestFingerprint(validated.value),
      manifest: validated.value,
    };
    const storedVersion = await f.db.packVersions!.put(version);
    if (!storedVersion.ok) throw new Error(storedVersion.error.message);
    const storedInstallation = await f.db.packInstallations!.create({
      installation: {
        id: `pak_fabricated_${String(++seq).padStart(5, '0')}` as PackInstallation['id'],
        companyId: 'company_default' as PackInstallation['companyId'],
        packId: 'pack-b',
        packVersion: '1.0.0',
        name: 'pack-b pack',
        coreApi: '1',
        capabilities: ['pack-b:capability.one'],
        status: 'installed' as const,
        installedBy: f.actor,
        installedAt: nowIso(),
        updatedAt: nowIso(),
      },
      creationCommandId: 'cmd_fabricated_b',
      creationCommandFingerprint: 'sha256:' + 'a'.repeat(64),
    });
    if (!storedInstallation.ok) throw new Error(storedInstallation.error.message);
    const cycle = await f.install({
      packId: 'pack-a',
      packVersion: '2.0.0',
      dependsOn: [{ packId: 'pack-b', packVersion: '1.0.0' }],
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error.details['reason']).toBe('PACK_DEPENDENCY_CYCLE');
    expect(f.db.db.prepare("SELECT * FROM pack_installations WHERE pack_id = 'pack-a'").all()).toHaveLength(0);
  });
});

describe('preflight failures (zero writes)', () => {
  it('missing tool requirement → CONFLICT, no installation', async () => {
    const f = await make();
    const missing = await f.install();
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.details['reason']).toBe('PACK_TOOL_MISSING');
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
  });

  it('validator without the validation:validator capability → CONFLICT', async () => {
    const f = await make();
    const { createToolRecord } = await import('@companyos/core');
    for (const [toolId, capabilities] of [['tool.registered', []], ['tool.validator', ['other:capability']]] as const) {
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
      const registered = await registry.register(record.value, { actorId: f.actor });
      if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
    }
    const invalid = await f.install();
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.details['reason']).toBe('PACK_VALIDATOR_MISSING');
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
  });

  it('unknown role authority fails at the canonical manifest stage', async () => {
    const f = await make();
    const { createToolRecord } = await import('@companyos/core');
    for (const [toolId, capabilities] of [['tool.registered', []], ['tool.validator', ['validation:validator']]] as const) {
      const record = createToolRecord({
        toolId, name: toolId, description: toolId, version: '1.0.0', capabilities,
        requiredAuthorities: ['tool.invoke'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        riskLevel: 'LOW', now: nowIso(),
      });
      if (!record.ok) throw new Error(record.error.message);
      const registry = createToolRegistry({
        ids, clock, records: f.db.toolRecords, invocations: f.db.toolInvocations,
        invocationArtifacts: f.db.toolInvocationArtifacts, adapters: new Map(),
        authorize: async () => ok(true), events: f.db.events, secrets: async () => [],
        timer: (ms, onTimeout) => { const t = setTimeout(onTimeout, ms); return () => clearTimeout(t); },
      });
      const registered = await registry.register(record.value, { actorId: f.actor });
      if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
    }
    const bogus = await f.service.install({
      commandId: 'cmd_bogus_authority',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: manifest({ packId: 'pack-bogus', packVersion: '1.0.0', roleAuthority: 'pack.superadmin' }),
      traceId: 'trace_bogus',
    });
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.error.code).toBe('VALIDATION_FAILED'); // canonical manifest stage
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
  });

  it('a role key collision with an existing role is a CONFLICT (no last-writer-wins)', async () => {
    const f = await make();
    // Define the same role key directly through the authorization service, then install.
    const authz = createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments });
    const defined = await authz.defineRole({ companyId: 'company_default', key: 'pack-fixture-reviewer', name: 'Existing reviewer', authorities: ['workflow.review'] });
    expect(defined.ok).toBe(true);
    const conflict = await f.install();
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.details['reason']).toBe('PACK_ROLE_CONFLICT');
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
  });
});

describe('permanent install idempotency (Sprint 13 pattern)', () => {
  it('same command replays the durable installation (no duplicates)', async () => {
    const f = await make();
    await seedTools(f);
    const commandId = 'cmd_permanent_1';
    const first = await f.install({ commandId });
    expect(first.ok).toBe(true);
    const replay = await f.install({ commandId });
    expect(replay.ok).toBe(true);
    if (first.ok && replay.ok) expect(replay.value.id).toBe(first.value.id);
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(1);
    // PackContentRefs are not duplicated either.
    const refs = await f.db.packContentRefs!.listByInstallation(first.ok ? first.value.id : '');
    if (refs.ok) expect(refs.value).toHaveLength(9);
    // Replay emits no second lifecycle event.
    const installedEvents = (await f.db.events.all()).filter((e) => e.event.type === 'pack.installed');
    expect(installedEvents).toHaveLength(1);
  });

  it('same command with a different manifest → CONFLICT on the fingerprint', async () => {
    const f = await make();
    await seedTools(f);
    const commandId = 'cmd_permanent_2';
    const first = await f.install({ commandId });
    expect(first.ok).toBe(true);
    const conflict = await f.service.install({
      commandId,
      companyId: 'company_default',
      actorId: f.actor,
      manifest: manifest({ packId: 'pack-fixture', packVersion: '2.0.0' }),
      traceId: 'trace_conflict_2',
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.details['reason']).toBe('PACK_COMMAND_FINGERPRINT_CONFLICT');
    }
  });

  it('ledger miss (trimmed) still replays from the permanent installation identity', async () => {
    const f = await make();
    await seedTools(f);
    const commandId = 'cmd_permanent_3';
    const first = await f.install({ commandId });
    expect(first.ok).toBe(true);
    // Simulate the ledger trimming the command (bounded retry cache).
    f.db.db.prepare('DELETE FROM command_ledger WHERE command_id = ?').run(commandId);
    const replay = await f.install({ commandId });
    expect(replay.ok).toBe(true);
    if (first.ok && replay.ok) expect(replay.value.id).toBe(first.value.id);
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(1);
  });

  it('a different command for the same tuple returns the existing installation (no second row)', async () => {
    const f = await make();
    await seedTools(f);
    const first = await f.install({ commandId: 'cmd_tuple_a' });
    expect(first.ok).toBe(true);
    const second = await f.install({ commandId: 'cmd_tuple_b' });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.id).toBe(first.ok ? first.value.id : 'x');
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(1);
  });

  it('the same PackVersion is reused across companies (no manifest copy)', async () => {
    const f = await make();
    await seedTools(f);
    const other = 'company_other';
    // The outsider needs a company-B role to install there; give them one.
    const authz = createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments });
    const role = await authz.defineRole({ companyId: other, key: 'admin', name: 'B admin', authorities: ['pack.manage', 'workflow.review', 'workflow.draft.create'] });
    if (!role.ok) throw new Error(role.error.message);
    const assigned = await authz.assign({ actorId: f.outsider, roleId: role.value.id, assignedBy: 'system:test' });
    if (!assigned.ok) throw new Error(assigned.error.message);

    const a = await f.install({ commandId: 'cmd_ca' });
    expect(a.ok).toBe(true);
    const b = await f.install({ commandId: 'cmd_cb', companyId: other, actorId: f.outsider });
    expect(b.ok).toBe(true);
    // One PackVersion row, two installations.
    expect(f.db.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(1);
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(2);
  });
});

describe('disable / enable / upgrade lifecycle', () => {
  it('disable removes live availability, keeps every durable fact', async () => {
    const f = await make();
    await seedTools(f);
    const installed = await f.install({ commandId: 'cmd_dis_1' });
    expect(installed.ok).toBe(true);
    const disabled = await f.service.disable({
      commandId: 'cmd_dis_2',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-fixture',
      packVersion: '1.0.0',
      traceId: 'trace_dis',
    });
    expect(disabled.ok).toBe(true);
    if (disabled.ok) expect(disabled.value.status).toBe('disabled');
    const live = await f.service.listInstalled('company_default');
    if (live.ok) expect(live.value).toHaveLength(0);
    // History preserved: the installation row, the version and the refs all survive.
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(1);
    expect(f.db.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(1);
    expect(f.db.db.prepare('SELECT * FROM pack_content_refs').all()).toHaveLength(9);
    const types = (await f.db.events.all()).map((entry) => entry.event.type);
    expect(types).toContain('pack.disabled');
    // Disabling again is a stable result, not an error cycle.
    const again = await f.service.disable({
      commandId: 'cmd_dis_3',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-fixture',
      packVersion: '1.0.0',
      traceId: 'trace_dis_again',
    });
    expect(again.ok).toBe(true);
    const disableEvents = (await f.db.events.all()).filter((e) => e.event.type === 'pack.disabled');
    expect(disableEvents).toHaveLength(1);
  });

  it('disable is rejected while an installed pack depends on the target', async () => {
    const f = await make();
    await seedTools(f);
    await f.install({ commandId: 'cmd_dep_c', packId: 'pack-c', packVersion: '1.0.0' });
    await f.install({ commandId: 'cmd_dep_b', packId: 'pack-b', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-c', packVersion: '1.0.0' }] });
    const blocked = await f.service.disable({
      commandId: 'cmd_dep_dis',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-c',
      packVersion: '1.0.0',
      traceId: 'trace_dep_dis',
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.details['reason']).toBe('PACK_DEPENDENCY_IN_USE');
    const status = await f.db.packInstallations!.findEnabled('company_default', 'pack-c');
    if (status.ok && status.value) expect(status.value.status).toBe('installed');
  });

  it('enable revalidates and does not re-materialize', async () => {
    const f = await make();
    await seedTools(f);
    await f.install({ commandId: 'cmd_en_1' });
    await f.service.disable({ commandId: 'cmd_en_2', companyId: 'company_default', actorId: f.actor, packId: 'pack-fixture', packVersion: '1.0.0', traceId: 'trace_en_dis' });
    const rolesBefore = (await f.db.roles.list({ limit: 500 })).items.length;
    const templatesBefore = (await f.db.templates.list({ limit: 500 })).items.length;
    const enabled = await f.service.enable({
      commandId: 'cmd_en_3',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-fixture',
      packVersion: '1.0.0',
      traceId: 'trace_en',
    });
    expect(enabled.ok).toBe(true);
    if (enabled.ok) expect(enabled.value.status).toBe('installed');
    // No re-materialization: role and template counts are unchanged.
    expect((await f.db.roles.list({ limit: 500 })).items.length).toBe(rolesBefore);
    expect((await f.db.templates.list({ limit: 500 })).items.length).toBe(templatesBefore);
    const types = (await f.db.events.all()).map((entry) => entry.event.type);
    expect(types).toContain('pack.enabled');
  });

  it('upgrade v1→v2 is atomic: v2 installed, v1 disabled, one enabled version', async () => {
    const f = await make();
    await seedTools(f);
    await f.install({ commandId: 'cmd_upg_1' });
    const upgraded = await f.service.upgrade({
      commandId: 'cmd_upg_2',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-fixture',
      manifest: manifest({ packId: 'pack-fixture', packVersion: '2.0.0' }),
      traceId: 'trace_upg',
    });
    expect(upgraded.ok).toBe(true);
    if (upgraded.ok) expect(upgraded.value.packVersion).toBe('2.0.0');
    const installations = await f.db.packInstallations!.listByCompany('company_default');
    if (installations.ok) {
      expect(installations.value.filter((i) => i.status === 'installed')).toHaveLength(1);
      const v1 = installations.value.find((i) => i.packVersion === '1.0.0');
      expect(v1?.status).toBe('disabled'); // v1 never mutated: retained disabled
    }
    expect(f.db.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(2);
    const types = (await f.db.events.all()).map((entry) => entry.event.type);
    expect(types).toContain('pack.upgraded');
    expect(types).toContain('pack.disabled');
    // Upgrade replay is idempotent.
    const replay = await f.service.upgrade({
      commandId: 'cmd_upg_2',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-fixture',
      manifest: manifest({ packId: 'pack-fixture', packVersion: '2.0.0' }),
      traceId: 'trace_upg_replay',
    });
    expect(replay.ok).toBe(true);
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(2);
    const upgradedEvents = (await f.db.events.all()).filter((e) => e.event.type === 'pack.upgraded');
    expect(upgradedEvents).toHaveLength(1);
  });
});

describe('boundaries (no migration / no IPC / no run pinning / no dynamic code)', () => {
  it('pack.manage remains the only mutation authority and no new authority exists', () => {
    expect(AUTHORITIES).toContain('pack.manage');
    for (const authority of ['pack.read', 'pack.install', 'pack.enable', 'pack.disable', 'pack.upgrade']) {
      expect(AUTHORITIES).not.toContain(authority);
    }
  });

  it('a failing participant rolls the whole install back (no half-installed pack)', async () => {
    // The FIRST ref insert succeeds, the SECOND throws: the installation row, the
    // materialized role and the materialized workflow draft must ALL disappear.
    const f = await make();
    await seedTools(f);
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
      authorization: createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments }),
      lifecycle: createWorkflowLifecycle({
        ids, clock, templates: f.db.templates, locks: f.db.locks, proposals: f.db.proposals,
        snapshots: f.db.snapshots, runs: f.db.runs, events: f.db.events, unitOfWork: f.db.unitOfWork,
      }),
      packVersions: f.db.packVersions!,
      packInstallations: f.db.packInstallations!,
      packContentRefs: flakyRefs,
      events: f.db.events,
      ledger: f.db.ledger,
      unitOfWork: f.db.unitOfWork,
      toolRequirementResolver: f.toolResolver,
    });
    const boom = await service.install({
      commandId: 'cmd_rollback_1',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: manifest({ packId: 'pack-rollback', packVersion: '1.0.0' }),
      traceId: 'trace_rollback',
    });
    expect(boom.ok).toBe(false);
    // All-or-nothing: nothing survives anywhere.
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
    expect(f.db.db.prepare('SELECT * FROM pack_content_refs').all()).toHaveLength(0);
    expect(f.db.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(0);
    expect(f.db.db.prepare('SELECT * FROM workflow_templates').all()).toHaveLength(0);
    expect(f.db.db.prepare('SELECT * FROM roles').all()).not.toHaveLength(0); // bootstrap owner only
    expect((await f.db.roles.list({ limit: 500 })).items.every((role) => role.key === 'owner')).toBe(true);
    // The install event is only emitted after the transaction commits.
    expect((await f.db.events.all()).map((entry) => entry.event.type)).not.toContain('pack.installed');
  });

  it('a packless workflow keeps working (no pack is ever installed)', async () => {
    const f = await make();
    const template = await f.lifecycle.createTemplate({ orgId: 'company_default', name: 'Packless flow', actorId: f.actor, traceId: 'trace_packless' });
    expect(template.ok).toBe(true);
    if (!template.ok) return;
    const draft = await f.lifecycle.saveDraftGraph({
      templateId: template.value.id,
      graph: { nodes: [{ id: 's1', kind: 'work', title: 'Work', config: {} }], edges: [] },
      actorId: f.actor,
      traceId: 'trace_packless',
    });
    expect(draft.ok).toBe(true);
    expect(f.db.db.prepare('SELECT * FROM pack_installations').all()).toHaveLength(0);
    expect((await f.db.events.all()).every((entry) => !entry.event.type.startsWith('pack.'))).toBe(true);
  });

  it('the service writes no subsystem table with raw SQL and loads no dynamic code', () => {
    const source = readFileSync(fileURLToPath(new URL('../../packages/engine/src/pack/pack-service.ts', import.meta.url)), 'utf8');
    for (const forbidden of ['prepare(', 'INSERT INTO', 'DELETE FROM', 'DROP TABLE', 'eval(', 'new Function(', 'node:vm', 'child_process', 'electron', 'ipcRenderer']) {
      expect(source.includes(forbidden)).toBe(false);
    }
  });
});

describe('matrix completion (frozen contract gaps)', () => {
  it('a PackVersion identity is immutable: the same tuple with different content is a CONFLICT', async () => {
    const f = await make();
    await seedTools(f);
    const first = await f.install({ packId: 'pack-immutable', packVersion: '1.0.0' });
    expect(first.ok).toBe(true);
    // A second company needs its own actor seat; the PackVersion row is SHARED, so the
    // same (packId, packVersion) with different manifest content must be refused.
    const authz = createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments });
    const role = await authz.defineRole({ companyId: 'company_other', key: 'admin', name: 'Other admin', authorities: ['pack.manage', 'workflow.review', 'workflow.draft.create'] });
    if (!role.ok) throw new Error(role.error.message);
    const assigned = await authz.assign({ actorId: f.outsider, roleId: role.value.id, assignedBy: 'system:test' });
    if (!assigned.ok) throw new Error(assigned.error.message);
    const conflict = await f.service.install({
      commandId: 'cmd_immutable_conflict',
      companyId: 'company_other',
      actorId: f.outsider,
      manifest: manifest({ packId: 'pack-immutable', packVersion: '1.0.0', name: 'A different manifest for the same identity' }),
      traceId: 'trace_immutable_conflict',
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.details['reason']).toBe('PACK_VERSION_CONFLICT');
    expect(f.db.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(1); // no second row, no rewrite
    expect(f.db.db.prepare("SELECT * FROM pack_installations WHERE company_id = 'company_other'").all()).toHaveLength(0);
  });

  it('an installed pack that requires the exact previous version blocks the upgrade', async () => {
    const f = await make();
    await seedTools(f);
    await f.install({ packId: 'pack-a', packVersion: '1.0.0' });
    const dependent = await f.install({ packId: 'pack-b', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-a', packVersion: '1.0.0' }] });
    expect(dependent.ok).toBe(true);
    const blocked = await f.service.upgrade({
      commandId: 'cmd_upgrade_blocked',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-a',
      manifest: manifest({ packId: 'pack-a', packVersion: '2.0.0' }),
      traceId: 'trace_upgrade_blocked',
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.details['reason']).toBe('PACK_DEPENDENCY_IN_USE');
    expect(f.db.db.prepare("SELECT * FROM pack_versions WHERE pack_id = 'pack-a' AND pack_version = '2.0.0'").all()).toHaveLength(0);
    // v1 stays enabled and untouched.
    const enabled = await f.db.packInstallations!.findEnabled('company_default', 'pack-a');
    expect(enabled.ok && enabled.value?.packVersion).toBe('1.0.0');
  });

  it('a disabled dependency is not available; re-enabling restores it', async () => {
    const f = await make();
    await seedTools(f);
    await f.install({ packId: 'pack-b', packVersion: '1.0.0' });
    const disabled = await f.service.disable({ commandId: 'cmd_dis_b', companyId: 'company_default', actorId: f.actor, packId: 'pack-b', traceId: 'trace_dis_b' });
    expect(disabled.ok).toBe(true);
    // Availability source is the installed STATUS: a disabled dependency cannot back a new install.
    const whileDisabled = await f.install({ packId: 'pack-a', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-b', packVersion: '1.0.0' }] });
    expect(whileDisabled.ok).toBe(false);
    if (!whileDisabled.ok) expect(whileDisabled.error.details['reason']).toBe('PACK_DEPENDENCY_MISSING');
    expect(f.db.db.prepare("SELECT * FROM pack_installations WHERE pack_id = 'pack-a'").all()).toHaveLength(0);
    const reEnabled = await f.service.enable({ commandId: 'cmd_en_b', companyId: 'company_default', actorId: f.actor, packId: 'pack-b', packVersion: '1.0.0', traceId: 'trace_en_b' });
    expect(reEnabled.ok).toBe(true);
    const afterEnable = await f.install({ packId: 'pack-a', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-b', packVersion: '1.0.0' }] });
    expect(afterEnable.ok).toBe(true);
  });

  it('a capability id outside the pack namespace fails at the canonical manifest stage', async () => {
    const f = await make();
    await seedTools(f);
    const foreign = await f.service.install({
      commandId: 'cmd_foreign_capability',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: {
        ...(manifest({ packId: 'pack-x', packVersion: '1.0.0' }) as Record<string, unknown>),
        capabilities: [{ id: 'someone-else:capability.one', description: 'not owned by this pack' }],
      },
      traceId: 'trace_foreign_capability',
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe('VALIDATION_FAILED');
      expect(foreign.error.message).toContain('namespaced');
    }
    expect(f.db.db.prepare('SELECT * FROM pack_versions').all()).toHaveLength(0);
  });
});

describe('PACK_LIVE_CAPABILITY_DISABLE_GAP corrective (new-use availability)', () => {
  const roleEntityId = async (f: Fixture, packId: string, keySuffix: string): Promise<string> => {
    const installations = await f.db.packInstallations!.listByCompany('company_default');
    if (!installations.ok) throw new Error(installations.error.message);
    for (const installation of installations.value) {
      if (installation.packId !== packId) continue;
      const refs = await f.db.packContentRefs!.listByInstallation(installation.id);
      if (!refs.ok) throw new Error(refs.error.message);
      const ref = refs.value.find((entry) => entry.contentKind === 'role' && entry.logicalKey.endsWith(keySuffix));
      if (ref?.materializedEntityRef !== null && ref !== undefined) return ref.materializedEntityRef;
    }
    throw new Error(`pack-materialized role ${packId}:${keySuffix} not found`);
  };

  const templateEntityId = async (f: Fixture, packId: string): Promise<string> => {
    const installations = await f.db.packInstallations!.listByCompany('company_default');
    if (!installations.ok) throw new Error(installations.error.message);
    for (const installation of installations.value) {
      if (installation.packId !== packId) continue;
      const refs = await f.db.packContentRefs!.listByInstallation(installation.id);
      if (!refs.ok) throw new Error(refs.error.message);
      const ref = refs.value.find((entry) => entry.contentKind === 'workflowTemplate');
      if (ref?.materializedEntityRef !== null && ref !== undefined) return ref.materializedEntityRef;
    }
    throw new Error(`pack-materialized workflow template for ${packId} not found`);
  };

  it('a pack-materialized role cannot be assigned to a new member after disable (direct API)', async () => {
    const f = await make();
    await seedTools(f);
    await f.install({ packId: 'pack-role-a' });
    const roleId = await roleEntityId(f, 'pack-role-a', ':reviewer');
    // While installed the direct Role assignment API accepts a NEW member.
    const whileInstalled = await f.guardedAuthorization.assign({ actorId: 'user_new_member', roleId, assignedBy: 'system:test' });
    expect(whileInstalled.ok).toBe(true);

    const disabled = await f.service.disable({ commandId: 'cmd_role_dis', companyId: 'company_default', actorId: f.actor, packId: 'pack-role-a', traceId: 'trace_role_dis' });
    expect(disabled.ok).toBe(true);

    // Direct API bypass (no PackService in the path): the guard lives in the subsystem.
    const afterDisable = await f.guardedAuthorization.assign({ actorId: 'user_other_member', roleId, assignedBy: 'system:test' });
    expect(afterDisable.ok).toBe(false);
    if (!afterDisable.ok) {
      expect(afterDisable.error.code).toBe('POLICY_DENIED');
      expect(afterDisable.error.details['reason']).toBe('PACK_MATERIALIZED_CONTENT_UNAVAILABLE');
      expect(JSON.stringify(afterDisable.error.details)).not.toContain('company_other');
    }
    // Historical rows stay readable and the earlier assignment is untouched (history).
    expect(await f.db.roles.get(roleId)).not.toBeNull();
    expect((await f.guardedAuthorization.assignmentsOf('user_new_member')).some((entry) => entry.roleId === roleId)).toBe(true);
    expect(f.db.db.prepare('SELECT * FROM pack_content_refs').all().length).toBeGreaterThan(0);

    // Re-enable restores availability with ZERO re-materialization.
    const before = await f.db.roles.list({ limit: 500 });
    const enabled = await f.service.enable({ commandId: 'cmd_role_en', companyId: 'company_default', actorId: f.actor, packId: 'pack-role-a', packVersion: '1.0.0', traceId: 'trace_role_en' });
    expect(enabled.ok).toBe(true);
    const reEnabled = await f.guardedAuthorization.assign({ actorId: 'user_third_member', roleId, assignedBy: 'system:test' });
    expect(reEnabled.ok).toBe(true);
    const after = await f.db.roles.list({ limit: 500 });
    expect(after.items).toHaveLength(before.items.length); // 0 duplicate roles
    expect(f.db.db.prepare('SELECT * FROM pack_content_refs').all()).toHaveLength(9);
  });

  it('a materialized role shared by v1 and v2 stays available while v2 is installed', async () => {
    const f = await make();
    await seedTools(f);
    await f.install({ packId: 'pack-shared', packVersion: '1.0.0' });
    const roleId = await roleEntityId(f, 'pack-shared', ':reviewer');
    // Upgrade reuses the SAME materialized role (identical declaration).
    const upgraded = await f.service.upgrade({
      commandId: 'cmd_shared_upgrade',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-shared',
      manifest: manifest({ packId: 'pack-shared', packVersion: '2.0.0' }),
      traceId: 'trace_shared_upgrade',
    });
    expect(upgraded.ok).toBe(true);
    expect(await roleEntityId(f, 'pack-shared', ':reviewer')).toBe(roleId);
    // v1 is disabled, v2 installed: any-live-owner semantics keep the role assignable.
    const duringUpgrade = await f.guardedAuthorization.assign({ actorId: 'user_shared_1', roleId, assignedBy: 'system:test' });
    expect(duringUpgrade.ok).toBe(true);
    // Disabling the live owner removes new-use availability.
    const disabled = await f.service.disable({ commandId: 'cmd_shared_dis', companyId: 'company_default', actorId: f.actor, packId: 'pack-shared', packVersion: '2.0.0', traceId: 'trace_shared_dis' });
    expect(disabled.ok).toBe(true);
    const afterDisable = await f.guardedAuthorization.assign({ actorId: 'user_shared_2', roleId, assignedBy: 'system:test' });
    expect(afterDisable.ok).toBe(false);
    if (!afterDisable.ok) expect(afterDisable.error.details['reason']).toBe('PACK_MATERIALIZED_CONTENT_UNAVAILABLE');
  });

  it('a pack-materialized workflow cannot start new work after disable (every new-use API)', async () => {
    const f = await make();
    await seedTools(f);
    await f.install({ packId: 'pack-flow-a' });
    const templateId = await templateEntityId(f, 'pack-flow-a');

    // Live: publish the materialized draft and start a run from it.
    const published = await f.guardedLifecycle.publish({ templateId, actorId: f.actor, traceId: 'trace_flow_publish' });
    expect(published.ok).toBe(true);
    const run = await f.guardedLifecycle.createRun({ templateId, companyId: 'company_default', workflowId: 'wf_flow_a', actorId: f.actor });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // No Run pinning in this task: packVersions stays empty (T15-05 scope).
    const snapshot = await f.guardedLifecycle.readSnapshot(run.value.snapshot.id);
    expect(snapshot?.packVersions).toEqual({});

    const disabled = await f.service.disable({ commandId: 'cmd_flow_dis', companyId: 'company_default', actorId: f.actor, packId: 'pack-flow-a', traceId: 'trace_flow_dis' });
    expect(disabled.ok).toBe(true);

    // Every new-use entry refuses (direct subsystem API, no PackService in the path).
    for (const attempt of [
      f.guardedLifecycle.saveDraftGraph({ templateId, graph: { nodes: [{ id: 's1', kind: 'work', title: 'Work', config: {} }], edges: [] }, actorId: f.actor, traceId: 'trace_flow_draft' }),
      f.guardedLifecycle.publishRevision({ templateId, actorId: f.actor, traceId: 'trace_flow_revision' }),
      f.guardedLifecycle.fork({ templateId, name: 'Forked from a disabled pack', actorId: f.actor, traceId: 'trace_flow_fork' }),
      f.guardedLifecycle.createRun({ templateId, companyId: 'company_default', workflowId: 'wf_flow_a_2', actorId: f.actor }),
    ]) {
      const denied = await attempt;
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.error.code).toBe('POLICY_DENIED');
        expect(denied.error.details['reason']).toBe('PACK_MATERIALIZED_CONTENT_UNAVAILABLE');
      }
    }

    // Historical reads and the EXISTING run stay untouched.
    expect(await f.guardedLifecycle.readTemplate(templateId)).not.toBeNull();
    expect(await f.guardedLifecycle.readSnapshot(run.value.snapshot.id)).not.toBeNull();
    expect(f.db.db.prepare('SELECT * FROM runs').all().length).toBeGreaterThan(0);
    expect(f.db.db.prepare('SELECT * FROM workflow_templates').all().length).toBeGreaterThan(0);
    const versions = f.db.db.prepare('SELECT * FROM workflow_template_versions').all();
    expect(versions.length).toBeGreaterThan(0);
  });

  it('availability is company-scoped: disabling one company never gates another', async () => {
    const f = await make();
    await seedTools(f);
    await f.install({ packId: 'pack-scope-a' });
    // Install the same pack in a second company (the outsider holds a seat there).
    const authz = createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments });
    const seat = await authz.defineRole({ companyId: 'company_other', key: 'admin', name: 'Other admin', authorities: ['pack.manage', 'workflow.review', 'workflow.draft.create'] });
    if (!seat.ok) throw new Error(seat.error.message);
    const assigned = await authz.assign({ actorId: f.outsider, roleId: seat.value.id, assignedBy: 'system:test' });
    if (!assigned.ok) throw new Error(assigned.error.message);
    const elsewhere = await f.install({ packId: 'pack-scope-a', companyId: 'company_other', actorId: f.outsider });
    expect(elsewhere.ok).toBe(true);

    const otherInstallations = await f.db.packInstallations!.listByCompany('company_other');
    if (!otherInstallations.ok) throw new Error(otherInstallations.error.message);
    const otherRefs = await f.db.packContentRefs!.listByInstallation(otherInstallations.value[0]!.id);
    if (!otherRefs.ok) throw new Error(otherRefs.error.message);
    const otherRoleRef = otherRefs.value.find((entry) => entry.contentKind === 'role');
    expect(otherRoleRef?.materializedEntityRef).toBeTruthy();

    // Disable in company_default only.
    const disabled = await f.service.disable({ commandId: 'cmd_scope_dis', companyId: 'company_default', actorId: f.actor, packId: 'pack-scope-a', traceId: 'trace_scope_dis' });
    expect(disabled.ok).toBe(true);
    const stillLive = await f.availability.isMaterializedContentAvailable({
      companyId: 'company_other',
      contentKind: 'role',
      entityId: otherRoleRef!.materializedEntityRef!,
    });
    expect(stillLive.ok && stillLive.value).toBe(true);
    // A non-pack role in the disabled company is never gated.
    const bootstrapRole = (await f.db.roles.list({ limit: 500 })).items.find((role) => role.companyId === 'company_default');
    const notGated = await f.availability.isMaterializedContentAvailable({ companyId: 'company_default', contentKind: 'role', entityId: bootstrapRole!.id });
    expect(notGated.ok && notGated.value).toBe(true);
  });

  it('disable keeps provenance immutable: no ref deleted, no new migration, tool registry untouched', async () => {
    const f = await make();
    await seedTools(f);
    await f.install({ packId: 'pack-provenance-a' });
    const refsBefore = f.db.db.prepare('SELECT * FROM pack_content_refs ORDER BY installation_id, content_kind, logical_key').all();
    const versionsBefore = f.db.db.prepare('SELECT * FROM pack_versions').all();
    const disabled = await f.service.disable({ commandId: 'cmd_prov_dis', companyId: 'company_default', actorId: f.actor, packId: 'pack-provenance-a', traceId: 'trace_prov_dis' });
    expect(disabled.ok).toBe(true);
    const refsAfter = f.db.db.prepare('SELECT * FROM pack_content_refs ORDER BY installation_id, content_kind, logical_key').all();
    const versionsAfter = f.db.db.prepare('SELECT * FROM pack_versions').all();
    expect(refsAfter).toEqual(refsBefore); // provenance never mutated to hide content
    expect(versionsAfter).toEqual(versionsBefore);
    // Only pack.disabled is written for the disable (no synthetic role/workflow events).
    const packEvents = (await f.db.events.all()).filter((entry) => entry.event.type.startsWith('pack.'));
    expect(packEvents.map((entry) => entry.event.type).sort()).toEqual(['pack.disabled', 'pack.installed']);
    // A pack tool REQUIREMENT never disables the global tool: the registry keeps serving it.
    const record = await f.toolResolver.resolve('tool.registered');
    expect(record.ok && record.capabilities).toBeTruthy();
    // The pack chain needs no schema change for the corrective.
    const migrations = readdirSync(fileURLToPath(new URL('../../packages/persistence/migrations/pack', import.meta.url)));
    expect(migrations.filter((name) => name.endsWith('.sql'))).toEqual(['0001_pack_persistence.sql']);
  });
});
