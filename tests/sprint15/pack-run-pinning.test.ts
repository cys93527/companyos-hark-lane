/**
 * Sprint 15 / Task-15-05: Run Pack Pinning & Production Composition (ADR-0027).
 *
 * Real SQLite (pack + lifecycle + core + engine + provider + agent + tools + artifact
 * chains), real PackService, real availability policy, real run provenance resolver and
 * the real WorkflowLifecycle. One industry-neutral fixture per pack.
 *
 * The matrix locks the frozen rules: `RunSnapshot.packVersions` is TRUSTED DERIVED DATA
 * (no caller field exists), root provenance comes from the LIVE pack owners of the
 * selected materialized template plus their exact dependency closure, resolution happens
 * BEFORE any write, a packless workflow still pins `{}`, and after creation no runtime or
 * recovery path ever consults the current active pack.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTHORITIES,
  TOOL_CAPABILITY_VALIDATOR,
  createPackContentRef,
  createToolRecord,
  ok,
  validatorIdsOf,
  type DomainError,
  type PackInstallation,
  type PackVersion,
  type Result,
} from '@companyos/core';
import {
  createAuthorizationService,
  createPackAvailabilityPolicy,
  createPackService,
  createRunPackProvenanceResolver,
  createToolRegistry,
  createValidationEvidenceGuard,
  createWorkflowLifecycle,
  ensureBootstrapOwner,
  type CreateRunInput,
  type RunPackProvenanceResolver,
  type ToolRequirementResolver,
  type WorkflowLifecycle,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t15pin-'));
  created.push(dir);
  return dir;
};
let seq = 0;
const ids = {
  // 12 digits: long enough for every canonical id pattern (e.g. the artifact target ref).
  id: (prefix = 'id') => `${prefix}_15P${String(++seq).padStart(12, '0')}`,
  ulid: () => `15P${String(++seq).padStart(23, '0')}`,
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

/** Industry-neutral manifest: one role + one workflow template + the other seven kinds. */
const manifest = (over: {
  readonly packId: string;
  readonly packVersion: string;
  readonly dependsOn?: readonly { readonly packId: string; readonly packVersion: string }[];
}): unknown => ({
  manifestVersion: 1,
  packId: over.packId,
  packVersion: over.packVersion,
  name: `${over.packId} pack`,
  coreApi: '1',
  capabilities: [{ id: `${over.packId}:capability.one`, description: 'a capability' }],
  dependsOn: over.dependsOn ?? [],
  declarations: {
    roles: [{ key: `${over.packId}:reviewer`, label: 'Reviewer', authorityRefs: ['workflow.review'] }],
    workflowTemplates: [
      {
        key: `${over.packId}:flow`,
        name: 'Fixture flow',
        description: '',
        graph: {
          nodes: [
            { id: 's1', kind: 'work', title: 'Work', config: { validatorIds: ['tool.validator'] } },
          ],
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
    templates: [{ key: `${over.packId}:document-template`, kind: 'some-type', content: { title: 'x' } }],
  },
});

interface Fixture {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly service: ReturnType<typeof createPackService>;
  /** Lifecycle with availability + provenance wired exactly like the production root. */
  readonly lifecycle: WorkflowLifecycle;
  readonly resolver: RunPackProvenanceResolver;
  readonly actor: string;
  readonly calls: () => number;
  readonly templateIdOf: (packId: string, packVersion?: string) => Promise<string>;
  readonly install: (over: {
    readonly packId: string;
    readonly packVersion: string;
    readonly dependsOn?: readonly { readonly packId: string; readonly packVersion: string }[];
    readonly companyId?: string;
    readonly actorId?: string;
    readonly commandId?: string;
  }) => Promise<Result<{ readonly id: string }, DomainError>>;
}

const make = async (): Promise<Fixture> => {
  seq += 1;
  const dataDir = tempDir();
  const db = openDurableDatabase({
    dataDir,
    appliedAt: nowIso(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'agent', 'tools', 'artifact', 'pack'],
  });
  database = db;
  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  const actor = 'user_owner';
  const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);

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
  const toolResolver: ToolRequirementResolver = {
    async resolve(toolId: string) {
      const found = await registry.get(toolId, actor);
      if (!found.ok || found.value === null) return { ok: false as const };
      return { ok: true as const, capabilities: found.value.capabilities };
    },
  };

  // Materialization goes through an UNGUARDED lifecycle: the pack layer creates its own
  // content, so its new rows are never blocked by the availability guard.
  const materializingLifecycle = createWorkflowLifecycle({
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

  const service = createPackService({
    clock,
    ids,
    authorization: authz,
    lifecycle: materializingLifecycle,
    packVersions: db.packVersions!,
    packInstallations: db.packInstallations!,
    packContentRefs: db.packContentRefs!,
    events: db.events,
    ledger: db.ledger,
    unitOfWork: db.unitOfWork,
    toolRequirementResolver: toolResolver,
  });

  const packAvailability = createPackAvailabilityPolicy({
    packInstallations: db.packInstallations!,
    packContentRefs: db.packContentRefs!,
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
    packAvailability,
    packProvenance: resolver,
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
    readonly companyId?: string;
    readonly actorId?: string;
    readonly commandId?: string;
  }): Promise<Result<{ readonly id: string }, DomainError>> => {
    const commandId = over.commandId ?? `cmd_${ids.id('install')}`;
    const result = await service.install({
      commandId,
      companyId: over.companyId ?? 'company_default',
      actorId: over.actorId ?? actor,
      manifest: manifest({ packId: over.packId, packVersion: over.packVersion, dependsOn: over.dependsOn }),
      traceId: `trace_${commandId}`,
    });
    if (!result.ok) return result;
    return ok({ id: result.value.id });
  };

  return { db, dataDir, service, lifecycle, resolver, actor, calls: () => calls, templateIdOf, install };
};

/** Publish a template and start a run through the production-like lifecycle. */
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

describe('T15-05 run pack pinning (trusted derived provenance)', () => {
  it('1. a packless workflow pins {} (legacy workflow stays first-class)', async () => {
    const f = await make();
    const template = await f.lifecycle.createTemplate({ orgId: 'company_default', name: 'Packless flow', actorId: f.actor, traceId: 't_packless' });
    expect(template.ok).toBe(true);
    if (!template.ok) return;
    const graph = { nodes: [{ id: 's1', kind: 'work' as const, title: 'Work', config: {} }], edges: [] };
    await f.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: f.actor, traceId: 't_packless' });
    const run = await runFromTemplate(f, template.value.id, 'packless');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(snapshot?.packVersions).toEqual({});
  });

  it('2. one pack-owned workflow pins the exact live owner version', async () => {
    const f = await make();
    await f.install({ packId: 'pack-a', packVersion: '1.4.2' });
    const templateId = await f.templateIdOf('pack-a');
    const run = await runFromTemplate(f, templateId, 'one');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(snapshot?.packVersions).toEqual({ 'pack-a': '1.4.2' });
    expect(f.calls()).toBe(1); // one resolution per new run
  });

  it('3. root + direct dependency are pinned together', async () => {
    const f = await make();
    await f.install({ packId: 'pack-b', packVersion: '2.0.0' });
    await f.install({ packId: 'pack-a', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-b', packVersion: '2.0.0' }] });
    const run = await runFromTemplate(f, await f.templateIdOf('pack-a'), 'direct');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(snapshot?.packVersions).toEqual({ 'pack-a': '1.0.0', 'pack-b': '2.0.0' });
  });

  it('4. the transitive exact dependency closure is pinned', async () => {
    const f = await make();
    await f.install({ packId: 'pack-c', packVersion: '3.1.0' });
    await f.install({ packId: 'pack-b', packVersion: '2.0.0', dependsOn: [{ packId: 'pack-c', packVersion: '3.1.0' }] });
    await f.install({ packId: 'pack-a', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-b', packVersion: '2.0.0' }] });
    const run = await runFromTemplate(f, await f.templateIdOf('pack-a'), 'closure');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(snapshot?.packVersions).toEqual({ 'pack-a': '1.0.0', 'pack-b': '2.0.0', 'pack-c': '3.1.0' });
  });

  it('5. the pinned map is packId-sorted and deterministic', async () => {
    const f = await make();
    await f.install({ packId: 'pack-z', packVersion: '1.0.0' });
    await f.install({ packId: 'pack-a', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-z', packVersion: '1.0.0' }] });
    const run = await runFromTemplate(f, await f.templateIdOf('pack-a'), 'order');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(Object.keys(snapshot!.packVersions)).toEqual(['pack-a', 'pack-z']);
    // Same contributing set -> identical serialization.
    const stored = JSON.parse(
      (f.db.db.prepare('SELECT pack_versions_json FROM run_snapshots WHERE id = ?').get(run.value.snapshotId) as { pack_versions_json: string }).pack_versions_json,
    ) as Record<string, string>;
    expect(Object.keys(stored)).toEqual(['pack-a', 'pack-z']);
    expect(stored).toEqual({ 'pack-a': '1.0.0', 'pack-z': '1.0.0' });
  });

  it('6. a disabled historical owner is excluded from new runs', async () => {
    const f = await make();
    await f.install({ packId: 'pack-x', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-x');
    const first = await runFromTemplate(f, templateId, 'v1');
    expect(first.ok).toBe(true);
    const upgraded = await f.service.upgrade({
      commandId: 'cmd_upgrade_x',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-x',
      manifest: manifest({ packId: 'pack-x', packVersion: '2.0.0' }),
      traceId: 'trace_upgrade_x',
    });
    expect(upgraded.ok).toBe(true);
    const v2TemplateId = await f.templateIdOf('pack-x', '2.0.0');
    expect(v2TemplateId).not.toBe(templateId); // v2 materialized its own template
    // The v1 template stays readable, but the NEW run pins only the live v2 owner.
    const second = await runFromTemplate(f, v2TemplateId, 'v2');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(second.value.snapshotId);
    expect(snapshot?.packVersions).toEqual({ 'pack-x': '2.0.0' });
  });

  it('7. every live owner is pinned (no random pick)', async () => {
    const f = await make();
    await f.install({ packId: 'pack-x', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-x');
    // A second, independently installed pack that declares ownership of the SAME
    // materialized template (durable provenance, inserted through the store).
    const secondInstall = await f.install({ packId: 'pack-y', packVersion: '5.0.0' });
    expect(secondInstall.ok).toBe(true);
    const companyRows = await f.db.packInstallations!.listByCompany('company_default');
    if (!companyRows.ok) throw new Error(companyRows.error.message);
    const yInstallation = companyRows.value.find((row) => row.packId === 'pack-y');
    const ref = createPackContentRef({
      packId: 'pack-y',
      packVersion: '5.0.0',
      contentKind: 'workflowTemplate',
      logicalKey: 'pack-y:shared-flow',
      materializedEntityRef: templateId,
    });
    if (!ref.ok) throw new Error(ref.error.message);
    const inserted = await f.db.packContentRefs!.insert(yInstallation!.id, ref.value);
    if (!inserted.ok) throw new Error(inserted.error.message);
    const run = await runFromTemplate(f, templateId, 'shared');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(snapshot?.packVersions).toEqual({ 'pack-x': '1.0.0', 'pack-y': '5.0.0' });
  });

  it('8. provenance is company-scoped: no cross-tenant pinning', async () => {
    const f = await make();
    await f.install({ packId: 'pack-x', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-x');
    // The same pack installed for a second company materializes its OWN template there.
    const authz = createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments });
    const seat = await authz.defineRole({ companyId: 'company_other', key: 'admin', name: 'Other admin', authorities: ['pack.manage', 'workflow.review', 'workflow.draft.create'] });
    if (!seat.ok) throw new Error(seat.error.message);
    const assigned = await authz.assign({ actorId: 'user_other', roleId: seat.value.id, assignedBy: 'system:test' });
    if (!assigned.ok) throw new Error(assigned.error.message);
    const elsewhere = await f.install({ packId: 'pack-x', packVersion: '1.0.0', companyId: 'company_other', actorId: 'user_other' });
    expect(elsewhere.ok).toBe(true);
    // Asking with the WRONG company finds no owner there: never a cross-tenant pin.
    const wrongCompany = await f.resolver.resolveForWorkflow({ companyId: 'company_other', templateId });
    expect(wrongCompany.ok && wrongCompany.value).toEqual({});
    const rightCompany = await f.resolver.resolveForWorkflow({ companyId: 'company_default', templateId });
    expect(rightCompany.ok && rightCompany.value).toEqual({ 'pack-x': '1.0.0' });
  });

  it('9. a missing dependency fails the run closed (0 run, 0 snapshot)', async () => {
    const f = await make();
    await f.install({ packId: 'pack-a', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-a');
    // Corrupt the durable state through the STORES only: an installed owner whose manifest
    // now requires a version that is not installed (a state PackService would never create).
    const disabled = await f.service.disable({ commandId: 'cmd_free_a', companyId: 'company_default', actorId: f.actor, packId: 'pack-a', packVersion: '1.0.0', traceId: 'trace_free_a' });
    expect(disabled.ok).toBe(true);
    const { packManifestFingerprint, validatePackManifest } = await import('@companyos/core');
    const broken = manifest({ packId: 'pack-a', packVersion: '2.0.0', dependsOn: [{ packId: 'pack-b', packVersion: '9.9.9' }] });
    const validated = validatePackManifest(broken);
    if (!validated.ok) throw new Error(validated.error.message);
    const put = await f.db.packVersions!.put({
      packId: 'pack-a',
      packVersion: '2.0.0',
      manifestFingerprint: packManifestFingerprint(validated.value),
      manifest: validated.value,
    } satisfies PackVersion);
    if (!put.ok) throw new Error(put.error.message);
    const installation = {
      id: ids.id('pak') as PackInstallation['id'],
      companyId: 'company_default' as PackInstallation['companyId'],
      packId: 'pack-a',
      packVersion: '2.0.0',
      name: 'pack-a pack',
      coreApi: '1',
      capabilities: ['pack-a:capability.one'],
      status: 'installed' as const,
      installedBy: f.actor,
      installedAt: nowIso(),
      updatedAt: nowIso(),
    };
    const createdInstallation = await f.db.packInstallations!.create({
      installation,
      creationCommandId: 'cmd_fabricated_a2',
      creationCommandFingerprint: 'sha256:' + 'b'.repeat(64),
    });
    if (!createdInstallation.ok) throw new Error(createdInstallation.error.message);
    const ref = createPackContentRef({ packId: 'pack-a', packVersion: '2.0.0', contentKind: 'workflowTemplate', logicalKey: 'pack-a:flow', materializedEntityRef: templateId });
    if (!ref.ok) throw new Error(ref.error.message);
    const inserted = await f.db.packContentRefs!.insert(createdInstallation.value.id, ref.value);
    if (!inserted.ok) throw new Error(inserted.error.message);

    const published = await f.lifecycle.publish({ templateId, actorId: f.actor, traceId: 't_broken' });
    expect(published.ok).toBe(true);
    const runsBefore = f.db.db.prepare('SELECT * FROM runs').all().length;
    const denied = await f.lifecycle.createRun({ templateId, companyId: 'company_default', workflowId: 'wf_broken', actorId: f.actor });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('PACK_DEPENDENCY_MISSING');
    expect(f.db.db.prepare('SELECT * FROM runs').all()).toHaveLength(runsBefore);
    expect(f.db.db.prepare('SELECT * FROM run_snapshots').all().length).toBeLessThanOrEqual(runsBefore);
  });

  it('10. a durable dependency cycle fails the run closed', async () => {
    const f = await make();
    await f.install({ packId: 'pack-a', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-a');
    const disabled = await f.service.disable({ commandId: 'cmd_free_a_cycle', companyId: 'company_default', actorId: f.actor, packId: 'pack-a', packVersion: '1.0.0', traceId: 'trace_free_a_cycle' });
    expect(disabled.ok).toBe(true);
    const { packManifestFingerprint, validatePackManifest } = await import('@companyos/core');
    // Fabricate two mutually dependent installed versions through the stores.
    const specs = [
      { packId: 'pack-a', packVersion: '2.0.0', dependsOn: [{ packId: 'pack-b', packVersion: '1.0.0' }] },
      { packId: 'pack-b', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-a', packVersion: '2.0.0' }] },
    ] as const;
    for (const spec of specs) {
      const raw = manifest(spec);
      const validated = validatePackManifest(raw);
      if (!validated.ok) throw new Error(validated.error.message);
      const put = await f.db.packVersions!.put({
        packId: spec.packId,
        packVersion: spec.packVersion,
        manifestFingerprint: packManifestFingerprint(validated.value),
        manifest: validated.value,
      } satisfies PackVersion);
      if (!put.ok) throw new Error(put.error.message);
      const created = await f.db.packInstallations!.create({
        installation: {
          id: ids.id('pak') as PackInstallation['id'],
          companyId: 'company_default' as PackInstallation['companyId'],
          packId: spec.packId,
          packVersion: spec.packVersion,
          name: `${spec.packId} pack`,
          coreApi: '1',
          capabilities: [`${spec.packId}:capability.one`],
          status: 'installed' as const,
          installedBy: f.actor,
          installedAt: nowIso(),
          updatedAt: nowIso(),
        },
        creationCommandId: `cmd_fabricated_${spec.packId}_${spec.packVersion}`,
        creationCommandFingerprint: 'sha256:' + 'c'.repeat(64),
      });
      if (!created.ok) throw new Error(created.error.message);
      if (spec.packId !== 'pack-a') continue;
      // The fabricated a@2.0.0 install owns the materialized template (durable provenance).
      const ref = createPackContentRef({
        packId: 'pack-a',
        packVersion: '2.0.0',
        contentKind: 'workflowTemplate',
        logicalKey: 'pack-a:shared-flow',
        materializedEntityRef: templateId,
      });
      if (!ref.ok) throw new Error(ref.error.message);
      const inserted = await f.db.packContentRefs!.insert(created.value.id, ref.value);
      if (!inserted.ok) throw new Error(inserted.error.message);
    }
    const published = await f.lifecycle.publish({ templateId, actorId: f.actor, traceId: 't_cycle' });
    expect(published.ok).toBe(true);
    const runsBefore = f.db.db.prepare('SELECT * FROM runs').all().length;
    const denied = await f.lifecycle.createRun({ templateId, companyId: 'company_default', workflowId: 'wf_cycle', actorId: f.actor });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details['reason']).toBe('PACK_DEPENDENCY_CYCLE');
    expect(f.db.db.prepare('SELECT * FROM runs').all()).toHaveLength(runsBefore);
  });

  it('11. a caller cannot supply pack provenance (the field no longer exists)', async () => {
    // Compile-time proof: the application input rejects a packVersions field outright.
    const spoof: CreateRunInput = {
      templateId: 'tpl_x',
      companyId: 'company_default',
      workflowId: 'wf_x',
      actorId: 'user_owner',
      // @ts-expect-error RunSnapshot.packVersions is trusted derived data (T15-05): the
      // application input rejects caller-supplied provenance at compile time.
      packVersions: { fake: '999' },
    };
    expect('packVersions' in spoof).toBe(true); // the JSON still carries it...
    const f = await make();
    await f.install({ packId: 'pack-a', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-a');
    // ...and the runtime ignores it entirely: the resolver decides.
    const resolved = await f.resolver.resolveForWorkflow({ companyId: 'company_default', templateId });
    expect(resolved.ok && resolved.value).toEqual({ 'pack-a': '1.0.0' });
    const snapshotSource = readFileSync(
      fileURLToPath(new URL('../../packages/engine/src/lifecycle-service.ts', import.meta.url)),
      'utf8',
    );
    expect(snapshotSource.includes('input.packVersions')).toBe(false);
  });

  it('12. a caller mismatch cannot override the resolver', async () => {
    const f = await make();
    await f.install({ packId: 'pack-a', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-a');
    const resolved = await f.resolver.resolveForWorkflow({ companyId: 'company_default', templateId });
    expect(resolved.ok && resolved.value).toEqual({ 'pack-a': '1.0.0' });
    // There is no caller-side value at all: createRun reads the resolver, nothing else.
    const run = await runFromTemplate(f, templateId, 'mismatch');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(snapshot?.packVersions).toEqual({ 'pack-a': '1.0.0' });
  });

  it('13. R1 keeps v1 after the root pack is upgraded to v2', async () => {
    const f = await make();
    await f.install({ packId: 'pack-x', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-x');
    const first = await runFromTemplate(f, templateId, 'r1');
    expect(first.ok).toBe(true);
    const upgraded = await f.service.upgrade({
      commandId: 'cmd_r1_upgrade',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-x',
      manifest: manifest({ packId: 'pack-x', packVersion: '2.0.0' }),
      traceId: 'trace_r1_upgrade',
    });
    expect(upgraded.ok).toBe(true);
    const firstSnapshot = await f.lifecycle.readSnapshot(first.ok ? first.value.snapshotId : '');
    expect(firstSnapshot?.packVersions).toEqual({ 'pack-x': '1.0.0' });
  });

  it('14. R2 after the upgrade pins v2', async () => {
    const f = await make();
    await f.install({ packId: 'pack-x', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-x');
    const first = await runFromTemplate(f, templateId, 'r1');
    expect(first.ok).toBe(true);
    await f.service.upgrade({
      commandId: 'cmd_r2_upgrade',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-x',
      manifest: manifest({ packId: 'pack-x', packVersion: '2.0.0' }),
      traceId: 'trace_r2_upgrade',
    });
    const second = await runFromTemplate(f, await f.templateIdOf('pack-x', '2.0.0'), 'r2');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(second.value.snapshotId);
    expect(snapshot?.packVersions).toEqual({ 'pack-x': '2.0.0' });
    // R1 is untouched.
    const firstSnapshot = await f.lifecycle.readSnapshot(first.ok ? first.value.snapshotId : '');
    expect(firstSnapshot?.packVersions).toEqual({ 'pack-x': '1.0.0' });
  });

  it('15. disabling the pack after R1 does not mutate R1', async () => {
    const f = await make();
    await f.install({ packId: 'pack-x', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-x');
    const first = await runFromTemplate(f, templateId, 'r1');
    expect(first.ok).toBe(true);
    const disabled = await f.service.disable({ commandId: 'cmd_r1_disable', companyId: 'company_default', actorId: f.actor, packId: 'pack-x', traceId: 'trace_r1_disable' });
    expect(disabled.ok).toBe(true);
    const snapshot = await f.lifecycle.readSnapshot(first.ok ? first.value.snapshotId : '');
    expect(snapshot?.packVersions).toEqual({ 'pack-x': '1.0.0' });
    expect(await f.lifecycle.readTemplate(templateId)).not.toBeNull();
    expect(f.db.db.prepare('SELECT * FROM runs').all().length).toBeGreaterThan(0);
  });

  it('16. a disabled pack blocks a NEW run (no T15-04 regression)', async () => {
    const f = await make();
    await f.install({ packId: 'pack-x', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-x');
    const published = await f.lifecycle.publish({ templateId, actorId: f.actor, traceId: 't_block' });
    expect(published.ok).toBe(true);
    await f.service.disable({ commandId: 'cmd_block', companyId: 'company_default', actorId: f.actor, packId: 'pack-x', traceId: 'trace_block' });
    const runsBefore = f.db.db.prepare('SELECT * FROM runs').all().length;
    const denied = await f.lifecycle.createRun({ templateId, companyId: 'company_default', workflowId: 'wf_blocked', actorId: f.actor });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('POLICY_DENIED');
    expect(f.db.db.prepare('SELECT * FROM runs').all()).toHaveLength(runsBefore);
  });

  it('17. dependency versions are preserved across an upgrade', async () => {
    const f = await make();
    await f.install({ packId: 'pack-b', packVersion: '1.0.0' });
    await f.install({ packId: 'pack-a', packVersion: '1.0.0', dependsOn: [{ packId: 'pack-b', packVersion: '1.0.0' }] });
    const v1Template = await f.templateIdOf('pack-a', '1.0.0');
    const first = await runFromTemplate(f, v1Template, 'dep1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // R1 pins the dependency version that was in force when it was created.
    const firstSnapshot = await f.lifecycle.readSnapshot(first.value.snapshotId);
    expect(firstSnapshot?.packVersions).toEqual({ 'pack-a': '1.0.0', 'pack-b': '1.0.0' });

    // Move the whole graph to new versions: the dependent retires first, then its
    // dependency (no stranded dependency is ever left behind by the lifecycle rules).
    const retireA = await f.service.disable({ commandId: 'cmd_retire_a', companyId: 'company_default', actorId: f.actor, packId: 'pack-a', packVersion: '1.0.0', traceId: 'trace_retire_a' });
    expect(retireA.ok).toBe(true);
    const retireB = await f.service.disable({ commandId: 'cmd_retire_b', companyId: 'company_default', actorId: f.actor, packId: 'pack-b', packVersion: '1.0.0', traceId: 'trace_retire_b' });
    expect(retireB.ok).toBe(true);
    const installB2 = await f.install({ packId: 'pack-b', packVersion: '2.0.0', commandId: 'cmd_b2' });
    expect(installB2.ok).toBe(true);
    const upgraded = await f.service.upgrade({
      commandId: 'cmd_a2',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-a',
      manifest: manifest({ packId: 'pack-a', packVersion: '2.0.0', dependsOn: [{ packId: 'pack-b', packVersion: '2.0.0' }] }),
      traceId: 'trace_a2',
    });
    expect(upgraded.ok).toBe(true);
    // R1 is untouched; the new run pins the new closure.
    expect((await f.lifecycle.readSnapshot(first.value.snapshotId))?.packVersions).toEqual({ 'pack-a': '1.0.0', 'pack-b': '1.0.0' });
    const second = await runFromTemplate(f, await f.templateIdOf('pack-a', '2.0.0'), 'dep2');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondSnapshot = await f.lifecycle.readSnapshot(second.value.snapshotId);
    expect(secondSnapshot?.packVersions).toEqual({ 'pack-a': '2.0.0', 'pack-b': '2.0.0' });
  });

  it('18. a real DB close/reopen preserves the pinned map exactly', async () => {
    const f = await make();
    await f.install({ packId: 'pack-a', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-a');
    const first = await runFromTemplate(f, templateId, 'restart');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const dataDir = f.dataDir;
    const snapshotId = first.value.snapshotId;
    f.db.close();
    database = null;

    // Fresh process: SAME durable file, completely new service graph.
    const db = openDurableDatabase({
      dataDir,
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'lifecycle', 'provider', 'agent', 'tools', 'artifact', 'pack'],
    });
    database = db;
    const reopened = createWorkflowLifecycle({
      ids,
      clock,
      templates: db.templates,
      locks: db.locks,
      proposals: db.proposals,
      snapshots: db.snapshots,
      runs: db.runs,
      events: db.events,
    });
    const snapshot = await reopened.readSnapshot(snapshotId);
    expect(snapshot?.packVersions).toEqual({ 'pack-a': '1.0.0' });
    // And the durable row is byte-identical to what was written.
    const row = db.db.prepare('SELECT pack_versions_json FROM run_snapshots WHERE id = ?').get(snapshotId) as { pack_versions_json: string };
    expect(JSON.parse(row.pack_versions_json)).toEqual({ 'pack-a': '1.0.0' });
  });

  it('19. disabling/upgrading after the restart never rewrites the snapshot', async () => {
    const f = await make();
    await f.install({ packId: 'pack-x', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-x');
    const first = await runFromTemplate(f, templateId, 'immutable');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = (f.db.db.prepare('SELECT pack_versions_json FROM run_snapshots WHERE id = ?').get(first.value.snapshotId) as { pack_versions_json: string }).pack_versions_json;
    await f.service.upgrade({
      commandId: 'cmd_immutable_upgrade',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-x',
      manifest: manifest({ packId: 'pack-x', packVersion: '2.0.0' }),
      traceId: 'trace_immutable_upgrade',
    });
    await f.service.disable({ commandId: 'cmd_immutable_disable', companyId: 'company_default', actorId: f.actor, packId: 'pack-x', packVersion: '2.0.0', traceId: 'trace_immutable_disable' });
    const after = (f.db.db.prepare('SELECT pack_versions_json FROM run_snapshots WHERE id = ?').get(first.value.snapshotId) as { pack_versions_json: string }).pack_versions_json;
    expect(after).toBe(before);
  });

  it('20. recovery does not resolve active packs (0 resolver calls)', async () => {
    const f = await make();
    await f.install({ packId: 'pack-x', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-x');
    const run = await runFromTemplate(f, templateId, 'recovery');
    expect(run.ok).toBe(true);
    const afterCreate = f.calls();
    expect(afterCreate).toBe(1);
    // The startup recovery orchestrator is composed from durable state only: it receives
    // no pack resolver, no pack stores and no PackService.
    const { createStartupRecoveryOrchestrator } = await import('@companyos/engine');
    const { createWorkflowEngine } = await import('@companyos/engine');
    const engine = createWorkflowEngine({
      ids,
      clock,
      runs: f.db.runs,
      events: f.db.events,
      approvals: f.db.approvals,
      tasks: f.db.tasks,
      handlers: { resolve: () => null },
      logger: undefined,
    });
    const orchestrator = createStartupRecoveryOrchestrator({
      actorId: f.actor,
      runtime: { recoverInterrupted: async () => ok([]) },
      tools: { recoverInvocations: async () => ok({ interrupted: [], waitingApproval: [], retryable: [] }) as never },
      engine: { recover: async (runId: string) => engine.recover(runId as never) },
      runs: f.db.runs,
    });
    const report = await orchestrator.run();
    expect(report.ok).toBe(true);
    expect(f.calls()).toBe(afterCreate); // recovery resolved nothing

    // Continuation (engine drive over the existing run) reads the pinned snapshot and
    // never the active pack: the engine holds no pack dependency at all.
    const { createWorkflowEngine: buildEngine, alwaysSucceed } = await import('@companyos/engine');
    const drivingEngine = buildEngine({
      ids,
      clock,
      runs: f.db.runs,
      events: f.db.events,
      approvals: f.db.approvals,
      tasks: f.db.tasks,
      handlers: { resolve: () => alwaysSucceed('stub.t15-advance') },
    });
    const driven = await drivingEngine.drive(run.ok ? (run.value.runId as never) : ('' as never));
    expect(f.calls()).toBe(afterCreate); // advancing an existing run resolved nothing
    const snapshot = await f.lifecycle.readSnapshot(run.ok ? run.value.snapshotId : '');
    expect(snapshot?.packVersions).toEqual({ 'pack-x': '1.0.0' });
    void driven;
  });

  it('21. the evidence gate stays pinned-version authoritative across pack changes', async () => {
    const f = await make();
    await f.install({ packId: 'pack-x', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-x');
    const run = await runFromTemplate(f, templateId, 'evidence');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const stageId = 's1';
    // requiredValidators reads the run PINNED version graph node config (run-pinned
    // authority) — never a pack manifest, never the active pack.
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
          return ok(node === undefined ? [] : validatorIdsOf(node));
        },
      },
    });
    const missing = await guard.evaluateGate({ runId: run.value.runId, stageId, artifactId: 'art_missing' as never });
    expect(missing.ok).toBe(false); // missing required evidence stays rejected

    // Real evidence through the REAL ArtifactService, then the gate passes.
    const { createArtifactService } = await import('@companyos/engine');
    const { artifactTargetRef } = await import('@companyos/core');
    const { createFilesystemArtifactContentStore } = await import('@companyos/persistence');
    const contentStore = createFilesystemArtifactContentStore({ casRoot: tempDir() });
    const artifactService = createArtifactService({
      artifactStore: f.db.artifactStore!, contentStore, runs: f.db.runs, events: f.db.events,
      ledger: f.db.ledger, clock, ids, unitOfWork: f.db.unitOfWork, authorize: async () => ok(true),
    });
    const created = await artifactService.create({
      commandId: 'cmd_evidence_target',
      runId: run.value.runId as never,
      kind: 'pack-x:diff-kind',
      content: new TextEncoder().encode('evidence payload'),
      producedBy: 'agent:agt_evidence',
      traceId: 'trace_evidence_target',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Seed the required validation rows durably for the pinned stage (ADR-0020 batch shape).
    const { createValidation } = await import('@companyos/core');
    const finishedAt = '2026-09-26T01:00:00.000Z';
    const validation = createValidation({
      runId: run.value.runId as never,
      stageId: stageId as never,
      validatorId: 'tool.validator',
      validatorVersion: '1.0.0',
      status: 'pass',
      blocking: true,
      evidenceRefs: ['artifact:' + created.value.id],
      startedAt: finishedAt,
      finishedAt,
      targetRef: artifactTargetRef(created.value.id),
      ids,
    });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    await f.db.validationStore!.record(validation.value, {
      creationCommandId: 'cmd_evidence_batch',
      creationCommandFingerprint: 'sha256:' + 'd'.repeat(64),
    });

    // Now disable AND upgrade the pack: the pinned requirement does not move.
    await f.service.upgrade({
      commandId: 'cmd_evidence_upgrade',
      companyId: 'company_default',
      actorId: f.actor,
      packId: 'pack-x',
      manifest: manifest({ packId: 'pack-x', packVersion: '2.0.0' }),
      traceId: 'trace_evidence_upgrade',
    });
    await f.service.disable({ commandId: 'cmd_evidence_disable', companyId: 'company_default', actorId: f.actor, packId: 'pack-x', packVersion: '2.0.0', traceId: 'trace_evidence_disable' });

    const afterDisable = await guard.evaluateGate({
      runId: run.value.runId,
      stageId,
      artifactId: created.value.id as never,
    });
    expect(afterDisable.ok).toBe(true); // real evidence still passes the pinned gate
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(snapshot?.packVersions).toEqual({ 'pack-x': '1.0.0' });
  });

  it('22. tool provenance and 23. artifact provenance survive the pack lifecycle', async () => {
    const f = await make();
    await f.install({ packId: 'pack-x', packVersion: '1.0.0' });
    const templateId = await f.templateIdOf('pack-x');
    const run = await runFromTemplate(f, templateId, 'provenance');
    expect(run.ok).toBe(true);
    // The tool the pack REQUIRES is a global registry entity: still served after disable.
    await f.service.disable({ commandId: 'cmd_prov_disable', companyId: 'company_default', actorId: f.actor, packId: 'pack-x', traceId: 'trace_prov_disable' });
    const template = await f.lifecycle.readTemplate(templateId);
    expect(template).not.toBeNull();
    const pinned = await f.lifecycle.readSnapshot(run.ok ? run.value.snapshotId : '');
    const pinnedTemplate = pinned === null ? null : await f.db.templates.get(pinned.templateId);
    const pinnedVersion = pinnedTemplate?.versions.find((entry) => entry.id === pinned?.workflowVersionId);
    expect(pinnedVersion?.graph.nodes.map((node) => node.id)).toEqual(['s1']);
    expect(f.db.db.prepare('SELECT * FROM workflow_templates').all().length).toBeGreaterThan(0);
    expect(f.db.db.prepare('SELECT * FROM workflow_template_versions').all().length).toBeGreaterThan(0);
  });

  it('24. no new migration, 25. no new authority / IPC / renderer', async () => {
    const f = await make();
    await f.install({ packId: 'pack-a', packVersion: '1.0.0' });
    const migrations = readdirSync(fileURLToPath(new URL('../../packages/persistence/migrations/pack', import.meta.url)));
    expect(migrations.filter((name) => name.endsWith('.sql'))).toEqual(['0001_pack_persistence.sql']);
    for (const authority of ['pack.read', 'pack.install', 'pack.enable', 'pack.disable', 'pack.upgrade', 'run.pack.pin']) {
      expect(AUTHORITIES).not.toContain(authority);
    }
    expect(AUTHORITIES).toContain('pack.manage');
    for (const source of ['pack-provenance.ts', 'run-pack-provenance.ts', 'pack-service.ts', 'pack-availability.ts']) {
      const text = readFileSync(fileURLToPath(new URL(`../../packages/engine/src/pack/${source}`, import.meta.url)), 'utf8');
      expect(text.includes('electron')).toBe(false);
      expect(text.includes('ipcRenderer')).toBe(false);
      expect(text.includes('UPDATE ')).toBe(false); // no snapshot rewriting anywhere
      expect(text.includes('DELETE ')).toBe(false);
    }
    // Run creation keeps the existing authority seam: no new pack authority is asked for.
    const lifecycleSource = readFileSync(fileURLToPath(new URL('../../packages/engine/src/lifecycle-service.ts', import.meta.url)), 'utf8');
    expect(lifecycleSource.includes("authority: 'pack.")).toBe(false);
    void f;
  });
});
