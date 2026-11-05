// DB-BACKUP — the desktop backup policy: settings, start/periodic scheduler (fake timers),
// mandatory pre-migration snapshot, staged restore, the restore helper script and main.ts wiring.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabaseSnapshot, listDatabaseSnapshots, openDurableDatabase } from '@companyos/persistence';

import {
  applyPendingDatabaseRestore,
  createDatabaseBackupScheduler,
  databaseBackupDir,
  databaseBackupSettings,
  DATABASE_RESTORE_REQUEST_FILE,
  preMigrationBackupHook,
  readDatabaseRestoreRequest,
  requestDatabaseRestore,
  shippedDatabaseMigrationNames,
  type BackupLogger,
} from '../src/db-backup.js';
// @ts-expect-error -- plain .mjs helper shipped in resources/setup (no type declarations)
import { main as restoreMain, parseArgs as parseRestoreArgs } from '../../../scripts/hark/setup/restore-database.mjs';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-desk-backup-'));
  dirs.push(dir);
  return dir;
};
const logger = (): BackupLogger & { lines: { level: string; message: string; fields?: Record<string, unknown> }[] } => {
  const lines: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, ...(fields === undefined ? {} : { fields }) });
  };
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
};
/** A userData dir (spaces + CJK) holding a migrated database with one probe row. */
const seedUserData = (): { userData: string; live: string } => {
  const userData = join(tempDir(), 'Roaming', 'CompanyOS 公司');
  const dataDir = join(userData, 'data');
  const opened = openDurableDatabase({ dataDir, appliedAt: 't1' });
  opened.db.exec("CREATE TABLE probe (v TEXT); INSERT INTO probe VALUES ('v1')");
  opened.close();
  return { userData, live: join(dataDir, 'companyos.sqlite') };
};
const probe = (path: string): string[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT v FROM probe ORDER BY rowid').all().map((r) => String((r as { v: string }).v));
  } finally {
    db.close();
  }
};
const insertProbe = (path: string, v: string): void => {
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO probe VALUES (?)').run(v);
  db.close();
};

describe('DB-BACKUP settings', () => {
  it('defaults to every 6 h, keep 10', () => {
    expect(databaseBackupSettings({})).toEqual({ intervalMs: 6 * 3_600_000, keep: 10, warnings: [] });
  });
  it('honours valid overrides, 0 disables the periodic snapshot', () => {
    expect(databaseBackupSettings({ COMPANYOS_DB_BACKUP_INTERVAL_HOURS: '0.5', COMPANYOS_DB_BACKUP_KEEP: '3' })).toMatchObject({ intervalMs: 1_800_000, keep: 3 });
    expect(databaseBackupSettings({ COMPANYOS_DB_BACKUP_INTERVAL_HOURS: '0' }).intervalMs).toBe(0);
  });
  it('rejects invalid values with a warning and keeps the defaults', () => {
    const s = databaseBackupSettings({ COMPANYOS_DB_BACKUP_INTERVAL_HOURS: '0.01', COMPANYOS_DB_BACKUP_KEEP: '0' });
    expect(s).toMatchObject({ intervalMs: 6 * 3_600_000, keep: 10 });
    expect(s.warnings).toHaveLength(2);
    expect(databaseBackupSettings({ COMPANYOS_DB_BACKUP_INTERVAL_HOURS: 'abc', COMPANYOS_DB_BACKUP_KEEP: '2.5' }).warnings).toHaveLength(2);
  });
});

