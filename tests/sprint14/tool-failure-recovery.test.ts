/**
 * Sprint 14 / Task-14-05: Tool Failure Recovery End-to-End (Sprint 9/9.1 frozen
 * contract + ADR-0018/0019; roadmap AC14.1 Tool-Failure side).
 *
 * Recon conclusions this suite LOCKS (the final report's matrix):
 *   - Retry eligibility (canRetryInvocation, frozen): ONLY status INTERRUPTED with
 *     idempotencyMode !== 'NONE'. A known FAILED / WAITING_APPROVAL / COMPLETED
 *     invocation is refused with CONFLICT — the "known FAILED retry" scenario is
 *     therefore FAIL-CLOSED by existing contract, not a retry path.
 *   - A retry is a NEW invocation via the normal registry.invoke path: fresh id,
 *     parentInvocationId = the interrupted attempt, stable rootInvocationId,
 *     strictly increasing attemptNumber, and its OWN derived idempotency key —
 *     the old row is never mutated, never "revived".
 *   - Version provenance: each invocation captures the executing ToolRecord.version
 *     at creation (line 503) — a retry executes the CURRENT durable record version.
 *     Same-id re-registration is refused (CONFLICT), so registry drift on one toolId
 *     is not reachable through the public API (the approve-path drift guard of
 *     ADR-0019 stays authoritative for WAITING approvals).
 *   - COMPLETED replays go through replayOutput (digest-verified, original status
 *     preserved) — never through retryInvocation.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DomainError,
  FixedClock,
  SequenceIdFactory,
  TOOL_CAPABILITY_VALIDATOR,
  createTask,
  createToolInvocation,
  createToolRecord,
  createWorkflowRun,
  ok,
  type ToolPort,
  type ToolResult,
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
  type StageHandler,
  type StageHandlerRegistry,
} from '@companyos/engine';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';
import { composeSprint13Application } from '../../apps/desktop/src/artifact-stack.js';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const EPOCH = Date.parse('2026-09-26T00:00:00.000Z');
const ACTOR = 'user_owner';
const INTRUDER = 'user_intruder';
const STAGE_ID = 'stg_1';

const created: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
const openFixtures: ToolFixture[] = [];
afterEach(() => {
  while (openFixtures.length > 0) openFixtures.pop()?.close();
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

interface ToolFixture {
  readonly tag: string;
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly ids: SequenceIdFactory;
  readonly clock: FixedClock;
  readonly runtime: ReturnType<typeof createAgentRuntime>;
  readonly gateEngine: ReturnType<typeof createWorkflowEngine>;
  readonly sprint13: ReturnType<typeof composeSprint13Application>;
  readonly orchestrator: ReturnType<typeof createStartupRecoveryOrchestrator>;
  readonly tools: ReturnType<typeof createToolRegistry>;
  readonly stageHandlerCounts: () => Record<string, number>;
  /** Per-tool side-effect counters (the controlled adapters increment on EVERY execute). */
  readonly adapterCounts: () => Record<string, number>;
  close(): void;
}

let generation = 0;

const openToolFixture = async (options: { readonly dataDir?: string; readonly casRoot?: string } = {}): Promise<ToolFixture> => {
  generation += 1;
  const tag = `T${String(generation)}`;
  const dataDir = options.dataDir ?? tempDir(`companyos-t14tool-${tag}-`);
  const casRoot = options.casRoot ?? tempDir(`companyos-t14tool-${tag}-cas-`);
  return await compose(dataDir, casRoot, tag);
};

const reopenToolFixture = async (previous: ToolFixture): Promise<ToolFixture> => {
  previous.close();
  generation += 1;
  return await compose(previous.dataDir, previous.casRoot, `T${String(generation)}`);
};

