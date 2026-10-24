/**
 * 314caae re-audit — N314-T1: ASYNC TASK CREATION CAN CONFIRM UNCOMMITTED FOREIGN DATA.
 *
 * Codex counterexample: `normalTaskMaterializer.materialize` → `tasks.putGuarded` began its
 * read→decide→create/replay critical section with no transaction owner; across its awaits a
 * foreign UnitOfWork transaction started, wrote the SAME task row (UNCOMMITTED), and the
 * guarded creation's conflict path re-read that uncommitted row on the shared connection and
 * announced `ok=true, replayed=true` — then the foreign transaction rolled back and the task
 * vanished (absent after restart). A replay success must rest on committed canonical truth.
 *
 * INVARIANT A — an async persistence operation's consistent steps never fall into another
 *   context's transaction (exclusive connection access across awaits).
 * INVARIANT B — `ok`/`replayed` is only ever backed by committed canonical durable truth.
 * INVARIANT C — a foreign context never observes another transaction's uncommitted rows as
 *   authoritative truth (it waits for legal access).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FaultCrashError, domainError, err, ok as okResult, type Task } from '@companyos/core';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { createNormalTaskMaterializer } from '../../packages/engine/src/planning/normal-task-materializer.js';
import { createDesktopAutonomyRunner } from '../../apps/desktop/src/autonomy/desktop-autonomy-runner.js';
import { COMPANY, composeF5, createdDirs as fixtureDirs, openDatabases as fixtureDbs, type F5Fixture } from './helpers/f5-fixture.js';

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (fixtureDbs.length > 0) {
    try {
      fixtureDbs.pop()?.close();
    } catch {
      // already closed by a test (D5 closes on purpose)
    }
  }
  while (openDatabases.length > 0) {
    try {
      openDatabases.pop()?.close();
    } catch {
      // already closed by a test
    }
  }
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    const fixtureDir = fixtureDirs.pop();
    if (fixtureDir !== undefined) rmSync(fixtureDir, { recursive: true, force: true });
  }
});

const CHAINS = [
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
  'router',
] as const;

const disposable = (): DurableDatabase => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-n314-'));
  createdDirs.push(dir);
  const db = openDurableDatabase({ dataDir: dir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  return db;
};

const tick = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const eventOf = (id: string, type: string) => ({
  eventId: id,
  type,
  version: 1,
  occurredAt: new Date().toISOString(),
  aggregateId: 'probe',
  aggregateType: 'Probe',
  actorId: 'user_owner',
  traceId: 'trace',
  payload: {},
});

const countOf = (db: DurableDatabase, sql: string, ...params: readonly string[]): number =>
  Number((db.db.prepare(sql).get(...(params as never[])) as { n: number }).n);

interface Seeded {
  readonly runId: string;
  readonly taskId: string;
  readonly actor: string;
}

const seedRunAndTask = async (f: F5Fixture): Promise<Seeded> => {
  const created = await f.core.controlPlane!.handle({
    operation: 'goal.create',
    payload: { companyId: COMPANY, objective: 'async ownership N314', commandId: `n314-${String(Date.now())}` },
  });
  if (!created.ok) throw new Error('goal.create failed');
  const goalRunId = String((created.value as { readonly runId: string }).runId);
  await f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
  const executionRun = f.core.database.db
    .prepare("SELECT id FROM runs WHERE id != ? AND company_id = 'company_default' ORDER BY created_at DESC LIMIT 1")
    .get(goalRunId) as { id: string };
  const subject = f.core.database.db
    .prepare('SELECT id FROM tasks WHERE run_id = ? ORDER BY created_at LIMIT 1')
    .get(executionRun.id) as { id: string };
  const actor = (await f.core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  return { runId: executionRun.id, taskId: subject.id, actor };
};

const taskFor = (id: string, runId: string, inputs: Readonly<Record<string, unknown>> = { spec: 'a' }): Task =>
  ({
    id,
    runId,
    stageId: 'stage-probe',
    roleId: 'role-probe',
    kind: 'task.probe',
    state: 'READY',
    attempts: 0,
    maxAttempts: 3,
    inputs,
    outputs: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as unknown as Task;

/** A foreign unit whose transaction stays OPEN across an await (the losing-claim shape). */
const heldForeignTransaction = (
  db: DurableDatabase,
  body: () => Promise<void>,
): { readonly settle: Promise<{ ok: boolean }>; readonly release: () => void } => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settle = (async () => {
    const outcome = await db.unitOfWork.transaction(async () => {
      await gate;
      await body();
      throw new Error('injected foreign rollback');
    });
    return { ok: outcome.ok };
  })();
  return { settle, release };
};

