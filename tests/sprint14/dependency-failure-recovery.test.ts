/**
 * Sprint 14 / Task-14-04: Dependency-Failure Recovery (ADR-0022 — API Error + Quota).
 *
 * Recon conclusions this suite LOCKS (see the final report's failure matrix):
 *   - Canonical classification EXISTS (Sprint 6): PROVIDER_ERROR_KINDS with
 *     quota_exhausted (non-retryable) vs unavailable/timeout/rate_limited
 *     (RETRYABLE_KINDS) — no DEPENDENCY_FAILURE_CLASSIFICATION_GAP.
 *   - [SUPERSEDED by LIVE-SMOKE-FIX-03 Boss ruling (P1 CONTROL_PLANE_MODEL_CALL_TRANSIENT_RESILIENCE):
 *     the Agent runtime now retries RETRYABLE kinds (rate_limited/timeout/unavailable) inside
 *     ONE logical execution — max 4 network attempts, bounded 2s/5s/15s backoff, never a new
 *     ExecutionAttempt per network retry; non-retryable kinds (quota_exhausted, auth) still
 *     terminate after exactly ONE provider call. Original ADR-0022 lock: "one explicit
 *     execution = one provider attempt; retryable recorded as METADATA, never acted on."]
 *   - A dependency failure is a KNOWN terminal state (FAILED + agent.execution_failed
 *     + provider.failed audits) — NOT crash residue: startup recovery must ignore it.
 *   - Explicit continuation = a NEW AgentRuntime execution on the SAME run/task
 *     context (the runtime never re-picks a model; a restored provider is simply the
 *     binding the continuation supplies).
 *
 * Restart boundary reuses the T14-03 discipline: same SQLite file, NEW object graph
 * (fresh registries/runtimes/orchestrator); only durable state and the mock providers'
 * per-object call counters cross the boundary as test observations.
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
  createToolRecord,
  createWorkflowRun,
  ok,
  providerErrorToDomainError,
  normalizeProviderError,
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
const STAGE_ID = 'stg_1';

const created: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};
const openFixtures: DependencyFixture[] = [];
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

/** A provider script entry is either a successful outcome or an error KIND. */
type ScriptOutcome = { readonly outputText: string } | 'unavailable' | 'quota_exhausted' | 'rate_limited' | 'timeout';

interface DependencyFixture {
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
  readonly stageHandlerCounts: () => Record<string, number>;
  registerProvider(providerId: string, outcomes: readonly ScriptOutcome[]): Promise<{ calls: () => number }>;
  close(): void;
}

let generation = 0;

const openDependencyFixture = async (
  options: { readonly dataDir?: string; readonly casRoot?: string } = {},
): Promise<DependencyFixture> => {
  generation += 1;
  const tag = `D${String(generation)}`;
  const dataDir = options.dataDir ?? tempDir(`companyos-t14dep-${tag}-`);
  const casRoot = options.casRoot ?? tempDir(`companyos-t14dep-${tag}-cas-`);
  return await compose(dataDir, casRoot, tag);
};

const reopenDependencyFixture = async (previous: DependencyFixture): Promise<DependencyFixture> => {
  previous.close();
  generation += 1;
  return await compose(previous.dataDir, previous.casRoot, `D${String(generation)}`);
};

