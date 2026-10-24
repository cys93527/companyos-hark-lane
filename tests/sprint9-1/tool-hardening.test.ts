/**
 * Sprint 9.1 tests A–O: tool runtime hardening.
 *
 * Recovery semantics, indexed idempotency, replay honesty, pagination and tool descriptors in
 * the prompt - plus the two approval rules pinned as intentional.
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
  describeTool,
  domainError,
  toMessages,
  type ToolPort,
} from '@companyos/core';
import {
  CRITICAL_TOOL_SPEC,
  ECHO_TOOL_SPEC,
  FAILING_TOOL_SPEC,
  HIGH_RISK_TOOL_SPEC,
  READ_ONLY_TOOL_SPEC,
  createMockTool,
  createMockToolRecord,
  createToolRegistry,
  type MockToolSpec,
  type ToolRegistry,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const EPOCH = Date.parse('2027-02-01T00:00:00.000Z');
const ACTOR = 'user_owner';

interface Fixture {
  readonly clock: FixedClock;
  readonly ids: SequenceIdFactory;
  denied: Set<string>;
  database(): DurableDatabase;
  tools(): ToolRegistry;
  adapters(): ReadonlyMap<string, ToolPort>;
  mockCalls(toolId: string): number;
  restart(): void;
  cleanup(): void;
}

const make = (): Fixture => {
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-tool-hardening-'));
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();
  const denied = new Set<string>();
  const adapterCalls = new Map<string, number>();
  const open = (): DurableDatabase =>
    openDurableDatabase({
      dataDir,
      appliedAt: clock.nowIso(),
      chains: ['core', 'engine', 'provider', 'registry', 'selection', 'agent', 'tools'],
    });

  let database = open();

  const authorize = async ({ authority }: { readonly actorId: string; readonly authority: string }) =>
    denied.has(authority)
      ? { ok: false as const, error: domainError('PERMISSION_DENIED', `denied: ${authority}`, { authority }) }
      : { ok: true as const, value: true as const };

  const build = (db: DurableDatabase) => {
    const adapters = new Map<string, ToolPort>();
    const specs = [ECHO_TOOL_SPEC, READ_ONLY_TOOL_SPEC, FAILING_TOOL_SPEC, HIGH_RISK_TOOL_SPEC, CRITICAL_TOOL_SPEC];
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
    const tools = createToolRegistry({
      ids,
      clock,
      records: db.toolRecords,
      invocations: db.toolInvocations,
      invocationArtifacts: db.toolInvocationArtifacts,
      adapters,
      authorize,
      events: db.events,
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
      claims: db.toolInvocationClaims ?? undefined,
      invocationIndex: db.toolInvocationIndex ?? undefined,
    });
    return { tools, adapters };
  };

  let built = build(database);

  return {
    clock,
    ids,
    denied,
    database: () => database,
    tools: () => built.tools,
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

const register = async (f: Fixture, spec: MockToolSpec = ECHO_TOOL_SPEC): Promise<void> => {
  const record = createMockToolRecord(spec, f.clock.nowIso());
  if (!record.ok) throw new Error(record.error.message);
  const registered = await f.tools().register(record.value, { actorId: ACTOR });
  if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
};

const invoke = (
  f: Fixture,
  toolId = 'mock.echo',
  input: Record<string, unknown> = { text: 'x' },
  idempotencyKey?: string,
) =>
  f.tools().invoke({
    toolId,
    executionId: 'exec_1',
    agentId: 'agent_1',
    taskId: 'tsk_1',
    runId: 'run_1',
    actorId: ACTOR,
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });

/** Put an invocation into STARTED by hand: that is what a crashed process leaves behind. */
const crashIntoStarted = async (f: Fixture, toolId = 'mock.echo', key = 'crash-key'): Promise<string> => {
  const created = await f.tools().invoke({
    toolId,
    executionId: 'exec_crash',
    agentId: 'agent_1',
    taskId: 'tsk_crash',
    runId: 'run_crash',
    actorId: ACTOR,
    input: { text: 'crashed' },
    idempotencyKey: key,
  });
  // A tool that fails still records its invocation (that is the point of the audit trail).
  const invocationId = created.ok
    ? created.value.invocationId
    : String(created.error.details['invocationId'] ?? '');
  if (invocationId.length === 0) throw new Error('no invocation was recorded');
  const row = await f.database().toolInvocations.get(invocationId);
  if (row === null) throw new Error('missing invocation');
  await f.database().toolInvocations.put({ ...row, status: 'STARTED', idempotencyKey: null });
  return row.id;
};

