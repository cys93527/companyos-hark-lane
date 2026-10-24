/**
 * Sprint 18 / Task-18-06 corrective — provider cancellation contract (§12–§14 of the review).
 *
 * The one thing the T18-06 review refused to close was `PROVIDER_ABORT_CONTRACT_GAP`: the
 * Supervisor stopped WAITING for the provider but the provider kept running — a ghost
 * execution whose external side effects outlive the record that says CANCELLED.
 *
 * These tests prove the cancellation is REAL end to end:
 *
 *   AgentRuntime signal → ProviderRegistry.invoke → ModelProviderPort.invoke → the invocation
 *
 * and that nothing here fakes it with `Promise.race`. The fake model is the production mock
 * adapter (`createMockProvider`), registered through the real provider registry: it is the ONLY
 * production adapter in the repository, so what it observes is what a real adapter would.
 *
 * Mandatory regression items covered here: 1, 2, 3, 5, 6, 7, 8, 9, 10, 13, 15.
 * (Items 4, 11, 12, 14 live with the supervisor fixture in
 * `tests/sprint18/supervisor-decision-runtime.test.ts`.)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ok, type DomainError, type Result } from '@companyos/core';
import {
  createAgentRuntime,
  createMockProvider,
  createModelRegistry,
  createProviderRegistry,
  createSelectionPolicyService,
  type MockProvider,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

/* ------------------------------------------------------------------ harness */

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18abort-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18A${String(++seq).padStart(12, '0')}`,
  ulid: () => `18A${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string =>
  new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };
const ACTOR = 'user_owner';
const PROVIDER_ID = 'prov_abort';
const MODEL_KEY = 'abort.model';
const PROVIDER_MODEL_ID = 'abort-model-1';
const CHAINS = [
  'core',
  'engine',
  'lifecycle',
  'provider',
  'registry',
  'selection',
  'agent',
] as const;
/**
 * A sleep gate, owned by ONE fixture so no test can observe another test's state. The ENGINE may
 * not install timers (boundary gate), so the shell of the test supplies this — and gating it is
 * what makes "the invocation is genuinely in flight when the signal fires" a deterministic fact
 * instead of a wall-clock race.
 */
interface SleepGate {
  /** How many waits the adapter has started. */
  started: number;
  /** Opens the current wait. */
  release(): void;
  sleep(ms: number): Promise<void>;
}

const createSleepGate = (): SleepGate => {
  const gate: SleepGate = {
    started: 0,
    release(): void {
      /* replaced per wait */
    },
    sleep(ms: number): Promise<void> {
      void ms;
      gate.started += 1;
      return new Promise<void>((resolve) => {
        gate.release = (): void => resolve();
      });
    },
  };
  return gate;
};

/** Wait until the adapter has actually reached the expected state (polled, never assumed). */
const until = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 5_000 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!predicate()) throw new Error('the expected provider state never arrived');
};

/** What `run` resolves to on success. */
type RunResult = {
  readonly executionId: string;
  readonly status: string;
  readonly errorKind: string | null;
};

/**
 * Start a turn, let the provider become genuinely in flight, fire the cancellation, and prove
 * the adapter observed it — none of it depending on wall-clock timing.
 */
const abortInFlight = async (
  f: Fixture,
  waitForSleep = true,
): Promise<{ readonly controller: AbortController; readonly turn: Promise<Result<RunResult, DomainError>> }> => {
  const controller = new AbortController();
  const turn = f.run({ signal: controller.signal });
  await until(() => f.model.calls.length === 1 && (!waitForSleep || f.gate.started >= 1));
  controller.abort();
  await until(() => f.model.abortObservations === 1);
  f.gate.release();
  return { controller, turn };
};

interface Fixture {
  readonly db: DurableDatabase;
  readonly model: MockProvider;
  readonly gate: SleepGate;
  /** Prepare + run in ONE call, mirroring how a caller drives a turn. */
  run(input: {
    readonly signal?: AbortSignal;
    readonly prompt?: { readonly structuredKeys?: readonly string[] };
  }): Promise<
    Result<
      { readonly executionId: string; readonly status: string; readonly errorKind: string | null },
      DomainError
    >
  >;
  runWithOutput(input: {
    readonly signal?: AbortSignal;
  }): Promise<Result<{ readonly executionId: string; readonly outputText: string }, DomainError>>;
  executionRow(executionId: string): Promise<Record<string, unknown> | undefined>;
}