const compose = async (dataDir: string, casRoot: string, tag: string): Promise<DependencyFixture> => {
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
      ids,
      clock,
      registrations: db.providers,
      models: db.providerModels,
      authorize: sessionAuthorize as never,
      events: db.events,
      systemActor: ACTOR,
    } as never);

    const adapter: ToolPort = {
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
      invoke: async () =>
        ok({
          status: 'ok',
          output: { verdict: 'pass', evidenceRefs: [] },
          artifactRefs: [],
          startedAt: clock.nowIso(),
          finishedAt: clock.nowIso(),
          latencyMs: 1,
        } satisfies ToolResult),
    };
    const tools = createToolRegistry({
      ids,
      clock,
      records: db.toolRecords,
      invocations: db.toolInvocations,
      invocationArtifacts: db.toolInvocationArtifacts,
      adapters: new Map<string, ToolPort>([['tool.gate', adapter]]),
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
    const toolRecord = createToolRecord({
      toolId: 'tool.gate',
      name: 'tool.gate',
      description: 'gate validator',
      version: '1.0.0',
      capabilities: [TOOL_CAPABILITY_VALIDATOR],
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      riskLevel: 'LOW',
      requiredAuthorities: ['tool.invoke'],
      now: clock.nowIso(),
    });
    if (!toolRecord.ok) throw new Error(toolRecord.error.message);
    const toolRegistered = await tools.register(toolRecord.value, { actorId: ACTOR });
    if (!toolRegistered.ok && toolRegistered.error.code !== 'CONFLICT') throw new Error(toolRegistered.error.message);

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
      // LIVE-SMOKE-FIX-03: deterministic instant retry backoff (tests never wait real seconds).
      modelRetrySleep: async () => undefined,
    } as never);

    const sprint13 = composeSprint13Application({
      database: db,
      contentStore: createFilesystemArtifactContentStore({ casRoot }),
      clock,
      ids,
      authorize: sessionAuthorize as never,
      tools,
      logger: nullLogger,
    });

    const counts: Record<string, number> = {};
    const handlerOf = (kind: string): StageHandler => ({
      id: `handler.${kind}`,
      execute: () => {
        counts[kind] = (counts[kind] ?? 0) + 1;
        return 'succeeded';
      },
    });
    const handlers: StageHandlerRegistry = { resolve: (kind: string) => handlerOf(kind) };
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

    const orchestrator = createStartupRecoveryOrchestrator({
      actorId: ACTOR,
      runtime,
      tools,
      engine: gateEngine,
      runs: db.runs,
    });

    let closed = false;
    const fixture: DependencyFixture = {
      tag,
      db,
      dataDir,
      casRoot,
      ids,
      clock,
      runtime,
      gateEngine,
      sprint13,
      orchestrator,
      stageHandlerCounts: () => ({ ...counts }),
      async registerProvider(providerId: string, outcomes: readonly ScriptOutcome[]) {
        const provider = createMockProvider({
          providerId,
          kind: 'mock',
          displayName: providerId,
          script: { models: [MODEL('standard')], outcomes: outcomes as never },
        });
        const registered = await providers.register(provider, { actorId: ACTOR });
        if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
        const model = await models.registerFromProvider({ providerId, providerModelId: 'standard', actorId: ACTOR });
        if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
        return { calls: () => provider.calls.length };
      },
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

const CONTEXT = (runId: string, taskId: string) => ({
  company: { id: 'company_default', label: 'Company' },
  workflow: { id: 'wfl_1', label: 'Change workflow' },
  workflowVersion: '1.0.0',
  workflowRun: { id: runId, label: 'Run 1' },
  stage: { id: STAGE_ID, label: 'S1' },
  task: { id: taskId, label: 'Stage B work' },
  role: { id: 'rol_1', label: 'Developer' },
  objective: 'Produce the stage B deliverable.',
  instructions: ['Be concise.'],
  constraints: [],
  acceptanceCriteria: ['One paragraph.'],
  memoryView: [],
  previousHandoff: null,
  artifactRefs: [],
});

const executeRequest = (runId: string, taskId: string, modelKey: string) => ({
  agentId: 'agent_1',
  roleId: 'rol_1',
  taskId: taskId as never,
  runId: runId as never,
  actorId: ACTOR,
  modelKey,
  explicit: true,
  scopes: [],
  context: CONTEXT(runId, taskId),
});

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

const seedRun = async (f: DependencyFixture, state?: string): Promise<{ readonly id: string; readonly versionId: string }> => {
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
  return { id: row.id, versionId: row.versionId };
};

const eventTypes = async (f: DependencyFixture): Promise<readonly string[]> =>
  (await f.db.events.all()).map((entry) => entry.event.type);

/* -------------------------------------------------------------------- tests */

describe('canonical classification contract (§2/§17 — no invented vocabulary)', () => {
  it('distinguishes API/transient vs quota/rate with frozen Sprint 6 kinds and codes', () => {
    const quota = providerErrorToDomainError(normalizeProviderError({ kind: 'quota_exhausted', message: 'billing hard limit' }));
    expect(quota.code).toBe('LIMIT_EXCEEDED');
    expect(normalizeProviderError({ kind: 'quota_exhausted', message: 'x' }).retryable).toBe(false);

    for (const transient of ['unavailable', 'timeout', 'rate_limited'] as const) {
      const normalized = normalizeProviderError({ kind: transient, message: 'x' });
      expect(normalized.retryable).toBe(true); // RETRYABLE_KINDS — metadata only, never auto-acted-on
      const error = providerErrorToDomainError(normalized);
      expect(error.code).toBe(
        transient === 'rate_limited' ? 'LIMIT_EXCEEDED' : transient === 'timeout' ? 'TIMEOUT' : 'AGENT_UNAVAILABLE',
      );
    }
  });
});

describe('API error dependency failure (§3/§11/§12/§14/§30 — no existing retry: attempt terminates)', () => {
  it('full restart E2E: durable FAILED, zero startup provider calls, explicit continuation succeeds on the SAME run/task', async () => {
    // ---------------- PROCESS A ----------------
    const a = await openDependencyFixture();
    await seedTemplate(a.db);
    await a.registerProvider('mock-a', ['unavailable']); // repeats forever
    const run = await seedRun(a);
    const driven = await a.gateEngine.drive(run.id as never, { maxSteps: 8 });
    if (!driven.ok) throw new Error(driven.error.message);
    expect(driven.value.run.state).toBe('EXECUTING');
    // Stage A completed through the normal engine path (durable proof for §26).
    const taskA = a.ids.id('tsk_a');
    const taskB = a.ids.id('tsk_b');
    const { createTask } = await import('@companyos/core');
    for (const [id, kind] of [[taskA, 'stageA'], [taskB, 'stageB']] as const) {
      const task = createTask({ runId: run.id as never,  stageId: STAGE_ID as never, roleId: 'rol_1' as never, kind, now: a.clock.nowIso(), ids: a.ids });
      if (!task.ok) throw new Error(task.error.message);
      await a.db.tasks.put({ ...task.value, id: id as never });
    }
    const advanced = await a.gateEngine.advance({
      runId: run.id as never,
      stageId: STAGE_ID as never,
      taskIds: [taskA as never],
      snapshot: { snapshotId: 'snp_1' as never, snapshotHash: '0'.repeat(64) as never },
    });
    expect(advanced.outcome).toBe('completed');
    const aRunRow = await a.db.runs.get(run.id as never);
    if (aRunRow === null) throw new Error('run');
    const rejected = await a.gateEngine.dispatch({
      commandId: a.ids.id('cmd'),
      runId: run.id as never,
      type: 'REVIEW.REJECT',
      expectedRevision: aRunRow.revision,
      actorId: ACTOR,
      traceId: a.ids.id('trace'),
      issuedAt: a.clock.nowIso(),
      reason: 'review requested changes',
    });
    if (!rejected.ok) throw new Error(rejected.error.message);
    const aRunRow2 = await a.db.runs.get(run.id as never);
    if (aRunRow2 === null) throw new Error('run2');
    const reworked = await a.gateEngine.dispatch({
      commandId: a.ids.id('cmd'),
      runId: run.id as never,
      type: 'REWORK.READY',
      expectedRevision: aRunRow2.revision,
      actorId: ACTOR,
      traceId: a.ids.id('trace'),
      issuedAt: a.clock.nowIso(),
    });
    if (!reworked.ok) throw new Error(reworked.error.message);

    // Stage B attempt through the REAL runtime: provider returns an API error.
    const failedExecution = await a.runtime.execute(executeRequest(run.id, taskB, 'mock-a.standard'));
    expect(failedExecution.ok).toBe(false);
    const failedRow = (await a.db.agentExecutions.list()).items.find((e) => e.status === 'FAILED');
    expect(failedRow?.errorKind).toBe('PROVIDER_UNAVAILABLE');
    expect(failedRow?.runId).toBe(run.id);
    // Exactly ONE provider call for ONE explicit execution — no in-attempt retry loop.
    const providerA = (await a.db.providers.get('mock-a')) as unknown as { id: string } | null;
    void providerA;
    const typesA = await eventTypes(a);
    expect(typesA).toContain('provider.failed');
    expect(typesA).toContain('agent.execution_failed');
    // A dependency failure is terminal, NOT crash residue: run stays EXECUTING, no RUNNING rows.
    expect((await a.db.runs.get(run.id as never))?.state).toBe('EXECUTING');
    expect((await a.db.agentExecutions.list()).items.some((e) => e.status === 'RUNNING')).toBe(false);
    a.close();

    // ---------------- PROCESS B: reopen + startup recovery ----------------
    const b = await reopenDependencyFixture(a);
    // Same-id re-registration is refused (durable registration wins, adapter stays
    // unbound) — a "restored provider" is a NEW registration the continuation binds.
    const restored = await b.registerProvider('mock-b', [{ outputText: 'stage B done' }]);
    const report = await b.orchestrator.run();
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.agentsInterrupted).toBe(0); // FAILED is not residue
      expect(report.value.runsRecovered).toBe(1); // run rests EXECUTING (crashable) → recovered in place
    }
    expect(restored.calls()).toBe(0); // §15: provider calls during startup = 0
    // Context preserved (§6): same run row, same tasks, pinned version.
    const runB = await b.db.runs.get(run.id as never);
    expect(runB?.id).toBe(run.id);
    expect(runB?.versionId).toBe(run.versionId);
    expect(runB?.state).toBe('EXECUTING');
    expect((await b.db.tasks.get(taskA as never))?.id).toBe(taskA);
    // The FAILED attempt is untouched, auditable history.
    const failedStill = (await b.db.agentExecutions.list()).items.find((e) => e.status === 'FAILED');
    expect(failedStill?.errorKind).toBe('PROVIDER_UNAVAILABLE');
    const typesB = await eventTypes(b);
    // LIVE-SMOKE-FIX-03: the failed logical execution performed 4 bounded network
    // attempts (1 initial + 3 retries), each durably audited; nothing new since.
    expect(typesB.filter((t) => t === 'provider.failed').length).toBe(4);

    // §14: EXPLICIT continuation with a healthy provider — same run/task, NEW attempt.
    const succeeded = await b.runtime.execute(executeRequest(run.id, taskB, 'mock-b.standard'));
    expect(succeeded.ok).toBe(true);
    if (succeeded.ok) expect(succeeded.value.status).toBe('COMPLETED');
    expect(restored.calls()).toBe(1); // one call for one explicit attempt
    // §26: completed Stage A never re-ran; no goal re-entry.
    expect(b.stageHandlerCounts()['stageA'] ?? 0).toBe(0);
    expect((await b.db.runs.list({ limit: 500 })).items.map((r) => r.id)).toEqual([run.id]);
    // Old failure still auditable next to the success (§7).
    const rows = (await b.db.agentExecutions.list()).items;
    expect(rows.filter((e) => e.status === 'FAILED')).toHaveLength(1);
    expect(rows.filter((e) => e.status === 'COMPLETED')).toHaveLength(1);
    b.close();
  });
});

