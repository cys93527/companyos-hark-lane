/**
 * Sprint 16 / Task-16-05 — DevCompany Pack framework integration & model-binding validation.
 *
 * The real product manifest goes through the REAL Sprint 15 pack framework: real SQLite +
 * pack migrations + real authorization + real UnitOfWork/EventStore + real Pack stores +
 * real WorkflowLifecycle + real availability policy + real run provenance resolver. Only the
 * Sprint 17 runtime providers are test fixtures (a controlled tool/validator registry that
 * exists purely to satisfy the pack preflight — no shell command is ever executed), and the
 * model layer is the REAL Model Registry + real Router: bindings are resolved through
 * `deriveRouterPolicyView` + `applyHardFilters` + `router.recommend`, never hand-assembled.
 *
 * The test harness is the "trusted application binding coordinator": it reads
 * DEVCOMPANY_MODEL_POLICY, resolves each stage through the existing binding APIs, and feeds
 * the resolved bindings into the existing createRun path. It is NOT a production runtime
 * consumer — the product package stays inert and no generic framework code changes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TOOL_CAPABILITY_VALIDATOR,
  createToolRecord,
  ok,
  packManifestFingerprint,
  type DomainError,
  type ModelRecord,
  type Result,
  type RouterRequest,
} from '@companyos/core';
import {
  applyHardFilters,
  assertDerivedPolicyView,
  deriveRouterPolicyView,
} from '@companyos/core';
import {
  createAuthorizationService,
  createDeterministicModelRouter,
  createMockProvider,
  createModelRegistry,
  createPackAvailabilityPolicy,
  createPackService,
  createProviderRegistry,
  createRunPackProvenanceResolver,
  createToolRegistry,
  createWorkflowLifecycle,
  ensureBootstrapOwner,
  registryRevisionOf,
  type ToolRequirementResolver,
  type WorkflowLifecycle,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import {
  DEVCOMPANY_MANIFEST,
  DEVCOMPANY_MODEL_POLICY,
  DEVCOMPANY_PACK_ID,
  DEVCOMPANY_PACK_VERSION,
} from '@companyos/pack-dev-company';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t16int-'));
  created.push(dir);
  return dir;
};
let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_16N${String(++seq).padStart(12, '0')}`,
  ulid: () => `16N${String(++seq).padStart(23, '0')}`,
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

/** The six Sprint 17 tool identities + the validator tool the manifest requires. */
const REQUIRED_TOOL_IDS = [
  'repo.test-runner',
  'repo.linter',
  'repo.typechecker',
  'repo.builder',
  'repo.git',
  'repo.validation-evidence',
] as const;

interface Fixture {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly service: ReturnType<typeof createPackService>;
  readonly lifecycle: WorkflowLifecycle;
  readonly models: ReturnType<typeof createModelRegistry>;
  readonly actor: string;
  /** Resolve a stage's required capability through the REAL router + registry. */
  readonly resolveBinding: (stage: 'developer' | 'reviewer') => Promise<Result<string, DomainError>>;
}

