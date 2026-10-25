/**
 * @companyos/persistence — SQLite (`node:sqlite`) implementations of the Core
 * persistence ports: `EntityStore` and the checksum-verified migration runner.
 *
 * Law 2 (dependency direction): this package depends on Core and Contracts;
 * nothing in the inner ring may ever depend on it.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type Database, type OpenDatabaseOptions } from './db.js';
import { shippedMigrationNames } from './durable/index.js';
import { applyMigrations, loadMigrations, type MigrationReport } from './migrations.js';

export {
  DEFAULT_BUSY_TIMEOUT_MS,
  openDatabase,
  readPragma,
  tableExists,
  type Database,
  type OpenDatabaseOptions,
  type SqlStatement,
  type SqlValue,
} from './db.js';

export {
  MigrationChecksumError,
  MigrationFormatError,
  MigrationFromNewerVersionError,
  isMigrationFromNewerVersionError,
  applyMigrations,
  checksumOf,
  loadMigrations,
  normalizeSql,
  readAppliedMigrations,
  type ApplyMigrationsOptions,
  type MigrationFile,
  type MigrationRecord,
  type MigrationReport,
} from './migrations.js';

export {
  createEntityStore,
  type CreateEntityStoreOptions,
  type EntityClock,
  type EntityOrderBy,
  type EntityStore,
  type JsonEntity,
} from './entity-store.js';

/* ------------------------------------------------------- durable layer (S3) -- */
export {
  coreMigrationsDir,
  createSqliteApprovalStore,
  createSqliteCommandLedger,
  createSqliteEventStore,
  createSqliteLockStore,
  createSqliteProposalStore,
  createSqliteRunStore,
  createSqliteSessionStore,
  createSqliteSnapshotStore,
  createSqliteTaskStore,
  createSqliteTemplateStore,
  createSqliteUnitOfWork,
  DEFAULT_CHAINS,
  engineMigrationsDir,
  lifecycleMigrationsDir,
  providerMigrationsDir,
  registryMigrationsDir,
  selectionMigrationsDir,
  agentMigrationsDir,
  toolMigrationsDir,
  routerMigrationsDir,
  handoffMigrationsDir,
  openDurableDatabase,
  shippedMigrationNames,
  toPersistenceError,
  type DurableDatabase,
  type MigrationChainName,
  type OpenDurableDatabaseOptions,
  type SqliteEventStore,
  type SqliteUnitOfWork,
} from './durable/index.js';
export {
  isStorageOriginCode,
  runDurableRead,
  storageBoundaryErrorOf,
  type StorageBoundaryContext,
} from './durable/storage-errors.js';
export {
  createSqliteRouterDecisionStore,
  type RouterDecisionReadPort,
  type RouterDecisionRow,
} from './durable/sqlite-router-decisions.js';
export { createSqliteHandoffStore } from './durable/sqlite-handoff-store.js';
export { type RunCreationGuardedStore } from './durable/sqlite-run-store.js';
export { type ExecutionAttemptStore } from './durable/sqlite-execution-attempt-store.js';
export {
  type ProviderDispatch,
  type ProviderDispatchState,
  type ProviderDispatchStore,
} from './durable/sqlite-provider-dispatch-store.js';
export { type TemplateCreationGuardedStore } from './durable/sqlite-template-store.js';
export { createSqliteArtifactStore } from './durable/sqlite-artifact-store.js';
export {
  createSqlitePackVersionStore,
  createSqlitePackInstallationStore,
  createSqlitePackContentRefStore,
  type PackStoresOptions,
} from './durable/sqlite-pack-stores.js';
export { createSqliteValidationStore, validationBatchFingerprintCount } from './durable/sqlite-validation-store.js';
export { createFilesystemArtifactContentStore, type CasStoreOptions } from './content/cas-store.js';
export { createFilesystemArtifactContentDiagnostics, type ArtifactContentDiagnosticsPort } from './content/cas-diagnostics.js';

/** `packages/persistence/migrations` — resolves identically from `src/` and `dist/`. */
export const defaultMigrationsDir = (): string =>
  fileURLToPath(new URL('../migrations/', import.meta.url));

export interface OpenCompanyDatabaseOptions extends Omit<OpenDatabaseOptions, 'path'> {
  /** Directory holding the database file (typically Electron's userData dir). */
  readonly dataDir: string;
  readonly fileName?: string;
  readonly migrationsDir?: string;
  readonly appliedAt: string;
  readonly logger?: { info(message: string, fields?: Record<string, unknown>): void };
}

export interface CompanyDatabase {
  readonly db: Database;
  readonly path: string;
  readonly migrationReport: MigrationReport;
  /** Byte size of the database file, or 0 for in-memory databases. */
  readonly journalMode: string;
}

/**
 * Open (creating if needed) the CompanyOS database and bring the schema up to
 * date. Used by the desktop shell at boot and by tests with a temp directory.
 */
export function openCompanyDatabase(options: OpenCompanyDatabaseOptions): CompanyDatabase {
  const fileName = options.fileName ?? 'companyos.sqlite';
  const inMemory = options.dataDir === ':memory:';
  if (!inMemory) mkdirSync(options.dataDir, { recursive: true });
  const path = inMemory ? ':memory:' : join(options.dataDir, fileName);

  const db = openDatabase({
    path,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.journalMode === undefined ? {} : { journalMode: options.journalMode }),
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    ...(options.foreignKeys === undefined ? {} : { foreignKeys: options.foreignKeys }),
  });

  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  const migrations = loadMigrations(migrationsDir);
  const migrationReport = applyMigrations({
    db,
    migrations,
    appliedAt: options.appliedAt,
    knownNames: shippedMigrationNames([migrationsDir]),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const journalRow = db.prepare('PRAGMA journal_mode').get();
  const journalMode =
    journalRow === undefined
      ? 'unknown'
      : String(Object.values(journalRow as Record<string, unknown>)[0] ?? 'unknown');

  return { db, path, migrationReport, journalMode };
}
