/**
 * Durable stores for the provider layer (Sprint 6): roles, assignments, provider
 * registrations, model catalogue and secret REFERENCES.
 *
 * The secret store can only ever hold a pointer (provider + purpose + source); there is
 * no column for a key value, by construction.
 */
import type {
  EntityStore,
  HealthReport,
  Page,
  PageRequest,
  ProviderModelRecord,
  ProviderRegistration,
  Role,
  RoleAssignment,
  SecretRef,
} from '@companyos/core';

import type { Database } from '../db.js';

const json = (value: unknown): string => JSON.stringify(value ?? null);
const parse = <T>(value: string | null): T | null =>
  value === null || value === '' ? null : (JSON.parse(value) as T);

/* --------------------------------------------------------------------- roles --- */

interface RoleRow {
  readonly id: string;
  readonly company_id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly required_capabilities: string;
  readonly authority_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function createSqliteRoleStore(db: Database): EntityStore<Role> {
  const upsert = db.prepare(
    `INSERT INTO roles (id, company_id, key, name, description, required_capabilities, authority_json,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       required_capabilities = excluded.required_capabilities,
       authority_json = excluded.authority_json,
       updated_at = excluded.updated_at`,
  );
  const fromRow = (row: RoleRow): Role => ({
    id: row.id as Role['id'],
    companyId: row.company_id as Role['companyId'],
    key: row.key,
    name: row.name,
    description: row.description,
    requiredCapabilities: JSON.parse(row.required_capabilities) as readonly string[],
    authority: JSON.parse(row.authority_json) as readonly string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return {
    async get(id: string): Promise<Role | null> {
      const row = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as RoleRow | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: Role): Promise<void> {
      upsert.run(
        entity.id,
        entity.companyId,
        entity.key,
        entity.name,
        entity.description,
        json(entity.requiredCapabilities),
        json(entity.authority),
        entity.createdAt,
        entity.updatedAt,
      );
    },
    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM roles WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<Role>> {
      const limit = Math.min(Math.max(page.limit ?? 50, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM roles ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as RoleRow[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM roles').get() as { total: number | bigint };
      return { items: rows.map(fromRow), total: Number(total.total), offset, limit };
    },
  };
}

/* --------------------------------------------------------------- assignments --- */

interface AssignmentRow {
  readonly actor_id: string;
  readonly role_id: string;
  readonly assigned_at: string;
  readonly assigned_by: string;
}

export function createSqliteAssignmentStore(db: Database): EntityStore<RoleAssignment> {
  const upsert = db.prepare(
    `INSERT INTO role_assignments (actor_id, role_id, assigned_at, assigned_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(actor_id, role_id) DO UPDATE SET assigned_by = excluded.assigned_by`,
  );
  const fromRow = (row: AssignmentRow): RoleAssignment => ({
    id: `${row.actor_id}:${row.role_id}`,
    actorId: row.actor_id,
    roleId: row.role_id,
    assignedAt: row.assigned_at,
    assignedBy: row.assigned_by,
  });

  return {
    async get(id: string): Promise<RoleAssignment | null> {
      const [actorId, roleId] = id.split(':');
      const row = db
        .prepare('SELECT * FROM role_assignments WHERE actor_id = ? AND role_id = ?')
        .get(actorId ?? '', roleId ?? '') as AssignmentRow | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: RoleAssignment): Promise<void> {
      upsert.run(entity.actorId, entity.roleId, entity.assignedAt, entity.assignedBy);
    },
    async delete(id: string): Promise<boolean> {
      const result = db
        .prepare('DELETE FROM role_assignments WHERE actor_id = ? AND role_id = ?')
        .run(...(id.split(':') as [string, string]));
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<RoleAssignment>> {
      const limit = Math.min(Math.max(page.limit ?? 50, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM role_assignments ORDER BY actor_id ASC, role_id ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as AssignmentRow[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM role_assignments').get() as {
        total: number | bigint;
      };
      return { items: rows.map(fromRow), total: Number(total.total), offset, limit };
    },
  };
}

/* ---------------------------------------------------------------- providers --- */

interface ProviderRow {
  readonly provider_id: string;
  readonly kind: string;
  readonly display_name: string;
  readonly enabled: number | bigint;
  readonly last_health: string | null;
  readonly registered_at: string;
  readonly updated_at: string;
}

export function createSqliteProviderStore(db: Database): EntityStore<ProviderRegistration> {
  const upsert = db.prepare(
    `INSERT INTO providers (provider_id, kind, display_name, enabled, last_health, registered_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET
       kind = excluded.kind,
       display_name = excluded.display_name,
       enabled = excluded.enabled,
       last_health = excluded.last_health,
       updated_at = excluded.updated_at`,
  );
  const fromRow = (row: ProviderRow): ProviderRegistration => ({
    id: row.provider_id,
    providerId: row.provider_id,
    kind: row.kind,
    displayName: row.display_name,
    enabled: Number(row.enabled) === 1,
    lastHealth: parse<HealthReport>(row.last_health),
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  });

  return {
    async get(id: string): Promise<ProviderRegistration | null> {
      const row = db.prepare('SELECT * FROM providers WHERE provider_id = ?').get(id) as
        | ProviderRow
        | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: ProviderRegistration): Promise<void> {
      upsert.run(
        entity.providerId,
        entity.kind,
        entity.displayName,
        entity.enabled ? 1 : 0,
        entity.lastHealth === null ? null : json(entity.lastHealth),
        entity.registeredAt,
        entity.updatedAt,
      );
    },
    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM providers WHERE provider_id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<ProviderRegistration>> {
      const limit = Math.min(Math.max(page.limit ?? 50, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM providers ORDER BY registered_at ASC, provider_id ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as ProviderRow[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM providers').get() as { total: number | bigint };
      return { items: rows.map(fromRow), total: Number(total.total), offset, limit };
    },
  };
}

interface ModelRow {
  readonly provider_id: string;
  readonly model_id: string;
  readonly display_name: string;
  readonly context_window: number | bigint;
  readonly max_output: number | bigint | null;
  readonly capabilities: string;
  readonly pricing: string | null;
  readonly metadata: string | null;
  readonly updated_at: string;
}

export function createSqliteProviderModelStore(db: Database): EntityStore<ProviderModelRecord> {
  const upsert = db.prepare(
    `INSERT INTO provider_models (provider_id, model_id, display_name, context_window, max_output,
       capabilities, pricing, metadata, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET
       display_name = excluded.display_name,
       context_window = excluded.context_window,
       max_output = excluded.max_output,
       capabilities = excluded.capabilities,
       pricing = excluded.pricing,
       metadata = excluded.metadata,
       updated_at = excluded.updated_at`,
  );
  const fromRow = (row: ModelRow): ProviderModelRecord => ({
    id: `${row.provider_id}:${row.model_id}`,
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name,
    contextWindow: Number(row.context_window),
    maxOutputTokens: row.max_output === null ? null : Number(row.max_output),
    capabilities: JSON.parse(row.capabilities) as ProviderModelRecord['capabilities'],
    pricing: parse<ProviderModelRecord['pricing']>(row.pricing),
    metadata: parse<Readonly<Record<string, unknown>>>(row.metadata) ?? {},
    updatedAt: row.updated_at,
  });

  return {
    async get(id: string): Promise<ProviderModelRecord | null> {
      const [providerId, modelId] = id.split(':');
      const row = db
        .prepare('SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?')
        .get(providerId ?? '', modelId ?? '') as ModelRow | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: ProviderModelRecord): Promise<void> {
      upsert.run(
        entity.providerId,
        entity.modelId,
        entity.displayName,
        entity.contextWindow,
        entity.maxOutputTokens,
        json(entity.capabilities),
        entity.pricing === null ? null : json(entity.pricing),
        json(entity.metadata),
        entity.updatedAt,
      );
    },
    async delete(id: string): Promise<boolean> {
      const result = db
        .prepare('DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?')
        .run(...(id.split(':') as [string, string]));
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<ProviderModelRecord>> {
      const limit = Math.min(Math.max(page.limit ?? 50, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM provider_models ORDER BY provider_id ASC, model_id ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as ModelRow[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM provider_models').get() as {
        total: number | bigint;
      };
      return { items: rows.map(fromRow), total: Number(total.total), offset, limit };
    },
  };
}

/* -------------------------------------------------------------- secret refs --- */

interface SecretRow {
  readonly id: string;
  readonly provider_id: string;
  readonly purpose: string;
  readonly source: string;
  readonly env_name: string | null;
  readonly created_at: string;
}

export function createSqliteSecretRefStore(db: Database): EntityStore<SecretRef> {
  const upsert = db.prepare(
    `INSERT INTO secret_refs (id, provider_id, purpose, source, env_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, purpose) DO UPDATE SET source = excluded.source, env_name = excluded.env_name`,
  );
  const fromRow = (row: SecretRow): SecretRef => ({
    id: row.id,
    providerId: row.provider_id,
    purpose: row.purpose,
    source: row.source as SecretRef['source'],
    ...(row.env_name === null ? {} : { envName: row.env_name }),
  });

  return {
    async get(id: string): Promise<SecretRef | null> {
      const row = db.prepare('SELECT * FROM secret_refs WHERE id = ?').get(id) as SecretRow | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: SecretRef): Promise<void> {
      upsert.run(
        entity.id,
        entity.providerId,
        entity.purpose,
        entity.source,
        entity.envName ?? null,
        new Date(0).toISOString(),
      );
    },
    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM secret_refs WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<SecretRef>> {
      const limit = Math.min(Math.max(page.limit ?? 50, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM secret_refs ORDER BY provider_id ASC, purpose ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as SecretRow[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM secret_refs').get() as { total: number | bigint };
      return { items: rows.map(fromRow), total: Number(total.total), offset, limit };
    },
  };
}
