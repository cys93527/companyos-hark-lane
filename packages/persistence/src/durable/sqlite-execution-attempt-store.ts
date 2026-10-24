/**
 * Durable ExecutionAttempt store (Sprint 21 final) — the generic execution-claim owner.
 *
 * `claim` is a PLAIN INSERT arbitrated by the PRIMARY KEY (deterministic exa_ id) and the
 * UNIQUE(task_id, attempt_number) index: a concurrent second claim for the same attempt
 * loses at the database, and the loser re-reads to distinguish replay (same immutable
 * seed) from conflict. Find-then-create is only the friendly fast path — never the final
 * authority. `settle` applies the frozen domain transitions; `interruptActiveOfRuntime`
 * is the canonical startup orphan transition under the supported V1 single-runtime
 * boundary (every ACTIVE attempt belongs to the PREVIOUS runtime instance because V1
 * supports exactly one live runtime owner per workspace/database).
 */
import {
  applyExecutionAttemptTransition,
  DomainError,
  err,
  executionAttemptSeedFingerprint,
  ok,
  type ExecutionAttempt,
  type ExecutionAttemptState,
  type Result,
} from '@companyos/core';

import type { Database } from '../db.js';

interface AttemptRow {
  readonly id: string;
  readonly company_id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly attempt_number: number | bigint;
  readonly state: string;
  readonly role_id: string;
  readonly task_kind: string;
  readonly seed_fingerprint: string;
  readonly runtime_instance_id: string | null;
  readonly created_at: string;
  readonly settled_at: string | null;
  /* LIVE-SMOKE-FIX-04B - nullable on legacy rows and non-FAILED terminals. */
  readonly failure_code: string | null;
  readonly failure_phase: string | null;
  readonly failure_summary: string | null;
  readonly failure_retryable: number | null;
}

const num = (value: number | bigint): number => Number(value);

const toDomain = (row: AttemptRow): ExecutionAttempt => ({
  seed: {
    schema: 'companyos/execution-attempt/1',
    id: row.id,
    companyId: row.company_id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptNumber: num(row.attempt_number),
    roleId: row.role_id,
    taskKind: row.task_kind,
    fingerprint: row.seed_fingerprint,
  },
  state: row.state as ExecutionAttemptState,
  runtimeInstanceId: row.runtime_instance_id,
  createdAt: row.created_at,
  settledAt: row.settled_at,
  // LIVE-SMOKE-FIX-04B: the attempt-scoped canonical failure (absent on legacy rows).
  ...(row.failure_code === null
    ? {}
    : {
        failure: {
          code: String(row.failure_code),
          phase: row.failure_phase === null ? null : String(row.failure_phase),
          summary: row.failure_summary === null ? null : String(row.failure_summary),
          retryable: row.failure_retryable === 1,
        },
      }),
});

const conflict = (attempt: ExecutionAttempt): DomainError =>
  new DomainError(
    'CONFLICT',
    `Execution attempt "${attempt.seed.id}" already exists with a different immutable seed.`,
    { details: { reason: 'EXECUTION_ATTEMPT_SEED_CONFLICT', attemptId: attempt.seed.id } },
  );

export interface ExecutionAttemptStore {
  /** Legacy §35: reconstruct the attempt row directly in the INTERRUPTED recovery state. */
  reconcileLegacyInterrupted(attempt: ExecutionAttempt): Promise<Result<{ readonly attemptId: string; readonly replayed: boolean }, DomainError>>;
  /** Guarded claim: plain INSERT, PK/UNIQUE arbitration, replay/conflict on race loss. */
  claim(attempt: ExecutionAttempt): Promise<Result<{ readonly attemptId: string; readonly replayed: boolean }, DomainError>>;
  get(attemptId: string): Promise<ExecutionAttempt | null>;
  /** The canonical attempt of one (task, attemptNumber), whatever its state. */
  byTaskAndAttempt(taskId: string, attemptNumber: number): Promise<ExecutionAttempt | null>;
  /** The CURRENT active claim of a task, if any. */
  activeOfTask(taskId: string): Promise<ExecutionAttempt | null>;
  /** Apply a frozen domain transition (settle / interrupt / reacquire). */
  transition(input: {
    readonly attemptId: string;
    readonly to: ExecutionAttemptState;
    readonly now: string;
    readonly runtimeInstanceId?: string | null;
    /**
     * LIVE-SMOKE-FIX-04B - the typed failure payload committed ATOMICALLY with a
     * terminal FAILED transition (same UPDATE, same settlement transaction: no
     * FAILED-then-backfill crash window). Ignored for non-FAILED targets; a FAILED
     * target without a payload is refused (the claimed-attempt invariant).
     */
    readonly failure?: {
      readonly code: string;
      readonly phase?: string | null;
      readonly summary?: string | null;
      readonly retryable?: boolean;
    };
  }): Promise<Result<ExecutionAttempt, DomainError>>;
  /**
   * The canonical startup orphan transition: every ACTIVE attempt of the previous
   * runtime instance becomes INTERRUPTED. Safe ONLY under the supported V1 boundary
   * (exactly one live runtime owner per workspace/database).
   */
  interruptActiveOfRuntime(runtimeInstanceId: string | null, now: string): Promise<readonly ExecutionAttempt[]>;
  listByTask(taskId: string): Promise<readonly ExecutionAttempt[]>;
}