const make = async (): Promise<Fixture> => {
  const dataDir = tempDir();
  const db = openDurableDatabase({
    dataDir,
    appliedAt: nowIso(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'],
  });
  database = db;
  const actor = 'user_owner';
  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);

  // --- controlled TEST tool registry (Sprint 17 providers do not exist yet) -------------
  const registry = createToolRegistry({
    ids,
    clock,
    records: db.toolRecords,
    invocations: db.toolInvocations,
    invocationArtifacts: db.toolInvocationArtifacts,
    adapters: new Map(), // no adapter is ever bound: nothing executes
    authorize: async () => ok(true),
    events: db.events,
    secrets: async () => [],
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
  });
  for (const toolId of REQUIRED_TOOL_IDS) {
    const record = createToolRecord({
      toolId,
      name: toolId,
      description: 'Sprint 17 future provider (test fixture only)',
      version: '1.0.0',
      capabilities: toolId === 'repo.validation-evidence' ? [TOOL_CAPABILITY_VALIDATOR] : [],
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

  // --- the real pack framework, wired exactly like production ---------------------------
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
  const packProvenance = createRunPackProvenanceResolver({
    packInstallations: db.packInstallations!,
    packContentRefs: db.packContentRefs!,
    packVersions: db.packVersions!,
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

  // --- the REAL model layer: registry + deterministic router ----------------------------
  const providers = createProviderRegistry({
    ids,
    clock,
    registrations: db.providers,
    models: db.providerModels,
    authorize: async () => ok(true),
    events: db.events,
    systemActor: actor,
  });
  const mockProvider = createMockProvider({
    providerId: 'mock.test',
    kind: 'mock',
    displayName: 'Test provider',
    script: {
      models: [
        {
          modelId: 'test-model-a',
          displayName: 'Test Model A',
          contextWindow: 8_000,
          maxOutputTokens: 1_000,
          capabilities: { streaming: true, structuredOutput: true, toolCalling: true, reasoning: false, vision: false, audio: false },
          pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'CREDIT' },
        },
        {
          modelId: 'test-model-b',
          displayName: 'Test Model B',
          contextWindow: 8_000,
          maxOutputTokens: 1_000,
          capabilities: { streaming: true, structuredOutput: true, toolCalling: false, reasoning: true, vision: false, audio: false },
          pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'CREDIT' },
        },
      ],
    },
  });
  const registeredProvider = await providers.register(mockProvider);
  if (!registeredProvider.ok) throw new Error(registeredProvider.error.message);
  const models = createModelRegistry({
    ids,
    clock,
    records: db.modelRecords,
    aliases: db.modelAliases,
    providers,
    authorize: async () => ok(true),
    events: db.events,
    scope: 'default',
  });
  for (const providerModelId of ['test-model-a', 'test-model-b']) {
    const registered = await models.registerFromProvider({ providerId: 'mock.test', providerModelId, actorId: actor });
    if (!registered.ok) throw new Error(registered.error.message);
  }
  // Built AFTER the registry so the lifecycle can carry the T18-02 binding seam: run-pinned
  // model bindings are verified against the real registry before any run is created.
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
    packProvenance,
    // T18-02: pinned model bindings are verified against the real registry.
    modelRegistry: models,
  });
  // A registry snapshot the router can read synchronously for provenance.
  let registrySnapshot: readonly ModelRecord[] = [];
  const refreshRegistrySnapshot = async (): Promise<void> => {
    registrySnapshot = await models.list({ includeDisabled: true });
  };
  await refreshRegistrySnapshot();
  const router = createDeterministicModelRouter({
    ids: { next: (prefix: string) => ids.id(prefix) },
    clock,
    audit: {
      requested: async () => undefined,
      candidatesBuilt: async () => undefined,
      recommendationCreated: async () => undefined,
      noCandidate: async () => undefined,
      overrideRequested: async () => undefined,
      overrideConfirmed: async () => undefined,
    },
    modelRegistryRevision: () => registryRevisionOf(registrySnapshot),
  });

  /**
   * The trusted-binding-coordinator step: take the PRODUCT policy's required capability,
   * derive the real policy view, run the REAL router over the REAL registry and return the
   * selected model key. Nothing about the model choice is hand-assembled.
   */
  const resolveBinding = async (stage: 'developer' | 'reviewer'): Promise<Result<string, DomainError>> => {
    const requirement = DEVCOMPANY_MODEL_POLICY[stage].requiredLogicalCapabilities;
    const view = deriveRouterPolicyView({ policy: null, requiredCapabilities: [...requirement], generatedAt: nowIso() });
    const asserted = assertDerivedPolicyView(view);
    if (!asserted.ok) return asserted;
    const listed = await models.list({ includeDisabled: true });
    const request: RouterRequest = {
      requestId: ids.id('req'),
      companyId: 'company_default',
      taskId: ids.id('tsk'),
      roleId: `dev-company:${stage}`,
      selectionMode: 'AUTO',
      policyView: view,
      estimatedInputTokens: 1_000,
      requiredOutputTokens: 500,
      candidateModels: listed,
      traceId: `trace_bind_${stage}`,
    };
    const filtered = applyHardFilters(request);
    if (!filtered.ok) return filtered;
    const recommended = await router.recommend(request);
    if (!recommended.ok) return recommended as never;
    const selected = recommended.value.selectedModelKey;
    if (selected === null) {
      return { ok: false, error: new (await import('@companyos/core')).DomainError('POLICY_DENIED', 'no eligible model for the required capability') };
    }
    return ok(selected);
  };

  return { db, dataDir, service, lifecycle, models, actor, resolveBinding };
};

/** Publish the materialized DevCompany template and start a real Run. */
const runFromDevCompany = async (
  f: Fixture,
  label: string,
  bindings: Readonly<Record<string, string>>,
): Promise<Result<{ readonly runId: string; readonly snapshotId: string }, DomainError>> => {
  const installations = await f.db.packInstallations!.listByCompany('company_default');
  if (!installations.ok) return installations;
  const installation = installations.value.find((row) => row.packId === DEVCOMPANY_PACK_ID);
  if (installation === undefined) return { ok: false, error: new (await import('@companyos/core')).DomainError('NOT_FOUND', 'no installation') };
  const refs = await f.db.packContentRefs!.listByInstallation(installation.id);
  if (!refs.ok) return refs;
  const templateRef = refs.value.find((ref) => ref.contentKind === 'workflowTemplate');
  const templateId = templateRef?.materializedEntityRef;
  if (templateId === null || templateId === undefined) {
    return { ok: false, error: new (await import('@companyos/core')).DomainError('NOT_FOUND', 'no materialized template') };
  }
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
    modelBindings: bindings,
  });
  if (!run.ok) return run;
  return ok({ runId: run.value.run.id, snapshotId: run.value.snapshot.id });
};

