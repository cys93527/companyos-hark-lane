/**
 * Sprint 13 / Task-13-11: FULL PRODUCTION COMPOSITION wiring.
 *
 * The object graph under test IS the object graph main.ts runs: quiescent-startup CAS
 * reconciliation (openArtifactFoundation) → service composition over the ONE durable
 * database (composeSprint13Application). Electron itself is never imported; the
 * composition module is deliberately electron-free so these assertions cannot drift
 * from production.
 *
 * IPC BOUNDARY (Task-13-11 corrective): the Sprint 13 services are TRUSTED
 * MAIN-PROCESS capabilities. Every proof below calls them the way the trusted
 * application layer does — NEVER through renderer-facing IPC (no Sprint 13 operation
 * exists in the frozen IPC contract, and gate semantics like `blocking` must never
 * come from a caller). A dedicated boundary test locks that surface shut.
 *
 * Covered: startup happy/fatal/orphan, chain-missing fail-closed, evidence-gated
 * VALIDATION.PASS through the composed engine, run-FIXED stage policy, durable
 * reference resolution, active ARTIFACT memory provenance, real (non-allow-all)
 * authorization with zero writes on DENY, single-database/shared-transaction wiring
 * (CAS + row + event + ledger), and the no-IPC-surface guarantee.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTHORITIES,
  TOOL_CAPABILITY_VALIDATOR,
  createToolRecord,
  createWorkflowRun,
  decideAuthority,
  domainError,
  ok,
  artifactTargetRef,
  type ToolPort,
  type ToolResult,
  type WorkflowTemplate,
} from '@companyos/core';
import {
  createAuthorizationService,
  createToolRegistry,
  ensureBootstrapOwner,
  verifyArtifactMemoryProvenance,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';
import {
  composeSprint13Application,
  createDurableReferenceResolver,
  openArtifactFoundation,
  type Sprint13Composition,
} from '../../apps/desktop/src/artifact-stack.js';
import { WORKFLOW_OPERATIONS } from '../../apps/desktop/src/workflows.js';
import { sourceWithoutComments } from '../shared/expected-chains.js';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** Recursive production-source walk (designer-boundary precedent) for source guards. */
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
};

const created: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
const clock = { now: (): number => Date.parse('2026-01-01T00:00:00.000Z'), nowIso: (): string => '2026-01-01T00:00:00.000Z' };
const ids = (() => {
  let n = 0;
  return { id: (prefix = 'id') => `${prefix}_01JT31${String(++n).padStart(4, '0')}`, ulid: () => `01JT31${String(++n).padStart(20, '0')}` };
})();
const ACTOR = 'user_owner';
const OTHER = 'user_nobody';

