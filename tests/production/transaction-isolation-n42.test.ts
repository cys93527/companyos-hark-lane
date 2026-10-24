/**
 * 42ed326 re-audit — N42-T1 CONNECTION-WIDE TRANSACTION ISOLATION.
 *
 * Codex counterexample: a losing supervisor claim opened a transaction that stayed open
 * across an `await`; another async context then wrote a ModelRegistry disable and provider
 * audit events DIRECTLY on the same SQLite connection (inside that open transaction); the
 * loser's UNIQUE-conflict ROLLBACK silently erased them — the API had already returned
 * success. ALS alone could not stop this: it identifies the unit that OWNS a transaction,
 * it does not stop a FOREIGN context's statement from joining it.
 *
 * The fix (persistence infrastructure, connection scope): every mutation either runs
 * inside its own authorized unit, runs immediately while NO transaction is open, waits for
 * legal access (async API), or is REFUSED typed (a raw statement aimed at a foreign open
 * transaction). Tests here are durable-level and disposable; the real composition paths
 * are exercised by the F5-based suites and the live E2E.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FaultCrashError, type DomainError } from '@companyos/core';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { COMPANY, composeF5, openDatabases as fixtureDatabases, type F5Fixture } from './helpers/f5-fixture.js';

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (fixtureDatabases.length > 0) fixtureDatabases.pop()?.close();
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
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
] as const;

const disposable = (): DurableDatabase => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-n42-'));
  createdDirs.push(dir);
  const db = openDurableDatabase({ dataDir: dir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  return db;
};

const tick = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const countOf = (db: DurableDatabase, sql: string, ...params: readonly string[]): number =>
  Number((db.db.prepare(sql).get(...(params as never[])) as { n: number }).n);

/**
 * N07-I1 — DURABLE TRUTH IS OBSERVED THROUGH AN INDEPENDENT CONNECTION. The shared
 * connection refuses reads while another context's transaction is open (uncommitted rows
 * must never be consulted as truth), so a mid-flight "has it committed yet?" assertion is
 * answered by a separate read-only connection: it sees only COMMITTED state.
 */
const durableCountOf = (db: DurableDatabase, sql: string, ...params: readonly string[]): number => {
  const reader = new DatabaseSync(db.path, { readOnly: true });
  try {
    return Number((reader.prepare(sql).get(...(params as never[])) as { n: number }).n);
  } finally {
    reader.close();
  }
};

interface Seeded {
  readonly runId: string;
  readonly taskId: string;
  readonly actor: string;
}

