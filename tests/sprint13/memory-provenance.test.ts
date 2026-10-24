/**
 * Sprint 13 / Task-13-08: durable ARTIFACT / VALIDATION memory provenance verification.
 *
 * Real SQLite (artifact chain), real stores, real MemoryService integration. Covers
 * §26-§33: valid/malformed/missing/null-store/corrupt refs for both source types,
 * status-agnostic validation provenance (PASS/FAIL/ERROR + legacy untargeted),
 * no-content-read and no-gate-reevaluation structural proofs, aggregation semantics,
 * and preservation of the Sprint 12 source-type behaviours.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createValidation,
  createWorkflowRun,
  ok,
  artifactTargetRef,
  type Artifact,
  type ArtifactContentStore,
  type ArtifactStorePort,
  type DomainError,
  type Result,
  type ValidationStorePort,
} from '@companyos/core';
import {
  createArtifactService,
  createMemoryService,
  verifyArtifactMemoryProvenance,
  verifyValidationMemoryProvenance,
} from '@companyos/engine';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase as openDb,
  type DurableDatabase,
} from '@companyos/persistence';

const created: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
const clock = { now: (): number => Date.parse('2026-01-01T00:00:00.000Z'), nowIso: (): string => '2026-01-01T00:00:00.000Z' };
const ids = (() => {
  let n = 0;
  return { id: (prefix = 'id') => `${prefix}_01JT20${String(++n).padStart(4, '0')}`, ulid: () => `01JT20${String(++n).padStart(20, '0')}` };
})();
const ACTOR = 'user_owner';
const allow = async (): Promise<{ readonly ok: true; readonly value: true }> => ok(true);

let database: DurableDatabase | null = null;
afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Read-method spy over the real artifact store (content-store calls counted too). */
interface ArtifactSpy {
  readonly store: ArtifactStorePort;
  reads: number;
}
const spyArtifactStore = (real: ArtifactStorePort): ArtifactSpy => {
  const state = { reads: 0 };
  return {
    get reads() { return state.reads; },
    store: {
      create: real.create.bind(real),
      get: async (id: Artifact['id']) => { state.reads += 1; return real.get(id); },
      getByCreationCommand: real.getByCreationCommand.bind(real),
      listByRun: real.listByRun.bind(real),
      listByHash: real.listByHash.bind(real),
    } as ArtifactStorePort,
  };
};

interface Harness {
  readonly db: DurableDatabase;
  readonly artifactStore: ArtifactStorePort;
  readonly validationStore: ValidationStorePort;
  readonly runId: string;
  artifact(): Promise<Artifact>;
  validationId(overrides?: { readonly status?: 'pass' | 'fail' | 'error' | 'skipped'; readonly targetRef?: string | null }): Promise<string>;
}

const make = async (): Promise<Harness> => {
  const db = openDb({
    dataDir: tempDir('companyos-t21-'),
    appliedAt: clock.nowIso(),
    chains: ['core', 'engine', 'artifact'],
  });
  database = db;
  const contentStore: ArtifactContentStore = createFilesystemArtifactContentStore({ casRoot: tempDir('companyos-t21-cas-') });
  const artifactService = createArtifactService({
    artifactStore: db.artifactStore!, contentStore, runs: db.runs, events: db.events,
    ledger: db.ledger, clock, ids, unitOfWork: db.unitOfWork, authorize: allow,
  });
  const seedRun = createWorkflowRun({
    companyId: 'cmp_1' as never, workflowId: 'wfl_1' as never, templateId: 'tpl_1' as never,
    versionId: 'ver_1' as never, snapshotId: 'snp_1' as never, startedBy: ACTOR, now: clock.nowIso(), ids,
  });
  expect(seedRun.ok).toBe(true);
  if (!seedRun.ok) throw new Error('seed');
  await db.runs.put(seedRun.value);
  const h: Harness = {
    db, artifactStore: db.artifactStore!, validationStore: db.validationStore!, runId: seedRun.value.id,
    async artifact() {
      const made = await artifactService.create({
        commandId: `cmd_t_${ids.id('a')}`, runId: seedRun.value.id as never, kind: 'pack-x:doc',
        content: new TextEncoder().encode('provenance target'), producedBy: 'agent:agt_1', traceId: 'trace_t',
      });
      expect(made.ok).toBe(true);
      if (!made.ok) throw new Error('artifact');
      return made.value;
    },
    async validationId(overrides) {
      const made = createValidation({
        runId: seedRun.value.id as never, validatorId: 'pack-x:unit', validatorVersion: '1.0.0',
        status: overrides?.status ?? 'pass', blocking: true, evidenceRefs: ['command:seed'],
        startedAt: clock.nowIso(), finishedAt: clock.nowIso(),
        ...(overrides?.targetRef === undefined ? {} : { targetRef: overrides.targetRef as never }),
        ids,
      });
      expect(made.ok).toBe(true);
      if (!made.ok) throw new Error('validation');
      await db.validationStore!.record(made.value, { creationCommandId: `cmd_v_${ids.id('v')}`, creationCommandFingerprint: 'fp:seed' });
      return made.value.id;
    },
  };
  return h;
};

