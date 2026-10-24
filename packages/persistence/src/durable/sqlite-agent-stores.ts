/**
 * Durable stores for the Agent Execution Runtime (Sprint 8).
 *
 * The runtime must survive a restart with status, failure reason, model binding, usage and
 * trace intact - so nothing important lives only in memory.
 */
import type {
  AgentExecution,
  AgentExecutionStatus,
  EntityStore,
  ExecutionErrorKind,
  Page,
  PageRequest,
} from '@companyos/core';

import type { Database } from '../db.js';

const json = (value: unknown): string => JSON.stringify(value ?? null);

/** Artifact references are their own rows so a restart can list them without the execution. */
export interface ExecutionArtifactRecord {
  readonly id: string;
  readonly executionId: string;
  readonly artifactRef: string;
  readonly label: string;
  readonly createdAt: string;
}

interface ExecutionRow {
  readonly execution_id: string;
  readonly agent_id: string;
  readonly role_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly model_key: string;
  readonly provider_id: string;
  readonly provider_model_id: string;
  readonly status: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly trace_id: string;
  readonly attempt: number | bigint;
  readonly input_usage: string;
  readonly output_usage: string;
  readonly latency_ms: number | bigint | null;
  readonly result_ref: string | null;
  readonly error_code: string | null;
  readonly error_kind: string | null;
  readonly error_message: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  /** F5-C-R1: durable post-commit ownership marker (nullable). */
  readonly outcome_committed_at?: string | null;
  /** 9dc9943: the exact Decision that owns the committed outcome (nullable). */
  readonly outcome_decision_id?: string | null;
  /** 9dc9943: the durable decision-authority expiry (nullable, ISO-8601 UTC). */
  readonly decision_authority_expires_at?: string | null;
  /** 25b98d1: the admitted logical supervisor turn identity (nullable). */
  readonly logical_turn_id?: string | null;
}

const toExecution = (row: ExecutionRow): AgentExecution => ({
  id: row.execution_id,
  executionId: row.execution_id,
  agentId: row.agent_id,
  roleId: row.role_id,
  taskId: row.task_id,
  runId: row.run_id,
  modelKey: row.model_key,
  providerId: row.provider_id,
  providerModelId: row.provider_model_id,
  status: row.status as AgentExecutionStatus,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  traceId: row.trace_id,
  attempt: Number(row.attempt),
  inputUsage: JSON.parse(row.input_usage) as AgentExecution['inputUsage'],
  outputUsage: JSON.parse(row.output_usage) as AgentExecution['outputUsage'],
  latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
  resultRef: row.result_ref,
  artifactRefs: [],
  errorCode: row.error_code,
  errorKind: row.error_kind as ExecutionErrorKind | null,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  outcomeCommittedAt: row.outcome_committed_at ?? null,
  outcomeDecisionId: row.outcome_decision_id ?? null,
  decisionAuthorityExpiresAt: row.decision_authority_expires_at ?? null,
  logicalTurnId: row.logical_turn_id ?? null,
});

