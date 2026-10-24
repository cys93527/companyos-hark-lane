/**
 * Sprint 14 / Task-14-02: Quiescent Startup Recovery Orchestrator (ADR-0021).
 *
 * Two layers:
 *   1. Real-durable composition — real SQLite (7 chains), the REAL AgentRuntime
 *      (recoverInterrupted), the REAL ToolRegistry (recoverInvocations) and a REAL
 *      WorkflowEngine: residue converges to the frozen states, the exact frozen event
 *      vocabulary appears, WAITING/PAUSED stay untouched, provider/adapter call counts
 *      stay 0.
 *   2. Injection harness (fake deps) — frozen order via a unified action log, exhaustive
 *      pagination, partial-failure fail-closed, run-enumeration failure, plus a
 *      source-level lock on the production startup ordering (CAS → recovery → IPC/window)
 *      and the no-new-IPC boundary.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FixedClock,
  SequenceIdFactory,
  createToolInvocation,
  createWorkflowRun,
  domainError,
  ok,
  type DomainError,
  type ToolPort,
  type ToolResult,
} from '@companyos/core';
import {
  createAgentRuntime,
  createModelRegistry,
  createMockProvider,
  createProviderRegistry,
  createScriptedRegistry,
  createSelectionPolicyService,
  createStartupRecoveryOrchestrator,
  createToolRegistry,
  createWorkflowEngine,
  type StartupRecoveryDeps,
} from '@companyos/engine';
import {
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const EPOCH = Date.parse('2026-09-26T00:00:00.000Z');
const ACTOR = 'user_owner';
const allow = async (): Promise<{ readonly ok: true; readonly value: true }> => ok(true);

const created: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};

let database: DurableDatabase | null = null;
afterEach(() => {
  database?.close();
  database = null;
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const MODEL = (modelId: string) => ({
  modelId,
  displayName: modelId,
  contextWindow: 1000,
  maxOutputTokens: 200,
  capabilities: { streaming: true },
  pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' as const },
});

/* --------------------------------------------------------------- real composition */

interface Real {
  readonly db: DurableDatabase;
  readonly engine: ReturnType<typeof createWorkflowEngine>;
  readonly tools: ReturnType<typeof createToolRegistry>;
  readonly runtime: ReturnType<typeof createAgentRuntime>;
  readonly adapterCalls: () => number;
  readonly providerInvocations: () => number;
}

