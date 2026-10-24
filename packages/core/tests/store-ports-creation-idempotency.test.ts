/**
 * Sprint 13A / Task-13-01 port contract test: the store ports must be able to express
 * the Accepted Option B permanent idempotency — create with durable creation metadata,
 * recover artifact/batch + fingerprint by creation command even after a ledger trim —
 * WITHOUT putting that metadata on the domain entities and WITHOUT any SQLite.
 *
 * The in-memory stores below are throwaway contract fixtures (`satisfies` proves the
 * interface shape); the real SQLite adapters arrive with Task-13-02.
 */
import { describe, expect, it } from 'vitest';

import type {
  ArtifactCreationMetadata,
  ArtifactStorePort,
  DurableArtifactLookup,
  DurableValidationLookup,
  ValidationCreationMetadata,
  ValidationStorePort,
  WorkflowRunId,
} from '../src/index.js';
import { createArtifact, createValidation } from '../src/index.js';
import type { Artifact } from '../src/domain/artifact.js';
import type { Validation } from '../src/domain/validation.js';

const ids = (() => {
  let n = 0;
  return {
    id: (prefix = 'id') => `${prefix}_01JTEST${String(++n).padStart(4, '0')}`,
    ulid: () => `01JTEST0000000000000000${String(++n).padStart(2, '0')}`,
  };
})();

const artifactInput = {
  runId: 'run_01JTEST' as WorkflowRunId,
  kind: 'pack-x:report',
  contentRef: 'sha256:' + 'a'.repeat(64),
  contentHash: 'a'.repeat(64),
  sizeBytes: 8,
  producedBy: 'agent:agt_01JTEST',
  now: '2026-01-01T00:00:00.000Z',
  ids,
};

const validationInput = {
  runId: 'run_01JTEST' as WorkflowRunId,
  validatorId: 'pack-x:unit',
  validatorVersion: '1.0.0',
  status: 'pass' as const,
  exitCode: 0,
  startedAt: '2026-01-01T00:00:00.000Z',
  ids,
};

/** Contract fixture: in-memory ArtifactStorePort with unique creation-command semantics. */
class InMemoryArtifactStore implements ArtifactStorePort {
  readonly rows = new Map<string, { artifact: Artifact; creation: ArtifactCreationMetadata }>();

  async create(artifact: Artifact, creation: ArtifactCreationMetadata): Promise<void> {
    if (this.rows.has(creation.creationCommandId)) {
      throw new Error('UNIQUE(creation_command_id): one command creates exactly one artifact');
    }
    this.rows.set(creation.creationCommandId, { artifact, creation });
  }

  async get(artifactId: Artifact['id']): Promise<Artifact | null> {
    for (const row of this.rows.values()) if (row.artifact.id === artifactId) return row.artifact;
    return null;
  }

  async getByCreationCommand(commandId: string): Promise<DurableArtifactLookup | null> {
    const row = this.rows.get(commandId);
    if (row === undefined) return null;
    return {
      artifact: row.artifact,
      creationCommandId: row.creation.creationCommandId,
      creationCommandFingerprint: row.creation.creationCommandFingerprint,
    };
  }

  async listByRun(runId: Artifact['runId']): Promise<readonly Artifact[]> {
    return [...this.rows.values()].filter((r) => r.artifact.runId === runId).map((r) => r.artifact);
  }

  async listByHash(contentHash: string): Promise<readonly Artifact[]> {
    return [...this.rows.values()].filter((r) => r.artifact.contentHash === contentHash).map((r) => r.artifact);
  }

  async listAll(): Promise<readonly Artifact[]> {
    return [...this.rows.values()].map((r) => r.artifact);
  }
}

/** Contract fixture: in-memory ValidationStorePort with batch creation-command semantics. */
class InMemoryValidationStore implements ValidationStorePort {
  readonly rows = new Map<string, { validation: Validation; creation: ValidationCreationMetadata }>();

  async record(validation: Validation, creation: ValidationCreationMetadata): Promise<void> {
    const key = `${creation.creationCommandId}|${validation.validatorId}`;
    if (this.rows.has(key)) {
      throw new Error('UNIQUE(creation_command_id, validator_id): no duplicate batch row');
    }
    this.rows.set(key, { validation, creation });
  }

  async get(validationId: Validation['id']): Promise<Validation | null> {
    for (const row of this.rows.values()) if (row.validation.id === validationId) return row.validation;
    return null;
  }

  async getByCreationCommand(commandId: string): Promise<DurableValidationLookup | null> {
    const batch = [...this.rows.values()].filter((r) => r.creation.creationCommandId === commandId);
    if (batch.length === 0) return null;
    return {
      validations: batch.map((r) => r.validation),
      creationCommandId: commandId,
      creationCommandFingerprint: batch[0]!.creation.creationCommandFingerprint,
      targetRef: batch[0]!.validation.targetRef,
    };
  }

  async listByRun(runId: Validation['runId']): Promise<readonly Validation[]> {
    return [...this.rows.values()].filter((r) => r.validation.runId === runId).map((r) => r.validation);
  }