describe('DB-BACKUP scheduler (fake timers)', () => {
  it('start takes one start snapshot now and then a periodic one per interval; stop disarms', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-05T02:00:00.000Z'));
    const { userData, live } = seedUserData();
    const backupDir = databaseBackupDir(userData);
    const log = logger();
    const scheduler = createDatabaseBackupScheduler({ sourcePath: () => live, backupDir, intervalMs: 6 * 3_600_000, keep: 2, logger: log });

    scheduler.start();
    scheduler.start(); // idempotent
    expect(listDatabaseSnapshots(backupDir).map((s) => s.tag)).toEqual(['start']);
    expect(scheduler.status().lastSnapshot?.tag).toBe('start');

    vi.advanceTimersByTime(6 * 3_600_000 - 1);
    expect(listDatabaseSnapshots(backupDir).filter((s) => s.tag === 'periodic')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(listDatabaseSnapshots(backupDir).filter((s) => s.tag === 'periodic')).toHaveLength(1);
    vi.advanceTimersByTime(3 * 6 * 3_600_000);
    const periodic = listDatabaseSnapshots(backupDir).filter((s) => s.tag === 'periodic');
    expect(periodic).toHaveLength(2); // rotation keep=2
    expect(periodic[0]?.createdAt).toBe('2026-11-06T02:00:00.000Z');
    expect(scheduler.status()).toMatchObject({ intervalHours: 6, keep: 2, consecutiveFailures: 0, lastError: null });

    scheduler.stop();
    vi.advanceTimersByTime(10 * 6 * 3_600_000);
    expect(listDatabaseSnapshots(backupDir).filter((s) => s.tag === 'periodic')[0]?.createdAt).toBe('2026-11-06T02:00:00.000Z');
  });

  it('interval 0 arms no timer; a closed database (null path) is skipped silently', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { userData, live } = seedUserData();
    let path: string | null = null;
    const scheduler = createDatabaseBackupScheduler({ sourcePath: () => path, backupDir: databaseBackupDir(userData), intervalMs: 0, keep: 10, logger: logger() });
    expect(scheduler.snapshotNow('manual')).toBeNull();
    expect(scheduler.status().lastError).toBeNull();
    path = live;
    scheduler.start();
    expect(vi.getTimerCount()).toBe(0);
    expect(listDatabaseSnapshots(databaseBackupDir(userData))).toHaveLength(1);
  });

  it('a failing snapshot never throws: it is logged and surfaced as a diagnostic, and recovery resets it', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { userData, live } = seedUserData();
    const broken = join(userData, 'not-a-db.sqlite');
    writeFileSync(broken, 'nope'.repeat(2000));
    let path = broken;
    const log = logger();
    const scheduler = createDatabaseBackupScheduler({ sourcePath: () => path, backupDir: databaseBackupDir(userData), intervalMs: 60_000, keep: 10, logger: log });
    expect(() => scheduler.start()).not.toThrow();
    vi.advanceTimersByTime(60_000);
    expect(scheduler.status()).toMatchObject({ consecutiveFailures: 2, lastSnapshot: null });
    expect(scheduler.status().lastError?.tag).toBe('periodic');
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
    path = live;
    vi.advanceTimersByTime(60_000);
    expect(scheduler.status()).toMatchObject({ consecutiveFailures: 0 });
    expect(scheduler.status().lastSnapshot?.tag).toBe('periodic');
  });
});