const makeReal = async (): Promise<Real> => {
  const db = openDurableDatabase({
    dataDir: tempDir('companyos-t14-'),
    appliedAt: new Date(EPOCH).toISOString(),
    chains: ['core', 'engine', 'provider', 'registry', 'selection', 'agent', 'tools'],
  });
  database = db;
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();

  let providerInvocations = 0;
  const provider = createMockProvider({
    providerId: 'mock-a',
    kind: 'mock',
    displayName: 'A',
    script: {
      models: [MODEL('standard')],
      outcomes: [{ outputText: 'ok' }],
    },
  });
  const origInvoke = (provider as unknown as { invoke?: unknown }).invoke;
  void origInvoke;
  const countingProvider = new Proxy(provider as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'invoke' && typeof value === 'function') {
        return async (...args: unknown[]) => {
          providerInvocations += 1;
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      }
      return value;
    },
  }) as typeof provider;

  const providers = createProviderRegistry({
    ids,
    clock,
    registrations: db.providers,
    models: db.providerModels,
    authorize: allow as never,
    events: db.events,
    systemActor: ACTOR,
  } as never);
  const registered = await providers.register(countingProvider, { actorId: ACTOR });
  if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);

  const models = createModelRegistry({
    ids,
    clock,
    records: db.modelRecords,
    aliases: db.modelAliases,
    providers,
    authorize: allow as never,
    events: db.events,
    scope: 'default',
  } as never);
  const registeredModel = await models.registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: ACTOR });
  if (!registeredModel.ok && registeredModel.error.code !== 'CONFLICT') throw new Error(registeredModel.error.message);

  const policies = createSelectionPolicyService({
    ids,
    clock,
    policies: db.selectionPolicies,
    results: db.benchmarkResults,
    readRecords: async () => models.list({ includeDisabled: true }),
    authorize: allow as never,
    events: db.events,
  } as never);

  let adapterCalls = 0;
  const adapter: ToolPort = {
    describe: () => ({
      toolId: 'tool.probe',
      name: 'tool.probe',
      description: 'probe',
      version: '1.0.0',
      riskLevel: 'LOW',
      capabilities: [],
      parameters: { type: 'object' },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    }),
    invoke: async () => {
      adapterCalls += 1;
      return ok({
        status: 'ok',
        output: {},
        artifactRefs: [],
        startedAt: clock.nowIso(),
        finishedAt: clock.nowIso(),
        latencyMs: 1,
      } satisfies ToolResult);
    },
  };
  const tools = createToolRegistry({
    ids,
    clock,
    records: db.toolRecords,
    invocations: db.toolInvocations,
    invocationArtifacts: db.toolInvocationArtifacts,
    adapters: new Map<string, ToolPort>([['tool.probe', adapter]]),
    authorize: allow as never,
    events: db.events,
    secrets: async () => [],
    timer: (ms: number, onTimeout: () => void) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
    ...(db.toolInvocationClaims === null ? {} : { claims: db.toolInvocationClaims }),
    ...(db.toolInvocationIndex === null ? {} : { invocationIndex: db.toolInvocationIndex }),
  } as never);

  const runtime = createAgentRuntime({
    ids,
    clock,
    executions: db.agentExecutions,
    artifacts: db.executionArtifacts,
    models,
    providers,
    policies,
    tools,
    events: db.events,
    authorize: allow as never,
    secrets: async () => [],
  } as never);

  const engine = createWorkflowEngine({
    ids,
    clock,
    runs: db.runs,
    events: db.events,
    approvals: db.approvals,
    tasks: db.tasks,
    handlers: createScriptedRegistry({}),
    ledger: db.ledger,
    unitOfWork: db.unitOfWork,
  });

  return { db, engine, tools, runtime, adapterCalls: () => adapterCalls, providerInvocations: () => providerInvocations };
};

const seedRun = async (db: DurableDatabase, ids: SequenceIdFactory, state: string): Promise<string> => {
  const run = createWorkflowRun({
    companyId: 'cmp_1' as never,
    workflowId: 'wfl_1' as never,
    templateId: 'tpl_1' as never,
    versionId: 'ver_1' as never,
    snapshotId: 'snp_1' as never,
    startedBy: ACTOR,
    now: new Date(EPOCH).toISOString(),
    ids,
  });
  if (!run.ok) throw new Error(run.error.message);
  await db.runs.put({ ...run.value, state: state as never });
  return run.value.id;
};

/** Sprint 8 seeding pattern: a real prepare(), then the row left in RUNNING. */
const seedRunningAgent = async (real: Real, ids: SequenceIdFactory, runId: string): Promise<string> => {
  const prepared = await real.runtime.prepare({
    agentId: 'agent_1',
    roleId: 'role_1',
    taskId: ids.id('tsk'),
    runId: runId as never,
    actorId: ACTOR,
    modelKey: 'mock-a.standard',
    explicit: true,
    scopes: [],
  });
  if (!prepared.ok) throw new Error(prepared.error.message);
  await real.db.agentExecutions.put({ ...prepared.value, status: 'RUNNING' });
  return prepared.value.executionId;
};

const seedStartedInvocation = async (db: DurableDatabase, ids: SequenceIdFactory, runId: string): Promise<string> => {
  const made = createToolInvocation({
    id: ids.id('tinv'),
    toolId: 'tool.probe',
    toolVersion: '1.0.0',
    executionId: ids.id('exec'),
    agentId: 'agent_1',
    taskId: ids.id('tsk'),
    runId,
    actorId: ACTOR,
    traceId: ids.id('trace'),
    riskLevel: 'LOW',
    idempotencyMode: 'IDEMPOTENT_KEY',
    idempotencyKey: ids.id('key'),
    input: {},
    now: new Date(EPOCH).toISOString(),
  });
  if (!made.ok) throw new Error(made.error.message);
  await db.toolInvocations.put({ ...made.value, status: 'STARTED' });
  return made.value.id;
};