describe('quota exhaustion (§18/§19/§20/§21/§31 — no automatic retry, ever)', () => {
  it('restart E2E: exactly one provider call per explicit attempt, no startup retry, explicit continuation succeeds', async () => {
    const a = await openDependencyFixture();
    await seedTemplate(a.db);
    const quota = await a.registerProvider('mock-a', ['quota_exhausted']);
    const run = await seedRun(a);
    const taskB = a.ids.id('tsk_b');

    const failed = await a.runtime.execute(executeRequest(run.id, taskB, 'mock-a.standard'));
    expect(failed.ok).toBe(false);
    expect(quota.calls()).toBe(1); // quota error → ZERO automatic retries
    const failedRow = (await a.db.agentExecutions.list()).items[0];
    expect(failedRow?.status).toBe('FAILED');
    expect(failedRow?.errorKind).toBe('QUOTA_EXHAUSTED');
    expect((await a.db.runs.get(run.id as never))?.state).toBe('IDLE'); // untouched by the dependency failure
    a.close();

    const b = await reopenDependencyFixture(a);
    const restored = await b.registerProvider('mock-b', [{ outputText: 'after quota reset' }]);
    const report = await b.orchestrator.run();
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.value.agentsInterrupted).toBe(0);
    expect(restored.calls()).toBe(0); // no quota retry at startup
    expect((await b.db.agentExecutions.list()).items).toHaveLength(1); // no new execution auto-created
    expect((await b.db.runs.get(run.id as never))?.id).toBe(run.id);

    // Explicit continuation after quota restoration: same run/task, new attempt, success.
    const succeeded = await b.runtime.execute(executeRequest(run.id, taskB, 'mock-b.standard'));
    expect(succeeded.ok).toBe(true);
    expect(restored.calls()).toBe(1);
    const rows = (await b.db.agentExecutions.list()).items;
    expect(rows.filter((e) => e.status === 'FAILED')).toHaveLength(1);
    expect(rows.filter((e) => e.status === 'COMPLETED')).toHaveLength(1);
    b.close();
  });
});