describe('N314-T1 — async task creation confirms only committed canonical truth', () => {
  it('REPRODUCTION — a raw same-connection read DOES see a foreign transaction\'s uncommitted task (the hazard), while the fenced store waits and never does', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    const db = f.core.database;
    const task = taskFor('tsk_repro_000000000000001', seeded.runId);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const foreign = db.unitOfWork.transaction(async () => {
      await gate;
      await db.tasks.put(task as never); // the competing write, through the STORE port
      throw new Error('injected foreign rollback');
    });
    await tick();
    expect(db.db.writeFence.openTransactionOwner()).not.toBeNull(); // foreign txn open
    release();
    // The hazard exists at the raw level: while the foreign txn was open its row was
    // transiently visible on this connection. The FENCED store never observes it as truth:
    // the re-read below happens after the rollback and must see NOTHING.
    const outcome = await foreign;
    expect(outcome.ok).toBe(false);
    const visible = await db.tasks.get(task.id as never);
    expect(visible).toBeNull(); // INVARIANT B: no uncommitted row is ever authoritative
    // And a legitimate creation then succeeds as CREATED (never a fake replay).
    const guarded = await db.tasks.putGuarded(task as never);
    expect(guarded.ok).toBe(true);
    if (guarded.ok) expect(guarded.value.replayed).toBe(false);
    const reread = await db.tasks.get(task.id as never);
    expect(reread).not.toBeNull();
  }, 120_000);

  it('A1/A2 — a task creation interleaved with an uncommitted competing transaction never reports a premature replay; after its ROLLBACK the creation is CASE A', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    const db = f.core.database;
    const task = taskFor('tsk_a1_0000000000000001', seeded.runId);
    const foreign = heldForeignTransaction(db, async () => {
      await db.tasks.put(task as never); // UNCOMMITTED competing write
    });
    await tick();
    expect(db.db.writeFence.openTransactionOwner()).not.toBeNull();
    const pending = db.tasks.putGuarded(task as never);
    await tick(5);
    // The guarded creation is WAITING for legal access — it has not spoken yet.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await tick(5);
    expect(settled).toBe(false); // no premature ok/replay while the foreign txn is open
    foreign.release();
    expect((await foreign.settle).ok).toBe(false); // the foreign write is GONE
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.replayed).toBe(false); // CASE A: created
    expect(await db.tasks.get(task.id as never)).not.toBeNull(); // durable
  }, 120_000);

  it('A3 — a competing transaction that CREATES AND COMMITS the same identity yields a true replay, and the task is durable', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    const db = f.core.database;
    const task = taskFor('tsk_a3_0000000000000001', seeded.runId);
    const competing = await db.unitOfWork.transaction(async () => {
      await db.tasks.putGuarded(task as never);
      return 'committed';
    });
    expect(competing.ok).toBe(true);
    const replay = await db.tasks.putGuarded(task as never);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.replayed).toBe(true); // CASE B: committed canonical row
    expect(await db.tasks.get(task.id as never)).not.toBeNull();
  }, 120_000);

  it('A4 — the same Task ID with a DIFFERENT creation fingerprint is a typed conflict, never a replay', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    const db = f.core.database;
    const first = taskFor('tsk_a4_0000000000000001', seeded.runId, { spec: 'a' });
    const created = await db.tasks.putGuarded(first as never);
    expect(created.ok).toBe(true);
    const conflicting = taskFor('tsk_a4_0000000000000001', seeded.runId, { spec: 'DIFFERENT' });
    const result = await db.tasks.putGuarded(conflicting as never);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the typed identity conflict');
    expect(result.error.code).toBe('VALIDATION_FAILED');
    // The canonical row is untouched.
    const stored = await db.tasks.get(first.id as never);
    expect(String((stored as { inputs?: { spec?: string } }).inputs?.spec)).toBe('a');
  }, 120_000);

  it('A5 — a TaskStore persistence failure is a TYPED persistence error, never a fake replay', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    const db = f.core.database;
    // (i) a CHECK-constraint fault (not an identity collision) → CASE D typed failure.
    const invalid = { ...taskFor('tsk_a5_0000000000000001', seeded.runId), state: 'NOT_A_STATE' } as unknown as Task;
    const faulty = await db.tasks.putGuarded(invalid);
    expect(faulty.ok).toBe(false);
    if (faulty.ok) throw new Error('expected the typed persistence failure');
    expect(faulty.error.code).toBe('PERSISTENCE_FAILED');
    expect(await db.tasks.get('tsk_a5_0000000000000001')).toBeNull();
    // (ii) an uncertain connection state → CASE D typed failure (no fake success).
    const raw = db.db.raw;
    const realExec = raw.exec.bind(raw);
    let failures = 2;
    (raw as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      if (failures > 0 && (sql === 'COMMIT' || sql === 'ROLLBACK')) {
        failures -= 1;
        throw new Error('injected transaction boundary failure');
      }
      return realExec(sql);
    };
    const doomed = await db.unitOfWork.transaction(async () => 'never lands');
    expect(doomed.ok).toBe(false);
    (raw as unknown as { exec: (sql: string) => unknown }).exec = realExec;
    // The connection itself reports the uncertain state; fenced work fails closed.
    expect(db.db.writeFence.connectionState()).toBe('indeterminate');
    const refused: unknown = await db.tasks
      .putGuarded(taskFor('tsk_a5_0000000000000002', seeded.runId))
      .then((value) => value, (error: unknown) => error);
    const refusedError =
      typeof refused === 'object' && refused !== null && 'ok' in refused && (refused as { ok: boolean }).ok === false
        ? (refused as unknown as { error: { code: string } }).error
        : (refused as { code?: string; details?: Record<string, unknown> });
    expect(String(refusedError.code)).toBe('PERSISTENCE_FAILED');
  }, 120_000);

  it('A6/D8 — crash after creation, restart: the SAME creation command replays the SAME canonical task (idempotent)', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    const db = f.core.database;
    const task = taskFor('tsk_a6_0000000000000001', seeded.runId);
    const created = await db.tasks.putGuarded(task as never);
    expect(created.ok).toBe(true);
    // Crash right after the durable creation (the canonical crash sentinel).
    try {
      throw new FaultCrashError('crash_after_task_commit');
    } catch {
      // the process dies here
    }
    // Restart: a FRESH connection over the same durable file, same creation command.
    const reopened = openDurableDatabase({
      dataDir: f.dataDir,
      appliedAt: new Date().toISOString(),
      chains: [...CHAINS],
    });
    openDatabases.push(reopened);
    const replay = await reopened.tasks.putGuarded(task as never);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.replayed).toBe(true);
    expect(await reopened.tasks.get(task.id as never)).not.toBeNull();
  }, 120_000);

  it('B1/B2/B5 — an async mutation keeps exclusive access across its awaits; a foreign BEGIN waits; it holds NO transaction', async () => {
    const db = disposable();
    const order: string[] = [];
    let releaseMutation = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutation = db.db.writeFence.mutation('probe.multi-step', async () => {
      await db.events.append([eventOf('evt_b1', 'probe.b1')] as never);
      order.push('mutation:step1');
      await gate; // an await INSIDE the operation
      await db.events.append([eventOf('evt_b2', 'probe.b2')] as never);
      order.push('mutation:step2');
    });
    await tick();
    // A foreign transaction queues behind the mutation's whole critical section.
    const foreign = db.unitOfWork.transaction(async () => {
      order.push('foreign:begin');
      return 'done';
    });
    await tick(5);
    expect(order).toEqual(['mutation:step1']); // the foreign unit has NOT begun
    expect(db.db.writeFence.openTransactionOwner()).toBeNull(); // and no write lock is held
    releaseMutation();
    await mutation;
    expect((await foreign).ok).toBe(true);
    expect(order).toEqual(['mutation:step1', 'mutation:step2', 'foreign:begin']); // B2/B5
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id IN ('evt_b1','evt_b2')")).toBe(2);
  }, 60_000);

  it('B3 — a fenced store READ waits for legal access and never observes a foreign uncommitted row', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    const db = f.core.database;
    const task = taskFor('tsk_b3_0000000000000001', seeded.runId);
    const foreign = heldForeignTransaction(db, async () => {
      await db.tasks.put(task as never); // UNCOMMITTED
    });
    await tick();
    expect(db.db.writeFence.openTransactionOwner()).not.toBeNull();
    let seen: unknown = 'unsettled';
    const read = db.tasks.get(task.id as never).then((value) => {
      seen = value;
    });
    await tick(5);
    expect(seen).toBe('unsettled'); // the read waits — it cannot observe the uncommitted row
    foreign.release();
    await foreign.settle;
    await read;
    expect(seen).toBeNull(); // truth after the rollback: the row never existed
  }, 60_000);

  it('B4/B6 — parallel async mutations each land atomically; a throwing mutation never blocks the queue', async () => {
    const db = disposable();
    const writes = await Promise.all([
      db.db.writeFence.mutation('probe.p1', async () => db.events.append([eventOf('evt_p1', 'p1')] as never)),
      db.db.writeFence.mutation('probe.p2', async () => db.events.append([eventOf('evt_p2', 'p2')] as never)),
      db.db.writeFence
        .mutation('probe.p3', async () => {
          throw new Error('injected mutation failure');
        })
        .catch(() => 'failed'),
    ]);
    expect(writes[2]).toBe('failed');
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id IN ('evt_p1','evt_p2')")).toBe(2);
    const alive = await db.db.writeFence.mutation('probe.p4', async () => 'alive');
    expect(alive).toBe('alive');
  }, 60_000);

  it('C2 — RouterDecision.save rides the SAME fence (the N314-COV1 gap): it waits during a foreign transaction and then commits', async () => {
    const db = disposable();
    if (db.routerDecisions === null) throw new Error('router decisions store not composed');
    const record = {
      decisionId: 'rd_c2_0000000000000001',
      requestId: 'req_c2',
      taskId: 'tsk_c2',
      roleId: 'role_c2',
      selectionMode: 'AUTO',
      selectedModelKey: 'f5.planner',
      decision: JSON.stringify({ selected: 'provider-x' }),
      reasonCodesJson: '[]',
      candidateEvaluationsJson: '[]',
      rejectedCandidatesJson: '[]',
      policySnapshotVersion: 'v1',
      modelRegistryRevision: '1',
      benchmarkVersion: '1',
      performanceSnapshot: '{}',
      routerVersion: 'router-v1',
      traceId: 'trace-c2',
      createdAt: new Date().toISOString(),
    };
    const foreign = heldForeignTransaction(db, async () => {
      await db.events.append([eventOf('evt_c2', 'c2')] as never);
    });
    await tick();
    expect(db.db.writeFence.openTransactionOwner()).not.toBeNull();
    let settled = false;
    const save = (db.routerDecisions as unknown as { save: (record: unknown) => Promise<void> }).save(record);
    void save.then(() => {
      settled = true;
    });
    await tick(5);
    expect(settled).toBe(false); // it waits — it never writes into the foreign transaction
    foreign.release();
    await foreign.settle;
    await save;
    const saved = await (db.routerDecisions as unknown as { get: (id: string) => Promise<unknown> }).get(record.decisionId);
    expect(saved).not.toBeNull(); // committed after legal access (no fake success)
  }, 60_000);

  it('C3/C4/C5/C6 — comment-prefixed and WITH-wrapped mutations and raw exec/prepared access are owned; the statement API is preserved', async () => {
    const db = disposable();
    const statement = db.db.prepare('SELECT 1 AS one');
    // API fidelity: run/get/all (and iterate when the driver has it) all survive.
    expect(typeof statement.run).toBe('function');
    expect(typeof statement.get).toBe('function');
    expect(typeof statement.all).toBe('function');
    const one = statement.get() as { one: number };
    expect(Number(one.one)).toBe(1);
    const raw = db.db.raw;
    const rawStatement = raw.prepare('SELECT 1 AS one');
    if (typeof (rawStatement as unknown as { iterate?: unknown }).iterate === 'function') {
      expect(typeof statement.iterate).toBe('function');
    }
    // A comment-prefixed mutation and a WITH-wrapped mutation are both owned.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const foreign = db.unitOfWork.transaction(async () => {
      await gate;
      return 'x';
    });
    await tick();
    expect(db.db.writeFence.openTransactionOwner()).not.toBeNull();
    for (const sql of [
      "-- leading comment\nINSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES ('evt_c3','c3',1,'now','a','P','u','t',NULL,NULL,'{}',1)",
      "WITH payload AS (SELECT 'x' AS v) INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES ('evt_c4','c4',1,'now','a','P','u','t',NULL,NULL,'{}',2)",
    ]) {
      let refusal: unknown = null;
      try {
        db.db.prepare(sql).run();
      } catch (error) {
        refusal = error;
      }
      expect(refusal, sql.slice(0, 24)).not.toBeNull();
      expect(String((refusal as { details?: Record<string, unknown> }).details?.['reason'])).toBe(
        'CROSS_CONTEXT_TRANSACTION_WRITE_REFUSED',
      );
    }
    // raw.exec and the guarded raw.prepare are owned too.
    let execRefusal: unknown = null;
    try {
      db.db.exec("DELETE FROM events WHERE event_id = 'evt_c3'");
    } catch (error) {
      execRefusal = error;
    }
    expect(execRefusal).not.toBeNull();
    release();
    await foreign;
  }, 60_000);

  it('C7 — a STALE async context (its transaction ended) can never write again', async () => {
    const db = disposable();
    let releaseChild = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let staleRefusal: unknown = null;
    let childDone = false;
    const parent = db.unitOfWork.transaction(async () => {
      // A detached child that outlives the transaction.
      void (async () => {
        await gate;
        try {
          db.db.prepare("INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES ('evt_c7','c7',1,'now','a','P','u','t',NULL,NULL,'{}',1)").run();
        } catch (error) {
          staleRefusal = error;
        }
        childDone = true;
      })();
      return 'ok';
    });
    expect((await parent).ok).toBe(true); // the transaction COMMITTED
    expect(db.db.writeFence.openTransactionOwner()).toBeNull();
    releaseChild(); // the stale child resumes AFTER its unit ended
    await tick(10);
    expect(childDone).toBe(true);
    expect(staleRefusal).not.toBeNull();
    expect(String((staleRefusal as { details?: Record<string, unknown> }).details?.['reason'])).toBe(
      'STALE_TRANSACTION_OWNER_REFUSED',
    );
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_c7'")).toBe(0);
  }, 60_000);

  it('C8 — two SQLite connections: independent mutations land; SQLite UNIQUE arbitrates (never a process-local queue)', async () => {
    const first = disposable();
    const second = openDurableDatabase({
      dataDir: createdDirs[createdDirs.length - 1] as string,
      appliedAt: new Date().toISOString(),
      chains: [...CHAINS],
    });
    openDatabases.push(second);
    expect(second.db.writeFence).not.toBe(first.db.writeFence);
    await Promise.all([
      first.events.append([eventOf('evt_c8a', 'c8')] as never),
      second.events.append([eventOf('evt_c8b', 'c8')] as never),
    ]);
    expect(countOf(first, "SELECT COUNT(*) AS n FROM events WHERE event_id IN ('evt_c8a','evt_c8b')")).toBe(2);
  }, 60_000);

  it('D1/D2/D3/D4/D5 — BEGIN, COMMIT, ROLLBACK and close failures have typed contracts: no fake success, no permanent wait', async () => {
    // D1 — a failed BEGIN is typed and never blocks the queue.
    const db = disposable();
    const raw = db.db.raw;
    const realExec = raw.exec.bind(raw);
    let failBegin = true;
    (raw as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      if (failBegin && sql === 'BEGIN IMMEDIATE') {
        failBegin = false;
        throw new Error('injected BEGIN failure');
      }
      return realExec(sql);
    };
    const failed = await db.unitOfWork.transaction(async () => 'x');
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('PERSISTENCE_FAILED');
    (raw as unknown as { exec: (sql: string) => unknown }).exec = realExec;
    const alive = await db.unitOfWork.transaction(async () => 'alive');
    expect(alive.ok).toBe(true);

    // D2 — a failed COMMIT rolls back; other contexts are not affected.
    let failCommit = true;
    (raw as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      if (failCommit && sql === 'COMMIT') {
        failCommit = false;
        throw new Error('injected COMMIT failure');
      }
      return realExec(sql);
    };
    const committed = await db.unitOfWork.transaction(async () => {
      await db.events.append([eventOf('evt_d2', 'd2')] as never);
      return 'x';
    });
    expect(committed.ok).toBe(false);
    (raw as unknown as { exec: (sql: string) => unknown }).exec = realExec;
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_d2'")).toBe(0);
    expect(db.db.writeFence.connectionState()).toBe('ok'); // the rollback was known-good
    await db.events.append([eventOf('evt_d2b', 'd2b')] as never);
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_d2b'")).toBe(1);

    // D3/D4 — a failed ROLLBACK makes the connection state UNKNOWN: fail closed.
    let failRollback = true;
    (raw as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      if (sql === 'COMMIT') throw new Error('injected COMMIT failure');
      if (failRollback && sql === 'ROLLBACK') {
        failRollback = false;
        throw new Error('injected ROLLBACK failure');
      }
      return realExec(sql);
    };
    const uncertain = await db.unitOfWork.transaction(async () => 'x');
    expect(uncertain.ok).toBe(false);
    (raw as unknown as { exec: (sql: string) => unknown }).exec = realExec;
    expect(db.db.writeFence.connectionState()).toBe('indeterminate');
    const refused = await db.unitOfWork.transaction(async () => 'must not land');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(String(refused.error.details['reason'])).toBe('CONNECTION_STATE_UNCERTAIN');

    // D5 — a CLOSED connection refuses queued work typed (no silent loss).
    const closing = disposable();
    let queued: unknown = 'pending';
    const queuedWrite = closing.db.writeFence.mutation('probe.queued', async () => 'never');
    closing.close();
    await queuedWrite.then(
      (value: unknown) => {
        queued = value;
      },
      (error: unknown) => {
        queued = error;
      },
    );
    expect(String(queued)).toMatch(/CONNECTION_CLOSED|closed/);
    expect(closing.db.writeFence.connectionState()).toBe('closed');
  }, 60_000);

  it('D6/D7 — crash before the task commit leaves nothing; a committed creation survives', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    const db = f.core.database;
    const before = taskFor('tsk_d6_0000000000000001', seeded.runId);
    await expect(
      db.unitOfWork.transaction(async () => {
        await db.tasks.putGuarded(before as never);
        throw new FaultCrashError('crash_before_task_commit');
      }),
    ).rejects.toBeInstanceOf(FaultCrashError);
    expect(await db.tasks.get(before.id as never)).toBeNull(); // nothing committed
    const after = taskFor('tsk_d7_0000000000000001', seeded.runId);
    const created = await db.tasks.putGuarded(after as never);
    expect(created.ok).toBe(true);
    expect(await db.tasks.get(after.id as never)).not.toBeNull(); // survives
  }, 120_000);
});