const withLog = <T>(inner: T, prop: string, prefix: string, log: string[]): T =>
  new Proxy(inner as object, {
    get(target, key, receiver) {
      const value = Reflect.get(target as object, key, receiver);
      if (key === prop && typeof value === 'function') {
        return async (...args: unknown[]) => {
          log.push(`${prefix}:${String(args[0])}`);
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      }
      return value;
    },
  }) as T;

describe('real-durable composition (ADR-0021 order / matrices / events / side effects)', () => {
  it('no residue: clean startup reports all-zero actions and stays healthy', async () => {
    const real = await makeReal();
    const report = await createStartupRecoveryOrchestrator({
      actorId: ACTOR,
      runtime: real.runtime,
      tools: real.tools,
      engine: real.engine,
      runs: real.db.runs,
    }).run();
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value).toMatchObject({
        agentsInterrupted: 0,
        toolsInterrupted: 0,
        toolsWaitingApproval: 0,
        runsRecovered: 0,
        recoveringRunsCompleted: 0,
        runsPaused: 0,
        runsWaitingApproval: 0,
        manualInterventionRequired: 0,
      });
      expect(report.value.runsScanned).toBe(0);
    }
    expect(real.adapterCalls()).toBe(0);
    expect(real.providerInvocations()).toBe(0);
  });

  it('triple residue on one run: agent RUNNING + tool STARTED + run EXECUTING converge in the frozen order', async () => {
    const real = await makeReal();
    const ids = new SequenceIdFactory();
    const runId = await seedRun(real.db, ids, 'EXECUTING');
    await seedStartedInvocation(real.db, ids, runId);
    await seedRunningAgent(real, ids, runId);

    const log: string[] = [];
    const report = await createStartupRecoveryOrchestrator({
      actorId: ACTOR,
      runtime: withLog(real.runtime, 'recoverInterrupted', 'agent', log),
      tools: withLog(real.tools, 'recoverInvocations', 'tool', log),
      engine: withLog(real.engine, 'recover', 'run', log),
      runs: real.db.runs,
    }).run();
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.agentsInterrupted).toBe(1);
      expect(report.value.toolsInterrupted).toBe(1);
      expect(report.value.runsRecovered).toBe(1);
    }
    // Unified action log proves the frozen ORDER (not just source line order).
    const agentAt = log.findIndex((entry) => entry.startsWith('agent'));
    const toolAt = log.findIndex((entry) => entry.startsWith('tool'));
    const runAt = log.findIndex((entry) => entry.startsWith('run'));
    expect(agentAt).toBeGreaterThanOrEqual(0);
    expect(agentAt).toBeLessThan(toolAt);
    expect(toolAt).toBeLessThan(runAt);
    // Converged durable states (run back at its resumePoint, point consumed).
    expect((await real.db.agentExecutions.list()).items[0]).toMatchObject({ status: 'INTERRUPTED' });
    expect((await real.db.toolInvocations.list()).items[0]).toMatchObject({ status: 'INTERRUPTED' });
    const run = await real.db.runs.get(runId as never);
    expect(run?.state).toBe('EXECUTING');
    expect(run?.resumePoint).toBeNull();
    // External side effects during recovery: ZERO (§15/§32).
    expect(real.adapterCalls()).toBe(0);
    expect(real.providerInvocations()).toBe(0);
    // Frozen event vocabulary (§33/§34).
    const types = (await real.db.events.all()).map((entry) => entry.event.type);
    expect(types).toContain('agent.execution_interrupted');
    expect(types).toContain('tool.invocation_interrupted');
    expect(types).toContain('run.crash_detected');
    expect(types).toContain('run.recovered');
  });

  it('RECOVERING run: completes the existing cycle, never a second crash_detected (§16/§35)', async () => {
    const real = await makeReal();
    const ids = new SequenceIdFactory();
    const runId = await seedRun(real.db, ids, 'EXECUTING');
    const crashed = await real.engine.dispatch({
      commandId: ids.id('cmd'),
      runId: runId as never,
      type: 'CRASH.DETECTED',
      expectedRevision: 0,
      actorId: ACTOR,
      traceId: ids.id('trace'),
      issuedAt: new Date(EPOCH).toISOString(),
    });
    expect(crashed.ok).toBe(true);

    const report = await createStartupRecoveryOrchestrator({
      actorId: ACTOR,
      runtime: real.runtime,
      tools: real.tools,
      engine: real.engine,
      runs: real.db.runs,
    }).run();
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.value.recoveringRunsCompleted).toBe(1);
    expect((await real.db.runs.get(runId as never))?.state).toBe('EXECUTING');
    const all = await real.db.events.all();
    expect(all.filter((e) => e.event.type === 'run.crash_detected')).toHaveLength(1); // pre-restart one only
    expect(all.filter((e) => e.event.type === 'run.recovered')).toHaveLength(1);
  });

  it('manual states: PAUSED run / WAITING_APPROVAL run / WAITING_APPROVAL tool untouched, startup PASSes (§17/§18/§38)', async () => {
    const real = await makeReal();
    const ids = new SequenceIdFactory();
    const pausedId = await seedRun(real.db, ids, 'PAUSED');
    const waitingRunId = await seedRun(real.db, ids, 'WAITING_APPROVAL');
    const made = createToolInvocation({
      id: ids.id('tinv'),
      toolId: 'tool.probe',
      toolVersion: '1.0.0',
      executionId: ids.id('exec'),
      agentId: 'agent_1',
      taskId: ids.id('tsk'),
      runId: waitingRunId,
      actorId: ACTOR,
      traceId: ids.id('trace'),
      riskLevel: 'LOW',
      idempotencyMode: 'IDEMPOTENT_KEY',
      idempotencyKey: ids.id('key'),
      input: {},
      now: new Date(EPOCH).toISOString(),
    });
    if (!made.ok) throw new Error(made.error.message);
    await real.db.toolInvocations.put({ ...made.value, status: 'WAITING_APPROVAL' });

    const report = await createStartupRecoveryOrchestrator({
      actorId: ACTOR,
      runtime: real.runtime,
      tools: real.tools,
      engine: real.engine,
      runs: real.db.runs,
    }).run();
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.runsPaused).toBe(1);
      expect(report.value.runsWaitingApproval).toBe(1);
      expect(report.value.toolsWaitingApproval).toBe(1);
      expect(report.value.toolsInterrupted).toBe(0);
      expect(report.value.runsRecovered).toBe(0);
      expect(report.value.manualInterventionRequired).toBe(3);
    }
    expect((await real.db.runs.get(pausedId as never))?.state).toBe('PAUSED');
    expect((await real.db.runs.get(waitingRunId as never))?.state).toBe('WAITING_APPROVAL');
    expect((await real.db.toolInvocations.list()).items[0]?.status).toBe('WAITING_APPROVAL');
    expect(real.adapterCalls()).toBe(0);
  });

  it('sequential second run RE-SCANS: 0 new actions, zero duplicate events (§23/§40)', async () => {
    const real = await makeReal();
    const ids = new SequenceIdFactory();
    const runId = await seedRun(real.db, ids, 'EXECUTING');
    await seedStartedInvocation(real.db, ids, runId);
    await seedRunningAgent(real, ids, runId);
    const orchestrator = createStartupRecoveryOrchestrator({
      actorId: ACTOR,
      runtime: real.runtime,
      tools: real.tools,
      engine: real.engine,
      runs: real.db.runs,
    });
    const first = await orchestrator.run();
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.agentsInterrupted + first.value.toolsInterrupted + first.value.runsRecovered).toBe(3);
    const eventsAfterFirst = (await real.db.events.all()).length;

    const second = await orchestrator.run();
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.agentsInterrupted).toBe(0);
      expect(second.value.toolsInterrupted).toBe(0);
      expect(second.value.runsRecovered).toBe(0);
      expect(second.value.recoveringRunsCompleted).toBe(0);
    }
    expect((await real.db.events.all()).length).toBe(eventsAfterFirst);
  });

  it('sequential re-scan still recovers GENUINELY NEW residue after the first pass (§23 re-scan semantics)', async () => {
    const real = await makeReal();
    const ids = new SequenceIdFactory();
    await seedRun(real.db, ids, 'EXECUTING');
    const orchestrator = createStartupRecoveryOrchestrator({
      actorId: ACTOR,
      runtime: real.runtime,
      tools: real.tools,
      engine: real.engine,
      runs: real.db.runs,
    });
    const first = await orchestrator.run();
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.runsRecovered).toBe(1);

    // A NEW crash after the first pass (durable state changed): the re-scan must see it.
    const freshId = await seedRun(real.db, ids, 'VALIDATING');
    const second = await orchestrator.run();
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.runsRecovered).toBe(1); // the NEW residue only
    expect((await real.db.runs.get(freshId as never))?.state).toBe('VALIDATING'); // its resumePoint
  });

  it('concurrent run() calls share ONE scan cycle (§41)', async () => {
    const real = await makeReal();
    const ids = new SequenceIdFactory();
    const runId = await seedRun(real.db, ids, 'EXECUTING');
    await seedStartedInvocation(real.db, ids, runId);
    let agentScans = 0;
    const counting = withCounter(real.runtime, 'recoverInterrupted', () => {
      agentScans += 1;
    });
    const orchestrator = createStartupRecoveryOrchestrator({
      actorId: ACTOR,
      runtime: counting,
      tools: real.tools,
      engine: real.engine,
      runs: real.db.runs,
    });
    const [a, b] = await Promise.all([orchestrator.run(), orchestrator.run()]);
    expect(a.ok && b.ok).toBe(true);
    expect(agentScans).toBe(1);
    const all = await real.db.events.all();
    expect(all.filter((e) => e.event.type === 'run.crash_detected')).toHaveLength(1);
    expect(all.filter((e) => e.event.type === 'tool.invocation_interrupted')).toHaveLength(1);
  });
});

