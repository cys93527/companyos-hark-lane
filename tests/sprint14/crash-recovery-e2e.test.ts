/**
 * Sprint 14 / Task-14-03: Crash Recovery End-to-End (ADR-0021 + roadmap AC14.1–14.3).
 *
 * A REAL restart boundary, not an instance-level re-run: PROCESS A opens a real temp
 * SQLite DB + real CAS root, performs real durable work through the real engine /
 * ArtifactService / runtime / tool registry, leaves selected state in-flight, closes
 * the DB and DISCARDS every service object. PROCESS B re-opens the SAME SQLite file
 * and the SAME CAS root, re-composes a NEW service graph (fresh clock/ids/authz/
 * providers/models/tools/runtime/engine/orchestrator — nothing carried across except
 * durable state, the CAS filesystem and test-observation counters), runs CAS
 * reconciliation + the T14-02 StartupRecoveryOrchestrator AS-IS (no second recovery
 * algorithm), then continues the workflow through the normal engine API.
 *
 * Matrix (§44): 3-stage crash→restart→continuation; completed stage not repeated;
 * RUNNING dead-attempt; agent/tool residue; WAITING/PAUSED untouched; RECOVERING
 * restart; crashable-state matrix; EvidenceGuard after recovery; real evidence;
 * run-pinned validator policy; durable event trail; CAS-fatal prevention; second
 * actual restart = new crash cycle.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DomainError,
  FixedClock,
  SequenceIdFactory,
  TOOL_CAPABILITY_VALIDATOR,
  applyTaskEvent,
  createTask,
  createToolInvocation,
  createToolRecord,
  createWorkflowRun,
  ok,
  type RunCommand,
  type RunCommandType,
  type Task,
  type ToolPort,
  type ToolResult,
  type WorkflowRun,
  type WorkflowTemplate,
} from '@companyos/core';
import {
  createAgentRuntime,
  createAuthorizationService,
  createModelRegistry,
  createMockProvider,
  createProviderRegistry,
  createSelectionPolicyService,
  createStartupRecoveryOrchestrator,
  createToolRegistry,
  createWorkflowEngine,
  ensureBootstrapOwner,
  type StartupRecoveryOrchestrator,
  type StageHandler,
  type StageHandlerRegistry,
} from '@companyos/engine';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';
import { composeSprint13Application, openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const EPOCH = Date.parse('2026-09-26T00:00:00.000Z');
const ACTOR = 'user_owner';
const STAGE_ID = 'stg_1';

const created: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
/** Every open fixture; afterEach closes leftovers so a failed assertion cannot leak handles. */
const openFixtures: RestartFixture[] = [];
afterEach(() => {
  while (openFixtures.length > 0) openFixtures.pop()?.close();
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- restart harness (tests only) */

const MODEL = (modelId: string) => ({
  modelId,
  displayName: modelId,
  contextWindow: 1000,
  maxOutputTokens: 200,
  capabilities: { streaming: true },
  pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' as const },
});

interface RestartFixture {
  readonly tag: string;
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly ids: SequenceIdFactory;
  readonly clock: FixedClock;
  readonly engine: ReturnType<typeof composeSprint13Application>['engine'];
  readonly runtime: ReturnType<typeof createAgentRuntime>;
  readonly tools: ReturnType<typeof createToolRegistry>;
  readonly sprint13: ReturnType<typeof composeSprint13Application>;
  readonly orchestrator: StartupRecoveryOrchestrator;
  readonly stageHandlerCounts: () => Record<string, number>;
  readonly adapterCalls: () => number;
  readonly actionLog: readonly string[];
  close(): void;
}

let processGeneration = 0;

const openRestartFixture = async (): Promise<RestartFixture> => {
  processGeneration += 1;
  const tag = `P${String(processGeneration)}`;
  const dataDir = tempDir(`companyos-t14e2e-${tag}-`);
  const casRoot = tempDir(`companyos-t14e2e-${tag}-cas-`);
  return await composeRestartFixture(dataDir, casRoot, tag);
};

/** PROCESS B/C: same SQLite file, same CAS root, completely NEW object graph. */
const reopenRestartFixture = async (previous: RestartFixture): Promise<RestartFixture> => {
  previous.close();
  processGeneration += 1;
  const tag = `P${String(processGeneration)}`;
  return await composeRestartFixture(previous.dataDir, previous.casRoot, tag);
};

const composeRestartFixture = async (dataDir: string, casRoot: string, tag: string): Promise<RestartFixture> => {
  const db = openDurableDatabase({
    dataDir,
    appliedAt: new Date(EPOCH).toISOString(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact'],
  });
  const clock = new FixedClock(EPOCH);
  // Distinct per-process prefixes: the durable command ledger survives the restart,
  // so command ids from a fresh factory must never collide with Process A's.
  const ids = new SequenceIdFactory(tag);
  const failSafe = (error: unknown): never => {
    db.close();
    throw error instanceof Error ? error : new Error(String(error));
  };
  try {

  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  const bootstrap = await ensureBootstrapOwner(authz, { actorId: ACTOR, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);
  const sessionAuthorize = async (input: { readonly actorId: string; readonly authority: string; readonly scopeId?: string }) => {
    if (input.actorId !== ACTOR) {
      return {
        ok: false as const,
        error: new DomainError('POLICY_DENIED', 'Actor ' + input.actorId + ' is not the session actor.', {}),
      };
    }
    return authz.decide({ actorId: input.actorId, authority: input.authority, ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }) });
  };

  const providers = createProviderRegistry({
    ids,
    clock,
    registrations: db.providers,
    models: db.providerModels,
    authorize: sessionAuthorize as never,
    events: db.events,
    systemActor: ACTOR,
  } as never);

  const models = createModelRegistry({
    ids,
    clock,
    records: db.modelRecords,
    aliases: db.modelAliases,
    providers,
    authorize: sessionAuthorize as never,
    events: db.events,
    scope: 'default',
  } as never);

  const policies = createSelectionPolicyService({
    ids,
    clock,
    policies: db.selectionPolicies,
    results: db.benchmarkResults,
    readRecords: async () => models.list({ includeDisabled: true }),
    authorize: sessionAuthorize as never,
    events: db.events,
  } as never);

  let adapterCalls = 0;
  const validatorAdapter: ToolPort = {
    describe: () => ({
      toolId: 'tool.gate',
      name: 'tool.gate',
      description: 'gate validator',
      version: '1.0.0',
      riskLevel: 'LOW',
      capabilities: [TOOL_CAPABILITY_VALIDATOR],
      parameters: { type: 'object' },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    }),
    invoke: async () => {
      adapterCalls += 1;
      return ok({
        status: 'ok',
        output: { verdict: 'pass', evidenceRefs: [] },
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
    adapters: new Map<string, ToolPort>([['tool.gate', validatorAdapter]]),
    authorize: sessionAuthorize as never,
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
    authorize: sessionAuthorize as never,
    secrets: async () => [],
  } as never);

  const contentStore = createFilesystemArtifactContentStore({ casRoot });
  const sprint13 = composeSprint13Application({
    database: db,
    contentStore,
    clock,
    ids,
    authorize: sessionAuthorize as never,
    tools,
    logger: nullLogger,
  });

  // Controlled stage handlers (the engine's sanctioned extension point): count + succeed.
  const counts: Record<string, number> = {};
  const handlerOf = (kind: string): StageHandler => ({
    id: `handler.${kind}`,
    execute: () => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      return 'succeeded';
    },
  });
  const handlers: StageHandlerRegistry = { resolve: (kind: string) => handlerOf(kind) };

  // Production semantics, controlled execution: the SAME validationGate adapter
  // sprint13 composed (gate REQUIRED) with the counting stage handlers.
  const gateEngine = createWorkflowEngine({
    ids,
    clock,
    runs: db.runs,
    events: db.events,
    approvals: db.approvals,
    tasks: db.tasks,
    handlers,
    ledger: db.ledger,
    unitOfWork: db.unitOfWork,
    validationGate: sprint13.engineValidationGate,
  });

  const actionLog: string[] = [];
  const orchestrator = createStartupRecoveryOrchestrator({
    actorId: ACTOR,
    runtime: {
      recoverInterrupted: async (actorId: string) => {
        actionLog.push('agent-recover');
        return runtime.recoverInterrupted(actorId);
      },
    },
    tools: {
      recoverInvocations: async (actorId: string) => {
        actionLog.push('tool-recover');
        return tools.recoverInvocations(actorId);
      },
    },
    engine: {
      recover: async (runId: string) => {
        const outcome = await gateEngine.recover(runId as never);
        if (outcome === 'resumed') actionLog.push('run-recover:' + runId);
        return outcome;
      },
    },
    runs: db.runs,
  });

  let closed = false;
  const fixture: RestartFixture = {
    tag,
    db,
    dataDir,
    casRoot,
    ids,
    clock,
    engine: gateEngine,
    runtime,
    tools,
    sprint13,
    orchestrator,
    stageHandlerCounts: () => ({ ...counts }),
    adapterCalls: () => adapterCalls,
    actionLog,
    close(): void {
      if (closed) return; // idempotent: tests may close before reopenRestartFixture does
      closed = true;
      const index = openFixtures.indexOf(fixture);
      if (index >= 0) openFixtures.splice(index, 1);
      db.close();
    },
  };
  openFixtures.push(fixture);
  return fixture;
  } catch (error) {
    return failSafe(error);
  }
};

/* ------------------------------------------------------------- seeding helpers */

const seedTemplate = async (db: DurableDatabase): Promise<void> => {
  const template: WorkflowTemplate = {
    id: 'tpl_gate' as never,
    orgId: 'cmp_1',
    name: 'gated',
    state: 'published' as never,
    currentVersionId: 'ver_2',
    draftVersionId: null,
    forkedFrom: null,
    createdBy: ACTOR,
    createdAt: new Date(EPOCH).toISOString(),
    updatedAt: new Date(EPOCH).toISOString(),
    versions: [
      {
        id: 'ver_1',
        templateId: 'tpl_gate' as never,
        semver: '1.0.0',
        contentHash: 'a'.repeat(64),
        changeProposalId: null,
        immutable: true,
        createdBy: ACTOR,
        createdAt: new Date(EPOCH).toISOString(),
        graph: { nodes: [{ id: 's1', kind: 'work', title: 'S1', config: { validatorIds: ['tool.gate'] } }], edges: [] },
      },
      {
        id: 'ver_2',
        templateId: 'tpl_gate' as never,
        semver: '2.0.0',
        contentHash: 'b'.repeat(64),
        changeProposalId: null,
        immutable: true,
        createdBy: ACTOR,
        createdAt: new Date(EPOCH).toISOString(),
        graph: { nodes: [{ id: 's1', kind: 'work', title: 'S1', config: { validatorIds: ['tool.other'] } }], edges: [] },
      },
    ],
  };
  await db.templates.put(template);
};

const registerValidatorTool = async (f: RestartFixture): Promise<void> => {
  const record = createToolRecord({
    toolId: 'tool.gate',
    name: 'tool.gate',
    description: 'gate validator',
    version: '1.0.0',
    capabilities: [TOOL_CAPABILITY_VALIDATOR],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    riskLevel: 'LOW',
    requiredAuthorities: ['tool.invoke'],
    now: f.clock.nowIso(),
  });
  if (!record.ok) throw new Error(record.error.message);
  const registered = await f.tools.register(record.value, { actorId: ACTOR });
  if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
};

const seedRun = async (f: RestartFixture, state?: string): Promise<WorkflowRun> => {
  const run = createWorkflowRun({
    companyId: 'cmp_1' as never,
    workflowId: 'wfl_1' as never,
    templateId: 'tpl_gate' as never,
    versionId: 'ver_1' as never,
    snapshotId: 'snp_1' as never,
    startedBy: ACTOR,
    now: f.clock.nowIso(),
    ids: f.ids,
  });
  if (!run.ok) throw new Error(run.error.message);
  const row = state === undefined ? run.value : { ...run.value, state: state as never };
  await f.db.runs.put(row);
  return row;
};

const seedTask = async (f: RestartFixture, kind: string, runId: string): Promise<Task> => {
  const task = createTask({
    runId: runId as never,
    stageId: STAGE_ID as never,
    roleId: 'rol_1' as never,
    kind,
    now: f.clock.nowIso(),
    ids: f.ids,
  });
  if (!task.ok) throw new Error(task.error.message);
  await f.db.tasks.put(task.value);
  return task.value;
};

/** Frozen Sprint 2 seeding pattern: leave the task RUNNING as if the process died. */
const leaveTaskRunning = async (f: RestartFixture, task: Task): Promise<void> => {
  const planned = applyTaskEvent(task, 'PLAN', f.clock.nowIso());
  if (!planned.ok) throw new Error(planned.error.message);
  const started = applyTaskEvent(planned.value, 'START', f.clock.nowIso());
  if (!started.ok) throw new Error(started.error.message);
  await f.db.tasks.put(started.value);
};

/** The mock provider + its model must be registered before runtime.prepare resolves a binding. */
const ensureMockModel = async (f: RestartFixture): Promise<void> => {
  const providers = createProviderRegistry({
    ids: f.ids,
    clock: f.clock,
    registrations: f.db.providers,
    models: f.db.providerModels,
    authorize: (async () => ok(true)) as never,
    events: f.db.events,
    systemActor: ACTOR,
  } as never);
  const reg = await providers.register(
    createMockProvider({
      providerId: 'mock-a',
      kind: 'mock',
      displayName: 'A',
      script: { models: [MODEL('standard')], outcomes: [{ outputText: 'ok' }] },
    }),
    { actorId: ACTOR },
  );
  if (!reg.ok && reg.error.code !== 'CONFLICT') throw new Error(reg.error.message);
  const models = createModelRegistry({
    ids: f.ids,
    clock: f.clock,
    records: f.db.modelRecords,
    aliases: f.db.modelAliases,
    providers,
    authorize: (async () => ok(true)) as never,
    events: f.db.events,
    scope: 'default',
  } as never);
  const model = await models.registerFromProvider({ providerId: 'mock-a', providerModelId: 'standard', actorId: ACTOR });
  if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
};

const leaveAgentRunning = async (f: RestartFixture, runId: string): Promise<string> => {
  await ensureMockModel(f);
  const prepared = await f.runtime.prepare({
    agentId: 'agent_1',
    roleId: 'rol_1',
    taskId: f.ids.id('tsk_agent'),
    runId: runId as never,
    actorId: ACTOR,
    modelKey: 'mock-a.standard',
    explicit: true,
    scopes: [],
  });
  if (!prepared.ok) throw new Error(prepared.error.message);
  await f.db.agentExecutions.put({ ...prepared.value, status: 'RUNNING' });
  return prepared.value.executionId;
};

const leaveToolStarted = async (f: RestartFixture, runId: string): Promise<string> => {
  const made = createToolInvocation({
    id: f.ids.id('tinv'),
    toolId: 'tool.gate',
    toolVersion: '1.0.0',
    executionId: f.ids.id('exec_tool'),
    agentId: 'agent_1',
    taskId: f.ids.id('tsk_tool'),
    runId,
    actorId: ACTOR,
    traceId: f.ids.id('trace'),
    riskLevel: 'LOW',
    idempotencyMode: 'IDEMPOTENT_KEY',
    idempotencyKey: f.ids.id('key'),
    input: {},
    now: f.clock.nowIso(),
  });
  if (!made.ok) throw new Error(made.error.message);
  await f.db.toolInvocations.put({ ...made.value, status: 'STARTED' });
  return made.value.id;
};

const command = (
  f: RestartFixture,
  run: WorkflowRun,
  type: RunCommandType,
  payload?: Record<string, unknown>,
  reason?: string,
): RunCommand => ({
  commandId: f.ids.id('cmd'),
  runId: run.id,
  type,
  expectedRevision: run.revision,
  actorId: ACTOR,
  traceId: f.ids.id('trace'),
  issuedAt: f.clock.nowIso(),
  ...(reason === undefined ? {} : { reason }),
  ...(payload === undefined ? {} : { payload }),
});

const dispatch = async (
  f: RestartFixture,
  runId: string,
  type: RunCommandType,
  payload?: Record<string, unknown>,
  reason?: string,
) => {
  const run = await f.db.runs.get(runId as never);
  if (run === null) throw new Error('run missing');
  const result = await f.engine.dispatch(command(f, run, type, payload, reason));
  if (!result.ok) throw new Error(`${String(type)} failed: ${result.error.code} ${result.error.message}`);
  return result.value;
};

const driveToExecuting = async (f: RestartFixture, runId: string): Promise<void> => {
  const driven = await f.engine.drive(runId as never, { maxSteps: 8 });
  if (!driven.ok) throw new Error(driven.error.message);
  expect(driven.value.run.state).toBe('EXECUTING');
};

const eventsOf = async (f: RestartFixture): Promise<readonly string[]> =>
  (await f.db.events.all()).map((entry) => entry.event.type);

/* --------------------------------------------------------------------- tests */

describe('canonical crash → restart → continuation (matrix 1–5, 7, 8, 12, 13)', () => {
  it('full 3-stage scenario: completed stage stays completed, B runs exactly once, C follows normally', async () => {
    // ---------------- PROCESS A ----------------
    const a = await openRestartFixture();
    await seedTemplate(a.db);
    await registerValidatorTool(a);
    const run = await seedRun(a);
    const taskA = await seedTask(a, 'stageA', run.id);
    const taskB = await seedTask(a, 'stageB', run.id);
    const taskC = await seedTask(a, 'stageC', run.id);

    // Real business work: drive to EXECUTING, execute Stage A, rework back to EXECUTING.
    await driveToExecuting(a, run.id);
    const advanced = await a.engine.advance({
      runId: run.id,
      stageId: STAGE_ID as never,
      taskIds: [taskA.id] as never,
      snapshot: { snapshotId: run.snapshotId as never, snapshotHash: '0'.repeat(64) as never },
    });
    expect(advanced.outcome).toBe('completed');
    await dispatch(a, run.id, 'REVIEW.REJECT', undefined, 'review requested changes');
    await dispatch(a, run.id, 'REWORK.READY');
    expect((await a.db.runs.get(run.id as never))?.state).toBe('EXECUTING');
    // Durable proof #1/#2 for Stage A: task DONE + a real Artifact (CAS + row + event).
    const storedA = await a.db.tasks.get(taskA.id as never);
    expect(storedA?.state).toBe('DONE');
    expect(storedA?.attempts).toBe(1);
    const artifact = await a.sprint13.artifactService.create({
      commandId: 'cmd_stage_a_artifact',
      runId: run.id,
      kind: 'stage.a.output',
      content: new TextEncoder().encode('stage A deliverable'),
      producedBy: ACTOR,
      traceId: 'trace_stage_a',
    });
    if (!artifact.ok) throw new Error(artifact.error.message);
    // Crash mid Stage B: task B RUNNING, agent RUNNING, tool STARTED.
    await leaveTaskRunning(a, taskB);
    await leaveAgentRunning(a, run.id);
    await leaveToolStarted(a, run.id);
    const countsA = a.stageHandlerCounts();
    expect(countsA['stageA']).toBe(1);
    a.close();

    // ---------------- PROCESS B (new object graph, same SQLite + CAS) ----------------
    const b = await reopenRestartFixture(a);
    // §32: CAS reconciliation first.
    const foundation = await openArtifactFoundation({ casRoot: b.casRoot, database: b.db, logger: nullLogger });
    expect(foundation.ok).toBe(true);
    // §31: a NEW orchestrator (fresh, process-local memo) — T14-02 module AS-IS.
    const report = await b.orchestrator.run();
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.agentsInterrupted).toBe(1);
      expect(report.value.toolsInterrupted).toBe(1);
      expect(report.value.runsRecovered).toBe(1);
    }
    // §10: no business execution during startup recovery.
    expect(b.stageHandlerCounts()['stageB'] ?? 0).toBe(0);
    expect(b.stageHandlerCounts()['stageC'] ?? 0).toBe(0);
    // Provider-zero during recovery is locked by the T14-02 counting-provider test;
    // here the agent proof is the durable INTERRUPTED row below (never COMPLETED).
    expect(b.adapterCalls()).toBe(0);
    // §16: agent residue archived with the frozen event; provider untouched.
    const agentRows = (await b.db.agentExecutions.list()).items;
    expect(agentRows[0]?.status).toBe('INTERRUPTED');
    const toolRows = (await b.db.toolInvocations.list()).items;
    expect(toolRows[0]?.status).toBe('INTERRUPTED');
    // §23/§28: resumePoint authority + ordering.
    const recoveredRun = await b.db.runs.get(run.id as never);
    expect(recoveredRun?.state).toBe('EXECUTING');
    expect(recoveredRun?.resumePoint).toBeNull();
    const bLog = b.actionLog;
    expect(bLog.findIndex((e) => e === 'agent-recover')).toBeLessThan(bLog.findIndex((e) => e === 'tool-recover'));
    expect(bLog.findIndex((e) => e === 'tool-recover')).toBeLessThan(bLog.findIndex((e) => e.startsWith('run-recover:')));
    // §8: identity preserved — same run/task/template pin; no new runs.
    expect((await b.db.runs.list({ limit: 500 })).items.map((r) => r.id)).toEqual([run.id]);
    expect((await b.db.tasks.get(taskA.id as never))?.id).toBe(taskA.id);
    expect(recoveredRun?.templateId).toBe(run.templateId);
    expect(recoveredRun?.versionId).toBe(run.versionId);
    // §27: durable recovery events queryable from the reopened store.
    const typesB = await eventsOf(b);
    expect(typesB).toContain('agent.execution_interrupted');
    expect(typesB).toContain('tool.invocation_interrupted');
    expect(typesB).toContain('run.crash_detected');
    expect(typesB).toContain('run.recovered');
    const recoveryEventSnapshot = typesB.filter((t) =>
      ['agent.execution_interrupted', 'tool.invocation_interrupted', 'run.crash_detected', 'run.recovered'].includes(t),
    ).length;

    // §11/§12: EXPLICIT continuation through the normal engine API.
    const continued = await b.engine.advance({
      runId: run.id,
      stageId: STAGE_ID as never,
      taskIds: [taskB.id, taskC.id] as never,
      snapshot: { snapshotId: run.snapshotId as never, snapshotHash: '0'.repeat(64) as never },
    });
    expect(continued.outcome).toBe('completed');
    // §7: Stage A never re-ran in Process B; §12: Stage B exactly once (dead attempt counted).
    const countsB = b.stageHandlerCounts();
    expect(countsB['stageA'] ?? 0).toBe(0);
    expect(countsB['stageB']).toBe(1);
    expect(countsB['stageC']).toBe(1);
    const storedBtask = await b.db.tasks.get(taskB.id as never);
    expect(storedBtask?.state).toBe('DONE');
    expect(storedBtask?.attempts).toBe(2);
    expect((await b.db.tasks.get(taskA.id as never))?.attempts).toBe(1);
    expect((await b.db.tasks.get(taskC.id as never))?.attempts).toBe(1);
    // §14: artifact identity preserved (same id/hash/ref), nothing recreated.
    const sameArtifact = await b.db.artifactStore!.get(artifact.value.id);
    expect(sameArtifact?.id).toBe(artifact.value.id);
    expect(sameArtifact?.contentHash).toBe(artifact.value.contentHash);
    expect(sameArtifact?.contentRef).toBe(artifact.value.contentRef);
    expect((await b.db.artifactStore!.listByRun(run.id as never)).length).toBe(1);
    // §13: Stage C followed the normal machine (REVIEWING now; normal semantics, no fork).
    expect((await b.db.runs.get(run.id as never))?.state).toBe('REVIEWING');
    // §29: continuation wrote NO duplicate recovery events.
    const typesAfter = (await eventsOf(b)).filter((t) =>
      ['agent.execution_interrupted', 'tool.invocation_interrupted', 'run.crash_detected', 'run.recovered'].includes(t),
    ).length;
    expect(typesAfter).toBe(recoveryEventSnapshot);
    // Handoff: N/A (this scenario has no natural handoff — §15).
    b.close();
  });
});

describe('evidence gate across restart (matrix 10–12, §24–§26)', () => {
  it('recovered VALIDATING run: gate REJECTS without evidence, PASSES after real evidence, pinned v1 policy survives', async () => {
    const a = await openRestartFixture();
    await seedTemplate(a.db);
    await registerValidatorTool(a);
    const run = await seedRun(a);
    const task = await seedTask(a, 'stageA', run.id);
    await driveToExecuting(a, run.id);
    await a.engine.advance({
      runId: run.id,
      stageId: STAGE_ID as never,
      taskIds: [task.id] as never,
      snapshot: { snapshotId: run.snapshotId as never, snapshotHash: '0'.repeat(64) as never },
    });
    await dispatch(a, run.id, 'REVIEW.PASS');
    expect((await a.db.runs.get(run.id as never))?.state).toBe('VALIDATING');
    const artifact = await a.sprint13.artifactService.create({
      commandId: 'cmd_gate_artifact',
      runId: run.id,
      kind: 'stage.output',
      content: new TextEncoder().encode('gate target'),
      producedBy: ACTOR,
      traceId: 'trace_gate',
    });
    if (!artifact.ok) throw new Error(artifact.error.message);
    a.close();

    const b = await reopenRestartFixture(a);
    const foundation = await openArtifactFoundation({ casRoot: b.casRoot, database: b.db, logger: nullLogger });
    expect(foundation.ok).toBe(true);
    const report = await b.orchestrator.run();
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.value.runsRecovered).toBe(1);
    expect((await b.db.runs.get(run.id as never))?.state).toBe('VALIDATING'); // resumePoint authority

    // §24: VALIDATION.PASS without durable evidence → REJECTED (gate not bypassed).
    const runRow = await b.db.runs.get(run.id as never);
    if (runRow === null) throw new Error('run');
    const forged = await b.engine.dispatch({
      ...command(b, runRow, 'VALIDATION.PASS'),
      payload: { artifactId: artifact.value.id, stageId: 's1' },
    });
    expect(forged.ok).toBe(false);
    expect((await b.db.runs.get(run.id as never))?.state).toBe('VALIDATING');

    // §26: run-pinned policy survives restart — v1 (tool.gate), not current v2 (tool.other).
    const pinned = await b.sprint13.stagePolicy.requiredValidators({ runId: run.id, stageId: 's1' });
    expect(pinned.ok).toBe(true);
    if (pinned.ok) expect(pinned.value).toEqual(['tool.gate']);

    // §25: REAL evidence through ValidationService → Resolver → Tool Registry.
    const evidence = await b.sprint13.validationService.run({
      commandId: 'cmd_evidence_1',
      actorId: ACTOR,
      runId: run.id,
      stageId: 's1' as never,
      targetRef: `artifact:${artifact.value.id}` as never,
      validators: [{ validatorId: 'tool.gate', blocking: true }],
      traceId: 'trace_evidence',
    });
    expect(evidence.ok).toBe(true);
    expect(b.adapterCalls()).toBe(1); // real validator execution — explicit continuation work

    const runRow2 = await b.db.runs.get(run.id as never);
    if (runRow2 === null) throw new Error('run2');
    const passed = await b.engine.dispatch({
      ...command(b, runRow2, 'VALIDATION.PASS'),
      payload: { artifactId: artifact.value.id, stageId: 's1' },
    });
    expect(passed.ok).toBe(true);
    expect((await b.db.runs.get(run.id as never))?.state).toBe('FINALIZING');
    b.close();
  });
});

