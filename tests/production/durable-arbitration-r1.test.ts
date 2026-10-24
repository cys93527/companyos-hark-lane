/**
 * POST-CODEX 40d7892 re-audit — the DURABLE ARBITRATION closures (F5-D-R1 / F5-C-R1 / F5-B-R1).
 *
 * F5-D-R1 — terminal execution can be revived by a startup/start persist: the
 *   READY→RUNNING write used a generic UPSERT, so a cancellation that landed between
 *   the load and the write was overwritten back to RUNNING (and later COMPLETED, with
 *   BOTH terminal events). Fixed at the LOWEST durable owner: creation and start are
 *   CONDITIONAL single statements (`createIfAbsent` / `startIfPreTerminal` … WHERE the
 *   row's CURRENT status is in the legal pre-terminal set) — terminal → RUNNING is now
 *   impossible at the storage level.
 *
 * F5-C-R1 — Decision commit and terminal execution must share ONE winner: the sink's
 *   transaction now STAMPS the owning row's durable `outcome_committed_at` marker (the
 *   commit-authority check IS the write), and the settlement arbiter refuses any
 *   failure/cancel/timeout reinterpretation of a committed row — it converges to the
 *   committed COMPLETED state instead; recovery finishes a committed row as COMPLETED.
 *
 * F5-B-R1 — a settlement write failure could return while the durable execution stayed
 *   RUNNING (and the late sink could still commit): the turn now settles within a
 *   BOUNDED operation (each attempt re-reads durable truth through the canonical
 *   arbiter); beyond the bound it returns a TYPED settlement/persistence failure — never
 *   a fabricated timeout/cancel result — with documented recovery ownership.
 */
import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { domainError, err, normalizeExecutionError, ok } from '@companyos/core';

import { createDesktopAutonomyRunner } from '../../apps/desktop/src/autonomy/desktop-autonomy-runner.js';
import { createGoalOutcomeAutonomyDriver } from '../../apps/desktop/src/autonomy/goal-outcome-autonomy-driver.js';
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
    payload: { companyId: COMPANY, objective: 'durable arbitration R1 seed', commandId: `r1-${String(Date.now())}` },
  });
  if (!created.ok) throw new Error('goal.create failed: ' + JSON.stringify(created.error));
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

const prepareExecution = async (f: F5Fixture, seeded: Seeded): Promise<string> => {
  const prepared = await f.core.runtime.prepare({
    modelKey: 'f5.planner',
    explicit: true,
    scopes: [],
    agentId: 'r1-arbitration',
    roleId: 'r1-arbitration',
    taskId: seeded.taskId,
    runId: seeded.runId,
    actorId: seeded.actor,
  });
  if (!prepared.ok) throw new Error('prepare failed: ' + prepared.error.message);
  return prepared.value.executionId;
};

interface TurnResult {
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly details: Record<string, unknown> };
}

const startInvocation = (f: F5Fixture, seeded: Seeded, executionId: string): Promise<TurnResult> =>
  f.core.runtime
    .runWithOutput({
      executionId,
      actorId: seeded.actor,
      context: {
        company: { id: COMPANY, label: COMPANY },
        workflow: { id: 'r1', label: 'r1' },
        workflowVersion: 'v1',
        workflowRun: { id: seeded.runId, label: 'run' },
        stage: { id: 'stage', label: 'stage' },
        task: { id: seeded.taskId, label: 'task' },
        role: { id: 'r1-arbitration', label: 'role' },
        objective: 'r1 arbitration',
        instructions: ['answer'],
        constraints: [],
        acceptanceCriteria: [],
        memoryView: [],
        decisionView: [],
        artifactRefs: [],
      },
      deferCompletion: true,
    } as never)
    .then(
      (value) => value as TurnResult,
      (error: unknown) => ({ ok: false, error: { code: 'THREW', details: { cause: String(error) } } }),
    );

const statusOf = (f: F5Fixture, executionId: string): string =>
  String(
    (
      f.core.database.db
        .prepare('SELECT status FROM agent_executions WHERE execution_id = ?')
        .get(executionId) as { status: string } | undefined
    )?.status ?? 'MISSING',
  );

const markerOf = (f: F5Fixture, executionId: string): string | null =>
  (f.core.database.db
    .prepare('SELECT outcome_committed_at FROM agent_executions WHERE execution_id = ?')
    .get(executionId) as { outcome_committed_at: string | null } | undefined)?.outcome_committed_at ?? null;

const terminalEventsOf = (f: F5Fixture, executionId: string): readonly string[] =>
  (
    f.core.database.db
      .prepare(
        "SELECT type FROM events WHERE aggregate_id = ? AND type IN ('agent.execution_completed','agent.execution_failed','agent.execution_cancelled','agent.execution_interrupted') ORDER BY rowid",
      )
      .all(executionId) as { type: string }[]
  ).map((row) => row.type);

