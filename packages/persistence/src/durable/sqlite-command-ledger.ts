/**
 * Durable command ledger (Sprint 3 requirement 4 / 11).
 *
 * Makes idempotency survive a process restart: a replayed `commandId` returns the
 * outcome recorded in the previous life of the process, with no second effect.
 * `trim(limit)` keeps the window bounded and explicit (oldest rows leave first, by
 * insertion order).
 */
import type { CommandLedgerPort, CommandLedgerRecord } from '@companyos/core';

import type { Database } from '../db.js';

interface LedgerRow {
  readonly command_id: string;
  readonly fingerprint: string;
  readonly run_id: string;
  readonly outcome_json: string;
  readonly recorded_at: string;
}

export function createSqliteCommandLedger(db: Database): CommandLedgerPort {
  const insert = db.prepare(
    `INSERT INTO command_ledger (command_id, fingerprint, run_id, outcome_json, recorded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(command_id) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       run_id = excluded.run_id,
       outcome_json = excluded.outcome_json,
       recorded_at = excluded.recorded_at`,
  );

  const count = (): number => {
    const row = db.prepare('SELECT COUNT(*) AS total FROM command_ledger').get() as {
      total: number | bigint;
    };
    return Number(row.total);
  };

  return {
    async get(commandId: string): Promise<CommandLedgerRecord | null> {
      const row = db.prepare('SELECT * FROM command_ledger WHERE command_id = ?').get(commandId) as
        | LedgerRow
        | undefined;
      if (row === undefined) return null;
      return {
        commandId: row.command_id,
        fingerprint: row.fingerprint,
        runId: row.run_id,
        outcome: JSON.parse(row.outcome_json) as Readonly<Record<string, unknown>>,
        recordedAt: row.recorded_at,
      };
    },
    async put(record: CommandLedgerRecord): Promise<void> {
      insert.run(
        record.commandId,
        record.fingerprint,
        record.runId,
        JSON.stringify(record.outcome),
        record.recordedAt,
      );
    },
    async count(): Promise<number> {
      return count();
    },
    async trim(limit: number): Promise<number> {
      const excess = count() - Math.max(limit, 0);
      if (excess <= 0) return 0;
      // `rowid` (internal insertion order) is the authority, never `recorded_at`,
      // which comes from the caller's clock and can skew (Sprint 3 review LOW-1).
      const result = db
        .prepare(
          `DELETE FROM command_ledger WHERE rowid IN (
             SELECT rowid FROM command_ledger ORDER BY rowid ASC LIMIT ?
           )`,
        )
        .run(excess);
      return Number(result.changes);
    },
  };
}