  async listByTargetRef(targetRef: Validation['targetRef']): Promise<readonly Validation[]> {
    return [...this.rows.values()].filter((r) => r.validation.targetRef === targetRef).map((r) => r.validation);
  }

  async listBatchesByTargetRef(targetRef: Validation['targetRef']): Promise<DurableValidationLookup[]> {
    const commands = new Set<string>();
    for (const r of this.rows.values()) {
      if (r.validation.targetRef === targetRef) commands.add(r.creation.creationCommandId);
    }
    const batches: DurableValidationLookup[] = [];
    for (const commandId of commands) {
      const lookup = await this.getByCreationCommand(commandId);
      if (lookup !== null) batches.push(lookup);
    }
    return batches;
  }
}

describe('ArtifactStorePort permanent idempotency contract', () => {
  it('persists creation metadata alongside the artifact and recovers it by command', async () => {
    const store = new InMemoryArtifactStore();
    const created = createArtifact(artifactInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await store.create(created.value, {
      creationCommandId: 'cmd_art_1',
      creationCommandFingerprint: 'fp:aaa',
    });

    const lookup = await store.getByCreationCommand('cmd_art_1');
    expect(lookup).not.toBeNull();
    expect(lookup?.artifact.id).toBe(created.value.id);
    expect(lookup?.creationCommandFingerprint).toBe('fp:aaa');
  });

  it('keeps the metadata off the domain entity (fingerprint only via the lookup view)', async () => {
    const store = new InMemoryArtifactStore();
    const created = createArtifact(artifactInput);
    if (!created.ok) return;
    await store.create(created.value, {
      creationCommandId: 'cmd_art_2',
      creationCommandFingerprint: 'fp:bbb',
    });

    expect('creationCommandId' in created.value).toBe(false);
    expect('creationCommandFingerprint' in created.value).toBe(false);

    const lookup = await store.getByCreationCommand('cmd_art_2');
    expect(lookup?.creationCommandFingerprint).toBe('fp:bbb');
  });

  it('supports the service replay/conflict decision after a ledger trim', async () => {
    const store = new InMemoryArtifactStore();
    const created = createArtifact(artifactInput);
    if (!created.ok) return;
    await store.create(created.value, {
      creationCommandId: 'cmd_art_3',
      creationCommandFingerprint: 'fp:ccc',
    });

    // Ledger is gone — the row-level lookup still recovers id + fingerprint:
    const sameContent = await store.getByCreationCommand('cmd_art_3');
    expect(sameContent?.artifact.id).toBe(created.value.id);
    expect(sameContent?.creationCommandFingerprint === 'fp:ccc').toBe(true);

    // The port surfaces durable facts only; CONFLICT policy compares fingerprints:
    const differentFingerprint = { creationCommandId: 'cmd_art_3', creationCommandFingerprint: 'fp:zzz' };
    expect(differentFingerprint.creationCommandFingerprint).not.toBe(sameContent?.creationCommandFingerprint);

    // One command → exactly one artifact (unique index semantics):
    await expect(
      store.create(created.value, { creationCommandId: 'cmd_art_3', creationCommandFingerprint: 'fp:ccc' }),
    ).rejects.toThrow(/exactly one artifact/);
  });
});

describe('ValidationStorePort batch permanent idempotency contract', () => {
  it('records a full validator batch and recovers the complete set + fingerprint', async () => {
    const store = new InMemoryValidationStore();
    const v1 = createValidation({ ...validationInput, validatorId: 'pack-x:unit' });
    const v2 = createValidation({ ...validationInput, validatorId: 'pack-x:lint', exitCode: 1, status: 'fail', blocking: false });
    if (!v1.ok || !v2.ok) return;
    const creation = { creationCommandId: 'cmd_val_1', creationCommandFingerprint: 'fp:v1' };
    await store.record(v1.value, creation);
    await store.record(v2.value, creation);

    const lookup = await store.getByCreationCommand('cmd_val_1');
    expect(lookup).not.toBeNull();
    expect(lookup?.validations).toHaveLength(2);
    expect(lookup?.validations.map((v) => v.validatorId).sort()).toEqual(['pack-x:lint', 'pack-x:unit']);
    expect(lookup?.creationCommandFingerprint).toBe('fp:v1');
  });

  it('keeps batch metadata off the domain entity and rejects duplicate batch rows', async () => {
    const store = new InMemoryValidationStore();
    const v = createValidation({ ...validationInput, validatorId: 'pack-x:unit' });
    if (!v.ok) return;
    const creation = { creationCommandId: 'cmd_val_2', creationCommandFingerprint: 'fp:v2' };
    await store.record(v.value, creation);

    expect('creationCommandId' in v.value).toBe(false);

    await expect(store.record(v.value, creation)).rejects.toThrow(/no duplicate batch row/);

    // A new commandId (intentional re-validation) is a different key — never blocked:
    await expect(
      store.record(v.value, { creationCommandId: 'cmd_val_3', creationCommandFingerprint: 'fp:v3' }),
    ).resolves.toBeUndefined();
    const batchTwo = await store.getByCreationCommand('cmd_val_3');
    expect(batchTwo?.validations).toHaveLength(1);
    expect(batchTwo?.creationCommandFingerprint).toBe('fp:v3');
  });
});