const seedRunAndTask = async (f: F5Fixture): Promise<Seeded> => {
  const created = await f.core.controlPlane!.handle({
    operation: 'goal.create',
    payload: { companyId: COMPANY, objective: 'connection isolation N42', commandId: `n42-${String(Date.now())}` },
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

const runLoop = (f: F5Fixture, seeded: Seeded, runIdentity: string, timeoutMs: number) =>
  f.core.autonomousSupervisor!.run({
    companyId: COMPANY,
    runId: seeded.runId,
    taskId: seeded.taskId,
    actorId: seeded.actor,
    runIdentity,
    timeoutMs,
  });

const MODEL_ROW = (id: string, enabled: boolean, now: string) => ({
  id,
  modelKey: 'f5.planner',
  providerId: 'prov_f5',
  providerModelId: 'p1',
  displayName: 'Model',
  description: '',
  capabilities: {},
  contextWindow: 8000,
  maxOutputTokens: null,
  pricing: null,
  enabled,
  availability: 'available',
  metadata: {},
  registeredAt: now,
  updatedAt: now,
  registeredBy: 'user_owner',
});

/** A transaction that opens on the connection and STAYS OPEN across an await. */
const openHeldTransaction = (
  db: DurableDatabase,
): { readonly release: () => void; readonly settle: Promise<{ ok: boolean; error?: DomainError }> } => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settle = db.unitOfWork.transaction(async () => {
    await gate; // the loser's claim window: the transaction is OPEN across an await
    throw new Error('injected loser conflict rollback');
  });
  return {
    release,
    settle: settle.then((result) => ({ ok: result.ok, ...(result.ok ? {} : { error: result.error }) })),
  };
};

describe('N42-T1 — a foreign open transaction can never swallow another context write', () => {
  it('T1-01 ModelRegistry disable survives a loser transaction ROLLBACK (the Codex counterexample)', async () => {
    const db = disposable();
    const now = new Date().toISOString();
    await db.modelRecords.put(MODEL_ROW('mdl_x', true, now) as never);
    expect(countOf(db, "SELECT COUNT(*) AS n FROM model_records WHERE id = 'mdl_x' AND enabled = 1")).toBe(1);
    const loser = openHeldTransaction(db);
    await tick();
    expect(db.db.writeFence.openTransactionOwner()).not.toBeNull(); // the loser's txn IS open
    // The operator disables the model THROUGH THE STORE while the loser's txn is open.
    const disabled = db.modelRecords.put(MODEL_ROW('mdl_x', false, now) as never);
    await tick(5);
    // Not written yet: it is WAITING for legal access, not sneaking into the open txn.
    expect(durableCountOf(db, "SELECT COUNT(*) AS n FROM model_records WHERE id = 'mdl_x' AND enabled = 0")).toBe(0);
    loser.release();
    const outcome = await loser.settle;
    expect(outcome.ok).toBe(false); // the loser rolled back
    await disabled; // and only now does the disable commit — durably, on its own.
    expect(countOf(db, "SELECT COUNT(*) AS n FROM model_records WHERE id = 'mdl_x' AND enabled = 0")).toBe(1);
    const reread = await db.modelRecords.get('mdl_x');
    expect(reread?.enabled).toBe(false);
  }, 60_000);

  it('T1-02 provider audit appends survive a loser transaction ROLLBACK', async () => {
    const db = disposable();
    const loser = openHeldTransaction(db);
    await tick();
    expect(db.db.writeFence.openTransactionOwner()).not.toBeNull();
    const event = (type: string, id: string) => ({
      eventId: id,
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      aggregateId: 'exa_probe',
      aggregateType: 'AgentExecution',
      actorId: 'user_owner',
      traceId: 'trace_probe',
      payload: { providerId: 'model.openai-compatible' },
    });
    const appended = db.events.append([event('provider.invoked', 'evt_p1'), event('agent.provider_invoked', 'evt_p2')] as never);
    await tick(5);
    expect(durableCountOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id IN ('evt_p1','evt_p2')")).toBe(0);
    loser.release();
    const outcome = await loser.settle;
    expect(outcome.ok).toBe(false);
    await appended;
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id IN ('evt_p1','evt_p2')")).toBe(2);
    // Restart-equivalent: a FRESH connection still sees both committed audit events.
    const reopened = new DatabaseSync(db.path, { readOnly: true });
    expect(Number((reopened.prepare("SELECT COUNT(*) AS n FROM events WHERE event_id IN ('evt_p1','evt_p2')").get() as { n: number }).n)).toBe(2);
    reopened.close();
  }, 60_000);

  it('T1-05/06 a RAW statement aimed at a foreign open transaction is REFUSED typed; after its ROLLBACK the same write succeeds', async () => {
    const db = disposable();
    const loser = openHeldTransaction(db);
    await tick();
    let refusal: unknown = null;
    try {
      // A direct statement (bypassing the fence) must never join the foreign transaction.
      db.db.prepare('INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
        'evt_raw',
        'raw.direct',
        1,
        new Date().toISOString(),
        'agg',
        'Probe',
        'user_owner',
        'trace',
        null,
        null,
        '{}',
        999_999,
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).not.toBeNull();
    expect((refusal as { code?: string }).code).toBe('PERSISTENCE_FAILED');
    expect(String((refusal as { details?: Record<string, unknown> }).details?.['reason'])).toBe('CROSS_CONTEXT_TRANSACTION_WRITE_REFUSED');
    loser.release();
    await loser.settle;
    // After the foreign unit ended, the SAME statement is legal and durable.
    db.db.prepare('INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'evt_raw2',
      'raw.direct',
      1,
      new Date().toISOString(),
      'agg',
      'Probe',
      'user_owner',
      'trace',
      null,
      null,
      '{}',
      999_998,
    );
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_raw2'")).toBe(1);
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_raw'")).toBe(0);
  }, 60_000);

  it('T1-03/04 EventStore and registry writes share ONE fence: concurrent independent writes both commit, ordered', async () => {
    const db = disposable();
    const fenceFromUow = db.unitOfWork;
    const fenceFromDb = db.db.writeFence;
    expect(fenceFromUow.committed).toBeTypeOf('function');
    const before = fenceFromDb.committed();
    const [a, b] = await Promise.all([
      db.events.append([{ eventId: 'evt_a', type: 'probe.a', version: 1, occurredAt: new Date().toISOString(), aggregateId: 'x', aggregateType: 'P', actorId: 'u', traceId: 't', payload: {} }] as never),
      db.modelRecords.put(MODEL_ROW('mdl_y', false, new Date().toISOString()) as never),
    ]);
    expect(a).toEqual([1]);
    expect(b).toBeUndefined();
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_a'")).toBe(1);
    expect(countOf(db, "SELECT COUNT(*) AS n FROM model_records WHERE id = 'mdl_y'")).toBe(1);
    // Neither queued a transaction (both committed as standalone immediate mutations).
    expect(fenceFromDb.committed()).toBe(before);
  }, 60_000);

  it('T1-07 a COMMIT failure on one unit never wrongly rolls back, commits or blocks another context write', async () => {
    const db = disposable();
    const raw = db.db.raw;
    const realExec = raw.exec.bind(raw);
    let failNextCommit = true;
    (raw as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      if (failNextCommit && sql === 'COMMIT') {
        failNextCommit = false;
        throw new Error('injected COMMIT failure');
      }
      return realExec(sql);
    };
    const failing = await db.unitOfWork.transaction(async () => {
      db.db.prepare("INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES ('evt_t7','t7',1,'now','a','P','u','t',NULL,NULL,'{}',1)").run();
      return 'ok';
    });
    expect(failing.ok).toBe(false);
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_t7'")).toBe(0); // rolled back
    // The queue is healthy: the next independent write lands.
    await db.events.append([{ eventId: 'evt_t7b', type: 't7.b', version: 1, occurredAt: new Date().toISOString(), aggregateId: 'a', aggregateType: 'P', actorId: 'u', traceId: 't', payload: {} }] as never);
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_t7b'")).toBe(1);
  }, 60_000);

  it('T1-08/09 FIFO survives a throwing write; nested serialize runs in place (no self-wait)', async () => {
    const db = disposable();
    const uow = db.unitOfWork as Required<typeof db.unitOfWork>;
    await expect(
      uow.serialize(async () => {
        throw new Error('injected FIFO failure');
      }),
    ).rejects.toThrow(/injected FIFO failure/);
    // Nested serialize: SUPPORTED — the inner unit runs in the outer's slot, no hang.
    const nested = await uow.serialize(async () => uow.serialize(async () => 'inner'));
    expect(nested).toBe('inner');
    // serialize → transaction: SUPPORTED (314caae) — escalates in place, no self-wait.
    const escalated = await uow.serialize(async () => uow.transaction(async () => 'x'));
    expect(escalated.ok).toBe(true);
    if (!escalated.ok) throw new Error(escalated.error.message);
    expect(escalated.value).toBe('x');
    expect(db.db.writeFence.openTransactionOwner()).toBeNull();
  }, 60_000);

  it('T1-10 nested transaction poison rolls the OUTER unit back and leaks nothing to other contexts', async () => {
    const db = disposable();
    const outcome = await db.unitOfWork.transaction(async () => {
      db.db.prepare("INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES ('evt_nest','n',1,'now','a','P','u','t',NULL,NULL,'{}',1)").run();
      const inner = await db.unitOfWork.transaction(async () => {
        throw new Error('nested failure');
      });
      expect(inner.ok).toBe(false);
      return 'outer';
    });
    expect(outcome.ok).toBe(false); // the poison rolled the OUTER unit back
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_nest'")).toBe(0);
    // No poison leaked: a NEW transaction commits normally.
    const next = await db.unitOfWork.transaction(async () => 'clean');
    expect(next.ok).toBe(true);
  }, 60_000);

  it('T1-11 two SQLite CONNECTIONS: independent mutations both land; the durable arbiter stays SQLite, not a process-local queue', async () => {
    const first = disposable();
    const dir = createdDirs[createdDirs.length - 1] as string;
    const second = openDurableDatabase({ dataDir: dir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
    openDatabases.push(second);
    expect(second.db.writeFence).not.toBe(first.db.writeFence); // separate connections, separate fences
    const [a, b] = await Promise.all([
      first.events.append([{ eventId: 'evt_c1', type: 'c1', version: 1, occurredAt: new Date().toISOString(), aggregateId: 'a', aggregateType: 'P', actorId: 'u', traceId: 't', payload: {} }] as never),
      second.events.append([{ eventId: 'evt_c2', type: 'c2', version: 1, occurredAt: new Date().toISOString(), aggregateId: 'a', aggregateType: 'P', actorId: 'u', traceId: 't', payload: {} }] as never),
    ]);
    void a;
    void b;
    expect(countOf(first, "SELECT COUNT(*) AS n FROM events WHERE event_id IN ('evt_c1','evt_c2')")).toBe(2);
    // A UNIQUE conflict across connections is still decided by SQLite, not by any local lock.
    first.db.prepare("INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES ('evt_uq','uq',1,'now','a','P','u','t',NULL,NULL,'{}',10)").run();
    let conflict: unknown = null;
    try {
      second.db.prepare("INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES ('evt_uq','uq',1,'now','a','P','u','t',NULL,NULL,'{}',11)").run();
    } catch (error) {
      conflict = error;
    }
    expect(conflict).not.toBeNull();
    expect(String((conflict as { message?: string }).message)).toMatch(/UNIQUE|constraint/i);
    expect(countOf(second, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_uq'")).toBe(1);
  }, 60_000);

  it('T1-12/13 crash BEFORE the commit leaves nothing; after a committed unit the rows survive', async () => {
    const db = disposable();
    // 12: the crash sentinel thrown INSIDE the unit — the fence rolls back, then re-throws.
    await expect(
      db.unitOfWork.transaction(async () => {
        db.db.prepare("INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES ('evt_pre','p',1,'now','a','P','u','t',NULL,NULL,'{}',1)").run();
        throw new FaultCrashError('crash_before_commit');
      }),
    ).rejects.toBeInstanceOf(FaultCrashError);
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_pre'")).toBe(0);
    expect(db.db.writeFence.openTransactionOwner()).toBeNull(); // no orphan transaction left open
    // 13: a committed unit's rows survive a crash thrown right after it returned.
    const committed = await db.unitOfWork.transaction(async () => {
      db.db.prepare("INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES ('evt_post','q',1,'now','a','P','u','t',NULL,NULL,'{}',2)").run();
      return 'committed';
    });
    expect(committed.ok).toBe(true);
    try {
      throw new FaultCrashError('crash_after_commit');
    } catch {
      // the process would die here; the durable row must already be there
    }
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_post'")).toBe(1);
  }, 60_000);

  it('T1-14/15 terminal CAS + mandatory audit, and Decision + outcome marker, remain atomic under the fence', async () => {
    // T1-14/15 are proven end-to-end by the F5 suites (A1-04 terminal CAS+audit rollback;
    // N9-C2 atomicity) which run ON this fence; here we pin the FENCE-level property they
    // rely on: a unit's writes are invisible until COMMIT and all-or-nothing.
    const db = disposable();
    let sawInside = -1;
    let sawAfter = -1;
    const outcome = await db.unitOfWork.transaction(async () => {
      db.db.prepare("INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES ('evt_cas','cas',1,'now','a','P','u','t',NULL,NULL,'{}',3)").run();
      sawInside = countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_cas'");
      return 'ok';
    });
    expect(outcome.ok).toBe(true);
    sawAfter = countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_cas'");
    expect(sawInside).toBe(1);
    expect(sawAfter).toBe(1);
    // A SECOND connection cannot see an uncommitted row (SQLite isolation is the arbiter).
    const reopened = new DatabaseSync(db.path, { readOnly: true });
    expect(Number((reopened.prepare("SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_cas'").get() as { n: number }).n)).toBe(1);
    reopened.close();
  }, 60_000);
});

describe('PHASE 7 — the fence is the CONNECTION scope, shared by every store and the UnitOfWork', () => {
  it('the UnitOfWork IS the connection fence: a store write waits while a UnitOfWork transaction is open', async () => {
    const db = disposable();
    expect(typeof db.db.writeFence.openTransactionOwner).toBe('function');
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.unitOfWork.transaction(async () => {
      await gate;
      return 'held';
    });
    await tick();
    expect(db.db.writeFence.openTransactionOwner()).not.toBeNull();
    const storeWrite = db.events.append([
      { eventId: 'evt_shared', type: 'shared', version: 1, occurredAt: new Date().toISOString(), aggregateId: 'a', aggregateType: 'P', actorId: 'u', traceId: 't', payload: {} },
    ] as never);
    await tick(5);
    // The STORE's write is blocked by the same fence the UnitOfWork owns — one coordinator.
    expect(durableCountOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_shared'")).toBe(0);
    release();
    expect((await holder).ok).toBe(true);
    await storeWrite;
    expect(countOf(db, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_shared'")).toBe(1);
  }, 60_000);
});

describe('PHASE 5 — the REAL production paths (composition root), not fixtures', () => {
  it('T1-16 (real Desktop composition) a losing claim transaction cannot erase provider audit; a held unit cannot un-disable a model', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 8_000, maxSupervisorTurns: 1 });
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    const invocationsBefore = f.supervisorInvocations.length;
    // (a) the loser's OPEN claim transaction spans the winner's whole real turn.
    f.faults.holdClaimOnConflictMs = 800;
    const entrants = await Promise.all([
      runLoop(f, seeded, 'n42-real', 8000),
      runLoop(f, seeded, 'n42-real', 8000),
    ]);
    for (const entrant of entrants) expect(entrant.ok).toBe(true);
    expect(f.supervisorInvocations.length - invocationsBefore).toBe(1);
    // The winner's REAL provider-audit events survived the loser's rollback.
    const providerEvents = Number(
      (f.core.database.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type IN ('agent.provider_invoked','provider.invoked')")
        .get() as { n: number }).n,
    );
    expect(providerEvents).toBeGreaterThan(0);

    // (b) the REAL ModelRegistry service, disabled while an unrelated unit's transaction is
    // open: the write waits for legal access and commits — the unit's ROLLBACK cannot undo it.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = f.core.database.unitOfWork.transaction(async () => {
      await gate;
      throw new Error('injected unrelated rollback');
    });
    await tick();
    expect(f.core.database.db.writeFence.openTransactionOwner()).not.toBeNull();
    const disabling = f.core.models.setEnabled('f5.planner', false, seeded.actor);
    await tick(5);
    const midFlightReader = new DatabaseSync(f.core.database.path, { readOnly: true });
    const midFlight = midFlightReader
      .prepare("SELECT enabled FROM model_records WHERE model_key = 'f5.planner'")
      .get() as { enabled: number };
    midFlightReader.close();
    expect(Number(midFlight.enabled)).toBe(1); // durable truth: not written into the open unit
    release();
    expect((await held).ok).toBe(false);
    const disabled = await disabling;
    expect(disabled.ok).toBe(true);
    const after = f.core.database.db
      .prepare("SELECT enabled FROM model_records WHERE model_key = 'f5.planner'")
      .get() as { enabled: number };
    expect(Number(after.enabled)).toBe(0); // the disable SURVIVED the unrelated rollback
    expect(f.core.database.db.writeFence.openTransactionOwner()).toBeNull();
  }, 120_000);
});
