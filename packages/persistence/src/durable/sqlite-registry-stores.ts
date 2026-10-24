/**
 * Durable stores for the Model Registry (Sprint 7): curated model records + aliases.
 */
import type {
  EntityStore,
  LogicalAlias,
  ModelRecord,
  Page,
  PageRequest,
} from '@companyos/core';

import type { Database } from '../db.js';

const json = (value: unknown): string => JSON.stringify(value ?? null);
const parse = <T>(value: string | null): T | null =>
  value === null || value === '' ? null : (JSON.parse(value) as T);

interface ModelRow {
  readonly id: string;
  readonly model_key: string;
  readonly provider_id: string;
  readonly provider_model_id: string;
  readonly display_name: string;
  readonly description: string;
  readonly capabilities: string;
  readonly context_window: number | bigint;
  readonly max_output: number | bigint | null;
  readonly pricing: string | null;
  readonly enabled: number | bigint;
  readonly availability: string;
  readonly metadata: string | null;
  readonly registered_at: string;
  readonly updated_at: string;
  readonly registered_by: string;
}

export function createSqliteModelRecordStore(db: Database): EntityStore<ModelRecord> {
  const upsert = db.prepare(
    `INSERT INTO model_records (id, model_key, provider_id, provider_model_id, display_name, description,
       capabilities, context_window, max_output, pricing, enabled, availability, metadata,
       registered_at, updated_at, registered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       description = excluded.description,
       capabilities = excluded.capabilities,
       context_window = excluded.context_window,
       max_output = excluded.max_output,
       pricing = excluded.pricing,
       enabled = excluded.enabled,
       availability = excluded.availability,
       metadata = excluded.metadata,
       updated_at = excluded.updated_at`,
  );

  const fromRow = (row: ModelRow): ModelRecord => ({
    id: row.id,
    modelKey: row.model_key,
    providerId: row.provider_id,
    providerModelId: row.provider_model_id,
    displayName: row.display_name,
    description: row.description,
    capabilities: JSON.parse(row.capabilities) as ModelRecord['capabilities'],
    contextWindow: Number(row.context_window),
    maxOutputTokens: row.max_output === null ? null : Number(row.max_output),
    pricing: parse<ModelRecord['pricing']>(row.pricing),
    enabled: Number(row.enabled) === 1,
    availability: row.availability as ModelRecord['availability'],
    metadata: parse<Readonly<Record<string, unknown>>>(row.metadata) ?? {},
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
    registeredBy: row.registered_by,
  });

  return {
    async get(id: string): Promise<ModelRecord | null> {
      const row = db.prepare('SELECT * FROM model_records WHERE id = ?').get(id) as ModelRow | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: ModelRecord): Promise<void> {
      /*
       * 42ed326 re-audit (N42-T1) — a ModelRegistry mutation (e.g. disabling a model) is an
       * INDEPENDENT durable mutation: it waits for legal access on the connection's write
       * fence, so an unrelated context's open transaction can never swallow it and a later
       * ROLLBACK can never revive a model the operator disabled.
       */
      await db.writeFence.mutation('model_records.put', async () => {
      upsert.run(
        entity.id,
        entity.modelKey,
        entity.providerId,
        entity.providerModelId,
        entity.displayName,
        entity.description,
        json(entity.capabilities),
        entity.contextWindow,
        entity.maxOutputTokens,
        entity.pricing === null ? null : json(entity.pricing),
        entity.enabled ? 1 : 0,
        entity.availability,
        json(entity.metadata),
        entity.registeredAt,
        entity.updatedAt,
        entity.registeredBy,
      );
      });
    },
    async delete(id: string): Promise<boolean> {
      return db.writeFence.mutation('model_records.delete', async () => {
        const result = db.prepare('DELETE FROM model_records WHERE id = ?').run(id);
        return Number(result.changes) > 0;
      });
    },
    async list(page: PageRequest = {}): Promise<Page<ModelRecord>> {
      const limit = Math.min(Math.max(page.limit ?? 100, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const direction = page.descending === true ? 'DESC' : 'ASC';
      const rows = db
        .prepare(`SELECT * FROM model_records ORDER BY model_key ${direction} LIMIT ? OFFSET ?`)
        .all(limit, offset) as ModelRow[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM model_records').get() as {
        total: number | bigint;
      };
      return { items: rows.map(fromRow), total: Number(total.total), offset, limit };
    },
  };
}

interface AliasRow {
  readonly id: string;
  readonly alias: string;
  readonly model_key: string;
  readonly scope: string;
  readonly created_at: string;
  readonly created_by: string;
}

export function createSqliteAliasStore(db: Database): EntityStore<LogicalAlias> {
  const upsert = db.prepare(
    `INSERT INTO logical_aliases (id, alias, model_key, scope, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET model_key = excluded.model_key`,
  );
  const fromRow = (row: AliasRow): LogicalAlias => ({
    id: row.id,
    alias: row.alias,
    modelKey: row.model_key,
    scope: row.scope,
    createdAt: row.created_at,
    createdBy: row.created_by,
  });

  return {
    async get(id: string): Promise<LogicalAlias | null> {
      const row = db.prepare('SELECT * FROM logical_aliases WHERE id = ?').get(id) as AliasRow | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: LogicalAlias): Promise<void> {
      await db.writeFence.mutation('logical_aliases.put', async () => {
        upsert.run(entity.id, entity.alias, entity.modelKey, entity.scope, entity.createdAt, entity.createdBy);
      });
    },
    async delete(id: string): Promise<boolean> {
      return db.writeFence.mutation('logical_aliases.delete', async () => {
        const result = db.prepare('DELETE FROM logical_aliases WHERE id = ?').run(id);
        return Number(result.changes) > 0;
      });
    },
    async list(page: PageRequest = {}): Promise<Page<LogicalAlias>> {
      const limit = Math.min(Math.max(page.limit ?? 200, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM logical_aliases ORDER BY scope ASC, alias ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as AliasRow[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM logical_aliases').get() as {
        total: number | bigint;
      };
      return { items: rows.map(fromRow), total: Number(total.total), offset, limit };
    },
  };
}
