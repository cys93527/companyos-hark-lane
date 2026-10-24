/**
 * 07cc53b re-audit — N07-R1: SYNCHRONOUS TRANSACTION SAFETY.
 *
 * Codex counterexample: `HandoffService.createDraft → handoffStore.create → db.inTransaction`
 * hit a UNIQUE conflict, the synchronous ROLLBACK then FAILED, and the connection was left
 * with a RESIDUAL OPEN TRANSACTION while the code reported agreement. A later
 * `models.setEnabled(model, false)` wrote into that residual transaction, its
 * `model.disabled` audit was appended, and BOTH reported success — then the residual
 * transaction (or a later rollback/close) erased them: durable truth (verified on an
 * independent connection) never contained the disable.
 *
 * Core invariant (N07-R1): a connection whose COMMIT/ROLLBACK outcome cannot be reliably
 * established must never again confirm a new durable mutation success. This suite drives
 * the REAL production paths (real handoff store, real ModelRegistry service, real
 * EventStore, real TaskStore) on disposable fixtures, and observes durable truth through
 * INDEPENDENT read-only connections.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { COMPANY, composeF5, createdDirs as fixtureDirs, openDatabases as fixtureDbs, type F5Fixture } from './helpers/f5-fixture.js';

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (fixtureDbs.length > 0) {
    try {
      fixtureDbs.pop()?.close();
    } catch {
      // already closed by a test
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
  }
  while (fixtureDirs.length > 0) {
    const dir = fixtureDirs.pop();
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
  'router',
] as const;

const disposable = (): DurableDatabase => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-n07-'));
  createdDirs.push(dir);
  const db = openDurableDatabase({ dataDir: dir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  return db;
};

/** Durable truth is observed through an INDEPENDENT read-only connection (N07-I1). */
const independentCount = (dbPath: string, sql: string, ...params: readonly string[]): number => {
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number((reader.prepare(sql).get(...(params as never[])) as { n: number }).n);
  } finally {
    reader.close();
  }
};

const independentRow = (
  dbPath: string,
  sql: string,
  ...params: readonly string[]
): Record<string, unknown> | undefined => {
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return reader.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
  } finally {
    reader.close();
  }
};

const stateOf = (db: DurableDatabase): string => db.db.writeFence.connectionState();

/** Fail the NEXT `raw.exec` whose SQL matches — the controlled COMMIT/ROLLBACK fault. */
const failNextExec = (db: DurableDatabase, sql: string): () => void => {
  const raw = db.db.raw as unknown as { exec: (sql: string) => unknown };
  const real = raw.exec.bind(raw);
  let armed = true;
  raw.exec = (statement: string) => {
    if (armed && statement === sql) {
      armed = false;
      throw Object.assign(new Error(`injected ${sql} failure`), { code: 'SQLITE_IOERR' });
    }
    return real(statement);
  };
  return () => {
    raw.exec = real;
    armed = false;
  };
};