export function createSqliteAgentExecutionStore(
  db: Database,
): EntityStore<AgentExecution> & {
  /** F5-D — conditional terminal transition (see the implementation below). */
  putIfStatus(entity: AgentExecution, expectedStatus: AgentExecutionStatus): Promise<boolean>;
  /** F5-D-R1 — conditional creation/progress writes (see the implementations below). */
  createIfAbsent(entity: AgentExecution): Promise<boolean>;
  startIfPreTerminal(entity: AgentExecution): Promise<boolean>;
  /** 9dc9943 — the durable post-commit stamp (Decision identity + authority expiry). */
  commitOutcome(executionId: string, decisionId: string, at: string, nowIso: string): Promise<boolean>;
  /** 25b98d1 — the ACTIVE logical-turn claim holder (durable single-flight arbiter). */
  activeOwnerOfLogicalTurn(logicalTurnId: string): Promise<AgentExecution | null>;
} {
  /*
   * The generic upsert is the FIXTURE-GRADE `put` fallback only: its INSERT carries the
   * commit/authority columns as NULL, and its DO UPDATE never touches them — an
   * accidental generic put can never clobber a committed marker nor an authority bound.
   */
  const upsert = db.prepare(
    `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
       provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
       input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(execution_id) DO UPDATE SET
       status = excluded.status,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at,
       input_usage = excluded.input_usage,
       output_usage = excluded.output_usage,
       latency_ms = excluded.latency_ms,
       result_ref = excluded.result_ref,
       error_code = excluded.error_code,
       error_kind = excluded.error_kind,
       error_message = excluded.error_message,
       updated_at = excluded.updated_at`,
  );

  const artifactsFor = (executionId: string): readonly string[] =>
    (
      db
        .prepare('SELECT artifact_ref FROM agent_execution_artifacts WHERE execution_id = ? ORDER BY artifact_ref ASC')
        .all(executionId) as { artifact_ref: string }[]
    ).map((row) => row.artifact_ref);

  /*
   * F5-D — the canonical CONDITIONAL lifecycle transition (compare-and-set): the UPDATE
   * only lands while the durable row still carries `expectedStatus`. One SQL statement
   * is the arbiter, so exactly one writer ever wins a RUNNING → terminal transition — a
   * stale in-memory object can never overwrite a newer durable terminal state, and a
   * lost racer can never emit a second terminal event.
   */
  /*
   * 9dc9943 — THE STORAGE-LEVEL TERMINAL ARBITRATION PREDICATES. The in-memory
   * pre-read is NOT the authority: the CAS itself must encode the rule. A SUCCESS
   * settlement (COMPLETED) may converge a committed row (that is the committed
   * outcome's canonical path); every NON-SUCCESS terminal (CANCELLED / FAILED /
   * INTERRUPTED — timeout and cancellation included) may win ONLY while the row has
   * NOT already outcome-committed. `read marker, then update by status only` can
   * never produce Decision + CANCELLED.
   */
  const successTransition = db.prepare(
    `UPDATE agent_executions SET
       status = ?, started_at = ?, finished_at = ?,
       input_usage = ?, output_usage = ?, latency_ms = ?, result_ref = ?,
       error_code = ?, error_kind = ?, error_message = ?, updated_at = ?
     WHERE execution_id = ? AND status = ?`,
  );
  const nonSuccessTransition = db.prepare(
    `UPDATE agent_executions SET
       status = ?, started_at = ?, finished_at = ?,
       input_usage = ?, output_usage = ?, latency_ms = ?, result_ref = ?,
       error_code = ?, error_kind = ?, error_message = ?, updated_at = ?
     WHERE execution_id = ? AND status = ? AND outcome_committed_at IS NULL`,
  );

  /*
   * F5-D-R1 — the canonical CONDITIONAL creation/progress write. One statement decides
   * from DURABLE truth (never an earlier in-memory read):
   *   - row ABSENT → the INSERT lands (legal initial creation);
   *   - row exists with its CURRENT status in the legal pre-terminal set
   *     ('CREATED','READY','RUNNING') → the lifecycle/metadata write lands (a
   *     RUNNING→RUNNING progress write re-checks the status, so it can never
   *     overwrite newer lifecycle truth);
   *   - row exists in any OTHER (terminal) state → the statement is a NO-OP and the
   *     caller learns the durable truth won (FALSE) — terminal → RUNNING is
   *     IMPOSSIBLE at the storage level.
   */
  const conditionalStart = db.prepare(
    `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
       provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
       input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
       created_at, updated_at, outcome_committed_at, outcome_decision_id, decision_authority_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(execution_id) DO UPDATE SET
       status = excluded.status,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at,
       input_usage = excluded.input_usage,
       output_usage = excluded.output_usage,
       latency_ms = excluded.latency_ms,
       result_ref = excluded.result_ref,
       error_code = excluded.error_code,
       error_kind = excluded.error_kind,
       error_message = excluded.error_message,
       updated_at = excluded.updated_at,
       -- 25b98d1/N25-A1: the authority deadline is IMMUTABLE at the storage level — once
       -- non-NULL it is never cleared, extended nor replaced by a stale writer.
       decision_authority_expires_at = COALESCE(agent_executions.decision_authority_expires_at, excluded.decision_authority_expires_at)
     WHERE agent_executions.status IN ('CREATED', 'READY', 'RUNNING' )`,
  );

  /*
   * F5-C-R1 — the durable POST-COMMIT stamp: it lands ONLY while the owning row is
   * still RUNNING, inside the SAME transaction as the Decision insert. Once it lands,
   * the row's outcome is authoritative for every later settlement writer; when it is
   * refused (row terminal/lost), the uncommitted Decision has lost its authority.
   */
  /*
   * F5-D-R1 — CREATION-ONLY insert: absent → the row is created; an existing row is
   * UNTOUCHED (DO NOTHING). Generic upsert semantics are never used for lifecycle.
   * 25b98d1 — `logical_turn_id` carries the ACTIVE claim: the partial unique index over
   * non-terminal rows makes this the atomic supervisor single-flight admission (one SQL
   * statement decides the winner; a collision raises and is surfaced as `false`).
   */
  const createIfAbsentStatement = db.prepare(
    `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
       provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
       input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
       created_at, updated_at, outcome_committed_at, outcome_decision_id, decision_authority_expires_at, logical_turn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(execution_id) DO NOTHING`,
  );

  /*
   * 9dc9943 — the FINAL Decision-commit predicate (ONE atomic statement):
   *   status = RUNNING            → authority is still held by a live turn;
   *   outcome_committed_at NULL   → the outcome is not already committed;
   *   authority expiry valid      → the durable deadline has not passed (a deadline
   *                                 that expired while settlement storage was
   *                                 unavailable still revokes the late sink — even
   *                                 though the row may temporarily remain RUNNING).
   * Legacy/absent expiry (NULL) keeps the historical permissive gate: generic
   * non-supervisor executions never carry this predicate at all.
   */
  const commitOutcomeStatement = db.prepare(
    `UPDATE agent_executions SET outcome_committed_at = ?, outcome_decision_id = ?, updated_at = ?
     WHERE execution_id = ? AND status = 'RUNNING' AND outcome_committed_at IS NULL
       AND (decision_authority_expires_at IS NULL OR ? < decision_authority_expires_at)`
  );

  return {
    async get(id: string): Promise<AgentExecution | null> {
      const row = db.prepare('SELECT * FROM agent_executions WHERE execution_id = ?').get(id) as
        | ExecutionRow
        | undefined;
      return row === undefined ? null : { ...toExecution(row), artifactRefs: artifactsFor(id) };
    },
    /**
     * F5-D — conditional terminal transition. Returns TRUE when this writer WON the
     * transition; FALSE when the durable row no longer carries `expectedStatus`
     * (ALREADY_TERMINAL / LOST_RACE — the caller must not emit a terminal event).
     */
    async putIfStatus(entity: AgentExecution, expectedStatus: AgentExecutionStatus): Promise<boolean> {
      const statement = entity.status === 'COMPLETED' ? successTransition : nonSuccessTransition;
      const result = statement.run(
        entity.status,
        entity.startedAt,
        entity.finishedAt,
        json(entity.inputUsage),
        json(entity.outputUsage),
        entity.latencyMs,
        entity.resultRef,
        entity.errorCode,
        entity.errorKind,
        entity.errorMessage,
        entity.updatedAt,
        entity.executionId,
        expectedStatus,
      );
      return Number(result.changes) > 0;
    },
    /**
     * F5-D-R1 — conditional creation/progress write. TRUE when THIS writer won
     * (created the row, or updated it while its CURRENT durable status was in the
     * legal pre-terminal set); FALSE when the durable lifecycle truth won instead
     * (the caller must report it and must not proceed as if it owned the row).
     */
    async startIfPreTerminal(entity: AgentExecution): Promise<boolean> {
      const result = conditionalStart.run(
        entity.executionId,
        entity.agentId,
        entity.roleId,
        entity.taskId,
        entity.runId,
        entity.modelKey,
        entity.providerId,
        entity.providerModelId,
        entity.status,
        entity.startedAt,
        entity.finishedAt,
        entity.traceId,
        entity.attempt,
        json(entity.inputUsage),
        json(entity.outputUsage),
        entity.latencyMs,
        entity.resultRef,
        entity.errorCode,
        entity.errorKind,
        entity.errorMessage,
        entity.createdAt,
        entity.updatedAt,
        entity.outcomeCommittedAt ?? null,
        entity.outcomeDecisionId ?? null,
        entity.decisionAuthorityExpiresAt ?? null,
      );
      return Number(result.changes) > 0;
    },
    /**
     * F5-D-R1 — CREATION-ONLY write: TRUE when the row was ABSENT and is now created;
     * FALSE when a row already exists (this writer must then inspect durable truth).
     * 25b98d1 — a `logical_turn_id` collision with an ACTIVE owner (the partial unique
     * index) raises; it is surfaced as `false` — the durable single-flight arbiter.
     */
    async createIfAbsent(entity: AgentExecution): Promise<boolean> {
      try {
        const result = createIfAbsentStatement.run(
          entity.executionId,
          entity.agentId,
          entity.roleId,
          entity.taskId,
          entity.runId,
          entity.modelKey,
          entity.providerId,
          entity.providerModelId,
          entity.status,
          entity.startedAt,
          entity.finishedAt,
          entity.traceId,
          entity.attempt,
          json(entity.inputUsage),
          json(entity.outputUsage),
          entity.latencyMs,
          entity.resultRef,
          entity.errorCode,
          entity.errorKind,
          entity.errorMessage,
          entity.createdAt,
          entity.updatedAt,
          entity.outcomeCommittedAt ?? null,
          entity.outcomeDecisionId ?? null,
          entity.decisionAuthorityExpiresAt ?? null,
          entity.logicalTurnId ?? null,
        );
        return Number(result.changes) > 0;
      } catch (error) {
        // A UNIQUE/constraint collision IS the durable ownership arbitration (a false);
        // any other storage failure is a real I/O error and stays a throw so the claim
        // transaction (and its audit) rolls back together.
        if (/UNIQUE|constraint/i.test(String((error as { message?: unknown } | null)?.message ?? ''))) {
          return false;
        }
        throw error;
      }
    },
    /**
     * 6ec4d81 re-audit — the HISTORICAL owner of a logical supervisor turn: the global
     * unique index guarantees exactly one execution ever acquires an identity, and this
     * reader finds it in ANY status (the ownership survives terminal settlement).
     */
    async activeOwnerOfLogicalTurn(logicalTurnId: string): Promise<AgentExecution | null> {
      const row = db
        .prepare('SELECT * FROM agent_executions WHERE logical_turn_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(logicalTurnId) as ExecutionRow | undefined;
      return row === undefined ? null : { ...toExecution(row), artifactRefs: artifactsFor(row.execution_id) };
    },
    /**
     * F5-C-R1 — stamp the durable post-commit marker while the row is RUNNING.
     * TRUE = this transaction holds the commit authority for the row; FALSE = the
     * row is no longer RUNNING and the caller's uncommitted decision has LOST it.
     */
    async commitOutcome(
      executionId: string,
      decisionId: string,
      at: string,
      nowIso: string,
    ): Promise<boolean> {
      const result = commitOutcomeStatement.run(at, decisionId, at, executionId, nowIso);
      return Number(result.changes) > 0;
    },
    async put(entity: AgentExecution): Promise<void> {
      upsert.run(
        entity.executionId,
        entity.agentId,
        entity.roleId,
        entity.taskId,
        entity.runId,
        entity.modelKey,
        entity.providerId,
        entity.providerModelId,
        entity.status,
        entity.startedAt,
        entity.finishedAt,
        entity.traceId,
        entity.attempt,
        json(entity.inputUsage),
        json(entity.outputUsage),
        entity.latencyMs,
        entity.resultRef,
        entity.errorCode,
        entity.errorKind,
        entity.errorMessage,
        entity.createdAt,
        entity.updatedAt,
      );
    },
    async delete(id: string): Promise<boolean> {
      db.prepare('DELETE FROM agent_execution_artifacts WHERE execution_id = ?').run(id);
      const result = db.prepare('DELETE FROM agent_executions WHERE execution_id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<AgentExecution>> {
      const limit = Math.min(Math.max(page.limit ?? 100, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const direction = page.descending === true ? 'DESC' : 'ASC';
      const rows = db
        .prepare(`SELECT * FROM agent_executions ORDER BY created_at ${direction} LIMIT ? OFFSET ?`)
        .all(limit, offset) as ExecutionRow[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM agent_executions').get() as {
        total: number | bigint;
      };
      return {
        items: rows.map((row) => ({ ...toExecution(row), artifactRefs: artifactsFor(row.execution_id) })),
        total: Number(total.total),
        offset,
        limit,
      };
    },
  };
}

/** Artifact references: a small EntityStore so they survive a restart like everything else. */
export function createSqliteExecutionArtifactStore(db: Database): EntityStore<ExecutionArtifactRecord> {
  const upsert = db.prepare(
    `INSERT INTO agent_execution_artifacts (id, execution_id, artifact_ref, label, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label`,
  );
  const fromRow = (row: {
    readonly id: string;
    readonly execution_id: string;
    readonly artifact_ref: string;
    readonly label: string;
    readonly created_at: string;
  }): ExecutionArtifactRecord => ({
    id: row.id,
    executionId: row.execution_id,
    artifactRef: row.artifact_ref,
    label: row.label,
    createdAt: row.created_at,
  });

  return {
    async get(id: string): Promise<ExecutionArtifactRecord | null> {
      const row = db.prepare('SELECT * FROM agent_execution_artifacts WHERE id = ?').get(id) as
        | {
            id: string;
            execution_id: string;
            artifact_ref: string;
            label: string;
            created_at: string;
          }
        | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: ExecutionArtifactRecord): Promise<void> {
      upsert.run(entity.id, entity.executionId, entity.artifactRef, entity.label, entity.createdAt);
    },
    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM agent_execution_artifacts WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<ExecutionArtifactRecord>> {
      const limit = Math.min(Math.max(page.limit ?? 200, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM agent_execution_artifacts ORDER BY execution_id ASC, artifact_ref ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as {
        id: string;
        execution_id: string;
        artifact_ref: string;
        label: string;
        created_at: string;
      }[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM agent_execution_artifacts').get() as {
        total: number | bigint;
      };
      return { items: rows.map(fromRow), total: Number(total.total), offset, limit };
    },
  };
}