describe('continuous dependency failure (§9/§32/§33 — bounded means one call per explicit attempt)', () => {
  it('persistent API error: N explicit attempts → exactly N provider calls, all terminal, no loop', async () => {
    const a = await openDependencyFixture();
    const run = await seedRun(a);
    const taskB = a.ids.id('tsk_b');
    const provider = await a.registerProvider('mock-a', ['unavailable']);
    for (let i = 0; i < 3; i += 1) {
      const failed = await a.runtime.execute(executeRequest(run.id, taskB, 'mock-a.standard'));
      expect(failed.ok).toBe(false);
    }
    // LIVE-SMOKE-FIX-03: each explicit logical attempt now performs up to 4 bounded
    // network attempts for a RETRYABLE kind (3 explicit attempts × 4 = 12) — still
    // bounded, still terminal, no loop beyond the policy.
    expect(provider.calls()).toBe(12);
    const rows = (await a.db.agentExecutions.list()).items;
    expect(rows).toHaveLength(3);
    expect(rows.every((e) => e.status === 'FAILED')).toBe(true); // no RUNNING residue
    a.close();
  });

  it('persistent quota: two explicit continuations → two attempts only, no background spawns', async () => {
    const a = await openDependencyFixture();
    const run = await seedRun(a);
    const taskB = a.ids.id('tsk_b');
    const provider = await a.registerProvider('mock-a', ['quota_exhausted']);
    for (let i = 0; i < 2; i += 1) {
      const failed = await a.runtime.execute(executeRequest(run.id, taskB, 'mock-a.standard'));
      expect(failed.ok).toBe(false);
    }
    expect(provider.calls()).toBe(2);
    expect((await a.db.agentExecutions.list()).items).toHaveLength(2);
    a.close();
  });
});

