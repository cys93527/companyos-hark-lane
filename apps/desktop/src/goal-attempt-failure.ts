/**
 * LIVE-CONTRACT-FILL (hark-live-goal 42075419348) — the typed reason behind a failed goal.
 *
 * The run row only says `execution_failed` and the canonical attempt code is engine-
 * normalized (PROVIDER_FAILED). The provider's own typed reason (e.g. the kernel's
 * output-ceiling stop) is on the attempt's durable executor.dispatch_settled audit row.
 * This read joins the two for the goal workspace; it never invents a reason.
 */
import type { GoalAttemptFailure } from './control-plane.js';

interface SqlLike {
  prepare(sql: string): { all(...params: unknown[]): readonly unknown[] };
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,79}$/u;

export const createLatestAttemptFailureReader =
  (db: SqlLike) =>
  async (runIds: readonly string[]): Promise<GoalAttemptFailure | null> => {
    if (runIds.length === 0) return null;
    const placeholders = runIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT id, run_id, task_id, failure_code, settled_at FROM execution_attempts
          WHERE run_id IN (${placeholders}) AND state = 'FAILED'
          ORDER BY COALESCE(settled_at, created_at) DESC, rowid DESC LIMIT 1`,
      )
      .all(...runIds) as readonly { id: string; run_id: string; task_id: string; failure_code: string | null; settled_at: string | null }[];
    const attempt = rows[0];
    if (attempt === undefined) return null;
    const settled = db
      .prepare("SELECT payload FROM events WHERE aggregate_id = ? AND type = 'executor.dispatch_settled' ORDER BY rowid DESC LIMIT 1")
      .all(attempt.id) as readonly { payload: string }[];
    let detailCode: string | null = null;
    try {
      const payload = settled[0] === undefined ? null : (JSON.parse(settled[0].payload) as { reasonCode?: unknown });
      if (typeof payload?.reasonCode === 'string' && REASON_CODE.test(payload.reasonCode)) detailCode = payload.reasonCode;
    } catch {
      detailCode = null;
    }
    return {
      runId: attempt.run_id,
      taskId: attempt.task_id,
      attemptId: attempt.id,
      failureCode: attempt.failure_code,
      detailCode,
      settledAt: attempt.settled_at,
    };
  };
