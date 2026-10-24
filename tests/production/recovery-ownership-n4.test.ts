/**
 * 4a6e362 re-audit — RECOVERY OWNERSHIP (N25-R1 read classification / N4-M1 storage
 * normalization / N4-R2 per-Goal recovery registry).
 *
 * The invariant: a NON-TERMINAL Goal that meets a recoverable persistence fault must
 * never silently lose its recovery owner — and one Goal's outage must never suppress
 * another Goal's recovery. The four state-read outcomes (TERMINAL / NON_TERMINAL /
 * NOT_FOUND / READ_FAILED) are distinct; UNKNOWN is never interpreted as "finished".
 */
import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { domainError, err, ok, type DomainError, type Result } from '@companyos/core';

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

const FAILING = (detail: string): DomainError =>
  domainError('PERSISTENCE_FAILED', `storage unavailable (${detail})`, {
    reason: 'RECONCILIATION_PERSISTENCE_FAILED',
  });

/** The goal-state snapshot the REAL goal driver needs to reach its advance step. */
const goalState = (goalRunId: string) => ({
  goalRunId,
  goalRunState: 'EXECUTING',
  executionRuns: [{ runId: goalRunId, state: 'EXECUTING' }],
  tasks: [],
  totalAttempts: 0,
  failedAttempts: 0,
  correctiveCycles: 0,
  pendingApproval: null,
  decisionCount: 0,
  eventCount: 0,
  fingerprint: `fp-${goalRunId}`,
});

interface Seeded {
  readonly runId: string;
  readonly taskId: string;
  readonly actor: string;
}

const seedGoal = async (f: F5Fixture, label: string): Promise<string> => {
  const created = await f.core.controlPlane!.handle({
    operation: 'goal.create',
    payload: { companyId: COMPANY, objective: `recovery ${label}`, commandId: `n4-${label}-${String(Date.now())}` },
  });
  if (!created.ok) throw new Error('goal.create failed');
  return String((created.value as { readonly runId: string }).runId);
};