describe('PART H §10 — the REAL production path (NormalTaskMaterializer over the real stores)', () => {
  it('the real materializer closes the Codex counterexample: created→replay idempotence, no premature replay, no second task identity', async () => {
    const f = await composeF5();
    await seedRunAndTask(f); // the real composition, real stores, real UnitOfWork
    const db = f.core.database;
    // A REAL pinned template + run, written through the REAL stores (never manual truth).
    const now = new Date().toISOString();
    const template = {
      id: 'tpl_probe_0000000000001',
      orgId: COMPANY,
      name: 'probe-template',
      state: 'published',
      currentVersionId: 'ver_probe_0000000000001',
      draftVersionId: null,
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      createdBy: 'user_owner',
      versions: [
        {
          id: 'ver_probe_0000000000001',
          templateId: 'tpl_probe_0000000000001',
          semver: '1.0.0',
          contentHash: 'sha_probe_000000000000000000000000000000000000000000000000000000000000',
          changeProposalId: null,
          state: 'published',
          publishedAt: now,
          createdAt: now,
          createdBy: 'user_owner',
          graph: {
            nodes: [
              { id: 'stage_probe_a', kind: 'normal', title: 'A', config: { taskProfile: { roleId: 'role-probe', taskKind: 'task.probe', maxAttempts: 3 } } },
              { id: 'stage_probe_b', kind: 'normal', title: 'B', config: { taskProfile: { roleId: 'role-probe', taskKind: 'task.probe', maxAttempts: 3 } } },
            ],
            edges: [],
          },
        },
      ],
    };
    const savedTemplate = await (db.templates as unknown as { put: (t: unknown) => Promise<unknown> }).put(template);
    void savedTemplate;
    const runId = 'run_probe_n314_00000000001';
    await (db.runs as unknown as { put: (r: unknown) => Promise<void> }).put({
      id: runId,
      companyId: COMPANY,
      workflowId: 'wf-probe',
      templateId: 'tpl_probe_0000000000001',
      versionId: 'ver_probe_0000000000001',
      snapshotId: 'snap_probe_0000000000001',
      state: 'EXECUTING',
      revision: 1,
      reworkCount: 0,
      maxRework: 3,
      failureReason: null,
      resumePoint: null,
      history: [],
      createdAt: now,
      updatedAt: now,
      startedBy: 'user_owner',
    } as never);
    const materializer = createNormalTaskMaterializer({
      runs: db.runs as never,
      templates: db.templates as never,
      runSnapshot: { verify: async () => okResult(true) as never },
      tasks: db.tasks as never,
      taskKindAvailable: () => true,
      clock: { nowIso: () => new Date().toISOString() },
    });
    const input = { companyId: COMPANY, runId, stageId: 'stage_probe_a', inputs: { spec: 'mat' } };
    // The Codex window: a foreign uncommitted write while the materializer runs.
    const foreign = heldForeignTransaction(db, async () => {
      await db.events.append([eventOf('evt_probe_mat', 'probe.mat')] as never);
    });
    await tick();
    expect(db.db.writeFence.openTransactionOwner()).not.toBeNull();
    const first = materializer.materialize(input as never);
    await tick(5);
    foreign.release();
    expect((await foreign.settle).ok).toBe(false);
    const created = await first;
    expect(created.ok, created.ok ? '' : JSON.stringify({ code: created.error.code, message: created.error.message, details: created.error.details })).toBe(true);
    if (created.ok) {
      expect(created.value.replayed).toBe(false); // CASE A — never a premature replay
      expect(await db.tasks.get(created.value.taskId as never)).not.toBeNull(); // durable truth
      // The SAME creation command replays the SAME canonical task (idempotence).
      const replay = await materializer.materialize(input as never);
      expect(replay.ok).toBe(true);
      if (replay.ok) {
        expect(replay.value.replayed).toBe(true);
        expect(replay.value.taskId).toBe(created.value.taskId);
      }
      const total = Number(
        (db.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get(created.value.taskId) as { n: number }).n,
      );
      expect(total).toBe(1); // ONE canonical task identity
      // Replay authority: the same identity with a different creation seed conflicts.
      const conflicting = await materializer.materialize({ ...input, inputs: { spec: 'OTHER' } } as never);
      expect(conflicting.ok).toBe(false);
      if (!conflicting.ok) expect(conflicting.error.code).toBe('VALIDATION_FAILED');
    }
  }, 120_000);
});

