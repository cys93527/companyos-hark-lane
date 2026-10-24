/**
 * Durable `EntityStore<Approval>` (Sprint 3 requirement 10).
 *
 * An approval that is lost on restart would silently reopen a human gate — the exact
 * failure mode SM-L1-03 forbids ("no auto-approval").
 */
import type {
  Approval,
  ApprovalStatus,
  EntityStore,
  Page,
  PageRequest,
  RiskLevel,
} from '@companyos/core';

import type { Database } from '../db.js';

interface ApprovalRow {
  readonly id: string;
  readonly run_id: string;
  readonly task_id: string | null;
  readonly risk_level: string;
  readonly status: string;
  readonly reason: string;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly decided_by: string | null;
  readonly decided_at: string | null;
  readonly decision_note: string | null;
}

export function createSqliteApprovalStore(db: Database): EntityStore<Approval> {
  const insert = db.prepare(
    `INSERT INTO approvals (id, run_id, task_id, risk_level, status, reason,
       requested_by, requested_at, decided_by, decided_at, decision_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       decided_by = excluded.decided_by,
       decided_at = excluded.decided_at,
       decision_note = excluded.decision_note`,
  );

  const fromRow = (row: ApprovalRow): Approval => ({
    id: row.id as Approval['id'],
    runId: row.run_id as Approval['runId'],
    taskId: (row.task_id as Approval['taskId']) ?? null,
    riskLevel: row.risk_level as RiskLevel,
    status: row.status as ApprovalStatus,
    reason: row.reason,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
  });

  return {
    async get(id: string): Promise<Approval | null> {
      const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: Approval): Promise<void> {
      insert.run(
        entity.id,
        entity.runId,
        entity.taskId,
        entity.riskLevel,
        entity.status,
        entity.reason,
        entity.requestedBy,
        entity.requestedAt,
        entity.decidedBy,
        entity.decidedAt,
        entity.decisionNote,
      );
    },
    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM approvals WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<Approval>> {
      const limit = Math.min(Math.max(page.limit ?? 50, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const direction = page.descending === true ? 'DESC' : 'ASC';
      const rows = db
        .prepare(`SELECT * FROM approvals ORDER BY requested_at ${direction}, id ASC LIMIT ? OFFSET ?`)
        .all(limit, offset) as ApprovalRow[];
      const totalRow = db.prepare('SELECT COUNT(*) AS total FROM approvals').get() as { total: number | bigint };
      return { items: rows.map(fromRow), total: Number(totalRow.total), offset, limit };
    },
  };
}
