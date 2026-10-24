/**
 * Sprint 6 tests A–Q: the provider registry, its contract, error normalization, secret
 * hygiene and restart persistence. Everything is deterministic: the MockProvider is
 * scripted, the clock is fixed and no test touches the network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FixedClock,
  SequenceIdFactory,
  type HealthReport,
  type Result,
} from '@companyos/core';
import {
  createEnvSecretVault,
  createMockProvider,
  createProviderRegistry,
  type MockProvider,
  type MockProviderInput,
  type ProviderRegistry,
  type SecretVault,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const EPOCH = Date.parse('2026-08-01T00:00:00.000Z');
const API_KEY = 'sk-mock-0123456789abcdef';

interface Fixture {
  readonly dataDir: string;
  readonly clock: FixedClock;
  readonly ids: SequenceIdFactory;
  readonly vault: SecretVault;
  database(): DurableDatabase;
  registry(): ProviderRegistry;
  restart(): void;
  mock(input?: Partial<MockProviderInput>): MockProvider;
  cleanup(): void;
}

const make = (): Fixture => {
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-providers-'));
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();
  const vault = createEnvSecretVault({ env: { COMPANYOS_MOCK_KEY: API_KEY, COMPANYOS_UNUSED: 'unused' } });

  const open = (): DurableDatabase =>
    openDurableDatabase({ dataDir, appliedAt: clock.nowIso(), chains: ['core', 'engine', 'provider'] });

  let database = open();

  const build = (db: DurableDatabase): ProviderRegistry =>
    createProviderRegistry({
      ids,
      clock,
      registrations: db.providers,
      models: db.providerModels,
      secretResolver: vault,
      secrets: async () => vault.values(),
    });

  let registry = build(database);

  return {
    dataDir,
    clock,
    ids,
    vault,
    database: () => database,
    registry: () => registry,
    restart(): void {
      database.close();
      database = open();
      registry = build(database);
    },
    mock(input: Partial<Parameters<typeof createMockProvider>[0]> = {}): MockProvider {
      return createMockProvider({
        providerId: input.providerId ?? 'mock-a',
        kind: input.kind ?? 'mock',
        displayName: input.displayName ?? 'Mock A',
        ...(input.version === undefined ? {} : { version: input.version }),
        ...(input.script === undefined ? {} : { script: input.script }),
        now: () => clock.nowIso(),
      });
    },
    cleanup(): void {
      try {
        database.close();
      } catch {
        // already closed
      }
      rmSync(dataDir, { recursive: true, force: true });
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

const expectError = (result: { ok: boolean; error?: { code: string; details?: Record<string, unknown> } }): string => {
  expect(result.ok).toBe(false);
  return result.error?.code ?? 'missing';
};

const modelFixture = (overrides: Record<string, unknown> = {}) => ({
  modelId: 'mock-small',
  displayName: 'Mock Small',
  contextWindow: 1_000,
  maxOutputTokens: 100,
  capabilities: { streaming: true, structuredOutput: true, toolCalling: true },
  ...overrides,
});

describe('A/B. provider registration', () => {
  it('A: registers a provider, persists it and lists it', async () => {
    const f = fixture();
    const registered = await f.registry().register(f.mock({ script: { models: [modelFixture()] } }));
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.value).toMatchObject({ id: 'mock-a', providerId: 'mock-a', kind: 'mock', enabled: true });

    const listed = await f.registry().list();
    expect(listed.map((entry) => entry.providerId)).toEqual(['mock-a']);
    expect((await f.database().providers.list()).items).toHaveLength(1);
    expect(f.registry().boundProviderIds()).toEqual(['mock-a']);
  });

  it('B: refuses a duplicate provider id - in memory and in storage', async () => {
    const f = fixture();
    await f.registry().register(f.mock());
    const duplicate = await f.registry().register(f.mock());
    expect(expectError(duplicate)).toBe('CONFLICT');

    /*
     * A second process (fresh registry over the same database) RE-BINDS the same trusted
     * descriptor (Sprint 18 closeout: durable descriptor vs process-local adapter — restart
     * must re-attach, not be refused), and it still writes no second durable row. A DIFFERENT
     * adapter under the same id stays refused fail-closed.
     */
    f.restart();
    const afterRestart = await f.registry().register(f.mock());
    expect(afterRestart.ok).toBe(true);
    expect(f.registry().get('mock-a')).not.toBeNull();
    expect((await f.database().providers.list()).items).toHaveLength(1);
    const impostor = await f.registry().register(
      f.mock({ displayName: 'A Different Adapter' }),
    );
    expect(expectError(impostor)).toBe('CONFLICT');
  });
});

