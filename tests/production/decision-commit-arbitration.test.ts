/**
 * F5-C — DECISION COMMIT vs TERMINAL SETTLEMENT ARBITRATION (release blocker, post-Codex).
 *
 * Codex reproduced the defect: a deadline that had already canonically won (the
 * execution settled terminally) could still be followed by the slow Decision sink
 * writing its durable Decision LATER (deadline wins in memory → sink still writes).
 * The mirrored window was broken too: an abort firing just after the commit landed
 * could misreport the turn as a failure even though the Decision was durable.
 *
 * The fix (Phase 2 of the closure) gives the two facts ONE arbitration:
 *   - the sink commits a Decision ONLY while the execution that owns the turn is
 *     durably RUNNING (`authorizedExecutionId`, checked in the same transaction as
 *     the insert) — once the deadline/cancellation canonically won, the late commit
 *     LOSES its authority and is refused with reason
 *     `SUPERVISOR_DECISION_EXECUTION_TERMINAL`;
 *   - the turn races its own deadline against the sink call and, on a race loss,
 *     re-reads the DURABLE Decision row: commit landed ⇒ the execution is settled
 *     with the real provider result and the Decision survives (the deadline cannot
 *     erase it); no Decision ⇒ the deadline owns the row and the still-in-flight
 *     sink can never commit one.
 *
 * Invariants pinned here (deterministic fixtures only; real time, real SQLite):
 *   F5-C1  slow sink past the deadline  → execution settles BY the deadline
 *          (the sink's transaction had not even completed), Decision absent forever
 *   F5-C2a a commit shortly before the deadline survives; a later timeout cannot
 *          overwrite it (the F5-D arbiter reports ALREADY_TERMINAL)
 *   F5-C2b the deadline fires AFTER the commit landed (slow post-commit tail) →
 *          Decision survives, execution COMPLETED with the real result
 *   F5-C3  commit/timeout repeated with varying delays → exactly one canonical
 *          outcome every run: Decision ⟺ COMPLETED, never both, never neither
 *   F5-C4  a late sink resolution performs ZERO lifecycle advancement, and a late
 *          writer aimed at a settled owner is refused with the typed reason
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

/** One legal advance puts the execution run + work task in place (the F5-04 shape). */
const seedSupervisorSubject = async (f: F5Fixture): Promise<SeededSubject> => {
  const created = await f.core.controlPlane!.handle({
    operation: 'goal.create',
    payload: { companyId: COMPANY, objective: 'decision commit arbitration seed', commandId: `f5c-${String(Date.now())}` },
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

/** The direct, deterministic supervisor drive (one logical round per identity). */
const driveTurn = async (
  f: F5Fixture,
  seeded: SeededSubject,
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
  return {
    ok: result.ok,
    stopReason: String((result.ok ? result.value.stopReason : result.error.code) ?? ''),
  };
};

/**
 * Arm the commit-window probe so it hits ONLY the sink's transaction: the hook fires
 * inside the supervisor provider call, immediately before validate+record.
 */
const armSinkDelay = (f: F5Fixture, patch: { readonly txMs?: number; readonly tailMs?: number }): void => {
  f.hooks.onSupervisorCall = (): void => {
    f.hooks.onSupervisorCall = undefined;
    if (patch.txMs !== undefined) f.sinkDelay.txMs = patch.txMs;
    if (patch.tailMs !== undefined) f.sinkDelay.tailMs = patch.tailMs;
  };
};
const disarmSinkDelay = (f: F5Fixture): void => {
  f.hooks.onSupervisorCall = undefined;
  f.sinkDelay.txMs = 0;
  f.sinkDelay.tailMs = 0;
};

const supervisorExecutionsOf = (f: F5Fixture) =>
  f.core.database.db
    .prepare("SELECT execution_id, status, error_kind, started_at, finished_at, updated_at FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY started_at, rowid")
    .all() as {
    execution_id: string;
    status: string;
    error_kind: string | null;
    started_at: string | null;
    finished_at: string | null;
    updated_at: string;
  }[];

const newestExecution = (f: F5Fixture): ReturnType<typeof supervisorExecutionsOf>[number] => {
  const rows = supervisorExecutionsOf(f);
  return rows[rows.length - 1]!;
};

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

/** The whole settlement-relevant state of one execution (for "no late advancement" proofs). */
const durableStateOf = (f: F5Fixture, executionId: string): string =>
  JSON.stringify({
    row: f.core.database.db
      .prepare('SELECT status, error_kind, error_code, updated_at FROM agent_executions WHERE execution_id = ?')
      .get(executionId) ?? null,
    terminalEvents: terminalEventsOf(f, executionId),
    decisions: decisionCount(f),
  });

const isBoundedDeadlineSettlement = (row: { status: string; error_kind: string | null }): boolean =>
  row.status === 'CANCELLED' || row.error_kind === 'CANCELLED' || row.error_kind === 'TIMEOUT';

const COMPOSE = { supervisorTimeoutMs: 120_000, maxSupervisorTurns: 1 } as const;

describe('F5-C — decision commit vs terminal settlement arbitration', () => {
  it('F5-C1 a sink slower than the deadline: the execution settles BY the deadline and no Decision can ever appear', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedSupervisorSubject(f);
    const decisionsBefore = decisionCount(f);
    const completedBefore = f.sinkDelay.txCompleted;
    f.mode.value = 'legal';
    // The sink is slow to OBTAIN its write window: the transaction begins only after
    // the deadline (and the canonical settlement) have already landed. Armed inside
    // the provider call so ONLY the sink's own transaction takes the delay.
    armSinkDelay(f, { txMs: 2500 });
    const started = Date.now();
    const turn = await driveTurn(f, seeded, 'f5c-c1', 800);
    const elapsed = Date.now() - started;
    // Bounded by the deadline — NOT by the slow sink (whose transaction has not even
    // completed yet, proving the settlement did not wait for it).
    expect(elapsed).toBeLessThan(2400);
    expect(f.sinkDelay.txCompleted).toBe(completedBefore);
    expect(turn.ok).toBe(true);
    const execution = newestExecution(f);
    expect(execution.status).not.toBe('RUNNING');
    expect(isBoundedDeadlineSettlement(execution)).toBe(true);
    expect(terminalEventsOf(f, execution.execution_id)).toHaveLength(1);
    expect(decisionCount(f)).toBe(decisionsBefore);
    // The sandbagged sink wakes up LATER and does run its transaction — the commit gate
    // finds a settled owner and refuses: no Decision, no second settlement.
    disarmSinkDelay(f);
    await f.sinkDelay.idle();
    expect(f.sinkDelay.txCompleted).toBe(completedBefore + 1);
    expect(decisionCount(f)).toBe(decisionsBefore);
    expect(statusOf(f, execution.execution_id)).toBe(execution.status);
    expect(terminalEventsOf(f, execution.execution_id)).toHaveLength(1);
  }, 60_000);

  it('F5-C2a a commit shortly before the deadline survives; a later timeout cannot overwrite it', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedSupervisorSubject(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    armSinkDelay(f, { txMs: 300 }); // the commit lands well before the 800ms deadline
    const turn = await driveTurn(f, seeded, 'f5c-c2a', 800);
    expect(turn.ok).toBe(true);
    const execution = newestExecution(f);
    expect(execution.status).toBe('COMPLETED');
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    expect(terminalEventsOf(f, execution.execution_id)).toEqual(['agent.execution_completed']);
    // The settlement already won: a LATER timeout-shaped failure loses the arbitration
    // (F5-D) — the committed truth and the Decision are not overwritten.
    const late = await f.core.runtime.failExecution({
      executionId: execution.execution_id,
      actorId: seeded.actor,
      error: normalizeExecutionError({ kind: 'TIMEOUT', message: 'late deadline settlement' }),
    });
    expect(late.ok).toBe(false);
    expect(statusOf(f, execution.execution_id)).toBe('COMPLETED');
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    expect(terminalEventsOf(f, execution.execution_id)).toEqual(['agent.execution_completed']);
  }, 60_000);

  it('F5-C2b the deadline fires AFTER the commit landed (slow post-commit tail): the Decision survives', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedSupervisorSubject(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    // The commit COMPLETES immediately; the sink does not return until 1600ms — the
    // turn's 800ms deadline fires in that window (CASE A).
    armSinkDelay(f, { tailMs: 1600 });
    const turn = await driveTurn(f, seeded, 'f5c-c2b', 800);
    expect(turn.ok).toBe(true); // the run reports its own timeout — never a throw
    const execution = newestExecution(f);
    // The commit WON: the Decision is durable and the execution carries the REAL
    // provider result — the deadline did not erase it.
    expect(execution.status).toBe('COMPLETED');
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    expect(terminalEventsOf(f, execution.execution_id)).toEqual(['agent.execution_completed']);
    // The late sink resolution changes nothing.
    await f.sinkDelay.idle();
    expect(statusOf(f, execution.execution_id)).toBe('COMPLETED');
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    expect(terminalEventsOf(f, execution.execution_id)).toEqual(['agent.execution_completed']);
    disarmSinkDelay(f);
  }, 60_000);

  it('F5-C3 commit/timeout repeated with varying delays: exactly ONE canonical outcome every run', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedSupervisorSubject(f);
    const baseline = supervisorExecutionsOf(f).length;
    f.mode.value = 'legal';
    // Delays with >=300ms margins on both sides of the 800ms deadline. The turn is driven
    // DIRECTLY (no autonomy loop): one logical turn per identity, nothing else in flight.
    const cases: readonly { readonly txMs: number; readonly committed: boolean }[] = [
      { txMs: 100, committed: true },
      { txMs: 250, committed: true },
      { txMs: 950, committed: false },
      { txMs: 1500, committed: false },
    ];
    for (const [index, scenario] of cases.entries()) {
      await f.sinkDelay.idle(); // no pending predecessor transaction
      armSinkDelay(f, { txMs: scenario.txMs });
      const decisionsBefore = decisionCount(f);
      const result = await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
        companyId: COMPANY,
        runId: seeded.runId,
        taskId: seeded.taskId,
        actorId: seeded.actor,
        commandId: supervisorDecisionCommandId(seeded.runId, `f5c-c3-${String(index)}`),
        timeoutMs: 800,
      });
      const execution = newestExecution(f);
      const landed = decisionCount(f) - decisionsBefore;
      // EXACTLY ONE canonical winner, every run: a Decision exists iff the execution is
      // COMPLETED — never both, never neither; and the turn outcome agrees with it.
      expect(result.ok).toBe(scenario.committed);
      expect(landed === 1).toBe(execution.status === 'COMPLETED');
      expect(landed).toBe(scenario.committed ? 1 : 0);
      expect(execution.status).not.toBe('RUNNING');
      expect(terminalEventsOf(f, execution.execution_id)).toHaveLength(1);
      // The outcome is permanent once the race has resolved.
      disarmSinkDelay(f);
      await f.sinkDelay.idle();
      expect(decisionCount(f) - decisionsBefore).toBe(landed);
      expect(statusOf(f, execution.execution_id)).toBe(execution.status);
    }
    const rows = supervisorExecutionsOf(f);
    expect(rows.length).toBe(baseline + cases.length);
    expect(rows.every((row) => row.status !== 'RUNNING')).toBe(true);
  }, 120_000);

  it('F5-C4 a late sink resolution performs ZERO lifecycle advancement; a late writer at a settled owner is refused', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedSupervisorSubject(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    armSinkDelay(f, { tailMs: 1600 }); // commit lands; the record promise resolves AFTER the deadline
    const turn = await driveTurn(f, seeded, 'f5c-c4', 800);
    expect(turn.ok).toBe(true);
    const execution = newestExecution(f);
    expect(execution.status).toBe('COMPLETED');
    // The late branch is genuinely STILL in flight when the turn has already closed.
    expect(f.sinkDelay.inFlight).toBeGreaterThan(0);
    const snapshot = durableStateOf(f, execution.execution_id);
    disarmSinkDelay(f);
    await f.sinkDelay.idle(); // the late OK lands — and must change nothing
    expect(durableStateOf(f, execution.execution_id)).toBe(snapshot);
    // A late writer aimed at the settled owner has LOST its authority: the sink refuses
    // with its typed reason, and nothing new appears in durable truth.
    const refused = await f.core.supervisorDecisionSink!.record({
      commandId: supervisorDecisionCommandId(seeded.runId, 'f5c-c4-direct-late-writer'),
      companyId: COMPANY,
      runId: seeded.runId,
      stageId: null,
      taskId: null,
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'late writer after the settlement',
      evidenceRefs: [],
      modelBindingKey: 'supervisor',
      decidedBy: seeded.actor,
      authorizedExecutionId: execution.execution_id,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('the late writer unexpectedly committed');
    expect(String(refused.error.details['reason'])).toBe('SUPERVISOR_DECISION_EXECUTION_TERMINAL');
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    expect(durableStateOf(f, execution.execution_id)).toBe(snapshot);
  }, 60_000);
});