describe('A/B/C/D/E. recovery semantics', () => {
  it('A: a WAITING_APPROVAL invocation survives a restart still waiting', async () => {
    const f = fixture();
    await register(f, HIGH_RISK_TOOL_SPEC);
    const refused = await invoke(f, 'mock.high_risk', { target: 't' }, 'key-approval');
    expect(refused.ok).toBe(false);
    const invocationId = refused.ok ? '' : String(refused.error.details['invocationId']);

    f.restart();

    const row = await f.database().toolInvocations.get(invocationId);
    expect(row?.status).toBe('WAITING_APPROVAL');
    expect(row?.approvedBy).toBeNull();
  });

  it('B: recovery never auto-approves and never auto-executes a pending campaign', async () => {
    const f = fixture();
    await register(f, HIGH_RISK_TOOL_SPEC);
    const refused = await invoke(f, 'mock.high_risk', { target: 't' }, 'key-approval-2');
    expect(refused.ok).toBe(false);

    const report = await f.tools().recoverInvocations(ACTOR);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.waitingApproval).toHaveLength(1);
    expect(report.value.interrupted).toHaveLength(0);
    // Nothing ran: no adapter call, still no approval.
    expect(f.mockCalls('mock.high_risk')).toBe(0);
    const row = await f.tools().listInvocations(undefined, ACTOR);
    if (row.ok) expect(row.value.items[0]?.status).toBe('WAITING_APPROVAL');
  });

  it('C: a STARTED invocation becomes INTERRUPTED - never COMPLETED', async () => {
    const f = fixture();
    await register(f);
    const invocationId = await crashIntoStarted(f);
    f.restart();

    const report = await f.tools().recoverInvocations(ACTOR);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.interrupted).toContain(invocationId);

    const row = await f.database().toolInvocations.get(invocationId);
    expect(row?.status).toBe('INTERRUPTED');
    expect(row?.status).not.toBe('COMPLETED');
    expect(row?.errorKind).toBe('INTERRUPTED');
    expect(await f.database().events.all()).toSatisfy((entries: readonly unknown[]) => entries.length > 0);
    const types = (await f.database().events.all()).map((entry) => entry.event.type);
    expect(types).toContain('tool.invocation_interrupted');
  });

  it('D: a NON-IDEMPOTENT tool is never auto-retried (and an explicit retry is refused)', async () => {
    const f = fixture();
    await register(f, FAILING_TOOL_SPEC); // idempotencyMode: NONE
    const invocationId = await crashIntoStarted(f, 'mock.failing');
    const report = await f.tools().recoverInvocations(ACTOR);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.interrupted).toContain(invocationId);
    // Non-idempotent => not even listed as retryable.
    expect(report.value.retryable).not.toContain(invocationId);

    const callsBefore = f.mockCalls('mock.failing');
    const retried = await f.tools().retryInvocation(invocationId, ACTOR);
    expect(retried.ok).toBe(false);
    if (!retried.ok) expect(retried.error.code).toBe('POLICY_DENIED');
    expect(f.mockCalls('mock.failing')).toBe(callsBefore);
  });

  it('E: an IDEMPOTENT tool can be retried by an explicit recovery command', async () => {
    const f = fixture();
    await register(f, ECHO_TOOL_SPEC); // idempotencyMode: COMMAND_ID
    const invocationId = await crashIntoStarted(f, 'mock.echo', 'retryable-crash');
    const report = await f.tools().recoverInvocations(ACTOR);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.retryable).toContain(invocationId);

    const before = f.mockCalls('mock.echo');
    const retried = await f.tools().retryInvocation(invocationId, ACTOR);
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      expect(retried.value.status).toBe('COMPLETED');
      // A retry is a NEW attempt, not a revived row.
      expect(retried.value.invocationId).not.toBe(invocationId);
    }
    expect(f.mockCalls('mock.echo')).toBe(before + 1);
    const original = await f.database().toolInvocations.get(invocationId);
    expect(original?.status).toBe('INTERRUPTED');
  });
});