let database: DurableDatabase | null = null;
afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** The REAL Role -> Authority decision point, exactly like main.ts (session + authz). */
const makeAuthorize = async (db: DurableDatabase) => {
  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  const bootstrap = await ensureBootstrapOwner(authz, { actorId: ACTOR, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error('bootstrap owner failed');
  return {
    authz,
    sessionAuthorize: async ({ actorId, authority, scopeId }: { readonly actorId: string; readonly authority: string; readonly scopeId?: string }) => {
      if (actorId !== ACTOR) {
        return { ok: false as const, error: domainError('POLICY_DENIED', `Actor "${actorId}" is not the session actor.`, {}) };
      }
      return authz.decide({ actorId, authority, ...(scopeId === undefined ? {} : { scopeId }) });
    },
  };
};

const makeTools = async (db: DurableDatabase, authorize: Awaited<ReturnType<typeof makeAuthorize>>['sessionAuthorize']) => {
  let validatorCalls = 0;
  const validatorAdapter: ToolPort = {
    describe: () => ({
      toolId: 'tool.gate',
      name: 'tool.gate',
      description: 'gate validator',
      version: '1.0.0',
      riskLevel: 'LOW',
      capabilities: [TOOL_CAPABILITY_VALIDATOR],
      parameters: { type: 'object' },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    }),
    invoke: async (): Promise<{ readonly ok: true; readonly value: ToolResult }> => {
      validatorCalls += 1;
      return ok({
        status: 'ok',
        output: { verdict: 'pass', evidenceRefs: [] },
        artifactRefs: [],
        startedAt: clock.nowIso(),
        finishedAt: clock.nowIso(),
        latencyMs: 1,
      });
    },
  };
  const record = createToolRecord({
    toolId: 'tool.gate',
    name: 'tool.gate',
    description: 'gate validator',
    version: '1.0.0',
    capabilities: [TOOL_CAPABILITY_VALIDATOR],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    riskLevel: 'LOW',
    requiredAuthorities: ['tool.invoke'],
    now: clock.nowIso(),
  });
  if (!record.ok) throw new Error(record.error.message);
  const tools = createToolRegistry({
    ids,
    clock,
    records: db.toolRecords,
    invocations: db.toolInvocations,
    invocationArtifacts: db.toolInvocationArtifacts,
    adapters: new Map<string, ToolPort>([['tool.gate', validatorAdapter]]),
    authorize,
    events: db.events,
    secrets: async () => [],
    timer: (ms: number, onTimeout: () => void) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
    ...(db.toolInvocationClaims === null ? {} : { claims: db.toolInvocationClaims }),
    ...(db.toolInvocationIndex === null ? {} : { invocationIndex: db.toolInvocationIndex }),
  } as never);
  // Register the validator exactly like main.ts registers its tools (idempotent on
  // restart; CONFLICT tolerated).
  const registered = await tools.register(record.value, { actorId: ACTOR });
  if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
  return { tools, validatorAdapter, calls: () => validatorCalls, record: record.value };
};

/** The pinned template: v1 requires tool.gate at stage s1; v2 (current) does not. */
const seedTemplate = async (db: DurableDatabase): Promise<void> => {
  const template: WorkflowTemplate = {
    id: 'tpl_gate' as never,
    orgId: 'cmp_1',
    name: 'gated',
    state: 'published' as never,
    currentVersionId: 'ver_2',
    draftVersionId: null,
    forkedFrom: null,
    createdBy: ACTOR,
    createdAt: clock.nowIso(),
    updatedAt: clock.nowIso(),
    versions: [
      {
        id: 'ver_1',
        templateId: 'tpl_gate' as never,
        semver: '1.0.0',
        contentHash: 'a'.repeat(64),
        changeProposalId: null,
        immutable: true,
        createdBy: ACTOR,
        createdAt: clock.nowIso(),
        graph: {
          nodes: [{ id: 's1', kind: 'work', title: 'Stage 1', config: { validatorIds: ['tool.gate'] } }],
          edges: [],
        },
      },
      {
        id: 'ver_2',
        templateId: 'tpl_gate' as never,
        semver: '2.0.0',
        contentHash: 'b'.repeat(64),
        changeProposalId: null,
        immutable: true,
        createdBy: ACTOR,
        createdAt: clock.nowIso(),
        graph: {
          nodes: [{ id: 's1', kind: 'work', title: 'Stage 1', config: { validatorIds: ['tool.other'] } }],
          edges: [],
        },
      },
    ],
  };
  await db.templates.put(template);
};

interface Harness {
  readonly db: DurableDatabase;
  readonly casRoot: string;
  readonly foundation: Extract<Awaited<ReturnType<typeof openArtifactFoundation>>, { readonly ok: true }>;
  readonly composition: Sprint13Composition;
  readonly sessionAuthorize: Awaited<ReturnType<typeof makeAuthorize>>['sessionAuthorize'];
  readonly validatorCalls: () => number;
  readonly runId: string;
  readonly seedArtifact: (content?: Uint8Array) => Promise<{ readonly id: string; readonly contentHash: string; readonly contentRef: string; readonly commandId: string }>;
}

const make = async (): Promise<Harness> => {
  const db = openDurableDatabase({
    dataDir: tempDir('companyos-t31-'),
    appliedAt: clock.nowIso(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'router', 'handoff', 'memory', 'artifact'],
  });
  database = db;
  const casRoot = tempDir('companyos-t31-cas-');
  const { sessionAuthorize } = await makeAuthorize(db);
  const { tools, calls } = await makeTools(db, sessionAuthorize);

  const seedRun = createWorkflowRun({
    companyId: 'cmp_1' as never,
    workflowId: 'wfl_1' as never,
    templateId: 'tpl_gate' as never,
    versionId: 'ver_1' as never,
    snapshotId: 'snp_1' as never,
    startedBy: ACTOR,
    now: clock.nowIso(),
    ids,
  });
  if (!seedRun.ok) throw new Error(seedRun.error.message);
  await db.runs.put(seedRun.value);
  await seedTemplate(db);

  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger });
  if (!foundation.ok) throw new Error(`foundation not ok: ${foundation.error.message}`);
  const composition = composeSprint13Application({
    database: db,
    contentStore: foundation.contentStore,
    clock,
    ids,
    authorize: sessionAuthorize,
    tools,
    logger: nullLogger,
  });
  return {
    db,
    casRoot,
    foundation,
    composition,
    sessionAuthorize,
    validatorCalls: calls,
    runId: seedRun.value.id,
    seedArtifact: async (content = new TextEncoder().encode('artifact bytes')) => {
      const commandId = `cmd_${ids.id('c')}`;
      const created2 = await composition.artifactService.create({
        commandId,
        runId: seedRun.value.id,
        kind: 'pack-x:doc',
        content,
        producedBy: ACTOR,
        traceId: 'trace_1',
      });
      if (!created2.ok) throw new Error(created2.error.message);
      return { id: created2.value.id, contentHash: created2.value.contentHash, contentRef: created2.value.contentRef, commandId };
    },
  };
};