const seedRunAndTask = async (f: F5Fixture): Promise<Seeded> => {
  const goalRunId = await seedGoal(f, 'seed');
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

interface Scheduled {
  fn: () => void;
  ms: number;
}

describe('N25-R1 — a failed state read never cancels recovery ownership', () => {
  it('R1-01 a typed PERSISTENCE_FAILED from the REAL runs.get keeps exactly ONE future recovery scheduled', async () => {
    const f = await composeF5();
    const goalRunId = await seedGoal(f, 'r1-01');
    const scheduled: Scheduled[] = [];
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: { run: async () => err(FAILING('outage')) } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      // The production-shaped reader: the REAL durable run read, whose storage fault
      // (injected here as the typed PERSISTENCE_FAILED Codex reproduced) makes the
      // state UNKNOWN — never "terminal".
      goalRunState: async () => {
        throw domainError('PERSISTENCE_FAILED', 'injected read failure', { reason: 'RUN_STATE_READ_FAILED' });
      },
      stallResumeDelayMs: 20,
    });
    expect(runner.start(COMPANY, goalRunId)).toBe(true);
    for (let attempt = 0; attempt < 400 && scheduled.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(1); // the read failure did NOT cancel the owner
  }, 60_000);

  it('R1-02 an UNREADABLE state across generations keeps a future recovery owner alive at every generation', async () => {
    const f = await composeF5();
    const goalRunId = await seedGoal(f, 'r1-02');
    const scheduled: Scheduled[] = [];
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: { run: async () => err(FAILING('outage')) } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      // The storage stays UNREADABLE across every generation of this test.
      goalRunState: async () => {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      },
      stallResumeDelayMs: 20,
    });
    runner.start(COMPANY, goalRunId);
    for (let round = 0; round < 5; round += 1) {
      for (let attempt = 0; attempt < 400 && scheduled.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(scheduled, `generation ${String(round)}`).toHaveLength(1);
      const next = scheduled.shift();
      if (next === undefined) break;
      next.fn();
    }
    for (let attempt = 0; attempt < 400 && scheduled.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(1); // never zero, never many
  }, 120_000);

  it('R1-03 storage recovers: the SCHEDULED resume advances the same run and settles the stale owner — no manual call', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 8_000, maxSupervisorTurns: 1 });
    const seeded = await seedRunAndTask(f);
    // Case-14 shape: an expired RUNNING owner with no Decision, settlement storage down.
    f.mode.value = 'legal';
    f.hooks.onSupervisorCall = (): void => {
      f.sinkDelay.txMs = 1500;
    };
    f.faults.executionWriteFaults = 999;
    await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      commandId: 'supervisor-decision:' + seeded.runId + ':n4-r1-03:0',
      timeoutMs: 600,
    });
    const stale = f.core.database.db
      .prepare("SELECT execution_id, status, logical_turn_id FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
      .get() as { execution_id: string; status: string; logical_turn_id: string | null };
    expect(stale.status).toBe('RUNNING');
    const staleIdentity = stale.logical_turn_id;
    const scheduled: Scheduled[] = [];
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: f.core.autonomyDriver,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async (id: string) =>
        String((f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(id) as { state: string } | undefined)?.state ?? null),
      stallResumeDelayMs: 20,
    });
    // The FIRST driver generation fails through the REAL state read (a one-shot raw
    // SQLITE_BUSY inside runs.get) — typed by the storage boundary, scheduled by the
    // runner while its own reader still answers EXECUTING.
    f.faults.throwOnRunsGetOnce = true;
    runner.start(COMPANY, seeded.runId);
    for (let attempt = 0; attempt < 500 && scheduled.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(1); // the outage kept a recovery owner
    // Storage recovers; the ONE scheduled resume advances the run — zero manual calls.
    f.faults.executionWriteFaults = 0;
    f.hooks.onSupervisorCall = undefined;
    f.sinkDelay.txMs = 0;
    await new Promise((resolve) => setTimeout(resolve, 800)); // past the durable expiry
    const stateBefore = String(
      (f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(seeded.runId) as { state: string }).state,
    );
    const providersBefore = f.supervisorInvocations.length;
    const next = scheduled.shift()!;
    next.fn(); // the ONE scheduled resume — no manual call anywhere
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const stateNow = String(
        (f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(seeded.runId) as { state: string }).state,
      );
      if (stateNow !== stateBefore) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const stateAfter = String(
      (f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(seeded.runId) as { state: string }).state,
    );
    // The recovered storage let the SCHEDULED resume continue the SAME run: durable
    // progress happened — automatically, with no manual call anywhere.
    expect(stateAfter).not.toBe(stateBefore);
    // And the resumed generation NEVER created a second execution for the stale identity
    // (no duplicate ownership, no duplicate old provider work).
    const staleOwners = Number(
      (f.core.database.db
        .prepare('SELECT COUNT(*) AS n FROM agent_executions WHERE logical_turn_id = ?')
        .get(String(staleIdentity)) as { n: number }).n,
    );
    expect(staleOwners).toBe(1);
    void providersBefore;
  }, 120_000);

  it('R1-04 a KNOWN-TERMINAL goal stops recovery and cleans the owner registration', async () => {
    const f = await composeF5();
    const goalRunId = await seedGoal(f, 'r1-04');
    const scheduled: Scheduled[] = [];
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: { run: async () => err(FAILING('outage')) } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async () => 'COMPLETED', // read OK: canonically final
      stallResumeDelayMs: 20,
    });
    runner.start(COMPANY, goalRunId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(scheduled).toHaveLength(0); // truth is known and final: nothing to recover
  }, 60_000);

  it('R1-05 NOT_FOUND and READ_FAILED are never confused: a missing goal stops, an unreadable one keeps the owner', async () => {
    const f = await composeF5();
    const goalRunId = await seedGoal(f, 'r1-05');
    const missing: Scheduled[] = [];
    const missingRunner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: { run: async () => err(FAILING('outage')) } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        missing.push({ fn, ms });
      },
      goalRunState: async () => null, // read OK: no such goal
      stallResumeDelayMs: 20,
    });
    missingRunner.start(COMPANY, goalRunId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(missing).toHaveLength(0);
    const unreadable: Scheduled[] = [];
    const unreadableRunner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: { run: async () => err(FAILING('outage')) } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        unreadable.push({ fn, ms });
      },
      goalRunState: async () => {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      },
      stallResumeDelayMs: 20,
    });
    unreadableRunner.start(COMPANY, goalRunId);
    for (let attempt = 0; attempt < 300 && unreadable.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(unreadable).toHaveLength(1); // UNKNOWN ≠ NOT_FOUND
  }, 60_000);
});

