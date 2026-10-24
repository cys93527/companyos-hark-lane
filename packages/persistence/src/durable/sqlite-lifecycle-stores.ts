/**
 * Durable `EntityStore<TemplateLock>` / `EntityStore<ChangeProposal>` /
 * `EntityStore<RunSnapshot>` (Sprint 4 requirements 3, 4, 10, 14, 16).
 *
 * The partial unique index `idx_locks_one_active` is what actually prevents a
 * concurrent double publish: the second INSERT of an active lock for the same template
 * fails with a UNIQUE violation, surfaced here as `CONFLICT/lock_held`.
 */
import type {
  ChangeProposal,
  EntityStore,
  Page,
  PageRequest,
  RunSnapshot,
  TemplateLock,
} from '@companyos/core';
import { DomainError } from '@companyos/core';

import type { Database } from '../db.js';

const conflict = (message: string, details: Record<string, unknown>): DomainError =>
  new DomainError('CONFLICT', message, { details });

const isUniqueViolation = (error: unknown): boolean =>
  /UNIQUE/i.test(error instanceof Error ? error.message : String(error));

/* ------------------------------------------------------------------- locks ---- */

interface LockRow {
  readonly id: string;
  readonly template_id: string;
  readonly version_id: string;
  readonly scope: string;
  readonly reason: string;
  readonly locked_by: string;
  readonly locked_at: string;
  readonly released_at: string | null;
  readonly released_by: string | null;
}