/** Foundation reopen against the SAME casRoot + database (restart semantics). */
const openArtifactFoundationOk = async (casRoot: string, db: DurableDatabase) => {
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger });
  if (!foundation.ok) throw new Error(`foundation not ok: ${foundation.error.message}`);
  return foundation;
};

const runIn = async (h: Harness, state: string): Promise<void> => {
  const run = await h.db.runs.get(h.runId as never);
  if (run === null) throw new Error('run missing');
  await h.db.runs.put({ ...run, state: state as never });
};

const recordGateEvidence = async (h: Harness, artifactId: string): Promise<void> => {
  const recorded = await h.composition.validationService.run({
    commandId: `cmd_val_${ids.id('v')}`,
    actorId: ACTOR,
    runId: h.runId as never,
    stageId: 's1' as never,
    targetRef: artifactTargetRef(artifactId as never),
    validators: [{ validatorId: 'tool.gate', blocking: true }],
    traceId: 'trace_1',
  });
  if (!recorded.ok) throw new Error(recorded.error.message);
};

describe('Task-13-11 startup reconciliation gate (quiescent, detect/report only)', () => {
  it('happy startup: empty CAS reconciles clean and stays healthy with zero artifacts', async () => {
    const db = openDurableDatabase({
      dataDir: tempDir('companyos-t31b-'),
      appliedAt: clock.nowIso(),
      chains: ['core', 'engine', 'artifact'],
    });
    database = db;
    const foundation = await openArtifactFoundation({ casRoot: tempDir('companyos-t31b-cas-'), database: db, logger: nullLogger });
    expect(foundation.ok).toBe(true);
    if (!foundation.ok) return;
    expect(foundation.report.artifactsChecked).toBe(0);
    expect(foundation.report.fatal).toHaveLength(0);
  });

  it('fatal integrity (metadata → CAS missing) fails startup CLOSED', async () => {
    const h = await make();
    const artifact = await h.seedArtifact();
    const objectPath = join(h.casRoot, artifact.contentHash.slice(0, 2), artifact.contentHash);
    expect(existsSync(objectPath)).toBe(true);
    // Simulate EXTERNAL corruption (test-side only — production has no delete path).
    rmSync(objectPath);
    const reopened = await openArtifactFoundation({ casRoot: h.casRoot, database: h.db, logger: nullLogger });
    expect(reopened.ok).toBe(false);
    if (reopened.ok) return;
    expect(reopened.error.code).toBe('PERSISTENCE_FAILED');
    expect(reopened.error.details['reason']).toBe('ARTIFACT_INTEGRITY_FATAL');
    expect(reopened.report.fatal).toHaveLength(1);
    expect(reopened.report.fatal[0]?.integrityStatus).toBe('CAS_MISSING');
  });

  it('a CAS orphan is DETECTED and REPORTED, never removed (ADR-0015 detect-only)', async () => {
    const h = await make();
    const orphanDir = join(h.casRoot, 'ab');
    mkdirSync(orphanDir, { recursive: true });
    const orphanPath = join(orphanDir, 'a'.repeat(64));
    writeFileSync(orphanPath, 'orphan bytes');
    const foundation = await openArtifactFoundation({ casRoot: h.casRoot, database: h.db, logger: nullLogger });
    expect(foundation.ok).toBe(true);
    if (!foundation.ok) return;
    expect(foundation.report.orphanCasObserved).toBe(1);
    expect(foundation.report.orphans.map((entry) => entry.contentRef)).toEqual([`sha256:${'a'.repeat(64)}`]);
    // Detect/REPORT ONLY: the orphan still exists after reconciliation.
    expect(existsSync(orphanPath)).toBe(true);
  });

  it('artifact chain disabled → fail closed with ARTIFACT_CHAIN_NOT_ENABLED', async () => {
    const db = openDurableDatabase({
      dataDir: tempDir('companyos-t31c-'),
      appliedAt: clock.nowIso(),
      chains: ['core', 'engine'],
    });
    database = db;
    const foundation = await openArtifactFoundation({ casRoot: tempDir('companyos-t31c-cas-'), database: db, logger: nullLogger });
    expect(foundation.ok).toBe(false);
    if (foundation.ok) return;
    expect(foundation.error.code).toBe('PERSISTENCE_FAILED');
    expect(foundation.error.details['reason']).toBe('ARTIFACT_CHAIN_NOT_ENABLED');
  });

  it('restart stability: the SAME casRoot re-reconciles the artifacts it backed', async () => {
    const h = await make();
    await h.seedArtifact();
    const foundation = await openArtifactFoundationOk(h.casRoot, h.db);
    expect(foundation.report.artifactsChecked).toBe(1);
    expect(foundation.report.managedCasObjectsSeen).toBe(1);
    expect(foundation.report.fatal).toHaveLength(0);
  });
});

