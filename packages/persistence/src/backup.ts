/**
 * DB-BACKUP — local SQLite snapshots, rotation, validation and restore.
 *
 * Owned by @companyos/persistence because this package owns the SQLite file and its
 * migrations; the driver itself is only touched through db.ts (`snapshotDatabaseFile`,
 * `inspectDatabaseFile`). The desktop shell decides WHEN to snapshot (start, before
 * migrations, periodically) and WHERE (`<userData>/backups`); see
 * docs/hark-lane/DB_BACKUP.md.
 *
 * File naming is filesystem-safe on every platform (no ':' — Windows forbids it):
 *   companyos-<tag>-YYYYMMDDTHHMMSSmmmZ[-n].sqlite
 * A snapshot is written to a dot-prefixed `.partial` file in the same directory, flushed,
 * integrity-checked and only then renamed into place, so a listed backup is always a
 * complete, verified database.
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { domainError, type DomainError } from '@companyos/core';

import { inspectDatabaseFile, snapshotDatabaseFile } from './db.js';

export const DATABASE_SNAPSHOT_TAGS = ['start', 'pre-migration', 'periodic', 'pre-restore', 'manual'] as const;
export type DatabaseSnapshotTag = (typeof DATABASE_SNAPSHOT_TAGS)[number];

/** Default number of snapshots kept PER TAG. */
export const DEFAULT_SNAPSHOT_KEEP = 10;

export interface DatabaseSnapshot {
  readonly fileName: string;
  readonly path: string;
  readonly tag: DatabaseSnapshotTag;
  /** ISO-8601 UTC instant encoded in the file name. */
  readonly createdAt: string;
  readonly bytes: number;
}

const SNAPSHOT_NAME = /^companyos-(start|pre-migration|periodic|pre-restore|manual)-(\d{8})T(\d{6})(\d{3})Z(?:-(\d+))?\.sqlite$/u;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** `2026-11-05T02:03:04.005Z` → `20261105T020304005Z` (no ':' / '.', sortable). */
export const snapshotStamp = (at: Date): string =>
  `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}T` +
  `${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}${pad(at.getUTCSeconds(), 2)}${pad(at.getUTCMilliseconds(), 3)}Z`;

export const snapshotFileName = (tag: DatabaseSnapshotTag, at: Date, sequence = 0): string =>
  `companyos-${tag}-${snapshotStamp(at)}${sequence > 0 ? `-${String(sequence)}` : ''}.sqlite`;

export interface ParsedSnapshotName {
  readonly tag: DatabaseSnapshotTag;
  readonly createdAt: string;
  readonly sequence: number;
}

