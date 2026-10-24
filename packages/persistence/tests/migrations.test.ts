/**
 * Sprint 0 acceptance (T0.7): migrations apply exactly once, a modified applied
 * migration fails loudly, and the connection carries the required pragmas.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MigrationChecksumError,
  MigrationFormatError,
  applyMigrations,
  checksumOf,
  defaultMigrationsDir,
  loadMigrations,
  normalizeSql,
  openCompanyDatabase,
  openDatabase,
  readPragma,
  tableExists,
} from '../src/index.js';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-persistence-'));
  created.push(dir);
  return dir;
};

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('migration runner', () => {
  it('loads the shipped migrations and applies 0001_init.sql once', () => {
    const dir = tempDir();
    const db = openDatabase({ path: join(dir, 'app.sqlite') });
    const migrations = loadMigrations(defaultMigrationsDir());
    expect(migrations.map((migration) => migration.name)).toContain('0001_init');

    const first = applyMigrations({ db, migrations, appliedAt: '2026-01-01T00:00:00.000Z' });
    expect(first.applied.map((record) => record.name)).toEqual(['0001_init']);
    expect(first.currentVersion).toBe(1);

    const second = applyMigrations({ db, migrations, appliedAt: '2026-01-02T00:00:00.000Z' });
    expect(second.applied).toEqual([]);
    expect(second.skipped.map((record) => record.name)).toEqual(['0001_init']);

    expect(tableExists(db, 'schema_migrations')).toBe(true);
    expect(tableExists(db, 'entities')).toBe(true);
    expect(tableExists(db, 'events')).toBe(true);
    db.close();
  });

  it('throws MigrationChecksumError when an applied migration is edited', () => {
    const dir = tempDir();
    const migrationsDir = join(dir, 'migrations');
    const db = openDatabase({ path: join(dir, 'app.sqlite') });
    mkdirSync(migrationsDir, { recursive: true });
    const file = join(migrationsDir, '0001_init.sql');
    writeFileSync(file, 'CREATE TABLE alpha (id TEXT PRIMARY KEY);\n', 'utf8');

    applyMigrations({ db, migrations: loadMigrations(migrationsDir), appliedAt: 'now' });

    writeFileSync(file, 'CREATE TABLE alpha (id TEXT PRIMARY KEY, extra TEXT);\n', 'utf8');
    expect(() =>
      applyMigrations({ db, migrations: loadMigrations(migrationsDir), appliedAt: 'later' }),
    ).toThrow(MigrationChecksumError);

    try {
      applyMigrations({ db, migrations: loadMigrations(migrationsDir), appliedAt: 'later' });
    } catch (error) {
      const checksumError = error as MigrationChecksumError;
      expect(checksumError.code).toBe('HASH_MISMATCH');
      expect(checksumError.details['name']).toBe('0001_init');
    }
    db.close();
  });

  it('rejects badly named migration files and duplicate versions', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'init.sql'), 'SELECT 1;\n', 'utf8');
    expect(() => loadMigrations(dir)).toThrow(MigrationFormatError);

    const dir2 = tempDir();
    writeFileSync(join(dir2, '0001_a.sql'), 'SELECT 1;\n', 'utf8');
    writeFileSync(join(dir2, '0001_b.sql'), 'SELECT 2;\n', 'utf8');
    expect(() => loadMigrations(dir2)).toThrow(MigrationFormatError);
    expect(() => loadMigrations(join(dir2, 'missing'))).toThrow(MigrationFormatError);
  });

  it('normalises line endings so checksums match across platforms', () => {
    const lf = 'CREATE TABLE t (id TEXT);\n';
    const crlf = 'CREATE TABLE t (id TEXT);\r\n';
    expect(checksumOf(lf)).toBe(checksumOf(crlf));
    expect(normalizeSql(crlf)).toBe(lf);
    expect(checksumOf(lf)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('database pragmas', () => {
  it('opens with WAL, foreign keys and a bounded busy timeout', () => {
    const dir = tempDir();
    const db = openDatabase({ path: join(dir, 'app.sqlite') });
    expect(String(readPragma(db, 'journal_mode')).toLowerCase()).toBe('wal');
    expect(Number(readPragma(db, 'foreign_keys'))).toBe(1);
    expect(Number(readPragma(db, 'busy_timeout'))).toBe(5_000);
    db.close();
  });

  it('rolls a failed transaction back', () => {
    const dir = tempDir();
    const db = openDatabase({ path: join(dir, 'app.sqlite') });
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    expect(() =>
      db.inTransaction(() => {
        db.prepare('INSERT INTO t (id) VALUES (?)').run('a');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const row = db.prepare('SELECT COUNT(*) AS total FROM t').get() as { total: number };
    expect(Number(row.total)).toBe(0);
    db.close();
  });

  it('opens the full company database with migrations applied', () => {
    const dir = tempDir();
    const opened = openCompanyDatabase({ dataDir: dir, appliedAt: '2026-01-01T00:00:00.000Z' });
    expect(opened.migrationReport.currentVersion).toBe(1);
    expect(opened.journalMode.toLowerCase()).toBe('wal');
    expect(opened.path.endsWith('companyos.sqlite')).toBe(true);
    opened.db.close();
    expect(readFileSync(opened.path).length).toBeGreaterThan(0);
  });
});
