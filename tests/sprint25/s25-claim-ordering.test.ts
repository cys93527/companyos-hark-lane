/**
 * Sprint25 V2 — the CANONICAL EXECUTION-CLAIM ORDERING proof (Boss corrective §7-§14).
 *
 * The claim under test, distinguished exactly as the order requires:
 *
 *   A. the COMPANYOS EXECUTION CLAIM — Transaction A commits Task → RUNNING,
 *      ExecutionAttempt → ACTIVE, Task.attempts += 1 (the frozen Sprint21 owner);
 *   B. the PROVIDER-SIDE DISPATCH CLAIM — the subordinate provider_dispatches row
 *      (DISPATCHED/PUBLISHED), which is NOT an execution truth.
 *
 * The required order: canonical claim (A) COMMIT → Sprint25 preflight → provider
 * invocation (B and the external call, outside any write transaction) → canonical
 * settlement. The preflight lives INSIDE the stage handler, so it runs strictly
 * AFTER Transaction A and strictly BEFORE the provider.
 *
 * Every proof below drives the REAL WorkflowEngine over the REAL durable stores
 * with the REAL dispatch orchestration; only the external provider is scripted.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FAULT_CHECKPOINTS,
  FixedClock,
  SequenceIdFactory,
  createTask,
  createWorkflowRun,
  executionAttemptIdOf,
} from '@companyos/core';
import {
  createExecutorProviderRegistry,
  createStaticRegistry,
  createWorkflowEngine,
  type ExecutorProvider,
  type ExecutorProviderOutcome,
  type StageExecutionContext,
  type StageHandlerReturn,
  type TypedExecutorConfig,
  type WorkflowEngine,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { createProviderDispatchExecution } from '../../apps/desktop/src/executor/provider-dispatch.js';
import { scriptedExecutorConfig } from '../support/provider-safety-fixture.js';

const KIND = 'task.provider-order';
const COMPANY = 'cmp_1';
const STAGE = 'stg_1' as never;
const EPOCH = Date.parse('2026-05-01T00:00:00.000Z');

const dirs: string[] = [];
const dbs: DurableDatabase[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 's25o-'));
  dirs.push(dir);
  return dir;
};

/** What the durable truth looked like at the INSTANT the preflight ran. */
interface PreflightObservation {
  readonly taskState: string | null;
  readonly taskAttempts: number | null;
  readonly attemptState: string | null;
}

interface HarnessOptions {
  /** Controls the preflight outcome: null = config-invalid refusal. */
  readonly configOf?: () => TypedExecutorConfig | null;
  readonly workspaceRoot?: string | null;
  readonly maxAttempts?: number;
  readonly crashAt?: string;
  /** Runs DURING the provider invocation (the outside-write-transaction proof). */
  readonly onProviderStart?: (database: DurableDatabase) => Promise<void>;
}

interface Harness {
  readonly dataDir: string;
  readonly database: DurableDatabase;
  readonly runId: string;
  readonly taskId: string;
  readonly observations: PreflightObservation[];
  providerCalls(): number;
  drive(): ReturnType<WorkflowEngine['drive']>;
  advanceStage(): Promise<unknown>;
}

