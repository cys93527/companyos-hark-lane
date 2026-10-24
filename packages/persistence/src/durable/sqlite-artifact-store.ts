/**
 * Durable artifact store (Sprint 13 — ADR-0015).
 *
 * Immutable evidence persistence (Option A): INSERT-only — there is no UPDATE or DELETE
 * statement here, and none may be added without a new ADR.
 *
 * Permanent creation idempotency (Option B): `creation_command_id` /
 * `creation_command_fingerprint` are stored as ROW METADATA next to the artifact, never
 * on the domain `Artifact` type. `getByCreationCommand` returns the durable facts
 * (artifact + fingerprint) so the ArtifactService can decide replay vs CONFLICT after
 * the bounded command ledger trimmed the command; this store never makes that decision.
 */
import {
  DomainError,
  isContentHash,
  type Artifact,
  type ArtifactCreationMetadata,
  type ArtifactId,
  type ArtifactStorePort,
  type DurableArtifactLookup,
  type WorkflowRunId,
} from '@companyos/core';

import type { Database } from '../db.js';

interface ArtifactRow {
  readonly artifact_id: string;
  readonly run_id: string;
  readonly task_id: string | null;
  readonly kind: string;
  readonly content_ref: string;
  readonly content_hash: string;
  readonly size_bytes: number | bigint;
  readonly produced_by: string;
  readonly created_at: string;
  readonly creation_command_id: string | null;
  readonly creation_command_fingerprint: string | null;
}

/** Storage-layer integrity guard: a recovered artifact must still satisfy its invariants. */
const toArtifact = (row: ArtifactRow): Artifact => {
  const sizeBytes = Number(row.size_bytes);
  if (!isContentHash(row.content_hash) || row.kind.trim() === '' || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `Artifact row "${row.artifact_id}" is corrupt: recovered shape violates the domain invariants.`,
      { details: { artifactId: row.artifact_id, reason: 'ARTIFACT_ROW_CORRUPT' } },
    );
  }
  return {
    id: row.artifact_id as Artifact['id'],
    runId: row.run_id as Artifact['runId'],
    taskId: row.task_id as Artifact['taskId'],
    kind: row.kind,
    contentRef: row.content_ref,
    contentHash: row.content_hash,
    sizeBytes,
    producedBy: row.produced_by,
    createdAt: row.created_at,
  };
};

export function createSqliteArtifactStore(db: Database): ArtifactStorePort {
  return {
    async create(artifact: Artifact, creation: ArtifactCreationMetadata): Promise<void> {
      try {
        db.prepare(
          `INSERT INTO artifacts (
             artifact_id, run_id, task_id, kind, content_ref, content_hash, size_bytes,
             produced_by, created_at, creation_command_id, creation_command_fingerprint
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          artifact.id,
          artifact.runId,
          artifact.taskId,
          artifact.kind,
          artifact.contentRef,
          artifact.contentHash,
          artifact.sizeBytes,
          artifact.producedBy,
          artifact.createdAt,
          creation.creationCommandId,
          creation.creationCommandFingerprint,
        );
      } catch (error) {
        if (error instanceof Error && /UNIQUE|PRIMARY KEY|constraint/i.test(error.message)) {
          // Exactly one artifact per creation command (ADR-0015 decision 15). The service
          // normally replays before reaching the INSERT; reaching it means a duplicate.
          throw new DomainError(
            'CONFLICT',
            `Artifact creation command "${creation.creationCommandId}" already produced an artifact.`,
            {
              details: {
                reason: 'ARTIFACT_CREATION_COMMAND_EXISTS',
                creationCommandId: creation.creationCommandId,
                artifactId: artifact.id,
              },
            },
          );
        }
        throw error;
      }
    },

    async get(artifactId: ArtifactId): Promise<Artifact | null> {
      const row = db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifactId) as
        | ArtifactRow
        | undefined;
      return row === undefined ? null : toArtifact(row);
    },

    async getByCreationCommand(creationCommandId: string): Promise<DurableArtifactLookup | null> {
      const row = db
        .prepare('SELECT * FROM artifacts WHERE creation_command_id = ?')
        .get(creationCommandId) as ArtifactRow | undefined;
      if (row === undefined) return null;
      return {
        artifact: toArtifact(row),
        creationCommandId: row.creation_command_id ?? creationCommandId,
        creationCommandFingerprint: row.creation_command_fingerprint ?? '',
      };
    },

    async listByRun(runId: WorkflowRunId): Promise<readonly Artifact[]> {
      const rows = db
        .prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at DESC, artifact_id DESC')
        .all(runId) as readonly ArtifactRow[];
      return rows.map(toArtifact);
    },

    async listByHash(contentHash: string): Promise<readonly Artifact[]> {
      // Same bytes may legitimately back several artifact identities (identity ≠ content
      // identity); deterministic order by id.
      const rows = db
        .prepare('SELECT * FROM artifacts WHERE content_hash = ? ORDER BY artifact_id ASC')
        .all(contentHash) as readonly ArtifactRow[];
      return rows.map(toArtifact);
    },

    async listAll(): Promise<readonly Artifact[]> {
      // Startup reconciliation enumeration (Task-13-10). Every row re-validates through
      // the store's integrity guard — a corrupt durable row FAILS the enumeration
      // (fail closed), never silently skips.
      const rows = db
        .prepare('SELECT * FROM artifacts ORDER BY created_at ASC, artifact_id ASC')
        .all() as readonly ArtifactRow[];
      return rows.map(toArtifact);
    },
  };
}
