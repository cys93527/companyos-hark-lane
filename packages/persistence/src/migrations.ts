/**
 * Migration runner — numbered `NNNN_name.sql` files applied exactly once, with a
 * sha256 checksum recorded per file (planning-document §五十六: SQLite +
 * Migrations).
 *
 * Guarantees:
 *   - every applied migration has a row in `schema_migrations`
 *   - re-running is a no-op (idempotent)
 *   - editing an already-applied file fails loudly (`MigrationChecksumError`)
 *     instead of silently diverging between machines
 *   - each migration runs inside a transaction, so a failure leaves no partial DDL
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { DomainError } from '@companyos/core';

import type { Database } from './db.js';

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
  readonly path: string;
}

export interface MigrationRecord {
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationReport {
  readonly applied: readonly MigrationRecord[];
  readonly skipped: readonly MigrationRecord[];
  readonly currentVersion: number;
}

export class MigrationChecksumError extends DomainError {
  public constructor(name: string, expected: string, actual: string) {
    super('HASH_MISMATCH', `Migration "${name}" was modified after it was applied.`, {
      details: { name, expected, actual },
    });
    this.name = 'MigrationChecksumError';
  }
}

export class MigrationFormatError extends DomainError {
  public constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super('VALIDATION_FAILED', message, { details });
    this.name = 'MigrationFormatError';
  }
}

/**
 * H12c: the database holds an applied migration that NO chain shipped with this build
 * knows. That only happens when a newer CompanyOS version already upgraded this data
 * directory and an older build is now opening it (a downgrade). The older build cannot
 * know what the newer schema means, so it refuses BEFORE applying anything instead of
 * running on a schema it does not understand. Code stays inside the frozen taxonomy
 * (`CONFLICT`); `details.kind` carries the typed reason.
 */
export class MigrationFromNewerVersionError extends DomainError {
  public readonly unknownMigrations: readonly string[];
  public constructor(unknownMigrations: readonly string[]) {
    super(
      'CONFLICT',
      `The database was upgraded by a newer CompanyOS version (unknown applied migrations: ${unknownMigrations.join(', ')}); this version refuses to open it.`,
      { details: { kind: 'SCHEMA_FROM_NEWER_VERSION', unknownMigrations } },
    );
    this.name = 'MigrationFromNewerVersionError';
    this.unknownMigrations = unknownMigrations;
  }
}

export const isMigrationFromNewerVersionError = (error: unknown): error is MigrationFromNewerVersionError =>
  error instanceof MigrationFromNewerVersionError ||
  (error instanceof DomainError &&
    error.code === 'CONFLICT' &&
    (error.details as { kind?: unknown } | undefined)?.kind === 'SCHEMA_FROM_NEWER_VERSION');

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Line endings are normalised so the checksum is identical on Windows and CI. */
export const normalizeSql = (sql: string): string => `${sql.replace(/\r\n/g, '\n').trimEnd()}\n`;

export const checksumOf = (sql: string): string =>
  createHash('sha256').update(normalizeSql(sql), 'utf8').digest('hex');

export function loadMigrations(dir: string): readonly MigrationFile[] {
  if (!existsSync(dir)) {
    throw new MigrationFormatError(`Migration directory does not exist: ${dir}`, { dir });
  }
  const migrations = readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((entry) => {
      const match = FILE_PATTERN.exec(entry);
      if (match === null) {
        throw new MigrationFormatError(`Migration "${entry}" must be named NNNN_name.sql`, { entry });
      }
      const path = join(dir, entry);
      const sql = readFileSync(path, 'utf8');
      return {
        version: Number(match[1]),
        name: entry.replace(/\.sql$/, ''),
        checksum: checksumOf(sql),
        sql,
        path,
      } satisfies MigrationFile;
    });

  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new MigrationFormatError(`Duplicate migration version ${migration.version}`, {
        version: migration.version,
      });
    }
    versions.add(migration.version);
  }
  return migrations;
}

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`.trim();

export interface ApplyMigrationsOptions {
  readonly db: Database;
  readonly migrations: readonly MigrationFile[];
  readonly appliedAt: string;
  readonly logger?: { info(message: string, fields?: Record<string, unknown>): void };
  /**
   * H12c: every migration name this build ships across ALL chains (schema_migrations is
   * shared by every chain). When given, an applied row outside this set and outside
   * `migrations` is a downgrade and is refused before anything is applied; rows that
   * belong to another known chain are expected and silent. When omitted (isolated unit
   * use of one chain), unknown rows are only logged.
   */
  readonly knownNames?: ReadonlySet<string>;
}

export function readAppliedMigrations(db: Database): ReadonlyMap<string, MigrationRecord> {
  db.exec(SCHEMA_MIGRATIONS_DDL);
  const rows = db.prepare('SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name').all();
  const applied = new Map<string, MigrationRecord>();
  for (const row of rows) {
    const record = row as { name: string; checksum: string; applied_at: string };
    applied.set(record.name, {
      name: record.name,
      checksum: record.checksum,
      appliedAt: record.applied_at,
    });
  }
  return applied;
}

export function applyMigrations(options: ApplyMigrationsOptions): MigrationReport {
  const { db, migrations, appliedAt } = options;
  const alreadyApplied = readAppliedMigrations(db);
  const inThisChain = new Set(migrations.map((migration) => migration.name));
  const unknown = [...alreadyApplied.keys()].filter(
    (name) => !inThisChain.has(name) && !(options.knownNames?.has(name) ?? false),
  );
  if (options.knownNames !== undefined && unknown.length > 0) {
    throw new MigrationFromNewerVersionError(unknown);
  }
  const applied: MigrationRecord[] = [];
  const skipped: MigrationRecord[] = [];

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    const existing = alreadyApplied.get(migration.name);
    if (existing !== undefined) {
      if (existing.checksum !== migration.checksum) {
        throw new MigrationChecksumError(migration.name, existing.checksum, migration.checksum);
      }
      skipped.push(existing);
      continue;
    }
    const record: MigrationRecord = { name: migration.name, checksum: migration.checksum, appliedAt };
    db.inTransaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)').run(
        record.name,
        record.checksum,
        record.appliedAt,
      );
    });
    options.logger?.info('migration applied', { name: migration.name, version: migration.version });
    applied.push(record);
  }

  for (const name of unknown) {
    options.logger?.info('applied migration file is no longer present', { name });
  }

  const currentVersion = [...alreadyApplied.keys(), ...applied.map((record) => record.name)].reduce(
    (max, name) => {
      const version = Number(name.slice(0, 4));
      return Number.isFinite(version) && version > max ? version : max;
    },
    0,
  );

  return { applied, skipped, currentVersion };
}