describe('DevCompany framework integration (Sprint 15 pack framework)', () => {
  it('1/2. installs the real manifest with a controlled test registry and the frozen identity', async () => {
    const f = await make();
    const installed = await f.service.install({
      commandId: 'cmd_devcompany_install',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_devcompany_install',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(installed.value.packId).toBe(DEVCOMPANY_PACK_ID);
    expect(installed.value.packVersion).toBe(DEVCOMPANY_PACK_VERSION);
    expect(installed.value.companyId).toBe('company_default');
    expect(installed.value.status).toBe('installed');
    // The fingerprint matches the canonical product-manifest fingerprint.
    const stored = await f.db.packVersions!.get(DEVCOMPANY_PACK_ID, DEVCOMPANY_PACK_VERSION);
    expect(stored.ok && stored.value?.manifestFingerprint).toBe(packManifestFingerprint(DEVCOMPANY_MANIFEST));
  });

  it('3/4/5. records 24 content refs: 6 materialized entities and 18 pack-native/requirement refs', async () => {
    const f = await make();
    const installed = await f.service.install({
      commandId: 'cmd_refs',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_refs',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const refs = await f.db.packContentRefs!.listByInstallation(installed.value.id);
    expect(refs.ok).toBe(true);
    if (!refs.ok) return;
    expect(refs.value).toHaveLength(24);
    const materialized = refs.value.filter((ref) => ref.materializedEntityRef !== null);
    const native = refs.value.filter((ref) => ref.materializedEntityRef === null);
    expect(materialized).toHaveLength(6); // 5 roles + 1 workflow template
    expect(native).toHaveLength(18); // 5 prompts + 6 tools + 1 validator + 5 artifacts + 1 risk rule
    const kinds = materialized.map((ref) => ref.contentKind).sort();
    expect(kinds).toEqual(['role', 'role', 'role', 'role', 'role', 'workflowTemplate']);
  });

  it('6/7. materializes the five roles through the real authorization service with no auto-assignment', async () => {
    const f = await make();
    const installed = await f.service.install({
      commandId: 'cmd_roles',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_roles',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const roles = (await f.db.roles.list({ limit: 500 })).items.filter((role) => role.companyId === 'company_default');
    const keys = roles.map((role) => role.key).sort();
    expect(keys).toEqual([
      'dev-company-cto',
      'dev-company-developer',
      'dev-company-documentation',
      'dev-company-qa',
      'dev-company-reviewer',
      'owner',
    ]);
    for (const role of roles.filter((entry) => entry.key !== 'owner')) {
      expect(role.authority.every((authority) => authority.length > 0)).toBe(true);
    }
    // Zero automatic assignments: the only assignment belongs to the bootstrap owner.
    const assignments = (await f.db.roleAssignments.list({ limit: 500 })).items;
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.actorId).toBe(f.actor);
  });

  it('8/9/42/43. materializes the workflow with full graph fidelity', async () => {
    const f = await make();
    const installed = await f.service.install({
      commandId: 'cmd_workflow',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_workflow',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const refs = await f.db.packContentRefs!.listByInstallation(installed.value.id);
    if (!refs.ok) return;
    const templateId = refs.value.find((ref) => ref.contentKind === 'workflowTemplate')!.materializedEntityRef!;
    const template = await f.lifecycle.readTemplate(templateId);
    expect(template).not.toBeNull();
    if (template === null) return;
    const version = template.versions[template.versions.length - 1]!;
    const manifestGraph = DEVCOMPANY_MANIFEST.declarations.workflowTemplates[0]!.graph;
    expect(version.graph.nodes.map((node) => node.id)).toEqual(manifestGraph.nodes.map((node) => node.id));
    expect(version.graph.edges).toEqual(manifestGraph.edges);
    const nodes: readonly { readonly id: string; readonly config: Readonly<Record<string, unknown>> }[] = version.graph.nodes;
    const sources: readonly { readonly id: string; readonly config: Readonly<Record<string, unknown>> }[] = manifestGraph.nodes;
    for (const node of nodes) {
      const source = sources.find((entry) => entry.id === node.id)!;
      expect(node.config['roleId']).toBe(source.config['roleId']);
      expect(node.config['riskLevel']).toBe(source.config['riskLevel']);
      expect(node.config['approval']).toEqual(source.config['approval']);
      expect(node.config['validatorIds']).toEqual(source.config['validatorIds']);
    }
    // The QA stage keeps its validator requirement in the materialized version.
    const qa = version.graph.nodes.find((node) => node.id === 'qa')!;
    expect((qa.config as { validatorIds?: readonly string[] }).validatorIds).toEqual(['repo.validation-evidence']);
  });

  it('10/11/12/46/47. installs no tool rows, no validator duplicates and no artifact instances', async () => {
    const f = await make();
    const toolsBefore = (await f.db.toolRecords.list({ limit: 500 })).items.length;
    const installed = await f.service.install({
      commandId: 'cmd_no_dup',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_no_dup',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const toolsAfter = (await f.db.toolRecords.list({ limit: 500 })).items;
    expect(toolsAfter).toHaveLength(toolsBefore); // the 6 test fixtures, nothing cloned
    expect(toolsAfter.filter((tool) => tool.toolId === 'repo.validation-evidence')).toHaveLength(1);
    expect(f.db.db.prepare('SELECT * FROM artifacts').all()).toHaveLength(0); // no artifact rows at install
  });

  it('13/22. new-use is allowed while installed (real subsystem entries)', async () => {
    const f = await make();
    const installed = await f.service.install({
      commandId: 'cmd_newuse',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_newuse',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const refs = await f.db.packContentRefs!.listByInstallation(installed.value.id);
    if (!refs.ok) return;
    const templateId = refs.value.find((ref) => ref.contentKind === 'workflowTemplate')!.materializedEntityRef!;
    // Real new-use entry, not a database peek.
    const published = await f.lifecycle.publish({ templateId, actorId: f.actor, traceId: 't_newuse' });
    expect(published.ok).toBe(true);
    // A pack role can be assigned to a new member while installed.
    const roleId = refs.value.find((ref) => ref.contentKind === 'role')!.materializedEntityRef!;
    const authz = createAuthorizationService({ ids, clock, roles: f.db.roles, assignments: f.db.roleAssignments, packAvailability: createPackAvailabilityPolicy({ packInstallations: f.db.packInstallations!, packContentRefs: f.db.packContentRefs! }) });
    const assigned = await authz.assign({ actorId: 'user_new_member', roleId, assignedBy: 'system:test' });
    expect(assigned.ok).toBe(true);
  });

  it('14/15/25. creates a real Run whose snapshot pins {dev-company: 1.0.0} and nothing else', async () => {
    const f = await make();
    const installed = await f.service.install({
      commandId: 'cmd_run',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_run',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const run = await runFromDevCompany(f, 'devcompany', {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(snapshot?.packVersions).toEqual({ 'dev-company': '1.0.0' });
    // The caller supplied no provenance: the resolver derived it.
    expect(snapshot?.packVersions).not.toContain('repo.test-runner');
  });

  it('16/17/18/19/26/27/28. resolves the model policy through the real Router and pins the bindings', async () => {
    const f = await make();
    const installed = await f.service.install({
      commandId: 'cmd_binding',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_binding',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    const developer = await f.resolveBinding('developer');
    expect(developer.ok).toBe(true);
    if (!developer.ok) return;
    const reviewer = await f.resolveBinding('reviewer');
    expect(reviewer.ok).toBe(true);
    if (!reviewer.ok) return;

    // Each binding really satisfies its stage requirement (through the real registry).
    const developerProfile = await f.models.capabilityProfile(developer.value);
    const reviewerProfile = await f.models.capabilityProfile(reviewer.value);
    expect(developerProfile.ok && developerProfile.value?.toolCalling).toBe(true);
    expect(reviewerProfile.ok && reviewerProfile.value?.reasoning).toBe(true);

    // AC16.2 core evidence: different model identities.
    expect(developer.value).not.toBe(reviewer.value);

    const run = await runFromDevCompany(f, 'bound', { developer: developer.value, reviewer: reviewer.value });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(snapshot?.modelBindings).toEqual({ developer: developer.value, reviewer: reviewer.value });

    // The bindings are frozen: an unrelated registry change does not re-resolve them.
    const before = JSON.stringify(snapshot?.modelBindings);
    const unregistered = await f.models.unregister(developer.value, f.actor);
    expect(unregistered.ok).toBe(true);
    const after = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(JSON.stringify(after?.modelBindings)).toBe(before);
    expect(JSON.stringify(after?.packVersions)).toBe(JSON.stringify({ 'dev-company': '1.0.0' }));
  });

  it('20/29. the model policy is absent from the PackManifest', async () => {
    const serialized = JSON.stringify(DEVCOMPANY_MANIFEST);
    expect(serialized).not.toContain('reviewerMustDifferFromDeveloper');
    expect(serialized).not.toContain('requiredLogicalCapabilities');
    expect(DEVCOMPANY_MANIFEST).not.toHaveProperty('modelPolicy');
  });

  it('21/48/49. the pack events carry only the whitelisted payload', async () => {
    const f = await make();
    await f.service.install({
      commandId: 'cmd_events',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_events',
    });
    const packEvents = (await f.db.events.all()).filter((entry) => entry.event.type.startsWith('pack.'));
    expect(packEvents.map((entry) => entry.event.type)).toEqual(['pack.installed']);
    const payload = JSON.stringify(packEvents[0]!.event.payload);
    const leakTokens = ['Summarize the input', 'delivery-cycle', 'toolCalling', 'reviewerMustDifferFromDeveloper', 'repo.test-runner', 'authorities'];
    for (const forbidden of leakTokens) {
      expect(payload).not.toContain(forbidden);
    }
  });

  it('22/23/33/34. disable blocks new Runs while the existing Run keeps everything', async () => {
    const f = await make();
    const installed = await f.service.install({
      commandId: 'cmd_disable',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_disable',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const developer = await f.resolveBinding('developer');
    if (!developer.ok) return;
    const run = await runFromDevCompany(f, 'before_disable', { developer: developer.value });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshotBefore = await f.lifecycle.readSnapshot(run.value.snapshotId);

    const disabled = await f.service.disable({
      commandId: 'cmd_disable_pack',
      companyId: 'company_default',
      actorId: f.actor,
      packId: DEVCOMPANY_PACK_ID,
      traceId: 'trace_disable_pack',
    });
    expect(disabled.ok).toBe(true);

    // New Run denied through the real subsystem entry.
    const denied = await runFromDevCompany(f, 'after_disable', { developer: developer.value });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('POLICY_DENIED');

    // The existing Run is untouched.
    const snapshotAfter = await f.lifecycle.readSnapshot(run.value.snapshotId);
    expect(snapshotAfter?.packVersions).toEqual({ 'dev-company': '1.0.0' });
    expect(JSON.stringify(snapshotAfter?.modelBindings)).toBe(JSON.stringify(snapshotBefore?.modelBindings));
    expect(f.db.db.prepare('SELECT * FROM workflow_templates').all().length).toBeGreaterThan(0);
  });

  it('24/35. re-enable restores new-use without re-materialization', async () => {
    const f = await make();
    const installed = await f.service.install({
      commandId: 'cmd_reenable',
      companyId: 'company_default',
      actorId: f.actor,
      manifest: DEVCOMPANY_MANIFEST,
      traceId: 'trace_reenable',
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const refsBefore = await f.db.packContentRefs!.listByInstallation(installed.value.id);
    const rolesBefore = (await f.db.roles.list({ limit: 500 })).items.length;
    await f.service.disable({ commandId: 'cmd_re_dis', companyId: 'company_default', actorId: f.actor, packId: DEVCOMPANY_PACK_ID, traceId: 'trace_re_dis' });
    const enabled = await f.service.enable({ commandId: 'cmd_re_en', companyId: 'company_default', actorId: f.actor, packId: DEVCOMPANY_PACK_ID, packVersion: DEVCOMPANY_PACK_VERSION, traceId: 'trace_re_en' });
    expect(enabled.ok).toBe(true);
    const refsAfter = await f.db.packContentRefs!.listByInstallation(installed.value.id);
    expect(refsAfter.ok && refsAfter.value).toHaveLength(refsBefore.ok ? refsBefore.value.length : 0);
    expect((await f.db.roles.list({ limit: 500 })).items).toHaveLength(rolesBefore);
    const run = await runFromDevCompany(f, 'reenabled', {});
    expect(run.ok).toBe(true);
    if (run.ok) {
      const snapshot = await f.lifecycle.readSnapshot(run.value.snapshotId);
      expect(snapshot?.packVersions).toEqual({ 'dev-company': '1.0.0' });
    }
  });

  it('25/50/51. a real reopen with a fresh service graph preserves installation, refs, Run and bindings', async () => {
    const dataDir = tempDir();
    const first = openDurableDatabase({
      dataDir,
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'],
    });
    database = first;
    const actor = 'user_owner';
    const authz = createAuthorizationService({ ids, clock, roles: first.roles, assignments: first.roleAssignments });
    const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);
    const registry = createToolRegistry({
      ids,
      clock,
      records: first.toolRecords,
      invocations: first.toolInvocations,
      invocationArtifacts: first.toolInvocationArtifacts,
      adapters: new Map(),
      authorize: async () => ok(true),
      events: first.events,
      secrets: async () => [],
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
    });
    for (const toolId of REQUIRED_TOOL_IDS) {
      const record = createToolRecord({
        toolId,
        name: toolId,
        description: 'test fixture',
        version: '1.0.0',
        capabilities: toolId === 'repo.validation-evidence' ? [TOOL_CAPABILITY_VALIDATOR] : [],
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
    const providers = createProviderRegistry({ ids, clock, registrations: first.providers, models: first.providerModels, authorize: async () => ok(true), events: first.events, systemActor: actor });
    const mockProvider = createMockProvider({
      providerId: 'mock.test',
      kind: 'mock',
      displayName: 'Test provider',
      script: {
        models: [
          { modelId: 'test-model-a', displayName: 'A', contextWindow: 8_000, maxOutputTokens: 1_000, capabilities: { streaming: true, structuredOutput: true, toolCalling: true, reasoning: false, vision: false, audio: false }, pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'CREDIT' } },
          { modelId: 'test-model-b', displayName: 'B', contextWindow: 8_000, maxOutputTokens: 1_000, capabilities: { streaming: true, structuredOutput: true, toolCalling: false, reasoning: true, vision: false, audio: false }, pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'CREDIT' } },
        ],
      },
    });
    const registeredProvider = await providers.register(mockProvider);
    if (!registeredProvider.ok) throw new Error(registeredProvider.error.message);
    const models = createModelRegistry({ ids, clock, records: first.modelRecords, aliases: first.modelAliases, providers, authorize: async () => ok(true), events: first.events, scope: 'default' });
    for (const providerModelId of ['test-model-a', 'test-model-b']) {
      // The pinned model key IS the registry key: the T18-02 seam verifies bindings against
      // the real registry, so a pinned key that no record owns must fail closed.
      const registered = await models.registerFromProvider({ providerId: 'mock.test', providerModelId, modelKey: providerModelId, actorId: actor });
      if (!registered.ok) throw new Error(registered.error.message);
    }
    // Built after the registry so the lifecycle can carry the T18-02 binding seam.
    const lifecycleA = createWorkflowLifecycle({
      ids, clock, templates: first.templates, locks: first.locks, proposals: first.proposals,
      snapshots: first.snapshots, runs: first.runs, events: first.events, unitOfWork: first.unitOfWork,
      packAvailability: createPackAvailabilityPolicy({ packInstallations: first.packInstallations!, packContentRefs: first.packContentRefs! }),
      packProvenance: createRunPackProvenanceResolver({ packInstallations: first.packInstallations!, packContentRefs: first.packContentRefs!, packVersions: first.packVersions! }),
      modelRegistry: models,
    });
    const service = createPackService({
      clock, ids, authorization: authz,
      lifecycle: createWorkflowLifecycle({ ids, clock, templates: first.templates, locks: first.locks, proposals: first.proposals, snapshots: first.snapshots, runs: first.runs, events: first.events, unitOfWork: first.unitOfWork }),
      packVersions: first.packVersions!, packInstallations: first.packInstallations!, packContentRefs: first.packContentRefs!,
      events: first.events, ledger: first.ledger, unitOfWork: first.unitOfWork, toolRequirementResolver: toolResolver,
    });
    const installed = await service.install({ commandId: 'cmd_restart', companyId: 'company_default', actorId: actor, manifest: DEVCOMPANY_MANIFEST, traceId: 'trace_restart' });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const refs = await first.packContentRefs!.listByInstallation(installed.value.id);
    if (!refs.ok) return;
    const templateId = refs.value.find((ref) => ref.contentKind === 'workflowTemplate')!.materializedEntityRef!;
    const published = await lifecycleA.publish({ templateId, actorId: actor, traceId: 't_restart' });
    if (!published.ok) return;
    const run = await lifecycleA.createRun({ templateId, companyId: 'company_default', workflowId: 'wf_restart', actorId: actor, modelBindings: { developer: 'test-model-a', reviewer: 'test-model-b' } });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshotId = run.value.snapshot.id;
    const packVersionsBefore = JSON.stringify(run.value.snapshot.packVersions);
    const bindingsBefore = JSON.stringify(run.value.snapshot.modelBindings);
    first.close();
    database = null;

    // Process B: the SAME durable file, a completely NEW object graph.
    const second = openDurableDatabase({
      dataDir,
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'],
    });
    database = second;
    const reopened = createWorkflowLifecycle({
      ids, clock, templates: second.templates, locks: second.locks, proposals: second.proposals,
      snapshots: second.snapshots, runs: second.runs, events: second.events,
    });
    const installations = await second.packInstallations!.listByCompany('company_default');
    expect(installations.ok).toBe(true);
    if (!installations.ok) return;
    expect(installations.value.some((row) => row.packId === DEVCOMPANY_PACK_ID && row.status === 'installed')).toBe(true);
    const snapshot = await reopened.readSnapshot(snapshotId);
    expect(JSON.stringify(snapshot?.packVersions)).toBe(packVersionsBefore);
    expect(JSON.stringify(snapshot?.modelBindings)).toBe(bindingsBefore);
    const reopenedRefs = await second.packContentRefs!.listByInstallation(installations.value[0]!.id);
    expect(reopenedRefs.ok && reopenedRefs.value.length).toBeGreaterThan(0);
  });

  it('26/53. a packless workflow still pins {} (the product policy is not a system default)', async () => {
    const f = await make();
    const template = await f.lifecycle.createTemplate({ orgId: 'company_default', name: 'Packless flow', actorId: f.actor, traceId: 't_packless' });
    expect(template.ok).toBe(true);
    if (!template.ok) return;
    const graph = { nodes: [{ id: 's1', kind: 'work' as const, title: 'Work', config: {} }], edges: [] };
    const drafted = await f.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: f.actor, traceId: 't_packless' });
    expect(drafted.ok).toBe(true);
    const published = await f.lifecycle.publish({ templateId: template.value.id, actorId: f.actor, traceId: 't_packless' });
    expect(published.ok).toBe(true);
    const run = await f.lifecycle.createRun({ templateId: template.value.id, companyId: 'company_default', workflowId: 'wf_packless', actorId: f.actor });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const snapshot = await f.lifecycle.readSnapshot(run.value.snapshot.id);
    expect(snapshot?.packVersions).toEqual({});
  });

  it('27/55/56. no generic production code carries a DevCompany special case', async () => {
    const search = async (dir: string): Promise<number> => {
      const { readdirSync, statSync, readFileSync } = await import('node:fs');
      const entries = readdirSync(dir);
      let hits = 0;
      for (const entry of entries) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) {
          if (entry === 'node_modules' || entry === 'dist') continue;
          hits += await search(full);
          continue;
        }
        if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
        const source = readFileSync(full, 'utf8');
        for (const needle of ['dev-company', 'CodeFleet', 'DEVCOMPANY_', '@companyos/pack-dev-company']) {
          if (source.includes(needle)) hits += 1;
        }
      }
      return hits;
    };
    for (const pkg of ['packages/core', 'packages/contracts', 'packages/engine', 'packages/persistence', 'apps/desktop']) {
      const root = await import('node:url');
      const dir = root.fileURLToPath(new URL(`../../${pkg}/src`, import.meta.url));
      expect(await search(dir), `${pkg} production sources must not name DevCompany`).toBe(0);
    }
  });

  it('28/38/39. adds no Sprint 17 runtime: no production tools, no execution, no auto-install', async () => {
    const f = await make();
    await f.service.install({ commandId: 'cmd_no_s17', companyId: 'company_default', actorId: f.actor, manifest: DEVCOMPANY_MANIFEST, traceId: 'trace_no_s17' });
    // The controlled tools exist only in this fixture's registry.
    const rows = (await f.db.toolRecords.list({ limit: 500 })).items;
    expect(rows.map((tool) => tool.toolId).sort()).toEqual([...REQUIRED_TOOL_IDS].sort());
    // No invocation was ever recorded: nothing executed.
    expect(f.db.db.prepare('SELECT * FROM tool_invocations').all()).toHaveLength(0);
    // The production composition does not know about the pack.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const main = readFileSync(fileURLToPath(new URL('../../apps/desktop/src/main.ts', import.meta.url)), 'utf8');
    expect(main).not.toContain('dev-company');
  });
});
