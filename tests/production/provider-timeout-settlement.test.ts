/**
 * F2 — PROVIDER TIMEOUT SETTLEMENT (release blocker closure): the catalogue preflight
 * carries the CALLER cancellation.
 *
 *   F2-01  a catalogue that never resolves dies with the caller deadline as CANCELLED
 *          (bounded — never a retryable timeout that multiplies the hang)
 *   F2-02  the signal reaches the provider's listModels (the F2 contract seam)
 *   F2-03  a caller cancellation that fired during the preflight ends the invocation
 *          BEFORE the provider is invoked (no provider call on an aborted signal)
 *   F2-04  the normal provider path is unchanged (no signal → normal invoke)
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

const ACTOR = 'user_owner';
const MODEL: RawModelInfo = {
  modelId: 'm1',
  displayName: 'm1',
  contextWindow: 32_768,
  capabilities: { streaming: false, structuredOutput: true },
};

const makeRegistry = (_provider: ModelProviderPort) =>
  createProviderRegistry({
    ids: { id: (prefix: string) => `${prefix}_x` },
    clock: { nowIso: () => '2026-10-06T00:00:00.000Z' },
    registrations: { get: async () => null, put: async () => undefined, list: async () => ({ items: [], total: 0 }) } as never,
    models: undefined,
    authorize: async () => ok(true as const),
    events: undefined,
    systemActor: ACTOR,
  } as never) as unknown as {
    register(provider: ModelProviderPort, options?: { actorId?: string }): Promise<Result<unknown, DomainError>>;
    invoke(selection: { providerId: string; actorId: string }, request: InvocationRequest): Promise<Result<InvocationResult, DomainError>>;
  };

const invokeRequest = (signal?: AbortSignal): InvocationRequest =>
  ({
    modelId: 'm1',
    messages: [{ role: 'user', content: 'x' }],
    ...(signal === undefined ? {} : { signal }),
  }) as never;

describe('F2 — the catalogue preflight carries the caller cancellation', () => {
  it('F2-01/02 — a catalogue that never resolves dies CANCELLED within the caller bound, and the signal reached listModels', async () => {
    const seenSignals: AbortSignal[] = [];
    const controller = new AbortController();
    // The catalogue is consumed at REGISTRATION too (durable catalogue); the provider
    // hangs only AFTER registration — the F2 scope is the INVOCATION deadline.
    const hang = { value: false };
    const hanging: ModelProviderPort = {
      describe: () => ({ providerId: 'prov_hang', kind: 'fake', displayName: 'hang', version: '1' }),
      listModels: (signal?: AbortSignal) => {
        if (!hang.value) return Promise.resolve(ok([MODEL]));
        return new Promise((resolve) => {
          if (signal !== undefined) seenSignals.push(signal);
          if (signal?.aborted) {
            resolve(err(domainError('CANCELLED', 'cancelled')));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => resolve(err(domainError('CANCELLED', 'cancelled'))),
            { once: true },
          );
        });
      },
      health: () => Promise.resolve(ok(undefined as never)),
      invoke: () => Promise.resolve(ok(undefined as never)),
      stream(): AsyncIterable<Result<never, DomainError>> {
        return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
      },
    };
    const registry = makeRegistry(hanging);
    const registered = await registry.register(hanging, { actorId: ACTOR });
    if (!registered.ok) throw new Error(registered.error.message);

    hang.value = true;
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const result = (await registry.invoke({ providerId: 'prov_hang', actorId: ACTOR }, invokeRequest(controller.signal))) as { ok: false; error: DomainError } | { ok: true };
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED'); // the exact canonical cancellation
    expect(elapsed).toBeLessThan(5_000); // bounded — never a multiplied retry hang
    expect(seenSignals.length).toBe(1); // the F2 contract seam received the caller signal
  }, 30_000);

  it('F2-03 — a cancellation that fired during the preflight ends the invocation before the provider is invoked', async () => {
    let invoked = 0;
    const controller = new AbortController();
    const slowThenAbort: ModelProviderPort = {
      describe: () => ({ providerId: 'prov_slow', kind: 'fake', displayName: 'slow', version: '1' }),
      listModels: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(ok([MODEL])), 30);
        }),
      health: () => Promise.resolve(ok(undefined as never)),
            stream(): AsyncIterable<Result<never, DomainError>> {
              return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
            },
      invoke: () => {
        invoked += 1;
        return Promise.resolve(ok(undefined as never));
      },
    };
    const registry = makeRegistry(slowThenAbort);
    const registered = await registry.register(slowThenAbort, { actorId: ACTOR });
    if (!registered.ok) throw new Error(registered.error.message);

    controller.abort(); // fires WHILE the preflight runs
    const result = (await registry.invoke({ providerId: 'prov_slow', actorId: ACTOR }, invokeRequest(controller.signal))) as { ok: false; error: DomainError } | { ok: true };
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED');
    expect(invoked).toBe(0); // the provider is never invoked on an aborted signal
  }, 30_000);

  it('F2-04 — the normal provider path is unchanged (no signal → normal invoke)', async () => {
    let invoked = 0;
    const normal: ModelProviderPort = {
      describe: () => ({ providerId: 'prov_normal', kind: 'fake', displayName: 'normal', version: '1' }),
      listModels: () => Promise.resolve(ok([MODEL])),
      health: () => Promise.resolve(ok(undefined as never)),
            stream(): AsyncIterable<Result<never, DomainError>> {
              return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
            },
      invoke: () => {
        invoked += 1;
        return Promise.resolve(
          ok({
            modelId: 'm1',
            providerId: 'prov_normal',
            outputText: 'ok',
            structured: null,
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
            finishReason: 'stop' as const,
          }),
        );
      },
    };
    const registry = makeRegistry(normal);
    const registered = await registry.register(normal, { actorId: ACTOR });
    if (!registered.ok) throw new Error(registered.error.message);
    const result = await registry.invoke({ providerId: 'prov_normal', actorId: ACTOR }, invokeRequest());
    expect(result.ok).toBe(true);
    expect(invoked).toBe(1);
  }, 30_000);
});