const buildEngine = (
  database: DurableDatabase,
  options: HarnessOptions,
  observations: PreflightObservation[],
  providerCalls: { count: number },
  shared: { readonly ids: SequenceIdFactory; readonly clock: FixedClock } = {
    ids: new SequenceIdFactory(),
    clock: new FixedClock(EPOCH),
  },
): WorkflowEngine => {
  const provider: ExecutorProvider = {
    descriptor: { providerKey: 'ordering', capabilities: ['timeout', 'structured-output'] },
    async start(): Promise<ExecutorProviderOutcome> {
      providerCalls.count += 1;
      await options.onProviderStart?.(database);
      return {
        kind: 'succeeded',
        exitCode: 0,
        stdoutText: 'ordering-proof',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
    },
  };

  const handler = {
    id: `provider.dispatch:${KIND}`,
    execute: async (context: StageExecutionContext): Promise<StageHandlerReturn> => {
      const runId = String(context.runId);
      const taskId = String(context.taskId);
      const attemptNumber = Number(context.attempt);
      const attemptId = executionAttemptIdOf({ companyId: COMPANY, runId, taskId, attemptNumber });
      const dispatch = createProviderDispatchExecution({
        registry: createExecutorProviderRegistry([provider]),
        dispatches: database.providerDispatches,
        clock: { nowIso: () => new Date().toISOString() },
        workspaceOf: () => options.workspaceRoot ?? null,
        requiredCapabilitiesOf: () => ['timeout'],
        workPackageTextOf: async () => 'Do the ordering proof work.',
        /*
         * The PREFLIGHT PROBE: `configOf` feeds the preflight's config-valid stage, so
         * reading the durable truth here observes it at the instant the preflight runs —
         * after the engine's claim transaction, before any provider effect.
         */
        configOf: (providerKey: string) => {
          const taskRow = database.db
            .prepare('SELECT state, attempts FROM tasks WHERE id = ?')
            .get(taskId) as { readonly state: string; readonly attempts: number } | undefined;
          const attemptRow = database.db
            .prepare('SELECT state FROM execution_attempts WHERE id = ?')
            .get(attemptId) as { readonly state: string } | undefined;
          observations.push({
            taskState: taskRow?.state ?? null,
            taskAttempts: taskRow === undefined ? null : Number(taskRow.attempts),
            attemptState: attemptRow?.state ?? null,
          });
          return options.configOf === undefined ? scriptedExecutorConfig(providerKey) : options.configOf();
        },
        authorizationOf: async () => ({
          present: true,
          source: 'composition-policy' as const,
          reference: 'provider-registration:ordering',
        }),
      });
      const result = await dispatch.execute(
        {
          companyId: COMPANY,
          runId,
          taskId,
          attemptId,
          attemptNumber,
          roleId: 'rol.provider',
          taskKind: KIND,
        },
        'ordering',
      );
      return result.output;
    },
  };

  return createWorkflowEngine({
    ids: shared.ids,
    clock: shared.clock,
    runs: database.runs,
    tasks: database.tasks,
    approvals: database.approvals,
    events: database.events,
    ledger: database.ledger,
    unitOfWork: database.unitOfWork,
    handlers: createStaticRegistry({ [KIND]: handler }),
    executionAttempts: database.executionAttempts,
    runtimeInstanceId: 'rt_s25_order',
    ...(options.crashAt === undefined
      ? {}
      : {
          faultCheckpoints: {
            checkpoint: (name: string) =>
              name === options.crashAt ? Promise.reject(new Error(`crash:${name}`)) : Promise.resolve(),
          },
        }),
  });
};

/** Seeds a run + one provider-backed task over the real durable stores. */
const seedRunAndTask = async (
  database: DurableDatabase,
  options: { readonly maxAttempts?: number } = {},
): Promise<{ readonly runId: string; readonly taskId: string }> => {
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();
  const runCreated = createWorkflowRun({
    companyId: COMPANY as never,
    workflowId: 'wfl_1' as never,
    templateId: 'tpl_1' as never,
    versionId: 'ver_1' as never,
    snapshotId: 'snp_1' as never,
    startedBy: 'user_owner',
    now: clock.nowIso(),
    ids,
  });
  if (!runCreated.ok) throw new Error(runCreated.error.message);
  await database.runs.put(runCreated.value);
  const taskCreated = createTask({
    runId: runCreated.value.id as never,
    stageId: STAGE,
    roleId: 'rol_1' as never,
    kind: KIND,
    maxAttempts: options.maxAttempts ?? 1,
    inputs: {},
    now: clock.nowIso(),
    ids,
  });
  if (!taskCreated.ok) throw new Error(taskCreated.error.message);
  const written = await database.tasks.putGuarded(taskCreated.value);
  if (!written.ok) throw new Error(written.error.message);
  return { runId: runCreated.value.id, taskId: taskCreated.value.id };
};

const makeHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const dataDir = tempDir();
  const database = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: ['core', 'engine'] });
  dbs.push(database);
  const observations: PreflightObservation[] = [];
  const providerCalls = { count: 0 };
  const { runId, taskId } = await seedRunAndTask(database, { maxAttempts: options.maxAttempts });
  const engine = buildEngine(database, options, observations, providerCalls);
  return {
    dataDir,
    database,
    runId,
    taskId,
    observations,
    providerCalls: () => providerCalls.count,
    drive: () => engine.drive(runId, { stage: { stageId: STAGE, taskIds: [taskId as never] }, maxSteps: 6 }),
    /*
     * The direct stage-execution port — the seam the supervisor uses per round. A
     * RETRY round is a NEW advance call, exactly like any executor failure retry.
     */
    advanceStage: () => engine.advance({ runId: runId as never, stageId: STAGE, taskIds: [taskId as never], snapshot: null } as never),
  };
};

const count = (database: DurableDatabase, sql: string, ...params: readonly (string | number)[]): number =>
  Number((database.db.prepare(sql).get(...(params as never[])) as { readonly c: number }).c);