const decisionCount = (f: F5Fixture): number =>
  Number((f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n);

const runningCount = (f: F5Fixture): number =>
  Number(
    (f.core.database.db.prepare("SELECT COUNT(*) AS n FROM agent_executions WHERE status = 'RUNNING'").get() as { n: number }).n,
  );

const waitFor = async (predicate: () => boolean, label: string, attempts = 200): Promise<void> => {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition never held: ${label}`);
};

const driveTurn = async (
  f: F5Fixture,
  seeded: Seeded,
  runIdentity: string,
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly stopReason: string }> => {
  const result = await f.core.autonomousSupervisor!.run({
    companyId: COMPANY,
    runId: seeded.runId,
    taskId: seeded.taskId,
    actorId: seeded.actor,
    runIdentity,
    timeoutMs,
  });
  return { ok: result.ok, stopReason: String(result.ok ? result.value.stopReason : result.error.code) };
};

const COMPOSE = { supervisorTimeoutMs: 120_000, maxSupervisorTurns: 1 } as const;

describe('POST-CODEX R1 — F5-D-R1: terminal executions can never be revived by a start persist', () => {
  it('D-R1-01/02 a cancellation landing between the load and the READY→RUNNING write is never revived; a later completion loses (one terminal event)', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'raw:ok';
    const executionId = await prepareExecution(f, seeded);
    expect(statusOf(f, executionId)).toBe('READY');
    // Pause the NEXT start write BEFORE its SQL — the exact Codex window.
    const invocationsBefore = f.rawInvocations.n;
    f.executionGate.armed = 'start';
    const turn = startInvocation(f, seeded, executionId);
    await waitFor(() => f.executionGate.paused, 'the start write is paused');
    // The cancellation lands durably in that window.
    const cancelled = await f.core.runtime.cancel(executionId, seeded.actor);
    expect(cancelled.ok).toBe(true);
    expect(statusOf(f, executionId)).toBe('CANCELLED');
    f.executionGate.release();
    const settledTurn = await turn;
    // The start write was refused by durable truth: typed, no provider call, no revival.
    expect(settledTurn.ok).toBe(false);
    expect(f.rawInvocations.n).toBe(invocationsBefore);
    expect(statusOf(f, executionId)).toBe('CANCELLED');
    // D-R1-02: a later completion attempt still loses to the cancellation.
    const late = await f.core.runtime.completeExecution({
      executionId,
      actorId: seeded.actor,
      resultRef: null,
      artifacts: [],
    });
    expect(late.ok).toBe(false);
    expect(statusOf(f, executionId)).toBe('CANCELLED');
    expect(terminalEventsOf(f, executionId)).toEqual(['agent.execution_cancelled']);
  }, 60_000);

  it('D-R1-03/04 the same window against pre-existing FAILED and COMPLETED rows: refused, never revived', async () => {
    // (a) FAILED: the row reaches its terminal kind INSIDE the paused start window.
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'raw:ok';
    const executionId = await prepareExecution(f, seeded);
    const invocationsBefore = f.rawInvocations.n;
    f.executionGate.armed = 'start';
    const turn = startInvocation(f, seeded, executionId);
    await waitFor(() => f.executionGate.paused, 'start paused (FAILED)');
    void (await f.core.runtime.failExecution({
      executionId,
      actorId: seeded.actor,
      error: normalizeExecutionError({ kind: 'PROVIDER_UNAVAILABLE', message: 'pre-settled failure' }),
    }));
    expect(statusOf(f, executionId)).toBe('FAILED');
    f.executionGate.release();
    const settledTurn = await turn;
    expect(settledTurn.ok).toBe(false);
    expect(f.rawInvocations.n).toBe(invocationsBefore);
    expect(statusOf(f, executionId)).toBe('FAILED');
    expect(terminalEventsOf(f, executionId)).toEqual(['agent.execution_failed']);

    // (b) COMPLETED: reached canonically (RUNNING → COMPLETED), then a stale RUNNING
    // start write is attempted at BOTH owners — the store refuses it at the storage
    // level and the runtime refuses to even start against a terminal row.
    const f2 = await composeF5(COMPOSE);
    const seeded2 = await seedRunAndTask(f2);
    f2.mode.value = 'raw:hang';
    const executionId2 = await prepareExecution(f2, seeded2);
    const pending2 = startInvocation(f2, seeded2, executionId2);
    await waitFor(() => statusOf(f2, executionId2) === 'RUNNING', 'running');
    const completed = await f2.core.runtime.completeExecution({
      executionId: executionId2,
      actorId: seeded2.actor,
      resultRef: null,
      artifacts: [],
    });
    expect(completed.ok).toBe(true);
    expect(statusOf(f2, executionId2)).toBe('COMPLETED');
    // The stale in-memory RUNNING object (the exact revival shape) against durable truth:
    const stale = (await f2.core.database.agentExecutions.get(executionId2))!;
    const revived = await f2.core.database.agentExecutions.startIfPreTerminal({
      ...stale,
      status: 'RUNNING',
    });
    expect(revived).toBe(false); // terminal → RUNNING is impossible at the storage level
    expect(statusOf(f2, executionId2)).toBe('COMPLETED');
    expect(terminalEventsOf(f2, executionId2)).toEqual(['agent.execution_completed']);
    // And the runtime refuses a fresh start against the terminal row before any write.
    const refused = await startInvocation(f2, seeded2, executionId2);
    expect(refused.ok).toBe(false);
    const invocationsAfterRefusal = f2.rawInvocations.n;
    void invocationsAfterRefusal;
    expect(statusOf(f2, executionId2)).toBe('COMPLETED');
    void pending2;  }, 120_000);

  it('D-R1-05 recovery and a late start/settlement race to exactly one canonical state, no resurrection', async () => {
    // (a) The startup recovery pass leaves a terminal row untouched while a paused
    // start write is released into it.
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'raw:ok';
    const executionId = await prepareExecution(f, seeded);
    f.executionGate.armed = 'start';
    const turn = startInvocation(f, seeded, executionId);
    await waitFor(() => f.executionGate.paused, 'start paused');
    await f.core.runtime.cancel(executionId, seeded.actor);
    const recoveryPass = await f.core.runtime.recoverInterrupted(seeded.actor);
    expect(recoveryPass.ok).toBe(true);
    f.executionGate.release();
    await turn;
    expect(statusOf(f, executionId)).toBe('CANCELLED');
    expect(terminalEventsOf(f, executionId)).toEqual(['agent.execution_cancelled']);

    // (b) A RUNNING row recovered to INTERRUPTED cannot be completed later:
    // recovery owns the settlement, the late winner loses.
    const f2 = await composeF5(COMPOSE);
    const seeded2 = await seedRunAndTask(f2);
    f2.mode.value = 'raw:hang';
    const executionId2 = await prepareExecution(f2, seeded2);
    const pending2 = startInvocation(f2, seeded2, executionId2);
    await waitFor(() => statusOf(f2, executionId2) === 'RUNNING', 'running');
    const recovered = await f2.core.runtime.recoverInterrupted(seeded2.actor);
    expect(recovered.ok).toBe(true);
    expect(statusOf(f2, executionId2)).toBe('INTERRUPTED');
    const lateSuccess = await f2.core.runtime.completeExecution({
      executionId: executionId2,
      actorId: seeded2.actor,
      resultRef: null,
      artifacts: [],
    });
    expect(lateSuccess.ok).toBe(false);
    expect(statusOf(f2, executionId2)).toBe('INTERRUPTED');
    expect(terminalEventsOf(f2, executionId2)).toEqual(['agent.execution_interrupted']);
    void pending2;
  }, 60_000);
});

describe('POST-CODEX R1 — F5-C-R1: Decision commit and terminal settlement share one winner', () => {
  it('C-R1-01 a cancellation after the commit is refused typed; the turn converges to COMPLETED', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    // Pause the turn's completion write AFTER the Decision (and its durable marker) committed.
    f.executionGate.armed = 'settle';
    const turn = driveTurn(f, seeded, 'r1-c1', 8000);
    await waitFor(() => f.executionGate.paused, 'settle paused');
    const execution = f.core.database.db
      .prepare("SELECT execution_id, status, outcome_committed_at FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
      .get() as { execution_id: string; status: string; outcome_committed_at: string | null };
    expect(execution.status).toBe('RUNNING');
    expect(execution.outcome_committed_at).not.toBeNull();
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    // The generic cancellation may not reinterpret the committed turn.
    const cancelled = await f.core.runtime.cancel(execution.execution_id, seeded.actor);
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) throw new Error('cancel unexpectedly won');
    expect(String(cancelled.error.details['reason'])).toBe('EXECUTION_OUTCOME_COMMITTED');
    expect(statusOf(f, execution.execution_id)).toBe('RUNNING');
    f.executionGate.release();
    const settled = await turn;
    expect(settled.ok).toBe(true);
    expect(statusOf(f, execution.execution_id)).toBe('COMPLETED');
    expect(terminalEventsOf(f, execution.execution_id)).toEqual(['agent.execution_completed']);
  }, 60_000);

  it('C-R1-02 a transient completion-write failure converges to the COMMITTED state; timeout never wins', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    f.faults.executionWriteFaults = 1; // the completion write throws once
    const turn = await driveTurn(f, seeded, 'r1-c2', 800);
    const execution = f.core.database.db
      .prepare("SELECT execution_id, status, outcome_committed_at FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
      .get() as { execution_id: string; status: string; outcome_committed_at: string | null };
    // The committed outcome is authoritative: COMPLETED, never FAILED/TIMEOUT.
    expect(execution.status).toBe('COMPLETED');
    expect(execution.outcome_committed_at).not.toBeNull();
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    expect(terminalEventsOf(f, execution.execution_id)).toEqual(['agent.execution_completed']);
    // Past the deadline: a false timeout/cancel can never reinterpret the committed turn.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(statusOf(f, execution.execution_id)).toBe('COMPLETED');
    expect(terminalEventsOf(f, execution.execution_id)).toEqual(['agent.execution_completed']);
    void turn;
  }, 60_000);

  it('C-R1-03/C-R1-04 the deadline winning before / racing the commit keeps ONE durable winner', async () => {
    // (a) The sink transaction never begins before the deadline: no Decision, marker NULL.
    const slow = await composeF5(COMPOSE);
    const seededSlow = await seedRunAndTask(slow);
    slow.mode.value = 'legal';
    slow.sinkDelay.txMs = 2500;
    const decisionsBefore = decisionCount(slow);
    await driveTurn(slow, seededSlow, 'r1-c3', 800);
    const slowRow = slow.core.database.db
      .prepare("SELECT execution_id, status, outcome_committed_at FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
      .get() as { execution_id: string; status: string; outcome_committed_at: string | null };
    expect(decisionCount(slow)).toBe(decisionsBefore);
    expect(slowRow.outcome_committed_at).toBeNull();
    expect(slowRow.status).not.toBe('RUNNING');
    await slow.sinkDelay.idle();
    expect(decisionCount(slow)).toBe(decisionsBefore); // the late sink has lost its authority
    expect(statusOf(slow, slowRow.execution_id)).toBe(slowRow.status);

    // (b) Races around the boundary: exactly one durable winner every run.
    const fast = await composeF5(COMPOSE);
    const seededFast = await seedRunAndTask(fast);
    fast.mode.value = 'legal';
    for (const [index, txMs] of [100, 950].entries()) {
      await fast.sinkDelay.idle();
      fast.sinkDelay.txMs = txMs;
      const before = decisionCount(fast);
      await driveTurn(fast, seededFast, `r1-c4-${String(index)}`, 800);
      const row = fast.core.database.db
        .prepare("SELECT execution_id, status, outcome_committed_at FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string; status: string; outcome_committed_at: string | null };
      const landed = decisionCount(fast) - before;
      // ONE winner: a Decision exists IFF the committed side won; a committed row is
      // COMPLETED with the marker; a lost one is terminal WITHOUT any marker.
      expect(landed === 1).toBe(row.status === 'COMPLETED');
      if (landed === 1) {
        expect(row.outcome_committed_at).not.toBeNull();
      } else {
        expect(row.outcome_committed_at).toBeNull();
        expect(row.status).not.toBe('RUNNING');
      }
      await fast.sinkDelay.idle();
      expect(decisionCount(fast) - before).toBe(landed);
    }
  }, 120_000);

  it('C-R1-05 repeated cancel-vs-commit races: Decision exists IFF the commit side won; never Decision + CANCELLED', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    for (let index = 0; index < 3; index += 1) {
      const before = decisionCount(f);
      f.executionGate.armed = 'settle';
      const turn = driveTurn(f, seeded, `r1-c5-${String(index)}`, 2000);
      await waitFor(() => f.executionGate.paused, 'settle paused');
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      const cancelled = await f.core.runtime.cancel(row.execution_id, seeded.actor);
      expect(cancelled.ok).toBe(false); // the committed turn may not be reinterpreted
      f.executionGate.release();
      await turn;
      const landed = decisionCount(f) - before;
      expect(landed).toBe(1);
      expect(statusOf(f, row.execution_id)).toBe('COMPLETED');
      expect(markerOf(f, row.execution_id)).not.toBeNull();
      expect(terminalEventsOf(f, row.execution_id)).toEqual(['agent.execution_completed']);
    }
  }, 120_000);

  it('C-R1-06 restart after the commit but before the execution settlement: recovery completes the committed turn, the Decision replays, no model call', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    f.executionGate.armed = 'settle';
    const turn = driveTurn(f, seeded, 'r1-c6', 8000);
    await waitFor(() => f.executionGate.paused, 'settle paused');
    const row = f.core.database.db
      .prepare("SELECT execution_id, status, outcome_committed_at FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
      .get() as { execution_id: string; status: string; outcome_committed_at: string | null };
    expect(row.status).toBe('RUNNING');
    expect(row.outcome_committed_at).not.toBeNull();
    const invocationsBefore = f.rawInvocations.n;
    // Restart: the crashed process's pending write is NEVER delivered (it died before
    // the write) — a fresh composition opens the SAME durable storage.
    const core2 = await recomposeF5Over(f);
    const recovered = await core2.runtime.recoverInterrupted(seeded.actor);
    expect(recovered.ok).toBe(true);
    expect(statusOf(f, row.execution_id)).toBe('COMPLETED'); // the COMMITTED state, never INTERRUPTED
    expect(terminalEventsOf(f, row.execution_id)).toEqual(['agent.execution_completed']);
    expect(decisionCount(f)).toBe(decisionsBefore + 1); // no duplicate Decision
    // A subsequent logical turn of the SAME identity replays the Decision with zero model calls.
    const replayed = await core2.autonomousSupervisor!.run({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      runIdentity: 'r1-c6',
      timeoutMs: 8000,
    });
    expect(replayed.ok).toBe(true);
    expect(f.rawInvocations.n).toBe(invocationsBefore); // no model call
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    expect(statusOf(f, row.execution_id)).toBe('COMPLETED');
    // The pre-restart writer is released LAST: it must LOSE to the durable truth
    // (the run() ok flag is the STOP report, not the turn outcome — the durable facts
    // are the assertion).
    f.executionGate.release();
    await turn;
    expect(statusOf(f, row.execution_id)).toBe('COMPLETED');
    expect(terminalEventsOf(f, row.execution_id)).toEqual(['agent.execution_completed']);
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
  }, 120_000);
});

describe('POST-CODEX R1 — F5-B-R1: the supervisor return boundary never abandons RUNNING', () => {
  it('B-R1-01/B-R1-02 one and two transient settlement-write failures: terminal BEFORE the return', async () => {
    for (const faults of [1, 2]) {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      f.sinkDelay.txMs = 1500; // the sink is slower than the deadline
      f.faults.executionWriteFaults = faults;
      const decisionsBefore = decisionCount(f);
      await driveTurn(f, seeded, `r1-b-${String(faults)}`, 800);
      const row = f.core.database.db
        .prepare("SELECT execution_id, status FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string; status: string };
      // The exact Codex counterexample: storage recovers inside the bounded operation,
      // so the row is ALREADY terminal when the turn returns.
      expect(row.status, `faults=${String(faults)}`).not.toBe('RUNNING');
      expect(runningCount(f)).toBe(0);
      expect(terminalEventsOf(f, row.execution_id)).toHaveLength(1);
      await f.sinkDelay.idle();
      // B-R1-04: the late sink after the deadline lost its authority — no Decision.
      expect(decisionCount(f)).toBe(decisionsBefore);
      expect(statusOf(f, row.execution_id)).toBe(row.status);
    }
  }, 120_000);

  it('B-R1-03 storage unavailable through the bounded operation: a TYPED settlement failure, never a fabricated timeout', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    f.hooks.onSupervisorCall = (): void => {
      f.sinkDelay.txMs = 1500; // the sink lands after the deadline
    };
    f.faults.executionWriteFaults = 999; // every settlement write throws
    const result = await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      commandId: 'supervisor-decision:' + seeded.runId + ':r1-b3:0',
      timeoutMs: 800,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the typed settlement failure');
    expect(result.error.code).toBe('PERSISTENCE_FAILED');
    expect(String(result.error.details['reason'])).toBe('SUPERVISOR_SETTLEMENT_PERSISTENCE_FAILED');
    // Never a fabricated timeout/cancel claim.
    expect(String(result.error.details['reason'])).not.toContain('TIMEOUT');
    // The durable RUNNING row stays owned by the EXISTING restart recovery.
    const row = f.core.database.db
      .prepare("SELECT execution_id, status FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
      .get() as { execution_id: string; status: string };
    expect(row.status).toBe('RUNNING');
    f.faults.executionWriteFaults = 0;
    const recovered = await f.core.runtime.recoverInterrupted(seeded.actor);
    expect(recovered.ok).toBe(true);
    // 9dc9943 — the recovery honors the DURABLE authority expiry: the expired row
    // settles as the SAME canonical TIMEOUT truth as live reconciliation would.
    expect(statusOf(f, row.execution_id)).toBe('FAILED');
  }, 60_000);

  it('B-R1-05 the normal-return invariant: the owned execution is not RUNNING when the call returns', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    const decisionsBefore = decisionCount(f);
    await driveTurn(f, seeded, 'r1-b5', 8000);
    // The healthy path: settled COMPLETED before the return.
    const row = f.core.database.db
      .prepare("SELECT execution_id, status FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
      .get() as { execution_id: string; status: string };
    expect(row.status).toBe('COMPLETED');
    expect(runningCount(f)).toBe(0);
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    expect(terminalEventsOf(f, row.execution_id)).toEqual(['agent.execution_completed']);
  }, 60_000);
});

describe('POST-CODEX 6ec4d81 — the deterministic adversarial arbitration matrix (V4, 18 cases)', () => {
  it('every case lands one unambiguous durable truth combination', async () => {
    interface Row {
      readonly case: string;
      /** Durable AgentExecution row under arbitration ('n/a' for launcher-only cases). */
      readonly durable: boolean;
      readonly executionId: string;
      readonly ownerExecutionId: string;
      readonly logicalTurnId: string | null;
      readonly rowsForIdentity: number;
      readonly decisionCount: number;
      readonly producingExecution: string | null;
      readonly replayed: boolean | 'n/a';
      readonly decisionIdentity: string | null;
      readonly commitIdentity: string | null;
      readonly authorityExpiry: string | null;
      readonly finalStatus: string;
      readonly marker: boolean;
      readonly terminalEvents: readonly string[];
      readonly running: number;
      readonly providerInvocations: number;
      readonly activeDriver: 'released' | 'n/a';
      readonly scheduledRecovery: number | 'n/a';
      readonly runStateChanged: boolean;
      readonly goalRunState: string;
    }
    const rows: Row[] = [];
    const runStateOf = (f: F5Fixture, runId: string): string =>
      String((f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string } | undefined)?.state ?? 'MISSING');
    const record = async (
      name: string,
      f: F5Fixture,
      seeded: Seeded,
      executionId: string,
      _decisionsBefore: number,
      invocationsBefore: number,
      runStateBefore: string,
      overrides: Partial<{
        readonly replayed: boolean | 'n/a';
        readonly activeDriver: 'released' | 'n/a';
        readonly scheduledRecovery: number | 'n/a';
        readonly durable: boolean;
      }> = {},
    ): Promise<void> => {
      const details = f.core.database.db
        .prepare('SELECT logical_turn_id, outcome_decision_id, decision_authority_expires_at FROM agent_executions WHERE execution_id = ?')
        .get(executionId) as
        | { logical_turn_id: string | null; outcome_decision_id: string | null; decision_authority_expires_at: string | null }
        | undefined;
      const logicalTurnId = details?.logical_turn_id ?? null;
      const identity = logicalTurnId === null ? '' : logicalTurnId;
      rows.push({
        case: name,
        durable: overrides.durable ?? true,
        executionId,
        ownerExecutionId: executionId,
        logicalTurnId,
        rowsForIdentity:
          logicalTurnId === null
            ? 0
            : Number(
                (
                  f.core.database.db
                    .prepare('SELECT COUNT(*) AS n FROM agent_executions WHERE logical_turn_id = ?')
                    .get(identity) as { n: number }
                ).n,
              ),
        // Execution-scoped: only decisions that NAME this row in their payload identity
        // (a later logical turn's Decision never counts for the reconciled row).
        decisionCount: Number(
          (
            f.core.database.db
              .prepare("SELECT COUNT(*) AS n FROM decisions WHERE metadata_json LIKE '%' || ? || '%'")
              .get(executionId) as { n: number }
          ).n,
        ),
        producingExecution:
          (f.core.database.db
            .prepare(
              "SELECT decision_id FROM decisions WHERE metadata_json LIKE '%' || ? || '%' LIMIT 1",
            )
            .get(executionId) as { decision_id: string } | undefined) === undefined
            ? null
            : (JSON.parse(
                String(
                  (
                    f.core.database.db
                      .prepare("SELECT metadata_json FROM decisions WHERE metadata_json LIKE '%' || ? || '%' LIMIT 1")
                      .get(executionId) as { metadata_json: string }
                  ).metadata_json,
                ),
              ) as { supervisor?: { executionId?: string } }).supervisor?.executionId ?? null,
        replayed: overrides.replayed ?? 'n/a',
        decisionIdentity: details?.outcome_decision_id ?? null,
        commitIdentity: markerOf(f, executionId),
        authorityExpiry: details?.decision_authority_expires_at ?? null,
        finalStatus: statusOf(f, executionId),
        marker: markerOf(f, executionId) !== null,
        terminalEvents: terminalEventsOf(f, executionId),
        running: runningCount(f),
        providerInvocations: f.rawInvocations.n - invocationsBefore,
        activeDriver: overrides.activeDriver ?? 'n/a',
        scheduledRecovery: overrides.scheduledRecovery ?? 'n/a',
        runStateChanged: runStateOf(f, seeded.runId) !== runStateBefore,
        goalRunState: runStateOf(f, seeded.runId),
      });
    };
    // 1. provider success → Decision success → completion success
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      await driveTurn(f, seeded, 'mx-1', 8000);
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      await record('1 provider→decision→completion', f, seeded, row.execution_id, d, i, rs);
    }
    // 2. provider success → Decision success → completion transient failure
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      f.faults.executionWriteFaults = 1;
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      await driveTurn(f, seeded, 'mx-2', 800);
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      await record('2 decision + transient completion failure', f, seeded, row.execution_id, d, i, rs);
    }
    // 3. provider success → sink delayed → timeout first
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      f.sinkDelay.txMs = 1500;
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      await driveTurn(f, seeded, 'mx-3', 800);
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      await f.sinkDelay.idle();
      await record('3 slow sink loses to the deadline', f, seeded, row.execution_id, d, i, rs);
    }
    // 4. provider success → sink commit first → timeout later
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      f.sinkDelay.tailMs = 1600;
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      await driveTurn(f, seeded, 'mx-4', 800);
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      await f.sinkDelay.idle();
      await record('4 commit wins, later deadline loses', f, seeded, row.execution_id, d, i, rs);
    }
    // 5. provider success → sink throws
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      f.hooks.onSupervisorCall = (): void => {
        f.faults.throwOnRunsGetOnce = true;
      };
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      await driveTurn(f, seeded, 'mx-5', 8000);
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      await record('5 sink throws (no commit)', f, seeded, row.execution_id, d, i, rs);
    }
    // 6. provider never resolves → timeout
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'hang';
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      await driveTurn(f, seeded, 'mx-6', 800);
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      await record('6 provider never resolves', f, seeded, row.execution_id, d, i, rs);
    }
    // 7. provider ignores cancel → late success
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'late';
      f.mode.delayMs = 3000;
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      await driveTurn(f, seeded, 'mx-7', 800);
      await new Promise((resolve) => setTimeout(resolve, 3500));
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      await record('7 late success after the deadline', f, seeded, row.execution_id, d, i, rs);
    }
    // 8. provider ignores cancel → late failure
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'raw:failLate';
      f.mode.delayMs = 3000;
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      await driveTurn(f, seeded, 'mx-8', 800);
      await new Promise((resolve) => setTimeout(resolve, 3500));
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      await record('8 late failure after the deadline', f, seeded, row.execution_id, d, i, rs);
    }
    // 9. execution cancelled during startup (the paused start window)
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'raw:ok';
      const executionId = await prepareExecution(f, seeded);
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      f.executionGate.armed = 'start';
      const turn = startInvocation(f, seeded, executionId);
      await waitFor(() => f.executionGate.paused, 'mx-9 start paused');
      await f.core.runtime.cancel(executionId, seeded.actor);
      f.executionGate.release();
      await turn;
      await record('9 cancelled during startup', f, seeded, executionId, d, i, rs);
    }
    // 10. execution cancelled after Decision commit
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      f.executionGate.armed = 'settle';
      const turn = driveTurn(f, seeded, 'mx-10', 8000);
      await waitFor(() => f.executionGate.paused, 'mx-10 settle paused');
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      await f.core.runtime.cancel(row.execution_id, seeded.actor);
      f.executionGate.release();
      await turn;
      await record('10 cancelled after the commit', f, seeded, row.execution_id, d, i, rs);
    }
    // 11. restart after timeout
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'hang';
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      await driveTurn(f, seeded, 'mx-11', 800);
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      const eventsBeforeRestart = terminalEventsOf(f, row.execution_id).length;
      const core2 = await recomposeF5Over(f);
      await core2.runtime.recoverInterrupted(seeded.actor);
      expect(terminalEventsOf(f, row.execution_id).length).toBe(eventsBeforeRestart);
      await record('11 restart after timeout', f, seeded, row.execution_id, d, i, rs);
    }
    // 12. restart after Decision commit before terminal settlement
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      f.executionGate.armed = 'settle';
      const turn = driveTurn(f, seeded, 'mx-12', 8000);
      await waitFor(() => f.executionGate.paused, 'mx-12 settle paused');
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      const core2 = await recomposeF5Over(f);
      await core2.runtime.recoverInterrupted(seeded.actor);
      f.executionGate.release();
      await turn;
      await record('12 restart after the commit', f, seeded, row.execution_id, d, i, rs);
    }

    // 13. Decision insert failure after the commit-marker attempt (C2 atomicity)
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      f.hooks.onSupervisorCall = (): void => {
        f.faults.decisionCreateFaults = 1;
      };
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      await driveTurn(f, seeded, 'mx-13', 8000);
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      await record('13 Decision insert failure (atomic rollback)', f, seeded, row.execution_id, d, i, rs);
    }
    // 14. the deadline expiry + unavailable settlement storage + the late sink (B1)
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      f.sinkDelay.txMs = 1500;
      f.faults.executionWriteFaults = 999;
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      const result = await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
        companyId: COMPANY,
        runId: seeded.runId,
        taskId: seeded.taskId,
        actorId: seeded.actor,
        commandId: 'supervisor-decision:' + seeded.runId + ':mx-14:0',
        timeoutMs: 800,
      });
      void result;
      f.faults.executionWriteFaults = 0;
      await f.sinkDelay.idle();
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      await record('14 expiry + unavailable storage + late sink', f, seeded, row.execution_id, d, i, rs);
    }
    // 15. live reconciliation after #14 (the existing driver settles it, zero provider calls)
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      f.sinkDelay.txMs = 1500;
      f.faults.executionWriteFaults = 999;
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
        companyId: COMPANY,
        runId: seeded.runId,
        taskId: seeded.taskId,
        actorId: seeded.actor,
        commandId: 'supervisor-decision:' + seeded.runId + ':mx-15:0',
        timeoutMs: 600,
      });
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      f.faults.executionWriteFaults = 0;
      await f.sinkDelay.idle();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await f.core.autonomousSupervisor!.run({
        companyId: COMPANY,
        runId: seeded.runId,
        taskId: seeded.taskId,
        actorId: seeded.actor,
        runIdentity: 'mx-15-advance',
        timeoutMs: 5000,
      });
      await record('15 reconciliation of the expired row', f, seeded, row.execution_id, d, i, rs);
    }
    // 16. two simultaneous terminal writers (cancel vs the receipt-side helper call)
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      f.sinkDelay.txMs = 1200; // the deadline wins first; the sink arrives after
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      await driveTurn(f, seeded, 'mx-16', 800);
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      const second = await f.core.runtime.cancel(row.execution_id, seeded.actor);
      void second;
      await f.sinkDelay.idle();
      await record('16 deadline then a second terminal writer', f, seeded, row.execution_id, d, i, rs);
    }

    // 17. the delayed contender paused BEFORE the claim: ONE owner, ONE provider call,
    //     the released contender REPLAYS the exact Decision (permanent ownership)
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      const runWithIdentity = (identity: string): Promise<TurnResult> =>
        f.core.autonomousSupervisor!.run({
          companyId: COMPANY,
          runId: seeded.runId,
          taskId: seeded.taskId,
          actorId: seeded.actor,
          runIdentity: identity,
          timeoutMs: 8000,
        }) as Promise<TurnResult>;
      f.executionGate.armed = 'claim';
      const contender = runWithIdentity('mx-17');
      await waitFor(() => f.executionGate.paused, 'mx-17 claim paused');
      const winner = await runWithIdentity('mx-17');
      expect(winner.ok).toBe(true);
      f.executionGate.release();
      const released = await contender;
      expect(released.ok).toBe(true);
      const row = f.core.database.db
        .prepare("SELECT execution_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { execution_id: string };
      const lastDecision = (released as unknown as { value: { lastDecision: { replayed?: boolean; executionId?: string } | null } }).value
        .lastDecision;
      expect(lastDecision?.replayed).toBe(true);
      expect(lastDecision?.executionId).toBe(row.execution_id);
      await record('17 delayed contender replays the ONE owner', f, seeded, row.execution_id, d, i, rs, {
        replayed: true,
        activeDriver: 'released',
      });
    }
    // 18. the launcher-only recovery case: a typed persistence refusal keeps exactly ONE
    //     scheduled recovery owner (never exhausted by a fixed count); no durable row.
    {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      f.mode.value = 'legal';
      const d = decisionCount(f);
      const i = f.rawInvocations.n;
      const rs = runStateOf(f, seeded.runId);
      const goalState = {
        goalRunId: seeded.runId,
        goalRunState: 'EXECUTING',
        executionRuns: [{ runId: seeded.runId, state: 'EXECUTING' }],
        tasks: [],
        totalAttempts: 0,
        failedAttempts: 0,
        correctiveCycles: 0,
        pendingApproval: null,
        decisionCount: 0,
        eventCount: 0,
        fingerprint: 'fp-mx-18',
      };
      const scheduled: { fn: () => void; ms: number }[] = [];
      const persistentDriver = createGoalOutcomeAutonomyDriver({
        advanceGoal: async () =>
          err(
            domainError('PERSISTENCE_FAILED', 'The goal advance hit a storage failure.', {
              reason: 'GOAL_ADVANCE_STORAGE_PERSISTENCE_FAILED',
              cause: 'database is locked',
            }),
          ),
        loadGoalState: async () => ok({ ...goalState }),
        preflightChecks: async () => [],
        projectOutcome: async () => ({}) as never,
      });
      const runner = createDesktopAutonomyRunner({
        companyId: COMPANY,
        driver: persistentDriver as never,
        logger: null,
        scheduleDelay: (fn, ms) => {
          scheduled.push({ fn, ms });
        },
        goalRunState: async () => 'EXECUTING',
        maxStallResumes: 0,
        stallResumeDelayMs: 20,
      });
      expect(runner.start(COMPANY, seeded.runId)).toBe(true);
      await waitFor(() => scheduled.length >= 1, 'mx-18 recovery scheduled');
      // released: the runner's active slot is released after the typed refusal
      for (let attempt = 0; attempt < 200 && runner.activeRunIds().length > 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const activeReleased = runner.activeRunIds().length === 0;
      expect(activeReleased).toBe(true);
      expect(f.rawInvocations.n - i).toBe(0); // zero model calls were made anywhere
      await record('18 typed persistence refusal schedules ONE recovery', f, seeded, 'n/a', d, i, rs, {
        replayed: 'n/a',
        activeDriver: 'released',
        scheduledRecovery: scheduled.length,
        durable: false,
      });
    }

    console.log('R1_MATRIX ' + JSON.stringify(rows, null, 1));
    expect(rows).toHaveLength(18);
    for (const row of rows) {
      if (!row.durable) continue; // the launcher-only case asserts inline
      // The ONE documented non-zero shape: the expired row whose settlement storage was
      // unavailable — provably expired, uncommitted, Decision-free and owned by the
      // existing recovery (the sanctioned typed-failure state); every other case is
      // fully settled.
      if (row.running !== 0) {
        expect(row.finalStatus, row.case).toBe('RUNNING');
        expect(row.decisionCount, row.case).toBe(0);
        expect(row.marker, row.case).toBe(false);
        expect(row.authorityExpiry, row.case).not.toBeNull();
      }
      expect(row.running, row.case).toBeLessThanOrEqual(1);
      expect(row.terminalEvents.length, row.case).toBeLessThanOrEqual(1);
      // ONE unambiguous truth: a Decision exists IFF the committed side won.
      if (row.decisionCount > 0) {
        expect(row.finalStatus, row.case).toBe('COMPLETED');
        expect(row.marker, row.case).toBe(true);
        expect(row.terminalEvents, row.case).toEqual(['agent.execution_completed']);
        // PERMANENT ownership: when this row carries an identity it is the ONLY owner,
        // and the Decision's producing execution is that very row.
        if (row.logicalTurnId !== null) {
          expect(row.rowsForIdentity, row.case).toBe(1);
          expect(row.producingExecution, row.case).toBe(row.executionId);
        }
      } else {
        expect(row.finalStatus, row.case).not.toBe('COMPLETED');
        expect(row.marker, row.case).toBe(false);
      }
    }
  }, 300_000);
});