export function createSqliteLockStore(db: Database): EntityStore<TemplateLock> {
  const upsert = db.prepare(
    `INSERT INTO workflow_template_locks (id, template_id, version_id, scope, reason, locked_by,
       locked_at, released_at, released_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET released_at = excluded.released_at, released_by = excluded.released_by`,
  );

  const fromRow = (row: LockRow): TemplateLock => ({
    id: row.id,
    templateId: row.template_id,
    versionId: row.version_id,
    scope: row.scope as TemplateLock['scope'],
    reason: row.reason,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    releasedAt: row.released_at,
    releasedBy: row.released_by,
  });

  return {
    async get(id: string): Promise<TemplateLock | null> {
      const row = db.prepare('SELECT * FROM workflow_template_locks WHERE id = ?').get(id) as
        | LockRow
        | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: TemplateLock): Promise<void> {
      try {
        upsert.run(
          entity.id,
          entity.templateId,
          entity.versionId,
          entity.scope,
          entity.reason,
          entity.lockedBy,
          entity.lockedAt,
          entity.releasedAt,
          entity.releasedBy,
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict(`Template ${entity.templateId} already has an active lock.`, {
            templateId: entity.templateId,
            incomingLockId: entity.id,
            reason: 'lock_held',
          });
        }
        throw error;
      }
    },
    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM workflow_template_locks WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<TemplateLock>> {
      const limit = Math.min(Math.max(page.limit ?? 50, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM workflow_template_locks ORDER BY locked_at ASC, id ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as LockRow[];
      const totalRow = db.prepare('SELECT COUNT(*) AS total FROM workflow_template_locks').get() as {
        total: number | bigint;
      };
      return { items: rows.map(fromRow), total: Number(totalRow.total), offset, limit };
    },
  };
}

/** Active lock of a template, or null — the DB is the authority (partial index). */
export function activeLockOf(db: Database, templateId: string): TemplateLock | null {
  const row = db
    .prepare('SELECT * FROM workflow_template_locks WHERE template_id = ? AND released_at IS NULL LIMIT 1')
    .get(templateId) as LockRow | undefined;
  if (row === undefined) return null;
  return {
    id: row.id,
    templateId: row.template_id,
    versionId: row.version_id,
    scope: row.scope as TemplateLock['scope'],
    reason: row.reason,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    releasedAt: row.released_at,
    releasedBy: row.released_by,
  };
}

/* --------------------------------------------------------------- proposals ---- */

interface ProposalRow {
  readonly id: string;
  readonly target_template_id: string;
  readonly base_version_id: string;
  readonly rationale: string;
  readonly ops_json: string;
  readonly author_id: string;
  readonly status: string;
  readonly created_at: string;
  readonly decided_by: string | null;
  readonly decided_at: string | null;
  readonly decision_note: string | null;
}

export function createSqliteProposalStore(db: Database): EntityStore<ChangeProposal> {
  const upsert = db.prepare(
    `INSERT INTO workflow_change_requests (id, target_template_id, base_version_id, rationale, ops_json,
       author_id, status, created_at, decided_by, decided_at, decision_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       decided_by = excluded.decided_by,
       decided_at = excluded.decided_at,
       decision_note = excluded.decision_note`,
  );

  const fromRow = (row: ProposalRow): ChangeProposal => ({
    id: row.id,
    targetTemplateId: row.target_template_id,
    baseVersionId: row.base_version_id,
    rationale: row.rationale,
    ops: JSON.parse(row.ops_json) as ChangeProposal['ops'],
    authorId: row.author_id,
    status: row.status as ChangeProposal['status'],
    createdAt: row.created_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
  });

  return {
    async get(id: string): Promise<ChangeProposal | null> {
      const row = db.prepare('SELECT * FROM workflow_change_requests WHERE id = ?').get(id) as
        | ProposalRow
        | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: ChangeProposal): Promise<void> {
      try {
        upsert.run(
          entity.id,
          entity.targetTemplateId,
          entity.baseVersionId,
          entity.rationale,
          JSON.stringify(entity.ops),
          entity.authorId,
          entity.status,
          entity.createdAt,
          entity.decidedBy,
          entity.decidedAt,
          entity.decisionNote,
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict(
            `Template ${entity.targetTemplateId} already has an OPEN proposal against that version.`,
            { templateId: entity.targetTemplateId, baseVersionId: entity.baseVersionId, reason: 'open_proposal_exists' },
          );
        }
        throw error;
      }
    },
    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM workflow_change_requests WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<ChangeProposal>> {
      const limit = Math.min(Math.max(page.limit ?? 50, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM workflow_change_requests ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as ProposalRow[];
      const totalRow = db.prepare('SELECT COUNT(*) AS total FROM workflow_change_requests').get() as {
        total: number | bigint;
      };
      return { items: rows.map(fromRow), total: Number(totalRow.total), offset, limit };
    },
  };
}

/* --------------------------------------------------------------- snapshots ---- */

interface SnapshotRow {
  readonly id: string;
  readonly run_id: string;
  readonly org_id: string;
  readonly template_id: string;
  readonly workflow_version_id: string;
  readonly template_lock_id: string;
  readonly pack_versions_json: string;
  readonly model_bindings_json: string;
  readonly memory_view_ref: string;
  readonly snapshot_hash: string;
  readonly created_at: string;
  readonly created_by: string;
}

export function createSqliteSnapshotStore(db: Database): EntityStore<RunSnapshot> {
  const upsert = db.prepare(
    `INSERT INTO run_snapshots (id, run_id, org_id, template_id, workflow_version_id, template_lock_id,
       pack_versions_json, model_bindings_json, memory_view_ref, snapshot_hash, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       snapshot_hash = excluded.snapshot_hash`,
  );

  const fromRow = (row: SnapshotRow): RunSnapshot => ({
    id: row.id,
    snapshotId: row.id,
    runId: row.run_id,
    orgId: row.org_id,
    templateId: row.template_id,
    workflowVersionId: row.workflow_version_id,
    templateLockId: row.template_lock_id,
    packVersions: JSON.parse(row.pack_versions_json) as Record<string, string>,
    modelBindings: JSON.parse(row.model_bindings_json) as Record<string, string>,
    memoryViewRef: row.memory_view_ref,
    snapshotHash: row.snapshot_hash,
    createdAt: row.created_at,
    createdBy: row.created_by,
  });

  return {
    async get(id: string): Promise<RunSnapshot | null> {
      const row = db.prepare('SELECT * FROM run_snapshots WHERE id = ?').get(id) as SnapshotRow | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: RunSnapshot): Promise<void> {
      upsert.run(
        entity.id,
        entity.runId,
        entity.orgId,
        entity.templateId,
        entity.workflowVersionId,
        entity.templateLockId,
        JSON.stringify(entity.packVersions),
        JSON.stringify(entity.modelBindings),
        entity.memoryViewRef,
        entity.snapshotHash,
        entity.createdAt,
        entity.createdBy,
      );
    },
    async delete(id: string): Promise<boolean> {
      // A pinned snapshot is part of a run's audit record: never deleted.
      throw conflict(`Run snapshot ${id} cannot be deleted (it is the run's audit record).`, {
        snapshotId: id,
      });
    },
    async list(page: PageRequest = {}): Promise<Page<RunSnapshot>> {
      const limit = Math.min(Math.max(page.limit ?? 50, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM run_snapshots ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as SnapshotRow[];
      const totalRow = db.prepare('SELECT COUNT(*) AS total FROM run_snapshots').get() as {
        total: number | bigint;
      };
      return { items: rows.map(fromRow), total: Number(totalRow.total), offset, limit };
    },
  };
}

/** Snapshot pinned by a run (Sprint 4 requirement 10). */
export async function snapshotOfRun(db: Database, runId: string): Promise<RunSnapshot | null> {
  const row = db.prepare('SELECT id FROM run_snapshots WHERE run_id = ?').get(runId) as
    | { id: string }
    | undefined;
  if (row === undefined) return null;
  // Reuse the store's row mapper instead of casting (the previous version promised a
  // synchronous RunSnapshot but returned a Promise — Sprint 4 review MEDIUM-1).
  return createSqliteSnapshotStore(db).get(row.id);
}
