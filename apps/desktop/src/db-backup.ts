/**
 * DB-BACKUP — the desktop's local SQLite backup policy (docs/hark-lane/DB_BACKUP.md).
 *
 * WHEN (decided here, mechanics in @companyos/persistence backup.ts):
 *   - `pre-migration`: inside openDurableDatabase, after open and before the first pending
 *     migration, only when existing data would be migrated. MANDATORY: a failed snapshot
 *     throws and the open is aborted — the app never migrates unprotected; the shell opens
 *     with the typed OPEN_FAILED banner and the data stays on the old schema, untouched.
 *   - `start`: once per process, right after the database first opens (the state the
 *     previous session left, before startup recovery touches it). Best effort.
 *   - `periodic`: every COMPANYOS_DB_BACKUP_INTERVAL_HOURS (default 6, 0 = off) while the
 *     app runs. Best effort.
 * A best-effort failure is logged and kept as a diagnostic (databaseStatus.backup); it
 * never blocks startup or the running app.
 *
 * WHERE: `<userData>/backups/companyos-<tag>-<UTC stamp>.sqlite`, newest
 * COMPANYOS_DB_BACKUP_KEEP (default 10) kept per tag.
 *
 * RESTORE: a restore is STAGED (`restore-request.json` beside the backups, written by
 * `requestDatabaseRestore` — e.g. from resources/setup/restore-database.mjs) and applied
 * by `applyPendingDatabaseRestore` at the next start, BEFORE the database is opened: the
 * live database is therefore closed by construction, the swap happens in quiescent
 * startup, and the normal bootstrap reopens (and, for an older backup, re-migrates) it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createDatabaseSnapshot,
  DEFAULT_SNAPSHOT_KEEP,
  listDatabaseSnapshots,
  parseSnapshotFileName,
  restoreDatabaseFromBackup,
  shippedMigrationNames,
  validateDatabaseBackup,
  type BeforeMigrationsInfo,
  type CreatedDatabaseSnapshot,
  type DatabaseSnapshot,
  type DatabaseSnapshotTag,
  type RestoredDatabase,
} from '@companyos/persistence';
import { domainError } from '@companyos/core';

export const DATABASE_BACKUP_DIR = 'backups';
export const DATABASE_RESTORE_REQUEST_FILE = 'restore-request.json';
export const DATABASE_RESTORE_REQUEST_SCHEMA = 'companyos/db-restore-request/1';
export const DEFAULT_BACKUP_INTERVAL_HOURS = 6;
export const BACKUP_INTERVAL_ENV = 'COMPANYOS_DB_BACKUP_INTERVAL_HOURS';
export const BACKUP_KEEP_ENV = 'COMPANYOS_DB_BACKUP_KEEP';

const MIN_INTERVAL_HOURS = 0.25;
const MAX_INTERVAL_HOURS = 168;
const MAX_KEEP = 100;

export interface BackupLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const databaseBackupDir = (userDataDir: string): string => join(userDataDir, DATABASE_BACKUP_DIR);

/** Every migration name this build ships (a backup outside this set came from a newer version). */
export const shippedDatabaseMigrationNames = (): ReadonlySet<string> => shippedMigrationNames();

/** List the backups in `<userData>/backups`, newest first (the restore helper shows these). */
export const listDatabaseBackups = (userDataDir: string): readonly DatabaseSnapshot[] =>
  listDatabaseSnapshots(databaseBackupDir(userDataDir));

export interface DatabaseBackupSettings {
  /** 0 disables the periodic snapshot (start + pre-migration stay on). */
  readonly intervalMs: number;
  readonly keep: number;
  /** Human-readable reasons a configured value was rejected (the default was used). */
  readonly warnings: readonly string[];
}

