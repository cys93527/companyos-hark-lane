/**
 * Sprint 9.1.2 tests: attempt chains, defensive descriptor copies, stable pagination.
 *
 * A–F: retry 1/2/3, one adapter call per attempt, full history, correct root/parent chain.
 * G–H: a PromptPlan is an immutable snapshot of its descriptors.
 * I–K: 1000 same-timestamp invocations page without duplication, loss or drift.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FixedClock,
  SequenceIdFactory,
  assemblePrompt,
  buildAgentContext,
  createToolInvocation,
  describeTool,
  domainError,
  type ToolPort,
} from '@companyos/core';
import {
  ECHO_TOOL_SPEC,
  FAILING_TOOL_SPEC,
  createMockTool,
  createMockToolRecord,
  createToolRegistry,
  type ToolRegistry,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const EPOCH = Date.parse('2027-03-01T00:00:00.000Z');
const ACTOR = 'user_owner';

interface Fixture {
  readonly clock: FixedClock;
  database(): DurableDatabase;
  tools(): ToolRegistry;
  mockCalls(toolId: string): number;
  restart(): void;
  cleanup(): void;
}

const make = (): Fixture => {
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-nit-'));
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();
  const adapterCalls = new Map<string, number>();
  const open = (): DurableDatabase =>
    openDurableDatabase({
      dataDir,
      appliedAt: clock.nowIso(),
      chains: ['core', 'engine', 'provider', 'registry', 'selection', 'agent', 'tools'],
    });

  let database = open();

  const build = (db: DurableDatabase) => {
    const adapters = new Map<string, ToolPort>();
    for (const spec of [ECHO_TOOL_SPEC, FAILING_TOOL_SPEC]) {
      const mock = createMockTool(spec, clock);
      adapters.set(spec.toolId, {
        describe: () => mock.describe(),
        invoke: async (request) => {
          adapterCalls.set(spec.toolId, (adapterCalls.get(spec.toolId) ?? 0) + 1);
          return mock.invoke(request);
        },
      });
    }
    const tools = createToolRegistry({
      ids,
      clock,
      records: db.toolRecords,
      invocations: db.toolInvocations,
      invocationArtifacts: db.toolInvocationArtifacts,
      adapters,
      authorize: async ({ authority }: { readonly authority: string; readonly actorId: string }) =>
        authority === 'denied'
          ? { ok: false as const, error: domainError('PERMISSION_DENIED', 'denied', {}) }
          : { ok: true as const, value: true as const },
      events: db.events,
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
      claims: db.toolInvocationClaims ?? undefined,
      invocationIndex: db.toolInvocationIndex ?? undefined,
    });
    return { tools };
  };

  let built = build(database);

  return {
    clock,
    database: () => database,
    tools: () => built.tools,
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

const register = async (f: Fixture, spec = ECHO_TOOL_SPEC): Promise<void> => {
  const record = createMockToolRecord(spec, f.clock.nowIso());
  if (!record.ok) throw new Error(record.error.message);
  const registered = await f.tools().register(record.value, { actorId: ACTOR });
  if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
};

/** A crash leaves an INTERRUPTED, replay-safe invocation that a human may retry. */
const crashedIdempotentAttempt = async (f: Fixture): Promise<string> => {
  const created = await f.tools().invoke({
    toolId: 'mock.echo',
    executionId: 'exec_chain',
    agentId: 'agent_1',
    taskId: 'tsk_chain',
    runId: 'run_chain',
    actorId: ACTOR,
    input: { text: 'chain' },
  });
  if (!created.ok) throw new Error(created.error.message);
  const row = await f.database().toolInvocations.get(created.value.invocationId);
  if (row === null) throw new Error('missing invocation');
  const interrupted = {
    ...row,
    // Keep the pristine base key, so retry keys derive from the original identity.
    status: 'INTERRUPTED' as const,
    errorKind: 'INTERRUPTED' as const,
    errorCode: 'INTERRUPTED',
    startedAt: f.clock.nowIso(),
    startedAt2: undefined,
  };
  const { startedAt2: _ignored, ...rest } = interrupted;
  await f.database().toolInvocations.put(rest);
  return row.id;
};