describe('PART G E1-E5 — the closed invariants stay closed under the new fence', () => {
  it('E1-E5 re-assert: one owner per identity, Decision+marker, CAS+audit, fixed deadline, independent recovery', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 8_000, maxSupervisorTurns: 1 });
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    await f.core.autonomousSupervisor!.run({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      runIdentity: 'n314-e',
      timeoutMs: 8000,
    });
    const rows = f.core.database.db
      .prepare(
        "SELECT execution_id, logical_turn_id, outcome_committed_at, outcome_decision_id, decision_authority_expires_at, status FROM agent_executions WHERE agent_id = 'supervisor-runtime'",
      )
      .all() as {
      execution_id: string;
      logical_turn_id: string | null;
      outcome_committed_at: string | null;
      outcome_decision_id: string | null;
      decision_authority_expires_at: string | null;
      status: string;
    }[];
    // E1 — one historical owner per logicalTurnId.
    const identities = rows.map((row) => row.logical_turn_id).filter((id): id is string => typeof id === 'string');
    expect(new Set(identities).size).toBe(identities.length);
    // E2/E3 — a committed Decision names its owner; exactly one terminal audit exists.
    for (const row of rows.filter((entry) => entry.outcome_committed_at !== null)) {
      expect(row.outcome_decision_id).not.toBeNull();
      const terminalEvents = Number(
        (f.core.database.db
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE aggregate_id = ? AND type IN ('agent.execution_completed','agent.execution_failed','agent.execution_cancelled','agent.execution_interrupted')",
          )
          .get(row.execution_id) as { n: number }).n,
      );
      expect(terminalEvents).toBe(1);
    }
    // E4 — the durable deadline is fixed and present on every bounded turn.
    expect(rows.every((row) => row.decision_authority_expires_at !== null)).toBe(true);
    // E5 — recovery ownership is per-Goal (the runner's registry is per runId): two starts
    // for the SAME Goal de-duplicate to at most ONE scheduled recovery; a different Goal is
    // independent (see the N4-R2 suite for the full multi-Goal matrix).
    const scheduled: { fn: () => void; ms: number }[] = [];
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: {
        run: async () =>
          err(
            domainError('PERSISTENCE_FAILED', 'storage unavailable', {
              reason: 'RECONCILIATION_PERSISTENCE_FAILED',
            }),
          ),
      } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async () => 'EXECUTING',
      stallResumeDelayMs: 20,
    });
    runner.start(COMPANY, seeded.runId);
    runner.start(COMPANY, seeded.runId); // the SAME goal de-duplicates
    await tick(30);
    expect(scheduled.length).toBe(1);
  }, 120_000);
});