describe('DB-BACKUP mandatory pre-migration snapshot', () => {
  it('snapshots before an upgrade and records it', () => {
    const { userData } = seedUserData();
    const recorded = vi.fn();
    const hook = preMigrationBackupHook({ backupDir: databaseBackupDir(userData), keep: 10, logger: logger(), onSnapshot: recorded });
    openDurableDatabase({ dataDir: join(userData, 'data'), appliedAt: 't2', chains: ['core', 'engine', 'lifecycle'], beforeMigrations: hook }).close();
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(listDatabaseSnapshots(databaseBackupDir(userData)).map((s) => s.tag)).toEqual(['pre-migration']);
  });

  it('a failed pre-migration snapshot refuses the migration (typed) and leaves the schema as it was', () => {
    const { userData, live } = seedUserData();
    const backupDir = databaseBackupDir(userData);
    writeFileSync(backupDir, 'a FILE where the backups directory should be'); // mkdir fails
    const log = logger();
    const hook = preMigrationBackupHook({ backupDir, keep: 10, logger: log });
    let caught: unknown;
    try {
      openDurableDatabase({ dataDir: join(userData, 'data'), appliedAt: 't2', chains: ['core', 'engine', 'lifecycle'], beforeMigrations: hook });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('PERSISTENCE_FAILED');
    expect((caught as { details?: { kind?: string } }).details?.kind).toBe('PRE_MIGRATION_BACKUP_FAILED');
    expect(log.lines.some((l) => l.level === 'error')).toBe(true);
    const db = new DatabaseSync(live, { readOnly: true });
    const lifecycleRows = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'workflow_templates'").get() as { n: number };
    db.close();
    expect(Number(lifecycleRows.n)).toBe(0);
  });
});

describe('DB-BACKUP staged restore', () => {
  it('request (validated now) → applied at next start before open: safety copy kept, backup data back', () => {
    const { userData, live } = seedUserData();
    const backupDir = databaseBackupDir(userData);
    const known = shippedDatabaseMigrationNames();
    const snap = createDatabaseSnapshot({ sourcePath: live, backupDir, tag: 'periodic' });
    insertProbe(live, 'v2-after-backup');

    const request = requestDatabaseRestore({ backupDir, backupFileName: snap.fileName, knownMigrationNames: known });
    expect(readDatabaseRestoreRequest(backupDir)).toEqual(request);
    expect(probe(live)).toEqual(['v1', 'v2-after-backup']); // requesting never touches the live db

    const log = logger();
    const outcome = applyPendingDatabaseRestore({ backupDir, livePath: live, knownMigrationNames: known, logger: log });
    expect(outcome.kind).toBe('restored');
    if (outcome.kind !== 'restored') return;
    expect(outcome.safetyCopyKind).toBe('snapshot');
    expect(probe(live)).toEqual(['v1']);
    expect(probe(outcome.safetyCopy ?? '')).toEqual(['v1', 'v2-after-backup']);
    expect(existsSync(join(backupDir, DATABASE_RESTORE_REQUEST_FILE))).toBe(false); // consumed
    expect(applyPendingDatabaseRestore({ backupDir, livePath: live, knownMigrationNames: known, logger: log }).kind).toBe('none');
    // The normal bootstrap reopens the restored file.
    openDurableDatabase({ dataDir: join(userData, 'data'), appliedAt: 't3' }).close();
  });

  it('refuses names that are not backups in the backups dir (no traversal)', () => {
    const { userData } = seedUserData();
    const backupDir = databaseBackupDir(userData);
    const known = shippedDatabaseMigrationNames();
    for (const name of ['../data/companyos.sqlite', 'companyos.sqlite', 'companyos-periodic-20991231T000000000Z.sqlite']) {
      let kind: unknown;
      try {
        requestDatabaseRestore({ backupDir, backupFileName: name, knownMigrationNames: known });
      } catch (error) {
        kind = (error as { details?: { kind?: unknown } }).details?.kind;
      }
      expect(kind === 'RESTORE_BACKUP_NAME_INVALID' || kind === 'RESTORE_BACKUP_NOT_FOUND').toBe(true);
    }
  });

  it('a backup that became corrupt after the request is refused at start; the live database is kept and the request consumed', () => {
    const { userData, live } = seedUserData();
    const backupDir = databaseBackupDir(userData);
    const known = shippedDatabaseMigrationNames();
    const snap = createDatabaseSnapshot({ sourcePath: live, backupDir, tag: 'manual' });
    requestDatabaseRestore({ backupDir, backupFileName: snap.fileName, knownMigrationNames: known });
    writeFileSync(snap.path, Buffer.alloc(4096, 0x41)); // corrupted on disk afterwards
    insertProbe(live, 'kept');
    const before = readFileSync(live);

    const log = logger();
    const outcome = applyPendingDatabaseRestore({ backupDir, livePath: live, knownMigrationNames: known, logger: log });
    expect(outcome).toMatchObject({ kind: 'refused', code: 'BACKUP_CORRUPT', backup: snap.fileName });
    expect(readFileSync(live).equals(before)).toBe(true);
    expect(probe(live)).toEqual(['v1', 'kept']);
    expect(existsSync(join(backupDir, DATABASE_RESTORE_REQUEST_FILE))).toBe(false);
    expect(log.lines.some((l) => l.level === 'error' && l.message.includes('restore refused'))).toBe(true);
  });

  it('a corrupt backup is refused already at request time; a malformed request file is refused at start', () => {
    const { userData, live } = seedUserData();
    const backupDir = databaseBackupDir(userData);
    const known = shippedDatabaseMigrationNames();
    const snap = createDatabaseSnapshot({ sourcePath: live, backupDir, tag: 'manual' });
    writeFileSync(snap.path, 'garbage');
    expect(() => requestDatabaseRestore({ backupDir, backupFileName: snap.fileName, knownMigrationNames: known })).toThrow();
    expect(readDatabaseRestoreRequest(backupDir)).toBeNull();
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, DATABASE_RESTORE_REQUEST_FILE), '{"schema":"other"}');
    expect(applyPendingDatabaseRestore({ backupDir, livePath: live, knownMigrationNames: known, logger: logger() })).toMatchObject({ kind: 'refused', code: 'RESTORE_REQUEST_INVALID' });
  });
});