export function createSqliteExecutionAttemptStore(db: Database): ExecutionAttemptStore {
  const insert = db.prepare(
    `INSERT INTO execution_attempts (
       id, company_id, run_id, task_id, attempt_number, state, role_id, task_kind,
       seed_fingerprint, runtime_instance_id, created_at, settled_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );

  const read = (attemptId: string): ExecutionAttempt | null => {
    const row = db
      .prepare('SELECT * FROM execution_attempts WHERE id = ?')
      .get(attemptId) as AttemptRow | undefined;
    return row === undefined ? null : toDomain(row);
  };

  return {
    async claim(attempt) {
      const expectedFingerprint = executionAttemptSeedFingerprint({
        schema: 'companyos/execution-attempt/1',
        id: attempt.seed.id,
        companyId: attempt.seed.companyId,
        runId: attempt.seed.runId,
        taskId: attempt.seed.taskId,
        attemptNumber: attempt.seed.attemptNumber,
        roleId: attempt.seed.roleId,
        taskKind: attempt.seed.taskKind,
      });
      try {
        insert.run(
          attempt.seed.id,
          attempt.seed.companyId,
          attempt.seed.runId,
          attempt.seed.taskId,
          attempt.seed.attemptNumber,
          attempt.state,
          attempt.seed.roleId,
          attempt.seed.taskKind,
          expectedFingerprint,
          attempt.runtimeInstanceId,
          attempt.createdAt,
        );
        return ok({ attemptId: attempt.seed.id, replayed: false });
      } catch (error) {
        if (!/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) throw error;
        const raced = read(attempt.seed.id);
        if (raced === null) throw error;
        if (raced.seed.fingerprint !== expectedFingerprint) return err(conflict(attempt));
        return ok({ attemptId: attempt.seed.id, replayed: true });
      }
    },

    /**
     * Sprint21 ruling §35: LEGACY reconciliation — a pre-upgrade RUNNING task's logical
     * attempt is reconstructed from canonical Task facts as INTERRUPTED
     * (recovery-required), NEVER presented as a live runtime's ACTIVE claim. No START,
     * no attempts increment, no fabricated provenance; whether the attempt's external
     * side effect occurred is honestly unknown (at-least-once).
     */
    async reconcileLegacyInterrupted(attempt) {
      const expectedFingerprint = executionAttemptSeedFingerprint({
        schema: 'companyos/execution-attempt/1',
        id: attempt.seed.id,
        companyId: attempt.seed.companyId,
        runId: attempt.seed.runId,
        taskId: attempt.seed.taskId,
        attemptNumber: attempt.seed.attemptNumber,
        roleId: attempt.seed.roleId,
        taskKind: attempt.seed.taskKind,
      });
      try {
        db.prepare(
          `INSERT INTO execution_attempts (
             id, company_id, run_id, task_id, attempt_number, state, role_id, task_kind,
             seed_fingerprint, runtime_instance_id, created_at, settled_at
           ) VALUES (?, ?, ?, ?, ?, 'INTERRUPTED', ?, ?, ?, NULL, ?, NULL)`,
        ).run(
          attempt.seed.id,
          attempt.seed.companyId,
          attempt.seed.runId,
          attempt.seed.taskId,
          attempt.seed.attemptNumber,
          attempt.seed.roleId,
          attempt.seed.taskKind,
          expectedFingerprint,
          attempt.createdAt,
        );
        return ok({ attemptId: attempt.seed.id, replayed: false });
      } catch (error) {
        if (!/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) throw error;
        const raced = read(attempt.seed.id);
        if (raced === null) throw error;
        if (raced.seed.fingerprint !== expectedFingerprint) return err(conflict(attempt));
        return ok({ attemptId: attempt.seed.id, replayed: true });
      }
    },

    async get(attemptId) {
      return read(attemptId);
    },

    async byTaskAndAttempt(taskId, attemptNumber) {
      const row = db
        .prepare('SELECT * FROM execution_attempts WHERE task_id = ? AND attempt_number = ?')
        .get(taskId, attemptNumber) as AttemptRow | undefined;
      return row === undefined ? null : toDomain(row);
    },

    async activeOfTask(taskId) {
      const row = db
        .prepare("SELECT * FROM execution_attempts WHERE task_id = ? AND state = 'ACTIVE'")
        .get(taskId) as AttemptRow | undefined;
      return row === undefined ? null : toDomain(row);
    },

    async transition({ attemptId, to, now, runtimeInstanceId, failure }) {
      const existing = read(attemptId);
      if (existing === null) {
        return err(
          new DomainError('NOT_FOUND', `Execution attempt "${attemptId}" does not exist.`, {
            details: { reason: 'EXECUTION_ATTEMPT_MISSING', attemptId },
          }),
        );
      }
      const next = applyExecutionAttemptTransition(existing, to, now);
      if (!next.ok) return next;
      const settled = to === 'COMPLETED' || to === 'FAILED';
      if (settled && to === 'FAILED' && failure === undefined) {
        return err(
          new DomainError('VALIDATION_FAILED', `Execution attempt "${attemptId}" cannot settle FAILED without its typed failure payload.`, {
            details: { reason: 'EXECUTION_ATTEMPT_FAILURE_PAYLOAD_REQUIRED', attemptId },
          }),
        );
      }
      const failurePayload =
        failure === undefined
          ? undefined
          : {
              code: failure.code,
              phase: failure.phase ?? null,
              summary: failure.summary ?? null,
              retryable: failure.retryable ?? true,
            };
      // One UPDATE: state + settled_at + the failure columns commit ATOMICALLY.
      db.prepare(
        `UPDATE execution_attempts
         SET state = ?, settled_at = COALESCE(?, settled_at),
             runtime_instance_id = COALESCE(?, runtime_instance_id),
             failure_code = ?, failure_phase = ?, failure_summary = ?, failure_retryable = ?
         WHERE id = ?`,
      ).run(
        to,
        settled ? now : null,
        runtimeInstanceId === undefined ? null : runtimeInstanceId,
        failurePayload === undefined ? null : failurePayload.code,
        failurePayload === undefined || failurePayload.phase === null ? null : failurePayload.phase,
        failurePayload === undefined || failurePayload.summary === null ? null : failurePayload.summary,
        failurePayload === undefined ? null : (failurePayload.retryable ? 1 : 0),
        attemptId,
      );
      return ok({
        ...next.value,
        runtimeInstanceId: runtimeInstanceId ?? existing.runtimeInstanceId,
        ...(failurePayload === undefined ? {} : {failure: failurePayload}),
      });
    },

    async interruptActiveOfRuntime(runtimeInstanceId, now) {
      const rows = db
        .prepare(
          runtimeInstanceId === null
            ? "SELECT * FROM execution_attempts WHERE state = 'ACTIVE'"
            : "SELECT * FROM execution_attempts WHERE state = 'ACTIVE' AND runtime_instance_id = ?",
        )
        .all(...(runtimeInstanceId === null ? [] : [runtimeInstanceId])) as AttemptRow[];
      const interrupted: ExecutionAttempt[] = [];
      for (const row of rows) {
        const attempt = toDomain(row);
        const next = applyExecutionAttemptTransition(attempt, 'INTERRUPTED', now);
        if (!next.ok) continue; // terminal rows never appear in this query
        db.prepare("UPDATE execution_attempts SET state = 'INTERRUPTED' WHERE id = ?").run(row.id);
        interrupted.push(next.value);
      }
      return interrupted;
    },

    async listByTask(taskId) {
      const rows = db
        .prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY attempt_number ASC')
        .all(taskId) as AttemptRow[];
      return rows.map(toDomain);
    },
  };
}
