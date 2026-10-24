/**
 * Sprint 13 / Task-13-02: durable artifact + validation evidence persistence.
 *
 * Covers: the opt-in `artifact` migration chain (#12), the SQLite adapters for
 * ArtifactStorePort / ValidationStorePort, Option B permanent creation idempotency
 * at the storage layer, and the negative-integrity fail-closed guards.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifact,
  createValidation,
  type ArtifactCreationMetadata,
  type ValidationCreationMetadata,
} from '@companyos/core';
import {
  createSqliteArtifactStore,
  createSqliteValidationStore,
  openDurableDatabase,
  tableExists,
  type DurableDatabase,
  type MigrationChainName,
} from '../src/index.js';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-artifact-'));
  created.push(dir);
  return dir;
};

let database: DurableDatabase | null = null;
const db = (chains: readonly MigrationChainName[]): DurableDatabase => {
  database?.close();
  database = openDurableDatabase({
    dataDir: tempDir(),
    appliedAt: '2026-01-01T00:00:00.000Z',
    chains,
  });
  return database;
};

afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const ids = (() => {
  let n = 0;
  return {
    id: (prefix = 'id') => `${prefix}_01JT13${String(++n).padStart(4, '0')}`,
    ulid: () => `01JT13${String(++n).padStart(20, '0')}`,
  };
})();

const artifactInput = (overrides: Partial<Parameters<typeof createArtifact>[0]> = {}) => ({
  runId: 'run_01JT13' as never,
  kind: 'pack-x:report',
  contentRef: 'sha256:' + 'a'.repeat(64),
  contentHash: 'a'.repeat(64),
  sizeBytes: 16,
  producedBy: 'agent:agt_01JT13',
  now: '2026-01-01T00:00:00.000Z',
  ids,
  ...overrides,
});

const validationInput = (overrides: Partial<Parameters<typeof createValidation>[0]> = {}) => ({
  runId: 'run_01JT13' as never,
  validatorId: 'pack-x:unit',
  validatorVersion: '1.0.0',
  status: 'pass' as const,
  exitCode: 0,
  startedAt: '2026-01-01T00:00:00.000Z',
  ids,
  ...overrides,
});

const artifactCreation = (commandId: string, fingerprint: string): ArtifactCreationMetadata => ({
  creationCommandId: commandId,
  creationCommandFingerprint: fingerprint,
});

const validationCreation = (commandId: string, fingerprint: string): ValidationCreationMetadata => ({
  creationCommandId: commandId,
  creationCommandFingerprint: fingerprint,
});

describe('artifact migration chain (#12)', () => {
  it('applies on a fresh database and creates both evidence tables', () => {
    const database = db(['core', 'engine', 'artifact']);
    expect(database.migrations.artifact?.applied.map((m) => m.name)).toEqual([
      '0001_artifact_validation',
      '0002_validation_target_ref',
    ]);
    expect(tableExists(database.db, 'artifacts')).toBe(true);
    expect(tableExists(database.db, 'validations')).toBe(true);
  });

  it('keeps the pre-existing 11 chains intact and applies #12 exactly once on reopen', () => {
    const first = db(['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'router', 'handoff', 'memory', 'artifact']);
    expect(first.migrations.artifact?.applied).toHaveLength(2);
    const path = first.path;
    first.close();
    database = openDurableDatabase({ dataDir: join(path, '..'), fileName: path.split(/[\\/]/).pop(), appliedAt: '2026-01-02T00:00:00.000Z', chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'router', 'handoff', 'memory', 'artifact'] });
    // Reopen: the artifact chain is NOT re-applied (exactly-once — an empty `applied`
    // report means no migration ran again), and the older chains stay untouched.
    expect(database.migrations.artifact?.applied).toHaveLength(0);
    expect(tableExists(database.db, 'artifacts')).toBe(true);
    expect(tableExists(database.db, 'validations')).toBe(true);
    expect(database.migrations.core?.applied).toHaveLength(0);
    expect(database.artifactStore).not.toBeNull();
    expect(database.validationStore).not.toBeNull();
  });

  it('leaves the stores null when the chain is not requested (opt-in)', () => {
    const without = db(['core', 'engine']);
    expect(without.artifactStore).toBeNull();
    expect(without.validationStore).toBeNull();
    expect(without.migrations.artifact).toBeNull();
  });
});

describe('ArtifactStore', () => {
  it('round-trips create/get and keeps creation metadata off the domain object', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteArtifactStore(d.db);
    const created = createArtifact(artifactInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await store.create(created.value, artifactCreation('cmd_a1', 'fp:one'));

    const loaded = await store.get(created.value.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(created.value.id);
    expect(loaded?.contentHash).toBe(created.value.contentHash);
    expect('creationCommandId' in (loaded as object)).toBe(false);
    expect('creationCommandFingerprint' in (loaded as object)).toBe(false);

    const lookup = await store.getByCreationCommand('cmd_a1');
    expect(lookup?.artifact.id).toBe(created.value.id);
    expect(lookup?.creationCommandFingerprint).toBe('fp:one');
  });

  it('rejects a duplicate creation command (exactly one artifact per commandId)', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteArtifactStore(d.db);
    const first = createArtifact(artifactInput());
    const second = createArtifact(artifactInput());
    if (!first.ok || !second.ok) return;
    await store.create(first.value, artifactCreation('cmd_dup', 'fp:x'));
    await expect(store.create(second.value, artifactCreation('cmd_dup', 'fp:x'))).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'ARTIFACT_CREATION_COMMAND_EXISTS' },
    });
  });

  it('returns null for an unknown creation command (ledger-trimmed miss)', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteArtifactStore(d.db);
    await expect(store.getByCreationCommand('cmd_never')).resolves.toBeNull();
  });

  it('lists by run deterministically and allows multiple identities per contentHash', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteArtifactStore(d.db);
    const a = createArtifact(artifactInput({ now: '2026-01-01T00:00:01.000Z' }));
    const b = createArtifact(artifactInput({ now: '2026-01-01T00:00:02.000Z', contentRef: 'sha256:' + 'a'.repeat(64) }));
    if (!a.ok || !b.ok) return;
    await store.create(a.value, artifactCreation('cmd_l1', 'fp:a'));
    await store.create(b.value, artifactCreation('cmd_l2', 'fp:b'));

    const byRun = await store.listByRun('run_01JT13' as never);
    expect(byRun.map((x) => x.createdAt)).toEqual([...byRun.map((x) => x.createdAt)].sort().reverse());
    expect(byRun).toHaveLength(2);

    // Same contentHash (both rows) → two artifact identities, no UNIQUE(content_hash).
    const byHash = await store.listByHash('a'.repeat(64));
    expect(byHash).toHaveLength(2);
    expect(new Set(byHash.map((x) => x.id)).size).toBe(2);
  });

  it('fails closed on a corrupt recovered row (defense in depth behind the DB CHECK)', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteArtifactStore(d.db);
    const created = createArtifact(artifactInput());
    if (!created.ok) return;
    await store.create(created.value, artifactCreation('cmd_c1', 'fp:c'));

    // Defense layer 1: the DB CHECK refuses the corrupt write outright.
    expect(() =>
      d.db.prepare('UPDATE artifacts SET content_hash = ? WHERE artifact_id = ?').run('short', created.value.id),
    ).toThrow(/CHECK constraint failed/);

    // Defense layer 2: even with CHECK enforcement bypassed (externally corrupted file),
    // the adapter re-validates the recovered shape and fails closed.
    d.db.exec('PRAGMA ignore_check_constraints = ON');
    d.db.prepare('UPDATE artifacts SET content_hash = ? WHERE artifact_id = ?').run('short', created.value.id);
    d.db.exec('PRAGMA ignore_check_constraints = OFF');
    await expect(store.get(created.value.id)).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
      details: { reason: 'ARTIFACT_ROW_CORRUPT' },
    });
  });

  it('enforces the metadata CHECK pair (both NULL or both present)', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const created = createArtifact(artifactInput());
    if (!created.ok) return;
    // id without fingerprint → CHECK violation
    expect(() =>
      d.db
        .prepare(
          'INSERT INTO artifacts (artifact_id, run_id, kind, content_ref, content_hash, size_bytes, produced_by, created_at, creation_command_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(created.value.id, 'run_01JT13', 'k', 'sha256:' + 'a'.repeat(64), 'a'.repeat(64), 1, 'p', '2026-01-01T00:00:00.000Z', 'cmd_x'),
    ).toThrow();
    // fingerprint without id → CHECK violation
    expect(() =>
      d.db
        .prepare(
          'INSERT INTO artifacts (artifact_id, run_id, kind, content_ref, content_hash, size_bytes, produced_by, created_at, creation_command_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(created.value.id + 'x', 'run_01JT13', 'k', 'sha256:' + 'a'.repeat(64), 'a'.repeat(64), 1, 'p', '2026-01-01T00:00:00.000Z', 'fp_x'),
    ).toThrow();
  });

  it('rejects invalid content hash and negative size via DB CHECK constraints', () => {
    const d = db(['core', 'engine', 'artifact']);
    const insert = (hash: string, size: number): void => {
      d.db
        .prepare(
          'INSERT INTO artifacts (artifact_id, run_id, kind, content_ref, content_hash, size_bytes, produced_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('art_' + hash.slice(0, 8), 'run_01JT13', 'k', 'sha256:' + hash, hash, size, 'p', '2026-01-01T00:00:00.000Z');
    };
    expect(() => insert('short', 1)).toThrow();
    expect(() => insert('a'.repeat(64), -1)).toThrow();
  });
});

describe('ValidationStore', () => {
  it('round-trips record/get and keeps creation metadata off the domain object', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteValidationStore(d.db);
    const created = createValidation(validationInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await store.record(created.value, validationCreation('cmd_v1', 'fp:v'));

    const loaded = await store.get(created.value.id);
    expect(loaded?.status).toBe('pass');
    expect(loaded?.blocking).toBe(true);
    expect('creationCommandId' in (loaded as object)).toBe(false);

    const lookup = await store.getByCreationCommand('cmd_v1');
    expect(lookup?.validations).toHaveLength(1);
    expect(lookup?.creationCommandFingerprint).toBe('fp:v');
  });

  it('allows one command + multiple validators and recovers the complete batch deterministically', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteValidationStore(d.db);
    const unit = createValidation(validationInput({ validatorId: 'pack-x:unit' }));
    const lint = createValidation(validationInput({ validatorId: 'pack-x:lint', status: 'fail' as const, exitCode: 1, blocking: false }));
    if (!unit.ok || !lint.ok) return;
    await store.record(unit.value, validationCreation('cmd_batch', 'fp:batch'));
    await store.record(lint.value, validationCreation('cmd_batch', 'fp:batch'));

    const lookup = await store.getByCreationCommand('cmd_batch');
    expect(lookup?.validations).toHaveLength(2);
    expect(lookup?.validations.map((v) => v.validatorId)).toEqual(['pack-x:lint', 'pack-x:unit']);
    expect(lookup?.validations.every((v) => v.runId === 'run_01JT13')).toBe(true);
  });

  it('rejects a duplicate (commandId, validatorId) but allows a NEW commandId (re-validation)', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteValidationStore(d.db);
    const first = createValidation(validationInput());
    if (!first.ok) return;
    await store.record(first.value, validationCreation('cmd_r1', 'fp:r1'));
    await expect(store.record(first.value, validationCreation('cmd_r1', 'fp:r1'))).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'VALIDATION_CREATION_COMMAND_EXISTS' },
    });

    // Intentional re-validation: NEW commandId → new durable evidence, append-only.
    const again = createValidation(validationInput());
    if (!again.ok) return;
    await store.record(again.value, validationCreation('cmd_r2', 'fp:r2'));
    const batchTwo = await store.getByCreationCommand('cmd_r2');
    expect(batchTwo?.validations).toHaveLength(1);
    expect(batchTwo?.validations[0]?.id).toBe(again.value.id);
  });

  it('recovers domain shape with evidence refs and parsed fields intact', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteValidationStore(d.db);
    const created = createValidation(
      validationInput({
        evidenceRefs: ['artifact:art_01JT13', 'command:npm test'],
        command: 'npm test',
        finishedAt: '2026-01-01T00:01:00.000Z',
      }),
    );
    if (!created.ok) return;
    await store.record(created.value, validationCreation('cmd_e1', 'fp:e'));
    const loaded = await store.get(created.value.id);
    expect(loaded?.evidenceRefs).toEqual(['artifact:art_01JT13', 'command:npm test']);
    expect(loaded?.command).toBe('npm test');
    expect(loaded?.finishedAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('fails closed on malformed persisted evidence JSON and on an unknown status', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteValidationStore(d.db);
    const created = createValidation(validationInput({ evidenceRefs: ['artifact:art_01JT13'] }));
    if (!created.ok) return;
    await store.record(created.value, validationCreation('cmd_z1', 'fp:z'));

    // Malformed evidence JSON: not covered by a CHECK, so the ADAPTER guard fails closed.
    d.db.prepare('UPDATE validations SET evidence_refs_json = ? WHERE validation_id = ?').run('not-json', created.value.id);
    await expect(store.get(created.value.id)).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
      details: { reason: 'VALIDATION_ROW_CORRUPT' },
    });

    // Unknown status: defense layer 1 (DB CHECK) refuses the write; layer 2 (adapter
    // re-validation) also fails closed if the write somehow bypasses the CHECK.
    expect(() =>
      d.db.prepare('UPDATE validations SET status = ? WHERE validation_id = ?').run('warn', created.value.id),
    ).toThrow(/CHECK constraint failed/);
    d.db.exec('PRAGMA ignore_check_constraints = ON');
    d.db.prepare('UPDATE validations SET status = ? WHERE validation_id = ?').run('warn', created.value.id);
    d.db.exec('PRAGMA ignore_check_constraints = OFF');
    await expect(store.get(created.value.id)).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
      details: { reason: 'VALIDATION_ROW_CORRUPT' },
    });
  });

  it('fails closed when one command batch carries mixed fingerprints', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteValidationStore(d.db);
    const unit = createValidation(validationInput({ validatorId: 'pack-x:unit' }));
    const lint = createValidation(validationInput({ validatorId: 'pack-x:lint' }));
    if (!unit.ok || !lint.ok) return;
    await store.record(unit.value, validationCreation('cmd_mix', 'fp:left'));
    await store.record(lint.value, validationCreation('cmd_mix', 'fp:right'));

    await expect(store.getByCreationCommand('cmd_mix')).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
      details: { reason: 'VALIDATION_BATCH_FINGERPRINT_MISMATCH' },
    });
  });
});

describe('Validation target binding (ADR-0017)', () => {
  const targetA = 'artifact:art_01JT13AAAAAAAAAAAAAAAAA0' as never;
  const targetB = 'artifact:art_01JT13BBBBBBBBBBBBBBBBB0' as never;

  it('round-trips targetRef through record/get/listByRun/getByCreationCommand', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteValidationStore(d.db);
    const created = createValidation(validationInput({ targetRef: targetA }));
    if (!created.ok) return;
    await store.record(created.value, validationCreation('cmd_t1', 'fp:t1'));

    const loaded = await store.get(created.value.id);
    expect(loaded?.targetRef).toBe(targetA);
    const byRun = await store.listByRun('run_01JT13' as never);
    expect(byRun[0]?.targetRef).toBe(targetA);
    const byCommand = await store.getByCreationCommand('cmd_t1');
    expect(byCommand?.targetRef).toBe(targetA);
    expect(byCommand?.validations.every((v) => v.targetRef === targetA)).toBe(true);
  });

  it('listByTargetRef returns exactly the target artifact validations (deterministic)', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteValidationStore(d.db);
    const forA = createValidation(validationInput({ targetRef: targetA }));
    const alsoForA = createValidation(validationInput({ targetRef: targetA, validatorId: 'pack-x:lint' }));
    const forB = createValidation(validationInput({ targetRef: targetB }));
    if (!forA.ok || !alsoForA.ok || !forB.ok) return;
    await store.record(forA.value, validationCreation('cmd_ta1', 'fp:a1'));
    await store.record(alsoForA.value, validationCreation('cmd_ta2', 'fp:a2'));
    await store.record(forB.value, validationCreation('cmd_tb1', 'fp:b1'));

    const a = await store.listByTargetRef(targetA);
    expect(a).toHaveLength(2);
    expect(a.every((v) => v.targetRef === targetA)).toBe(true);
    // Deterministic: newest first (startedAt), id as tiebreak.
    expect(a.map((v) => v.startedAt)).toEqual([...a.map((v) => v.startedAt)].sort().reverse());

    const b = await store.listByTargetRef(targetB);
    expect(b).toHaveLength(1);
    expect(b[0]?.targetRef).toBe(targetB);
  });

  it('distinguishes same-run same-validator validations for different artifacts', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteValidationStore(d.db);
    const forA = createValidation(validationInput({ targetRef: targetA }));
    const forB = createValidation(validationInput({ targetRef: targetB }));
    if (!forA.ok || !forB.ok) return;
    // Same run, same validator, different target — both durable, both queryable.
    await store.record(forA.value, validationCreation('cmd_sa', 'fp:sa'));
    await store.record(forB.value, validationCreation('cmd_sb', 'fp:sb'));
    expect((await store.listByTargetRef(targetA)).map((v) => v.id)).toEqual([forA.value.id]);
    expect((await store.listByTargetRef(targetB)).map((v) => v.id)).toEqual([forB.value.id]);
  });

  it('fails closed when one command batch carries mixed target refs', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteValidationStore(d.db);
    const unit = createValidation(validationInput({ validatorId: 'pack-x:unit', targetRef: targetA }));
    const lint = createValidation(validationInput({ validatorId: 'pack-x:lint', targetRef: targetB }));
    if (!unit.ok || !lint.ok) return;
    await store.record(unit.value, validationCreation('cmd_mix_t', 'fp:m'));
    await store.record(lint.value, validationCreation('cmd_mix_t', 'fp:m'));

    await expect(store.getByCreationCommand('cmd_mix_t')).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
      details: { reason: 'VALIDATION_BATCH_TARGET_MISMATCH' },
    });
  });

  it('allows same command + same target + multiple validators (frozen cardinality)', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteValidationStore(d.db);
    const unit = createValidation(validationInput({ validatorId: 'pack-x:unit', targetRef: targetA }));
    const lint = createValidation(validationInput({ validatorId: 'pack-x:lint', targetRef: targetA }));
    if (!unit.ok || !lint.ok) return;
    await store.record(unit.value, validationCreation('cmd_one_target', 'fp:ot'));
    await store.record(lint.value, validationCreation('cmd_one_target', 'fp:ot'));
    const batch = await store.getByCreationCommand('cmd_one_target');
    expect(batch?.validations).toHaveLength(2);
    expect(batch?.targetRef).toBe(targetA);
  });

  it('keeps legacy untargeted validations reconstructible (but distinguishable from targeted)', async () => {
    const d = db(['core', 'engine', 'artifact']);
    const store = createSqliteValidationStore(d.db);
    const legacy = createValidation(validationInput());
    if (!legacy.ok) return;
    await store.record(legacy.value, validationCreation('cmd_legacy', 'fp:lg'));

    const loaded = await store.get(legacy.value.id);
    expect(loaded?.targetRef).toBeNull();
    // A legacy record is NOT targeted evidence: it never appears in a target query.
    expect(await store.listByTargetRef(targetA)).toHaveLength(0);
    const lookup = await store.getByCreationCommand('cmd_legacy');
    expect(lookup?.targetRef).toBeNull();
  });
});