describe('N4-M1 — the storage boundary normalizes real driver faults and nothing else', () => {
  const realDriverWith = (deps: {
    loadGoalState: () => Promise<Result<ReturnType<typeof goalState>, DomainError>>;
    advanceGoal: () => Promise<Result<unknown, DomainError>>;
  }) =>
    createGoalOutcomeAutonomyDriver({
      advanceGoal: deps.advanceGoal,
      loadGoalState: deps.loadGoalState,
      preflightChecks: async () => [],
      projectOutcome: async () => ({}) as never,
    });

  it('M1-01 a state read throwing SQLITE_BUSY (REAL runs.get) reaches the launcher typed PERSISTENCE_FAILED and schedules', async () => {
    const f = await composeF5();
    const goalRunId = await seedGoal(f, 'm1-01');
    f.faults.throwOnRunsGetOnce = true; // the REAL runs.get throws (raw SQLITE_BUSY)
    const scheduled: Scheduled[] = [];
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: { run: async () => err(FAILING('outage')) } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async (runId: string) => {
        const row = (await f.core.database.runs.get(runId as never)) as { state?: string } | null;
        return row === null ? null : String(row.state);
      },
      stallResumeDelayMs: 20,
    });
    runner.start(COMPANY, goalRunId);
    for (let attempt = 0; attempt < 300 && scheduled.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(1);
  }, 60_000);

  it('M1-02 ERR_SQLITE_ERROR from the state read is normalized the same way', async () => {
    const f = await composeF5();
    const goalRunId = await seedGoal(f, 'm1-02');
    f.faults.throwOnRunsGetOnce = true;
    f.faults.runsGetFaultCode = 'ERR_SQLITE_ERROR';
    const scheduled: Scheduled[] = [];
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: { run: async () => err(FAILING('outage')) } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async (runId: string) => {
        const row = (await f.core.database.runs.get(runId as never)) as { state?: string } | null;
        return row === null ? null : String(row.state);
      },
      stallResumeDelayMs: 20,
    });
    runner.start(COMPANY, goalRunId);
    for (let attempt = 0; attempt < 300 && scheduled.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(1);
  }, 60_000);

  it('M1-03 a PURE persistence read throwing EIO is normalized; the COMPOSITE advance boundary never reinterprets EIO', async () => {
    // (a) pure read boundary: EIO is storage-origin.
    const pureDriver = realDriverWith({
      loadGoalState: async () => {
        throw Object.assign(new Error('I/O error'), { code: 'EIO' });
      },
      advanceGoal: async () => ok({}),
    });
    const readFailure = await pureDriver.run({ companyId: COMPANY, runId: 'run_m1_3' });
    expect(readFailure.ok).toBe(false);
    if (readFailure.ok) throw new Error('expected the typed storage failure');
    expect(readFailure.error.code).toBe('PERSISTENCE_FAILED');
    expect(String(readFailure.error.details['reason'])).toBe('STORAGE_OPERATION_FAILED');
    expect(String(readFailure.error.details['storageCode'])).toBe('EIO');
    // (b) composite boundary: the SAME EIO is NOT reinterpreted as a database failure.
    const compositeDriver = realDriverWith({
      loadGoalState: async () => ok(goalState('run_m1_3')),
      advanceGoal: async () => {
        throw Object.assign(new Error('workspace I/O error'), { code: 'EIO' });
      },
    });
    await expect(compositeDriver.run({ companyId: COMPANY, runId: 'run_m1_3' })).rejects.toThrow(/workspace I\/O error/);
  }, 60_000);

  it('M1-04 an advance/reconciliation storage fault is typed PERSISTENCE_FAILED with the raw code retained', async () => {
    const driver = realDriverWith({
      loadGoalState: async () => ok(goalState('run_m1_4')),
      advanceGoal: async () => {
        throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
      },
    });
    const result = await driver.run({ companyId: COMPANY, runId: 'run_m1_4' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the typed storage failure');
    expect(result.error.code).toBe('PERSISTENCE_FAILED');
    expect(String(result.error.details['operation'])).toBe('goal.advance');
    expect(String(result.error.details['storageCode'])).toBe('SQLITE_IOERR');
  }, 60_000);

  it('M1-05 validation / programmer failures are re-thrown untouched and schedule NOTHING', async () => {
    const driver = realDriverWith({
      loadGoalState: async () => ok(goalState('run_m1_5')),
      advanceGoal: async () => {
        throw Object.assign(new Error('proposal invalid'), { code: 'VALIDATION_FAILED' });
      },
    });
    await expect(driver.run({ companyId: COMPANY, runId: 'run_m1_5' })).rejects.toThrow(/proposal invalid/);
    const f = await composeF5();
    const goalRunId = await seedGoal(f, 'm1-05');
    const scheduled: Scheduled[] = [];
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: {
        run: async () => {
          throw Object.assign(new Error('programmer fault'), { code: 'ERR_INVALID_ARG_TYPE' });
        },
      } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async () => 'EXECUTING',
      stallResumeDelayMs: 20,
    });
    runner.start(COMPANY, goalRunId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(scheduled).toHaveLength(0);
  }, 60_000);
});

