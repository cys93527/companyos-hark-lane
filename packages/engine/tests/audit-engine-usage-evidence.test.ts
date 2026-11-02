/**
 * AUDIT-E3 regression (engine area): typed usage evidence on failed model invocations.
 * 1. An adapter's own KNOWN usage on a failed call was dropped by registry normalization, so
 *    every failed call settled UNKNOWN (ADR-0032 then blocks the Goal).
 * 2. A failure raised before the adapter was ever invoked (permission, cancellation during
 *    preflight) provably sent nothing: it must carry KNOWN zero usage.
 * 3. A dispatched failure WITHOUT adapter evidence stays UNKNOWN (fail closed, by design).
 */
import { describe, expect, it } from 'vitest';
import {
  domainError,
  err,
  ok,
  type DomainError,
  type InvocationRequest,
  type InvocationResult,
  type ModelProviderPort,
  type RawModelInfo,
  type Result,
} from '@companyos/core';
import { createProviderRegistry } from '@companyos/engine';
import { NOT_DISPATCHED_USAGE } from '../src/providers/registry.js';
import { observedUsageOf } from '../src/runtime/agent-runtime.js';

const ACTOR = 'user_owner';
const MODEL: RawModelInfo = {
  modelId: 'm1',
  displayName: 'm1',
  contextWindow: 32_768,
  capabilities: { streaming: false, structuredOutput: true },
};

type Registry = {
  register(provider: ModelProviderPort, options?: { actorId?: string }): Promise<Result<unknown, DomainError>>;
  invoke(selection: { providerId: string; actorId: string }, request: InvocationRequest): Promise<Result<InvocationResult, DomainError>>;
};

const makeRegistry = (gate: { deny: boolean }): Registry =>
  createProviderRegistry({
    ids: { id: (prefix: string) => `${prefix}_x` },
    clock: { nowIso: () => new Date(Date.UTC(2026, 9, 6)).toISOString() },
    registrations: { get: async () => null, put: async () => undefined, list: async () => ({ items: [], total: 0 }) } as never,
    models: undefined,
    authorize: async (input: { actorId: string; authority: string }) =>
      gate.deny && input.authority === 'provider.invoke' ? err(domainError('PERMISSION_DENIED', 'not allowed')) : ok(true as const),
    events: undefined,
    systemActor: ACTOR,
  } as never) as unknown as Registry;

const providerWith = (invoke: ModelProviderPort['invoke'], counter: { n: number }): ModelProviderPort => ({
  describe: () => ({ providerId: 'prov_e3', kind: 'fake', displayName: 'e3', version: '1' }),
  listModels: () => Promise.resolve(ok([MODEL])),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke: (request) => { counter.n += 1; return invoke(request); },
  stream(): AsyncIterable<Result<never, DomainError>> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
  },
});

const request = (signal?: AbortSignal): InvocationRequest =>
  ({ modelId: 'm1', messages: [{ role: 'user', content: 'x' }], ...(signal === undefined ? {} : { signal }) }) as never;

const setup = async (invoke: ModelProviderPort['invoke'], gate = { deny: false }) => {
  const counter = { n: 0 };
  const provider = providerWith(invoke, counter);
  const registry = makeRegistry(gate);
  const registered = await registry.register(provider, { actorId: ACTOR });
  if (!registered.ok) throw new Error(registered.error.message);
  return { registry, counter, gate };
};

const failureOf = (r: Result<InvocationResult, DomainError>): DomainError => {
  if (r.ok) throw new Error('expected a failure');
  return r.error;
};

describe('AUDIT-E3 registry usage evidence', () => {
  it("passes the adapter's KNOWN usage of an answered-but-failed call through normalization", async () => {
    const f = await setup(async () =>
      err(domainError('AGENT_UNAVAILABLE', 'answered but unusable', {
        kind: 'invalid_request',
        usageStatus: 'KNOWN',
        observedUsage: { inputTokens: 12, outputTokens: 3 },
      })));
    const error = failureOf(await f.registry.invoke({ providerId: 'prov_e3', actorId: ACTOR }, request()));
    expect(f.counter.n).toBe(1);
    expect(error.details['usageStatus']).toBe('KNOWN');
    expect(observedUsageOf(error)).toEqual({ inputTokens: 12, outputTokens: 3, totalCost: null });
  });

  it('a dispatched failure without adapter evidence stays UNKNOWN (fail closed)', async () => {
    const f = await setup(async () => err(domainError('AGENT_UNAVAILABLE', 'upstream 503', { kind: 'unavailable' })));
    const error = failureOf(await f.registry.invoke({ providerId: 'prov_e3', actorId: ACTOR }, request()));
    expect(f.counter.n).toBe(1);
    expect(error.details['usageStatus']).toBeUndefined();
    expect(observedUsageOf(error)).toBeNull();
  });

  it('a thrown dispatched failure without evidence stays UNKNOWN', async () => {
    const f = await setup(async () => { throw new Error('socket reset'); });
    const error = failureOf(await f.registry.invoke({ providerId: 'prov_e3', actorId: ACTOR }, request()));
    expect(observedUsageOf(error)).toBeNull();
  });

  it('a permission refusal before dispatch is KNOWN zero (never sent)', async () => {
    const f = await setup(async () => ok(undefined as never), { deny: false });
    f.gate.deny = true;
    const error = failureOf(await f.registry.invoke({ providerId: 'prov_e3', actorId: ACTOR }, request()));
    expect(f.counter.n).toBe(0);
    expect(error.code).toBe('PERMISSION_DENIED');
    expect(error.details['dispatch']).toBe(NOT_DISPATCHED_USAGE['dispatch']);
    expect(observedUsageOf(error)).toEqual({ inputTokens: 0, outputTokens: 0, totalCost: null });
  });

  it('a cancellation before dispatch is KNOWN zero (never sent)', async () => {
    const f = await setup(async () => ok(undefined as never));
    const controller = new AbortController();
    controller.abort();
    const error = failureOf(await f.registry.invoke({ providerId: 'prov_e3', actorId: ACTOR }, request(controller.signal)));
    expect(f.counter.n).toBe(0);
    expect(error.code).toBe('CANCELLED');
    expect(observedUsageOf(error)).toEqual({ inputTokens: 0, outputTokens: 0, totalCost: null });
  });
});