describe('Task-13-11 evidence gate over the composed engine', () => {
  it('real validator execution records evidence; the composed engine gates VALIDATION.PASS on it', async () => {
    const h = await make();
    const artifact = await h.seedArtifact();
    await runIn(h, 'VALIDATING');

    // Gate FIRST: no durable evidence → the composed engine refuses the transition.
    const refused = await h.composition.engine.dispatch({
      commandId: 'cmd_refused_1',
      runId: h.runId as never,
      type: 'VALIDATION.PASS',
      expectedRevision: 0,
      actorId: ACTOR,
      traceId: 'trace_1',
      issuedAt: clock.nowIso(),
      payload: { artifactId: artifact.id, stageId: 's1' },
    });
    expect(refused.ok).toBe(false);
    const untouched = await h.db.runs.get(h.runId as never);
    expect(untouched?.state).toBe('VALIDATING');

    // Real execution path: ValidationService → ValidatorResolver → Tool Registry → adapter.
    await recordGateEvidence(h, artifact.id);
    expect(h.validatorCalls()).toBe(1);

    const passed = await h.composition.engine.dispatch({
      commandId: 'cmd_pass_1',
      runId: h.runId as never,
      type: 'VALIDATION.PASS',
      expectedRevision: 0,
      actorId: ACTOR,
      traceId: 'trace_1',
      issuedAt: clock.nowIso(),
      payload: { artifactId: artifact.id, stageId: 's1' },
    });
    expect(passed.ok).toBe(true);
    if (passed.ok) expect(passed.value.to).toBe('FINALIZING');
    const run = await h.db.runs.get(h.runId as never);
    expect(run?.state).toBe('FINALIZING');
  });

  it('the stage policy reads the RUN-PINNED version, never the current template latest', async () => {
    const h = await make();
    // The run is pinned to ver_1 (tool.gate); the template's CURRENT version is ver_2 (tool.other).
    const pinned = await h.composition.stagePolicy.requiredValidators({ runId: h.runId, stageId: 's1' });
    expect(pinned.ok).toBe(true);
    if (pinned.ok) expect(pinned.value).toEqual(['tool.gate']);

    // Evidence for the WRONG (current-template) validator never satisfies the pinned gate.
    const artifact = await h.seedArtifact();
    await runIn(h, 'VALIDATING');
    const wrongTarget = await h.composition.validationService.run({
      commandId: `cmd_val_${ids.id('v')}`,
      actorId: ACTOR,
      runId: h.runId as never,
      stageId: 's1' as never,
      targetRef: artifactTargetRef(artifact.id as never),
      validators: [{ validatorId: 'tool.other', blocking: true }],
      traceId: 'trace_1',
    });
    expect(wrongTarget.ok).toBe(false); // tool.other is not registered → NOT_FOUND, zero executions

    const verdict = await h.composition.evidenceGuard.evaluateGate({ runId: h.runId, stageId: 's1', artifactId: artifact.id });
    expect(verdict.ok).toBe(false);
  });

  it('forge-proof: caller-declared verdict fields cannot move the composed gate', async () => {
    const h = await make();
    const artifact = await h.seedArtifact();
    await runIn(h, 'VALIDATING');
    const forged = await h.composition.engine.dispatch({
      commandId: 'cmd_forge_1',
      runId: h.runId as never,
      type: 'VALIDATION.PASS',
      expectedRevision: 0,
      actorId: ACTOR,
      traceId: 'trace_1',
      issuedAt: clock.nowIso(),
      payload: { artifactId: artifact.id, stageId: 's1', validationPassed: true, qualityGatePassed: true, status: 'pass' },
    });
    expect(forged.ok).toBe(false);
    const run = await h.db.runs.get(h.runId as never);
    expect(run?.state).toBe('VALIDATING');
  });
});

