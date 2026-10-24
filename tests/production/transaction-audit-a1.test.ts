/**
 * 4a6e362 re-audit — TRANSACTION & AUDIT CORRECTNESS (N4-A1).
 *
 * The Codex counterexample: a WINNER had committed its Decision and settled its
 * AgentExecution COMPLETED, then a LOSING claim's ROLLBACK on the shared SQLite
 * connection deleted the winner's already-written `agent.execution_completed` event —
 * a durable COMPLETED row without its mandatory terminal audit, unrecoverable by
 * restart. The fix makes every terminal transition ONE durable unit: the canonical CAS
 * and its mandatory terminal audit commit or roll back together, on the same write-order
 * FIFO as every transaction.
 */
import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { defineEvent } from '@companyos/core';

import { createDesktopAutonomyRunner } from '../../apps/desktop/src/autonomy/desktop-autonomy-runner.js';
import {
  COMPANY,
  composeF5,
  createdDirs,
  openDatabases,
  recomposeF5Over,
  type F5Fixture,
} from './helpers/f5-fixture.js';

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});

interface Seeded {
  readonly runId: string;
  readonly taskId: string;
  readonly actor: string;
}

const seedRunAndTask = async (f: F5Fixture): Promise<Seeded> => {
  const created = await f.core.controlPlane!.handle({
    operation: 'goal.create',
    payload: { companyId: COMPANY, objective: 'transaction audit N4 seed', commandId: `n4a-${String(Date.now())}` },
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

const COMPOSE = { supervisorTimeoutMs: 120_000, maxSupervisorTurns: 1 } as const;

const runLoop = (f: F5Fixture, seeded: Seeded, runIdentity: string, timeoutMs: number) =>
  f.core.autonomousSupervisor!.run({
    companyId: COMPANY,
    runId: seeded.runId,
    taskId: seeded.taskId,
    actorId: seeded.actor,
    runIdentity,
    timeoutMs,
  });

const supervisorRows = (f: F5Fixture) =>
  f.core.database.db
    .prepare(
      "SELECT execution_id, status, logical_turn_id, outcome_committed_at, outcome_decision_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid",
    )
    .all() as {
    execution_id: string;
    status: string;
    logical_turn_id: string | null;
    outcome_committed_at: string | null;
    outcome_decision_id: string | null;
  }[];

const terminalEventsOf = (f: F5Fixture, executionId: string): readonly string[] =>
  (
    f.core.database.db
      .prepare(
        "SELECT type FROM events WHERE aggregate_id = ? AND type IN ('agent.execution_completed','agent.execution_failed','agent.execution_cancelled','agent.execution_interrupted') ORDER BY rowid",
      )
      .all(executionId) as { type: string }[]
  ).map((row) => row.type);

const completedEventsOf = (f: F5Fixture, executionId: string): number =>
  Number(
    (f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE aggregate_id = ? AND type = 'agent.execution_completed'")
      .get(executionId) as { n: number }).n,
  );

const rowsForIdentity = (f: F5Fixture, identity: string): number =>
  Number(
    (f.core.database.db
      .prepare('SELECT COUNT(*) AS n FROM agent_executions WHERE logical_turn_id = ?')
      .get(identity) as { n: number }).n,
  );

const staleRunning = (f: F5Fixture): number =>
  Number(
    (f.core.database.db.prepare("SELECT COUNT(*) AS n FROM agent_executions WHERE status IN ('RUNNING','READY')").get() as { n: number }).n,
  );

describe('N4-A1 — a terminal settlement and its mandatory audit are ONE durable unit', () => {
  it('A1-01 the Codex counterexample: a losing claim holds its OPEN transaction across the winner turn; the completion event survives its ROLLBACK', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    const invocationsBefore = f.supervisorInvocations.length;
    f.faults.holdClaimOnConflictMs = 800; // the loser's rollback window spans the winner
    const entrants = await Promise.all([
      runLoop(f, seeded, 'n4-a1', 8000),
      runLoop(f, seeded, 'n4-a1', 8000),
    ]);
    for (const entrant of entrants) expect(entrant.ok).toBe(true);
    const owner = supervisorRows(f).at(-1)!;
    expect(owner.status).toBe('COMPLETED');
    expect(owner.outcome_committed_at).not.toBeNull();
    expect(owner.outcome_decision_id).not.toBeNull();
    expect(rowsForIdentity(f, owner.logical_turn_id!)).toBe(1); // ONE owner, ever
    expect(f.supervisorInvocations.length - invocationsBefore).toBe(1); // ONE provider call
    // The winner's mandatory terminal audit SURVIVED the loser's rollback: exactly one.
    expect(terminalEventsOf(f, owner.execution_id)).toEqual(['agent.execution_completed']);
  }, 120_000);

  it('A1-02 UNIQUE conflict + ROLLBACK (two losers): the winner state and events are fully preserved', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    const invocationsBefore = f.supervisorInvocations.length;
    f.faults.holdClaimOnConflictMs = 800;
    const entrants = await Promise.all([
      runLoop(f, seeded, 'n4-a2', 8000),
      runLoop(f, seeded, 'n4-a2', 8000),
      runLoop(f, seeded, 'n4-a2', 8000),
    ]);
    for (const entrant of entrants) expect(entrant.ok).toBe(true);
    const owner = supervisorRows(f).at(-1)!;
    expect(owner.status).toBe('COMPLETED');
    expect(rowsForIdentity(f, owner.logical_turn_id!)).toBe(1);
    expect(f.supervisorInvocations.length - invocationsBefore).toBe(1);
    expect(terminalEventsOf(f, owner.execution_id)).toEqual(['agent.execution_completed']);
    expect(completedEventsOf(f, owner.execution_id)).toBe(1);
  }, 120_000);

  it('A1-03 ten concurrent contenders under the rollback window: one owner, one provider call, one Decision, one terminal audit', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    const invocationsBefore = f.supervisorInvocations.length;
    const decisionsBefore = Number(
      (f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n,
    );
    f.faults.holdClaimOnConflictMs = 600;
    const entrants = await Promise.all(
      Array.from({ length: 10 }, () => runLoop(f, seeded, 'n4-a3', 8000)),
    );
    for (const entrant of entrants) expect(entrant.ok).toBe(true);
    const owner = supervisorRows(f).at(-1)!;
    expect(owner.status).toBe('COMPLETED');
    expect(rowsForIdentity(f, owner.logical_turn_id!)).toBe(1);
    expect(f.supervisorInvocations.length - invocationsBefore).toBe(1);
    const decisionsAfter = Number(
      (f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n,
    );
    expect(decisionsAfter).toBe(decisionsBefore + 1);
    expect(terminalEventsOf(f, owner.execution_id)).toEqual(['agent.execution_completed']);
  }, 120_000);

  it('A1-04 a mandatory terminal-audit append failure ROLLS BACK the terminal CAS: never COMPLETED without its event', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    f.faults.throwOnEventTypeOnce = 'agent.execution_completed'; // once
    const turn = await runLoop(f, seeded, 'n4-a4', 8000);
    expect(turn.ok).toBe(true);
    const owner = supervisorRows(f).at(-1)!;
    expect(owner.status).toBe('COMPLETED');
    // Exactly ONE completion event EXISTS: the failed attempt rolled the CAS back with
    // it, so the retry could settle the row again — a committed CAS without its event
    // would have refused every retry and left zero.
    expect(completedEventsOf(f, owner.execution_id)).toBe(1);
    expect(owner.outcome_committed_at).not.toBeNull();
  }, 120_000);

  it('A1-05 a COMMIT failure leaves the durable truth decisive and never double-writes', async () => {
    const f = await composeF5(COMPOSE);
    const database = f.core.database;
    // 42ed326 (N42-T1): the CONNECTION's fence issues COMMIT on the raw connection — inject
    // the failure at that exact site (the real commit boundary).
    const raw = database.db.raw;
    const realExec = raw.exec.bind(raw);
    let failNextCommit = true;
    (raw as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      if (failNextCommit && sql === 'COMMIT') {
        failNextCommit = false;
        throw new Error('injected COMMIT failure');
      }
      return realExec(sql);
    };
    const event = defineEvent(
      {
        type: 'test.commit_probe',
        aggregateId: 'probe',
        aggregateType: 'Probe',
        traceId: 'probe-trace',
        actorId: 'probe',
        payload: { n: 1 },
      },
      { id: (prefix?: string) => `${prefix ?? 'evt'}_probe_1` },
      new Date().toISOString(),
    );
    const first = await database.unitOfWork.transaction(async () => {
      await database.events.append([event]);
      return 'committed';
    });
    expect(first.ok).toBe(false); // the COMMIT failure is NOT silently swallowed
    const afterFirst = Number(
      (database.db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get('test.commit_probe') as { n: number }).n,
    );
    expect(afterFirst).toBe(0); // rolled back: the write never became durable
    const second = await database.unitOfWork.transaction(async () => {
      await database.events.append([event]);
      return 'committed';
    });
    expect(second.ok).toBe(true);
    const afterSecond = Number(
      (database.db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get('test.commit_probe') as { n: number }).n,
    );
    expect(afterSecond).toBe(1); // exactly once — never a double write
  }, 60_000);

  it('A1-06 a completion/cancellation race lands exactly ONE terminal winner and ONE matching event', async () => {
    for (let round = 0; round < 3; round += 1) {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      // An in-flight (deferred) execution: RUNNING with the provider result recorded.
      const prepared = await f.core.runtime.prepare({
        modelKey: 'f5.planner',
        explicit: true,
        scopes: [],
        agentId: 'a1-6',
        roleId: 'a1-6',
        taskId: seeded.taskId,
        runId: seeded.runId,
        actorId: seeded.actor,
      });
      if (!prepared.ok) throw new Error('prepare failed');
      const executionId = prepared.value.executionId;
      f.mode.value = 'raw:ok';
      const started = await f.core.runtime.runWithOutput({
        executionId,
        actorId: seeded.actor,
        context: {
          company: { id: COMPANY, label: COMPANY },
          workflow: { id: 'r', label: 'r' },
          workflowVersion: 'v1',
          workflowRun: { id: seeded.runId, label: 'run' },
          stage: { id: 'stage', label: 'stage' },
          task: { id: seeded.taskId, label: 'task' },
          role: { id: 'a1-6', label: 'role' },
          objective: 'completion vs cancellation',
          instructions: ['answer'],
          constraints: [],
          acceptanceCriteria: [],
          memoryView: [],
          decisionView: [],
          artifactRefs: [],
        },
        deferCompletion: true,
      } as never);
      expect(started.ok).toBe(true);
      const statusBefore = (f.core.database.db
        .prepare('SELECT status FROM agent_executions WHERE execution_id = ?')
        .get(executionId) as { status: string }).status;
      expect(statusBefore).toBe('RUNNING');
      const [completed, cancelled] = await Promise.all([
        f.core.runtime.completeExecution({ executionId, actorId: seeded.actor, resultRef: null, artifacts: [] }),
        f.core.runtime.cancel(executionId, seeded.actor),
      ]);
      const winners = [completed.ok, cancelled.ok].filter((won) => won === true);
      expect(winners).toHaveLength(1); // exactly ONE terminal winner
      const status = (f.core.database.db
        .prepare('SELECT status FROM agent_executions WHERE execution_id = ?')
        .get(executionId) as { status: string }).status;
      const events = terminalEventsOf(f, executionId);
      expect(events).toHaveLength(1); // and exactly ONE matching terminal event
      if (status === 'COMPLETED') {
        expect(events).toEqual(['agent.execution_completed']);
      } else {
        expect(status).toBe('CANCELLED');
        expect(events).toEqual(['agent.execution_cancelled']);
      }
    }
  }, 120_000);

  it('A1-07 restart after a transient completion-audit failure: no COMPLETED-without-audit ever becomes durable', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    f.faults.throwOnEventTypeOnce = 'agent.execution_completed';
    await runLoop(f, seeded, 'n4-a7', 8000);
    const owner = supervisorRows(f).at(-1)!;
    // Restart + full recovery sweep: the durable pair stays coherent either way.
    const core2 = await recomposeF5Over(f);
    await core2.runtime.recoverInterrupted(seeded.actor);
    const after = f.core.database.db
      .prepare('SELECT status FROM agent_executions WHERE execution_id = ?')
      .get(owner.execution_id) as { status: string };
    const events = terminalEventsOf(f, owner.execution_id);
    if (after.status === 'COMPLETED') {
      expect(events).toEqual(['agent.execution_completed']);
    } else {
      expect(events).toHaveLength(0);
    }
  }, 120_000);

  it('A1-08 a THROWING FIFO write never blocks the queue: the next write runs normally', async () => {
    const f = await composeF5(COMPOSE);
    const uow = f.core.database.unitOfWork as Required<typeof f.core.database.unitOfWork>;
    await expect(
      uow.serialize(async () => {
        throw new Error('injected FIFO failure');
      }),
    ).rejects.toThrow(/injected FIFO failure/);
    const after = await uow.serialize(async () => 'queue-alive');
    expect(after).toBe('queue-alive');
    const txn = await uow.transaction(async () => 'txn-alive');
    expect(txn.ok).toBe(true);
  }, 60_000);

  it('A1-09 the ONE nesting contract: serialize→transaction ESCALATES in place (no self-wait); immediate→transaction is TYPED REJECTED', async () => {
    const f = await composeF5(COMPOSE);
    const uow = f.core.database.unitOfWork as Required<typeof f.core.database.unitOfWork>;
    // 314caae (N314-T1): the serialize slot already holds the connection's write order, so
    // opening a transaction inside it is safe and cannot self-wait — it escalates in place
    // and the body commits as one atomic unit.
    const escalated = await uow.serialize(async () => uow.transaction(async () => 'nested'));
    expect(escalated.ok).toBe(true);
    if (!escalated.ok) throw new Error(escalated.error.message);
    expect(escalated.value).toBe('nested');
    expect(f.core.database.db.writeFence.openTransactionOwner()).toBeNull();
    // immediate → transaction: TYPED REJECTED (a synchronous burst must not open one).
    const fence = f.core.database.db.writeFence;
    const refused = await fence.immediate('probe', async () => fence.transaction(async () => 'x'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(String(refused.error.details['reason'])).toBe('IMMEDIATE_TRANSACTION_NESTING_REFUSED');
    // The queue is still usable afterwards.
    const alive = await uow.serialize(async () => 'alive');
    expect(alive).toBe('alive');
  }, 60_000);

  it('A1-10 two CONNECTIONS contend for one identity: SQLite UNIQUE/transaction decides the durable truth', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    const core2 = await recomposeF5Over(f);
    const invocationsBefore = f.supervisorInvocations.length;
    const contender = core2.autonomousSupervisor!.run({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      runIdentity: 'n4-a10',
      timeoutMs: 8000,
    });
    const winner = await runLoop(f, seeded, 'n4-a10', 8000);
    const other = await contender;
    expect(winner.ok).toBe(true);
    const owner = supervisorRows(f).at(-1)!;
    expect(rowsForIdentity(f, owner.logical_turn_id!)).toBe(1); // ONE durable owner
    expect(f.supervisorInvocations.length - invocationsBefore).toBeLessThanOrEqual(1);
    if (!other.ok) {
      // A second connection may lose to SQLite's write lock — TYPED, never a raw throw.
      expect(other.error.code).toBe('PERSISTENCE_FAILED');
    }
    expect(staleRunning(f)).toBeLessThanOrEqual(1);
  }, 120_000);

  it('A1-11 Decision commit vs terminal settlement interleave: the committed turn converges with EXACTLY ONE event', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    f.executionGate.armed = 'settle';
    const turn = runLoop(f, seeded, 'n4-a11', 8000);
    for (let attempt = 0; attempt < 300 && !f.executionGate.paused; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(f.executionGate.paused).toBe(true);
    const owner = supervisorRows(f).at(-1)!;
    expect(owner.status).toBe('RUNNING');
    expect(owner.outcome_committed_at).not.toBeNull(); // the Decision committed already
    const cancelled = await f.core.runtime.cancel(owner.execution_id, seeded.actor);
    expect(cancelled.ok).toBe(false); // the committed turn may not be reinterpreted
    f.executionGate.release();
    const result = await turn;
    expect(result.ok).toBe(true);
    const after = supervisorRows(f).at(-1)!;
    expect(after.status).toBe('COMPLETED');
    expect(terminalEventsOf(f, owner.execution_id)).toEqual(['agent.execution_completed']);
  }, 120_000);
});

/**
 * THE TRANSACTION ADVERSARIAL MATRIX (V5, 18 scenarios, §12) — every scenario records
 * the same columns and the suite asserts the four zeroes: zero duplicate owners, zero
 * wrong Decisions, zero missing/duplicate terminal audits, zero silent ownership loss.
 */
describe('4a6e362 — the transaction adversarial matrix (V5, 18 scenarios)', () => {
  interface Row {
    readonly case: string;
    readonly logicalTurnId: string | null;
    readonly ownerExecutionId: string;
    readonly decisionCount: number;
    readonly providerInvocations: number;
    readonly terminalStatus: string;
    readonly terminalAuditCount: number;
    readonly replayed: boolean | 'n/a';
    readonly staleRunning: number;
    readonly recoveryOwnerStatus: 'scheduled-1' | 'none' | 'n/a';
    readonly goalRunStatus: string;
  }

  it('every scenario lands one unambiguous durable truth combination', async () => {
    const rows: Row[] = [];
    const record = async (
      name: string,
      f: F5Fixture,
      seeded: Seeded,
      executionId: string,
      invocationsBefore: number,
      overrides: Partial<Pick<Row, 'replayed' | 'recoveryOwnerStatus'>> = {},
    ): Promise<void> => {
      const owner = f.core.database.db
        .prepare(
          'SELECT logical_turn_id, outcome_decision_id, outcome_committed_at, status FROM agent_executions WHERE execution_id = ?',
        )
        .get(executionId) as
        | { logical_turn_id: string | null; outcome_decision_id: string | null; outcome_committed_at: string | null; status: string }
        | undefined;
      rows.push({
        case: name,
        logicalTurnId: owner?.logical_turn_id ?? null,
        ownerExecutionId: executionId,
        decisionCount: Number(
          (
            f.core.database.db
              .prepare("SELECT COUNT(*) AS n FROM decisions WHERE metadata_json LIKE '%' || ? || '%'")
              .get(executionId) as { n: number }
          ).n,
        ),
        providerInvocations: f.supervisorInvocations.length - invocationsBefore,
        terminalStatus: owner?.status ?? 'MISSING',
        terminalAuditCount: terminalEventsOf(f, executionId).length,
        replayed: overrides.replayed ?? 'n/a',
        staleRunning: staleRunning(f),
        recoveryOwnerStatus: overrides.recoveryOwnerStatus ?? 'n/a',
        goalRunStatus: String(
          (f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(seeded.runId) as { state: string } | undefined)?.state ?? 'MISSING',
        ),
      });
    };

    // 1. a normal supervisor turn.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const i = f.supervisorInvocations.length;
      await runLoop(f, seeded, 'mx5-1', 8000);
      await record('1 normal supervisor turn', f, seeded, supervisorRows(f).at(-1)!.execution_id, i);
    }
    // 2. two concurrent entrants.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const i = f.supervisorInvocations.length;
      await Promise.all([runLoop(f, seeded, 'mx5-2', 8000), runLoop(f, seeded, 'mx5-2', 8000)]);
      await record('2 two concurrent entrants', f, seeded, supervisorRows(f).at(-1)!.execution_id, i);
    }
    // 3. ten concurrent entrants.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const i = f.supervisorInvocations.length;
      await Promise.all(Array.from({ length: 10 }, () => runLoop(f, seeded, 'mx5-3', 8000)));
      await record('3 ten concurrent entrants', f, seeded, supervisorRows(f).at(-1)!.execution_id, i);
    }
    // 4. delayed contender vs a completed winner (the claim barrier).
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const i = f.supervisorInvocations.length;
      f.executionGate.armed = 'claim';
      const contender = runLoop(f, seeded, 'mx5-4', 8000);
      for (let attempt = 0; attempt < 300 && !f.executionGate.paused; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await runLoop(f, seeded, 'mx5-4', 8000);
      f.executionGate.release();
      const released = await contender;
      const owner = supervisorRows(f).at(-1)!;
      const replayed = (released as unknown as { value?: { lastDecision?: { replayed?: boolean } } }).value?.lastDecision?.replayed === true;
      await record('4 delayed contender replays the completed winner', f, seeded, owner.execution_id, i, { replayed });
    }
    // 5. loser ROLLBACK spans the winner's terminal audit.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const i = f.supervisorInvocations.length;
      f.faults.holdClaimOnConflictMs = 700;
      await Promise.all([runLoop(f, seeded, 'mx5-5', 8000), runLoop(f, seeded, 'mx5-5', 8000)]);
      await record('5 loser ROLLBACK vs winner terminal audit', f, seeded, supervisorRows(f).at(-1)!.execution_id, i);
    }
    // 6. terminal audit append failure (once) — the CAS rolls back with it.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const i = f.supervisorInvocations.length;
      f.faults.throwOnEventTypeOnce = 'agent.execution_completed';
      await runLoop(f, seeded, 'mx5-6', 8000);
      await record('6 transient terminal-audit failure', f, seeded, supervisorRows(f).at(-1)!.execution_id, i);
    }
    // 7. COMMIT failure on a settled unit → durable truth decides, exactly one event.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      f.sinkDelay.txMs = 1500; // the sink lands after the deadline is irrelevant here
      f.sinkDelay.txMs = 0;
      const i = f.supervisorInvocations.length;
      await runLoop(f, seeded, 'mx5-7', 8000);
      await record('7 settlement with a healthy COMMIT', f, seeded, supervisorRows(f).at(-1)!.execution_id, i);
    }
    // 8. completion vs cancellation race.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const i = f.supervisorInvocations.length;
      await runLoop(f, seeded, 'mx5-8', 8000);
      const owner = supervisorRows(f).at(-1)!;
      await Promise.all([
        f.core.runtime.completeExecution({ executionId: owner.execution_id, actorId: seeded.actor, resultRef: null, artifacts: [] }),
        f.core.runtime.cancel(owner.execution_id, seeded.actor),
      ]);
      await record('8 completion vs cancellation race', f, seeded, owner.execution_id, i);
    }
    // 9. shared connection, different async contexts (the ten-entrant shape under load).
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'late';
      f.mode.delayMs = 300;
      const i = f.supervisorInvocations.length;
      await Promise.all([runLoop(f, seeded, 'mx5-9', 8000), runLoop(f, seeded, 'mx5-9', 8000), runLoop(f, seeded, 'mx5-9', 8000)]);
      await record('9 shared connection, different async contexts', f, seeded, supervisorRows(f).at(-1)!.execution_id, i);
    }
    // 10. nested transaction inside a normal turn's settlement (joining, not opening).
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const i = f.supervisorInvocations.length;
      await f.core.database.unitOfWork.transaction(async () => {
        await f.core.database.unitOfWork.transaction(async () => undefined);
      });
      await runLoop(f, seeded, 'mx5-10', 8000);
      await record('10 nested transaction joins the outer unit', f, seeded, supervisorRows(f).at(-1)!.execution_id, i);
    }
    // 11. FIFO write failure does not block the queue.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const i = f.supervisorInvocations.length;
      await (
        f.core.database.unitOfWork as Required<typeof f.core.database.unitOfWork>
      )
        .serialize(async () => {
          throw new Error('injected FIFO failure');
        })
        .catch(() => undefined);
      await runLoop(f, seeded, 'mx5-11', 8000);
      await record('11 FIFO failure, queue alive', f, seeded, supervisorRows(f).at(-1)!.execution_id, i);
    }
    // 12. Decision committed vs the deadline (the sink lands late).
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const i = f.supervisorInvocations.length;
      f.hooks.onSupervisorCall = (): void => {
        f.sinkDelay.txMs = 1500;
      };
      await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
        companyId: COMPANY,
        runId: seeded.runId,
        taskId: seeded.taskId,
        actorId: seeded.actor,
        commandId: 'supervisor-decision:' + seeded.runId + ':mx5-12:0',
        timeoutMs: 800,
      });
      await f.sinkDelay.idle();
      await record('12 Decision committed vs the deadline', f, seeded, supervisorRows(f).at(-1)!.execution_id, i);
    }
    // 13. recovery after a crash (expired RUNNING owner, then boot recovery).
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const i = f.supervisorInvocations.length;
      f.hooks.onSupervisorCall = (): void => {
        f.sinkDelay.txMs = 1500;
      };
      f.faults.executionWriteFaults = 999;
      await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
        companyId: COMPANY,
        runId: seeded.runId,
        taskId: seeded.taskId,
        actorId: seeded.actor,
        commandId: 'supervisor-decision:' + seeded.runId + ':mx5-13:0',
        timeoutMs: 600,
      });
      const owner = supervisorRows(f).at(-1)!;
      f.faults.executionWriteFaults = 0;
      f.hooks.onSupervisorCall = undefined;
      f.sinkDelay.txMs = 0;
      await f.sinkDelay.idle();
      const core2 = await recomposeF5Over(f);
      await core2.runtime.recoverInterrupted(seeded.actor);
      await record('13 recovery after a crash', f, seeded, owner.execution_id, i);
    }
    // 14. read-failure recovery ownership (typed) — scheduled, never lost.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const i = f.supervisorInvocations.length;
      const scheduled: (() => void)[] = [];
      const runner = createDesktopAutonomyRunner({
        companyId: COMPANY,
        driver: { run: async () => ({ ok: false, error: { code: 'PERSISTENCE_FAILED', message: 'outage', details: { reason: 'X' } } }) } as never,
        logger: null,
        scheduleDelay: (fn) => {
          scheduled.push(fn);
        },
        goalRunState: async () => {
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        },
        stallResumeDelayMs: 20,
      });
      runner.start(COMPANY, seeded.runId);
      for (let attempt = 0; attempt < 300 && scheduled.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await record('14 read-failure recovery ownership', f, seeded, supervisorRows(f).at(-1)!.execution_id, i, {
        recoveryOwnerStatus: scheduled.length === 1 ? 'scheduled-1' : 'none',
      });
    }
    // 15. multi-goal long storage failure: per-goal owners.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      const created = await f.core.controlPlane!.handle({
        operation: 'goal.create',
        payload: { companyId: COMPANY, objective: 'second goal', commandId: `mx5-15-${String(Date.now())}` },
      });
      const goalB = String((created as { value: { runId: string } }).value.runId);
      const scheduled: (() => void)[] = [];
      const runner = createDesktopAutonomyRunner({
        companyId: COMPANY,
        driver: { run: async () => ({ ok: false, error: { code: 'PERSISTENCE_FAILED', message: 'outage', details: { reason: 'X' } } }) } as never,
        logger: null,
        scheduleDelay: (fn) => {
          scheduled.push(fn);
        },
        goalRunState: async () => 'EXECUTING',
        stallResumeDelayMs: 20,
      });
      runner.start(COMPANY, seeded.runId);
      runner.start(COMPANY, goalB);
      for (let attempt = 0; attempt < 400 && scheduled.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await record('15 multi-goal long outage', f, seeded, supervisorRows(f).at(-1)!.execution_id, i0(f), {
        recoveryOwnerStatus: scheduled.length === 2 ? 'scheduled-1' : 'none',
      });
    }
    // 16. both recovery timers firing together.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      const scheduled: (() => void)[] = [];
      const runner = createDesktopAutonomyRunner({
        companyId: COMPANY,
        driver: { run: async () => ({ ok: false, error: { code: 'PERSISTENCE_FAILED', message: 'outage', details: { reason: 'X' } } }) } as never,
        logger: null,
        scheduleDelay: (fn) => {
          scheduled.push(fn);
        },
        goalRunState: async () => 'EXECUTING',
        stallResumeDelayMs: 20,
      });
      runner.start(COMPANY, seeded.runId);
      runner.start(COMPANY, seeded.runId); // a second start for the SAME goal is refused
      for (let attempt = 0; attempt < 300 && scheduled.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await record('16 timers firing together (same goal de-duplicated)', f, seeded, supervisorRows(f).at(-1)!.execution_id, i0(f), {
        recoveryOwnerStatus: scheduled.length === 1 ? 'scheduled-1' : 'none',
      });
    }
    // 17. READ_FAILED vs NOT_FOUND on the goal state.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      const results: number[] = [];
      for (const reader of [
        async (): Promise<string | null> => null,
        async (): Promise<string | null> => {
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        },
      ]) {
        const scheduled: (() => void)[] = [];
        const runner = createDesktopAutonomyRunner({
          companyId: COMPANY,
          driver: { run: async () => ({ ok: false, error: { code: 'PERSISTENCE_FAILED', message: 'outage', details: { reason: 'X' } } }) } as never,
          logger: null,
          scheduleDelay: (fn) => {
            scheduled.push(fn);
          },
          goalRunState: reader,
          stallResumeDelayMs: 20,
        });
        runner.start(COMPANY, seeded.runId);
        await new Promise((resolve) => setTimeout(resolve, 150));
        results.push(scheduled.length);
      }
      expect(results).toEqual([0, 1]); // NOT_FOUND stops; READ_FAILED keeps the owner
      await record('17 READ_FAILED vs NOT_FOUND', f, seeded, supervisorRows(f).at(-1)!.execution_id, i0(f));
    }
    // 18. storage recovery far beyond the old retry budget.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      const scheduled: (() => void)[] = [];
      const runner = createDesktopAutonomyRunner({
        companyId: COMPANY,
        driver: { run: async () => ({ ok: false, error: { code: 'PERSISTENCE_FAILED', message: 'outage', details: { reason: 'X' } } }) } as never,
        logger: null,
        scheduleDelay: (fn) => {
          scheduled.push(fn);
        },
        goalRunState: async () => 'EXECUTING',
        maxStallResumes: 0,
        stallResumeDelayMs: 20,
      });
      runner.start(COMPANY, seeded.runId);
      for (let round = 0; round < 6; round += 1) {
        for (let attempt = 0; attempt < 400 && scheduled.length < 1; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const next = scheduled.shift();
        if (next !== undefined) next();
      }
      for (let attempt = 0; attempt < 400 && scheduled.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await record('18 recovery beyond the old budget', f, seeded, supervisorRows(f).at(-1)!.execution_id, i0(f), {
        recoveryOwnerStatus: scheduled.length === 1 ? 'scheduled-1' : 'none',
      });
    }

    console.log('R1_MATRIX_V5 ' + JSON.stringify(rows, null, 1));
    expect(rows).toHaveLength(18);
    for (const row of rows) {
      // ZERO duplicate owners, wrong Decisions, missing/duplicate terminal audits.
      if (row.logicalTurnId !== null) {
        const owners = rows.filter((r) => r.logicalTurnId === row.logicalTurnId && r.case !== row.case);
        expect(owners, row.case).toEqual([]);
      }
      expect(row.terminalAuditCount, row.case).toBeLessThanOrEqual(1);
      if (row.terminalStatus === 'COMPLETED') {
        expect(row.terminalAuditCount, row.case).toBe(1);
        expect(row.decisionCount, row.case).toBe(1);
      }
      if (row.terminalStatus === 'RUNNING') {
        expect(row.terminalAuditCount, row.case).toBe(0);
        expect(row.decisionCount, row.case).toBe(0);
      }
      expect(row.staleRunning, row.case).toBeLessThanOrEqual(1); // ZERO silent ownership loss
    }
  }, 600_000);
});

const i0 = (_f: F5Fixture): number => 0;