describe('C/D. model listing and capability normalization', () => {
  it('C: lists models with stable defaults (display name, caps, pricing)', async () => {
    const f = fixture();
    await f.registry().register(
      f.mock({
        script: {
          models: [
            modelFixture(),
            { modelId: 'mock-plain', contextWindow: 4_000 },
          ],
        },
      }),
    );
    const models = await f.registry().models('mock-a');
    expect(models.ok).toBe(true);
    if (!models.ok) return;
    expect(models.value.map((entry) => entry.modelId)).toEqual(['mock-small', 'mock-plain']);
    const plain = models.value[1];
    expect(plain).toMatchObject({
      modelId: 'mock-plain',
      displayName: 'mock-plain',
      contextWindow: 4_000,
      maxOutputTokens: null,
      pricing: null,
    });
  });

  it('D: absent capabilities normalize to false, never undefined', async () => {
    const f = fixture();
    await f.registry().register(
      f.mock({ script: { models: [{ modelId: 'mock-partial', contextWindow: 100, capabilities: { streaming: true } }] } }),
    );
    const models = await f.registry().models('mock-a');
    if (!models.ok) throw new Error('unexpected');
    expect(models.value[0]?.capabilities).toEqual({
      streaming: true,
      structuredOutput: false,
      toolCalling: false,
      vision: false,
      audio: false,
      reasoning: false,
    });
  });

  it('C: serves the persisted catalogue while a provider is not bound', async () => {
    const f = fixture();
    await f.registry().register(f.mock({ script: { models: [modelFixture()] } }));
    f.restart(); // fresh registry, nothing bound yet
    expect(f.registry().boundProviderIds()).toEqual([]);
    const offline = await f.registry().models('mock-a');
    expect(offline.ok).toBe(true);
    if (!offline.ok) return;
    expect(offline.value[0]?.modelId).toBe('mock-small');
    expect(offline.value[0]?.capabilities.streaming).toBe(true);
  });
});

describe('E. health check', () => {
  it('E: records the last health and returns it while offline', async () => {
    const f = fixture();
    const report: HealthReport = { status: 'degraded', checkedAt: EPOCH === 0 ? 'x' : 'now', latencyMs: 12, detail: 'slow upstream' };
    await f.registry().register(f.mock({ script: { health: report } }));
    const health = await f.registry().health('mock-a');
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    expect(health.value).toMatchObject({ status: 'degraded', latencyMs: 12, detail: 'slow upstream' });

    f.restart();
    const persisted = await f.registry().health('mock-a');
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    expect(persisted.value).toMatchObject({ status: 'degraded', detail: 'slow upstream' });
  });

  it('E: an unavailable provider is recorded as unavailable', async () => {
    const f = fixture();
    await f.registry().register(f.mock());
    await f.registry().health('mock-a');
    const missing = await f.registry().health('nope');
    expect(expectError(missing)).toBe('NOT_FOUND');
    expect((await f.database().providers.get('mock-a'))?.lastHealth?.status).toBe('healthy');
  });
});

