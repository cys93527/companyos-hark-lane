/**
 * Durable `EntityStore<WorkflowTemplate>` (Sprint 4 requirements 1–2, 8, 16).
 *
 * The aggregate keeps its versions inline (`WorkflowTemplate.versions`), so this store
 * splits them into `workflow_template_versions` on write and reassembles on read.
 *
 * **Immutability is enforced at the storage layer**, not only in Core: a RELEASED
 * version row (semver without `-draft`) may never change again. A draft row may be
 * updated exactly once — when it is released (`1.3.0-draft` → `1.3.0`).
 */
import type { EntityStore, Page, PageRequest, WorkflowTemplate, WorkflowVersion } from '@companyos/core';
import { DomainError, err, isDraftSemver, ok, versionSnapshotHash, type Result } from '@companyos/core';

import type { Database } from '../db.js';

interface TemplateRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly state: string;
  readonly current_version_id: string | null;
  readonly draft_version_id: string | null;
  readonly forked_from_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
}

interface VersionRow {
  readonly id: string;
  readonly template_id: string;
  readonly semver: string;
  readonly content_hash: string;
  readonly snapshot_hash: string;
  readonly graph_json: string;
  readonly change_proposal_id: string | null;
  readonly created_at: string;
  readonly created_by: string;
}

const conflict = (message: string, details: Record<string, unknown>): DomainError =>
  new DomainError('CONFLICT', message, { details });

const isUniqueViolation = (error: unknown): boolean =>
  /UNIQUE/i.test(error instanceof Error ? error.message : String(error));

/**
 * The template-creation guard (T20-05 permanent identity): a PLAIN insert arbitrated by
 * the PRIMARY KEY, with the immutable creation seed (orgId/name) deciding replay vs
 * conflict. Mutable lifecycle state (state/versions/current version) is NOT seed — a
 * raced row that already advanced still replays.
 */
export interface TemplateCreationGuardedStore {
  putGuarded(entity: WorkflowTemplate): Promise<
    Result<{ readonly templateId: string; readonly replayed: boolean }, DomainError>
  >;
}

