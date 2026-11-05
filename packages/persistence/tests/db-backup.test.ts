/**
 * DB-BACKUP — local SQLite snapshots (VACUUM INTO through a separate read-only connection),
 * rotation, Windows-safe naming, pre-migration hook, validation and restore.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDatabaseSnapshot,
  inspectDatabaseFile,
  listDatabaseSnapshots,
  openDatabase,
  openDurableDatabase,
  parseSnapshotFileName,
  restoreDatabaseFromBackup,
  rotateDatabaseSnapshots,
  shippedMigrationNames,
  snapshotFileName,
  validateDatabaseBackup,
  type BeforeMigrationsInfo,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const tempDir = (label = 'companyos-backup-'): string => {
  const dir = mkdtempSync(join(tmpdir(), label));
  dirs.push(dir);
  return dir;
};

const countRows = (path: string, table = 't'): number => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    db.close();
  }
};
const migrationRows = (path: string): string[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => String((r as { name: string }).name));
  } finally {
    db.close();
  }
};
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const clock = (start = Date.parse('2026-11-05T02:00:00.000Z'), stepMs = 1_000): (() => Date) => {
  let t = start - stepMs;
  return () => new Date((t += stepMs));
};
const kindOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return (error as { details?: { kind?: unknown } }).details?.kind;
  }
  return 'NO_THROW';
};

describe('DB-BACKUP snapshot consistency (WAL, open transactions, concurrent writers)', () => {
  it('a snapshot taken while the app connection holds an open write transaction contains exactly the committed rows', async () => {
    const dir = tempDir();
    const live = join(dir, 'companyos.sqlite');
    const db = openDatabase({ path: live });
    db.exec('CREATE TABLE t (x INTEGER)');
    for (let i = 0; i < 5; i += 1) db.prepare('INSERT INTO t (x) VALUES (?)').run(i);

    let snapshotPath = '';
    const result = await db.writeFence.transaction(async () => {
      for (let i = 0; i < 7; i += 1) db.prepare('INSERT INTO t (x) VALUES (?)').run(100 + i);
      await Promise.resolve(); // the transaction stays OPEN across an await
      snapshotPath = createDatabaseSnapshot({ sourcePath: live, backupDir: join(dir, 'backups'), tag: 'periodic', now: clock() }).path;
      return 'committed';
    });
    expect(result.ok).toBe(true);
    expect(countRows(snapshotPath)).toBe(5); // uncommitted 7 excluded
    expect(countRows(live)).toBe(12);
    // The backup connection never joined (or disturbed) the app connection.
    expect(db.writeFence.connectionState()).toBe('ok');
    db.close();
  });

  it('a second connection holding an uncommitted write transaction neither blocks nor leaks into the snapshot (WAL)', () => {
    const dir = tempDir();
    const live = join(dir, 'companyos.sqlite');
    const app = openDatabase({ path: live });
    app.exec('CREATE TABLE t (x INTEGER)');
    app.prepare('INSERT INTO t (x) VALUES (1)').run();
    const writer = new DatabaseSync(live);
    writer.exec('PRAGMA busy_timeout = 100');
    writer.exec('BEGIN IMMEDIATE');
    writer.exec('INSERT INTO t (x) VALUES (2), (3)');

    const started = Date.now();
    const snap = createDatabaseSnapshot({ sourcePath: live, backupDir: join(dir, 'backups'), tag: 'periodic', now: clock(), busyTimeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(countRows(snap.path)).toBe(1);
    writer.exec('COMMIT');
    writer.close();
    expect(countRows(createDatabaseSnapshot({ sourcePath: live, backupDir: join(dir, 'backups'), tag: 'periodic', now: clock(Date.parse('2026-11-05T03:00:00Z')) }).path)).toBe(3);
    app.close();
  });

  it('interleaved concurrent writes: every snapshot equals the committed state at its instant and passes integrity_check', () => {
    const dir = tempDir();
    const live = join(dir, 'companyos.sqlite');
    const a = openDatabase({ path: live });
    a.exec('CREATE TABLE t (x INTEGER, pad TEXT)');
    const b = new DatabaseSync(live);
    const now = clock();
    const expected: number[] = [];
    const paths: string[] = [];
    let committed = 0;
    for (let round = 0; round < 6; round += 1) {
      const writer = round % 2 === 0 ? (sql: string) => a.exec(sql) : (sql: string) => b.exec(sql);
      writer(`INSERT INTO t (x, pad) VALUES ${Array.from({ length: 50 }, (_, i) => `(${String(i)}, '${'p'.repeat(200)}')`).join(',')}`);
      committed += 50;
      b.exec('BEGIN IMMEDIATE');
      b.exec("INSERT INTO t (x, pad) VALUES (-1, 'uncommitted')");
      paths.push(createDatabaseSnapshot({ sourcePath: live, backupDir: join(dir, 'backups'), tag: 'periodic', keep: 50, now }).path);
      expected.push(committed);
      b.exec('ROLLBACK');
    }
    expect(paths.map((p) => countRows(p))).toEqual(expected);
    for (const p of paths) expect(inspectDatabaseFile(p).integrity).toEqual(['ok']);
    b.close();
    a.close();
  });
});

describe('DB-BACKUP naming, atomic write and rotation', () => {
  it('file names are Windows-safe (no reserved characters), sortable and round-trip through the parser', () => {
    const at = new Date('2026-11-05T02:03:04.005Z');
    const name = snapshotFileName('pre-migration', at);
    expect(name).toBe('companyos-pre-migration-20261105T020304005Z.sqlite');
    expect(name).not.toMatch(/[<>:"/\\|?*]/u);
    expect(parseSnapshotFileName(name)).toEqual({ tag: 'pre-migration', createdAt: '2026-11-05T02:03:04.005Z', sequence: 0 });
    expect(parseSnapshotFileName(snapshotFileName('start', at, 3))?.sequence).toBe(3);
    expect(parseSnapshotFileName('companyos-start-2026-11-05T02:03:04Z.sqlite')).toBeNull();
    expect(parseSnapshotFileName('..\\companyos-start-20261105T020304005Z.sqlite')).toBeNull();
    // Inside a Windows userData path with spaces and CJK, the name stays one path segment.
    const full = win32.join('C:\\Users\\陈 雁松\\AppData\\Roaming\\CompanyOS', 'backups', name);
    expect(win32.basename(full)).toBe(name);
    expect(win32.dirname(full)).toBe('C:\\Users\\陈 雁松\\AppData\\Roaming\\CompanyOS\\backups');
    expect(full.slice(2)).not.toContain(':'); // only the drive colon
  });

  it('writes under a userData path with spaces and CJK, via a temp file that never remains', () => {
    const root = tempDir();
    const userData = join(root, 'App Data', '公司 OS 用户');
    mkdirSync(join(userData, 'data'), { recursive: true });
    const live = join(userData, 'data', 'companyos.sqlite');
    const db = openDatabase({ path: live });
    db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('数据')");
    const backupDir = join(userData, 'backups');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, '.companyos-periodic-20200101T000000000Z.sqlite.partial'), 'stale');

    const snap = createDatabaseSnapshot({ sourcePath: live, backupDir, tag: 'start', now: clock() });
    expect(snap.path.startsWith(backupDir)).toBe(true);
    expect(readdirSync(backupDir)).toEqual([snap.fileName]); // stale partial removed, no new partial
    expect(countRows(snap.path)).toBe(1);
    db.close();
  });

  it('a failed snapshot throws typed DATABASE_BACKUP_FAILED and leaves no partial or listed file', () => {
    const dir = tempDir();
    const backupDir = join(dir, 'backups');
    expect(kindOf(() => createDatabaseSnapshot({ sourcePath: join(dir, 'missing.sqlite'), backupDir, tag: 'start' }))).toBe('DATABASE_BACKUP_FAILED');
    const notDb = join(dir, 'not-a-db.sqlite');
    writeFileSync(notDb, 'this is not sqlite'.repeat(100));
    expect(kindOf(() => createDatabaseSnapshot({ sourcePath: notDb, backupDir, tag: 'start' }))).toBe('DATABASE_BACKUP_FAILED');
    expect(existsSync(backupDir) ? readdirSync(backupDir) : []).toEqual([]);
  });

  it('keeps the newest N per tag and never touches other tags', () => {
    const dir = tempDir();
    const live = join(dir, 'companyos.sqlite');
    const db = openDatabase({ path: live });
    db.exec('CREATE TABLE t (x INTEGER)');
    const backupDir = join(dir, 'backups');
    const now = clock();
    for (let i = 0; i < 3; i += 1) createDatabaseSnapshot({ sourcePath: live, backupDir, tag: 'pre-migration', now });
    const created = Array.from({ length: 12 }, () => createDatabaseSnapshot({ sourcePath: live, backupDir, tag: 'periodic', keep: 10, now }));
    const periodic = listDatabaseSnapshots(backupDir).filter((s) => s.tag === 'periodic');
    expect(periodic).toHaveLength(10);
    expect(periodic.map((s) => s.fileName)).toEqual(created.slice(2).reverse().map((s) => s.fileName)); // newest first
    expect(created[11]?.rotatedOut).toHaveLength(1);
    expect(listDatabaseSnapshots(backupDir).filter((s) => s.tag === 'pre-migration')).toHaveLength(3);
    expect(rotateDatabaseSnapshots(backupDir, 'pre-migration', 1)).toHaveLength(2);
    expect(() => rotateDatabaseSnapshots(backupDir, 'periodic', 0)).toThrow(TypeError);
    // Same-millisecond snapshots get a sequence suffix instead of colliding.
    const fixed = () => new Date('2026-12-01T00:00:00.000Z');
    const one = createDatabaseSnapshot({ sourcePath: live, backupDir, tag: 'manual', now: fixed });
    const two = createDatabaseSnapshot({ sourcePath: live, backupDir, tag: 'manual', now: fixed });
    expect(two.fileName).toBe(one.fileName.replace('.sqlite', '-1.sqlite'));
    db.close();
  });
});

describe('DB-BACKUP pre-migration hook (openDurableDatabase.beforeMigrations)', () => {
  it('is not called for a fresh database or when nothing is pending', () => {
    const dir = tempDir();
    const hook = vi.fn<(info: BeforeMigrationsInfo) => void>();
    openDurableDatabase({ dataDir: dir, appliedAt: 't1', beforeMigrations: hook }).close();
    openDurableDatabase({ dataDir: dir, appliedAt: 't2', beforeMigrations: hook }).close();
    expect(hook).not.toHaveBeenCalled();
  });

  it('snapshots the OLD schema before pending migrations are applied', () => {
    const dir = tempDir();
    openDurableDatabase({ dataDir: dir, appliedAt: 't1' }).close(); // core + engine only
    const before = migrationRows(join(dir, 'companyos.sqlite'));
    const backupDir = join(dir, 'backups');
    let snapshotPath = '';
    const hook = vi.fn((info: BeforeMigrationsInfo) => {
      snapshotPath = createDatabaseSnapshot({ sourcePath: info.path, backupDir, tag: 'pre-migration' }).path;
    });
    const opened = openDurableDatabase({ dataDir: dir, appliedAt: 't2', chains: ['core', 'engine', 'lifecycle'], beforeMigrations: hook });
    expect(hook).toHaveBeenCalledTimes(1);
    const info = hook.mock.calls[0]?.[0];
    expect(info?.appliedCount).toBe(before.length);
    expect(info?.pending.length).toBeGreaterThan(0);
    expect(info?.pending.every((name) => !before.includes(name))).toBe(true);
    expect(opened.migrations.lifecycle?.applied.map((m) => m.name)).toEqual(info?.pending);
    opened.close();
    expect(migrationRows(snapshotPath)).toEqual(before); // the backup holds the pre-upgrade schema
    expect(migrationRows(join(dir, 'companyos.sqlite')).length).toBe(before.length + (info?.pending.length ?? 0));
  });

  it('a throwing hook aborts the open: nothing is migrated and the file stays openable', () => {
    const dir = tempDir();
    openDurableDatabase({ dataDir: dir, appliedAt: 't1' }).close();
    const live = join(dir, 'companyos.sqlite');
    const before = migrationRows(live);
    expect(() =>
      openDurableDatabase({
        dataDir: dir,
        appliedAt: 't2',
        chains: ['core', 'engine', 'lifecycle'],
        beforeMigrations: () => {
          throw new Error('disk full');
        },
      }),
    ).toThrow('disk full');
    expect(migrationRows(live)).toEqual(before);
    // The aborted open closed its connection: the file can be reopened (and migrated) normally.
    openDurableDatabase({ dataDir: dir, appliedAt: 't3', chains: ['core', 'engine', 'lifecycle'] }).close();
  });

  it('is skipped for a database from a newer version (the downgrade refusal comes first)', () => {
    const dir = tempDir();
    openDurableDatabase({ dataDir: dir, appliedAt: 't1' }).close();
    const raw = openDatabase({ path: join(dir, 'companyos.sqlite') });
    raw.prepare('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)').run('0999_future', 'f'.repeat(64), 'x');
    raw.close();
    const hook = vi.fn();
    expect(() => openDurableDatabase({ dataDir: dir, appliedAt: 't2', chains: ['core', 'engine', 'lifecycle'], beforeMigrations: hook })).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('DB-BACKUP validation and restore', () => {
  const seed = (dataDir: string): string => {
    const opened = openDurableDatabase({ dataDir, appliedAt: 't1' });
    opened.db.exec("CREATE TABLE probe (v TEXT); INSERT INTO probe VALUES ('original')");
    opened.close();
    return join(dataDir, 'companyos.sqlite');
  };

  it('restore round-trip: safety copy of the current data, stale WAL removed, backup data back', () => {
    const root = tempDir();
    const dataDir = join(root, '用户 数据', 'data');
    const live = seed(dataDir);
    const backupDir = join(root, '用户 数据', 'backups');
    const now = clock();
    const snap = createDatabaseSnapshot({ sourcePath: live, backupDir, tag: 'periodic', now });

    const later = openDatabase({ path: live });
    later.exec("INSERT INTO probe VALUES ('after-backup')");
    later.close();
    writeFileSync(`${live}-wal`, 'stale wal bytes that must never be replayed');
    writeFileSync(`${live}-shm`, 'stale shm');

    const restored = restoreDatabaseFromBackup({ livePath: live, backupPath: snap.path, backupDir, knownMigrationNames: shippedMigrationNames(), now });
    expect(restored.safetyCopy).not.toBeNull();
    expect(['snapshot', 'raw-copy']).toContain(restored.safetyCopyKind);
    expect(existsSync(`${live}-wal`)).toBe(false);
    expect(existsSync(`${live}-shm`)).toBe(false);
    expect(existsSync(`${live}.restore-partial`)).toBe(false);
    expect(countRows(live, 'probe')).toBe(1);
    expect(restored.schemaVersion).toBeGreaterThan(0);
    // The reopened database works and migrates as usual.
    const reopened = openDurableDatabase({ dataDir, appliedAt: 't9' });
    expect(reopened.db.prepare('SELECT v FROM probe').all().map((r) => (r as { v: string }).v)).toEqual(['original']);
    reopened.close();
  });

  it('a healthy live database gets a verified pre-restore snapshot holding the replaced data', () => {
    const dir = tempDir();
    const live = seed(join(dir, 'data'));
    const backupDir = join(dir, 'backups');
    const now = clock();
    const snap = createDatabaseSnapshot({ sourcePath: live, backupDir, tag: 'start', now });
    const later = openDatabase({ path: live });
    later.exec("INSERT INTO probe VALUES ('newer')");
    later.close();

    const restored = restoreDatabaseFromBackup({ livePath: live, backupPath: snap.path, backupDir, knownMigrationNames: shippedMigrationNames(), now });
    expect(restored.safetyCopyKind).toBe('snapshot');
    expect(parseSnapshotFileName(restored.safetyCopy?.split(/[\\/]/u).pop() ?? '')?.tag).toBe('pre-restore');
    expect(countRows(restored.safetyCopy ?? '', 'probe')).toBe(2);
    expect(countRows(live, 'probe')).toBe(1);
  });

  it('rejects corrupt, foreign and newer-version backups and leaves the live database untouched', () => {
    const dir = tempDir();
    const live = seed(join(dir, 'data'));
    const backupDir = join(dir, 'backups');
    const known = shippedMigrationNames();
    const good = createDatabaseSnapshot({ sourcePath: live, backupDir, tag: 'periodic', now: clock() });
    const liveHash = sha(live);

    const garbage = join(dir, 'garbage.sqlite');
    writeFileSync(garbage, Buffer.alloc(8192, 0x5a));
    const truncated = join(dir, 'truncated.sqlite');
    writeFileSync(truncated, readFileSync(good.path));
    truncateSync(truncated, Math.floor(statSync(truncated).size / 2));
    const flipped = join(dir, 'flipped.sqlite');
    const bytes = readFileSync(good.path);
    for (let i = 4096 + 100; i < Math.min(bytes.length, 4096 * 3); i += 7) bytes[i] = 0xff - (bytes[i] ?? 0);
    writeFileSync(flipped, bytes);
    const foreign = join(dir, 'foreign.sqlite');
    const f = new DatabaseSync(foreign);
    f.exec('CREATE TABLE x (y)');
    f.close();
    const newer = join(dir, 'newer.sqlite');
    writeFileSync(newer, readFileSync(good.path));
    const n = new DatabaseSync(newer);
    n.prepare('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)').run('0999_future', 'f'.repeat(64), 'x');
    n.close();

    expect(kindOf(() => validateDatabaseBackup(join(dir, 'nope.sqlite'), known))).toBe('BACKUP_NOT_FOUND');
    expect(kindOf(() => validateDatabaseBackup(garbage, known))).toBe('BACKUP_CORRUPT');
    expect(kindOf(() => validateDatabaseBackup(truncated, known))).toBe('BACKUP_CORRUPT');
    expect(kindOf(() => validateDatabaseBackup(flipped, known))).toBe('BACKUP_CORRUPT');
    expect(kindOf(() => validateDatabaseBackup(foreign, known))).toBe('BACKUP_NOT_COMPANYOS');
    expect(kindOf(() => validateDatabaseBackup(newer, known))).toBe('BACKUP_FROM_NEWER_VERSION');
    for (const bad of [garbage, truncated, flipped, foreign, newer]) {
      expect(() => restoreDatabaseFromBackup({ livePath: live, backupPath: bad, backupDir, knownMigrationNames: known })).toThrow();
    }
    expect(sha(live)).toBe(liveHash);
    expect(listDatabaseSnapshots(backupDir).filter((s) => s.tag === 'pre-restore')).toHaveLength(0); // refused before any safety copy
    expect(validateDatabaseBackup(good.path, known).migrationCount).toBeGreaterThan(0);
  });
});