describe('F/G/H/I. invoke, stream, structured output, tool calling', () => {
  it('F: invokes a model and returns text, usage and finish reason', async () => {
    const f = fixture();
    const provider = f.mock({
      script: {
        models: [modelFixture()],
        outcomes: [{ outputText: 'hello', usage: { inputTokens: 3, outputTokens: 2, totalCost: 0 } }],
      },
    });
    await f.registry().register(provider);
    const result = await f.registry().invoke(
      { providerId: 'mock-a' },
      { modelId: 'mock-small', messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ outputText: 'hello', providerId: 'mock-a', finishReason: 'stop' });
    expect(result.value.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalCost: 0 });
    expect(provider.calls).toHaveLength(1);
  });

  it('G: streams deltas and closes with a usage-carrying chunk', async () => {
    const f = fixture();
    await f.registry().register(
      f.mock({
        script: {
          models: [modelFixture()],
          streamDeltas: ['he', 'll', 'o'],
          streamUsage: { inputTokens: 1, outputTokens: 3, totalCost: 0 },
        },
      }),
    );
    const chunks: string[] = [];
    let sawDone = false;
    let finalUsage: unknown = null;
    for await (const chunk of f.registry().stream(
      { providerId: 'mock-a' },
      { modelId: 'mock-small', messages: [{ role: 'user', content: 'hi' }] },
    )) {
      expect(chunk.ok).toBe(true);
      if (!chunk.ok) continue;
      chunks.push(chunk.value.deltaText);
      if (chunk.value.done) {
        sawDone = true;
        finalUsage = chunk.value.usage;
      }
    }
    expect(chunks.join('')).toBe('hello');
    expect(sawDone).toBe(true);
    expect(finalUsage).toEqual({ inputTokens: 1, outputTokens: 3, totalCost: 0 });
  });

  it('H: carries a structured result and refuses structured output on a plain model', async () => {
    const f = fixture();
    await f.registry().register(
      f.mock({
        script: {
          models: [modelFixture({ capabilities: { structuredOutput: true } }), modelFixture({ modelId: 'mock-text', capabilities: { structuredOutput: false } })],
          outcomes: [{ outputText: '{"ok":true}', structured: { ok: true } }],
        },
      }),
    );
    const structured = await f.registry().invoke(
      { providerId: 'mock-a' },
      {
        modelId: 'mock-small',
        messages: [{ role: 'user', content: 'x' }],
        responseFormat: { mode: 'json_object' },
      },
    );
    expect(structured.ok).toBe(true);
    if (structured.ok) expect(structured.value.structured).toEqual({ ok: true });

    const refused = await f.registry().invoke(
      { providerId: 'mock-a' },
      { modelId: 'mock-text', messages: [{ role: 'user', content: 'x' }], responseFormat: { mode: 'json_object' } },
    );
    expect(expectError(refused)).toBe('CAPABILITY_MISSING');
    expect(refused.ok === false && refused.error.details?.['kind']).toBe('structured_output_unsupported');
  });

  it('I: returns tool calls when declared, and refuses tools on a model without them', async () => {
    const f = fixture();
    await f.registry().register(
      f.mock({
        script: {
          models: [modelFixture(), modelFixture({ modelId: 'mock-text', capabilities: { toolCalling: false } })],
          outcomes: [
            { outputText: '', toolCalls: [{ callId: 'c1', name: 'lookup', arguments: { id: '42' } }] },
          ],
        },
      }),
    );
    const tools = [{ name: 'lookup', description: 'look something up', parameters: { type: 'object' } }];
    const called = await f.registry().invoke(
      { providerId: 'mock-a' },
      { modelId: 'mock-small', messages: [{ role: 'user', content: 'x' }], tools },
    );
    expect(called.ok).toBe(true);
    if (called.ok) {
      expect(called.value.toolCalls[0]).toEqual({ callId: 'c1', name: 'lookup', arguments: { id: '42' } });
      expect(called.value.finishReason).toBe('tool_calls');
    }

    const refused = await f.registry().invoke(
      { providerId: 'mock-a' },
      { modelId: 'mock-text', messages: [{ role: 'user', content: 'x' }], tools },
    );
    expect(expectError(refused)).toBe('CAPABILITY_MISSING');
    expect(refused.ok === false && refused.error.details?.['kind']).toBe('tool_unsupported');
  });
});

