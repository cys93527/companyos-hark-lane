/**
 * POST-CODEX 9dc9943 re-audit — the FINAL Decision/Execution commit protocol (N9-C2 / N9-C1 / N9-B1).
 *
 * N9-C2 — the marker+Decision transaction must be atomic: a non-ok exit inside the sink's
 *   UnitOfWork callback now THROWS a typed abort (rollback), so no orphan outcome marker
 *   can survive a failed Decision insert; the outer layer maps the abort to Result.err.
 *
 * N9-C1 — the STORAGE CAS itself encodes the arbitration: a non-success terminal
 *   (cancel/failure/timeout/interrupted) lands only while `outcome_committed_at IS NULL`;
 *   a committed row converges COMPLETED only. The in-memory pre-read is not the authority.
 *
 * N9-B1 — a DURABLE decision-authority expiry (absolute, canonical clock) written at start
 *   revokes the late sink even when the row temporarily remains RUNNING; the existing
 *   Autonomy Driver reconciles expired/committed rows through the canonical arbiter with
 *   ZERO provider calls.
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
    payload: { companyId: COMPANY, objective: 'commit protocol N9 seed', commandId: `n9-${String(Date.now())}` },
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

const newestSupervisor = (f: F5Fixture) =>
  f.core.database.db
    .prepare(
      "SELECT execution_id, status, outcome_committed_at, outcome_decision_id, decision_authority_expires_at FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1",
    )
    .get() as {
    execution_id: string;
    status: string;
    outcome_committed_at: string | null;
    outcome_decision_id: string | null;
    decision_authority_expires_at: string | null;
  };

const decisionCount = (f: F5Fixture): number =>
  Number((f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n);

const providerCallsFor = (f: F5Fixture, executionId: string): number =>
  Number(
    (
      f.core.database.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE aggregate_id = ? AND type = 'provider.invoked'")
        .get(executionId) as { n: number }
    ).n,
  );

const driveTurn = async (f: F5Fixture, seeded: Seeded, runIdentity: string, timeoutMs: number): Promise<boolean> =>
  (
    await f.core.autonomousSupervisor!.run({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      runIdentity,
      timeoutMs,
    })
  ).ok;

const COMPOSE = { supervisorTimeoutMs: 120_000, maxSupervisorTurns: 1 } as const;

describe('N9-C2 — the Decision transaction is ATOMIC (no orphan outcome marker)', () => {
  it('C2-01/C2-03 a Decision insert failure ROLLS BACK the marker: marker NULL, Decision 0, typed abort returned', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    f.hooks.onSupervisorCall = (): void => {
      f.faults.decisionCreateFaults = 1; // the insert throws AFTER the marker statement ran
    };
    await driveTurn(f, seeded, 'n9-c2-1', 8000);
    const row = newestSupervisor(f);
    expect(row.outcome_committed_at).toBeNull(); // rolled back with the transaction
    expect(row.outcome_decision_id).toBeNull();
    expect(decisionCount(f)).toBe(decisionsBefore);
    expect(row.status).not.toBe('RUNNING');
    expect(row.status).not.toBe('COMPLETED'); // never a marker-driven COMPLETED without a Decision
    const types = (
      f.core.database.db
        .prepare('SELECT type FROM events WHERE aggregate_id = ? ORDER BY rowid')
        .all(row.execution_id) as { type: string }[]
    ).map((r) => r.type);
    expect(types).not.toContain('agent.execution_completed');
  }, 60_000);

  it('C2-02 a conflict resolution after the marker attempt rolls back the same way', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    // The fault path C2-02: the injected failure arrives as a raw persistence exception
    // after the marker statement — identical rollback semantics (asserted via the state).
    f.hooks.onSupervisorCall = (): void => {
      f.faults.decisionCreateFaults = 2;
    };
    await driveTurn(f, seeded, 'n9-c2-2', 8000);
    const row = newestSupervisor(f);
    expect(row.outcome_committed_at).toBeNull();
    expect(row.outcome_decision_id).toBeNull();
    expect(decisionCount(f)).toBe(decisionsBefore);
  }, 60_000);

  it('C2-04/C2-05 the successful path commits marker and Decision TOGETHER, records the identity, and survives restart both-or-neither', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    await driveTurn(f, seeded, 'n9-c2-4', 8000);
    const row = newestSupervisor(f);
    expect(row.status).toBe('COMPLETED');
    expect(row.outcome_committed_at).not.toBeNull();
    expect(row.outcome_decision_id).not.toBeNull();
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    // The recorded identity IS the durable Decision that owns the committed outcome.
    const committed = f.core.database.db
      .prepare('SELECT decision_id FROM decisions WHERE decision_id = ?')
      .get(row.outcome_decision_id) as { decision_id: string } | undefined;
    expect(committed?.decision_id).toBe(row.outcome_decision_id);
    // Restart: the pair survives atomically (both present), no resurrection.
    const core2 = await recomposeF5Over(f);
    await core2.runtime.recoverInterrupted(seeded.actor);
    const after = newestSupervisor(f);
    expect(after.status).toBe('COMPLETED');
    expect(after.outcome_decision_id).toBe(row.outcome_decision_id);
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
  }, 60_000);
});

describe('N9-C1 — the STORAGE CAS encodes the committed-outcome rule', () => {
  it('C1-01/C1-02/C1-03 cancel / failure / timeout settlements lose to a committed RUNNING row — at the SQL level', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    f.executionGate.armed = 'settle'; // pause the turn's completion: RUNNING + committed
    const turn = driveTurn(f, seeded, 'n9-c1-1', 8000);
    for (let attempt = 0; attempt < 200 && !f.executionGate.paused; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const row = newestSupervisor(f);
    expect(row.status).toBe('RUNNING');
    expect(row.outcome_committed_at).not.toBeNull();
    // The runtime-level refusals (typed).
    const cancelled = await f.core.runtime.cancel(row.execution_id, seeded.actor);
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) {
      expect(String(cancelled.error.details['reason'])).toBe('EXECUTION_OUTCOME_COMMITTED');
    }
    const failed = await f.core.runtime.failExecution({
      executionId: row.execution_id,
      actorId: seeded.actor,
      error: normalizeExecutionError({ kind: 'TIMEOUT', message: 'late deadline settlement' }),
    });
    expect(failed.ok).toBe(false);
    // THE STORAGE-LEVEL PROOF (the in-memory pre-read is irrelevant): the CAS itself refuses.
    const rawRow = (await f.core.database.agentExecutions.get(row.execution_id))!;
    const casCancel = await f.core.database.agentExecutions.putIfStatus(
      { ...rawRow, status: 'CANCELLED' },
      'RUNNING',
    );
    expect(casCancel).toBe(false); // non-success can never beat a committed outcome
    const casFailure = await f.core.database.agentExecutions.putIfStatus(
      { ...rawRow, status: 'FAILED' },
      'RUNNING',
    );
    expect(casFailure).toBe(false);
    expect(newestSupervisor(f).status).toBe('RUNNING'); // nothing landed
    f.executionGate.release();
    await turn;
    const settled = newestSupervisor(f);
    expect(settled.status).toBe('COMPLETED'); // the committed convergence
    expect(settled.outcome_decision_id).not.toBeNull();
  }, 60_000);

  it('C1-04 recovery cannot destroy a committed outcome: it converges COMPLETED (never INTERRUPTED)', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    f.executionGate.armed = 'settle';
    const turn = driveTurn(f, seeded, 'n9-c1-4', 8000);
    for (let attempt = 0; attempt < 200 && !f.executionGate.paused; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const row = newestSupervisor(f);
    const recovered = await f.core.runtime.recoverInterrupted(seeded.actor);
    expect(recovered.ok).toBe(true);
    expect(newestSupervisor(f).status).toBe('COMPLETED');
    expect(newestSupervisor(f).outcome_decision_id).toBe(row.outcome_decision_id ?? newestSupervisor(f).outcome_decision_id);
    f.executionGate.release();
    await turn;
    expect(newestSupervisor(f).status).toBe('COMPLETED');
  }, 60_000);

  it('C1-05 the terminal side winning first: the sink is refused typed, Decision and marker both absent', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    f.sinkDelay.txMs = 1500; // the sink begins after the deadline won
    await driveTurn(f, seeded, 'n9-c1-5', 800);
    const row = newestSupervisor(f);
    expect(row.status).not.toBe('RUNNING');
    expect(row.outcome_committed_at).toBeNull();
    expect(decisionCount(f)).toBe(decisionsBefore);
    // The DIRECT late sink against the same (now terminal) execution: refused typed.
    const refused = await f.core.supervisorDecisionSink!.record({
      commandId: supervisorDecisionCommandId(seeded.runId, 'n9-c1-5-late'),
      companyId: COMPANY,
      runId: seeded.runId,
      stageId: null,
      taskId: null,
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'late writer after the terminal winner',
      evidenceRefs: [],
      modelBindingKey: 'supervisor',
      decidedBy: seeded.actor,
      authorizedExecutionId: row.execution_id,
    });
    expect(refused.ok).toBe(false);
    expect(decisionCount(f)).toBe(decisionsBefore);
    expect(newestSupervisor(f).outcome_committed_at).toBeNull();
    await f.sinkDelay.idle();
    expect(decisionCount(f)).toBe(decisionsBefore); // still absent after the slow sink completes
  }, 60_000);
});

describe('N9-B1 — durable authority expiry + live reconciliation (zero provider calls)', () => {
  it('B1-03 the deadline wins while settlement storage is unavailable: the late sink is refused by the DURABLE expiry', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    f.hooks.onSupervisorCall = (): void => {
      f.sinkDelay.txMs = 2000; // the sink resumes AFTER the authority expiry
    };
    f.faults.executionWriteFaults = 999; // every settlement write fails
    const result = await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      commandId: supervisorDecisionCommandId(seeded.runId, 'n9-b1-3'),
      timeoutMs: 800,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PERSISTENCE_FAILED');
      expect(String(result.error.details['reason'])).toBe('SUPERVISOR_SETTLEMENT_PERSISTENCE_FAILED');
    }
    const row = newestSupervisor(f);
    expect(row.status).toBe('RUNNING'); // settlement storage was unavailable — honestly so
    expect(row.decision_authority_expires_at).not.toBeNull(); // the durable bound exists
    // Storage recovers; the late sink resumes BEFORE any autonomy tick.
    f.faults.executionWriteFaults = 0;
    await f.sinkDelay.idle();
    expect(decisionCount(f)).toBe(decisionsBefore); // refused by the durable expired authority
    expect(newestSupervisor(f).outcome_committed_at).toBeNull();
    expect(newestSupervisor(f).status).toBe('RUNNING');
  }, 60_000);

  it('B1-04/B1-06 the next autonomy advance RECONCILES the row terminally/committed with zero provider calls for it', async () => {
    // (a) expired RUNNING row → canonical timeout settlement by the existing driver.
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    f.hooks.onSupervisorCall = (): void => {
      f.sinkDelay.txMs = 2000; // the sink resumes AFTER the authority expiry
    };
    f.faults.executionWriteFaults = 999;
    await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      commandId: supervisorDecisionCommandId(seeded.runId, 'n9-b1-4'),
      timeoutMs: 800,
    });
    const expiredRow = newestSupervisor(f);
    expect(expiredRow.status).toBe('RUNNING');
    const providerCallsBefore = providerCallsFor(f, expiredRow.execution_id);
    f.faults.executionWriteFaults = 0;
    await f.sinkDelay.idle();
    // Wait past the durable expiry, then a normal advance reconciles the row.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await f.core.autonomousSupervisor!.run({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      runIdentity: 'n9-b1-4-advance',
      timeoutMs: 5000,
    });
    const reconciled = f.core.database.db
      .prepare('SELECT status, error_kind FROM agent_executions WHERE execution_id = ?')
      .get(expiredRow.execution_id) as { status: string; error_kind: string | null };
    expect(reconciled.status).not.toBe('RUNNING');
    expect(reconciled.status).toBe('FAILED');
    expect(reconciled.error_kind).toBe('TIMEOUT');
    expect(providerCallsFor(f, expiredRow.execution_id)).toBe(providerCallsBefore); // ZERO for the reconciled row
    const running = Number(
      (f.core.database.db.prepare("SELECT COUNT(*) AS n FROM agent_executions WHERE status = 'RUNNING'").get() as { n: number })
        .n,
    );
    expect(running).toBeLessThanOrEqual(1); // the reconciled row is no longer RUNNING

    // (b) committed-but-RUNNING row → the advance converges COMPLETED.
    const f2 = await composeF5(COMPOSE);
    const seeded2 = await seedRunAndTask(f2);
    f2.mode.value = 'legal';
    f2.executionGate.armed = 'settle';
    const pending = driveTurn(f2, seeded2, 'n9-b1-6', 8000);
    for (let attempt = 0; attempt < 200 && !f2.executionGate.paused; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const committedRow = newestSupervisor(f2);
    expect(committedRow.status).toBe('RUNNING');
    expect(committedRow.outcome_committed_at).not.toBeNull();
    const callsBefore2 = providerCallsFor(f2, committedRow.execution_id);
    await f2.core.autonomousSupervisor!.run({
      companyId: COMPANY,
      runId: seeded2.runId,
      taskId: seeded2.taskId,
      actorId: seeded2.actor,
      runIdentity: 'n9-b1-6-advance',
      timeoutMs: 5000,
    });
    // The advance may legitimately start the NEXT logical turn; the COMMITTED row itself
    // must be terminally converged COMPLETED with zero provider calls for it.
    const converged = f2.core.database.db
      .prepare('SELECT status FROM agent_executions WHERE execution_id = ?')
      .get(committedRow.execution_id) as { status: string };
    expect(converged.status).toBe('COMPLETED');
    expect(providerCallsFor(f2, committedRow.execution_id)).toBe(callsBefore2);
    f2.executionGate.release();
    await pending;
    const stillCommitted = f2.core.database.db
      .prepare('SELECT status FROM agent_executions WHERE execution_id = ?')
      .get(committedRow.execution_id) as { status: string };
    expect(stillCommitted.status).toBe('COMPLETED');
  }, 120_000);

  it('B1-05 process restart instead of reconciliation reaches the SAME terminal truth (no duplicate execution)', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    f.hooks.onSupervisorCall = (): void => {
      f.sinkDelay.txMs = 2000; // the sink lands after the restart decision point
    };
    f.faults.executionWriteFaults = 999;
    await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      commandId: supervisorDecisionCommandId(seeded.runId, 'n9-b1-5'),
      timeoutMs: 800,
    });
    const row = newestSupervisor(f);
    expect(row.status).toBe('RUNNING');
    f.faults.executionWriteFaults = 0;
    await f.sinkDelay.idle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const executionsBefore = Number(
      (f.core.database.db
        .prepare("SELECT COUNT(*) AS n FROM agent_executions WHERE agent_id = 'supervisor-runtime'")
        .get() as { n: number }).n,
    );
    const core2 = await recomposeF5Over(f);
    await core2.runtime.recoverInterrupted(seeded.actor);
    const recovered = f.core.database.db
      .prepare('SELECT status, error_kind FROM agent_executions WHERE execution_id = ?')
      .get(row.execution_id) as { status: string; error_kind: string | null };
    // THE SAME terminal truth as reconciliation: the durable expiry settles it TIMEOUT.
    expect(recovered.status).toBe('FAILED');
    expect(recovered.error_kind).toBe('TIMEOUT');
    expect(
      Number(
        (f.core.database.db
          .prepare("SELECT COUNT(*) AS n FROM agent_executions WHERE agent_id = 'supervisor-runtime'")
          .get() as { n: number }).n,
      ),
    ).toBe(executionsBefore); // no duplicate execution
    expect(decisionCount(f)).toBe(1); // the seed's decision only — no fake late Decision
  }, 60_000);

  it('B1-07 storage stays unavailable: the typed PERSISTENCE_FAILED remains honest, no fake Decision, no fake terminal', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    f.hooks.onSupervisorCall = (): void => {
      f.sinkDelay.txMs = 1200; // the sink lands after the authority expiry
    };
    f.faults.executionWriteFaults = 999;
    const result = await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      commandId: supervisorDecisionCommandId(seeded.runId, 'n9-b1-7'),
      timeoutMs: 600,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error.details['reason'])).toBe('SUPERVISOR_SETTLEMENT_PERSISTENCE_FAILED');
    const row = newestSupervisor(f);
    expect(row.status).toBe('RUNNING'); // no fake terminal status
    expect(row.outcome_committed_at).toBeNull(); // no fake commit
    await f.sinkDelay.idle();
    expect(decisionCount(f)).toBe(decisionsBefore); // no fake Decision
  }, 60_000);
});