export function createSqliteTemplateStore(db: Database): EntityStore<WorkflowTemplate> & TemplateCreationGuardedStore {
  // Creation insert: NO upsert — a same-id race must hit the PRIMARY KEY, not clobber
  // the canonical row.
  const insertCreation = db.prepare(
    `INSERT INTO workflow_templates (id, org_id, name, state, current_version_id, draft_version_id,
       forked_from_json, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const upsertTemplate = db.prepare(
    `INSERT INTO workflow_templates (id, org_id, name, state, current_version_id, draft_version_id,
       forked_from_json, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       state = excluded.state,
       current_version_id = excluded.current_version_id,
       draft_version_id = excluded.draft_version_id,
       updated_at = excluded.updated_at`,
  );
  const upsertVersion = db.prepare(
    `INSERT INTO workflow_template_versions (id, template_id, semver, content_hash, snapshot_hash,
       graph_json, change_proposal_id, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       semver = excluded.semver,
       content_hash = excluded.content_hash,
       snapshot_hash = excluded.snapshot_hash,
       graph_json = excluded.graph_json`,
  );
  const findVersion = db.prepare('SELECT * FROM workflow_template_versions WHERE id = ?');

  const readVersions = (templateId: string): readonly WorkflowVersion[] =>
    (
      db
        .prepare(
          'SELECT * FROM workflow_template_versions WHERE template_id = ? ORDER BY created_at ASC, id ASC',
        )
        .all(templateId) as VersionRow[]
    ).map((row) => ({
      id: row.id,
      templateId: row.template_id,
      semver: row.semver,
      contentHash: row.content_hash,
      graph: JSON.parse(row.graph_json) as WorkflowVersion['graph'],
      createdAt: row.created_at,
      createdBy: row.created_by,
      changeProposalId: row.change_proposal_id,
      immutable: true,
    }));

  const fromRow = (row: TemplateRow): WorkflowTemplate => ({
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    state: row.state as WorkflowTemplate['state'],
    currentVersionId: row.current_version_id,
    draftVersionId: row.draft_version_id,
    versions: readVersions(row.id),
    forkedFrom:
      row.forked_from_json === null
        ? null
        : (JSON.parse(row.forked_from_json) as WorkflowTemplate['forkedFrom']),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  });

  const readTemplate = async (id: string): Promise<WorkflowTemplate | null> => {
    const row = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(id) as
      | TemplateRow
      | undefined;
    return row === undefined ? null : fromRow(row);
  };

  const seedConflict = (id: string): DomainError =>
    new DomainError('CONFLICT', `Template "${id}" already exists with a different immutable creation seed.`, {
      details: { reason: 'TEMPLATE_IDENTITY_SEED_CONFLICT', templateId: id },
    });

  return {
    async get(id: string): Promise<WorkflowTemplate | null> {
      const row = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(id) as
        | TemplateRow
        | undefined;
      return row === undefined ? null : fromRow(row);
    },

    async putGuarded(
      entity: WorkflowTemplate,
    ): Promise<Result<{ readonly templateId: string; readonly replayed: boolean }, DomainError>> {
      // Single synchronous connection: load-compare-insert has no interleaving window; the
      // PRIMARY KEY is the final arbiter for any same-id race. Seed = orgId + name only.
      const existing = await readTemplate(entity.id);
      if (existing !== null) {
        if (existing.orgId !== entity.orgId || existing.name !== entity.name) {
          return err(seedConflict(entity.id));
        }
        return ok({ templateId: entity.id, replayed: true });
      }
      try {
        insertCreation.run(
          entity.id, entity.orgId, entity.name, entity.state, entity.currentVersionId,
          entity.draftVersionId, entity.forkedFrom === null ? null : JSON.stringify(entity.forkedFrom),
          entity.createdAt, entity.updatedAt, entity.createdBy,
        );
        return ok({ templateId: entity.id, replayed: false });
      } catch (error) {
        if (!/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) throw error;
        const raced = await readTemplate(entity.id);
        if (raced === null) throw error;
        if (raced.orgId !== entity.orgId || raced.name !== entity.name) {
          return err(seedConflict(entity.id));
        }
        return ok({ templateId: entity.id, replayed: true });
      }
    },
    async put(entity: WorkflowTemplate): Promise<void> {
      // 1. Immutability guard for RELEASED versions (requirement 8).
      for (const version of entity.versions) {
        const row = findVersion.get(version.id) as VersionRow | undefined;
        if (row === undefined) continue;
        const unchanged =
          row.semver === version.semver &&
          row.content_hash === version.contentHash &&
          row.graph_json === JSON.stringify(version.graph);
        if (!isDraftSemver(row.semver) && !unchanged) {
          throw conflict(
            `Version ${version.id} ("${row.semver}") is released and immutable; it cannot be rewritten.`,
            {
              templateId: entity.id,
              versionId: version.id,
              storedSemver: row.semver,
              incomingSemver: version.semver,
            },
          );
        }
      }

      upsertTemplate.run(
        entity.id,
        entity.orgId,
        entity.name,
        entity.state,
        entity.currentVersionId,
        entity.draftVersionId,
        entity.forkedFrom === null ? null : JSON.stringify(entity.forkedFrom),
        entity.createdAt,
        entity.updatedAt,
        entity.createdBy,
      );

      for (const version of entity.versions) {
        try {
          upsertVersion.run(            version.id,
            version.templateId,
            version.semver,
            version.contentHash,
            versionSnapshotHash(version),
            JSON.stringify(version.graph),
            version.changeProposalId,
            version.createdAt,
            version.createdBy,
          );
        } catch (error) {
          // Requirement M: duplicate version number, caught by the UNIQUE index.
          if (isUniqueViolation(error)) {
            throw conflict(`Duplicate version number "${version.semver}" for template ${entity.id}.`, {
              templateId: entity.id,
              semver: version.semver,
            });
          }
          throw error;
        }
      }

      // Only DRAFT rows may ever disappear (e.g. the draft superseded by a release);
      // released versions are never deleted, so history stays intact.
      const draftIds = entity.versions.filter((version) => isDraftSemver(version.semver)).map((version) => version.id);
      if (draftIds.length === 0) {
        db.prepare(
          "DELETE FROM workflow_template_versions WHERE template_id = ? AND semver LIKE '%-draft'",
        ).run(entity.id);
      } else {
        const placeholders = draftIds.map(() => '?').join(', ');
        db.prepare(
          `DELETE FROM workflow_template_versions WHERE template_id = ? AND semver LIKE '%-draft' AND id NOT IN (${placeholders})`,
        ).run(entity.id, ...draftIds);
      }
    },

    async delete(id: string): Promise<boolean> {
      // Templates are archived, never deleted (requirement 13: Archived is read-only and
      // retained for audit).
      throw conflict(`Template ${id} cannot be deleted; archive it instead.`, { templateId: id });
    },

    async list(page: PageRequest = {}): Promise<Page<WorkflowTemplate>> {
      const limit = Math.min(Math.max(page.limit ?? 50, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const direction = page.descending === true ? 'DESC' : 'ASC';
      const rows = db
        .prepare(
          `SELECT * FROM workflow_templates ORDER BY created_at ${direction}, id ASC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as TemplateRow[];
      const totalRow = db.prepare('SELECT COUNT(*) AS total FROM workflow_templates').get() as {
        total: number | bigint;
      };
      return { items: rows.map(fromRow), total: Number(totalRow.total), offset, limit };
    },
  };
}