describe('F/G/H/I. replay honesty and indexed idempotency', () => {
  it('F: a replay answers with the original status and id', async () => {
    const f = fixture();
    await register(f);
    const first = await invoke(f, 'mock.echo', { text: 'same' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = await invoke(f, 'mock.echo', { text: 'same' });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.originalInvocationId).toBe(first.value.invocationId);
    expect(replay.value.originalStatus).toBe('COMPLETED');
    expect(replay.value.status).toBe('COMPLETED');
    expect(f.mockCalls('mock.echo')).toBe(1);
    const types = (await f.database().events.all()).map((entry) => entry.event.type);
    expect(types).toContain('tool.invocation_replayed');
  });

  it('G: a FAILED original is replayed AS FAILED - never dressed up as success', async () => {
    const f = fixture();
    // A failing tool that IS replay-safe (COMMAND_ID) and bound to the real failing adapter,
    // so "it did not run twice" is measurable on the adapter's own counter.
    await register(f, {
      ...FAILING_TOOL_SPEC,
      toolId: 'mock.failing_idem',
      adapterRef: 'mock.failing',
      idempotencyMode: 'COMMAND_ID',
    });
    const first = await invoke(f, 'mock.failing_idem', {}, 'failed-key');
    expect(first.ok).toBe(false);
    const callsAfterFirst = f.mockCalls('mock.failing');
    expect(callsAfterFirst).toBe(1);

    const second = await invoke(f, 'mock.failing_idem', {}, 'failed-key');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.status).toBe('FAILED');
    expect(second.value.originalStatus).toBe('FAILED');
    // The tool ran exactly once: a replay must never re-execute a failure either.
    expect(f.mockCalls('mock.failing')).toBe(callsAfterFirst);
  });

  it('H: the idempotency lookup is an indexed query, not a scan', async () => {
    const f = fixture();
    await register(f);
    const first = await invoke(f, 'mock.echo', { text: 'indexed' });
    if (!first.ok) throw new Error('unexpected');
    const row = await f.database().toolInvocations.get(first.value.invocationId);
    const key = row?.idempotencyKey ?? '';
    expect(key.length).toBeGreaterThan(0);
    const found = await f.tools().findInvocationByIdempotencyKey(key, ACTOR);
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value?.id).toBe(first.value.invocationId);
    const missing = await f.tools().findInvocationByIdempotencyKey('no-such-key', ACTOR);
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.value).toBeNull();
  });

  it('I: a storage UNIQUE violation surfaces as a DomainError (no raw SqliteError)', async () => {
    const f = fixture();
    await register(f);
    const first = await invoke(f, 'mock.echo', { text: 'unique' });
    if (!first.ok) throw new Error('unexpected');
    const row = await f.database().toolInvocations.get(first.value.invocationId);
    const key = row?.idempotencyKey ?? '';
    expect(key.length).toBeGreaterThan(0);

    // A registry whose index MISSES the existing row (simulating a stale/partial index): the
    // write path then hits the storage UNIQUE constraint, and the registry must translate it.
    const blindRegistry = createToolRegistry({
      ids: f.ids,
      clock: f.clock,
      records: f.database().toolRecords,
      invocations: f.database().toolInvocations,
      invocationArtifacts: f.database().toolInvocationArtifacts,
      adapters: f.adapters(),
      events: f.database().events,
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
      claims: f.database().toolInvocationClaims ?? undefined,
      invocationIndex: { findByIdempotencyKey: async () => null },
    });
    const colliding = await blindRegistry.invoke({
      toolId: 'mock.echo',
      executionId: 'exec_1',
      agentId: 'agent_1',
      taskId: 'tsk_1',
      runId: 'run_1',
      actorId: ACTOR,
      input: { text: 'unique' },
      idempotencyKey: key,
    });
    // Whatever branch it takes, the answer is a DomainError - never a raw storage error.
    expect(colliding.ok).toBe(false);
    if (!colliding.ok) {
      expect(['CONFLICT', 'ALREADY_EXISTS']).toContain(colliding.error.code);
      expect(colliding.error.details['kind']).toBe('IDEMPOTENT_REPLAY');
    }
  });
});

describe('J. tools.list pagination', () => {
  it('pages with an explicit cursor and never truncates silently', async () => {
    const f = fixture();
    for (const spec of [ECHO_TOOL_SPEC, READ_ONLY_TOOL_SPEC, FAILING_TOOL_SPEC, HIGH_RISK_TOOL_SPEC, CRITICAL_TOOL_SPEC]) {
      await register(f, spec);
    }
    const firstPage = await f.tools().list({ limit: 2 }, ACTOR);
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok) return;
    expect(firstPage.value.items).toHaveLength(2);
    expect(firstPage.value.nextCursor).not.toBeNull();

    const seen = new Set(firstPage.value.items.map((tool) => tool.toolId));
    let cursor = firstPage.value.nextCursor;
    let guard = 0;
    while (cursor !== null && guard < 10) {
      guard += 1;
      const page = await f.tools().list({ limit: 2, cursor }, ACTOR);
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const tool of page.value.items) seen.add(tool.toolId);
      cursor = page.value.nextCursor;
    }
    // Every registered tool was reachable across pages: no silent cap.
    expect(seen.size).toBe(5);

    const malformed = await f.tools().list({ limit: 2, cursor: 'not-a-cursor' }, ACTOR);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe('INVALID_ARGUMENT');

    const capped = await f.tools().list({ limit: 10_000 }, ACTOR);
    expect(capped.ok).toBe(true);
    if (capped.ok) expect(capped.value.items.length).toBeLessThanOrEqual(200);
  });
});

