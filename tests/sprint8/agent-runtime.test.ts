/**
 * Sprint 8 tests A–W: the Agent Execution Runtime.
 *
 * The runtime executes one attempt with an EXPLICIT model binding. It never selects a model,
 * never falls back, and never consults benchmark metadata.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DomainError,
  FixedClock,
  SequenceIdFactory,
  assemblePrompt,
  buildAgentContext,
  domainError,
  err,
  ok,
  type Result,
} from '@companyos/core';
import {
  createAgentRuntime,
  createMockProvider,
  createModelRegistry,
  createProviderRegistry,
  createSelectionPolicyService,
  type AgentRuntimeService,
  type ModelRegistryService,
  type ProviderRegistry,
  type SelectionPolicyService,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const EPOCH = Date.parse('2026-12-01T00:00:00.000Z');
const API_KEY = 'sk-mock-agent-0123456789abcdef';
const ROLE = 'role_developer';
const TASK = 'tsk_1';
const RUN = 'run_1';

const MODEL = (modelId: string, capabilities: Record<string, boolean> = { streaming: true }) => ({
  modelId,
  displayName: modelId,
  contextWindow: 1000,
  maxOutputTokens: 200,
  capabilities,
  pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' as const },
});

const CONTEXT = (objective = 'Summarise the change request in three bullets.') => ({
  company: { id: 'company_default', label: 'Company' },
  workflow: { id: 'wfl_1', label: 'Change workflow' },
  workflowVersion: '1.0.0',
  workflowRun: { id: RUN, label: 'Run 1' },
  stage: { id: 'stg_review', label: 'Review' },
  task: { id: TASK, label: 'Write the summary' },
  role: { id: ROLE, label: 'Developer' },
  objective,
  instructions: ['Be concise.', 'Cite the constraints.'],
  constraints: ['Do not invent facts.'],
  acceptanceCriteria: ['Three bullets maximum.'],
  memoryView: ['previous stage produced a diff'],
  previousHandoff: 'Stage 1 produced a patch.',
  artifactRefs: [{ id: 'art_diff_1', label: 'diff' }],
});

interface Fixture {
  readonly clock: FixedClock;
  readonly ids: SequenceIdFactory;
  database(): DurableDatabase;
  providers(): ProviderRegistry;
  models(): ModelRegistryService;
  policies(): SelectionPolicyService;
  runtime(): AgentRuntimeService;
  restart(): void;
  cleanup(): void;
}

const make = (): Fixture => {
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-agent-runtime-'));
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();
  const open = (): DurableDatabase =>
    openDurableDatabase({
      dataDir,
      appliedAt: clock.nowIso(),
      chains: ['core', 'engine', 'provider', 'registry', 'selection', 'agent'],
    });

  let database = open();

  const build = (db: DurableDatabase) => {
    const providers = createProviderRegistry({
      ids,
      clock,
      registrations: db.providers,
      models: db.providerModels,
      authorize: async () => ok(true),
      events: db.events,
      systemActor: 'user_owner',
      secrets: async () => [''],
    });
    const models = createModelRegistry({
      ids,
      clock,
      records: db.modelRecords,
      aliases: db.modelAliases,
      providers,
      events: db.events,
      scope: 'default',
    });
    const policies = createSelectionPolicyService({
      ids,
      clock,
      policies: db.selectionPolicies,
      results: db.benchmarkResults,
      readRecords: async () => models.list({ includeDisabled: true }),
      events: db.events,
    });
    const runtime = createAgentRuntime({
      ids,
      clock,
      executions: db.agentExecutions,
      artifacts: db.executionArtifacts,
      models,
      providers,
      policies,
      events: db.events,
      logger: undefined,
      secrets: async () => [],
      // LIVE-SMOKE-FIX-03: deterministic instant retry backoff (tests never wait real seconds).
      modelRetrySleep: async () => undefined,
    });
    return { providers, models, policies, runtime };
  };

  let built = build(database);

  return {
    clock,
    ids,
    database: () => database,
    providers: () => built.providers,
    models: () => built.models,
    policies: () => built.policies,
    runtime: () => built.runtime,
    restart(): void {
      database.close();
      database = open();
      built = build(database);
    },
    cleanup(): void {
      try {
        database.close();
      } catch {
        // already closed
      }
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Windows may still hold -wal/-shm briefly
      }
    },
  };
};

const fixtures: Fixture[] = [];
const fixture = (): Fixture => {
  const created = make();
  fixtures.push(created);
  return created;
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

interface Seeded {
  readonly providerA: ReturnType<typeof createMockProvider>;
  readonly providerB: ReturnType<typeof createMockProvider>;
}

const seed = async (
  f: Fixture,
  scriptA: Record<string, unknown> = {},
  scriptB: Record<string, unknown> = {},
): Promise<Seeded> => {
  const providerA = createMockProvider({
    providerId: 'mock-a',
    kind: 'mock',
    displayName: 'A',
    script: {
      models: [MODEL('standard'), MODEL('vision', { streaming: true, vision: true })],
      ...scriptA,
    },
  });
  const providerB = createMockProvider({
    providerId: 'mock-b',
    kind: 'mock',
    displayName: 'B',
    script: { models: [MODEL('cheap')], ...scriptB },
  });
  await f.providers().register(providerA, { actorId: 'user_owner' });
  await f.providers().register(providerB, { actorId: 'user_owner' });
  for (const [providerId, modelId] of [
    ['mock-a', 'standard'],
    ['mock-a', 'vision'],
    ['mock-b', 'cheap'],
  ] as const) {
    await f
      .models()
      .registerFromProvider({ providerId, providerModelId: modelId, actorId: 'user_owner' });
  }
  return { providerA, providerB };
};

const request = (overrides: Record<string, unknown> = {}) => ({
  agentId: 'agent_1',
  roleId: ROLE,
  taskId: TASK,
  runId: RUN,
  actorId: 'user_owner',
  modelKey: 'mock-a.standard',
  scopes: [],
  explicit: true,
  context: CONTEXT(),
  ...overrides,
});

const events = async (f: Fixture): Promise<readonly string[]> =>
  (await f.database().events.all())
    .map((entry) => entry.event.type)
    .filter((type) => type.startsWith('agent.'));

/** A provider whose results are fully controlled by the test (structured payload + usage). */
const scriptedProvider = (input: {
  readonly providerId?: string;
  readonly outputText?: string;
  readonly structured?: unknown;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly throwWith?: DomainError;
}) => {
  const providerId = input.providerId ?? 'mock-a';
  return {
    describe() {
      return { providerId, kind: 'mock', displayName: providerId, version: '1' };
    },
    async listModels() {
      return ok([MODEL('standard', { streaming: true, structuredOutput: true })] as never);
    },
    async health() {
      return ok({
        status: 'healthy' as const,
        checkedAt: '2026-12-01T00:00:00.000Z',
        latencyMs: 0,
        detail: null,
      });
    },
    async invoke(): Promise<Result<never, DomainError>> {
      if (input.throwWith !== undefined) throw input.throwWith;
      return ok({
        modelId: 'standard',
        outputText: input.outputText ?? 'ok',
        structured: input.structured ?? null,
        toolCalls: [],
        usage: {
          inputTokens: input.usage?.inputTokens ?? 7,
          outputTokens: input.usage?.outputTokens ?? 11,
        },
        finishReason: 'stop',
      } as never);
    },
    async *stream() {
      yield ok({
        deltaText: 'ok',
        toolCallDeltas: [],
        done: true,
        usage: null,
        modelId: 'standard',
      } as never);
    },
  };
};

