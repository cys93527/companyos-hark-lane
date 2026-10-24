/**
 * F5-B — NO EXIT MAY ABANDON THE OWNED SUPERVISOR EXECUTION (release blocker, post-Codex).
 *
 * Codex reproduced the defect: prepare → provider success → the Decision sink THROWS →
 * the supervisor call exits by throw and the deferred execution stays RUNNING forever
 * (only a restart cleaned it up).
 *
 * The fix (Phase 3 of the closure): the turn's post-`prepare` region has a catch that is
 * an exit exactly like a return — the owned deferred execution is settled through the ONE
 * canonical arbiter (Phase 1) before the error leaves the call; a settlement write that
 * threw is RETRIED (the arbiter refuses a landed transition, so one event, never two);
 * the `FaultCrashError` sentinel still stands for a KILLED process and keeps propagating
 * unsettled (its window is owned by the existing restart recovery).
 *
 * Invariants pinned here (deterministic once-throw store injection):
 *   F5-B1 a transient settlement-write failure during the deadline path → the row is
 *         terminal anyway (the retry lands through the arbiter), exactly one event
 *   F5-B2 a transient settlement-write failure on the completion path → terminal, typed,
 *         the committed Decision replays by identity with ZERO new provider calls, and no
 *         second settlement can ever land
 *   F5-B3 the sink's FIRST read throws → the call RETURNS a typed err (no rejection
 *         escapes), the row is terminal, no Decision exists, exactly one event
 */
import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { normalizeExecutionError } from '@companyos/core';
import { supervisorDecisionCommandId } from '@companyos/engine';

import {
  COMPANY,
  composeF5,
  createdDirs,
  openDatabases,
  type F5Fixture,
} from './helpers/f5-fixture.js';

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});

interface SeededSubject {
  readonly runId: string;
  readonly taskId: string;
  readonly actor: string;
}