describe('DB-BACKUP restore helper + main-process wiring', () => {
  it('restore-database.mjs carries no hashbang (a CRLF checkout breaks module loading on Windows)', () => {
    const source = readFileSync(new URL('../../../scripts/hark/setup/restore-database.mjs', import.meta.url), 'utf8');
    expect(source.startsWith('#!')).toBe(false);
  });
  it('restore-database.mjs parses list/request/cancel/status and refuses incomplete input', () => {
    expect(parseRestoreArgs(['list', '--user-data', 'C:\\Users\\陈 雁松\\AppData\\Roaming\\CompanyOS'])).toEqual({ command: 'list', 'user-data': 'C:\\Users\\陈 雁松\\AppData\\Roaming\\CompanyOS' });
    expect(parseRestoreArgs(['request', '--user-data', 'u', '--backup', 'companyos-start-20261105T020304005Z.sqlite']).backup).toBe('companyos-start-20261105T020304005Z.sqlite');
    expect(() => parseRestoreArgs(['request', '--user-data', 'u'])).toThrow();
    expect(() => parseRestoreArgs(['restore-now', '--user-data', 'u'])).toThrow();
    expect(() => parseRestoreArgs(['list'])).toThrow();
  });

  it('restore-database.mjs answers one JSON line (bad args exit 2, missing app module exit 3)', async () => {
    const run = restoreMain as (argv: string[], log: (l: string) => void) => Promise<number>;
    const lines: string[] = [];
    expect(await run(['request', '--user-data', 'u'], (l) => lines.push(l))).toBe(2);
    const empty = tempDir();
    expect(await run(['list', '--user-data', empty, '--dist', empty], (l) => lines.push(l))).toBe(3);
    const outs = lines.map((l) => JSON.parse(l) as { ok: boolean; code: string; message: string });
    expect(outs.map((o) => [o.ok, o.code])).toEqual([[false, 'RESTORE_ARGS_INVALID'], [false, 'ERR_MODULE_NOT_FOUND']]);
    expect(outs[1]?.message).toContain('db-backup.js');
  });

  it('main.ts applies a staged restore before the first open, passes the pre-migration hook and arms the scheduler on open', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/beforeMigrations: preMigrationBackupHook\(/u);
    const prepare = main.indexOf('prepareDatabaseBackups();');
    const firstStart = main.indexOf('const started = await runtimeStarter.start();', main.indexOf('async function main()'));
    expect(prepare).toBeGreaterThan(0);
    expect(prepare).toBeLessThan(firstStart);
    expect(main).toMatch(/shellDatabase = opened;\s*\/\/ DB-BACKUP[^\n]*\n\s*backupScheduler\?\.start\(\);/u);
    expect(main).toMatch(/backupScheduler\?\.stop\(\);\s*shellDatabase\?\.db\.close\(\);/u);
    expect(main).toMatch(/backup: backupScheduler\?\.status\(\) \?\? null/u);
  });
});