/* --------------------------------------------------------------- injection harness */

const fakeDeps = (over: {
  readonly runs: { list(page?: { limit?: number; offset?: number }): Promise<{ items: { id: string; state: string }[] }> };
  readonly agentOutcome?: { ok: true; value: unknown[] } | { ok: false; error: DomainError };
  readonly toolOutcome?:
    | { ok: true; value: { interrupted: string[]; waitingApproval: string[]; retryable: string[] } }
    | { ok: false; error: DomainError };
  readonly engineOutcome?: (runId: string) => 'resumed' | 'unrecoverable';
  readonly log?: string[];
  readonly runsPageSize?: number;
}): StartupRecoveryDeps =>
  ({
    actorId: ACTOR,
    runtime: {
      recoverInterrupted: async () => {
        over.log?.push('agent-recover');
        return (over.agentOutcome ?? ok([])) as never;
      },
    },
    tools: {
      recoverInvocations: async () => {
        over.log?.push('tool-recover');
        return (over.toolOutcome ?? ok({ interrupted: [], waitingApproval: [], retryable: [] })) as never;
      },
    },
    engine: {
      recover: (runId: string) => {
        over.log?.push(`run-recover:${runId}`);
        return Promise.resolve(over.engineOutcome ? over.engineOutcome(runId) : 'resumed');
      },
    },
    runs: over.runs as never,
    ...(over.runsPageSize === undefined ? {} : { runsPageSize: over.runsPageSize }),
  }) as StartupRecoveryDeps;

