/**
 * Durable `EntityStore<Task>` (Sprint 3 requirement 2).
 *
 * Task local state (L3) must survive a restart, otherwise a resumed run would re-run
 * work it already finished or forget an exhausted retry budget.
 *
 * T20-03A: every persisted Task carries canonical `run_id` ownership (NOT NULL, FK to
 * runs). The upsert NEVER rewrites identity/ownership columns — runId is immutable for a
 * task's life. `listByRun` pushes the run filter down to persistence so claim paths never
 * load another run's rows.
 */
import type { EntityStore, Page, PageRequest, Task, TaskState } from '@companyos/core';
import { canonicalJson, domainError, err, ok, DomainError, type Result } from '@companyos/core';

import type { Database } from '../db.js';
import { toPersistenceError } from './storage-errors.js';

interface TaskRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage_id: string;
  readonly role_id: string;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number | bigint;
  readonly max_attempts: number | bigint;
  readonly inputs_json: string;
  readonly outputs_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const num = (value: number | bigint): number => Number(value);

/**
 * The immutable CREATION SEED of a task — what a legitimate creation REPLAY must reproduce
 * (T20-03A final hardening). Deliberately two kinds of fields are NOT here:
 *
 *  - immutable STORED METADATA that a retry cannot be expected to reproduce:
 *    `createdAt` is immutable after insert (nothing rewrites it — the first insert owns it),
 *    but a replay after restart/crash/later command retry happens at a different wall-clock
 *    time, so it MUST NOT define replay equivalence. Same for `updatedAt`.
 *  - LIFECYCLE STATE: `state`, `attempts`, `outputs` progress legally after creation
 *    (`applyTaskEvent`); a replay of the creation command against a progressed task is a
 *    REPLAY, never a conflict, and never resets anything.
 *
 * `inputs` IS part of the seed: the store upsert never rewrites `inputs_json` and no
 * domain API mutates inputs — they are the immutable creation specification (corrective
 * lineage lives there). Inputs compare by CANONICAL JSON (semantic equality, property
 * order irrelevant), never by incidental serialization order.
 */
const SCALAR_SEED_FIELDS = [
  'runId',
  'stageId',
  'roleId',
  'kind',
  'maxAttempts',
] as const;

/**
 * maxAttempts audit note (Boss §12): the DOMAIN lifecycle never changes it
 * (`applyTaskEvent` touches only state/attempts/outputs/updatedAt); it is creation-time
 * configuration and therefore part of the seed. The generic EntityStore upsert retains its
 * pre-existing ability to persist a caller-supplied max_attempts on the lifecycle write
 * path — unchanged by this corrective; no domain API exercises it.
 */
const sameCreationSeed = (existing: Task, candidate: Task): boolean => {
  for (const field of SCALAR_SEED_FIELDS) {
    if (String(existing[field]) !== String(candidate[field])) return false;
  }
  return canonicalJson(existing.inputs) === canonicalJson(candidate.inputs);
};

const creationSeedConflict = (existing: Task, candidate: Task): DomainError => {
  const differing = SCALAR_SEED_FIELDS.filter(
    (field) => String(existing[field]) !== String(candidate[field]),
  );
  const inputsDiffer = canonicalJson(existing.inputs) !== canonicalJson(candidate.inputs);
  if (inputsDiffer) differing.push('inputs' as (typeof SCALAR_SEED_FIELDS)[number]);
  return domainError(
    'VALIDATION_FAILED',
    `Task "${String(candidate.id)}" already exists with a different creation seed (${differing.join(', ')}); task identity, ownership and creation inputs are immutable.`,
    {
      reason: 'TASK_IDENTITY_CONFLICT',
      taskId: String(candidate.id),
      differingFields: [...differing],
      existingRunId: String(existing.runId),
      candidateRunId: String(candidate.runId),
    },
  );
};

/** The canonical durable task store: EntityStore plus the run-scoped claim read. */
export type RunScopedTaskStore = EntityStore<Task> & {
  /** Every canonical task of ONE run, oldest first (the production claim order). */
  listByRun(runId: string): Promise<readonly Task[]>;
  /**
   * Creation-identity-guarded write (T20-03A corrective §8-§14): inserting a task whose id
   * already exists succeeds ONLY when the IMMUTABLE CREATION IDENTITY matches exactly —
   * then it is a replay. Any disagreement (runId, stageId, roleId, kind, maxAttempts,
   * createdAt) is a `TASK_IDENTITY_CONFLICT` and the stored row is never modified. The
   * primary key arbitrates concurrent same-id creations on this single connection.
   */
  putGuarded(entity: Task): Promise<
    Result<{ readonly taskId: string; readonly replayed: boolean }, DomainError>
  >;
};

