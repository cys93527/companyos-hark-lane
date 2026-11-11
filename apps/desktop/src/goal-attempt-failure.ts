/**
 * LIVE-CONTRACT-FILL (hark-live-goal 42075419348) — the typed reason behind a failed goal.
 *
 * The run row only says `execution_failed` and the canonical attempt code is engine-
 * normalized (PROVIDER_FAILED). The provider's own typed reason (e.g. the kernel's
 * output-ceiling stop) is on the attempt's durable executor.dispatch_settled audit row.
 * This read joins the two for the goal workspace; it never invents a reason.
 */
import type { GoalAttemptFailure } from './control-plane.js';
import { PROVIDER_OUTPUT_TRUNCATED_MESSAGE, PROVIDER_REASONING_EXHAUSTED_MESSAGE } from './models/openai-compatible-provider.js';

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
    if (attempt === undefined) return modelCallFailureOf(db, runIds, placeholders);
    const settled = db
      .prepare("SELECT payload FROM events WHERE aggregate_id = ? AND type = 'executor.dispatch_settled' ORDER BY rowid DESC LIMIT 1")
      .all(attempt.id) as readonly { payload: string }[];
    let detailCode: string | null = null;
    let detailMessage: string | null = null;
    try {
      const payload = settled[0] === undefined ? null : (JSON.parse(settled[0].payload) as { reasonCode?: unknown; kernelError?: unknown });
      if (typeof payload?.reasonCode === 'string' && REASON_CODE.test(payload.reasonCode)) detailCode = payload.reasonCode;
      detailMessage = kernelErrorMessageOf(payload?.kernelError);
    } catch {
      detailCode = null;
    }
    // UI-AUDIT-2: an attempt refused before dispatch carries no settled row; the model call's
    // typed refusal (budget / policy) is on the failed agent execution of the same Goal.
    if (detailCode === null) detailCode = modelCallFailureOf(db, runIds, placeholders)?.detailCode ?? null;
    return {
      runId: attempt.run_id,
      taskId: attempt.task_id,
      attemptId: attempt.id,
      failureCode: attempt.failure_code,
      detailCode,
      detailMessage,
      settledAt: attempt.settled_at,
    };
  };

/**
 * LIVE-CONTRACT-FILL run 6 — the kernel's own error line ("CODE: message", bounded, one
 * line) from the settled row; the slug alone ("error") told the boss nothing.
 */
const kernelErrorMessageOf = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null) return null;
  const error = value as { code?: unknown; message?: unknown };
  const code = typeof error.code === 'string' && error.code.trim() !== '' ? error.code.trim() : null;
  const message = typeof error.message === 'string' && error.message.trim() !== '' ? error.message.replace(/\s+/gu, ' ').trim() : null;
  if (code === null && message === null) return null;
  const line = code === null ? String(message) : message === null ? code : `${code}: ${message}`;
  return line.length <= 300 ? line : `${line.slice(0, 299)}…`;
};

/**
 * LIVE-CONTRACT-FILL (hark-live-goal 42085454360): a goal can fail before any execution
 * attempt exists — the planner's own model call failed. That failure lives on the agent
 * execution row; its CompanyOS-owned message names the typed output-ceiling causes.
 */
const modelCallFailureOf = (db: SqlLike, runIds: readonly string[], placeholders: string): GoalAttemptFailure | null => {
  const rows = db
    .prepare(
      `SELECT execution_id, run_id, task_id, error_kind, error_message, finished_at FROM agent_executions
        WHERE run_id IN (${placeholders}) AND status = 'FAILED'
        ORDER BY rowid DESC LIMIT 1`,
    )
    .all(...runIds) as readonly { execution_id: string; run_id: string; task_id: string | null; error_kind: string | null; error_message: string | null; finished_at: string | null }[];
  const execution = rows[0];
  if (execution === undefined) return null;
  const message = execution.error_message ?? '';
  const detailCode = message.startsWith(PROVIDER_REASONING_EXHAUSTED_MESSAGE)
    ? 'PROVIDER_REASONING_EXHAUSTED'
    : message.startsWith(PROVIDER_OUTPUT_TRUNCATED_MESSAGE)
      ? 'PROVIDER_OUTPUT_TRUNCATED'
      : terminalAuditReasonOf(db, execution.execution_id);
  return {
    runId: execution.run_id,
    taskId: execution.task_id ?? '',
    attemptId: execution.execution_id,
    failureCode: execution.error_kind !== null && REASON_CODE.test(execution.error_kind) ? execution.error_kind : null,
    detailCode,
    detailMessage: null,
    settledAt: execution.finished_at,
  };
};

/**
 * UI-AUDIT-2 (user report 2026-11-11: "目标失败 · 未归类的失败原因（POLICY_REFUSED）") — the
 * typed reason the runtime recorded on the execution's durable terminal audit
 * (agent.execution_failed {reason}: GOAL_ADMISSION_BOUND_UNPROVEN = no approved budget for
 * the model, MODEL_BLOCKED_BY_POLICY, …). Codes only; a malformed payload reads as none.
 */
const terminalAuditReasonOf = (db: SqlLike, executionId: string): string | null => {
  const rows = db
    .prepare("SELECT payload FROM events WHERE aggregate_id = ? AND type = 'agent.execution_failed' ORDER BY rowid DESC LIMIT 1")
    .all(executionId) as readonly { payload: string }[];
  try {
    const payload = rows[0] === undefined ? null : (JSON.parse(rows[0].payload) as { reason?: unknown });
    return typeof payload?.reason === 'string' && REASON_CODE.test(payload.reason) ? payload.reason : null;
  } catch {
    return null;
  }
};