const seedSupervisorSubject = async (f: F5Fixture): Promise<SeededSubject> => {
  const created = await f.core.controlPlane!.handle({
    operation: 'goal.create',
    payload: { companyId: COMPANY, objective: 'sink exception settlement seed', commandId: `f5b-${String(Date.now())}` },
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

const driveTurn = async (
  f: F5Fixture,
  seeded: SeededSubject,
  runIdentity: string,
  timeoutMs: number,
): Promise<{ readonly ok: boolean }> => {
  const result = await f.core.autonomousSupervisor!.run({
    companyId: COMPANY,
    runId: seeded.runId,
    taskId: seeded.taskId,
    actorId: seeded.actor,
    runIdentity,
    timeoutMs,
  });
  return { ok: result.ok };
};

const turnCommand = (f: F5Fixture, seeded: SeededSubject, identity: string, timeoutMs: number) =>
  f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
    companyId: COMPANY,
    runId: seeded.runId,
    taskId: seeded.taskId,
    actorId: seeded.actor,
    commandId: supervisorDecisionCommandId(seeded.runId, identity),
    timeoutMs,
  });

const supervisorExecutionsOf = (f: F5Fixture) =>
  f.core.database.db
    .prepare("SELECT execution_id, status, error_kind, error_code FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY started_at, rowid")
    .all() as { execution_id: string; status: string; error_kind: string | null; error_code: string | null }[];

const newestExecution = (f: F5Fixture): ReturnType<typeof supervisorExecutionsOf>[number] =>
  supervisorExecutionsOf(f)[supervisorExecutionsOf(f).length - 1]!;

const decisionCount = (f: F5Fixture): number =>
  Number((f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n);

const terminalEventsOf = (f: F5Fixture, executionId: string): readonly string[] =>
  (
    f.core.database.db
      .prepare(
        "SELECT type FROM events WHERE aggregate_id = ? AND type IN ('agent.execution_completed','agent.execution_failed','agent.execution_cancelled','agent.execution_interrupted') ORDER BY rowid",
      )
      .all(executionId) as { type: string }[]
  ).map((row) => row.type);

const statusOf = (f: F5Fixture, executionId: string): string =>
  String(
    (
      f.core.database.db
        .prepare('SELECT status FROM agent_executions WHERE execution_id = ?')
        .get(executionId) as { status: string } | undefined
    )?.status ?? 'MISSING',
  );

const runningCount = (f: F5Fixture): number =>
  Number(
    (f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM agent_executions WHERE status = 'RUNNING'")
      .get() as { n: number }).n,
  );

const COMPOSE = { supervisorTimeoutMs: 120_000, maxSupervisorTurns: 1 } as const;

describe('F5-B — no exit may abandon the owned supervisor execution', () => {
  it('F5-B1 a transient settlement-write failure during the deadline path still settles terminally (one event)', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedSupervisorSubject(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    // The deadline wins; the FIRST settlement write throws (transient); the sink is
    // sandbagged so it can never commit afterwards.
    f.hooks.onSupervisorCall = (): void => {
      f.sinkDelay.txMs = 1500;
      f.faults.throwOnExecutionWriteOnce = true;
    };
    const turn = await driveTurn(f, seeded, 'f5b-b1', 800);
    expect(turn.ok).toBe(true); // the run bounded itself — nothing rejected
    const execution = newestExecution(f);
    expect(execution.status).not.toBe('RUNNING');
    expect(execution.status === 'CANCELLED' || execution.error_kind === 'CANCELLED' || execution.error_kind === 'TIMEOUT').toBe(true);
    // The retry landed through the ONE arbiter: exactly one terminal event, no duplicate.
    expect(terminalEventsOf(f, execution.execution_id)).toHaveLength(1);
    expect(decisionCount(f)).toBe(decisionsBefore);
    expect(runningCount(f)).toBe(0);
    // The sandbagged sink completes later and can never commit; the row is frozen.
    await f.sinkDelay.idle();
    expect(decisionCount(f)).toBe(decisionsBefore);
    expect(statusOf(f, execution.execution_id)).toBe(execution.status);
    expect(terminalEventsOf(f, execution.execution_id)).toHaveLength(1);
  }, 60_000);

  it('F5-B2 (+C-R1-02) a transient settlement-write failure on the completion path converges to the COMMITTED state: FAILED/TIMEOUT never wins, the Decision replays', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedSupervisorSubject(f);
    const decisionsBefore = decisionCount(f);
    const invocationsBefore = f.supervisorInvocations.length;
    f.mode.value = 'legal';
    f.hooks.onSupervisorCall = (): void => {
      f.faults.throwOnExecutionWriteOnce = true;
    };
    const result = await turnCommand(f, seeded, 'f5b-b2', 5000);
    // The call RETURNED a typed err — a throw never escaped it.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the turn unexpectedly completed');
    expect(result.error.code).toBe('PERSISTENCE_FAILED');
    const execution = newestExecution(f);
    // F5-C-R1 — the outcome was durably committed with the Decision: the transient
    // completion-write failure can never reinterpret the turn as FAILED/TIMEOUT — the
    // bounded settlement CONVERGES the committed terminal state (COMPLETED).
    expect(execution.status).toBe('COMPLETED');
    expect(execution.error_kind).toBe(null);
    expect(terminalEventsOf(f, execution.execution_id)).toHaveLength(1);
    expect(runningCount(f)).toBe(0);
    // The Decision had committed before the completion write failed — it stays durable.
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    // Replay of the SAME identity: zero new provider calls, no second settlement.
    const replayed = await turnCommand(f, seeded, 'f5b-b2', 5000);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(replayed.value.replayed).toBe(true);
    expect(f.supervisorInvocations.length).toBe(invocationsBefore + 1);
    expect(terminalEventsOf(f, execution.execution_id)).toHaveLength(1);
    // A later failure attempt loses the arbitration outright (F5-D).
    const late = await f.core.runtime.failExecution({
      executionId: execution.execution_id,
      actorId: seeded.actor,
      error: normalizeExecutionError({ kind: 'TIMEOUT', message: 'late deadline settlement' }),
    });
    expect(late.ok).toBe(false);
    expect(statusOf(f, execution.execution_id)).toBe('COMPLETED');
    expect(terminalEventsOf(f, execution.execution_id)).toHaveLength(1);
  }, 60_000);

  it('F5-B3 the sink rejects outright (its first read throws): typed err returned, row terminal, zero Decision', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedSupervisorSubject(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    f.hooks.onSupervisorCall = (): void => {
      f.faults.throwOnRunsGetOnce = true;
    };
    const turn = await driveTurn(f, seeded, 'f5b-b3', 5000);
    expect(turn.ok).toBe(true); // resolved: the rejection never escaped the supervisor call
    const execution = newestExecution(f);
    expect(execution.status).toBe('FAILED');
    expect(execution.status).not.toBe('RUNNING');
    expect(terminalEventsOf(f, execution.execution_id)).toHaveLength(1);
    expect(decisionCount(f)).toBe(decisionsBefore); // nothing was committed
    expect(runningCount(f)).toBe(0);
  }, 60_000);
});