const handoffPacket = (handoffId: string, companyId = COMPANY) => ({
  handoffId,
  handoffVersion: 1,
  companyId,
  workflowId: 'wf-handoff',
  workflowVersionId: 'wfv-handoff',
  workflowRunId: `run_${handoffId}`,
  stageId: 'stg-handoff',
  taskId: `tsk_${handoffId}`,
  fromAgentId: 'agent-a',
  fromRoleId: 'role-a',
  toRoleId: 'role-b',
  toAgentId: 'agent-b',
  objective: 'handoff probe',
  status: 'DRAFT' as const,
  summary: 'probe',
  completedWork: [],
  remainingWork: [],
  constraints: [],
  acceptanceCriteria: [],
  knownRisks: [],
  openQuestions: [],
  recommendedNextAction: 'continue',
  modelBinding: null,
  executionRef: null,
  supersedes: null,
  acceptedBy: null,
  acceptedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReasons: [],
  rejectionComment: null,
  artifactRefs: [],
  validationRefs: [],
  decisionRefs: [],
  traceId: 'trace-n07',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const eventOf = (id: string, type = 'n07.probe') => ({
  eventId: id,
  type,
  version: 1,
  occurredAt: new Date().toISOString(),
  aggregateId: 'probe',
  aggregateType: 'Probe',
  actorId: 'user_owner',
  traceId: 'trace-n07',
  payload: {},
});

interface Seeded {
  readonly runId: string;
  readonly taskId: string;
  readonly actor: string;
}

const seedRunAndTask = async (f: F5Fixture): Promise<Seeded> => {
  const created = await f.core.controlPlane!.handle({
    operation: 'goal.create',
    payload: { companyId: COMPANY, objective: 'sync transaction N07', commandId: `n07-${String(Date.now())}` },
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

describe('N07-R1 — the synchronous transaction obeys the ONE connection state machine', () => {
  it('R1-01 a normal synchronous transaction commits; the independent connection sees it', () => {
    const db = disposable();
    const wrote = db.db.inTransaction(() => {
      db.db
        .prepare(
          "INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES ('evt_r101','r101',1,'now','a','P','u','t',NULL,NULL,'{}',1)",
        )
        .run();
      return 'ok';
    });
    expect(wrote).toBe('ok');
    expect(stateOf(db)).toBe('ok');
    expect(db.db.writeFence.openTransactionOwner()).toBeNull();
    expect(independentCount(db.path, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_r101'")).toBe(1);
  });

  it('R1-02 a UNIQUE conflict with a successful ROLLBACK leaves the connection legal; later writes commit', async () => {
    const db = disposable();
    if (db.handoffStore === null) throw new Error('handoff store not composed');
    await db.handoffStore.create(handoffPacket('hof_r102') as never);
    let refusal: unknown = null;
    try {
      await db.handoffStore.create(handoffPacket('hof_r102') as never);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).not.toBeNull();
    expect(String((refusal as { code?: string }).code)).toBe('ALREADY_EXISTS');
    expect(stateOf(db)).toBe('ok');
    expect(db.db.writeFence.openTransactionOwner()).toBeNull();
    // A later independent write commits normally…
    await db.events.append([eventOf('evt_r102')] as never);
    expect(independentCount(db.path, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_r102'")).toBe(1);
    // …and exactly ONE canonical handoff exists.
    expect(independentCount(db.path, "SELECT COUNT(*) AS n FROM handoffs WHERE handoff_id = 'hof_r102'")).toBe(1);
  });

  it('R1-03/12 a UNIQUE conflict whose ROLLBACK FAILS: INDETERMINATE, no false success on ANY store', async () => {
    const db = disposable();
    if (db.handoffStore === null) throw new Error('handoff store not composed');
    await db.handoffStore.create(handoffPacket('hof_r103') as never);
    const restore = failNextExec(db, 'ROLLBACK');
    let refusal: unknown = null;
    try {
      await db.handoffStore.create(handoffPacket('hof_r103') as never);
    } catch (error) {
      refusal = error;
    }
    restore();
    expect(refusal).not.toBeNull();
    expect(String((refusal as { code?: string }).code)).toBe('PERSISTENCE_FAILED');
    const details = (refusal as { details?: Record<string, unknown> }).details ?? {};
    expect(String(details['reason'])).toBe('SYNC_TRANSACTION_ROLLBACK_FAILED');
    expect(details['rollbackUnknown']).toBe(true);
    expect(details['residualTransaction']).toBe(true);
    expect(String(details['cause'])).toContain('UNIQUE'); // the original cause is retained
    // The connection's transaction state is UNKNOWN — never reported as recovered.
    expect(stateOf(db)).toBe('indeterminate');
    // R1-12 — every store on the shared connection refuses typed; none reports success.
    const attempts: string[] = [];
    for (const attempt of [
      async () => db.modelRecords.put({ id: 'mdl_r103', modelKey: 'k', providerId: 'p', providerModelId: 'pm', displayName: 'M', description: '', capabilities: {}, contextWindow: 1, maxOutputTokens: null, pricing: null, enabled: false, availability: 'available', metadata: {}, registeredAt: 'now', updatedAt: 'now', registeredBy: 'u' } as never),
      async () => db.events.append([eventOf('evt_r103')] as never),
      async () => db.tasks.putGuarded({ id: 'tsk_r103', runId: 'run_x', stageId: 's', roleId: 'r', kind: 'k', state: 'READY', attempts: 0, maxAttempts: 1, inputs: {}, outputs: {}, createdAt: 'now', updatedAt: 'now' } as never),
      async () => db.handoffStore!.create(handoffPacket('hof_r103b') as never),
    ]) {
      try {
        await attempt();
        attempts.push('SUCCESS');
      } catch (error) {
        attempts.push(String((error as { code?: string }).code ?? 'THREW'));
      }
    }
    expect(attempts).toEqual(['PERSISTENCE_FAILED', 'PERSISTENCE_FAILED', 'PERSISTENCE_FAILED', 'PERSISTENCE_FAILED']);
    // Durable truth (independent connection) holds none of the refused writes.
    expect(independentCount(db.path, "SELECT COUNT(*) AS n FROM model_records WHERE id = 'mdl_r103'")).toBe(0);
    expect(independentCount(db.path, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_r103'")).toBe(0);
    expect(independentCount(db.path, "SELECT COUNT(*) AS n FROM handoffs WHERE handoff_id = 'hof_r103b'")).toBe(0);
  });

  it('R1-04 (the Codex counterexample, REAL composition) a residual transaction can never produce a false model-disable success', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    const db = f.core.database;
    if (db.handoffStore === null) throw new Error('handoff store not composed');
    await db.handoffStore.create(handoffPacket('hof_r104', COMPANY) as never);
    // The disable is durable BEFORE the incident: the model is known-enabled after seeding.
    const before = independentRow(db.path, "SELECT enabled FROM model_records WHERE model_key = 'f5.planner'");
    expect(Number(before?.['enabled'] ?? 0)).toBe(1);
    // The loser's synchronous transaction rolls back FAILINGLY (residual open transaction).
    const restore = failNextExecOnly(db);
    let handoffRefusal: unknown = null;
    try {
      await db.handoffStore.create(handoffPacket('hof_r104', COMPANY) as never);
    } catch (error) {
      handoffRefusal = error;
    }
    restore();
    expect(handoffRefusal).not.toBeNull();
    expect(f.core.database.db.writeFence.connectionState()).toBe('indeterminate');
    // The REAL ModelRegistry service: it must NOT report success (the disable may not become
    // a fake durable success that a residual rollback later erases).
    const disabled = await f.core.models.setEnabled('f5.planner', false, seeded.actor);
    expect(disabled.ok).toBe(false);
    // Durable truth on an INDEPENDENT connection: the model is still enabled.
    const after = independentRow(db.path, "SELECT enabled FROM model_records WHERE model_key = 'f5.planner'");
    expect(Number(after?.['enabled'] ?? 1)).toBe(1);
  }, 120_000);

  it('R1-05 (REAL composition) a residual transaction cannot report an event durably persisted and then lose it', async () => {
    const f = await composeF5();
    await seedRunAndTask(f);
    const db = f.core.database;
    if (db.handoffStore === null) throw new Error('handoff store not composed');
    await db.handoffStore.create(handoffPacket('hof_r105', COMPANY) as never);
    const restore = failNextExecOnly(db);
    await db.handoffStore.create(handoffPacket('hof_r105', COMPANY) as never).catch(() => undefined);
    restore();
    expect(f.core.database.db.writeFence.connectionState()).toBe('indeterminate');
    let appendRefusal: unknown = null;
    try {
      await db.events.append([eventOf('evt_r105', 'provider.invoked')] as never);
    } catch (error) {
      appendRefusal = error;
    }
    expect(appendRefusal).not.toBeNull();
    expect(String((appendRefusal as { code?: string }).code)).toBe('PERSISTENCE_FAILED');
    // Independent connection: the event truly does not exist (never a vanished success).
    expect(independentCount(db.path, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_r105'")).toBe(0);
  }, 120_000);

  it('R1-06 a failed COMMIT with a successful ROLLBACK returns the error and stays safe', async () => {
    const db = disposable();
    const restore = failNextExec(db, 'COMMIT');
    let refusal: unknown = null;
    try {
      db.db.inTransaction(() => {
        db.db
          .prepare(
            "INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES ('evt_r106','r106',1,'now','a','P','u','t',NULL,NULL,'{}',2)",
          )
          .run();
      });
    } catch (error) {
      refusal = error;
    }
    restore();
    expect(refusal).not.toBeNull();
    expect(stateOf(db)).toBe('ok'); // the rollback was known-good
    expect(db.db.writeFence.openTransactionOwner()).toBeNull();
    expect(independentCount(db.path, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_r106'")).toBe(0);
    await db.events.append([eventOf('evt_r106b')] as never);
    expect(independentCount(db.path, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_r106b'")).toBe(1);
  });

  it('R1-07 a failed COMMIT whose ROLLBACK also fails: fail closed, never a fake success', async () => {
    const db = disposable();
    const commitFailure = failNextExec(db, 'COMMIT');
    const rollbackFailure = failNextExec(db, 'ROLLBACK');
    let refusal: unknown = null;
    try {
      db.db.inTransaction(() => 'never lands');
    } catch (error) {
      refusal = error;
    }
    commitFailure();
    rollbackFailure();
    expect(refusal).not.toBeNull();
    expect(String((refusal as { code?: string }).code)).toBe('PERSISTENCE_FAILED');
    expect(stateOf(db)).toBe('indeterminate');
    await expect(db.events.append([eventOf('evt_r107')] as never)).rejects.toThrow(/indeterminate|refuses/);
    expect(independentCount(db.path, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_r107'")).toBe(0);
  });

  it('R1-08 a failed BEGIN is typed and leaves no owner behind', async () => {
    const db = disposable();
    const restore = failNextExec(db, 'BEGIN IMMEDIATE');
    let refusal: unknown = null;
    try {
      db.db.inTransaction(() => 'never');
    } catch (error) {
      refusal = error;
    }
    restore();
    expect(refusal).not.toBeNull();
    expect(String((refusal as { code?: string }).code)).toBe('PERSISTENCE_FAILED');
    expect(db.db.writeFence.openTransactionOwner()).toBeNull();
    expect(stateOf(db)).toBe('ok');
    await db.events.append([eventOf('evt_r108')] as never);
    expect(independentCount(db.path, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_r108'")).toBe(1);
  });

  it('R1-09 a synchronous transaction is refused while an async owner holds the connection', async () => {
    const db = disposable();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.unitOfWork.transaction(async () => {
      await gate;
      return 'held';
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ownerDuring = db.db.writeFence.openTransactionOwner();
    expect(ownerDuring).not.toBeNull();
    let refusal: unknown = null;
    try {
      db.db.inTransaction(() => 'second owner');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).not.toBeNull();
    expect(String((refusal as { details?: Record<string, unknown> }).details?.['reason'])).toBe(
      'SYNC_TRANSACTION_OWNER_CONFLICT',
    );
    expect(db.db.writeFence.openTransactionOwner()).toBe(ownerDuring); // still ONE owner
    release();
    expect((await holder).ok).toBe(true);
  });

  it('R1-10/11 a closed connection refuses everything; an INDETERMINATE connection is never reused, a fresh one works from durable truth', async () => {
    // Closed.
    const closing = disposable();
    closing.close();
    expect(() => closing.db.inTransaction(() => 'x')).toThrow(/closed/);
    expect(() => closing.db.prepare('SELECT 1 AS one').get()).toThrow(/closed/);
    // Indeterminate is never revived; a NEW connection over the same file works.
    const db = disposable();
    const dir = createdDirs[createdDirs.length - 1] as string;
    const commitFailure = failNextExec(db, 'COMMIT');
    const rollbackFailure = failNextExec(db, 'ROLLBACK');
    try {
      db.db.inTransaction(() => 'never lands');
    } catch {
      // typed refusal
    }
    commitFailure();
    rollbackFailure();
    expect(stateOf(db)).toBe('indeterminate');
    expect(() => db.db.inTransaction(() => 'again')).toThrow(/indeterminate/);
    // The broken connection is DISCARDED (its residual transaction is unwound by SQLite at
    // close — uncommitted data is never presented as committed truth); recovery continues
    // through a NEW connection over the same durable file.
    db.close();
    openDatabases.splice(openDatabases.indexOf(db), 1);
    const reopened = openDurableDatabase({ dataDir: dir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
    openDatabases.push(reopened);
    expect(stateOf(reopened)).toBe('ok');
    await reopened.events.append([eventOf('evt_r111')] as never);
    expect(independentCount(reopened.path, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_r111'")).toBe(1);
  }, 60_000);
});

describe('N07-I1 / N07-A1 / N07-O1 — related connection safety', () => {
  it('N07-I1 every statement execution form obeys ownership: reads and RETURNING mutations are refused during a foreign transaction', async () => {
    const f = await composeF5();
    await seedRunAndTask(f);
    const db = f.core.database;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const foreign = db.unitOfWork.transaction(async () => {
      await gate;
      await db.events.append([eventOf('evt_i1_uncommitted')] as never);
      return 'held';
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.db.writeFence.openTransactionOwner()).not.toBeNull();
    // A raw READ on the shared connection must not observe the foreign uncommitted rows.
    const readAttempts: string[] = [];
    for (const read of [
      () => db.db.prepare('SELECT COUNT(*) AS n FROM events').get(),
      () => db.db.prepare('SELECT COUNT(*) AS n FROM events').all(),
      () => db.db.prepare("UPDATE events SET payload = '{}' WHERE event_id = 'nope' RETURNING event_id").all(),
    ]) {
      try {
        read();
        readAttempts.push('SUCCESS');
      } catch (error) {
        readAttempts.push(String((error as { details?: Record<string, unknown> }).details?.['reason'] ?? 'THREW'));
      }
    }
    expect(readAttempts).toEqual([
      'CROSS_CONTEXT_TRANSACTION_READ_REFUSED',
      'CROSS_CONTEXT_TRANSACTION_READ_REFUSED',
      'CROSS_CONTEXT_TRANSACTION_READ_REFUSED',
    ]);
    // The FENCED store read waits for legal access instead (and then reads committed truth).
    const reader = db.events.all();
    let settled = false;
    void reader.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    release();
    expect((await foreign).ok).toBe(true);
    const rows = await reader;
    expect(rows.some((row) => row.event.eventId === 'evt_i1_uncommitted')).toBe(true); // committed now
  }, 120_000);

  it('N07-A1 a STALE async context can neither read nor open a nested transaction after its unit ended', async () => {
    const db = disposable();
    let releaseChild = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let nestedResult: unknown = 'unsettled';
    let readResult: unknown = 'unsettled';
    const parent = db.unitOfWork.transaction(async () => {
      void (async () => {
        await gate;
        try {
          const nested = await db.unitOfWork.transaction(async () => 'stale nested');
          nestedResult = nested.ok ? 'JOINED' : String(nested.error.details['reason'] ?? nested.error.code);
        } catch (error) {
          nestedResult = String((error as { details?: Record<string, unknown> }).details?.['reason'] ?? 'THREW');
        }
        try {
          db.db.prepare('SELECT COUNT(*) AS n FROM events').get();
          readResult = 'SUCCESS';
        } catch (error) {
          readResult =
            error instanceof Error && error.message.includes('no longer owns')
              ? 'STALE_TRANSACTION_OWNER_REFUSED'
              : String((error as { details?: Record<string, unknown> }).details?.['reason'] ?? 'THREW');
        }
      })();
      return 'parent';
    });
    expect((await parent).ok).toBe(true);
    expect(db.db.writeFence.openTransactionOwner()).toBeNull();
    releaseChild();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(nestedResult).toBe('STALE_TRANSACTION_OWNER_REFUSED');
    expect(readResult).toBe('STALE_TRANSACTION_OWNER_REFUSED');
  });

  it('N07-O1 the immediate burst is linearized against TRANSACTIONS (never inside one) while keeping commit-at-arrival', async () => {
    const db = disposable();
    // (i) A held TRANSACTION: the burst WAITS — it can never execute inside (and be erased
    //     by) a foreign transaction, nor observe its uncommitted rows.
    let releaseTxn = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTxn = resolve;
    });
    const holder = db.unitOfWork.transaction(async () => {
      await gate;
      await db.events.append([eventOf('evt_o1_inside')] as never);
      return 'held';
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.db.writeFence.openTransactionOwner()).not.toBeNull();
    const deferred = db.events.append([eventOf('evt_o1_waiting')] as never);
    let deferredSettled = false;
    void deferred.then(() => {
      deferredSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deferredSettled).toBe(false); // linearized behind the transaction
    releaseTxn();
    expect((await holder).ok).toBe(true);
    await deferred;
    expect(
      independentCount(db.path, "SELECT COUNT(*) AS n FROM events WHERE event_id IN ('evt_o1_inside','evt_o1_waiting')"),
    ).toBe(2);
    // (ii) A non-transactional unit in flight: the burst proceeds immediately
    //      (commit-at-arrival). Sound because such a unit is a single-statement burst whose
    //      steps are individually durable — no transaction boundary exists to violate; every
    //      read-modify-write production path runs inside its OWN transaction (rule (i)).
    const order: string[] = [];
    let releaseMutation = (): void => undefined;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutation = db.db.writeFence.mutation('probe.nontransactional', async () => {
      order.push('mutation:step1');
      await db.events.append([eventOf('evt_o1_a')] as never);
      await mutationGate;
      order.push('mutation:step2');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const immediate = db.events.append([eventOf('evt_o1_c')] as never);
    await immediate; // resolves during the mutation's await: no transaction is open
    expect(independentCount(db.path, "SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_o1_c'")).toBe(1);
    releaseMutation();
    await mutation;
    expect(order).toEqual(['mutation:step1', 'mutation:step2']);
    expect(
      independentCount(db.path, "SELECT COUNT(*) AS n FROM events WHERE event_id IN ('evt_o1_a','evt_o1_c')"),
    ).toBe(2);
  });
});

/** The EXACT R1-04 fault: the next ROLLBACK (the loser's unwind) fails once. */
const failNextExecOnly = (db: DurableDatabase): () => void => {
  const raw = db.db.raw as unknown as { exec: (sql: string) => unknown };
  const real = raw.exec.bind(raw);
  let armed = true;
  raw.exec = (sql: string) => {
    if (armed && sql === 'ROLLBACK') {
      armed = false;
      throw Object.assign(new Error('injected ROLLBACK failure'), { code: 'SQLITE_IOERR' });
    }
    return real(sql);
  };
  return () => {
    raw.exec = real;
    armed = false;
  };
};
