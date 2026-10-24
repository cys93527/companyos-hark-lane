/**
 * EntityStore — the Core persistence port implemented on SQLite (ADR-0001).
 *
 * Sprint 0 stores entities as JSON documents keyed by id and namespaced by
 * `kind`. That is deliberately dumb: the domain aggregates (workflow templates,
 * runs, handoffs) only exist as data at this point, and every read goes back
 * through the domain factory that owns its invariants. Normalised tables arrive
 * per bounded context from Sprint 3 onwards.
 */
import type { EntityStore as CoreEntityStore, Page, PageRequest } from '@companyos/core';

import type { Database } from './db.js';

export interface JsonEntity {
  readonly id: string;
}

export interface EntityClock {
  nowIso(): string;
}

export interface CreateEntityStoreOptions {
  readonly db: Database;
  /** Namespace for this store, e.g. `workflow_template`. */
  readonly kind: string;
  readonly clock: EntityClock;
}

export interface EntityStore<T extends JsonEntity> extends CoreEntityStore<T> {
  count(): Promise<number>;
  has(id: string): Promise<boolean>;
}

const ORDER_COLUMNS = {
  id: 'id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export type EntityOrderBy = keyof typeof ORDER_COLUMNS;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const toEntity = <T extends JsonEntity>(row: unknown): T => {
  const record = row as { doc: string };
  return JSON.parse(record.doc) as T;
};

export function createEntityStore<T extends JsonEntity>(
  options: CreateEntityStoreOptions,
): EntityStore<T> {
  const { db, kind, clock } = options;

  const orderColumn = (page: PageRequest | undefined): string => {
    const requested = (page?.orderBy ?? 'createdAt') as EntityOrderBy;
    const column = ORDER_COLUMNS[requested];
    if (column === undefined) {
      throw new TypeError(
        `Unsupported orderBy "${String(page?.orderBy)}"; expected one of ${Object.keys(ORDER_COLUMNS).join(', ')}`,
      );
    }
    return column;
  };

  return {
    async get(id: string): Promise<T | null> {
      const row = db.prepare('SELECT doc FROM entities WHERE kind = ? AND id = ?').get(kind, id);
      return row === undefined ? null : toEntity<T>(row);
    },

    async has(id: string): Promise<boolean> {
      const row = db.prepare('SELECT 1 AS present FROM entities WHERE kind = ? AND id = ?').get(kind, id);
      return row !== undefined;
    },

    async put(entity: T): Promise<void> {
      const now = clock.nowIso();
      db.prepare(
        `INSERT INTO entities (id, kind, doc, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
      ).run(entity.id, kind, JSON.stringify(entity), now, now);
    },

    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM entities WHERE kind = ? AND id = ?').run(kind, id);
      return Number(result.changes) > 0;
    },

    async list(page: PageRequest = {}): Promise<Page<T>> {
      const limit = Math.min(Math.max(page.limit ?? DEFAULT_LIMIT, 0), MAX_LIMIT);
      const offset = Math.max(page.offset ?? 0, 0);
      const direction = page.descending === true ? 'DESC' : 'ASC';
      const column = orderColumn(page);
      const rows = db
        .prepare(
          `SELECT doc FROM entities WHERE kind = ?
           ORDER BY ${column} ${direction}, id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(kind, limit, offset);
      const totalRow = db.prepare('SELECT COUNT(*) AS total FROM entities WHERE kind = ?').get(kind);
      const total = Number((totalRow as { total: number | bigint } | undefined)?.total ?? 0);
      return { items: rows.map((row) => toEntity<T>(row)), total, offset, limit };
    },

    async count(): Promise<number> {
      const row = db.prepare('SELECT COUNT(*) AS total FROM entities WHERE kind = ?').get(kind);
      return Number((row as { total: number | bigint } | undefined)?.total ?? 0);
    },
  };
}
