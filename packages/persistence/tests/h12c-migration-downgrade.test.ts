/**
 * H12c — migration chain hygiene + downgrade detection.
 *
 * `schema_migrations` is shared by every chain. Each chain's runner now knows every name
 * the build ships, so (1) rows of a sibling chain are silent (no "no longer present"
 * noise on every boot) and (2) a row that NO shipped chain knows — written by a newer
 * CompanyOS — is refused with a typed error BEFORE anything is applied.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MigrationFromNewerVersionError,
  applyMigrations,
  defaultMigrationsDir,
  isMigrationFromNewerVersionError,
  loadMigrations,
  openCompanyDatabase,
  openDatabase,
  openDurableDatabase,
  shippedMigrationNames,
  type Database,
  type MigrationChainName,
} from '../src/index.js';

const dirs: string[] = [];
const connections: Database[] = [];
afterEach(() => {
  connections.splice(0).forEach((db) => db.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-h12c-'));
  dirs.push(dir);
  return dir;
};

const ALL: readonly MigrationChainName[] = [
  'core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'router', 'handoff', 'memory', 'artifact', 'pack', 'session',
];

const countSqlFiles = (dir: string): number =>
  readdirSync(dir).reduce((total, entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return total + countSqlFiles(path);
    return total + (entry.endsWith('.sql') ? 1 : 0);
  }, 0);

const insertFutureRow = (dataDir: string, name: string): void => {
  const raw = openDatabase({ path: join(dataDir, 'companyos.sqlite') });
  raw.prepare('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)').run(name, 'f'.repeat(64), 'newer-build');
  raw.close();
};

describe('H12c migration chain hygiene', () => {
  it('ships globally unique migration names covering every .sql file of every chain', () => {
    const names = shippedMigrationNames();
    expect(names.size).toBe(countSqlFiles(defaultMigrationsDir()));
    expect(names.has('0001_init')).toBe(true);
    expect(names.has('0009_run_failure_reason_typed')).toBe(true);
  });

  it('reopening with fewer chains logs no "no longer present" noise for sibling-chain rows', () => {
    const dir = tempDir();
    connections.push(openDurableDatabase({ dataDir: dir, appliedAt: 't1', chains: ALL }).db);
    connections.splice(0).forEach((db) => db.close());
    const logs: string[] = [];
    const reopened = openDurableDatabase({ dataDir: dir, appliedAt: 't2', logger: { info: (message) => logs.push(message) } });
    connections.push(reopened.db);
    expect(logs.filter((message) => message.includes('no longer present'))).toEqual([]);
    expect(reopened.migrations.core.applied).toEqual([]);
  });

  it('refuses a database written by a newer version before applying anything (durable open)', () => {
    const dir = tempDir();
    connections.push(openDurableDatabase({ dataDir: dir, appliedAt: 't1' }).db); // core + engine only
    connections.splice(0).forEach((db) => db.close());
    insertFutureRow(dir, '0010_future_engine_change');

    let caught: unknown;
    try {
      connections.push(openDurableDatabase({ dataDir: dir, appliedAt: 't2', chains: ALL }).db);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationFromNewerVersionError);
    expect(isMigrationFromNewerVersionError(caught)).toBe(true);
    const typed = caught as MigrationFromNewerVersionError;
    expect(typed.code).toBe('CONFLICT');
    expect(typed.details).toMatchObject({ kind: 'SCHEMA_FROM_NEWER_VERSION', unknownMigrations: ['0010_future_engine_change'] });

    // Nothing applied: the opt-in chains that were requested are still absent.
    const raw = openDatabase({ path: join(dir, 'companyos.sqlite') });
    connections.push(raw);
    const names = (raw.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((row) => row.name);
    expect(names).not.toContain('0001_workflow_lifecycle');
    expect(names).toContain('0010_future_engine_change');
  });

  it('openCompanyDatabase refuses the same way; isolated single-chain use without knownNames only logs', () => {
    const dir = tempDir();
    connections.push(openCompanyDatabase({ dataDir: dir, appliedAt: 't1' }).db);
    connections.splice(0).forEach((db) => db.close());
    insertFutureRow(dir, '0002_future_core_change');
    expect(() => openCompanyDatabase({ dataDir: dir, appliedAt: 't2' })).toThrow(MigrationFromNewerVersionError);

    const raw = openDatabase({ path: join(dir, 'companyos.sqlite') });
    connections.push(raw);
    const logs: Array<{ message: string; name: unknown }> = [];
    const report = applyMigrations({
      db: raw,
      migrations: loadMigrations(defaultMigrationsDir()),
      appliedAt: 't3',
      logger: { info: (message, fields) => logs.push({ message, name: fields?.['name'] }) },
    });
    expect(report.applied).toEqual([]);
    expect(logs).toEqual([{ message: 'applied migration file is no longer present', name: '0002_future_core_change' }]);
  });
});
