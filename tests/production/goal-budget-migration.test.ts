import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyMigrations, coreMigrationsDir, engineMigrationsDir, loadMigrations, openDatabase, openDurableDatabase, type Database } from '@companyos/persistence';

const dirs: string[] = []; const connections: Database[] = [];
afterEach(() => { connections.splice(0).forEach((db) => db.close()); dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

it('additive 0008 preserves a real legacy Run; stopped pre-migration backup restores exactly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-migration-')); dirs.push(dir);
  const file = join(dir, 'companyos.sqlite'); const backup = join(dir, 'before.sqlite');
  const legacy = openDatabase({ path: file, journalMode: 'DELETE' });
  applyMigrations({ db: legacy, migrations: loadMigrations(coreMigrationsDir()), appliedAt: 'offline' });
  applyMigrations({ db: legacy, migrations: loadMigrations(engineMigrationsDir()).filter((m) => m.version < 8), appliedAt: 'offline' });
  legacy.prepare("INSERT INTO runs (id,company_id,workflow_id,template_id,version_id,snapshot_id,state,revision,rework_count,max_rework,history_json,created_at,updated_at,started_by) VALUES ('legacy','company','workflow','template','version','snapshot','IDLE',0,0,3,'[]','now','now','actor')").run();
  const before = legacy.prepare('SELECT * FROM runs').all(); legacy.close();
  copyFileSync(file, backup); const originalHash = digest(backup);
  const upgraded = openDurableDatabase({ dataDir: dir, appliedAt: 'offline' });
  connections.push(upgraded.db);
  expect(await upgraded.executionBudget.goalOf('legacy')).toBeNull();
  const row = upgraded.db.prepare('SELECT * FROM runs WHERE id = ?').get('legacy') as Record<string, unknown>;
  const { execution_goal_run_id, execution_budget_json, ...oldColumns } = row;
  expect([oldColumns]).toEqual(before); expect(execution_goal_run_id).toBeNull(); expect(execution_budget_json).toBeNull();
  const replay = applyMigrations({ db: upgraded.db, migrations: loadMigrations(engineMigrationsDir()), appliedAt: 'offline-again' });
  expect(replay.applied).toHaveLength(0);
  const migrations = loadMigrations(engineMigrationsDir()); const last = migrations.find((m) => m.version === 8)!;
  expect(() => applyMigrations({ db: upgraded.db, migrations: [{ ...last, checksum: 'tampered' }], appliedAt: 'offline' })).toThrow(/modified/);
  upgraded.close();
  connections.pop();
  const restoreDir = join(dir, 'restore'); mkdirSync(restoreDir); const restoredFile = join(restoreDir, 'companyos.sqlite');
  copyFileSync(backup, restoredFile); expect(digest(restoredFile)).toBe(originalHash);
  const restored = openDatabase({ path: restoredFile, readOnly: true, journalMode: 'DELETE' }); connections.push(restored);
  expect(restored.prepare('SELECT * FROM runs').all()).toEqual(before);
  expect(restored.prepare("SELECT name FROM schema_migrations WHERE name = '0008_goal_execution_budget'").all()).toHaveLength(0);
  expect(restored.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
});