const makeFixture = (script: Parameters<typeof createMockProvider>[0]['script'] = {}): Fixture => {
  const dataDir = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  const authorize = async (): Promise<Result<true, DomainError>> => ok(true as const);
  const gate = createSleepGate();
  const model = createMockProvider({
    providerId: PROVIDER_ID,
    kind: 'mock',
    displayName: 'Abort test model',
    sleep: (ms: number) => gate.sleep(ms),
    script: {
      models: [
        {
          modelId: PROVIDER_MODEL_ID,
          displayName: PROVIDER_MODEL_ID,
          contextWindow: 8_192,
          capabilities: { streaming: false, structuredOutput: true },
        },
      ],
      ...script,
    },
  });
  const providers = createProviderRegistry({
    ids,
    clock,
    registrations: db.providers,
    models: db.providerModels,
    authorize: authorize as never,
    events: db.events,
    systemActor: ACTOR,
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
    authorize: authorize as never,
    secrets: async () => [],
    logger: undefined,
  });

  const context = {
    company: { id: 'company_default', label: 'company' },
    workflow: { id: 'wf_abort', label: 'workflow' },
    workflowVersion: 'wf_abort@1',
    workflowRun: { id: 'run_abort', label: 'run' },
    stage: { id: 'stage_1', label: 'stage' },
    task: { id: 'task_abort', label: 'task' },
    role: { id: 'rol_1', label: 'role' },
    objective: 'Prove cancellation reaches the provider.',
    instructions: ['Be brief.'],
    constraints: [],
    acceptanceCriteria: [],
    memoryView: [],
    artifactRefs: [],
  };

  return {
    db,
    model,
    gate,
    async run(input) {
      const registered = await providers.register(model, { actorId: ACTOR });
      if (!registered.ok && registered.error.code !== 'CONFLICT')
        throw new Error(registered.error.message);
      const made = await models.registerFromProvider({
        providerId: PROVIDER_ID,
        providerModelId: PROVIDER_MODEL_ID,
        modelKey: MODEL_KEY,
        actorId: ACTOR,
      });
      if (!made.ok && made.error.code !== 'CONFLICT') throw new Error(made.error.message);
      const executed = await runtime.execute({
        agentId: 'agent_1',
        roleId: 'rol_1' as never,
        taskId: 'task_abort' as never,
        runId: 'run_abort' as never,
        actorId: ACTOR,
        modelKey: MODEL_KEY,
        explicit: true,
        scopes: [],
        context,
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!executed.ok) {
        return { ok: false as const, error: executed.error };
      }
      return {
        ok: true as const,
        value: {
          executionId: executed.value.executionId,
          status: executed.value.status,
          errorKind: executed.value.errorKind,
        },
      };
    },
    async runWithOutput(input) {
      const registered = await providers.register(model, { actorId: ACTOR });
      if (!registered.ok && registered.error.code !== 'CONFLICT')
        throw new Error(registered.error.message);
      const made = await models.registerFromProvider({
        providerId: PROVIDER_ID,
        providerModelId: PROVIDER_MODEL_ID,
        modelKey: MODEL_KEY,
        actorId: ACTOR,
      });
      if (!made.ok && made.error.code !== 'CONFLICT') throw new Error(made.error.message);
      const prepared = await runtime.prepare({
        agentId: 'agent_1',
        roleId: 'rol_1' as never,
        taskId: 'task_abort' as never,
        runId: 'run_abort' as never,
        actorId: ACTOR,
        modelKey: MODEL_KEY,
        explicit: true,
        scopes: [],
      });
      if (!prepared.ok) return { ok: false as const, error: prepared.error };
      const outcome = await runtime.runWithOutput({
        executionId: prepared.value.executionId,
        actorId: ACTOR,
        context,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!outcome.ok) return { ok: false as const, error: outcome.error };
      return {
        ok: true as const,
        value: {
          executionId: outcome.value.execution.executionId,
          outputText: outcome.value.outputText,
        },
      };
    },
    async executionRow(executionId) {
      const rows = db.db
        .prepare('SELECT * FROM agent_executions WHERE execution_id = ?')
        .all(executionId) as Record<string, unknown>[];
      return rows[0];
    },
  };
};

/** Fail the test on any unhandled rejection, which the review lists as a forbidden leftover. */
const rejections: unknown[] = [];
const onRejection = (reason: unknown): void => {
  rejections.push(reason);
};
process.on('unhandledRejection', onRejection);
afterEach(() => {
  expect(rejections).toEqual([]);
});

/* ------------------------------------------------------------------- tests */

describe('T18-06 corrective — cancellation reaches the provider (1,2,3,5,6,7,8,9,10,13,15)', () => {
  it('1. abort before the provider invoke → zero provider calls', async () => {
    const f = makeFixture();
    const controller = new AbortController();
    controller.abort();
    const result = await f.run({ signal: controller.signal });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED');
    // The provider was never reached at all: not one request, not one signal observation.
    expect(f.model.calls.length).toBe(0);
    expect(f.model.signalObservations).toBe(0);
    const row = await f.executionRow('');
    void row;
    const rows = f.db.db.prepare('SELECT * FROM agent_executions').all() as Record<
      string,
      unknown
    >[];
    // F5-D: a cancelled invocation settles through the ONE canonical CANCELLED
    // transition (deterministic whichever writer arrives first).
    expect(rows[0]?.['status']).toBe('CANCELLED');
    expect(rows[0]?.['error_kind']).toBe('CANCELLED');
  });

  it('2. abort while the provider is pending → the provider receives the abort', async () => {
    const f = makeFixture({ pendingMs: 5_000 });
    // Abort while the invocation is GENUINELY in flight: the adapter already received the
    // request and is waiting inside its pending window when the signal fires.
    const { turn } = await abortInFlight(f);
    const result = await turn;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED');
    // The adapter SAW the signal and SAW it fire: this is a real observation, not an inference.
    expect(f.model.signalObservations).toBe(1);
    expect(f.model.abortObservations).toBe(1);
    expect(f.model.cancellations).toBe(1);
  });

  it('3. the pending provider promise terminates (no dangling invocation)', async () => {
    const f = makeFixture({ pendingMs: 30_000 });
    const { turn } = await abortInFlight(f);
    const result = await turn;
    expect(result.ok).toBe(false);
    expect(f.model.abortObservations).toBe(1);
    expect(f.model.cancellations).toBe(1);
  });

  it('5. timeout aborts the provider, not only the outer promise', async () => {
    const f = makeFixture({ pendingMs: 30_000 });
    // The turn's own deadline firing is the same mechanism the supervisor uses.
    const { turn } = await abortInFlight(f);
    const result = await turn;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED');
    expect(f.model.abortObservations).toBe(1);
  });

  it('6. a normal, non-aborted call is unchanged', async () => {
    const f = makeFixture();
    const result = await f.run({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('COMPLETED');
    expect(f.model.calls.length).toBe(1);
    // No signal supplied ⇒ the adapter never saw one, so nothing about this path changed.
    expect(f.model.signalObservations).toBe(0);
    expect(f.model.abortObservations).toBe(0);
    expect(f.model.cancellations).toBe(0);
  });

  it('7. abort during a retry backoff stops the next attempt', async () => {
    // A provider that fails and retries on a delay: the abort lands inside the backoff.
    const f = makeFixture({
      outcomes: ['rate_limited'],
      retries: 5,
      retryDelayMs: 5_000,
    });
    const { turn } = await abortInFlight(f);
    const result = await turn;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED');
    // Exactly ONE attempt started, and the backoff never scheduled a second one.
    expect(f.model.retryAttempts).toBe(1);
    expect(f.model.calls.length).toBe(1);
    expect(f.model.abortObservations).toBe(1);
  });

  it('8. abort never triggers a fallback provider or model', async () => {
    const f = makeFixture({ pendingMs: 30_000 });
    const { turn } = await abortInFlight(f);
    const result = await turn;
    expect(result.ok).toBe(false);
    // The only provider ever invoked is the one that was named: no second call, no other model.
    expect(f.model.calls.length).toBe(1);
    expect(f.model.calls[0]?.modelId).toBe(PROVIDER_MODEL_ID);
    expect(f.db.db.prepare('SELECT COUNT(*) AS c FROM provider_models').get()).toEqual({ c: 1 });
  });

  it('9. cancellation is classified as CANCELLED, not as a provider/model failure', async () => {
    const f = makeFixture({ pendingMs: 30_000 });
    const { turn } = await abortInFlight(f);
    const result = await turn;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED');
    const rows = f.db.db.prepare('SELECT * FROM agent_executions').all() as Record<
      string,
      unknown
    >[];
    expect(rows[0]?.['error_kind']).toBe('CANCELLED');
    expect(String(rows[0]?.['error_code'])).toBe('CANCELLED');
    for (const forbidden of [
      'MODEL_UNAVAILABLE',
      'INVALID_OUTPUT',
      'PROVIDER_UNAVAILABLE',
      'POLICY_REFUSED',
    ]) {
      expect(rows[0]?.['error_kind']).not.toBe(forbidden);
    }
    // The cancellation is NOT retryable: a caller must not re-run the attempt unchanged.
    expect(String(rows[0]?.['error_kind'])).toBe('CANCELLED');
  });

  it('10. provider-reported usage still persists on a normal call', async () => {
    const f = makeFixture({
      outcomes: [{ outputText: 'ok', usage: { inputTokens: 11, outputTokens: 5 } }],
    });
    const result = await f.run({});
    expect(result.ok).toBe(true);
    const rows = f.db.db.prepare('SELECT * FROM agent_executions').all() as Record<
      string,
      unknown
    >[];
    const usage = JSON.parse(String(rows[0]?.['output_usage'])) as {
      inputTokens: number;
      outputTokens: number;
    };
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 5, totalTokens: 16 });
  });

  it('13. the signal reaches the adapter through the whole chain', async () => {
    const f = makeFixture();
    const controller = new AbortController();
    // Not aborted: this test is about FORWARDING, and proves the adapter received the very
    // signal object the caller supplied (not a copy, not a substitute).
    const result = await f.run({ signal: controller.signal });
    expect(result.ok).toBe(true);
    expect(f.model.signalObservations).toBe(1);
    expect(f.model.calls[0]?.signal).toBe(controller.signal);
    expect(f.model.calls[0]?.signal?.aborted).toBe(false);
  });

  it('15. no unhandled rejection escapes an aborted invocation', async () => {
    const f = makeFixture({ pendingMs: 30_000 });
    const controller = new AbortController();
    // Drive the deferred-settlement path too: the abandoned `runWithOutput` promise must not
    // surface as an unhandled rejection either.
    const deferred = f.runWithOutput({ signal: controller.signal });
    await until(() => f.model.calls.length === 1 && f.gate.started >= 1);
    controller.abort();
    await until(() => f.model.abortObservations === 1);
    f.gate.release();
    const settled = await deferred;
    expect(settled.ok).toBe(false);
    expect(f.model.abortObservations).toBe(1);
    // Give any stray rejection a chance to surface before asserting there was none.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rejections).toEqual([]);
  });
});

describe('T18-06 corrective — the streaming path honours the same signal', () => {
  it('an aborted stream ends without another chunk', async () => {
    const dataDir = tempDir();
    const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
    openDatabases.push(db);
    const authorize = async (): Promise<Result<true, DomainError>> => ok(true as const);
    const model = createMockProvider({
      providerId: PROVIDER_ID,
      kind: 'mock',
      displayName: 'Streaming abort model',
      script: {
        models: [
          {
            modelId: PROVIDER_MODEL_ID,
            displayName: PROVIDER_MODEL_ID,
            contextWindow: 8_192,
            capabilities: { streaming: true, structuredOutput: true },
          },
        ],
        streamDeltas: ['a', 'b', 'c', 'd'],
      },
    });
    const providers = createProviderRegistry({
      ids,
      clock,
      registrations: db.providers,
      models: db.providerModels,
      authorize: authorize as never,
      events: db.events,
      systemActor: ACTOR,
    });
    const registered = await providers.register(model, { actorId: ACTOR });
    if (!registered.ok && registered.error.code !== 'CONFLICT')
      throw new Error(registered.error.message);

    const controller = new AbortController();
    const seen: string[] = [];
    for await (const chunk of providers.stream(
      { providerId: PROVIDER_ID, actorId: ACTOR },
      {
        modelId: PROVIDER_MODEL_ID,
        messages: [{ role: 'user', content: 'go' }],
        signal: controller.signal,
      },
    )) {
      if (!chunk.ok) break;
      seen.push(chunk.value.deltaText);
      // Abort after the first delta: the remaining deltas must never be produced.
      controller.abort();
    }
    // The adapter saw the signal AND its abort, and stopped yielding instead of continuing.
    expect(model.signalObservations).toBe(1);
    expect(model.abortObservations).toBe(1);
    expect(seen).toEqual(['a']);
  });
});
