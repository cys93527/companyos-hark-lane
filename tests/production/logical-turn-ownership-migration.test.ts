/**
 * POST-CODEX 6ec4d81 re-audit — migration 0005 (PERMANENT logical-turn ownership).
 *
 * ONE LOGICAL TURN = ONE DURABLE OWNER FOR ITS ENTIRE HISTORY: the GLOBAL unique index
 * over non-NULL `logical_turn_id` replaces the ACTIVE-partial index, so a delayed
 * contender can never acquire a SECOND owner for a settled identity. The migration is
 * checksum-protected, append-only, and FAILS HONESTLY on a legacy database that already
 * contains duplicate identities (the historical bug): it deletes nothing and rewrites
 * nothing — a genuinely new reasoning attempt must carry a NEW logicalTurnId.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MigrationChecksumError,
  agentMigrationsDir,
  applyMigrations,
  coreMigrationsDir,
  loadMigrations,
  openDatabase,
  openDurableDatabase,
} from '@companyos/persistence';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-agent-migration-'));
  created.push(dir);
  return dir;
};

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A full-chain durable database (the production boot path), applying ALL chains. */
const FULL_CHAINS = [
  'core',
  'engine',
  'lifecycle',
  'provider',
  'registry',
  'selection',
  'agent',
  'tools',
  'artifact',
  'pack',
  'memory',
  'session',
  'handoff',
] as const;

const insertExecution = (
  db: ReturnType<typeof openDatabase>,
  input: {
    readonly id: string;
    readonly status: string;
    readonly logicalTurnId: string | null;
  },
): void => {
  db.prepare(
    `INSERT INTO agent_executions (
       execution_id, agent_id, role_id, task_id, run_id, model_key, provider_id,
       provider_model_id, status, started_at, finished_at, trace_id, attempt,
       input_usage, output_usage, latency_ms, result_ref, error_code, error_kind,
       error_message, created_at, updated_at, outcome_committed_at, outcome_decision_id,
       decision_authority_expires_at, logical_turn_id)
     VALUES (?, 'agent-x', 'role-x', 'task-x', 'run-x', 'model-x', 'provider-x',
       'provider-model-x', ?, NULL, NULL, 'trace-x', 1,
       '{}', '{}', NULL, NULL, NULL, NULL,
       NULL, 'now', 'now', NULL, NULL,
       NULL, ?)`,
  ).run(input.id, input.status, input.logicalTurnId);
};

const indexSqlOf = (
  db: ReturnType<typeof openDatabase>,
  name: string,
): string | null => {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name) as { sql: string | null } | undefined;
  return row?.sql ?? null;
};