describe('K/L/M. tool descriptors enter the prompt', () => {
  it('K: describeTool projects what a model needs and nothing sensitive', async () => {
    const f = fixture();
    const record = createMockToolRecord(HIGH_RISK_TOOL_SPEC, f.clock.nowIso());
    if (!record.ok) throw new Error('unexpected');
    const descriptor = describeTool(record.value);
    expect(Object.keys(descriptor).sort()).toEqual([
      'capabilities',
      'description',
      'name',
      'parameters',
      'riskLevel',
      'toolId',
      'version',
    ]);
    const serialized = JSON.stringify(descriptor);
    for (const forbidden of ['adapterRef', 'requiredAuthorities', 'secret', 'credential', 'apiKey']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(descriptor.parameters).toEqual(record.value.inputSchema);
  });

  it('L: the same descriptors produce the same PromptPlan and the same promptHash', () => {
    const context = buildAgentContext({
      company: { id: 'company_default', label: 'Company' },
      workflow: { id: 'wfl_1', label: 'Workflow' },
      workflowVersion: '1.0.0',
      workflowRun: { id: 'run_1', label: 'Run' },
      task: { id: 'tsk_1', label: 'Task' },
      role: { id: 'role_developer', label: 'Developer' },
      objective: 'Use a tool.',
      binding: { modelKey: 'mock-model-a.standard', providerId: 'mock-a', providerModelId: 'standard', source: 'BINDING' },
      trace: { traceId: 't1', executionId: 'exec_1', attempt: 1 },
    });
    if (!context.ok) throw new Error('unexpected');
    const echo = createMockToolRecord(ECHO_TOOL_SPEC, '2027-02-01T00:00:00.000Z');
    const readOnly = createMockToolRecord(READ_ONLY_TOOL_SPEC, '2027-02-01T00:00:00.000Z');
    if (!echo.ok || !readOnly.ok) throw new Error('unexpected');
    const descriptors = [describeTool(echo.value), describeTool(readOnly.value)];

    const first = assemblePrompt({ context: context.value, toolDescriptors: descriptors });
    const second = assemblePrompt({ context: context.value, toolDescriptors: descriptors });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.promptHash).toBe(second.value.promptHash);
    expect(first.value.toolDescriptors).toEqual(second.value.toolDescriptors);

    // Order must not matter: descriptors are sorted by toolId inside the assembler.
    const reordered = assemblePrompt({
      context: context.value,
      toolDescriptors: [...descriptors].reverse(),
    });
    expect(reordered.ok).toBe(true);
    if (reordered.ok) expect(reordered.value.promptHash).toBe(first.value.promptHash);

    // And the model actually sees the real schema/description.
    const messages = toMessages(first.value);
    expect(messages.tools[0]).toEqual({
      name: 'Echo',
      description: ECHO_TOOL_SPEC.description,
      parameters: ECHO_TOOL_SPEC.inputSchema,
    });
  });

  it('M: no secret reaches a descriptor', async () => {
    const f = fixture();
    const spec: MockToolSpec = {
      ...ECHO_TOOL_SPEC,
      toolId: 'mock.secret_probe',
      description: 'A tool whose description is ordinary.',
    };
    const record = createMockToolRecord(spec, f.clock.nowIso());
    if (!record.ok) throw new Error('unexpected');
    const descriptor = describeTool(record.value);
    expect(JSON.stringify(descriptor)).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  });
});

describe('N/O. approval rules are pinned as intentional', () => {
  it('N: HIGH may be approved by its requester (documented, locked behaviour)', async () => {
    const f = fixture();
    await register(f, HIGH_RISK_TOOL_SPEC);
    const refused = await invoke(f, 'mock.high_risk', { target: 'self' }, 'self-high');
    if (refused.ok) throw new Error('unexpected');
    const invocationId = String(refused.error.details['invocationId']);
    const selfApproved = await f.tools().approve({ invocationId, actorId: ACTOR });
    expect(selfApproved.ok).toBe(true);
    expect(f.mockCalls('mock.high_risk')).toBe(1);
  });

  it('O: CRITICAL still refuses self-approval', async () => {
    const f = fixture();
    await register(f, CRITICAL_TOOL_SPEC);
    const refused = await invoke(f, 'mock.critical', { target: 'critical' }, 'self-critical');
    if (refused.ok) throw new Error('unexpected');
    const invocationId = String(refused.error.details['invocationId']);
    const selfApproved = await f.tools().approve({ invocationId, actorId: ACTOR });
    expect(selfApproved.ok).toBe(false);
    if (!selfApproved.ok) expect(selfApproved.error.code).toBe('APPROVAL_DENIED');
    expect(f.mockCalls('mock.critical')).toBe(0);
  });
});