export function parseSnapshotFileName(fileName: string): ParsedSnapshotName | null {
  const match = SNAPSHOT_NAME.exec(fileName);
  if (match === null) return null;
  const [, tag, date, time, millis, sequence] = match as unknown as [string, DatabaseSnapshotTag, string, string, string, string | undefined];
  const createdAt = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.${millis}Z`;
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return { tag, createdAt, sequence: sequence === undefined ? 0 : Number(sequence) };
}

const backupError = (kind: string, message: string, details: Readonly<Record<string, unknown>> = {}): DomainError =>
  domainError('PERSISTENCE_FAILED', message, { kind, ...details });

const causeOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Flush a file's contents to stable storage (best effort for directories on Windows). */
const fsyncPath = (path: string, directory = false): void => {
  let fd: number | null = null;
  try {
    fd = openSync(path, directory ? 'r' : 'r+');
    fsyncSync(fd);
  } catch (error) {
    // Windows cannot open (or fsync) a directory handle through node:fs; file fsync must work.
    if (!directory) throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

const isHealthy = (integrity: readonly string[]): boolean => integrity.length === 1 && integrity[0] === 'ok';

/** Newest first; files that do not match the naming scheme (and `.partial` files) are ignored. */
export function listDatabaseSnapshots(backupDir: string): readonly DatabaseSnapshot[] {
  if (!existsSync(backupDir)) return [];
  const snapshots: DatabaseSnapshot[] = [];
  for (const fileName of readdirSync(backupDir)) {
    const parsed = parseSnapshotFileName(fileName);
    if (parsed === null) continue;
    const path = join(backupDir, fileName);
    let bytes = 0;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      bytes = stat.size;
    } catch {
      continue; // removed concurrently
    }
    snapshots.push({ fileName, path, tag: parsed.tag, createdAt: parsed.createdAt, bytes });
  }
  return snapshots.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    const sa = parseSnapshotFileName(a.fileName)?.sequence ?? 0;
    const sb = parseSnapshotFileName(b.fileName)?.sequence ?? 0;
    return sb - sa;
  });
}

/** Keep the newest `keep` snapshots of `tag`; returns the removed file names. */
export function rotateDatabaseSnapshots(backupDir: string, tag: DatabaseSnapshotTag, keep: number): readonly string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new TypeError(`keep must be a positive integer, got ${String(keep)}`);
  const removed: string[] = [];
  for (const snapshot of listDatabaseSnapshots(backupDir).filter((s) => s.tag === tag).slice(keep)) {
    rmSync(snapshot.path, { force: true });
    removed.push(snapshot.fileName);
  }
  return removed;
}

export interface CreateDatabaseSnapshotOptions {
  /** The live SQLite file. It may be open (and mid-transaction) on another connection. */
  readonly sourcePath: string;
  readonly backupDir: string;
  readonly tag: DatabaseSnapshotTag;
  readonly now?: () => Date;
  /** Snapshots kept for this tag after the new one is written (default 10). */
  readonly keep?: number;
  readonly busyTimeoutMs?: number;
}

export interface CreatedDatabaseSnapshot extends DatabaseSnapshot {
  readonly rotatedOut: readonly string[];
}

/**
 * Write one verified snapshot: VACUUM INTO a `.partial` temp file → fsync → integrity_check
 * → atomic rename → rotate. Any failure removes the temp file and throws a typed
 * `PERSISTENCE_FAILED` (details.kind `DATABASE_BACKUP_FAILED`); the live file is never
 * written.
 */
export function createDatabaseSnapshot(options: CreateDatabaseSnapshotOptions): CreatedDatabaseSnapshot {
  const now = options.now ?? (() => new Date());
  const keep = options.keep ?? DEFAULT_SNAPSHOT_KEEP;
  if (!Number.isInteger(keep) || keep < 1) throw new TypeError(`keep must be a positive integer, got ${String(keep)}`);
  if (options.sourcePath === ':memory:' || !existsSync(options.sourcePath)) {
    throw backupError('DATABASE_BACKUP_FAILED', `No database file to back up at ${options.sourcePath}.`, {
      reason: 'SOURCE_MISSING',
      sourcePath: options.sourcePath,
      tag: options.tag,
    });
  }
  const at = now();
  let fileName = '';
  let finalPath = '';
  let temp = '';
  try {
    mkdirSync(options.backupDir, { recursive: true });
    // Leftover temp files of an interrupted earlier snapshot are never valid backups.
    for (const entry of readdirSync(options.backupDir)) {
      if (entry.startsWith('.companyos-') && entry.endsWith('.partial')) rmSync(join(options.backupDir, entry), { force: true });
    }
    for (let sequence = 0; ; sequence += 1) {
      fileName = snapshotFileName(options.tag, at, sequence);
      finalPath = join(options.backupDir, fileName);
      if (!existsSync(finalPath)) break;
    }
    temp = join(options.backupDir, `.${fileName}.partial`);
    snapshotDatabaseFile(options.sourcePath, temp, {
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    });
    fsyncPath(temp);
    const inspection = inspectDatabaseFile(temp);
    if (!isHealthy(inspection.integrity)) {
      throw backupError('DATABASE_BACKUP_FAILED', 'The fresh snapshot failed PRAGMA integrity_check.', {
        reason: 'SNAPSHOT_INTEGRITY_FAILED',
        integrity: inspection.integrity.slice(0, 5),
      });
    }
    renameSync(temp, finalPath);
    fsyncPath(options.backupDir, true);
  } catch (error) {
    if (temp !== '') rmSync(temp, { force: true });
    if (error instanceof Error && (error as { details?: { kind?: unknown } }).details?.kind === 'DATABASE_BACKUP_FAILED') throw error;
    throw backupError('DATABASE_BACKUP_FAILED', `Database snapshot "${options.tag}" failed: ${causeOf(error)}`, {
      reason: 'SNAPSHOT_WRITE_FAILED',
      tag: options.tag,
      sourcePath: options.sourcePath,
      backupDir: options.backupDir,
      cause: causeOf(error),
    });
  }
  // Rotation runs only after the new snapshot is safely in place; a rotation failure does
  // not invalidate the snapshot that was just written.
  let rotatedOut: readonly string[] = [];
  try {
    rotatedOut = rotateDatabaseSnapshots(options.backupDir, options.tag, keep);
  } catch {
    rotatedOut = [];
  }
  return {
    fileName,
    path: finalPath,
    tag: options.tag,
    createdAt: at.toISOString(),
    bytes: statSync(finalPath).size,
    rotatedOut,
  };
}

export interface ValidatedDatabaseBackup {
  readonly path: string;
  readonly migrationCount: number;
  readonly schemaVersion: number;
}

const schemaVersionOf = (names: readonly string[]): number =>
  names.reduce((max, name) => {
    const version = Number(name.slice(0, 4));
    return Number.isFinite(version) && version > max ? version : max;
  }, 0);

/**
 * Is `path` a restorable CompanyOS database for THIS build? Checks, in order: the file
 * exists, opens as SQLite, passes `PRAGMA integrity_check`, carries `schema_migrations`
 * with at least one row, and every applied migration is one this build ships (a backup
 * written by a newer CompanyOS is refused exactly like the live downgrade refusal).
 * Failures are typed `PERSISTENCE_FAILED` with details.kind:
 * BACKUP_NOT_FOUND | BACKUP_CORRUPT | BACKUP_NOT_COMPANYOS | BACKUP_FROM_NEWER_VERSION.
 */
export function validateDatabaseBackup(path: string, knownMigrationNames: ReadonlySet<string>): ValidatedDatabaseBackup {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw backupError('BACKUP_NOT_FOUND', `Backup file not found: ${path}`, { path });
  }
  let inspection;
  try {
    inspection = inspectDatabaseFile(path);
  } catch (error) {
    throw backupError('BACKUP_CORRUPT', `The backup is not a readable SQLite database: ${causeOf(error)}`, { path, cause: causeOf(error) });
  }
  if (!isHealthy(inspection.integrity)) {
    throw backupError('BACKUP_CORRUPT', 'The backup failed PRAGMA integrity_check.', { path, integrity: inspection.integrity.slice(0, 5) });
  }
  if (inspection.migrationNames === null || inspection.migrationNames.length === 0) {
    throw backupError('BACKUP_NOT_COMPANYOS', 'The backup has no applied CompanyOS migrations (schema_migrations missing or empty).', { path });
  }
  const unknown = inspection.migrationNames.filter((name) => !knownMigrationNames.has(name));
  if (unknown.length > 0) {
    throw backupError('BACKUP_FROM_NEWER_VERSION', `The backup was written by a newer CompanyOS version (unknown migrations: ${unknown.join(', ')}).`, {
      path,
      unknownMigrations: unknown,
    });
  }
  return { path, migrationCount: inspection.migrationNames.length, schemaVersion: schemaVersionOf(inspection.migrationNames) };
}

export interface RestoreDatabaseOptions {
  /** The live database file. It MUST be closed by every connection of this process. */
  readonly livePath: string;
  readonly backupPath: string;
  /** Where the safety copy of the current live database is written. */
  readonly backupDir: string;
  readonly knownMigrationNames: ReadonlySet<string>;
  readonly now?: () => Date;
  readonly keep?: number;
}

export interface RestoredDatabase {
  readonly restoredFrom: string;
  /** Verified `pre-restore` snapshot (or raw copy directory) of the database that was replaced; null when none existed. */
  readonly safetyCopy: string | null;
  readonly safetyCopyKind: 'snapshot' | 'raw-copy' | 'none';
  readonly schemaVersion: number;
}

/**
 * Replace the (closed) live database with a validated backup.
 *
 *   1. validate the backup (integrity_check + schema known to this build) — refuse otherwise;
 *   2. keep a safety copy of the current live database: a verified `pre-restore` snapshot,
 *      or — when the live file is too damaged to snapshot — a raw copy of the file and its
 *      -wal/-shm into `<backupDir>/pre-restore-raw-<stamp>/`; if neither works, abort;
 *   3. copy the backup to `<live>.restore-partial`, fsync, integrity-check the copy;
 *   4. delete the live -wal/-shm (a stale WAL replayed onto another database corrupts it),
 *      then atomically rename the staged copy over the live file.
 * Until step 4 the live database is untouched; after a crash inside step 4 the safety copy
 * still holds the replaced data.
 */
export function restoreDatabaseFromBackup(options: RestoreDatabaseOptions): RestoredDatabase {
  const now = options.now ?? (() => new Date());
  const validated = validateDatabaseBackup(options.backupPath, options.knownMigrationNames);

  let safetyCopy: string | null = null;
  let safetyCopyKind: RestoredDatabase['safetyCopyKind'] = 'none';
  if (existsSync(options.livePath)) {
    try {
      safetyCopy = createDatabaseSnapshot({
        sourcePath: options.livePath,
        backupDir: options.backupDir,
        tag: 'pre-restore',
        now,
        ...(options.keep === undefined ? {} : { keep: options.keep }),
      }).path;
      safetyCopyKind = 'snapshot';
    } catch (snapshotError) {
      const rawDir = join(options.backupDir, `pre-restore-raw-${snapshotStamp(now())}`);
      try {
        mkdirSync(rawDir, { recursive: true });
        for (const suffix of ['', '-wal', '-shm']) {
          const file = `${options.livePath}${suffix}`;
          if (existsSync(file)) copyFileSync(file, join(rawDir, `${basename(options.livePath)}${suffix}`));
        }
        safetyCopy = rawDir;
        safetyCopyKind = 'raw-copy';
      } catch (copyError) {
        throw backupError('RESTORE_SAFETY_COPY_FAILED', 'Restore aborted: the current database could not be preserved first.', {
          snapshotCause: causeOf(snapshotError),
          copyCause: causeOf(copyError),
        });
      }
    }
  }

  const staged = `${options.livePath}.restore-partial`;
  try {
    rmSync(staged, { force: true });
    copyFileSync(options.backupPath, staged);
    fsyncPath(staged);
    const inspection = inspectDatabaseFile(staged);
    if (!isHealthy(inspection.integrity)) {
      throw backupError('RESTORE_STAGE_FAILED', 'The staged copy of the backup failed PRAGMA integrity_check.', { integrity: inspection.integrity.slice(0, 5) });
    }
  } catch (error) {
    rmSync(staged, { force: true });
    if (error instanceof Error && (error as { details?: { kind?: unknown } }).details?.kind === 'RESTORE_STAGE_FAILED') throw error;
    throw backupError('RESTORE_STAGE_FAILED', `Restore aborted while staging the backup: ${causeOf(error)}`, { cause: causeOf(error) });
  }

  try {
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${options.livePath}${suffix}`, { force: true });
    renameSync(staged, options.livePath);
  } catch (error) {
    rmSync(staged, { force: true });
    throw backupError('RESTORE_SWAP_FAILED', `Restore failed while swapping the database file (is it still open?): ${causeOf(error)}`, {
      cause: causeOf(error),
      safetyCopy,
    });
  }
  return { restoredFrom: options.backupPath, safetyCopy, safetyCopyKind, schemaVersion: validated.schemaVersion };
}