describe('PHASE 10 — migration 0005: permanent logical-turn ownership', () => {
  it('clean upgrade applies 0005 exactly once; reopen is idempotent; the GLOBAL index is UNIQUE over non-NULL identities', () => {
    const dir = tempDir();
    const first = openDurableDatabase({ dataDir: dir, appliedAt: 'first', chains: [...FULL_CHAINS] });
    try {
      expect(first.migrations.agent!.applied.map((record) => record.name)).toContain(
        '0005_logical_turn_permanent_ownership',
      );
      // The ACTIVE partial index is GONE; the global unique index is in place.
      expect(indexSqlOf(first.db, 'idx_agent_executions_active_logical_turn')).toBeNull();
      const global = indexSqlOf(first.db, 'idx_agent_executions_logical_turn');
      expect(global).not.toBeNull();
      expect(global).toMatch(/UNIQUE/i);
      expect(global).toMatch(/logical_turn_id IS NOT NULL/);
      // Integrity: the durable file is consistent after the index swap.
      const integrity = first.db.prepare('PRAGMA integrity_check').all() as readonly {
        integrity_check: string;
      }[];
      expect(integrity.map((row) => row.integrity_check)).toEqual(['ok']);
    } finally {
      first.close();
    }
    const second = openDurableDatabase({ dataDir: dir, appliedAt: 'second', chains: [...FULL_CHAINS] });
    try {
      expect(second.migrations.agent!.applied).toEqual([]);
      expect(second.migrations.agent!.skipped.map((record) => record.name)).toContain(
        '0005_logical_turn_permanent_ownership',
      );
    } finally {
      second.close();
    }
  });

  it('LEGACY NULL identities stay outside the index (many rows), while ONE identity can never be acquired twice — terminal rows included', () => {
    const dir = tempDir();
    const database = openDurableDatabase({ dataDir: dir, appliedAt: 'now', chains: [...FULL_CHAINS] });
    try {
      // Legacy/ordinary executions: NULL identities, unbounded.
      insertExecution(database.db, { id: 'exec-null-1', status: 'COMPLETED', logicalTurnId: null });
      insertExecution(database.db, { id: 'exec-null-2', status: 'COMPLETED', logicalTurnId: null });
      insertExecution(database.db, { id: 'exec-null-3', status: 'RUNNING', logicalTurnId: null });
      // ONE identity, ONE owner — and the ownership is PERMANENT across terminal states.
      insertExecution(database.db, { id: 'exec-owned-1', status: 'COMPLETED', logicalTurnId: 'turn-x' });
      expect(() =>
        insertExecution(database.db, { id: 'exec-owned-2', status: 'READY', logicalTurnId: 'turn-x' }),
      ).toThrow(/UNIQUE|constraint/i);
      const owners = database.db
        .prepare('SELECT COUNT(*) AS n FROM agent_executions WHERE logical_turn_id = ?')
        .get('turn-x') as { n: number };
      expect(owners.n).toBe(1);
    } finally {
      database.close();
    }
  });

  it('a 0004-era database carrying DUPLICATE identities fails HONESTLY: typed failure, nothing deleted, the previous chain intact', () => {
    const root = tempDir();
    const legacyDir = join(root, 'agent-0004');
    mkdirSync(legacyDir, { recursive: true });
    const chain = loadMigrations(agentMigrationsDir());
    // The pre-0005 chain: everything up to (and including) 0004.
    for (const migration of chain) {
      const upTo0004 = ['0001_agent_runtime', '0002_execution_outcome_commit', '0003_decision_commit_protocol', '0004_supervisor_turn_admission'];
      if (upTo0004.includes(migration.name)) {
        copyFileSync(migration.path, join(legacyDir, `${migration.name}.sql`));
      }
    }
    const db = openDatabase({ path: join(root, 'legacy.sqlite') });
    try {
      applyMigrations({ db, migrations: loadMigrations(coreMigrationsDir()), appliedAt: 'core' });
      applyMigrations({ db, migrations: loadMigrations(legacyDir), appliedAt: 'legacy' });
      // The historical bug: an ACTIVE owner and a SETTLED one shared the identity
      // (the ACTIVE-partial index allowed it — a terminal row left the index).
      insertExecution(db, { id: 'exec-old-settled', status: 'COMPLETED', logicalTurnId: 'turn-dup' });
      insertExecution(db, { id: 'exec-old-active', status: 'RUNNING', logicalTurnId: 'turn-dup' });
      const before = db
        .prepare('SELECT COUNT(*) AS n FROM agent_executions WHERE logical_turn_id = ?')
        .get('turn-dup') as { n: number };
      expect(before.n).toBe(2);
      // Bring in 0005: the unique index cannot be built over the duplicates — the
      // migration FAILS (typed), the transaction rolls the DDL back, and NOTHING is
      // deleted or rewritten.
      copyFileSync(
        chain.find((migration) => migration.name === '0005_logical_turn_permanent_ownership')!.path,
        join(legacyDir, '0005_logical_turn_permanent_ownership.sql'),
      );
      expect(() =>
        applyMigrations({ db, migrations: loadMigrations(legacyDir), appliedAt: 'upgrade' }),
      ).toThrow(/UNIQUE|constraint/i);
      const after = db
        .prepare('SELECT COUNT(*) AS n FROM agent_executions WHERE logical_turn_id = ?')
        .get('turn-dup') as { n: number };
      expect(after.n).toBe(2); // nothing deleted — the operator decides, not the migration
      const ledger = db
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '0005_logical_turn_permanent_ownership'")
        .get() as { n: number };
      expect(ledger.n).toBe(0); // the failed migration is NOT recorded as applied
      // The previous chain stayed intact: the ACTIVE partial index still exists.
      expect(indexSqlOf(db, 'idx_agent_executions_active_logical_turn')).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('checksum protection: an edited 0005 refuses the upgrade typed (HASH_MISMATCH)', () => {
    const root = tempDir();
    const dir = join(root, 'agent-tampered');
    mkdirSync(dir, { recursive: true });
    for (const migration of loadMigrations(agentMigrationsDir())) {
      copyFileSync(migration.path, join(dir, `${migration.name}.sql`));
    }
    const db = openDatabase({ path: join(root, 'tampered.sqlite') });
    try {
      applyMigrations({ db, migrations: loadMigrations(coreMigrationsDir()), appliedAt: 'core' });
      // Apply once cleanly, then tamper with the APPLIED 0005 file.
      applyMigrations({ db, migrations: loadMigrations(dir), appliedAt: 'first' });
      const file = join(dir, '0005_logical_turn_permanent_ownership.sql');
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- sneaky change\n`, 'utf8');
      try {
        applyMigrations({ db, migrations: loadMigrations(dir), appliedAt: 'second' });
        expect.unreachable('the checksum must refuse an edited migration');
      } catch (error) {
        const checksumError = error as MigrationChecksumError;
        expect(checksumError).toBeInstanceOf(MigrationChecksumError);
        expect(checksumError.code).toBe('HASH_MISMATCH');
        expect(checksumError.details['name']).toBe('0005_logical_turn_permanent_ownership');
      }
    } finally {
      db.close();
    }
  });
});