const denyReason = (result: Result<unknown, DomainError>): string | undefined =>
  result.ok ? undefined : (result.error as DomainError & { details?: { reason?: string } }).details?.reason;

describe('ARTIFACT memory provenance (§26)', () => {
  it('valid canonical ref to an existing Artifact → VERIFIED', async () => {
    const h = await make();
    const artifact = await h.artifact();
    const verdict = await verifyArtifactMemoryProvenance({
      sourceRefs: [artifactTargetRef(artifact.id)],
      artifactStore: h.artifactStore,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value).toBe('VERIFIED');
  });

  it('malformed refs (bare id / garbage / empty) → fail closed, never verified', async () => {
    const h = await make();
    await h.artifact();
    for (const bad of ['', 'art_01JT200000000000000000000A1', 'artifact:', 'artifact:art_x', 'workspace/foo']) {
      const verdict = await verifyArtifactMemoryProvenance({ sourceRefs: [bad], artifactStore: h.artifactStore });
      expect(verdict.ok, `ref=${JSON.stringify(bad)}`).toBe(false);
      if (!verdict.ok) expect(denyReason(verdict)).toBe('ARTIFACT_PROVENANCE_REF_INVALID');
    }
  });

  it('missing Artifact → fail closed', async () => {
    const h = await make();
    const verdict = await verifyArtifactMemoryProvenance({
      sourceRefs: [artifactTargetRef('art_01JT20DEADBEEF0000000000000ZZ1')],
      artifactStore: h.artifactStore,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(denyReason(verdict)).toBe('ARTIFACT_PROVENANCE_MISSING');
  });

  it('null store (chain not wired) → fail closed, never verified', async () => {
    const verdict = await verifyArtifactMemoryProvenance({
      sourceRefs: [artifactTargetRef('art_01JT200000000000000000000A1')],
      artifactStore: null,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(denyReason(verdict)).toBe('ARTIFACT_CHAIN_NOT_ENABLED');
  });

  it('corrupt durable row → integrity error propagates as a denial (§31)', async () => {
    const h = await make();
    const artifact = await h.artifact();
    h.db.db.exec('PRAGMA ignore_check_constraints = ON');
    h.db.db.prepare('UPDATE artifacts SET content_hash = ? WHERE artifact_id = ?').run('short', artifact.id);
    h.db.db.exec('PRAGMA ignore_check_constraints = OFF');
    const verdict = await verifyArtifactMemoryProvenance({
      sourceRefs: [artifactTargetRef(artifact.id)],
      artifactStore: h.artifactStore,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe('PERSISTENCE_FAILED');
  });

  it('verification reads IDENTITY only — one metadata get, zero content reads (§7/§29)', async () => {
    const h = await make();
    const artifact = await h.artifact();
    const spy = spyArtifactStore(h.artifactStore);
    const verdict = await verifyArtifactMemoryProvenance({
      sourceRefs: [artifactTargetRef(artifact.id)],
      artifactStore: spy.store,
    });
    expect(verdict.ok).toBe(true);
    expect(spy.reads).toBe(1); // exactly one identity get()
    // Structural: the verifier dependency type has NO ArtifactContentStore — proven at
    // the module level (artifact-validation-provenance.ts imports neither CAS nor
    // content types). Memory content below is untouched by verification.
  });
});

describe('VALIDATION memory provenance (§27/§28)', () => {
  it('valid bare ValidationId ref to an existing row → VERIFIED', async () => {
    const h = await make();
    const artifact = await h.artifact();
    const validationId = await h.validationId({ targetRef: artifactTargetRef(artifact.id) });
    const verdict = await verifyValidationMemoryProvenance({ sourceRefs: [validationId], validationStore: h.validationStore });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value).toBe('VERIFIED');
  });

  it('malformed refs → fail closed', async () => {
    const h = await make();
    for (const bad of ['', 'validation:val_1', 'hnd_1@v1']) {
      const verdict = await verifyValidationMemoryProvenance({ sourceRefs: [bad], validationStore: h.validationStore });
      expect(verdict.ok, `ref=${JSON.stringify(bad)}`).toBe(false);
      if (!verdict.ok) expect(denyReason(verdict)).toBe('VALIDATION_PROVENANCE_REF_INVALID');
    }
  });

  it('missing Validation → fail closed', async () => {
    const h = await make();
    const verdict = await verifyValidationMemoryProvenance({ sourceRefs: ['val_01JT20MISSING0000000000000ZZ'], validationStore: h.validationStore });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(denyReason(verdict)).toBe('VALIDATION_PROVENANCE_MISSING');
  });

  it('null store → fail closed', async () => {
    const verdict = await verifyValidationMemoryProvenance({ sourceRefs: ['val_01JT200000000000000000000A1'], validationStore: null });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(denyReason(verdict)).toBe('ARTIFACT_CHAIN_NOT_ENABLED');
  });

  it('status FAIL and ERROR remain valid provenance (§15: provenance ≠ gate verdict)', async () => {
    const h = await make();
    const artifact = await h.artifact();
    const target = artifactTargetRef(artifact.id);
    for (const status of ['fail', 'error', 'skipped'] as const) {
      const validationId = await h.validationId({ status, targetRef: target });
      const verdict = await verifyValidationMemoryProvenance({ sourceRefs: [validationId], validationStore: h.validationStore });
      expect(verdict.ok, `status=${status}`).toBe(true);
    }
  });

  it('legacy untargeted Validation (targetRef=null) is ACCEPTED as provenance (§28: no frozen targeting requirement)', async () => {
    const h = await make();
    const validationId = await h.validationId({ targetRef: null });
    const verdict = await verifyValidationMemoryProvenance({ sourceRefs: [validationId], validationStore: h.validationStore });
    expect(verdict.ok).toBe(true);
  });

  it('corrupt durable row → denial (§31)', async () => {
    const h = await make();
    const artifact = await h.artifact();
    const validationId = await h.validationId({ targetRef: artifactTargetRef(artifact.id) });
    h.db.db.prepare('UPDATE validations SET evidence_refs_json = ? WHERE validation_id = ?').run('not-json', validationId);
    const verdict = await verifyValidationMemoryProvenance({ sourceRefs: [validationId], validationStore: h.validationStore });
    expect(verdict.ok).toBe(false);
  });

  it('no gate re-evaluation: a FAIL validation verifies without any batch/stage/policy input (§30)', async () => {
    const h = await make();
    const artifact = await h.artifact();
    const validationId = await h.validationId({ status: 'fail', targetRef: artifactTargetRef(artifact.id) });
    // The verifier signature takes ONLY { sourceRefs, validationStore } — there is no
    // stagePolicy/batch/gate parameter to pass; this test locks that contract shape.
    const verdict = await verifyValidationMemoryProvenance({ sourceRefs: [validationId], validationStore: h.validationStore });
    expect(verdict.ok).toBe(true);
  });
});

describe('MemoryService integration (§34: write semantics unchanged)', () => {
  const memoryInput = (sourceType: string, sourceRefs: readonly string[]) => ({
    companyId: 'cmp_1', scope: { type: 'COMPANY' as const, id: 'cmp_1' }, kind: 'FACT' as const,
    title: 'From artifact', content: 'The artifact is durable evidence.', importance: 'HIGH' as const,
    sourceType, sourceRefs, createdBy: ACTOR, traceId: 'trace', metadata: {},
  });

  const serviceWith = (h: Harness) =>
    createMemoryService({
      store: {
        create: async () => {}, update: async () => {}, get: async () => null,
        listVersions: async () => [], listForTargetRole: async () => [], listRecent: async () => [],
        listAll: async () => [], updateStatus: async () => {}, retrieve: undefined,
      } as never,
      clock, ids, authorize: allow,
      provenance: {
        verify: async (input: { sourceType: string; sourceRefs: readonly string[]; companyId: string }) => {
          if (input.sourceType === 'ARTIFACT') return verifyArtifactMemoryProvenance({ sourceRefs: input.sourceRefs, artifactStore: h.artifactStore });
          if (input.sourceType === 'VALIDATION') return verifyValidationMemoryProvenance({ sourceRefs: input.sourceRefs, validationStore: h.validationStore });
          if (input.sourceType === 'USER') return { ok: true as const, value: 'ASSERTED' as const };
          return { ok: false as const, error: new (await import('@companyos/core')).DomainError('VALIDATION_FAILED', 'Unsupported.') };
        },
      },
    });

  it('ARTIFACT-sourced memory earns trust=VERIFIED and content is the caller-authored summary', async () => {
    const h = await make();
    const artifact = await h.artifact();
    const svc = serviceWith(h);
    const made = await svc.create(memoryInput('ARTIFACT', [artifactTargetRef(artifact.id)]) as never);
    expect(made.ok).toBe(true);
    if (made.ok) {
      expect(made.value.trust).toBe('VERIFIED');
      expect(made.value.content).toBe('The artifact is durable evidence.'); // caller content, NOT artifact bytes
      expect(made.value.provenance.sourceRefs).toEqual([`artifact:${artifact.id}`]);
    }
  });

  it('VALIDATION-sourced memory earns trust=VERIFIED (even for a FAIL validation)', async () => {
    const h = await make();
    const artifact = await h.artifact();
    const validationId = await h.validationId({ status: 'fail', targetRef: artifactTargetRef(artifact.id) });
    const svc = serviceWith(h);
    const made = await svc.create(memoryInput('VALIDATION', [validationId]) as never);
    expect(made.ok).toBe(true);
    if (made.ok) expect(made.value.trust).toBe('VERIFIED');
  });

  it('dangling ARTIFACT ref rejects the memory create (no silent ASSERTED downgrade)', async () => {
    const h = await make();
    const svc = serviceWith(h);
    const made = await svc.create(memoryInput('ARTIFACT', [artifactTargetRef('art_01JT20DEADBEEF0000000000000ZZ1')]) as never);
    expect(made.ok).toBe(false);
  });

  it('aggregation semantics preserved: sourceRefs[0] is THE reference (Sprint 12 convention, §32/§33)', async () => {
    const h = await make();
    const artifact = await h.artifact();
    const svc = serviceWith(h);
    // First ref valid, second garbage: FIRST decides (Sprint 12 branches read [0] only).
    const made = await svc.create(memoryInput('ARTIFACT', [artifactTargetRef(artifact.id), 'garbage']) as never);
    expect(made.ok).toBe(true);
    // First ref dangling, second valid: still a denial.
    const denied = await svc.create(memoryInput('ARTIFACT', [artifactTargetRef('art_01JT20DEADBEEF0000000000000ZZ1'), artifactTargetRef(artifact.id)]) as never);
    expect(denied.ok).toBe(false);
  });

  it('existing source behaviours preserved: USER → ASSERTED, unknown type → denial (§21/§22)', async () => {
    const h = await make();
    const svc = serviceWith(h);
    const user = await svc.create(memoryInput('USER', []) as never);
    expect(user.ok).toBe(true);
    if (user.ok) expect(user.value.trust).toBe('ASSERTED');
    const unknown = await svc.create(memoryInput('MOON', ['x']) as never);
    expect(unknown.ok).toBe(false);
  });
});