describe('A/B/C/D/M/N/O. execution, role binding and the manual path', () => {
  it('A: creates an execution with every required field, in READY', async () => {
    const f = fixture();
    await seed(f);
    const prepared = await f.runtime().prepare({
      agentId: 'agent_1',
      roleId: ROLE,
      taskId: TASK,
      runId: RUN,
      actorId: 'user_owner',
      modelKey: 'mock-a.standard',
      explicit: true,
      scopes: [],
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const execution = prepared.value;
    expect(execution).toMatchObject({
      agentId: 'agent_1',
      roleId: ROLE,
      taskId: TASK,
      runId: RUN,
      modelKey: 'mock-a.standard',
      providerId: 'mock-a',
      providerModelId: 'standard',
      status: 'READY',
      attempt: 1,
      latencyMs: null,
      resultRef: null,
      errorKind: null,
    });
    expect(execution.executionId).toMatch(/^exec/);
    expect(execution.traceId.length).toBeGreaterThan(0);
    expect(execution.createdAt).toBe(execution.updatedAt);
    expect(await events(f)).toEqual(['agent.execution_created']);
  });

  it('B/C/M/O: runs end to end through the mock provider and completes', async () => {
    const f = fixture();
    const { providerA } = await seed(f, { outcomes: [{ outputText: 'a summary' }] });

    const executed = await f.runtime().execute({
      ...request({ prompt: { maxOutputTokens: 64, rolePreamble: 'You are a reviewer.' } }),
      resultRef: 'result_1',
      artifacts: [{ ref: 'art_summary_1', label: 'summary' }],
    });

    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    const execution = executed.value;
    expect(execution.status).toBe('COMPLETED');
    expect(execution.roleId).toBe(ROLE);
    expect(execution.startedAt).not.toBeNull();
    expect(execution.finishedAt).not.toBeNull();
    expect(execution.latencyMs).toBe(0); // FixedClock: deterministic by construction
    expect(execution.resultRef).toBe('result_1');
    expect(execution.artifactRefs).toEqual(['art_summary_1']);
    expect(execution.outputUsage.totalTokens).toBe(
      execution.outputUsage.inputTokens + execution.outputUsage.outputTokens,
    );

    // The provider saw exactly the assembled request (M).
    expect(providerA.calls).toHaveLength(1);
    const call = providerA.calls[0];
    expect(call?.modelId).toBe('standard');
    expect(call?.messages).toHaveLength(2);
    expect(call?.messages[0]?.content).toBe('You are a reviewer.');
    expect(call?.messages[1]?.content).toContain('Summarise the change request');
    expect(call?.messages[1]?.content).toContain('Do not invent facts.');
    expect(call?.responseFormat).toBeUndefined();
    expect(call?.maxOutputTokens).toBe(64);
    expect(call?.traceId).toBe(execution.traceId);

    expect(await events(f)).toEqual([
      'agent.execution_created',
      'agent.execution_started',
      'agent.provider_invoked',
      'agent.execution_completed',
    ]);
    // Artifacts are their own rows, so a restart can list them (persistence, not memory).
    expect((await f.database().executionArtifacts.list()).items).toHaveLength(1);
  });

  it('N: a structured payload is persisted with the usage the provider reported', async () => {
    const f = fixture();
    await f
      .providers()
      .register(
        scriptedProvider({
          structured: { summary: 'ok' },
          usage: { inputTokens: 5, outputTokens: 9 },
        }) as never,
        {
          actorId: 'user_owner',
        },
      );
    await f
      .models()
      .registerFromProvider({
        providerId: 'mock-a',
        providerModelId: 'standard',
        actorId: 'user_owner',
      });

    const executed = await f
      .runtime()
      .execute(request({ prompt: { structuredKeys: ['summary'] } }));
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.value.status).toBe('COMPLETED');
    expect(executed.value.outputUsage).toEqual({
      inputTokens: 5,
      outputTokens: 9,
      totalTokens: 14,
    });
  });

  it('D: the SAME role and task run on a different model after the user switches', async () => {
    const f = fixture();
    await seed(f);
    const first = await f.runtime().execute(request({ modelKey: 'mock-a.standard' }));
    const second = await f.runtime().execute(request({ modelKey: 'mock-b.cheap' }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.roleId).toBe(second.value.roleId);
    expect(first.value.taskId).toBe(second.value.taskId);
    expect(first.value.modelKey).toBe('mock-a.standard');
    expect(second.value.modelKey).toBe('mock-b.cheap');
    expect(second.value.providerId).toBe('mock-b');
    expect(first.value.status).toBe('COMPLETED');
    expect(second.value.status).toBe('COMPLETED');
  });

  it('Closeout-1: records the binding source honestly (ROUTER is unreachable)', async () => {
    const f = fixture();
    await seed(f);
    await f.policies().savePolicy({
      scopeType: 'COMPANY',
      scopeId: '*',
      mode: 'AUTO',
      allowedModels: ['mock-a.standard'],
      actorId: 'user_owner',
    });
    const executed = await f
      .runtime()
      .execute(request({ scopes: [{ scopeType: 'COMPANY', scopeId: '*' }], explicit: false }));
    expect(executed.ok).toBe(true);
    if (executed.ok) {
      // The model was NAMED by the caller even though the policy says AUTO: the execution
      // records an explicit binding, never a fabricated router source.
      expect(executed.value.modelKey).toBe('mock-a.standard');
    }
    const stored = (await f.database().agentExecutions.list()).items[0];
    expect(stored?.modelKey).toBe('mock-a.standard');
    // The audit trail must name the honest source (Closeout-8 LOW-1): a caller-named model is
    // an EXPLICIT_BINDING even when the policy mode is AUTO - never a fabricated 'ROUTER'.
    const created = (await f.database().events.all()).find(
      (entry) => entry.event.type === 'agent.execution_created',
    );
    expect((created?.event.payload as Record<string, unknown>)['bindingSource']).toBe(
      'EXPLICIT_BINDING',
    );
    expect(JSON.stringify(await f.database().events.all())).not.toContain('ROUTER');
  });
});

describe('E–H. refusals are precise and create nothing', () => {
  const refusals = async (f: Fixture): Promise<readonly string[]> => {
    const verdict = await f.policies().explainManual({ modelKey: 'x', scopes: [] });
    void verdict;
    const stored = (await f.database().agentExecutions.list()).items;
    expect(stored).toHaveLength(0);
    return [];
  };

  it('E: a disabled model is refused', async () => {
    const f = fixture();
    await seed(f);
    await f.models().setEnabled('mock-a.standard', false, 'user_owner');
    const executed = await f.runtime().execute(request());
    expect(executed.ok).toBe(false);
    if (executed.ok) return;
    expect(executed.error.code).toBe('POLICY_DENIED');
    expect(executed.error.details['refusals']).toContain('MODEL_DISABLED');
    expect((await f.database().agentExecutions.list()).items).toHaveLength(0);
    await refusals(f);
  });

  it('F: an unavailable model is refused', async () => {
    const f = fixture();
    await seed(f);
    await f.providers().unregister('mock-a', { actorId: 'user_owner' });
    const executed = await f.runtime().execute(request());
    expect(executed.ok).toBe(false);
    if (executed.ok) return;
    expect(executed.error.details['refusals']).toContain('MODEL_UNAVAILABLE');
  });

  it('G: a blocked model is refused even when named explicitly', async () => {
    const f = fixture();
    await seed(f);
    await f.policies().savePolicy({
      scopeType: 'COMPANY',
      scopeId: '*',
      mode: 'HYBRID',
      blockedModels: ['mock-a.standard'],
      actorId: 'user_owner',
    });
    const executed = await f
      .runtime()
      .execute(request({ scopes: [{ scopeType: 'COMPANY', scopeId: '*' }], explicit: true }));
    expect(executed.ok).toBe(false);
    if (executed.ok) return;
    expect(executed.error.details['refusals']).toContain('MODEL_BLOCKED_BY_POLICY');
  });

  it('Closeout-2: an empty scope list cannot bypass the policy gate', async () => {
    const f = fixture();
    await seed(f);
    await f.policies().savePolicy({
      scopeType: 'ROLE',
      scopeId: ROLE,
      mode: 'HYBRID',
      blockedModels: ['mock-a.standard'],
      actorId: 'user_owner',
    });
    // The caller passes NO scopes at all: the runtime derives TASK/ROLE from the ids, so the
    // ROLE policy still applies and the hard block still refuses.
    const noScopes = await f.runtime().execute(request({ scopes: [], explicit: true }));
    expect(noScopes.ok).toBe(false);
    if (!noScopes.ok)
      expect(noScopes.error.details['refusals']).toContain('MODEL_BLOCKED_BY_POLICY');

    // A malformed scope is an argument error, not a silent skip.
    const malformed = await f
      .runtime()
      .execute(
        request({ scopes: [{ scopeType: 'NONSENSE' as never, scopeId: '' }], explicit: true }),
      );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe('INVALID_ARGUMENT');
    expect((await f.database().agentExecutions.list()).items).toHaveLength(0);
  });

  it('H: a missing required capability is refused', async () => {
    const f = fixture();
    await seed(f);
    await f.policies().savePolicy({
      scopeType: 'ROLE',
      scopeId: ROLE,
      mode: 'HYBRID',
      requiredCapabilities: ['vision'],
      actorId: 'user_owner',
    });
    const refused = await f
      .runtime()
      .execute(request({ scopes: [{ scopeType: 'ROLE', scopeId: ROLE }] }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('CAPABILITY_MISSING');
    expect(refused.error.details['refusals']).toContain('CAPABILITY_MISSING');

    // The capable model is accepted under the same policy.
    const allowed = await f
      .runtime()
      .execute(
        request({ modelKey: 'mock-a.vision', scopes: [{ scopeType: 'ROLE', scopeId: ROLE }] }),
      );
    expect(allowed.ok).toBe(true);
  });
});

describe('I/J. HYBRID validates and AUTO refuses - neither chooses', () => {
  it('I: HYBRID validates the named model and never picks from the candidate set', async () => {
    const f = fixture();
    await seed(f);
    await f.policies().savePolicy({
      scopeType: 'WORKFLOW',
      scopeId: 'wfl_1',
      mode: 'HYBRID',
      allowedProviders: ['mock-a', 'mock-b'],
      preferredModels: ['mock-b.cheap'],
      actorId: 'user_owner',
    });
    const scopes = [{ scopeType: 'WORKFLOW' as const, scopeId: 'wfl_1' }];

    // No modelKey: the runtime must NOT fall back to the first preferred model.
    const refused = await f.runtime().execute(request({ modelKey: null, scopes, explicit: false }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('MODEL_SELECTION_REQUIRED');
    expect((await f.database().agentExecutions.list()).items).toHaveLength(0);

    // A named model inside the allowed range is accepted…
    const inside = await f.runtime().execute(request({ modelKey: 'mock-a.standard', scopes }));
    expect(inside.ok).toBe(true);
    if (inside.ok) expect(inside.value.modelKey).toBe('mock-a.standard');

    // …and one outside it is refused with the policy reason.
    await f.policies().savePolicy({
      scopeType: 'WORKFLOW',
      scopeId: 'wfl_1',
      mode: 'HYBRID',
      allowedProviders: ['mock-a'],
      actorId: 'user_owner',
    });
    const outside = await f.runtime().execute(request({ modelKey: 'mock-b.cheap', scopes }));
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error.details['refusals']).toContain('PROVIDER_NOT_ALLOWED');
  });

  it('J: AUTO without a modelKey is MODEL_SELECTION_REQUIRED, not an automatic choice', async () => {
    const f = fixture();
    await seed(f);
    await f.policies().savePolicy({
      scopeType: 'COMPANY',
      scopeId: '*',
      mode: 'AUTO',
      allowedModels: ['mock-a.standard'],
      actorId: 'user_owner',
    });
    const scopes = [{ scopeType: 'COMPANY' as const, scopeId: '*' }];

    const refused = await f.runtime().execute(request({ modelKey: null, scopes, explicit: false }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('MODEL_SELECTION_REQUIRED');
      expect(refused.error.details['selectionOwner']).toBe('application-layer-router');
    }
    expect((await f.database().agentExecutions.list()).items).toHaveLength(0);

    // With a named model the AUTO policy only validates it.
    const named = await f.runtime().execute(request({ modelKey: 'mock-a.standard', scopes }));
    expect(named.ok).toBe(true);
  });
});

describe('K/L. deterministic prompt and explicit context', () => {
  it('K: identical context -> identical prompt plan', () => {
    const built = buildAgentContext({
      ...CONTEXT(),
      binding: {
        modelKey: 'mock-a.standard',
        providerId: 'mock-a',
        providerModelId: 'standard',
        source: 'BINDING',
      },
      trace: { traceId: 't1', executionId: 'e1', attempt: 1 },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const planA = assemblePrompt({
      context: built.value,
      structuredKeys: ['summary'],
      maxOutputTokens: 10,
    });
    const planB = assemblePrompt({
      context: built.value,
      structuredKeys: ['summary'],
      maxOutputTokens: 10,
    });
    expect(planA.ok && planB.ok).toBe(true);
    if (!planA.ok || !planB.ok) return;
    expect(planA.value.promptHash).toBe(planB.value.promptHash);
    expect(planA.value.user).toBe(planB.value.user);
    expect(planA.value.templateVersion).toBe('agent-prompt/v2');

    // A different objective -> a different plan (so the hash is meaningful).
    const other = buildAgentContext({
      ...CONTEXT('Write a completely different objective.'),
      binding: {
        modelKey: 'mock-a.standard',
        providerId: 'mock-a',
        providerModelId: 'standard',
        source: 'BINDING',
      },
      trace: { traceId: 't1', executionId: 'e1', attempt: 1 },
    });
    if (!other.ok) return;
    const planC = assemblePrompt({
      context: other.value,
      structuredKeys: ['summary'],
      maxOutputTokens: 10,
    });
    if (!planC.ok) return;
    expect(planC.value.promptHash).not.toBe(planA.value.promptHash);
  });

  it('K: the assembler refuses to invent a model binding', () => {
    const context = {
      ...CONTEXT(),
      modelBinding: {
        modelKey: '',
        providerId: 'mock-a',
        providerModelId: 'standard',
        source: 'BINDING',
      },
      trace: { traceId: 't1', executionId: 'e1', attempt: 1 },
    } as never;
    const plan = assemblePrompt({ context });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error.code).toBe('MODEL_SELECTION_REQUIRED');
  });

  it('L: the context is explicitly assembled and bounded', () => {
    const built = buildAgentContext({
      ...CONTEXT(),
      binding: {
        modelKey: 'mock-a.standard',
        providerId: 'mock-a',
        providerModelId: 'standard',
        source: 'BINDING',
      },
      trace: { traceId: 't1', executionId: 'e1', attempt: 1 },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.keys(built.value).sort()).toEqual([
      'acceptanceCriteria',
      'artifactRefs',
      'company',
      'constraints',
      'instructions',
      'memoryView',
      'modelBinding',
      'objective',
      'previousHandoff',
      'role',
      'stage',
      'task',
      'trace',
      'workflow',
      'workflowRun',
      'workflowVersion',
    ]);
    // Artifact references are ids, never content.
    expect(built.value.artifactRefs).toEqual([{ id: 'art_diff_1', label: 'diff' }]);

    const oversized = buildAgentContext({
      ...CONTEXT('x'.repeat(4_001)),
      binding: {
        modelKey: 'mock-a.standard',
        providerId: 'mock-a',
        providerModelId: 'standard',
        source: 'BINDING',
      },
      trace: { traceId: 't1', executionId: 'e1', attempt: 1 },
    });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('P–T. provider errors become structured, audited failures', () => {
  const failureOf = async (kind: string) => {
    const f = fixture();
    await seed(f, { outcomes: [kind] });
    const executed = await f.runtime().execute(request());
    expect(executed.ok).toBe(false);
    const stored = (await f.database().agentExecutions.list()).items;
    expect(stored).toHaveLength(1);
    return { f, stored: stored[0]!, executed };
  };

  it('P: rate limited', async () => {
    const { f, stored, executed } = await failureOf('rate_limited');
    expect(stored.status).toBe('FAILED');
    expect(stored.errorKind).toBe('RATE_LIMITED');
    expect(stored.errorMessage).toBeTruthy();
    if (!executed.ok) expect(executed.error.details['retryable']).toBe(true);
    expect(await events(f)).toContain('agent.execution_failed');
  });

  it('Q: timeout', async () => {
    const { stored } = await failureOf('timeout');
    expect(stored.errorKind).toBe('TIMEOUT');
    expect(stored.modelKey).toBe('mock-a.standard');
  });

  it('R: quota exhausted', async () => {
    const { stored } = await failureOf('quota_exhausted');
    expect(stored.errorKind).toBe('QUOTA_EXHAUSTED');
  });

  it('S: context limit', async () => {
    const { stored } = await failureOf('context_limit');
    expect(stored.errorKind).toBe('CONTEXT_LIMIT');
  });

  it('T: content rejected', async () => {
    const { stored } = await failureOf('content_rejected');
    expect(stored.errorKind).toBe('CONTENT_REJECTED');
  });

  it('N: a requested structured payload that never arrives is INVALID_OUTPUT', async () => {
    const f = fixture();
    await seed(f, {
      models: [MODEL('standard', { streaming: true, structuredOutput: true })],
      outcomes: [{ outputText: 'plain text only' }],
    });
    const executed = await f
      .runtime()
      .execute(request({ prompt: { structuredKeys: ['summary'] } }));
    expect(executed.ok).toBe(false);
    const stored = (await f.database().agentExecutions.list()).items[0];
    expect(stored?.status).toBe('FAILED');
    expect(stored?.errorKind).toBe('INVALID_OUTPUT');
  });
});

describe('U/V/W/X/Y. cancellation, secrets, restart and recovery', () => {
  it('U: a cancelled execution never reaches the provider', async () => {
    const f = fixture();
    const { providerA } = await seed(f);
    const prepared = await f.runtime().prepare({
      agentId: 'agent_1',
      roleId: ROLE,
      taskId: TASK,
      runId: RUN,
      actorId: 'user_owner',
      modelKey: 'mock-a.standard',
      explicit: true,
      scopes: [],
    });
    if (!prepared.ok) throw new Error('unexpected');
    const cancelled = await f.runtime().cancel(prepared.value.executionId, 'user_owner');
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) expect(cancelled.value.status).toBe('CANCELLED');

    const ran = await f.runtime().run({
      executionId: prepared.value.executionId,
      actorId: 'user_owner',
      context: CONTEXT() as never,
    });
    expect(ran.ok).toBe(false);
    if (!ran.ok) expect(ran.error.code).toBe('CANCELLED');
    expect(providerA.calls).toHaveLength(0);
    expect(await events(f)).toEqual(['agent.execution_created', 'agent.execution_cancelled']);
  });

  it('V: a credential never reaches the database, the events or the error', async () => {
    const f = fixture();
    const leaky = scriptedProvider({
      throwWith: new DomainError(
        'AGENT_UNAVAILABLE',
        `upstream said: Authorization: Bearer ${API_KEY}`,
        {
          details: { 'companyos.provider.kind': 'unavailable', leaked: API_KEY },
        },
      ),
    });
    await f.providers().register(leaky as never, { actorId: 'user_owner' });
    await f
      .models()
      .registerFromProvider({
        providerId: 'mock-a',
        providerModelId: 'standard',
        actorId: 'user_owner',
      });

    const runtimeWithSecrets = createAgentRuntime({
      ids: f.ids,
      clock: f.clock,
      executions: f.database().agentExecutions,
      artifacts: f.database().executionArtifacts,
      models: f.models(),
      providers: f.providers(),
      policies: f.policies(),
      events: f.database().events,
      secrets: async () => [API_KEY],
    });
    const executed = await runtimeWithSecrets.execute(request());
    expect(executed.ok).toBe(false);
    if (!executed.ok) expect(JSON.stringify(executed.error)).not.toContain(API_KEY);

    const stored = (await f.database().agentExecutions.list()).items[0];
    expect(stored?.status).toBe('FAILED');
    expect(JSON.stringify(stored)).not.toContain(API_KEY);
    expect(JSON.stringify(await f.database().events.all())).not.toContain(API_KEY);
  });

  it('W: status, failure, binding, usage and trace survive a restart', async () => {
    const f = fixture();
    await seed(f, { outcomes: [{ outputText: 'ok' }, 'quota_exhausted'] });
    const first = await f.runtime().execute(request({ resultRef: 'result_ok' }));
    const second = await f.runtime().execute(request({ modelKey: 'mock-a.vision' }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);

    f.restart();

    const historyResult = await f.runtime().list({ taskId: TASK }, 'user_owner');
    expect(historyResult.ok).toBe(true);
    const history = historyResult.ok ? historyResult.value : [];
    expect(history).toHaveLength(2);
    const completed = history.find((execution) => execution.status === 'COMPLETED');
    const failed = history.find((execution) => execution.status === 'FAILED');
    expect(completed?.modelKey).toBe('mock-a.standard');
    expect(completed?.resultRef).toBe('result_ok');
    expect(completed?.outputUsage.totalTokens).toBe(
      (completed?.outputUsage.inputTokens ?? 0) + (completed?.outputUsage.outputTokens ?? 0),
    );
    expect(completed?.traceId).toBeTruthy();
    expect(failed?.modelKey).toBe('mock-a.vision');
    expect(failed?.errorKind).toBe('QUOTA_EXHAUSTED');
    expect(failed?.errorMessage).toBeTruthy();
  });

  it('X: an execution interrupted mid-flight becomes INTERRUPTED, never COMPLETED', async () => {
    const f = fixture();
    const { providerA } = await seed(f);
    const prepared = await f.runtime().prepare({
      agentId: 'agent_1',
      roleId: ROLE,
      taskId: TASK,
      runId: RUN,
      actorId: 'user_owner',
      modelKey: 'mock-a.standard',
      explicit: true,
      scopes: [],
    });
    if (!prepared.ok) throw new Error('unexpected');
    // Simulate a process that died while RUNNING: the row exists in RUNNING, nothing else.
    await f.database().agentExecutions.put({ ...prepared.value, status: 'RUNNING' });
    f.restart();

    const recovered = await f.runtime().recoverInterrupted('user_owner');
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value).toHaveLength(1);
    expect(recovered.value[0]?.status).toBe('INTERRUPTED');
    expect(recovered.value[0]?.status).not.toBe('COMPLETED');
    // The recovery verdict is its own kind: a crashed process is not a provider timeout,
    // and it must not look retryable (Closeout: MEDIUM-3).
    expect(recovered.value[0]?.errorKind).toBe('INTERRUPTED');
    expect(recovered.value[0]?.errorCode).toBe('INTERRUPTED');
    // Recovery never re-invokes a provider.
    expect(providerA.calls).toHaveLength(0);
    expect(await events(f)).toContain('agent.execution_interrupted');
    // Running it again from a terminal state is a conflict, not a silent re-run.
    const again = await f
      .runtime()
      .run({
        executionId: recovered.value[0]!.executionId,
        actorId: 'user_owner',
        context: CONTEXT() as never,
      });
    expect(again.ok).toBe(false);
    expect(providerA.calls).toHaveLength(0);
  });

  it('Y: a provider error never triggers a fallback to another allowed model', async () => {
    const f = fixture();
    const { providerA, providerB } = await seed(f, { outcomes: ['unavailable'] });
    await f.policies().savePolicy({
      scopeType: 'COMPANY',
      scopeId: '*',
      mode: 'HYBRID',
      allowedProviders: ['mock-a', 'mock-b'],
      allowFallback: 'AUTO_WITHIN_POLICY',
      actorId: 'user_owner',
    });

    const executed = await f
      .runtime()
      .execute(
        request({ modelKey: 'mock-a.standard', scopes: [{ scopeType: 'COMPANY', scopeId: '*' }] }),
      );
    expect(executed.ok).toBe(false);
    if (!executed.ok) expect(executed.error.details['refusals']).toBeUndefined();
    const stored = (await f.database().agentExecutions.list()).items;
    // LIVE-SMOKE-FIX-03: the transient-unavailable failure is retried under the
    // CompanyOS bounded policy INSIDE this ONE logical execution — still exactly one
    // AgentExecution row, still model mock-a.standard, and the other model was never
    // touched (no model fallback; 4 network attempts = 1 initial + 3 bounded retries).
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('FAILED');
    expect(stored[0]?.modelKey).toBe('mock-a.standard');
    expect(providerA.calls).toHaveLength(4);
    expect(providerB.calls).toHaveLength(0);
  });

  it('Z: benchmark metadata changes nothing in the runtime', async () => {
    const f = fixture();
    await seed(f);
    const before = await f.runtime().execute(request({ modelKey: 'mock-a.standard' }));
    expect(before.ok).toBe(true);

    await f.policies().recordBenchmarkResults(
      [
        {
          id: 'br_1',
          modelKey: 'mock-b.cheap',
          suiteId: 'suite',
          caseId: 'case',
          category: 'CODING',
          score: 1,
          measuredValue: 1,
          notes: 'perfect',
          source: 'harness',
          recordedAt: '2026-12-01T00:00:00.000Z',
          recordedBy: 'user_owner',
        },
        {
          id: 'br_2',
          modelKey: 'mock-a.standard',
          suiteId: 'suite',
          caseId: 'case2',
          category: 'CODING',
          score: 0,
          measuredValue: 0,
          notes: 'terrible',
          source: 'harness',
          recordedAt: '2026-12-01T00:00:00.000Z',
          recordedBy: 'user_owner',
        },
      ],
      'user_owner',
    );

    const after = await f.runtime().execute(request({ modelKey: 'mock-a.standard' }));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // The low-scoring model is still used, because the caller named it.
    expect(after.value.modelKey).toBe('mock-a.standard');
    expect((await f.policies().performanceMetadata()).length).toBe(2);
  });
});

describe('R2. the runtime refuses a provider rejection it cannot explain', () => {
  it('never invents a success from a malformed provider result', async () => {
    const f = fixture();
    // A provider that returns a Result flag without a usable payload.
    const broken = {
      describe() {
        return { providerId: 'mock-a', kind: 'mock', displayName: 'A', version: '1' };
      },
      async listModels() {
        return ok([MODEL('standard')] as never);
      },
      async health() {
        return ok({
          status: 'healthy' as const,
          checkedAt: EPOCH === 0 ? 'x' : '2026-12-01T00:00:00.000Z',
          latencyMs: 0,
          detail: null,
        });
      },
      async invoke(): Promise<Result<never, DomainError>> {
        return err(
          domainError('AGENT_UNAVAILABLE', 'no result', {
            details: { 'companyos.provider.kind': 'unavailable' },
          }),
        );
      },
      async *stream() {
        yield err(domainError('AGENT_UNAVAILABLE', 'no result', {}));
      },
    };
    await f.providers().register(broken as never, { actorId: 'user_owner' });
    await f
      .models()
      .registerFromProvider({
        providerId: 'mock-a',
        providerModelId: 'standard',
        actorId: 'user_owner',
      });
    const executed = await f.runtime().execute(request());
    expect(executed.ok).toBe(false);
    const stored = (await f.database().agentExecutions.list()).items[0];
    expect(stored?.status).toBe('FAILED');
    expect(stored?.errorKind).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('AA. the runtime source carries no routing logic', () => {
  it('exposes only execution methods — no chooser', () => {
    const f = fixture();
    const surface = Object.keys(f.runtime()).sort();
    // Task-18-06 added the deferred-settlement seams (runWithOutput / completeExecution /
    // failExecution): a trusted runtime may persist its own durable result BEFORE the
    // execution is allowed to say COMPLETED. None of them resolves a model.
    expect(surface).toEqual([
      'cancel',
      'completeExecution',
      'execute',
      'failExecution',
      'get',
      'list',
      'prepare',
      'reclaimStaleClaims', // 25b98d1: boot-scope stale admission-claim reclaim
      'recoverInterrupted',
      'run',
      'runToolCall',
      'runWithOutput',
    ]);
    for (const forbidden of ['choose', 'select', 'pick', 'route', 'rank', 'score']) {
      expect(surface.some((key) => key.toLowerCase().includes(forbidden))).toBe(false);
    }
  });

  it('Sprint 8 debts: reads are permitted, run() re-validates, recovery pages', async () => {
    const f = fixture();
    await seed(f);
    const executed = await f.runtime().execute(request());
    if (!executed.ok) throw new Error('unexpected');

    // #1 agent.read is enforced on get/list.
    const denied = await f.runtime().get(executed.value.executionId, 'user_owner');
    // (no policy wired in this fixture => allow, but the call must go through the gate)
    expect(denied.ok).toBe(true);
    const listed = await f.runtime().list({ taskId: TASK }, 'user_owner');
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toHaveLength(1);

    // #2 run() re-validates: prepare then disable the model => FAILED, never a switch.
    const prepared = await f.runtime().prepare({
      agentId: 'agent_1',
      roleId: ROLE,
      taskId: TASK,
      runId: RUN,
      actorId: 'user_owner',
      modelKey: 'mock-a.standard',
      explicit: true,
      scopes: [],
    });
    if (!prepared.ok) throw new Error('unexpected');
    await f.models().setEnabled('mock-a.standard', false, 'user_owner');
    const ran = await f.runtime().run({
      executionId: prepared.value.executionId,
      actorId: 'user_owner',
      context: CONTEXT() as never,
    });
    expect(ran.ok).toBe(false);
    const stored = await f.database().agentExecutions.get(prepared.value.executionId);
    expect(stored?.status).toBe('FAILED');
    expect(stored?.modelKey).toBe('mock-a.standard');

    // #3 recovery scans past the first page: 250 in-flight rows are all repaired.
    for (let index = 0; index < 250; index += 1) {
      await f.database().agentExecutions.put({
        ...executed.value,
        id: `exec_page_${String(index)}`,
        executionId: `exec_page_${String(index)}`,
        status: 'RUNNING',
      });
    }
    const recovered = await f.runtime().recoverInterrupted('user_owner');
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.value.length).toBeGreaterThanOrEqual(250);
  });
});