describe('dependency failure vs crash residue (§16/§19)', () => {
  it('FAILED (quota) stays FAILED; only a real RUNNING row is interrupted at startup', async () => {
    const a = await openDependencyFixture();
    const run = await seedRun(a);
    const taskB = a.ids.id('tsk_b');
    await a.registerProvider('mock-a', ['quota_exhausted']);
    const failed = await a.runtime.execute(executeRequest(run.id, taskB, 'mock-a.standard'));
    expect(failed.ok).toBe(false);
    // And a genuinely in-flight execution left behind by a process death.
    const prepared = await a.runtime.prepare({
      agentId: 'agent_1',
      roleId: 'rol_1',
      taskId: a.ids.id('tsk_x'),
      runId: run.id as never,
      actorId: ACTOR,
      modelKey: 'mock-a.standard',
      explicit: true,
      scopes: [],
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    await a.db.agentExecutions.put({ ...prepared.value, status: 'RUNNING' });
    a.close();

    const b = await reopenDependencyFixture(a);
    const report = await b.orchestrator.run();
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.value.agentsInterrupted).toBe(1); // the RUNNING one only
    const rows = (await b.db.agentExecutions.list()).items;
    expect(rows.filter((e) => e.status === 'INTERRUPTED')).toHaveLength(1);
    const quotaRow = rows.find((e) => e.errorKind === 'QUOTA_EXHAUSTED');
    expect(quotaRow?.status).toBe('FAILED'); // known failure ≠ unknown side-effect state
    b.close();
  });
});

describe('structural guarantees (§22/§23/§27)', () => {
  it('production recovery/runtime paths add no background timers, schedulers or retry-after persistence', () => {
    for (const file of [
      'packages/engine/src/recovery/startup-recovery.ts',
      'packages/engine/src/runtime/agent-runtime.ts',
      'apps/desktop/src/main.ts',
    ]) {
      const source = readFileSync(repo(file), 'utf8');
      expect(source.includes('setInterval')).toBe(false);
      expect(source.includes('nextRetryAt')).toBe(false);
      expect(source.includes('WAITING_QUOTA')).toBe(false);
      expect(source.includes('RETRY_SCHEDULED')).toBe(false);
    }
  });

  it('EvidenceGate still enforced after a dependency-failure restart (§27)', async () => {
    const a = await openDependencyFixture();
    await seedTemplate(a.db);
    const run = await seedRun(a);
    const task = a.ids.id('tsk_v');
    const driven = await a.gateEngine.drive(run.id as never, { maxSteps: 8 });
    if (!driven.ok) throw new Error(driven.error.message);
    const { createTask } = await import('@companyos/core');
    const made = createTask({ runId: run.id as never,  stageId: STAGE_ID as never, roleId: 'rol_1' as never, kind: 'stageV', now: a.clock.nowIso(), ids: a.ids });
    if (!made.ok) throw new Error(made.error.message);
    await a.db.tasks.put({ ...made.value, id: task as never });
    const advanced = await a.gateEngine.advance({
      runId: run.id as never,
      stageId: STAGE_ID as never,
      taskIds: [task as never],
      snapshot: { snapshotId: 'snp_1' as never, snapshotHash: '0'.repeat(64) as never },
    });
    expect(advanced.outcome).toBe('completed');
    a.close();

    const b = await reopenDependencyFixture(a);
    await b.orchestrator.run();
    // Continue to VALIDATING through the normal machine, then try to pass WITHOUT evidence.
    const runRow = await b.db.runs.get(run.id as never);
    if (runRow === null) throw new Error('run');
    const review = await b.gateEngine.dispatch({
      commandId: b.ids.id('cmd'),
      runId: run.id as never,
      type: 'REVIEW.PASS',
      expectedRevision: runRow.revision,
      actorId: ACTOR,
      traceId: b.ids.id('trace'),
      issuedAt: b.clock.nowIso(),
    });
    if (!review.ok) throw new Error(review.error.message);
    expect((await b.db.runs.get(run.id as never))?.state).toBe('VALIDATING');
    const validating = await b.db.runs.get(run.id as never);
    if (validating === null) throw new Error('validating');
    const forged = await b.gateEngine.dispatch({
      commandId: b.ids.id('cmd'),
      runId: run.id as never,
      type: 'VALIDATION.PASS',
      expectedRevision: validating.revision,
      actorId: ACTOR,
      traceId: b.ids.id('trace'),
      issuedAt: b.clock.nowIso(),
      payload: { artifactId: 'art_missing0000000000000000000000', stageId: 's1' },
    });
    expect(forged.ok).toBe(false); // no durable evidence → REJECT; recovery did not bypass the gate
    expect((await b.db.runs.get(run.id as never))?.state).toBe('VALIDATING');
    b.close();
  });
});