/** Mark a (terminal) attempt as INTERRUPTED, i.e. "this attempt crashed too". */
const crash = async (f: Fixture, invocationId: string): Promise<void> => {
  const row = await f.database().toolInvocations.get(invocationId);
  if (row === null) throw new Error('missing invocation');
  await f.database().toolInvocations.put({ ...row, status: 'INTERRUPTED', errorKind: 'INTERRUPTED', errorCode: 'INTERRUPTED' });
};

describe('A–F. consecutive retry chain', () => {
  it('A/B/C/D/E/F: retry 1 → 2 → 3 keeps unique ids, a correct chain and one call each', async () => {
    const f = fixture();
    await register(f);
    const rootId = await crashedIdempotentAttempt(f);
    const callsAfterCrash = f.mockCalls('mock.echo');

    // Retry 1 (the root is INTERRUPTED, so it is retryable).
    const first = await f.tools().retryInvocation(rootId, ACTOR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const attempt1 = await f.database().toolInvocations.get(first.value.invocationId);
    expect(attempt1?.attemptNumber).toBe(2);
    expect(attempt1?.parentInvocationId).toBe(rootId);
    expect(attempt1?.rootInvocationId).toBe(rootId);
    expect(attempt1?.id).not.toBe(rootId);

    // The chain keeps growing: this attempt crashed as well, so retry 2 is allowed …
    await crash(f, attempt1!.id);
    const second = await f.tools().retryInvocation(attempt1!.id, ACTOR);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const attempt2 = await f.database().toolInvocations.get(second.value.invocationId);
    expect(attempt2?.attemptNumber).toBe(3);
    expect(attempt2?.parentInvocationId).toBe(attempt1!.id);
    expect(attempt2?.rootInvocationId).toBe(rootId);

    // … and retry 3.
    await crash(f, attempt2!.id);
    const third = await f.tools().retryInvocation(attempt2!.id, ACTOR);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    const attempt3 = await f.database().toolInvocations.get(third.value.invocationId);
    expect(attempt3?.attemptNumber).toBe(4);
    expect(attempt3?.parentInvocationId).toBe(attempt2!.id);
    expect(attempt3?.rootInvocationId).toBe(rootId);

    // D: exactly one adapter call per retry.
    expect(f.mockCalls('mock.echo')).toBe(callsAfterCrash + 3);

    // E: every historical attempt is still there.
    const history = await f.tools().listInvocations({ rootInvocationId: rootId, limit: 50 }, ACTOR);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    const ids = history.value.items.map((invocation) => invocation.id).sort();
    expect(ids).toEqual([rootId, attempt1!.id, attempt2!.id, attempt3!.id].sort());
    expect(history.value.items.every((invocation) => invocation.rootInvocationId === rootId)).toBe(true);

    // F: attempt numbers are strictly increasing along the chain.
    const numbers = history.value.items.map((invocation) => invocation.attemptNumber).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4]);
  });

  it('retrying an OLDER attempt still produces a NEW attempt (never a wrong replay)', async () => {
    const f = fixture();
    await register(f);
    const rootId = await crashedIdempotentAttempt(f);
    const first = await f.tools().retryInvocation(rootId, ACTOR);
    if (!first.ok) throw new Error('unexpected');
    expect(first.value.replayed).toBe(false);

    // Retrying the ROOT again must not answer with retry-1's replay: a new attempt is created.
    const again = await f.tools().retryInvocation(rootId, ACTOR);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.replayed).toBe(false);
    expect(again.value.invocationId).not.toBe(first.value.invocationId);
    const attempt = await f.database().toolInvocations.get(again.value.invocationId);
    expect(attempt?.attemptNumber).toBe(3);
    expect(attempt?.parentInvocationId).toBe(rootId);
    // One call for the crashed root attempt + one per explicit retry.
    expect(f.mockCalls('mock.echo')).toBe(3);
  });

  it('LOW-4: two concurrent retries of the same attempt execute the tool once', async () => {
    const f = fixture();
    await register(f);
    const rootId = await crashedIdempotentAttempt(f);
    const callsBefore = f.mockCalls('mock.echo');

    const outcomes = await Promise.all([
      f.tools().retryInvocation(rootId, ACTOR),
      f.tools().retryInvocation(rootId, ACTOR),
    ]);
    // Both may race for the same derived key; storage's UNIQUE constraint decides.
    const executed = outcomes.filter(
      (outcome) => outcome.ok && (outcome.value as { replayed?: boolean }).replayed === false,
    );
    expect(executed.length).toBeGreaterThanOrEqual(1);
    // The decisive property: at most one side effect per concurrent retry pair.
    expect(f.mockCalls('mock.echo')).toBe(callsBefore + 1);
    const chain = await f.tools().listInvocations({ rootInvocationId: rootId, limit: 50 }, ACTOR);
    if (chain.ok) expect(chain.value.items).toHaveLength(2);
  });

  it('NON-IDEMPOTENT tools are still refused', async () => {
    const f = fixture();
    await register(f, FAILING_TOOL_SPEC); // idempotencyMode: NONE
    const created = await f.tools().invoke({
      toolId: 'mock.failing',
      executionId: 'exec_nonidem',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: {},
    });
    // A failure still records the invocation.
    const invocationId = created.ok ? created.value.invocationId : String(created.error.details['invocationId'] ?? '');
    const row = await f.database().toolInvocations.get(invocationId);
    if (row === null) throw new Error('missing invocation');
    await f.database().toolInvocations.put({ ...row, status: 'INTERRUPTED' });
    const calls = f.mockCalls('mock.failing');
    const retried = await f.tools().retryInvocation(invocationId, ACTOR);
    expect(retried.ok).toBe(false);
    if (!retried.ok) expect(retried.error.code).toBe('POLICY_DENIED');
    expect(f.mockCalls('mock.failing')).toBe(calls);
  });
});

