/** Phase A only: no production Broker, model adapter, CoreServices or child process. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedExchange, captureHostFailures, requireUpstreamArrival } from './support/transport-plan-fixture.js';
import { safeError } from './support/e3-broker-evidence.js';

afterEach(() => { vi.useRealTimers(); });

describe('transport/plan-shape owned fixture boundaries', () => {
  it('keeps success unchanged and clears the successful exchange timer', async () => {
    vi.useFakeTimers();
    expect(await boundedExchange(Promise.resolve(200), 5000)).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('propagates the exact client error and clears the rejected exchange timer', async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    await expect(boundedExchange(Promise.reject(error), 5000)).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fails a pending exchange at its original bound without manufacturing a result', async () => {
    vi.useFakeTimers();
    const result = boundedExchange(new Promise<never>(() => undefined), 3000);
    const failed = expect(result).rejects.toThrow('exchange did not settle within 3000ms');
    await vi.advanceTimersByTimeAsync(3000); await failed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the late losing outcome consumed after the bound expires', async () => {
    vi.useFakeTimers(); let reject!: (error: Error) => void;
    const pending = new Promise<never>((_, failed) => { reject = failed; });
    const result = boundedExchange(pending, 20);
    const failed = expect(result).rejects.toThrow('20ms');
    await vi.advanceTimersByTimeAsync(20); await failed;
    reject(new Error('late original error')); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('F7 cannot proceed before its own upstream arrival', async () => {
    let received!: () => void; let passed = false;
    const result = requireUpstreamArrival(new Promise<void>(resolve => { received = resolve; }), new Promise<never>(() => undefined), 5000)
      .then(() => { passed = true; });
    await Promise.resolve(); expect(passed).toBe(false);
    received(); await result; expect(passed).toBe(true);
  });
  it('F7 preserves a connection failure before arrival rather than counting it as abort success', async () => {
    const error = Object.assign(new Error('failed before receive'), { code: 'ETIMEDOUT', errno: -4039, cause: new Error('original') });
    await expect(requireUpstreamArrival(new Promise<never>(() => undefined), Promise.resolve({ ok: false, error }), 5000)).rejects.toBe(error);
  });
  it('F7 fails when the client completes without an upstream receive event', async () => {
    await expect(requireUpstreamArrival(new Promise<never>(() => undefined), Promise.resolve({ ok: true, value: 200 }), 5000))
      .rejects.toThrow('UPSTREAM_REQUEST_NOT_OBSERVED');
  });
  it('F7 missing arrival is bounded and never skips the prerequisite', async () => {
    vi.useFakeTimers();
    const result = requireUpstreamArrival(new Promise<never>(() => undefined), new Promise<never>(() => undefined), 5000);
    const failed = expect(result).rejects.toThrow('5000ms');
    await vi.advanceTimersByTimeAsync(5000); await failed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('removes the exact host-survival listeners, including repeated attachment', () => {
    const exceptions = process.listeners('uncaughtException'); const rejections = process.listeners('unhandledRejection');
    const owner = captureHostFailures([]);
    try {
      owner.attach(); owner.attach();
      expect(process.listenerCount('uncaughtException')).toBe(exceptions.length + 1);
      expect(process.listenerCount('unhandledRejection')).toBe(rejections.length + 1);
    } finally { owner.detach(); }
    expect(process.listeners('uncaughtException')).toEqual(exceptions);
    expect(process.listeners('unhandledRejection')).toEqual(rejections);
  });
  it('retains nested network cause without credentials or response headers', () => {
    const error = Object.assign(new Error('failed Authorization: private-secret'), { code: 'ECONNRESET', syscall: 'read',
      cause: new AggregateError([Object.assign(new Error('connect'), { code: 'ETIMEDOUT', errno: -4039 })], 'failed'), headers: { cookie: 'private-cookie' } });
    const evidence = safeError(error);
    expect(evidence).toMatchObject({ code: 'ECONNRESET', syscall: 'read', cause: { errors: [{ code: 'ETIMEDOUT', errno: -4039 }] } });
    expect(JSON.stringify(evidence)).not.toContain('private-secret');
    expect(JSON.stringify(evidence)).not.toContain('private-cookie');
  });
});
