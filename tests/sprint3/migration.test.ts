/**
 * Sprint 3 requirement 14 + test K: the migration mechanism is unchanged — numbered
 * files, checksum-verified, idempotent — and the Sprint 3 schema lives in its own
 * checksum-protected chain so the Sprint 0 chain stays byte-identical.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MigrationChecksumError,
  applyMigrations,
  coreMigrationsDir,
  engineMigrationsDir,
  loadMigrations,
  openDatabase,
  openDurableDatabase,
  tableExists,
} from '@companyos/persistence';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-sprint3-migrations-'));
  created.push(dir);
  return dir;
};

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('K. migration checksum protection', () => {
  it('keeps the core chain at exactly one migration (Sprint 0 untouched)', () => {
    expect(loadMigrations(coreMigrationsDir()).map((migration) => migration.name)).toEqual(['0001_init']);
  });

  it('ships the durable schema as its own chain', () => {
    const migrations = loadMigrations(engineMigrationsDir());
    expect(migrations.map((migration) => migration.name)).toEqual([
      '0001_engine_persistence',
      '0002_task_run_ownership',
      '0003_execution_attempts',
      '0004_provider_dispatches',
      '0005_dispatch_config_fingerprint',
      '0006_provider_dispatch_routing_decision',
      '0007_execution_attempt_failure',
      '0008_goal_execution_budget',
      '0009_run_failure_reason_typed',
    ]);
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('applies both chains once and then skips them', () => {
    const dir = tempDir();
    const first = openDurableDatabase({ dataDir: dir, appliedAt: '2026-05-01T00:00:00.000Z' });
    try {
      expect(first.migrations.core.applied.map((record) => record.name)).toEqual(['0001_init']);
      expect(first.migrations.engine.applied.map((record) => record.name)).toEqual([
        '0001_engine_persistence',
        '0002_task_run_ownership',
        '0003_execution_attempts',
        '0004_provider_dispatches',
        '0005_dispatch_config_fingerprint',
        '0006_provider_dispatch_routing_decision',
        '0007_execution_attempt_failure',
        '0008_goal_execution_budget',
        '0009_run_failure_reason_typed',
      ]);
      expect(first.migrations.core.currentVersion).toBe(1);
      expect(first.migrations.engine.currentVersion).toBe(9);

      // Every durable object exists.
      for (const table of ['runs', 'tasks', 'approvals', 'events', 'command_ledger', 'schema_migrations']) {
        expect(tableExists(first.db, table), `${table} must exist`).toBe(true);
      }
      const eventColumns = first.db.prepare('PRAGMA table_info(events)').all() as readonly {
        name: string;
      }[];
      expect(eventColumns.map((column) => column.name)).toContain('global_position');
    } finally {
      first.close();
    }

    const second = openDurableDatabase({ dataDir: dir, appliedAt: '2026-05-02T00:00:00.000Z' });
    try {
      expect(second.migrations.core.applied).toEqual([]);
      expect(second.migrations.core.skipped.map((record) => record.name)).toEqual(['0001_init']);
      expect(second.migrations.engine.applied).toEqual([]);
      expect(second.migrations.engine.skipped.map((record) => record.name)).toEqual([
        '0001_engine_persistence',
        '0002_task_run_ownership',
        '0003_execution_attempts',
        '0004_provider_dispatches',
        '0005_dispatch_config_fingerprint',
        '0006_provider_dispatch_routing_decision',
        '0007_execution_attempt_failure',
        '0008_goal_execution_budget',
        '0009_run_failure_reason_typed',
      ]);
    } finally {
      second.close();
    }
  });

  it('refuses to open a database whose applied migration was edited', () => {
    const source = loadMigrations(engineMigrationsDir())[0];
    if (source === undefined) throw new Error('engine migration missing');

    const dir = tempDir();
    const migrationsDir = join(dir, 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    const file = join(migrationsDir, '0001_engine_persistence.sql');
    writeFileSync(file, readFileSync(source.path, 'utf8'), 'utf8');

    const db = openDatabase({ path: join(dir, 'tamper.sqlite') });
    try {
      // The engine chain assumes the core schema exists (it alters `events`).
      applyMigrations({ db, migrations: loadMigrations(coreMigrationsDir()), appliedAt: 'core' });
      applyMigrations({ db, migrations: loadMigrations(migrationsDir), appliedAt: 'first' });

      // Tamper with the file exactly as an attacker (or a bad merge) would.
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- sneaky change\n`, 'utf8');

      expect(() =>
        applyMigrations({ db, migrations: loadMigrations(migrationsDir), appliedAt: 'second' }),
      ).toThrow(MigrationChecksumError);

      try {
        applyMigrations({ db, migrations: loadMigrations(migrationsDir), appliedAt: 'second' });
      } catch (error) {
        const checksumError = error as MigrationChecksumError;
        expect(checksumError.code).toBe('HASH_MISMATCH');
        expect(checksumError.details['name']).toBe('0001_engine_persistence');
      }
    } finally {
      db.close();
    }
  });

  it('has no schema drift between the two chains', () => {
    const dir = tempDir();
    const database = openDurableDatabase({ dataDir: dir, appliedAt: 'now' });
    try {
      const ledgerRows = database.db
        .prepare('SELECT name FROM schema_migrations ORDER BY name')
        .all() as readonly { name: string }[];
      expect(ledgerRows.map((row) => row.name)).toEqual([
        '0001_engine_persistence',
        '0001_init',
        '0002_task_run_ownership',
        '0003_execution_attempts',
        '0004_provider_dispatches',
        '0005_dispatch_config_fingerprint',
        '0006_provider_dispatch_routing_decision',
        '0007_execution_attempt_failure',
        '0008_goal_execution_budget',
        '0009_run_failure_reason_typed',
      ]);
    } finally {
      database.close();
    }
  });
});