export function createSqliteTaskStore(db: Database): RunScopedTaskStore {
  const insert = db.prepare(
    `INSERT INTO tasks (id, run_id, stage_id, role_id, kind, state, attempts, max_attempts,
       inputs_json, outputs_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state,
       attempts = excluded.attempts,
       max_attempts = excluded.max_attempts,
       outputs_json = excluded.outputs_json,
       updated_at = excluded.updated_at`,
  );

  const fromRow = (row: TaskRow): Task => ({
    id: row.id as Task['id'],
    runId: row.run_id as Task['runId'],
    stageId: row.stage_id as Task['stageId'],
    roleId: row.role_id as Task['roleId'],
    kind: row.kind,
    state: row.state as TaskState,
    attempts: num(row.attempts),
    maxAttempts: num(row.max_attempts),
    inputs: JSON.parse(row.inputs_json) as Readonly<Record<string, unknown>>,
    outputs: JSON.parse(row.outputs_json) as Readonly<Record<string, unknown>>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const getTask = async (id: string): Promise<Task | null> => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row === undefined ? null : fromRow(row);
  };
  const putTask = async (entity: Task): Promise<void> => {
    insert.run(
      entity.id,
      entity.runId,
      entity.stageId,
      entity.roleId,
      entity.kind,
      entity.state,
      entity.attempts,
      entity.maxAttempts,
      JSON.stringify(entity.inputs),
      JSON.stringify(entity.outputs),
      entity.createdAt,
      entity.updatedAt,
    );
  };

  return {
    async get(id: string): Promise<Task | null> {
      return getTask(id);
    },
    async put(entity: Task): Promise<void> {
      await putTask(entity);
    },
    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<Task>> {
      const limit = Math.min(Math.max(page.limit ?? 50, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const direction = page.descending === true ? 'DESC' : 'ASC';
      const rows = db
        .prepare(`SELECT * FROM tasks ORDER BY created_at ${direction}, id ASC LIMIT ? OFFSET ?`)
        .all(limit, offset) as TaskRow[];
      const totalRow = db.prepare('SELECT COUNT(*) AS total FROM tasks').get() as { total: number | bigint };
      return { items: rows.map(fromRow), total: num(totalRow.total), offset, limit };
    },
    async listByRun(runId: string): Promise<readonly Task[]> {
      const rows = db
        .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at ASC, id ASC')
        .all(runId) as TaskRow[];
      return rows.map(fromRow);
    },
    async putGuarded(
      entity: Task,
    ): Promise<Result<{ readonly taskId: string; readonly replayed: boolean }, DomainError>> {
      /*
       * 314caae re-audit (N314-T1) — the guarded creation's read → decide → create-or-replay
       * critical section runs INSIDE ONE controlled short transaction on the connection's
       * write-order fence (only the steps that must share one persistence decision; no
       * long-running work, no model calls, no external I/O inside it):
       *
       *   CASE A — the insert lands → created success (one durable unit).
       *   CASE B — a COMMITTED canonical row with the same creation identity → replay
       *            success, decided by the PERMANENT creation seed (Sprint 13A).
       *   CASE C — an UNCOMMITTED competing write can never be observed as truth: our unit
       *            holds the connection's write order, so a competing transaction is either
       *            fully committed before us (→ CASE B) or rolled back (→ CASE A on retry).
       *   CASE D — a persistence refusal/fault (CROSS_CONTEXT/STALE owner refusal, SQLITE
       *            I/O/busy faults, anything that is not a UNIQUE-identity collision) is a
       *            TYPED persistence failure — NEVER a fake replay success.
       *
       * Replay authority: identity alone is not enough — the stored row must reproduce the
       * immutable creation seed (runId/stageId/roleId/kind/maxAttempts + canonical inputs).
       */
      const unit = await db.writeFence.transaction(async () => {
        const existing = await getTask(String(entity.id));
        if (existing !== null) {
          return sameCreationSeed(existing, entity)
            ? ok({ taskId: String(entity.id), replayed: true })
            : err(creationSeedConflict(existing, entity));
        }
        try {
          await putTask(entity);
          return ok({ taskId: String(entity.id), replayed: false });
        } catch (error) {
          if (error instanceof DomainError) throw error;
          const errcode = Number((error as { errcode?: unknown }).errcode ?? 0);
          const message = error instanceof Error ? error.message : String(error);
          const uniqueIdentityLoss = errcode === 2067 || /UNIQUE constraint/i.test(message);
          if (!uniqueIdentityLoss) {
            // CASE D — a persistence refusal/fault: never a replay.
            throw toPersistenceError(error, { operation: 'tasks.putGuarded' });
          }
          // CASE B (race) — the UNIQUE loss proves a COMMITTED row exists (it was created
          // and committed by a unit that ran before ours; nothing uncommitted is visible
          // inside our unit). Re-read and arbitrate replay vs conflict by creation seed.
          const raced = await getTask(String(entity.id));
          if (raced !== null) {
            return sameCreationSeed(raced, entity)
              ? ok({ taskId: String(entity.id), replayed: true })
              : err(creationSeedConflict(raced, entity));
          }
          // CASE C residue — the row vanished again (it was never committed): NOT a replay.
          throw domainError(
            'PERSISTENCE_FAILED',
            'The task creation race could not be resolved to durable truth; the caller may retry the creation command.',
            { reason: 'TASK_CREATION_RACE_UNRESOLVED', taskId: String(entity.id) },
          );
        }
      });
      return unit.ok ? unit.value : err(unit.error);
    },
  };
}