describe('manual + special states across a real restart (matrix 6–8, §19–§21)', () => {
  it('WAITING_APPROVAL tool, PAUSED run and WAITING_APPROVAL run survive a restart untouched', async () => {
    const a = await openRestartFixture();
    await registerValidatorTool(a);
    const pausedRun = await seedRun(a);
    await driveToExecuting(a, pausedRun.id);
    await dispatch(a, pausedRun.id, 'RUN.PAUSE', undefined, 'manual pause for the restart test');
    expect((await a.db.runs.get(pausedRun.id as never))?.state).toBe('PAUSED');
    // A run waiting for approval: drive with HIGH risk → WAITING_APPROVAL (needs a fresh run).
    const waitingRun = await seedRun(a);
    const driven = await a.engine.drive(waitingRun.id as never, { maxSteps: 8, risk: 'HIGH' });
    if (!driven.ok) throw new Error(driven.error.message);
    expect(driven.value.run.state).toBe('WAITING_APPROVAL');
    // A tool invocation left WAITING_APPROVAL.
    const made = createToolInvocation({
      id: a.ids.id('tinv'),
      toolId: 'tool.gate',
      toolVersion: '1.0.0',
      executionId: a.ids.id('exec_w'),
      agentId: 'agent_1',
      taskId: a.ids.id('tsk_w'),
      runId: waitingRun.id,
      actorId: ACTOR,
      traceId: a.ids.id('trace'),
      riskLevel: 'HIGH',
      idempotencyMode: 'IDEMPOTENT_KEY',
      idempotencyKey: a.ids.id('key'),
      input: {},
      now: a.clock.nowIso(),
    });
    if (!made.ok) throw new Error(made.error.message);
    await a.db.toolInvocations.put({ ...made.value, status: 'WAITING_APPROVAL' });
    a.close();

    const b = await reopenRestartFixture(a);
    const report = await b.orchestrator.run();
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.runsPaused).toBe(1);
      expect(report.value.runsWaitingApproval).toBe(1);
      expect(report.value.toolsWaitingApproval).toBe(1);
      expect(report.value.toolsInterrupted).toBe(0);
      expect(report.value.runsRecovered).toBe(0);
    }
    expect((await b.db.runs.get(pausedRun.id as never))?.state).toBe('PAUSED');
    expect((await b.db.runs.get(waitingRun.id as never))?.state).toBe('WAITING_APPROVAL');
    expect((await b.db.toolInvocations.list()).items[0]?.status).toBe('WAITING_APPROVAL');
    const types = await eventsOf(b);
    expect(types).not.toContain('run.crash_detected');
    expect(types).not.toContain('run.recovered');
    expect(b.adapterCalls()).toBe(0);
    b.close();
  });

  it('RECOVERING across restart: completes the existing cycle, no second crash_detected', async () => {
    const a = await openRestartFixture();
    const run = await seedRun(a);
    await driveToExecuting(a, run.id);
    await dispatch(a, run.id, 'CRASH.DETECTED'); // died AFTER crash detection persisted
    expect((await a.db.runs.get(run.id as never))?.state).toBe('RECOVERING');
    a.close();

    const b = await reopenRestartFixture(a);
    const report = await b.orchestrator.run();
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.value.recoveringRunsCompleted).toBe(1);
    expect((await b.db.runs.get(run.id as never))?.state).toBe('EXECUTING');
    const all = await b.db.events.all();
    expect(all.filter((e) => e.event.type === 'run.crash_detected')).toHaveLength(1);
    expect(all.filter((e) => e.event.type === 'run.recovered')).toHaveLength(1);
    b.close();
  });
});