describe('Task-13-11 shared infrastructure and real authorization', () => {
  it('ONE database: artifact rows, validation rows, invocations, events AND ledger all land in the same store', async () => {
    const h = await make();
    const artifact = await h.seedArtifact();
    await recordGateEvidence(h, artifact.id);
    const events = (await h.db.events.all()).map((stored) => stored.event.type);
    // ArtifactService internal smoke: trusted request → CAS → row → event → ledger.
    expect(events).toContain('artifact.created');
    const ledgerOutcome = await h.db.ledger.get(artifact.commandId);
    expect(ledgerOutcome?.outcome.artifactId).toBe(artifact.id);
    // ValidationService internal smoke: trusted RunValidation → real ValidatorResolver →
    // Tool Registry → durable validation row → validation.recorded.
    expect(events).toContain('validation.recorded');
    expect(events.some((type) => type.startsWith('tool.invocation'))).toBe(true);
    expect((await h.db.artifactStore!.listByRun(h.runId as never)).map((a) => a.id)).toEqual([artifact.id]);
    expect((await h.db.validationStore!.listByRun(h.runId as never)).length).toBe(1);
    // The composed engine reads the SAME run store.
    const viaEngine = await h.composition.engine.readRun(h.runId);
    expect(viaEngine?.id).toBe(h.runId);
  });

  it('authorization is REAL: a non-session actor gets POLICY_DENIED with ZERO writes', async () => {
    const h = await make();
    const forged = await h.composition.artifactService.create({
      commandId: 'cmd_forged_actor',
      runId: h.runId as never,
      kind: 'pack-x:doc',
      content: new TextEncoder().encode('should never land'),
      producedBy: OTHER,
      traceId: 'trace_1',
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.error.code).toBe('POLICY_DENIED');
    expect(readdirSync(h.casRoot).filter((entry) => entry !== 'staging')).toHaveLength(0);
    expect((await h.db.artifactStore!.listByRun(h.runId as never))).toHaveLength(0);
  });

  it('authorization is REAL: an actor without artifact.create is refused by the Role model', async () => {
    const h = await make();
    const authz = createAuthorizationService({ ids, clock, roles: h.db.roles, assignments: h.db.roleAssignments });
    const defined = await authz.defineRole({
      companyId: 'company_default',
      key: 'peer',
      name: 'Peer',
      authorities: ['workflow.draft.create'],
    });
    expect(defined.ok).toBe(true);
    if (!defined.ok) return;
    await authz.assign({ actorId: OTHER, roleId: defined.value.id, assignedBy: 'system:test' });
    // The Role model itself denies the authority (the session guard is a separate layer).
    const denied = await authz.decide({ actorId: OTHER, authority: 'artifact.create', scopeId: h.runId });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('PERMISSION_DENIED');
  });

  it('the durable reference resolver answers identity + run anchor from the SAME stores', async () => {
    const h = await make();
    const artifact = await h.seedArtifact();
    const resolver = createDurableReferenceResolver(h.db);
    const hit = await resolver([`artifact:${artifact.id}`]);
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.value).toEqual([{ kind: 'artifact', id: artifact.id, ref: `artifact:${artifact.id}`, runId: h.runId }]);
    }
    const miss = await resolver(['artifact:art_01AAAAAAAAAAAAAAAAAAAAAAAA']);
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error.details['reason']).toBe('ARTIFACT_REFERENCE_MISSING');
    const malformed = await resolver(['workspace/../secret']);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.details['reason']).toBe('DURABLE_REFERENCE_MALFORMED');
  });

  it('memory ARTIFACT provenance is LIVE (stores wired, fail-closed on a missing row)', async () => {
    const h = await make();
    const artifact = await h.seedArtifact();
    const verified = await verifyArtifactMemoryProvenance({
      sourceRefs: [`artifact:${artifact.id}`],
      artifactStore: h.db.artifactStore!,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.value).toBe('VERIFIED');
    const dangling = await verifyArtifactMemoryProvenance({
      sourceRefs: ['artifact:art_01AAAAAAAAAAAAAAAAAAAAAAAA'],
      artifactStore: h.db.artifactStore!,
    });
    expect(dangling.ok).toBe(false);
  });
});

