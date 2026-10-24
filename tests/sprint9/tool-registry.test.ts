/**
 * Sprint 9 tests A–X: the Tool Registry.
 *
 * Every gate is exercised through the registry (never by calling an adapter directly), and the
 * adapters are deterministic mocks that do nothing but describe an action.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FixedClock,
  RISK_POLICY,
  SequenceIdFactory,
  createToolRecord,
  domainError,
  type ToolPort,
  type ToolRecord,
} from '@companyos/core';
import {
  CRITICAL_TOOL_SPEC,
  ECHO_TOOL_SPEC,
  FAILING_TOOL_SPEC,
  HIGH_RISK_TOOL_SPEC,
  READ_ONLY_TOOL_SPEC,
  SLOW_TOOL_SPEC,
  createAgentRuntime,
  createMockProvider,
  createMockTool,
  createMockToolRecord,
  createModelRegistry,
  createProviderRegistry,
  createSelectionPolicyService,
  createToolRegistry,
  type AgentRuntimeService,
  type ProviderRegistry,
  type ToolRegistry,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const EPOCH = Date.parse('2027-01-01T00:00:00.000Z');
const API_KEY = 'sk-mock-tool-0123456789abcdef';
const ACTOR = 'user_owner';

const MODEL = () => ({
  modelId: 'standard',
  displayName: 'Standard',
  contextWindow: 1000,
  maxOutputTokens: 100,
  // toolCalling is required for the runtime to declare tools to the model (Sprint 9 §九).
  capabilities: { streaming: true, toolCalling: true },
});

const CONTEXT = {
  company: { id: 'company_default', label: 'Company' },
  workflow: { id: 'wfl_1', label: 'Workflow' },
  workflowVersion: '1.0.0',
  workflowRun: { id: 'run_1', label: 'Run' },
  task: { id: 'tsk_1', label: 'Task' },
  role: { id: 'role_developer', label: 'Developer' },
  objective: 'Do the thing.',
  instructions: [],
  constraints: [],
  acceptanceCriteria: [],
  memoryView: [],
  artifactRefs: [],
};

interface Fixture {
  readonly clock: FixedClock;
  readonly denied: Set<string>;
  database(): DurableDatabase;
  tools(): ToolRegistry;
  runtime(): AgentRuntimeService;
  providers(): ProviderRegistry;
  adapters(): ReadonlyMap<string, ToolPort>;
  mockCalls(toolId: string): number;
  restart(): void;
  cleanup(): void;
}

const make = (): Fixture => {
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-tools-'));
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();
  const denied = new Set<string>();
  const open = (): DurableDatabase =>
    openDurableDatabase({
      dataDir,
      appliedAt: clock.nowIso(),
      chains: ['core', 'engine', 'provider', 'registry', 'selection', 'agent', 'tools'],
    });

  let database = open();
  const adapterCalls = new Map<string, number>();

  const authorize = async ({ authority }: { readonly actorId: string; readonly authority: string }) =>
    denied.has(authority)
      ? { ok: false as const, error: domainError('PERMISSION_DENIED', `denied: ${authority}`, { authority }) }
      : { ok: true as const, value: true as const };

  const build = (db: DurableDatabase) => {
    const adapters = new Map<string, ToolPort>();
    const specs = [ECHO_TOOL_SPEC, READ_ONLY_TOOL_SPEC, FAILING_TOOL_SPEC, HIGH_RISK_TOOL_SPEC, CRITICAL_TOOL_SPEC, SLOW_TOOL_SPEC];
    for (const spec of specs) {
      const mock = createMockTool(spec, clock);
      adapters.set(spec.toolId, {
        describe: () => mock.describe(),
        invoke: async (request) => {
          adapterCalls.set(spec.toolId, (adapterCalls.get(spec.toolId) ?? 0) + 1);
          return mock.invoke(request);
        },
      });
    }

    const providers = createProviderRegistry({
      ids,
      clock,
      registrations: db.providers,
      models: db.providerModels,
      authorize,
      events: db.events,
      systemActor: ACTOR,
    });
    const models = createModelRegistry({
      ids,
      clock,
      records: db.modelRecords,
      aliases: db.modelAliases,
      providers,
      authorize,
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
    const tools = createToolRegistry({
      ids,
      clock,
      records: db.toolRecords,
      invocations: db.toolInvocations,
      invocationArtifacts: db.toolInvocationArtifacts,
      adapters,
      authorize,
      events: db.events,
      secrets: async () => [API_KEY],
      // Tests may use real timers (the engine itself may not; see the boundary gate).
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
      // Atomic approval claim: the REAL storage compare-and-set, exactly as production wires it.
      claims: db.toolInvocationClaims ?? undefined,
      // Indexed idempotency lookup (Sprint 9.1 §二): never an in-memory scan.
      invocationIndex: db.toolInvocationIndex ?? undefined,
    });
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
      authorize,
      secrets: async () => [API_KEY],
    });
    return { providers, models, policies, tools, runtime, adapters };
  };

  let built = build(database);

  return {
    clock,
    denied,
    database: () => database,
    tools: () => built.tools,
    runtime: () => built.runtime,
    providers: () => built.providers,
    adapters: () => built.adapters,
    mockCalls: (toolId: string) => adapterCalls.get(toolId) ?? 0,
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

const registerSpec = async (f: Fixture, spec = ECHO_TOOL_SPEC): Promise<ToolRecord> => {
  const record = createMockToolRecord(spec, f.clock.nowIso());
  if (!record.ok) throw new Error(`spec invalid: ${record.error.message}`);
  const registered = await f.tools().register(record.value, { actorId: ACTOR });
  if (!registered.ok && registered.error.code !== 'CONFLICT') {
    throw new Error(`register failed: ${registered.error.message}`);
  }
  return record.value;
};

const invokeEcho = (f: Fixture, text = 'hello') =>
  f.tools().invoke({
    toolId: 'mock.echo',
    executionId: 'exec_1',
    agentId: 'agent_1',
    taskId: 'tsk_1',
    runId: 'run_1',
    actorId: ACTOR,
    input: { text },
  });

const events = async (f: Fixture): Promise<readonly string[]> =>
  (await f.database().events.all())
    .map((entry) => entry.event.type)
    .filter((type) => type.startsWith('tool.'));

describe('A/B/C/D. registration, uniqueness, enable/disable, capabilities', () => {
  it('A: registers a tool contract and reads it back', async () => {
    const f = fixture();
    const record = await registerSpec(f);
    expect(record).toMatchObject({
      toolId: 'mock.echo',
      name: 'Echo',
      version: '1.0.0',
      enabled: true,
      riskLevel: 'LOW',
      idempotencyMode: 'COMMAND_ID',
      providerKind: 'mock',
    });
    expect(record.requiredAuthorities).toContain('tool.invoke');

    const read = await f.tools().get('mock.echo', ACTOR);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value?.toolId).toBe('mock.echo');
    const listed = await f.tools().list(undefined, ACTOR);
    if (listed.ok) expect(listed.value.items.map((tool) => tool.toolId)).toEqual(['mock.echo']);
    expect(listed.ok && listed.value.nextCursor).toBeNull();
    expect(await events(f)).toContain('tool.registered');
  });

  it('B: refuses a duplicate tool id', async () => {
    const f = fixture();
    await registerSpec(f);
    const again = createMockToolRecord(ECHO_TOOL_SPEC, f.clock.nowIso());
    if (!again.ok) throw new Error('unexpected');
    const duplicate = await f.tools().register(again.value, { actorId: ACTOR });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('CONFLICT');
  });

  it('C: enable/disable is persisted, listed and audited', async () => {
    const f = fixture();
    await registerSpec(f);
    const disabled = await f.tools().setEnabled('mock.echo', false, ACTOR);
    expect(disabled.ok).toBe(true);
    if (disabled.ok) expect(disabled.value.enabled).toBe(false);
    const visible = await f.tools().list(undefined, ACTOR);
    if (visible.ok) expect(visible.value.items).toHaveLength(0);
    const all = await f.tools().list({ includeDisabled: true }, ACTOR);
    if (all.ok) expect(all.value.items).toHaveLength(1);
    expect(await events(f)).toEqual(['tool.registered', 'tool.disabled']);
  });

  it('D: capabilities and declared authorities are part of the contract', async () => {
    const f = fixture();
    const strict = createToolRecord({
      toolId: 'mock.requires_authority',
      name: 'Needs model.write',
      description: 'Demonstrates a declared authority requirement.',
      version: '1.0.0',
      capabilities: ['read'],
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      outputSchema: { type: 'object' },
      riskLevel: 'LOW',
      requiredAuthorities: ['model.write'],
      providerKind: 'mock',
      adapterRef: 'mock.echo',
      now: f.clock.nowIso(),
    });
    if (!strict.ok) throw new Error('unexpected');
    await f.tools().register(strict.value, { actorId: ACTOR });

    f.denied.add('model.write');
    const refused = await f.tools().invoke({
      toolId: 'mock.requires_authority',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: {},
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('E/F/W/X. permissions, disabled tools and UI-proof risk', () => {
  it('E: tool.read is enforced on reads', async () => {
    const f = fixture();
    await registerSpec(f);
    f.denied.add('tool.read');
    const read = await f.tools().get('mock.echo', ACTOR);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe('PERMISSION_DENIED');
    const listed = await f.tools().list(undefined, ACTOR);
    expect(listed.ok).toBe(false);
  });

  it('F: tool.invoke is enforced before the adapter', async () => {
    const f = fixture();
    await registerSpec(f);
    f.denied.add('tool.invoke');
    const refused = await invokeEcho(f);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('PERMISSION_DENIED');
    expect(f.mockCalls('mock.echo')).toBe(0);
  });

  it('W: a disabled tool never reaches an adapter', async () => {
    const f = fixture();
    await registerSpec(f);
    await f.tools().setEnabled('mock.echo', false, ACTOR);
    const refused = await invokeEcho(f);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('POLICY_DENIED');
    expect(f.mockCalls('mock.echo')).toBe(0);
    expect((await f.database().toolInvocations.list()).items).toHaveLength(0);
  });

  it('X: risk cannot be bypassed by an input field', async () => {
    const f = fixture();
    await registerSpec(f, HIGH_RISK_TOOL_SPEC);
    // A caller trying to "approve itself" in the payload changes nothing: HIGH always waits.
    const refused = await f.tools().invoke({
      toolId: 'mock.high_risk',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: { target: 'x', approved: true } as never,
      idempotencyKey: 'key-self-approve',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('APPROVAL_REQUIRED');
    expect(RISK_POLICY.HIGH.requiresApproval).toBe(true);
    expect(RISK_POLICY.CRITICAL.selfApprovalAllowed).toBe(false);
    expect(f.mockCalls('mock.high_risk')).toBe(0);
  });
});

describe('G/H/I/J. schema validation and risk execution', () => {
  it('G: an invalid input is refused before the adapter', async () => {
    const f = fixture();
    await registerSpec(f);
    const refused = await f.tools().invoke({
      toolId: 'mock.echo',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: {},
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('INVALID_ARGUMENT');
      expect(refused.error.details['kind']).toBe('INPUT_INVALID');
      expect(String(refused.error.message)).toContain('$.text');
    }
    expect(f.mockCalls('mock.echo')).toBe(0);
  });

  it('H: an invalid output is refused after the adapter', async () => {
    const f = fixture();
    const spec = {
      ...ECHO_TOOL_SPEC,
      toolId: 'mock.bad_output',
      adapterRef: 'mock.echo',
      outputSchema: {
        type: 'object',
        properties: { different: { type: 'string' } },
        required: ['different'],
        additionalProperties: false,
      },
    };
    await registerSpec(f, spec);
    const result = await f.tools().invoke({
      toolId: 'mock.bad_output',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: { text: 'x' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.details['kind']).toBe('OUTPUT_INVALID');
    }
    expect(f.mockCalls('mock.echo')).toBe(1);
    const stored = (await f.database().toolInvocations.list()).items[0];
    expect(stored?.status).toBe('FAILED');
    expect(stored?.errorKind).toBe('OUTPUT_INVALID');
  });

  it('I: a LOW risk tool executes and records its outcome', async () => {
    const f = fixture();
    await registerSpec(f);
    const executed = await invokeEcho(f, 'low risk');
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.value).toMatchObject({
      status: 'COMPLETED',
      toolId: 'mock.echo',
      riskLevel: 'LOW',
      output: { echo: 'low risk' },
      replayed: false,
    });
    expect(executed.value.latencyMs).toBe(0);
  });

  it('J: a MEDIUM risk tool executes with STRICT audit', async () => {
    const f = fixture();
    const spec = { ...ECHO_TOOL_SPEC, toolId: 'mock.medium', riskLevel: 'MEDIUM' as const, adapterRef: 'mock.echo' };
    const record = await registerSpec(f, spec);
    expect(record.auditPolicy).toBe('STRICT');
    const executed = await f.tools().invoke({
      toolId: 'mock.medium',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: { text: 'medium' },
    });
    expect(executed.ok).toBe(true);
    expect(await events(f)).toEqual([
      'tool.registered',
      'tool.invocation_requested',
      'tool.invocation_started',
      'tool.invocation_completed',
    ]);
  });
});

describe('K/L/M. approval gates', () => {
  it('K: a HIGH risk tool waits for approval instead of executing', async () => {
    const f = fixture();
    await registerSpec(f, HIGH_RISK_TOOL_SPEC);
    const refused = await f.tools().invoke({
      toolId: 'mock.high_risk',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: { target: 'resource-1' },
      idempotencyKey: 'key-high-1',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('APPROVAL_REQUIRED');
      expect(typeof refused.error.details['invocationId']).toBe('string');
    }
    expect(f.mockCalls('mock.high_risk')).toBe(0);
    const waiting = (await f.database().toolInvocations.list()).items[0];
    expect(waiting?.status).toBe('WAITING_APPROVAL');
    expect(await events(f)).toContain('tool.approval_requested');
  });

  it('L: after approval the recorded request executes exactly once', async () => {
    const f = fixture();
    await registerSpec(f, HIGH_RISK_TOOL_SPEC);
    const refused = await f.tools().invoke({
      toolId: 'mock.high_risk',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: { target: 'resource-1' },
      idempotencyKey: 'key-high-2',
    });
    if (refused.ok) throw new Error('unexpected');
    const invocationId = String(refused.error.details['invocationId']);

    const approved = await f.tools().approve({ invocationId, actorId: 'user_reviewer' });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.value.status).toBe('COMPLETED');
      expect(approved.value.output).toEqual({ target: 'resource-1', action: 'described-only' });
    }
    expect(f.mockCalls('mock.high_risk')).toBe(1);
    const stored = await f.database().toolInvocations.get(invocationId);
    expect(stored?.approvedBy).toBe('user_reviewer');
  });

  it('M: a CRITICAL tool may not be approved by its requester', async () => {    const f = fixture();
    await registerSpec(f, CRITICAL_TOOL_SPEC);
    const refused = await f.tools().invoke({
      toolId: 'mock.critical',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: { target: 'production-ish' },
      idempotencyKey: 'key-critical-1',
    });
    if (refused.ok) throw new Error('unexpected');
    const invocationId = String(refused.error.details['invocationId']);

    const selfApproval = await f.tools().approve({ invocationId, actorId: ACTOR });
    expect(selfApproval.ok).toBe(false);
    if (!selfApproval.ok) expect(selfApproval.error.code).toBe('APPROVAL_DENIED');
    expect(f.mockCalls('mock.critical')).toBe(0);

    const second = await f.tools().approve({ invocationId, actorId: 'user_owner_2' });
    expect(second.ok).toBe(true);
    expect(f.mockCalls('mock.critical')).toBe(1);
  });

  it('Closeout HIGH-1: two concurrent approvals execute the tool exactly once', async () => {
    const f = fixture();
    await registerSpec(f, HIGH_RISK_TOOL_SPEC);
    const refused = await f.tools().invoke({
      toolId: 'mock.high_risk',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: { target: 'race' },
      idempotencyKey: 'key-race',
    });
    if (refused.ok) throw new Error('unexpected');
    const invocationId = String(refused.error.details['invocationId']);

    const outcomes = await Promise.all([
      f.tools().approve({ invocationId, actorId: 'user_approver_1' }),
      f.tools().approve({ invocationId, actorId: 'user_approver_2' }),
    ]);
    // The storage-level compare-and-set lets exactly one approver execute.
    const executed = outcomes.filter(
      (outcome) => outcome.ok && (outcome.value as { replayed?: boolean }).replayed === false,
    );
    expect(executed).toHaveLength(1);
    const replayedOrRefused = outcomes.filter(
      (outcome) => !outcome.ok || (outcome.value as { replayed?: boolean }).replayed === true,
    );
    expect(replayedOrRefused).toHaveLength(1);
    // The whole point: one side effect, not two.
    expect(f.mockCalls('mock.high_risk')).toBe(1);
  });

  it('Closeout MEDIUM-1: a tool disabled while approval is pending is refused', async () => {
    const f = fixture();
    await registerSpec(f, HIGH_RISK_TOOL_SPEC);
    const refused = await f.tools().invoke({
      toolId: 'mock.high_risk',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: { target: 'disabled-later' },
      idempotencyKey: 'key-disabled-later',
    });
    if (refused.ok) throw new Error('unexpected');
    const invocationId = String(refused.error.details['invocationId']);

    await f.tools().setEnabled('mock.high_risk', false, ACTOR);
    const approved = await f.tools().approve({ invocationId, actorId: 'user_reviewer' });
    expect(approved.ok).toBe(false);
    if (!approved.ok) expect(approved.error.details['kind']).toBe('TOOL_DISABLED');
    expect(f.mockCalls('mock.high_risk')).toBe(0);
  });
});

describe('N/O/P/Q/R/S. failures, timeout, idempotency, audit and redaction', () => {
  it('N: a tool error is structured, persisted and audited', async () => {
    const f = fixture();
    await registerSpec(f, FAILING_TOOL_SPEC);
    const failed = await f.tools().invoke({
      toolId: 'mock.failing',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: {},
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.details['kind']).toBe('TOOL_FAILED');
      expect(failed.error.details['retryable']).toBe(true);
    }
    const stored = (await f.database().toolInvocations.list()).items[0];
    expect(stored?.status).toBe('FAILED');
    expect(stored?.errorKind).toBe('TOOL_FAILED');
    expect(await events(f)).toContain('tool.invocation_failed');
  });

  it('O: a tool that never returns hits its timeout', async () => {
    const f = fixture();
    await registerSpec(f, SLOW_TOOL_SPEC);
    const timedOut = await f.tools().invoke({
      toolId: 'mock.slow',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: { text: 'never' },
    });
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) {
      expect(timedOut.error.code).toBe('TIMEOUT');
      expect(timedOut.error.details['kind']).toBe('TIMEOUT');
    }
    const stored = (await f.database().toolInvocations.list()).items[0];
    expect(stored?.status).toBe('FAILED');
    expect(stored?.errorKind).toBe('TIMEOUT');
  });

  it('P/Q: a replayed invocation returns the recorded outcome without a second side effect', async () => {
    const f = fixture();
    await registerSpec(f);
    const first = await invokeEcho(f, 'same payload');
    expect(first.ok).toBe(true);
    const second = await invokeEcho(f, 'same payload');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.invocationId).toBe(first.ok ? first.value.invocationId : '');
    // The adapter ran exactly once: no duplicate side effect.
    expect(f.mockCalls('mock.echo')).toBe(1);
    expect((await f.database().toolInvocations.list()).items).toHaveLength(1);
  });

  it('R: the audit trail carries the required fields and no full payload', async () => {
    const f = fixture();
    await registerSpec(f);
    await invokeEcho(f, 'audited');
    const events_ = await f.database().events.all();
    const completed = events_.find((entry) => entry.event.type === 'tool.invocation_completed');
    const payload = completed?.event.payload as Record<string, unknown>;
    for (const field of ['toolId', 'invocationId', 'executionId', 'agentId', 'taskId', 'runId', 'actorId', 'riskLevel', 'traceId']) {
      expect(payload[field], `payload.${field}`).toBeDefined();
    }
    // A digest yes, the payload itself no.
    expect(typeof payload['outputDigest']).toBe('string');
    expect(JSON.stringify(payload)).not.toContain('audited');
  });

  it('S: a credential never reaches the database, the events or the error', async () => {
    const f = fixture();
    await registerSpec(f, FAILING_TOOL_SPEC);
    const failed = await f.tools().invoke({
      toolId: 'mock.failing',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: { authorization: `Bearer ${API_KEY}` } as never,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(JSON.stringify(failed.error)).not.toContain(API_KEY);
    expect(JSON.stringify(await f.database().events.all())).not.toContain(API_KEY);
    expect(JSON.stringify((await f.database().toolInvocations.list()).items)).not.toContain(API_KEY);
  });
});

describe('T/U/V. restart persistence and the bounded runtime round', () => {
  it('T: tool contracts, state and history survive a restart', async () => {
    const f = fixture();
    await registerSpec(f);
    await registerSpec(f, FAILING_TOOL_SPEC);
    await invokeEcho(f, 'persisted');
    await f.tools().invoke({
      toolId: 'mock.failing',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: {},
    });
    await f.tools().setEnabled('mock.failing', false, ACTOR);

    f.restart();

    const echo = await f.tools().get('mock.echo', ACTOR);
    expect(echo.ok).toBe(true);
    if (echo.ok) {
      expect(echo.value?.riskLevel).toBe('LOW');
      expect(echo.value?.requiredAuthorities).toContain('tool.invoke');
    }
    const failing = await f.tools().get('mock.failing', ACTOR);
    if (failing.ok) expect(failing.value?.enabled).toBe(false);
    const history = await f.tools().listInvocations(undefined, ACTOR);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.value.items.length).toBeGreaterThanOrEqual(2);
      expect(history.value.items.some((invocation) => invocation.status === 'COMPLETED')).toBe(true);
      expect(history.value.items.some((invocation) => invocation.status === 'FAILED')).toBe(true);
      expect(history.value.items.find((invocation) => invocation.status === 'FAILED')?.errorKind).toBe('TOOL_FAILED');
    }
  });

  it('U/V: the runtime runs ONE tool round inside an execution and returns the result', async () => {
    const f = fixture();
    const provider = createMockProvider({
      providerId: 'mock-model-a',
      kind: 'mock',
      displayName: 'Model A',
      script: { models: [MODEL()], outcomes: [{ outputText: 'ok' }] },
    });
    await f.providers().register(provider, { actorId: ACTOR });
    const models = createModelRegistry({
      ids: new SequenceIdFactory(),
      clock: f.clock,
      records: f.database().modelRecords,
      aliases: f.database().modelAliases,
      providers: f.providers(),
      events: f.database().events,
      scope: 'default',
    });
    await models.registerFromProvider({ providerId: 'mock-model-a', providerModelId: 'standard', actorId: ACTOR });
    await registerSpec(f);

    // A real execution, with the tool DECLARED through the registry (descriptors, not guesses).
    const executed = await f.runtime().execute({
      agentId: 'agent_1',
      roleId: 'role_developer',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      modelKey: 'mock-model-a.standard',
      explicit: true,
      scopes: [],
      context: CONTEXT as never,
      prompt: { toolIds: ['mock.echo'] },
    });
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.value.status).toBe('COMPLETED');
    // The model saw a real descriptor from the registry.
    expect(provider.calls[0]?.tools?.[0]?.name).toBe('Echo');

    // ONE bounded tool round, tied to that execution.
    const round = await f.runtime().runToolCall({
      executionId: executed.value.executionId,
      actorId: ACTOR,
      toolId: 'mock.echo',
      input: { text: 'from the model' },
    });
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.value.status).toBe('COMPLETED');
    expect(round.value.output).toEqual({ echo: 'from the model' });

    const invocations = await f.tools().listInvocations({ executionId: executed.value.executionId }, ACTOR);
    expect(invocations.ok).toBe(true);
    if (invocations.ok) {
      expect(invocations.value.items).toHaveLength(1);
      expect(invocations.value.items[0]?.traceId).toBe(executed.value.traceId);
      expect(invocations.value.items[0]?.taskId).toBe('tsk_1');
    }
    // Exactly one round: no second call, no loop.
    expect(f.mockCalls('mock.echo')).toBe(1);
  });

  it('V: a tool result reaches the caller with output and artifacts', async () => {
    const f = fixture();
    await registerSpec(f, READ_ONLY_TOOL_SPEC);
    const result = await f.tools().invoke({
      toolId: 'mock.read_only',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: { id: 'art_1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toEqual({ id: 'art_1', summary: 'read-only record' });
    expect(result.value.artifactRefs).toEqual([]);
  });
});

describe('Y. the registry never selects a tool', () => {
  it('exposes no chooser surface', () => {
    const surface = Object.keys(fixture().tools()).sort();
    expect(surface).toContain('invoke');
    expect(surface).toContain('register');
    // No chooser/planner. `findInvocationByIdempotencyKey` is an indexed LOOKUP, not a tool
    // picker, so the check targets tool-selection shapes rather than the substring "find".
    for (const forbidden of ['plan', 'best', 'choose', 'select', 'route', 'rank', 'score']) {
      expect(surface.some((key) => key.toLowerCase().includes(forbidden))).toBe(false);
    }
    expect(surface).not.toContain('findTool');
    expect(surface).not.toContain('nextTool');
  });
});

describe('Z2. an adapter is required by name', () => {
  it('refuses an invocation whose adapter is not bound', async () => {
    const f = fixture();
    const record = createToolRecord({
      toolId: 'mock.unbound',
      name: 'Unbound',
      description: 'No adapter is bound to this tool.',
      version: '1.0.0',
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object' },
      riskLevel: 'LOW',
      providerKind: 'mock',
      adapterRef: 'missing-adapter',
      now: f.clock.nowIso(),
    });
    if (!record.ok) throw new Error('unexpected');
    await f.tools().register(record.value, { actorId: ACTOR });
    const refused = await f.tools().invoke({
      toolId: 'mock.unbound',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: {},
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.details['kind']).toBe('TOOL_NOT_FOUND');
  });
});