describe('G–H. descriptor snapshots are immutable', () => {
  it('G: mutating the caller schema after assembly cannot change the plan', () => {
    const context = buildAgentContext({
      company: { id: 'company_default', label: 'Company' },
      workflow: { id: 'wfl_1', label: 'Workflow' },
      workflowVersion: '1.0.0',
      workflowRun: { id: 'run_1', label: 'Run' },
      task: { id: 'tsk_1', label: 'Task' },
      role: { id: 'role_developer', label: 'Developer' },
      objective: 'Use a tool.',
      binding: { modelKey: 'mock-model-a.standard', providerId: 'mock-a', providerModelId: 'standard', source: 'BINDING' },
      trace: { traceId: 't1', executionId: 'exec_snapshot', attempt: 1 },
    });
    if (!context.ok) throw new Error('unexpected');

    const mutableSchema: Record<string, unknown> = {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    };
    const plan = assemblePrompt({
      context: context.value,
      toolDescriptors: [
        {
          toolId: 'mock.echo',
          name: 'Echo',
          description: 'Echoes text.',
          version: '1.0.0',
          riskLevel: 'LOW',
          capabilities: ['read'],
          parameters: mutableSchema,
        },
      ],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const before = JSON.stringify(plan.value.toolDescriptors);
    const hashBefore = plan.value.promptHash;

    // The caller keeps mutating its own object: the plan must not move.
    mutableSchema['properties'] = { hijacked: { type: 'number' } };
    mutableSchema['required'] = ['hijacked'];
    (mutableSchema['properties'] as Record<string, unknown>)['injected'] = { type: 'boolean' };

    expect(JSON.stringify(plan.value.toolDescriptors)).toBe(before);
    expect(plan.value.promptHash).toBe(hashBefore);
    const after = assemblePrompt({
      context: context.value,
      toolDescriptors: [
        {
          toolId: 'mock.echo',
          name: 'Echo',
          description: 'Echoes text.',
          version: '1.0.0',
          riskLevel: 'LOW',
          capabilities: ['read'],
          parameters: mutableSchema,
        },
      ],
    });
    // A NEW plan built from the mutated schema differs: the snapshot really did isolate it.
    if (after.ok) expect(after.value.promptHash).not.toBe(hashBefore);
  });

  it('H: the snapshot is frozen, so accident write-through is impossible', () => {
    const f = fixture();
    const record = createMockToolRecord(ECHO_TOOL_SPEC, f.clock.nowIso());
    if (!record.ok) throw new Error('unexpected');
    const plan = assemblePrompt({
      context: buildAgentContext({
        company: { id: 'c', label: 'c' },
        workflow: { id: 'w', label: 'w' },
        workflowVersion: '1.0.0',
        workflowRun: { id: 'r', label: 'r' },
        task: { id: 't', label: 't' },
        role: { id: 'ro', label: 'ro' },
        objective: 'x',
        binding: { modelKey: 'm', providerId: 'p', providerModelId: 'pm', source: 'BINDING' },
        trace: { traceId: 't1', executionId: 'e1', attempt: 1 },
      }).ok
        ? (buildAgentContext({
            company: { id: 'c', label: 'c' },
            workflow: { id: 'w', label: 'w' },
            workflowVersion: '1.0.0',
            workflowRun: { id: 'r', label: 'r' },
            task: { id: 't', label: 't' },
            role: { id: 'ro', label: 'ro' },
            objective: 'x',
            binding: { modelKey: 'm', providerId: 'p', providerModelId: 'pm', source: 'BINDING' },
            trace: { traceId: 't1', executionId: 'e1', attempt: 1 },
          }) as { ok: true; value: never }).value
        : ({} as never),
      toolDescriptors: [describeTool(record.value)],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const descriptor = plan.value.toolDescriptors[0]!;
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.parameters)).toBe(true);
    expect(() => {
      (descriptor.parameters as Record<string, unknown>)['type'] = 'hijacked';
    }).toThrow();
  });
});

describe('I–K. stable pagination under a frozen clock', () => {
  it('I/J/K: 1000 same-timestamp invocations page without loss, duplication or drift', async () => {
    const f = fixture();
    // Write 1000 rows directly: every one shares the SAME created_at.
    const ids: string[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const id = `tinv_${String(index).padStart(4, '0')}`;
      ids.push(id);
      const built = createToolInvocation({
        id,
        toolId: 'mock.echo',
        executionId: 'exec_paging',
        agentId: 'agent_1',
        taskId: 'tsk_paging',
        runId: 'run_paging',
        actorId: ACTOR,
        traceId: 'trace_paging',
        riskLevel: 'LOW',
        idempotencyMode: 'NONE',
        input: { text: `row-${String(index)}` },
        now: f.clock.nowIso(),
      });
      if (!built.ok) throw new Error(built.error.message);
      await f.database().toolInvocations.put(built.value);
    }

    const readAll = async (): Promise<readonly string[]> => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 200; guard += 1) {
        const page = await f.tools().listInvocations({ limit: 100, cursor }, ACTOR);
        expect(page.ok).toBe(true);
        if (!page.ok) return seen;
        for (const item of page.value.items) seen.push(item.id);
        cursor = page.value.nextCursor;
        if (cursor === null) break;
      }
      return seen;
    };

    const firstPass = await readAll();
    // No loss, no duplication.
    expect(firstPass).toHaveLength(1000);
    expect(new Set(firstPass).size).toBe(1000);
    expect([...firstPass].sort()).toEqual([...ids].sort());

    // No drift: the same traversal returns the same order.
    const secondPass = await readAll();
    expect(secondPass).toEqual(firstPass);

    // The declared order is created_at DESC, id DESC - so ids descend inside the tie group.
    const descending = [...ids].sort().reverse();
    expect(firstPass).toEqual(descending);

    const malformed = await f.tools().listInvocations({ limit: 100, cursor: 'nope' }, ACTOR);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe('INVALID_ARGUMENT');
  });
});