const taskRow = (database: DurableDatabase, taskId: string): { state: string; attempts: number } =>
  database.db.prepare('SELECT state, attempts FROM tasks WHERE id = ?').get(taskId) as { state: string; attempts: number };

describe('S25 claim ordering — canonical claim BEFORE preflight (Boss §9/§12)', () => {
  it('1/3. the durable claim is committed BEFORE the preflight runs (Task RUNNING, attempt ACTIVE, attempts=1)', async () => {
    const harness = await makeHarness({ workspaceRoot: tempDir() });
    const driven = await harness.drive();
    expect(driven.ok).toBe(true);
    expect(harness.providerCalls()).toBe(1);
    expect(harness.observations.length).toBe(1);
    const seen = harness.observations[0]!;
    // At the instant the preflight consulted the configuration, Transaction A was
    // already durable: the Task was RUNNING with attempts consumed, and the
    // ExecutionAttempt row existed in ACTIVE state.
    expect(seen.taskState).toBe('RUNNING');
    expect(seen.taskAttempts).toBe(1);
    expect(seen.attemptState).toBe('ACTIVE');
    // Exactly ONE execution-attempt truth was created — no second, no pre-attempt.
    expect(count(harness.database, 'SELECT COUNT(*) AS c FROM execution_attempts')).toBe(1);
  });

  it('2/5. a preflight failure invokes the provider ZERO times and creates NO provider dispatch', async () => {
    const harness = await makeHarness({
      workspaceRoot: tempDir(),
      configOf: () => null, // config-invalid: the preflight refuses
    });
    const driven = await harness.drive();
    expect(driven.ok).toBe(true);
    if (driven.ok) expect(driven.value.run.state).toBe('FAILED');
    expect(harness.providerCalls()).toBe(0);
    // Claim A exists (the canonical attempt performed the preflight) ...
    expect(count(harness.database, 'SELECT COUNT(*) AS c FROM execution_attempts')).toBe(1);
    expect(harness.observations[0]!.attemptState).toBe('ACTIVE');
    // ... but claim B (the provider-side dispatch row) was never created.
    expect(count(harness.database, 'SELECT COUNT(*) AS c FROM provider_dispatches')).toBe(0);
  });

  it('4. preflight failures consume attempts under the FROZEN retry semantics (no hidden pre-attempt phase)', async () => {
    const harness = await makeHarness({
      workspaceRoot: tempDir(),
      maxAttempts: 2,
      configOf: () => null,
    });
    // First drive: attempt 1 fails the preflight and the task goes to RETRY — the
    // FROZEN retry semantics, exactly as any executor failure would.
    const firstDrive = await harness.drive();
    expect(firstDrive.ok).toBe(true);
    expect(taskRow(harness.database, harness.taskId).state).toBe('READY'); // RETRY event → back to READY
    // The retry round is a NEW stage execution (the supervisor's per-round seam):
    // attempt 2 fails the same preflight and exhausts the task.
    await harness.advanceStage();
    // Two preflight refusals = two real attempts, numbered per the frozen owner.
    expect(harness.observations.length).toBe(2);
    expect(harness.observations[0]!.taskAttempts).toBe(1);
    expect(harness.observations[1]!.taskAttempts).toBe(2);
    expect(count(harness.database, 'SELECT COUNT(*) AS c FROM execution_attempts')).toBe(2);
    const finalTask = taskRow(harness.database, harness.taskId);
    expect(Number(finalTask.attempts)).toBe(2);
    expect(finalTask.state).toBe('FAILED');
    expect(harness.providerCalls()).toBe(0);
  });

  it('6. the provider invocation happens OUTSIDE any SQLite write transaction', async () => {
    let writeDuringProvider: string | null = null;
    const harness = await makeHarness({
      workspaceRoot: tempDir(),
      onProviderStart: (database) => {
        /*
         * A SECOND connection over the SAME file, opened while the provider call is
         * in flight. If the engine held a write transaction across the executor,
         * this write would fail with SQLITE_BUSY. Its success is direct proof that
         * no write transaction is held around the provider invocation.
         */
        const second = openDurableDatabase({ dataDir: harness.dataDir, appliedAt: new Date().toISOString(), chains: ['core', 'engine'] });
        try {
          second.db.exec('PRAGMA user_version = 5');
          writeDuringProvider = 'ok';
        } catch (error) {
          writeDuringProvider = `busy:${String(error)}`;
        } finally {
          try {
            second.db.exec('PRAGMA user_version = 0');
          } finally {
            second.close();
          }
        }
        void database;
        return Promise.resolve();
      },
    });
    const driven = await harness.drive();
    expect(driven.ok).toBe(true);
    expect(harness.providerCalls()).toBe(1);
    expect(writeDuringProvider).toBe('ok');
  });

  it('7. settlement after a preflight failure uses the EXISTING canonical rules (no fabricated output)', async () => {
    const harness = await makeHarness({
      workspaceRoot: tempDir(),
      configOf: () => null,
    });
    const driven = await harness.drive();
    expect(driven.ok).toBe(true);
    if (driven.ok) expect(driven.value.run.state).toBe('FAILED');
    const finalTask = taskRow(harness.database, harness.taskId);
    expect(finalTask.state).toBe('FAILED'); // the canonical failure settlement, not a wedge
    const attemptRow = harness.database.db
      .prepare('SELECT state FROM execution_attempts')
      .get() as { readonly state: string };
    expect(attemptRow.state).not.toBe('ACTIVE'); // settled by Transaction B, honestly
    // No stage output was fabricated for a dispatch that never reached a provider.
    expect(count(harness.database, 'SELECT COUNT(*) AS c FROM provider_dispatches')).toBe(0);
  });

  it('8. a crash after the claim but BEFORE the preflight restarts onto the SAME canonical attempt', async () => {
    const dataDir = tempDir();
    const observations: PreflightObservation[] = [];
    const providerCalls = { count: 0 };
    // ONE id/clock space across both lives — the same discipline the durable fixture
    // applies on restart, so ledger idempotency keys never collide across lives.
    const shared = { ids: new SequenceIdFactory(), clock: new FixedClock(EPOCH) };

    // Phase 1: crash at the engine checkpoint that sits exactly BETWEEN the claim
    // transaction and the handler — i.e. after the claim, before the preflight.
    const crashDb = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: ['core', 'engine'] });
    dbs.push(crashDb);
    const seeded = await seedRunAndTask(crashDb);
    const crashEngine = buildEngine(
      crashDb,
      { workspaceRoot: tempDir(), crashAt: FAULT_CHECKPOINTS.executionClaimBeforeExecutor },
      observations,
      providerCalls,
      shared,
    );
    await expect(
      crashEngine.drive(seeded.runId, { stage: { stageId: STAGE, taskIds: [seeded.taskId as never] }, maxSteps: 6 }),
    ).rejects.toThrow('crash:after_execution_claim_before_executor');
    // The claim survived the "crash": Task RUNNING + ExecutionAttempt ACTIVE, durable.
    const taskAfterCrash = taskRow(crashDb, seeded.taskId);
    expect(taskAfterCrash.state).toBe('RUNNING');
    expect(Number(taskAfterCrash.attempts)).toBe(1);
    const attemptId = executionAttemptIdOf({ companyId: COMPANY, runId: seeded.runId, taskId: seeded.taskId, attemptNumber: 1 });
    const attemptAfterCrash = crashDb.db
      .prepare('SELECT state FROM execution_attempts WHERE id = ?')
      .get(attemptId) as { readonly state: string };
    expect(attemptAfterCrash.state).toBe('ACTIVE');
    expect(providerCalls.count).toBe(0);
    crashDb.close();
    dbs.pop();

    // Phase 2: restart. Run the SAME production orphan recovery the composition runs
    // at startup, then re-drive: the SAME attempt identity is reacquired (no new
    // attempt minted, attempts NOT incremented).
    const restartedDb = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: ['core', 'engine'] });
    dbs.push(restartedDb);
    await restartedDb.executionAttempts.interruptActiveOfRuntime(null, new Date().toISOString());
    observations.length = 0;
    const restartedEngine = buildEngine(restartedDb, { workspaceRoot: tempDir() }, observations, providerCalls, shared);
    const driven = await restartedEngine.drive(seeded.runId, { stage: { stageId: STAGE, taskIds: [seeded.taskId as never] }, maxSteps: 6 });
    expect(driven.ok).toBe(true);
    expect(count(restartedDb, 'SELECT COUNT(*) AS c FROM execution_attempts')).toBe(1); // SAME one attempt
    const attemptRow = restartedDb.db
      .prepare('SELECT state, attempt_number FROM execution_attempts')
      .get() as { readonly state: string; readonly attempt_number: number };
    expect(attemptRow.state).not.toBe('ACTIVE'); // settled this time
    expect(Number(attemptRow.attempt_number)).toBe(1);
    const finalTask = taskRow(restartedDb, seeded.taskId);
    expect(Number(finalTask.attempts)).toBe(1); // recovery is NOT a retry
    expect(providerCalls.count).toBe(1); // the provider ran exactly once across both lives
    // And the preflight on the restarted life still saw the canonical claim truth.
    expect(observations.length).toBe(1);
    expect(observations[0]!.attemptState).not.toBeNull();
  });
});