/** Settings from the captured runtime env; invalid values fall back to the defaults, with a warning. */
export function databaseBackupSettings(env: Readonly<Record<string, string | undefined>>): DatabaseBackupSettings {
  const warnings: string[] = [];
  let hours = DEFAULT_BACKUP_INTERVAL_HOURS;
  const rawHours = env[BACKUP_INTERVAL_ENV];
  if (rawHours !== undefined && rawHours.trim() !== '') {
    const parsed = Number(rawHours);
    if (Number.isFinite(parsed) && (parsed === 0 || (parsed >= MIN_INTERVAL_HOURS && parsed <= MAX_INTERVAL_HOURS))) hours = parsed;
    else warnings.push(`${BACKUP_INTERVAL_ENV}=${rawHours} is not 0 or ${String(MIN_INTERVAL_HOURS)}..${String(MAX_INTERVAL_HOURS)}; using ${String(DEFAULT_BACKUP_INTERVAL_HOURS)}`);
  }
  let keep = DEFAULT_SNAPSHOT_KEEP;
  const rawKeep = env[BACKUP_KEEP_ENV];
  if (rawKeep !== undefined && rawKeep.trim() !== '') {
    const parsed = Number(rawKeep);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_KEEP) keep = parsed;
    else warnings.push(`${BACKUP_KEEP_ENV}=${rawKeep} is not an integer 1..${String(MAX_KEEP)}; using ${String(DEFAULT_SNAPSHOT_KEEP)}`);
  }
  return { intervalMs: Math.round(hours * 3_600_000), keep, warnings };
}

/* ------------------------------------------------------------ pre-migration -- */

/**
 * The openDurableDatabase `beforeMigrations` hook: a verified `pre-migration` snapshot or
 * a thrown typed error (details.kind PRE_MIGRATION_BACKUP_FAILED) that aborts the open.
 */