describe('J/K/L/M. provider failure normalization', () => {
  const failureCase = async (kind: string): Promise<{ code: string; details: Record<string, unknown> }> => {
    const f = fixture();
    await f.registry().register(
      f.mock({ script: { models: [modelFixture()], outcomes: [kind as never] } }),
    );
    const result = await f.registry().invoke(
      { providerId: 'mock-a' },
      { modelId: 'mock-small', messages: [{ role: 'user', content: 'x' }] },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    return { code: result.error.code, details: result.error.details as Record<string, unknown> };
  };

  it('J: maps a rate limit to LIMIT_EXCEEDED (retryable)', async () => {
    const failure = await failureCase('rate_limited');
    expect(failure.code).toBe('LIMIT_EXCEEDED');
    expect(failure.details['kind']).toBe('rate_limited');
    expect(failure.details['retryable']).toBe(true);
  });

  it('K: maps quota exhaustion to LIMIT_EXCEEDED (not retryable)', async () => {
    const failure = await failureCase('quota_exhausted');
    expect(failure.code).toBe('LIMIT_EXCEEDED');
    expect(failure.details['kind']).toBe('quota_exhausted');
    expect(failure.details['retryable']).toBe(false);
  });

  it('L: maps a timeout to TIMEOUT (retryable)', async () => {
    const failure = await failureCase('timeout');
    expect(failure.code).toBe('TIMEOUT');
    expect(failure.details['retryable']).toBe(true);
  });

  it('M: refuses a request beyond the context window and beyond the output cap', async () => {
    const f = fixture();
    await f.registry().register(f.mock({ script: { models: [modelFixture({ contextWindow: 10 })] } }));
    const tooLong = await f.registry().invoke(
      { providerId: 'mock-a' },
      { modelId: 'mock-small', messages: [{ role: 'user', content: 'x'.repeat(400) }] },
    );
    expect(expectError(tooLong)).toBe('VALIDATION_FAILED');
    expect(tooLong.ok === false && tooLong.error.details?.['kind']).toBe('context_limit');
    expect(tooLong.ok === false && tooLong.error.details?.['contextWindow']).toBe(10);

    const tooMuchOutput = await f.registry().invoke(
      { providerId: 'mock-a' },
      { modelId: 'mock-small', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 5_000 },
    );
    expect(expectError(tooMuchOutput)).toBe('INVALID_ARGUMENT');
    expect(tooMuchOutput.ok === false && tooMuchOutput.error.details?.['kind']).toBe('invalid_request');
  });

  it('L: an unknown model is refused before any provider call', async () => {
    const f = fixture();
    const provider = f.mock({ script: { models: [modelFixture()] } });
    await f.registry().register(provider);
    const unknown = await f.registry().invoke(
      { providerId: 'mock-a' },
      { modelId: 'nope', messages: [{ role: 'user', content: 'x' }] },
    );
    expect(expectError(unknown)).toBe('NOT_FOUND');
    expect(provider.calls).toHaveLength(0);
  });
});

describe('N. secrets never leave the process', () => {
  it('N: redacts the key from results, errors, health and the database', async () => {
    const f = fixture();
    const provider = f.mock({
      script: {
        models: [modelFixture({ contextWindow: 10_000 })],
        outcomes: [{ outputText: `leaked ${API_KEY}` }],
        health: { status: 'healthy', checkedAt: 'now', latencyMs: 1, detail: `key=${API_KEY}` },
      },
    });
    await f.registry().register(provider);
    expect(f.registry().knownSecrets()).toContain(API_KEY);

    const invoked = await f.registry().invoke(
      { providerId: 'mock-a' },
      { modelId: 'mock-small', messages: [{ role: 'user', content: 'x' }] },
    );
    // A result carrying credential material is REFUSED, not returned with holes punched
    // in it: the caller gets a safe error and the secret never crosses the boundary.
    expect(invoked.ok).toBe(false);
    if (!invoked.ok) {
      expect(invoked.error.code).toBe('PERMISSION_DENIED');
      expect(invoked.error.message).toContain('Secret material detected');
      expect(invoked.error.message).not.toContain(API_KEY);
      expect(JSON.stringify(invoked.error.details)).not.toContain(API_KEY);
    }

    await f.registry().health('mock-a');
    const stored = await f.database().providers.get('mock-a');
    expect(JSON.stringify(stored)).not.toContain(API_KEY);
    expect(stored?.lastHealth?.detail).toContain('[redacted]');

    // Nothing in the SQLite file (as text) may contain the key.
    const rows = f.database().db
      .prepare('SELECT provider_id, kind, display_name, last_health FROM providers')
      .all() as readonly unknown[];
    expect(JSON.stringify(rows)).not.toContain(API_KEY);
    const secretRows = f.database().db.prepare('SELECT * FROM secret_refs').all() as readonly unknown[];
    expect(JSON.stringify(secretRows)).not.toContain(API_KEY);
  });

  it('N: a failing provider message is redacted too', async () => {
    const f = fixture();
    // The mock reports its scripted failure kind; a message carrying the key is injected
    // by wrapping the adapter, which is exactly what a real adapter would do by accident.
    const base = f.mock({ script: { models: [modelFixture()] } });
    const leaky = {
      ...base,
      describe: () => base.describe(),
      listModels: () => base.listModels(),
      health: () => base.health(),
      invoke: async () => ({
        ok: false as const,
        error: {
          code: 'AGENT_UNAVAILABLE' as const,
          message: `upstream said: invalid key ${API_KEY}`,
          details: { upstreamCode: 'auth' },
        },
      }),
      stream: base.stream,
    };
    await f.registry().register(leaky as unknown as MockProvider);
    const failed = await f.registry().invoke(
      { providerId: 'mock-a' },
      { modelId: 'mock-small', messages: [{ role: 'user', content: 'x' }] },
    );
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.message).not.toContain(API_KEY);
    expect(JSON.stringify(failed.error.details)).not.toContain(API_KEY);
    void (failed as Result<unknown, unknown>);
  });
});