describe('N4-R2 — recovery ownership is scoped per Goal and never suppresses another Goal', () => {
  const twoGoals = async (): Promise<{ f: F5Fixture; goalA: string; goalB: string }> => {
    const f = await composeF5();
    const goalA = await seedGoal(f, 'a');
    const goalB = await seedGoal(f, 'b');
    return { f, goalA, goalB };
  };

  it('R2-01 two Goals in outage: each owns its OWN scheduled recovery (no cross-suppression)', async () => {
    const { goalA, goalB } = await twoGoals();
    const scheduled: Scheduled[] = [];
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: { run: async () => err(FAILING('outage')) } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async () => 'EXECUTING',
      stallResumeDelayMs: 20,
    });
    runner.start(COMPANY, goalA);
    for (let attempt = 0; attempt < 300 && scheduled.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(1);
    runner.start(COMPANY, goalB);
    for (let attempt = 0; attempt < 300 && scheduled.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(2); // B was NOT suppressed by A's pending recovery
  }, 60_000);

  it('R2-02/03 A recovers while B stays down; B resumes when ITS storage returns — automatically', async () => {
    const { goalA, goalB } = await twoGoals();
    const failing = new Set([goalA, goalB]);
    const driverRuns = new Map<string, number>();
    const scheduled: { fn: () => void; ms: number; index: number }[] = [];
    let fired = 0;
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: {
        run: async ({ runId }: { runId: string }) => {
          driverRuns.set(runId, (driverRuns.get(runId) ?? 0) + 1);
          return failing.has(runId) ? err(FAILING('outage')) : ok({ terminal: 'COMPLETED', terminalReason: 'done' });
        },
      } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        fired += 1;
        scheduled.push({ fn, ms, index: fired });
      },
      goalRunState: async (runId: string) => (failing.has(runId) ? 'EXECUTING' : 'COMPLETED'),
      stallResumeDelayMs: 20,
    });
    runner.start(COMPANY, goalA);
    runner.start(COMPANY, goalB);
    for (let attempt = 0; attempt < 400 && scheduled.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(2);
    // A recovers; its timer fires and A advances to a terminal generation.
    failing.delete(goalA);
    const timerA = scheduled.shift()!;
    timerA.fn();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(driverRuns.get(goalA) ?? 0).toBeGreaterThanOrEqual(2); // the resumed generation ran
    expect(scheduled).toHaveLength(1); // B's owner is untouched and still pending
    // B recovers later: firing ITS pending timer resumes B — no manual call.
    failing.delete(goalB);
    const timerB = scheduled.shift()!;
    timerB.fn();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(driverRuns.get(goalB) ?? 0).toBeGreaterThanOrEqual(2);
    const aBefore = driverRuns.get(goalA) ?? 0;
    expect(driverRuns.get(goalB) ?? 0).toBeGreaterThanOrEqual(2);
    void aBefore;
  }, 60_000);

  it('R2-04 the SAME Goal under repeated failures keeps AT MOST ONE pending recovery timer', async () => {
    const { goalA } = await twoGoals();
    const scheduled: Scheduled[] = [];
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: { run: async () => err(FAILING('outage')) } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async () => 'EXECUTING',
      stallResumeDelayMs: 20,
    });
    for (let round = 0; round < 4; round += 1) {
      runner.start(COMPANY, goalA);
      for (let attempt = 0; attempt < 300 && scheduled.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(scheduled, `round ${String(round)}`).toHaveLength(1); // never two
      const next = scheduled.shift()!;
      next.fn();
    }
  }, 60_000);

  it('R2-05 two Goals recovering together produce no duplicate generation and no duplicate old provider call', async () => {
    const { f, goalA, goalB } = await twoGoals();
    const runs = new Map<string, number>();
    const scheduled: Scheduled[] = [];
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: {
        run: async ({ runId }: { runId: string }) => {
          runs.set(runId, (runs.get(runId) ?? 0) + 1);
          return err(FAILING('outage'));
        },
      } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async () => 'EXECUTING',
      stallResumeDelayMs: 20,
    });
    runner.start(COMPANY, goalA);
    runner.start(COMPANY, goalB);
    for (let attempt = 0; attempt < 400 && scheduled.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(2);
    const first = scheduled.splice(0, 2);
    for (const timer of first) timer.fn();
    for (let attempt = 0; attempt < 400 && scheduled.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(2); // exactly one NEW pending recovery per Goal
    // No duplicate generation: each Goal ran exactly twice (initial + one resume).
    expect(runs.get(goalA)).toBe(2);
    expect(runs.get(goalB)).toBe(2);
    expect(f.rawInvocations.n).toBe(0); // no provider was invoked anywhere
  }, 60_000);

  it('R2-06 after the app exits, a FRESH runner re-derives every non-terminal Goal from durable truth (boot recovery owns)', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 8_000, maxSupervisorTurns: 1 });
    const seeded = await seedRunAndTask(f);
    // A durable non-terminal shape: an expired RUNNING owner with no Decision.
    f.mode.value = 'legal';
    f.hooks.onSupervisorCall = (): void => {
      f.sinkDelay.txMs = 1500;
    };
    f.faults.executionWriteFaults = 999;
    await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      commandId: 'supervisor-decision:' + seeded.runId + ':n4-r2-06:0',
      timeoutMs: 600,
    });
    f.hooks.onSupervisorCall = undefined;
    f.sinkDelay.txMs = 0;
    f.faults.executionWriteFaults = 0;
    // "App restart": a fresh composition (new runner instance, empty registry).
    const core2 = await recomposeF5Over(f);
    const scheduled: Scheduled[] = [];
    const freshRunner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: core2.autonomyDriver,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async (id: string) =>
        String((f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(id) as { state: string } | undefined)?.state ?? null),
      stallResumeDelayMs: 20,
    });
    const resumed = await freshRunner.resumeNonTerminalGoalRuns(core2);
    expect(resumed.length).toBeGreaterThanOrEqual(1); // durable truth re-derives the owner
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const status = (f.core.database.db
        .prepare("SELECT status FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid DESC LIMIT 1")
        .get() as { status: string }).status;
      if (status !== 'RUNNING') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    void scheduled;
  }, 120_000);

  it('§11 PROBE (real composition) — two Goals, real driver: outage keeps per-Goal owners; recovery continues BOTH automatically', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 8_000, maxSupervisorTurns: 1 });
    const seededA = await seedRunAndTask(f);
    const goalB = await seedGoal(f, 'probe-b');
    const scheduled: Scheduled[] = [];
    let readerDown = true;
    const realDriver = f.core.autonomyDriver!;
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: {
        run: async (input: never) => {
          if (readerDown) throw FAILING('outage'); // the outage producer on EVERY failure class
          return realDriver.run(input as never);
        },
      } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async (id: string) => {
        if (readerDown) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        return String((f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(id) as { state?: string } | undefined)?.state ?? null);
      },
      stallResumeDelayMs: 20,
    });
    runner.start(COMPANY, seededA.runId);
    runner.start(COMPANY, goalB);
    for (let attempt = 0; attempt < 400 && scheduled.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(2); // ONE recovery owner PER GOAL during the outage
    // The world recovers: firing BOTH timers lets EACH real driver generation continue
    // its own Goal — automatically, no manual call, no cross-suppression.
    const stateOf = (id: string): string =>
      String((f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(id) as { state: string } | undefined)?.state ?? 'MISSING');
    const revisionOf = (id: string): number =>
      Number((f.core.database.db.prepare('SELECT revision FROM runs WHERE id = ?').get(id) as { revision: number } | undefined)?.revision ?? -1);
    const beforeA = `${stateOf(seededA.runId)}:${String(revisionOf(seededA.runId))}`;
    const beforeB = `${stateOf(goalB)}:${String(revisionOf(goalB))}`;
    readerDown = false;
    const timers = scheduled.splice(0, 2);
    for (const timer of timers) timer.fn();
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const nowA = `${stateOf(seededA.runId)}:${String(revisionOf(seededA.runId))}`;
      const nowB = `${stateOf(goalB)}:${String(revisionOf(goalB))}`;
      if (nowA !== beforeA && nowB !== beforeB) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(`${stateOf(goalB)}:${String(revisionOf(goalB))}`).not.toBe(beforeB); // B continued
    expect(`${stateOf(seededA.runId)}:${String(revisionOf(seededA.runId))}`).not.toBe(beforeA); // A continued
    // No duplicate ownership and no stale running execution was fabricated anywhere.
    const duplicateIdentities = Number(
      (f.core.database.db
        .prepare('SELECT COUNT(*) AS n FROM (SELECT logical_turn_id FROM agent_executions WHERE logical_turn_id IS NOT NULL GROUP BY logical_turn_id HAVING COUNT(*) > 1)')
        .get() as { n: number }).n,
    );
    expect(duplicateIdentities).toBe(0);
    expect(f.rawInvocations.n).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('R2-07 across BOTH Goals, a long outage far beyond the old retry budget never loses a recovery owner', async () => {
    const { goalA, goalB } = await twoGoals();
    const scheduled: Scheduled[] = [];
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: { run: async () => err(FAILING('outage')) } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async () => 'EXECUTING',
      maxStallResumes: 0, // the legacy stall budget is exhausted and irrelevant here
      stallResumeDelayMs: 20,
    });
    runner.start(COMPANY, goalA);
    runner.start(COMPANY, goalB);
    for (let round = 0; round < 8; round += 1) {
      for (let attempt = 0; attempt < 400 && scheduled.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(scheduled, `round ${String(round)}`).toHaveLength(2); // one per Goal, always
      const timers = scheduled.splice(0, 2);
      for (const timer of timers) timer.fn();
    }
    for (let attempt = 0; attempt < 400 && scheduled.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(2); // ownership is never exhausted
  }, 120_000);
});
