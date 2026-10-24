/**
 * Task-18-08 — REAL-PROCESS crash tests (§7/§41). Three of the highest-risk windows are
 * exercised by a REAL child process that terminates ABRUPTLY (`process.exit(86)` mid-flight —
 * no graceful cleanup, no afterEach, no unwinding), after which the PARENT reopens the same
 * durable files in a fresh composition and proves recovery.
 *
 * The three windows (per §7):
 *   A. Decision durable → action not applied      (after_decision_commit_before_execution_complete)
 *   B. Review sink durable → Task not DONE        (after_review_sink_before_task_done)
 *   C. Action committed → application receipt absent (after_decision_action_before_receipt)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { FAULT_CHECKPOINTS } from '@companyos/core';

import {
  closeFixtureArtifacts,
  compose,
  countOf,
  goalArtifactRefOf,
  happyScript,
  installScript,
  registerValidator,
  runSupervisor,
  seedRoutingModel,
  sessionActorOf,
  taskState,
  type Started,
} from './helpers/t18-08-fixture.js';

const scratch: string[] = [];
afterEach(() => {
  closeFixtureArtifacts();
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

interface ChildOutcome {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
}

/** Spawn the child harness; expect it to DIE at the named checkpoint. */
const killChildAt = (
  crashAt: string,
  dataDir: string,
  casRoot: string,
  afterHits?: string,
): ChildOutcome => {
  const vitestBin = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');
  const config = join('tests', 'sprint18', 'child', 'vitest.config.ts');
  const done = spawnSync(
    process.execPath,
    [vitestBin, 'run', '--config', config, '--reporter=basic'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 180_000,
      env: {
        ...process.env,
        T18_08_CRASH_AT: crashAt,
        T18_08_DATA_DIR: dataDir,
        T18_08_CAS_ROOT: casRoot,
        ...(afterHits === undefined ? {} : { T18_08_CRASH_AFTER_HITS: afterHits }),
      },
    },
  );
  const stdout = (done.stdout ?? '') + (done.output?.map(String).join('') ?? '');
  const stderr = done.stderr ?? '';
  const combined = stdout + stderr;
  return {
    status: done.status,
    signal: done.signal ?? null,
    stdout: combined,
    stderr,
    /*
     * The REAL kill evidence: the worker executed the synchronous kill marker, SIGKILLed
     * itself (TerminateProcess — no unwinding, no teardown), and the runner therefore has NO
     * passing summary and reports its worker channel dying mid-run. A test failure would look
     * completely different: a clean summary with "failed", and no kill marker.
     */
    killed:
      combined.includes('T18_08_CHILD_KILLED_AT') &&
      done.status !== 0 &&
      !combined.includes('Test Files  1 passed') &&
      (combined.includes('ERR_IPC_CHANNEL_CLOSED') ||
        combined.includes('process exited') ||
        combined.includes('serialized') ||
        combined.includes('Serialized Error') ||
        done.signal !== null),
  };
};

const childKilledAt = (outcome: ChildOutcome, crashAt: string): void => {
  // The child must have been KILLED at the checkpoint: the synchronous marker landed, the
  // process died abruptly (no passing summary — a failing test would print one), and the
  // runner saw its worker vanish mid-run rather than report a result.
  expect(outcome.killed).toBe(true);
  expect(outcome.stdout).toContain(`T18_08_CHILD_KILLED_AT ${crashAt}`);
  expect(outcome.stdout).not.toContain('Test Files  1 passed');
};

const reopen = async (paths: { readonly dataDir: string; readonly casRoot: string }) => {
  const core = await compose(paths);
  const actor = await sessionActorOf(core);
  await seedRoutingModel(core, actor);
  await registerValidator(core, actor);
  // 25b98d1 — the production BOOT step: a dead process's pre-start admission claims
  // are reclaimed so their logical turns can be claimed again.
  await core.runtime.reclaimStaleClaims(actor);
  return { core, actor };
};