const fakePageStore = (runs: { id: string; state: string }[], cap: number) => ({
  list: async (page: { limit?: number; offset?: number } = {}) => {
    const size = Math.min(page.limit ?? cap, cap);
    const offset = page.offset ?? 0;
    return { items: runs.slice(offset, offset + size), total: runs.length };
  },
});

describe('injection harness (failure policy / pagination)', () => {
  it('agent recovery failure fails the whole pass (fail closed, §24)', async () => {
    const report = await createStartupRecoveryOrchestrator(
      fakeDeps({
        runs: fakePageStore([], 200),
        agentOutcome: { ok: false, error: domainError('PERSISTENCE_FAILED', 'agent scan exploded', {}) },
      }),
    ).run();
    expect(report.ok).toBe(false);
  });

  it('tool recovery failure after a successful agent pass: fail closed, agent pass stays durable (§42)', async () => {
    const log: string[] = [];
    const report = await createStartupRecoveryOrchestrator(
      fakeDeps({
        runs: fakePageStore([], 200),
        toolOutcome: { ok: false, error: domainError('PERSISTENCE_FAILED', 'tool scan exploded', {}) },
        log,
      }),
    ).run();
    expect(report.ok).toBe(false);
    expect(log).toEqual(['agent-recover', 'tool-recover']);
  });

  it('engine.recover failure on a crashable run: fail closed RUN_RECOVERY_FAILED (§43)', async () => {
    const report = await createStartupRecoveryOrchestrator(
      fakeDeps({ runs: fakePageStore([{ id: 'run_x', state: 'EXECUTING' }], 200), engineOutcome: () => 'unrecoverable' }),
    ).run();
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.error.details['reason']).toBe('RUN_RECOVERY_FAILED');
  });

  it('run enumeration error: fail closed RUN_ENUMERATION_FAILED', async () => {
    const boom = {
      list: async (): Promise<never> => {
        throw new Error('store gone');
      },
    };
    const report = await createStartupRecoveryOrchestrator(fakeDeps({ runs: boom as never })).run();
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.error.details['reason']).toBe('RUN_ENUMERATION_FAILED');
  });

  it('pagination is exhaustive across every page (§44)', async () => {
    const runs = Array.from({ length: 7 }, (_, i) => ({ id: `run_${i}`, state: i % 2 === 0 ? 'EXECUTING' : 'COMPLETED' }));
    const log: string[] = [];
    const report = await createStartupRecoveryOrchestrator(
      fakeDeps({ runs: fakePageStore(runs, 3), log, runsPageSize: 3 }),
    ).run();
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.runsScanned).toBe(7);
      expect(report.value.runsRecovered).toBe(4); // 0/2/4/6 crashable; COMPLETED ignored
    }
    expect(log.filter((entry) => entry.startsWith('run-recover'))).toHaveLength(4);
  });

  it('production startup ordering frozen in main.ts source: CAS → recovery → IPC/window; fail-closed; no recovery IPC (§28/§46)', () => {
    const source = readFileSync(repo('apps/desktop/src/main.ts'), 'utf8');
    const casAt = source.indexOf('openArtifactFoundation({');
    const recoveryAt = source.indexOf('createStartupRecoveryOrchestrator({');
    const exposureAt = source.indexOf('applyContentSecurityPolicy(logger);\n  registerIpcHandlers();');
    expect(casAt).toBeGreaterThanOrEqual(0);
    expect(recoveryAt).toBeGreaterThan(casAt);
    expect(exposureAt).toBeGreaterThan(recoveryAt);
    // A recovery safety failure closes the DB and exits BEFORE any exposure.
    const failAt = source.indexOf('startup failed: recovery safety failure');
    expect(failAt).toBeGreaterThan(0);
    expect(source.indexOf('app.exit(1)', failAt)).toBeGreaterThan(failAt);
    // No new renderer IPC surface for recovery.
    const ops = readFileSync(repo('apps/desktop/src/workflows.ts'), 'utf8');
    for (const op of ['recovery.start', 'recovery.status', 'run.recover']) {
      expect(ops).not.toContain(`'${op}'`);
    }
  });
});

/* --------------------------------------------------------------- helpers */

const withCounter = <T>(inner: T, prop: string, onCall: () => void): T =>
  new Proxy(inner as object, {
    get(target, key, receiver) {
      const value = Reflect.get(target as object, key, receiver);
      if (key === prop && typeof value === 'function') {
        return async (...args: unknown[]) => {
          onCall();
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      }
      return value;
    },
  }) as T;