export function preMigrationBackupHook(options: {
  readonly backupDir: string;
  readonly keep: number;
  readonly logger: BackupLogger;
  readonly now?: () => Date;
  readonly onSnapshot?: (snapshot: CreatedDatabaseSnapshot) => void;
}): (info: BeforeMigrationsInfo) => void {
  return (info) => {
    try {
      const snapshot = createDatabaseSnapshot({
        sourcePath: info.path,
        backupDir: options.backupDir,
        tag: 'pre-migration',
        keep: options.keep,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      options.logger.info('database pre-migration snapshot written', {
        file: snapshot.fileName,
        bytes: snapshot.bytes,
        pending: info.pending.length,
      });
      options.onSnapshot?.(snapshot);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      options.logger.error('database pre-migration snapshot failed; migration refused', { error: cause, pending: info.pending });
      throw domainError(
        'PERSISTENCE_FAILED',
        `升级数据库前的备份失败，未执行迁移（数据保持原样）：${cause}`,
        { kind: 'PRE_MIGRATION_BACKUP_FAILED', pending: info.pending, cause },
      );
    }
  };
}

/* ---------------------------------------------------------------- scheduler -- */

export interface DatabaseBackupStatus {
  readonly dir: string;
  readonly intervalHours: number;
  readonly keep: number;
  readonly lastSnapshot: { readonly fileName: string; readonly tag: DatabaseSnapshotTag; readonly createdAt: string } | null;
  readonly lastError: { readonly tag: DatabaseSnapshotTag; readonly at: string; readonly message: string } | null;
  readonly consecutiveFailures: number;
  readonly lastRestore: DatabaseRestoreOutcome | null;
}

export interface DatabaseBackupScheduler {
  /** Takes the `start` snapshot now (best effort) and arms the periodic timer. Idempotent. */
  start(): void;
  stop(): void;
  /** One best-effort snapshot; null when it failed (the failure is in status()). */
  snapshotNow(tag: DatabaseSnapshotTag): CreatedDatabaseSnapshot | null;
  /** Record a snapshot taken elsewhere (the pre-migration hook) in the diagnostics. */
  recordSnapshot(snapshot: CreatedDatabaseSnapshot): void;
  recordRestore(outcome: DatabaseRestoreOutcome): void;
  status(): DatabaseBackupStatus;
}

export function createDatabaseBackupScheduler(options: {
  /** The live database file, or null while it is not open. */
  readonly sourcePath: () => string | null;
  readonly backupDir: string;
  readonly intervalMs: number;
  readonly keep: number;
  readonly logger: BackupLogger;
  readonly now?: () => Date;
}): DatabaseBackupScheduler {
  const now = options.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let lastSnapshot: DatabaseBackupStatus['lastSnapshot'] = null;
  let lastError: DatabaseBackupStatus['lastError'] = null;
  let consecutiveFailures = 0;
  let lastRestore: DatabaseRestoreOutcome | null = null;

  const recordSnapshot = (snapshot: CreatedDatabaseSnapshot): void => {
    lastSnapshot = { fileName: snapshot.fileName, tag: snapshot.tag, createdAt: snapshot.createdAt };
    consecutiveFailures = 0;
  };

  const snapshotNow = (tag: DatabaseSnapshotTag): CreatedDatabaseSnapshot | null => {
    const sourcePath = options.sourcePath();
    if (sourcePath === null || sourcePath === ':memory:') {
      return null; // nothing open to back up (the database failed to open, or tests)
    }
    try {
      const snapshot = createDatabaseSnapshot({ sourcePath, backupDir: options.backupDir, tag, keep: options.keep, now });
      recordSnapshot(snapshot);
      options.logger.info('database snapshot written', { tag, file: snapshot.fileName, bytes: snapshot.bytes, rotatedOut: snapshot.rotatedOut.length });
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      consecutiveFailures += 1;
      lastError = { tag, at: now().toISOString(), message };
      options.logger.warn('database snapshot failed (app continues)', { tag, error: message, consecutiveFailures });
      return null;
    }
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      snapshotNow('start');
      if (options.intervalMs > 0) {
        timer = setInterval(() => {
          snapshotNow('periodic');
        }, options.intervalMs);
        // A pending periodic snapshot must never keep the process alive on quit.
        (timer as { unref?: () => void }).unref?.();
      }
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    snapshotNow,
    recordSnapshot,
    recordRestore(outcome: DatabaseRestoreOutcome): void {
      lastRestore = outcome;
    },
    status(): DatabaseBackupStatus {
      return {
        dir: options.backupDir,
        intervalHours: options.intervalMs / 3_600_000,
        keep: options.keep,
        lastSnapshot,
        lastError,
        consecutiveFailures,
        lastRestore,
      };
    },
  };
}

/* ------------------------------------------------------------------ restore -- */

export interface DatabaseRestoreRequest {
  readonly schema: typeof DATABASE_RESTORE_REQUEST_SCHEMA;
  /** A snapshot file NAME inside the backups directory (never a path). */
  readonly backup: string;
  readonly requestedAt: string;
}

export type DatabaseRestoreOutcome =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'restored';
      readonly backup: string;
      readonly safetyCopy: string | null;
      readonly safetyCopyKind: RestoredDatabase['safetyCopyKind'];
      readonly schemaVersion: number;
      readonly at: string;
    }
  | { readonly kind: 'refused'; readonly backup: string | null; readonly code: string; readonly message: string; readonly at: string };

const restoreRefusal = (code: string, message: string): Error =>
  domainError('VALIDATION_FAILED', message, { kind: code });

/** Resolve a requested backup NAME to its path inside `backupDir`, refusing anything else. */
export function resolveBackupFile(backupDir: string, backupFileName: string): DatabaseSnapshot {
  if (parseSnapshotFileName(backupFileName) === null) {
    throw restoreRefusal('RESTORE_BACKUP_NAME_INVALID', `"${backupFileName}" is not a CompanyOS backup file name.`);
  }
  const found = listDatabaseSnapshots(backupDir).find((snapshot) => snapshot.fileName === backupFileName);
  if (found === undefined) {
    throw restoreRefusal('RESTORE_BACKUP_NOT_FOUND', `Backup "${backupFileName}" does not exist in ${backupDir}.`);
  }
  return found;
}

/**
 * Stage a restore for the next app start. The backup is validated NOW (integrity +
 * schema), so a request for a damaged or newer-version backup is refused immediately.
 */
export function requestDatabaseRestore(options: {
  readonly backupDir: string;
  readonly backupFileName: string;
  readonly knownMigrationNames: ReadonlySet<string>;
  readonly now?: () => Date;
}): DatabaseRestoreRequest {
  const snapshot = resolveBackupFile(options.backupDir, options.backupFileName);
  validateDatabaseBackup(snapshot.path, options.knownMigrationNames);
  const request: DatabaseRestoreRequest = {
    schema: DATABASE_RESTORE_REQUEST_SCHEMA,
    backup: snapshot.fileName,
    requestedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  mkdirSync(options.backupDir, { recursive: true });
  const target = join(options.backupDir, DATABASE_RESTORE_REQUEST_FILE);
  const temp = `${target}.partial`;
  writeFileSync(temp, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  renameSync(temp, target);
  return request;
}

export function readDatabaseRestoreRequest(backupDir: string): DatabaseRestoreRequest | null {
  const file = join(backupDir, DATABASE_RESTORE_REQUEST_FILE);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DatabaseRestoreRequest>;
  if (parsed.schema !== DATABASE_RESTORE_REQUEST_SCHEMA || typeof parsed.backup !== 'string' || typeof parsed.requestedAt !== 'string') {
    throw restoreRefusal('RESTORE_REQUEST_INVALID', `${DATABASE_RESTORE_REQUEST_FILE} is not a ${DATABASE_RESTORE_REQUEST_SCHEMA} document.`);
  }
  return { schema: parsed.schema, backup: parsed.backup, requestedAt: parsed.requestedAt };
}

export function cancelDatabaseRestoreRequest(backupDir: string): boolean {
  const file = join(backupDir, DATABASE_RESTORE_REQUEST_FILE);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * Apply a staged restore. MUST run before the database is opened (quiescent startup).
 * The request is consumed first, so a backup that cannot be restored is reported once and
 * never retried on every boot; a refusal leaves the live database untouched.
 */
export function applyPendingDatabaseRestore(options: {
  readonly backupDir: string;
  readonly livePath: string;
  readonly knownMigrationNames: ReadonlySet<string>;
  readonly logger: BackupLogger;
  readonly keep?: number;
  readonly now?: () => Date;
}): DatabaseRestoreOutcome {
  const now = options.now ?? (() => new Date());
  let request: DatabaseRestoreRequest | null = null;
  try {
    request = readDatabaseRestoreRequest(options.backupDir);
    if (request === null) return { kind: 'none' };
    cancelDatabaseRestoreRequest(options.backupDir);
    const snapshot = resolveBackupFile(options.backupDir, request.backup);
    const restored = restoreDatabaseFromBackup({
      livePath: options.livePath,
      backupPath: snapshot.path,
      backupDir: options.backupDir,
      knownMigrationNames: options.knownMigrationNames,
      now,
      ...(options.keep === undefined ? {} : { keep: options.keep }),
    });
    options.logger.info('database restored from backup', {
      backup: snapshot.fileName,
      safetyCopy: restored.safetyCopy,
      safetyCopyKind: restored.safetyCopyKind,
      schemaVersion: restored.schemaVersion,
    });
    return {
      kind: 'restored',
      backup: snapshot.fileName,
      safetyCopy: restored.safetyCopy,
      safetyCopyKind: restored.safetyCopyKind,
      schemaVersion: restored.schemaVersion,
      at: now().toISOString(),
    };
  } catch (error) {
    cancelDatabaseRestoreRequest(options.backupDir);
    const details = (error as { details?: { kind?: unknown } }).details;
    const code = typeof details?.kind === 'string' ? details.kind : 'RESTORE_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    options.logger.error('database restore refused; the current database was kept', { backup: request?.backup ?? null, code, error: message });
    return { kind: 'refused', backup: request?.backup ?? null, code, message, at: now().toISOString() };
  }
}