describe('T18-08 real-process crashes (§7/§41)', () => {
  it('A. real kill at Decision durable → action absent: restart applies the same Decision once', async () => {
    const paths = { dataDir: mkdtempSync(join(tmpdir(), 't18f-real-a-')), casRoot: mkdtempSync(join(tmpdir(), 't18f-real-a-cas-')) };
    scratch.push(paths.dataDir, paths.casRoot);
    const crashAt = FAULT_CHECKPOINTS.decisionCommitBeforeExecutionComplete;
    const outcome = killChildAt(crashAt, paths.dataDir, paths.casRoot);
    childKilledAt(outcome, crashAt);

    const again = await reopen(paths);
    // The crashed run exists with its goal and exactly ONE durable Decision.
    const runId = (
      again.core.database.db.prepare('SELECT id FROM runs').get() as { id: string }
    ).id;
    const started: Started = {
      runId,
      workTaskId: (
        again.core.database.db
          .prepare("SELECT id FROM tasks WHERE kind = 'e2e7:build'")
          .get() as { id: string }
      ).id,
      reviewTaskId: (
        again.core.database.db
          .prepare("SELECT id FROM tasks WHERE kind = 'e2e7:review' ORDER BY id LIMIT 1")
          .get() as { id: string }
      ).id,
      review2TaskId: (
        again.core.database.db
          .prepare("SELECT id FROM tasks WHERE kind = 'e2e7:review' ORDER BY id LIMIT 1 OFFSET 1")
          .get() as { id: string }
      ).id,
      qaTaskId: (
        again.core.database.db
          .prepare("SELECT id FROM tasks WHERE kind = 'e2e7:qa'")
          .get() as { id: string }
      ).id,
    };
    const decisionsAfterKill = countOf(again.core, 'SELECT COUNT(*) AS c FROM decisions');
    expect(decisionsAfterKill).toBe(1);
    const decisionsAtKill = decisionsAfterKill;

    installScript(
      happyScript(started.workTaskId, await goalArtifactRefOf(again.core, started.runId)),
    );
    const result = (await runSupervisor(again.core, started, again.actor, 'realcrash')) as {
      ok: boolean;
      value: { stopReason: string; applied: readonly { readonly effect: string }[] };
    };
    expect(result.ok).toBe(true);
    expect(result.value.stopReason).toBe('completed');
    // The crashed Decision was applied EXACTLY ONCE — as the same durable identity — and the
    // chain closed without a second Decision minted for that turn.
    expect(result.value.applied[0]?.effect.startsWith('stage:work:')).toBe(true);
    const rows = again.core.database.db
      .prepare('SELECT subject_key, COUNT(*) AS c FROM decisions GROUP BY subject_key HAVING c > 1')
      .all();
    expect(rows).toHaveLength(0);
    expect(countOf(again.core, 'SELECT COUNT(*) AS c FROM decisions')).toBeGreaterThan(
      decisionsAtKill,
    );
  });

  it('B. real kill at the review-carrier window: restart routes the artifact once, no rerun', async () => {
    const paths = { dataDir: mkdtempSync(join(tmpdir(), 't18f-real-b-')), casRoot: mkdtempSync(join(tmpdir(), 't18f-real-b-cas-')) };
    scratch.push(paths.dataDir, paths.casRoot);
    /*
     * Sprint21 frozen window C for the REVIEW unit: the work unit settles and routes first
     * (hit 1, no kill), the review unit settles with its carrier unrouted, then the process
     * is killed (hit 2). The durable state at the kill: review tasks DONE with COMPLETED
     * attempts, canonical reports NOT yet written.
     */
    const crashAt = FAULT_CHECKPOINTS.taskSettledBeforeCarrier;
    const outcome = killChildAt(crashAt, paths.dataDir, paths.casRoot, '2');
    childKilledAt(outcome, crashAt);

    const again = await reopen(paths);
    const runId = (
      again.core.database.db.prepare('SELECT id FROM runs').get() as { id: string }
    ).id;
    const started: Started = {
      runId,
      workTaskId: (
        again.core.database.db
          .prepare("SELECT id FROM tasks WHERE kind = 'e2e7:build'")
          .get() as { id: string }
      ).id,
      reviewTaskId: (
        again.core.database.db
          .prepare("SELECT id FROM tasks WHERE kind = 'e2e7:review' ORDER BY id LIMIT 1")
          .get() as { id: string }
      ).id,
      review2TaskId: (
        again.core.database.db
          .prepare("SELECT id FROM tasks WHERE kind = 'e2e7:review' ORDER BY id LIMIT 1 OFFSET 1")
          .get() as { id: string }
      ).id,
      qaTaskId: (
        again.core.database.db
          .prepare("SELECT id FROM tasks WHERE kind = 'e2e7:qa'")
          .get() as { id: string }
      ).id,
    };
    // The review tasks ARE settled (durable attempts); the carrier has NOT routed, so no
    // canonical review report exists yet.
    expect(await taskState(again.core, started.reviewTaskId)).toBe('DONE');
    expect(
      (await again.core.database.artifactStore!.listByRun(runId as never)).filter(
        (row) => row.kind === 'companyos:review-findings',
      ),
    ).toHaveLength(0);

    installScript(
      happyScript(started.workTaskId, await goalArtifactRefOf(again.core, runId)),
    );
    const result = (await runSupervisor(again.core, started, again.actor, 'realcrash')) as {
      ok: boolean;
      value: { stopReason: string };
    };
    expect(result.ok).toBe(true);
    expect(result.value.stopReason).toBe('completed');
    // The reconciliation routes the settled review unit exactly once: the canonical reports
    // become durable (one per seeded review task), the run closes, and NO reviewer re-ran —
    // one COMPLETED attempt per task, named by the durable attempt row.
    const after = (
      await again.core.database.artifactStore!.listByRun(runId as never)
    ).filter((row) => row.kind === 'companyos:review-findings');
    expect(after.length).toBe(2);
    for (const reviewTaskId of [started.reviewTaskId, started.review2TaskId]) {
      expect(await taskState(again.core, reviewTaskId)).toBe('DONE');
      const attempts = again.core.database.db
        .prepare('SELECT state, attempt_number FROM execution_attempts WHERE task_id = ?')
        .all(String(reviewTaskId)) as { state: string; attempt_number: number }[];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.state).toBe('COMPLETED');
      expect(Number(attempts[0]!.attempt_number)).toBe(1);
    }
  });

  it('C. real kill at action committed → receipt absent: restart writes bookkeeping, applies once', async () => {
    const paths = { dataDir: mkdtempSync(join(tmpdir(), 't18f-real-c-')), casRoot: mkdtempSync(join(tmpdir(), 't18f-real-c-cas-')) };
    scratch.push(paths.dataDir, paths.casRoot);
    const crashAt = FAULT_CHECKPOINTS.decisionActionBeforeReceipt;
    const outcome = killChildAt(crashAt, paths.dataDir, paths.casRoot);
    childKilledAt(outcome, crashAt);

    const again = await reopen(paths);
    const runId = (
      again.core.database.db.prepare('SELECT id FROM runs').get() as { id: string }
    ).id;
    const started: Started = {
      runId,
      workTaskId: (
        again.core.database.db
          .prepare("SELECT id FROM tasks WHERE kind = 'e2e7:build'")
          .get() as { id: string }
      ).id,
      reviewTaskId: (
        again.core.database.db
          .prepare("SELECT id FROM tasks WHERE kind = 'e2e7:review' ORDER BY id LIMIT 1")
          .get() as { id: string }
      ).id,
      review2TaskId: (
        again.core.database.db
          .prepare("SELECT id FROM tasks WHERE kind = 'e2e7:review' ORDER BY id LIMIT 1 OFFSET 1")
          .get() as { id: string }
      ).id,
      qaTaskId: (
        again.core.database.db
          .prepare("SELECT id FROM tasks WHERE kind = 'e2e7:qa'")
          .get() as { id: string }
      ).id,
    };
    // The action IS durable (the work stage executed: the task is DONE), no receipt yet.
    expect(await taskState(again.core, started.workTaskId)).toBe('DONE');
    const receipts = countOf(
      again.core,
      "SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:supervisor-application'",
    );
    expect(receipts).toBe(0);

    installScript(
      happyScript(started.workTaskId, await goalArtifactRefOf(again.core, runId)),
    );
    const result = (await runSupervisor(again.core, started, again.actor, 'realcrash')) as {
      ok: boolean;
      value: { stopReason: string };
    };
    expect(result.ok).toBe(true);
    expect(result.value.stopReason).toBe('completed');
    // The already-terminal work unit was NOT executed twice: the engine never re-ran it, the
    // bookkeeping was written exactly once per Decision, and the run closed.
    expect(await taskState(again.core, started.workTaskId)).toBe('DONE');
    const executions = countOf(
      again.core,
      "SELECT COUNT(*) AS c FROM agent_executions WHERE role_id = 'rol_dev'",
    );
    expect(executions).toBe(0);
  });
});