const compose = async (dataDir: string, casRoot: string, tag: string): Promise<ToolFixture> => {
  const db = openDurableDatabase({
    dataDir,
    appliedAt: new Date(EPOCH).toISOString(),
    chains: ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact'],
  });
  const failSafe = (error: unknown): never => {
    db.close();
    throw error instanceof Error ? error : new Error(String(error));
  };
  try {
    const clock = new FixedClock(EPOCH);
    const ids = new SequenceIdFactory(tag);
    const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
    const bootstrap = await ensureBootstrapOwner(authz, { actorId: ACTOR, companyId: 'company_default' });
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);
    const sessionAuthorize = async (input: { readonly actorId: string; readonly authority: string; readonly scopeId?: string }) => {
      if (input.actorId !== ACTOR) {
        return { ok: false as const, error: new DomainError('POLICY_DENIED', 'not the session actor', {}) };
      }
      return authz.decide({ actorId: input.actorId, authority: input.authority });
    };

    const providers = createProviderRegistry({
      ids, clock, registrations: db.providers, models: db.providerModels,
      authorize: sessionAuthorize as never, events: db.events, systemActor: ACTOR,
    } as never);
    const models = createModelRegistry({
      ids, clock, records: db.modelRecords, aliases: db.modelAliases, providers,
      authorize: sessionAuthorize as never, events: db.events, scope: 'default',
    } as never);
    const policies = createSelectionPolicyService({
      ids, clock, policies: db.selectionPolicies, results: db.benchmarkResults,
      readRecords: async () => models.list({ includeDisabled: true }),
      authorize: sessionAuthorize as never, events: db.events,
    } as never);

    const counters: Record<string, number> = { 'tool.idem': 0, 'tool.unsafe': 0, 'tool.gate': 0 };
    const adapterOf = (toolId: string): ToolPort => ({
      describe: () => ({
        toolId,
        name: toolId,
        description: toolId,
        version: '1.0.0',
        riskLevel: 'LOW',
        capabilities: toolId === 'tool.gate' ? [TOOL_CAPABILITY_VALIDATOR] : [],
        parameters: { type: 'object' },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      }),
      invoke: async () => {
        counters[toolId] = (counters[toolId] ?? 0) + 1;
        return ok({
          status: 'ok',
          output: toolId === 'tool.gate' ? { verdict: 'pass', evidenceRefs: [] } : { done: true },
          artifactRefs: [],
          startedAt: clock.nowIso(),
          finishedAt: clock.nowIso(),
          latencyMs: 1,
        } satisfies ToolResult);
      },
    });
    const tools = createToolRegistry({
      ids, clock, records: db.toolRecords, invocations: db.toolInvocations,
      invocationArtifacts: db.toolInvocationArtifacts,
      adapters: new Map<string, ToolPort>([['tool.idem', adapterOf('tool.idem')], ['tool.unsafe', adapterOf('tool.unsafe')], ['tool.gate', adapterOf('tool.gate')]]),
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
    for (const [toolId, mode] of [['tool.idem', 'IDEMPOTENT_KEY'], ['tool.unsafe', 'NONE'], ['tool.gate', 'IDEMPOTENT_KEY']] as const) {
      const record = createToolRecord({
        toolId,
        name: toolId,
        description: toolId,
        version: '1.0.0',
        capabilities: toolId === 'tool.gate' ? [TOOL_CAPABILITY_VALIDATOR] : [],
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        riskLevel: 'LOW',
        requiredAuthorities: ['tool.invoke'],
        idempotencyMode: mode,
        now: clock.nowIso(),
      });
      if (!record.ok) throw new Error(record.error.message);
      const registered = await tools.register(record.value, { actorId: ACTOR });
      if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
    }

    const runtime = createAgentRuntime({
      ids, clock, executions: db.agentExecutions, artifacts: db.executionArtifacts,
      models, providers, policies, tools, events: db.events,
      authorize: sessionAuthorize as never, secrets: async () => [],
    } as never);
    // The mock provider registration keeps runtime.prepare resolvable (unused here,
    // but the orchestrator dependency graph is the production one).
    const providerRegistered = await providers.register(
      createMockProvider({ providerId: 'mock-a', kind: 'mock', displayName: 'A', script: { models: [MODEL('standard')], outcomes: [{ outputText: 'ok' }] } }),
      { actorId: ACTOR },
    );
    if (!providerRegistered.ok && providerRegistered.error.code !== 'CONFLICT') throw new Error(providerRegistered.error.message);

    const sprint13 = composeSprint13Application({
      database: db, contentStore: createFilesystemArtifactContentStore({ casRoot }),
      clock, ids, authorize: sessionAuthorize as never, tools, logger: nullLogger,
    });

    const handlerCounts: Record<string, number> = {};
    const handlerOf = (kind: string): StageHandler => ({
      id: `handler.${kind}`,
      execute: () => {
        handlerCounts[kind] = (handlerCounts[kind] ?? 0) + 1;
        return 'succeeded';
      },
    });
    const handlers: StageHandlerRegistry = { resolve: (kind: string) => handlerOf(kind) };
    const gateEngine = createWorkflowEngine({
      ids, clock, runs: db.runs, events: db.events, approvals: db.approvals,
      tasks: db.tasks, handlers, ledger: db.ledger, unitOfWork: db.unitOfWork,
      validationGate: sprint13.engineValidationGate,
    });
    const orchestrator = createStartupRecoveryOrchestrator({
      actorId: ACTOR, runtime, tools, engine: gateEngine, runs: db.runs,
    });

    let closed = false;
    const fixture: ToolFixture = {
      tag, db, dataDir, casRoot, ids, clock, runtime, gateEngine, sprint13, orchestrator, tools,
      stageHandlerCounts: () => ({ ...handlerCounts }),
      adapterCounts: () => ({ ...counters }),
      close(): void {
        if (closed) return;
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

/* ------------------------------------------------------------------ helpers */

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
      { id: 'ver_1', templateId: 'tpl_gate' as never, semver: '1.0.0', contentHash: 'a'.repeat(64), changeProposalId: null, immutable: true, createdBy: ACTOR, createdAt: new Date(EPOCH).toISOString(), graph: { nodes: [{ id: 's1', kind: 'work', title: 'S1', config: { validatorIds: ['tool.gate'] } }], edges: [] } },
      { id: 'ver_2', templateId: 'tpl_gate' as never, semver: '2.0.0', contentHash: 'b'.repeat(64), changeProposalId: null, immutable: true, createdBy: ACTOR, createdAt: new Date(EPOCH).toISOString(), graph: { nodes: [{ id: 's1', kind: 'work', title: 'S1', config: { validatorIds: ['tool.other'] } }], edges: [] } },
    ],
  };
  await db.templates.put(template);
};

const seedRun = async (f: ToolFixture, state?: string): Promise<string> => {
  const run = createWorkflowRun({
    companyId: 'cmp_1' as never, workflowId: 'wfl_1' as never, templateId: 'tpl_gate' as never,
    versionId: 'ver_1' as never, snapshotId: 'snp_1' as never, startedBy: ACTOR,
    now: f.clock.nowIso(), ids: f.ids,
  });
  if (!run.ok) throw new Error(run.error.message);
  const row = state === undefined ? run.value : { ...run.value, state: state as never };
  await f.db.runs.put(row);
  return row.id;
};

const seedTask = async (f: ToolFixture, kind: string, runId: string): Promise<string> => {
  const made = createTask({ runId: runId as never,  stageId: STAGE_ID as never, roleId: 'rol_1' as never, kind, now: f.clock.nowIso(), ids: f.ids });
  if (!made.ok) throw new Error(made.error.message);
  await f.db.tasks.put(made.value);
  return made.value.id;
};

/** Frozen seeding pattern (Sprint 8/9/T14-02): a STARTED row as if the process died mid-execution. */
const seedStartedInvocation = async (
  f: ToolFixture,
  runId: string,
  taskId: string,
  options: { readonly toolId?: string; readonly mode?: 'IDEMPOTENT_KEY' | 'NONE'; readonly attempt?: { readonly parentInvocationId: string; readonly rootInvocationId: string; readonly attemptNumber: number } } = {},
): Promise<string> => {
  const made = createToolInvocation({
    id: f.ids.id('tinv'),
    toolId: options.toolId ?? 'tool.idem',
    toolVersion: '1.0.0',
    executionId: f.ids.id('exec'),
    agentId: 'agent_1',
    taskId,
    runId,
    actorId: ACTOR,
    traceId: f.ids.id('trace'),
    riskLevel: 'LOW',
    idempotencyMode: options.mode ?? 'IDEMPOTENT_KEY',
    idempotencyKey: f.ids.id('key'),
    input: {},
    now: f.clock.nowIso(),
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
  });
  if (!made.ok) throw new Error(made.error.message);
  await f.db.toolInvocations.put({ ...made.value, status: 'STARTED' });
  return made.value.id;
};

const dispatch = async (f: ToolFixture, runId: string, type: string, extra: Record<string, unknown> = {}) => {
  const run = await f.db.runs.get(runId as never);
  if (run === null) throw new Error('run missing');
  const result = await f.gateEngine.dispatch({
    commandId: f.ids.id('cmd'),
    runId: runId as never,
    type: type as never,
    expectedRevision: run.revision,
    actorId: ACTOR,
    traceId: f.ids.id('trace'),
    issuedAt: f.clock.nowIso(),
    ...extra,
  });
  if (!result.ok) throw new Error(`${type} failed: ${result.error.code} ${result.error.message}`);
  return result.value;
};

const rowsOf = async (f: ToolFixture) => (await f.db.toolInvocations.list({ limit: 500 })).items;
const eventTypes = async (f: ToolFixture): Promise<readonly string[]> =>
  (await f.db.events.all()).map((entry) => entry.event.type);

/* -------------------------------------------------------------------- tests */

describe('full restart E2E — retryable INTERRUPTED (matrix 1,2,3,6,7,12,14,15,16,18,26,30)', () => {
  it('STARTED → restart recovery INTERRUPTED → explicit retry = new attempt → workflow continues', async () => {
    // ---------------- PROCESS A: crash mid tool execution ----------------
    const a = await openToolFixture();
    await seedTemplate(a.db);
    const runId = await seedRun(a);
    const taskA = await seedTask(a, 'stageA', runId);
    const taskB = await seedTask(a, 'stageB', runId);
    const driven = await a.gateEngine.drive(runId as never, { maxSteps: 8 });
    if (!driven.ok) throw new Error(driven.error.message);
    const advanced = await a.gateEngine.advance({
      runId: runId as never, stageId: STAGE_ID as never, taskIds: [taskA as never],
      snapshot: { snapshotId: 'snp_1' as never, snapshotHash: '0'.repeat(64) as never },
    });
    expect(advanced.outcome).toBe('completed');
    await dispatch(a, runId, 'REVIEW.REJECT', { reason: 'review requested changes' });
    await dispatch(a, runId, 'REWORK.READY');
    expect(a.stageHandlerCounts()['stageA']).toBe(1);
    const interruptedId = await seedStartedInvocation(a, runId, taskB, { toolId: 'tool.idem' });
    const rowsA = await rowsOf(a);
    const original = rowsA[0];
    expect(original?.status).toBe('STARTED');
    expect(a.adapterCounts()['tool.idem']).toBe(0); // died before any adapter execution
    a.close();

    // ---------------- PROCESS B: reopen + startup recovery ----------------
    const b = await reopenToolFixture(a);
    // Same-id re-registration is refused — durable tool identity/version is never rewritten (§18).
    const driftedRecord = createToolRecord({
      toolId: 'tool.idem', name: 'tool.idem', description: 'x', version: '9.9.9',
      capabilities: [], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      riskLevel: 'LOW', idempotencyMode: 'IDEMPOTENT_KEY', now: b.clock.nowIso(),
    });
    if (!driftedRecord.ok) throw new Error(driftedRecord.error.message);
    const drift = await b.tools.register(driftedRecord.value, { actorId: ACTOR });
    expect(drift.ok).toBe(false);
    if (!drift.ok) expect(drift.error.code).toBe('CONFLICT');

    const report = await b.orchestrator.run();
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.value.toolsInterrupted).toBe(1);
    expect(b.adapterCounts()['tool.idem']).toBe(0); // startup: interruption reconciliation only
    const afterRecovery = (await rowsOf(b)).find((r) => r.id === interruptedId);
    expect(afterRecovery?.status).toBe('INTERRUPTED'); // never "revived" (§4)
    expect((await eventTypes(b))).toContain('tool.invocation_interrupted');

    // ---------------- EXPLICIT manual retry (the ONLY path back to execution) ----------------
    const retried = await b.tools.retryInvocation(interruptedId, ACTOR);
    expect(retried.ok).toBe(true);
    expect(b.adapterCounts()['tool.idem']).toBe(1); // exactly one adapter execution
    const rowsB = await rowsOf(b);
    const oldRow = rowsB.find((r) => r.id === interruptedId);
    const newRow = rowsB.find((r) => r.id !== interruptedId);
    // Old row immutable (§23): still INTERRUPTED, original identity/version intact.
    expect(oldRow?.status).toBe('INTERRUPTED');
    expect(oldRow?.toolVersion).toBe('1.0.0');
    expect(oldRow?.outputDigest).toBeNull(); // never retro-completed; interruption is its own verdict
    // New attempt lineage (§5/§7): parent -> interrupted attempt, stable root, attempt 2.
    expect(newRow?.status).toBe('COMPLETED');
    expect(newRow?.parentInvocationId).toBe(interruptedId);
    expect(newRow?.rootInvocationId).toBe(original?.rootInvocationId);
    expect(newRow?.attemptNumber).toBe(2);
    expect(newRow?.toolVersion).toBe('1.0.0'); // current durable record version (§13/§14)
    expect(newRow?.idempotencyKey).not.toBe(original?.idempotencyKey); // own derived key (§21)
    // Workflow context preserved (§24): same run/task; no new runs.
    expect(newRow?.runId).toBe(runId);
    expect(newRow?.taskId).toBe(taskB);
    expect((await b.db.runs.list({ limit: 500 })).items.map((r) => r.id)).toEqual([runId]);

    // ---------------- Workflow continues through the normal engine path (§25/§26) ----------------
    const continued = await b.gateEngine.advance({
      runId: runId as never, stageId: STAGE_ID as never, taskIds: [taskB as never],
      snapshot: { snapshotId: 'snp_1' as never, snapshotHash: '0'.repeat(64) as never },
    });
    expect(continued.outcome).toBe('completed');
    expect(b.stageHandlerCounts()['stageB']).toBe(1);
    expect(b.stageHandlerCounts()['stageA'] ?? 0).toBe(0); // completed prior stage NOT rerun
    expect((await b.db.runs.get(runId as never))?.state).toBe('REVIEWING');
    b.close();

    // ---------------- PROCESS C: lineage + replay after a SECOND restart (§30/§44) ----------------
    const c = await reopenToolFixture(b);
    const rowsC = await rowsOf(c);
    expect(rowsC.find((r) => r.id === interruptedId)?.status).toBe('INTERRUPTED');
    expect(rowsC.find((r) => r.id === newRow?.id)?.status).toBe('COMPLETED');
    const typesC = await eventTypes(c);
    for (const expected of ['tool.invocation_interrupted', 'tool.invocation_requested', 'tool.invocation_started', 'tool.invocation_completed']) {
      expect(typesC).toContain(expected);
    }
    // ADR-0018 replay: the same idempotency key replays the COMPLETED facts, zero re-execution.
    const replay = await c.tools.invoke({
      toolId: 'tool.idem',
      executionId: 'exec_replay_probe',
      agentId: 'agent_1',
      taskId: taskB,
      runId,
      actorId: ACTOR,
      traceId: 'trace_replay',
      input: {},
      idempotencyKey: newRow?.idempotencyKey as string,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.status).toBe('COMPLETED'); // original facts, not a rerun
    expect(c.adapterCounts()['tool.idem']).toBe(0);
    expect((await eventTypes(c))).toContain('tool.invocation_replayed');
    c.close();
  });
});

describe('fail-closed retry policies (matrix 4,5,9,10,20)', () => {
  it('non-idempotent INTERRUPTED: manual retry DENIED, zero adapter calls, row unchanged', async () => {
    const a = await openToolFixture();
    const runId = await seedRun(a);
    const taskB = await seedTask(a, 'stageB', runId);
    const unsafeId = await seedStartedInvocation(a, runId, taskB, { toolId: 'tool.unsafe', mode: 'NONE' });
    a.close();

    const b = await reopenToolFixture(a);
    await b.orchestrator.run(); // STARTED -> INTERRUPTED
    const refused = await b.tools.retryInvocation(unsafeId, ACTOR);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('POLICY_DENIED');
    expect(b.adapterCounts()['tool.unsafe']).toBe(0);
    expect((await rowsOf(b))).toHaveLength(1);
    expect((await rowsOf(b))[0]?.status).toBe('INTERRUPTED');
    b.close();
  });

  it('known FAILED / WAITING_APPROVAL / COMPLETED are not retryable (existing contract is authority)', async () => {
    const f = await openToolFixture();
    const runId = await seedRun(f);
    const taskB = await seedTask(f, 'stageB', runId);

    // A known FAILED invocation (adapter returned failure) — retry refuses with CONFLICT.
    const failedId = await seedStartedInvocation(f, runId, taskB, { toolId: 'tool.idem' });
    await f.tools.recoverInvocations(ACTOR); // STARTED -> INTERRUPTED first…
    const executed = await f.tools.retryInvocation(failedId, ACTOR); // …then a real retry
    expect(executed.ok).toBe(true);
    // Now craft the terminal states through legal rows and prove retry refuses each.
    const rows = await rowsOf(f);
    void rows;
    // COMPLETED (the retry above) cannot be retried again:
    const completedRow = (await rowsOf(f)).find((r) => r.attemptNumber === 2);
    expect(completedRow?.status).toBe('COMPLETED');
    const completedRetry = await f.tools.retryInvocation(completedRow?.id as string, ACTOR);
    expect(completedRetry.ok).toBe(false);
    if (!completedRetry.ok) expect(completedRetry.error.code).toBe('CONFLICT');

    // WAITING_APPROVAL: retry refuses; approve/deny remains the only path.
    const waitingId = await seedStartedInvocation(f, runId, taskB, { toolId: 'tool.idem' });
    await f.db.toolInvocations.put({ ...((await rowsOf(f)).find((r) => r.id === waitingId))!, status: 'WAITING_APPROVAL' as never });
    const waitingRetry = await f.tools.retryInvocation(waitingId, ACTOR);
    expect(waitingRetry.ok).toBe(false);
    if (!waitingRetry.ok) expect(waitingRetry.error.code).toBe('CONFLICT');
    expect((await rowsOf(f)).find((r) => r.id === waitingId)?.status).toBe('WAITING_APPROVAL');

    // A known FAILED row is refused too (seed one directly in the terminal state).
    const failedKnownId = await seedStartedInvocation(f, runId, taskB, { toolId: 'tool.idem' });
    const failedKnown = (await rowsOf(f)).find((r) => r.id === failedKnownId);
    await f.db.toolInvocations.put({ ...failedKnown!, status: 'FAILED' as never });
    const failedRetry = await f.tools.retryInvocation(failedKnownId, ACTOR);
    expect(failedRetry.ok).toBe(false);
    if (!failedRetry.ok) expect(failedRetry.error.code).toBe('CONFLICT');
    expect(f.adapterCounts()['tool.idem']).toBe(1); // only the ONE successful retry above
    f.close();
  });

  it('unauthorized actor cannot retry (real session authorization seam)', async () => {
    const a = await openToolFixture();
    const runId = await seedRun(a);
    const taskB = await seedTask(a, 'stageB', runId);
    const id = await seedStartedInvocation(a, runId, taskB, { toolId: 'tool.idem' });
    a.close();

    const b = await reopenToolFixture(a);
    await b.orchestrator.run();
    const denied = await b.tools.retryInvocation(id, INTRUDER);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('POLICY_DENIED');
    expect(b.adapterCounts()['tool.idem']).toBe(0);
    b.close();
  });
});

describe('attempt chain lineage 2 → 3 (matrix 8, §22)', () => {
  it('retrying the second interrupted attempt produces attempt 3 on the SAME root chain', async () => {
    const f = await openToolFixture();
    const runId = await seedRun(f);
    const taskB = await seedTask(f, 'stageB', runId);
    // Attempt 1 dies mid-flight.
    const attempt1 = await seedStartedInvocation(f, runId, taskB, { toolId: 'tool.idem' });
    const root1 = (await rowsOf(f)).find((r) => r.id === attempt1)?.rootInvocationId;
    await f.tools.recoverInvocations(ACTOR); // -> INTERRUPTED
    // Attempt 2 (a retry that itself died mid-flight) — legal attempt-chain seeding.
    const attempt2 = await seedStartedInvocation(f, runId, taskB, {
      toolId: 'tool.idem',
      attempt: { parentInvocationId: attempt1, rootInvocationId: root1 as string, attemptNumber: 2 },
    });
    await f.tools.recoverInvocations(ACTOR); // attempt 2 -> INTERRUPTED as well
    const retried = await f.tools.retryInvocation(attempt2, ACTOR);
    expect(retried.ok).toBe(true);
    const attempt3 = (await rowsOf(f)).find((r) => r.attemptNumber === 3);
    expect(attempt3?.status).toBe('COMPLETED');
    expect(attempt3?.parentInvocationId).toBe(attempt2);
    expect(attempt3?.rootInvocationId).toBe(root1); // stable root across the whole chain
    expect(attempt3?.idempotencyKey).not.toBe(
      (await rowsOf(f)).find((r) => r.id === attempt2)?.idempotencyKey,
    );
    f.close();
  });
});

describe('no automatic / background retry (matrix 19, §32/§33)', () => {
  it('startup recovery and the retry module contain no retry-on-startup, timers or schedulers', () => {
    const recovery = readFileSync(repo('packages/engine/src/recovery/startup-recovery.ts'), 'utf8');
    expect(recovery.includes('retryInvocation')).toBe(false); // manual means manual
    expect(recovery.includes('setInterval')).toBe(false);
    const main = readFileSync(repo('apps/desktop/src/main.ts'), 'utf8');
    expect(main.includes('retryInvocation')).toBe(false);
    expect(main.includes('setInterval')).toBe(false);
  });
});