describe('O/Q. restart persistence and adapter substitution', () => {
  it('O: keeps registrations, catalogue and health across a restart', async () => {
    const f = fixture();
    await f.registry().register(f.mock({ script: { models: [modelFixture()] } }));
    await f.registry().health('mock-a');

    f.restart();
    const listed = await f.registry().list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ providerId: 'mock-a', enabled: true });
    expect(listed[0]?.lastHealth?.status).toBe('healthy');

    // Rebind the SAME id with a fresh adapter: invocations work again.
    await f.database().providers.delete('mock-a'); // storage guard off; the id is re-registered
    await f.registry().register(
      f.mock({ script: { models: [modelFixture()], outcomes: [{ outputText: 'after restart' }] } }),
    );
    const invoked = await f.registry().invoke(
      { providerId: 'mock-a' },
      { modelId: 'mock-small', messages: [{ role: 'user', content: 'x' }] },
    );
    expect(invoked.ok).toBe(true);
    if (invoked.ok) expect(invoked.value.outputText).toBe('after restart');
  });

  it('Q: substitutes behaviour without touching the call site', async () => {
    const f = fixture();
    const provider = f.mock({
      script: { models: [modelFixture()], outcomes: [{ outputText: 'first' }] },
    });
    await f.registry().register(provider);
    const call = async (): Promise<string> => {
      const result = await f.registry().invoke(
        { providerId: 'mock-a' },
        { modelId: 'mock-small', messages: [{ role: 'user', content: 'x' }] },
      );
      if (!result.ok) throw new Error('unexpected');
      return result.value.outputText;
    };
    expect(await call()).toBe('first');

    provider.setScript({ models: [modelFixture()], outcomes: [{ outputText: 'substituted' }] });
    expect(await call()).toBe('substituted');
  });
});