describe('Task-13-11 IPC boundary lock (corrective): Sprint 13 services stay internal', () => {
  it('no Sprint 13 operation exists on the renderer-facing workflow channel', async () => {
    // The services are trusted main-process capabilities: wired in the composition,
    // never callable through IPC. None of the four candidate operations was frozen in
    // an IPC contract (no operation-level payload ownership semantics exist), and gate
    // semantics (blocking flags, validation plans) must never come from a caller.
    for (const operation of ['artifact.create', 'artifact.read', 'validation.record', 'validation.read']) {
      expect((WORKFLOW_OPERATIONS as readonly string[])).not.toContain(operation);
    }
  });

  it('the workflow dispatch contains no Sprint 13 artifact/validation operation handling', () => {
    // Executable-source guard (comments stripped, expected-chains precedent): the
    // dispatch must not grow hidden Sprint 13 cases back.
    const source = sourceWithoutComments(readFileSync(repo('apps/desktop/src/workflows.ts'), 'utf8'));
    expect(source).not.toContain("'artifact.create'");
    expect(source).not.toContain("'artifact.read'");
    expect(source).not.toContain("'validation.record'");
    expect(source).not.toContain("'validation.read'");
  });
});

describe('Task-13-11 read-authority reconciliation (CASE C: catalog reservation, not capability)', () => {
  it('the four Sprint 13 authorities are frozen catalog vocabulary (S13_VALIDATION_CONTRACT §12)', () => {
    for (const authority of ['artifact.create', 'artifact.read', 'validation.record', 'validation.read']) {
      expect(AUTHORITIES).toContain(authority);
    }
  });

  it('read authorities have NO runtime enforcement point in production source (catalog ≠ capability)', () => {
    // `artifact.create`/`validation.record` are enforced inside their accepted services
    // (T04/T06). The read authorities are reserved vocabulary: the ONLY allowed
    // occurrence of their string literals in production source is the Core catalog
    // itself — no authorize(...) gate, no service action, no IPC dispatch anywhere.
    const roots = ['apps/desktop/src', 'packages/engine/src', 'packages/persistence/src', 'packages/core/src'];
    for (const root of roots) {
      for (const file of walk(repo(root))) {
        const source = readFileSync(file, 'utf8');
        const isCatalog = file.endsWith('role-authority.ts');
        for (const authority of ['artifact.read', 'validation.read']) {
          if (isCatalog) continue; // the vocabulary itself lives here
          expect({ file, authority, present: source.includes(`'${authority}'`) }).toEqual({
            file,
            authority,
            present: false,
          });
        }
      }
    }
  });

  it('decideAuthority stays fail-closed: an ungranted catalog name is PERMISSION_DENIED, a typo is INVALID_ARGUMENT', () => {
    const ungranted = decideAuthority({ actorId: 'user_x', authority: 'artifact.read', roles: [], assignments: [] });
    expect(ungranted.ok).toBe(false);
    if (!ungranted.ok) expect(ungranted.error.code).toBe('PERMISSION_DENIED');
    const unknown = decideAuthority({ actorId: 'user_x', authority: 'artifact.readAll', roles: [], assignments: [] });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('INVALID_ARGUMENT');
  });
});