describe('crashable-state restart matrix (§22, matrix 9)', () => {
  it('every CRASHABLE state persists → reopens → recovers to its own resume point', async () => {
    const states = ['PLANNING', 'ROUTING', 'EXECUTING', 'REVIEWING', 'VALIDATING', 'FINALIZING'];
    const a = await openRestartFixture();
    const idsByState = new Map<string, string>();
    for (const state of states) {
      const run = await seedRun(a, state);
      idsByState.set(state, run.id);
    }
    a.close();

    const b = await reopenRestartFixture(a);
    const report = await b.orchestrator.run();
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.runsRecovered).toBe(states.length);
      expect(report.value.runsScanned).toBe(states.length);
    }
    for (const state of states) {
      const runId = idsByState.get(state)!;
      const run = await b.db.runs.get(runId as never);
      expect({ state, final: run?.state, resumePoint: run?.resumePoint }).toEqual({
        state,
        final: state,
        resumePoint: null,
      });
    }
    b.close();
  });
});

describe('CAS integrity gates recovery (§32/§33, matrix 14)', () => {
  it('metadata→CAS missing: startup fails AT CAS reconciliation, recovery never runs, residue untouched', async () => {
    const a = await openRestartFixture();
    await registerValidatorTool(a);
    const run = await seedRun(a, 'EXECUTING');
    const artifact = await a.sprint13.artifactService.create({
      commandId: 'cmd_cas_fatal',
      runId: run.id,
      kind: 'stage.output',
      content: new TextEncoder().encode('will lose its CAS object'),
      producedBy: ACTOR,
      traceId: 'trace_cas',
    });
    if (!artifact.ok) throw new Error(artifact.error.message);
    await leaveAgentRunning(a, run.id);
    await leaveToolStarted(a, run.id);
    a.close();
    // External corruption between processes (test-side only).
    const { rmSync } = await import('node:fs');
    rmSync(join(a.casRoot, artifact.value.contentHash.slice(0, 2), artifact.value.contentHash));

    const b = await reopenRestartFixture(a);
    const foundation = await openArtifactFoundation({ casRoot: b.casRoot, database: b.db, logger: nullLogger });
    expect(foundation.ok).toBe(false);
    // Production behavior on a fatal foundation: startup fails closed BEFORE recovery —
    // no orchestrator.run(), durable residue untouched, zero recovery events.
    expect((await b.db.runs.get(run.id as never))?.state).toBe('EXECUTING');
    expect((await b.db.agentExecutions.list()).items[0]?.status).toBe('RUNNING');
    expect((await b.db.toolInvocations.list()).items[0]?.status).toBe('STARTED');
    const types = await eventsOf(b);
    expect(types).not.toContain('run.crash_detected');
    expect(types).not.toContain('run.recovered');
    expect(types).not.toContain('agent.execution_interrupted');
    expect(types).not.toContain('tool.invocation_interrupted');
    b.close();
  });
});

describe('second actual restart = NEW crash cycle (§30/§31, matrix 15)', () => {
  it('A crashes → B recovers → B dies before continuation → C recovers again (legitimate new cycle)', async () => {
    const a = await openRestartFixture();
    const run = await seedRun(a, 'EXECUTING');
    a.close();

    const b = await reopenRestartFixture(a);
    const first = await b.orchestrator.run();
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.runsRecovered).toBe(1);
    expect((await b.db.runs.get(run.id as never))?.state).toBe('EXECUTING');
    b.close(); // dies BEFORE any continuation — the run rests crashable again

    const c = await reopenRestartFixture(b);
    // Fresh orchestrator, EMPTY memo (process-local only — §31): the still-crashable
    // run is a NEW crash cycle and is recovered again, with NEW durable events.
    const second = await c.orchestrator.run();
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.runsRecovered).toBe(1);
    expect((await c.db.runs.get(run.id as never))?.state).toBe('EXECUTING');
    const all = await c.db.events.all();
    expect(all.filter((e) => e.event.type === 'run.crash_detected')).toHaveLength(2);
    expect(all.filter((e) => e.event.type === 'run.recovered')).toHaveLength(2);
    c.close();
  });
});
