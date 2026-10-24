/** Phase A: deterministic helper tests only; no production composition, Broker or DSH. */
import { createServer, request, type ClientRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compositionEvidence, ownRequests, safeError, trackOwnedServer, activeHandleSnapshot, identifyOwnedBrokerServer, waitOwnedCompletion } from './support/e3-broker-evidence.js';
import { observeLoopback } from './support/loopback-observation.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });
const rows = () => { const records: { event: string; fields: Record<string, unknown> }[] = []; return { records, emit: (event: string, fields: Record<string, unknown> = {}) => { records.push({ event, fields }); } }; };
const serve = async () => {
  const before = activeHandleSnapshot();
  const events = rows();
  const server = createServer((_request, response) => response.end('local'));
  const owner = trackOwnedServer(server, events.emit);
  cleanups.push(() => owner.close());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('NO_LOOPBACK_ADDRESS');
  return { server, owner, events, before, url: `http://127.0.0.1:${address.port}` };
};

describe('E3 composition error fidelity via existing database injection seam', () => {
  it('retains the original logger error message while redacting test secrets and URLs', () => {
    const events = rows(); const evidence = compositionEvidence(events.emit, ['test-secret']);
    evidence.logger.error('core services composition failed', { error: 'connection failed test-secret http://127.0.0.1/private', credentials: 'NEVER_LOG_THIS' });
    const result = evidence.failure().message;
    expect(result).toContain('connection failed'); expect(result).not.toContain('test-secret'); expect(result).not.toContain('/private'); expect(result).not.toContain('NEVER_LOG_THIS');
  });
  it('preserves errno, syscall and nested AggregateError causes without bodies or headers', () => {
    const error = Object.assign(new Error('failed'), { code: 'ETIMEDOUT', errno: -4039, syscall: 'connect', cause: new AggregateError([Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })], 'aggregate'), headers: { Authorization: 'NEVER_LOG' } });
    const recorded = safeError(error);
    expect(recorded).toMatchObject({ code: 'ETIMEDOUT', errno: -4039, syscall: 'connect', cause: { errors: [{ code: 'ECONNREFUSED' }] } });
    expect(JSON.stringify(recorded)).not.toContain('NEVER_LOG');
  });
  it('observes a direct-null prerequisite failure without changing the returned Result identity', () => {
    const events = rows(); const evidence = compositionEvidence(events.emit);
    const failure = { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'record rejected' } };
    const original = { toolRecords: { put: () => failure } };
    expect(evidence.database(original).toolRecords.put()).toBe(failure);
    expect(evidence.records).toContainEqual({ event: 'composition-store-return', phase: 'toolRecords.put', result: 'ERROR', error: { code: 'INVALID_ARGUMENT', message: 'record rejected' } });
  });
  it('keeps the receiver, arguments, synchronous values and thrown exception identity', () => {
    const events = rows(); const evidence = compositionEvidence(events.emit); const error = new Error('store failed');
    const roles = { value: 7, get(n: number) { return this.value + n; }, fail() { throw error; } };
    const db = evidence.database({ roles, db: { native: true } });
    expect(db.roles.get(3)).toBe(10); expect(db.db.native).toBe(true); expect(() => db.roles.fail()).toThrow(error);
    expect(evidence.records.at(-1)).toMatchObject({ event: 'composition-store-error', phase: 'roles.fail' });
  });
  it('preserves asynchronous rejection identity and stage evidence', async () => {
    const evidence = compositionEvidence(rows().emit); const error = Object.assign(new Error('bad store'), { code: 'SQLITE_BUSY' });
    const db = evidence.database({ events: { append: () => Promise.reject(error) } });
    await expect(db.events.append()).rejects.toBe(error);
    expect(evidence.records.at(-1)).toMatchObject({ phase: 'events.append', error: { code: 'SQLITE_BUSY' } });
  });
  it('an evidence sink failure does not replace the original composition error', () => {
    const evidence = compositionEvidence(() => { throw new Error('sink unavailable'); });
    evidence.logger.error('composition failed', { error: 'original store failure' });
    expect(evidence.writeFailures()).toBe(1);
    expect(evidence.failure().message).toContain('original store failure');
    expect(evidence.failure().message).toContain('evidence write failures: 1');
  });
  it('preserves asynchronous success and caps the in-error observation summary', async () => {
    const evidence = compositionEvidence(rows().emit); const success = { ok: true, value: 1 };
    const db = evidence.database({ roles: { get: () => Promise.resolve(success) } });
    expect(await db.roles.get()).toBe(success);
    for (let n = 0; n < 100; n++) evidence.record('observed-stage', { n });
    expect(evidence.records).toHaveLength(64);
  });
});

describe('owned Server close and passive observation', () => {
  it('observes real loopback close completion and only identifies the newly created server', async () => {
    const f = await serve();
    expect(identifyOwnedBrokerServer(f.url, f.before)).toBe(f.server);
    expect(() => identifyOwnedBrokerServer(f.url, activeHandleSnapshot())).toThrow('OWNERSHIP_NOT_CONFIRMED');
    await f.owner.close(); expect(f.server.listening).toBe(false);
    expect(f.events.records.some(row => row.event === 'owned-server-close-event')).toBe(true);
    expect(f.events.records.some(row => row.event === 'owned-server-close-complete')).toBe(true);
  });
  it('rejects a non-loopback identity without attempting an outbound request', () => {
    expect(() => identifyOwnedBrokerServer('http://example.invalid:1234', new Set())).toThrow('NOT_LOOPBACK');
  });
  it('reports a close timeout as failure when the stop callback does not stop its server', async () => {
    const f = await serve();
    vi.useFakeTimers();
    const result = f.owner.close(() => undefined, 50);
    const rejection = expect(result).rejects.toThrow('OWNED_SERVER_CLOSE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(50); await rejection;
    vi.useRealTimers(); await f.owner.close();
    expect(f.events.records.some(row => row.event === 'owned-server-close-timeout')).toBe(true);
  });
  it('writes and reads the existing validated observation channel and observes a real /models request', async () => {
    const observation = observeLoopback('Phase A local channel regression');
    const server = createServer((_request, response) => response.end('local'));
    observation.attach(server); const owner = trackOwnedServer(server, observation.emit);
    cleanups.push(async () => { try { await owner.close(); } finally { observation.dispose(); } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('ADDRESS');
    const response = await fetch(`http://127.0.0.1:${address.port}/models`); await response.text();
    await owner.close(); observation.dispose();
    const events = readFileSync(join(observation.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string });
    expect(events.some(row => row.event === 'channel-open')).toBe(true);
    expect(events.some(row => row.event === 'undici:request:create')).toBe(true);
    expect(events.some(row => row.event === 'server-request-received')).toBe(true);
    expect(events.some(row => row.event === 'owned-server-close-complete')).toBe(true);
    const complete = events.find(row => row.event === 'owned-server-close-complete');
    expect(complete).toMatchObject({ activeSockets: 0 });
  });
});

describe('immediate rejection consumption and error-preserving outcomes', () => {
  it('propagates successful status unchanged through outcome and value', async () => {
    const f = await serve(); const owner = ownRequests(f.events.emit); cleanups.push(() => owner.close());
    let req!: ClientRequest;
    const status = new Promise<number>((resolve, reject) => { req = request(f.url, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)); }); req.once('error', reject); });
    const result = owner.register(req, status); req.end();
    expect(await result.outcome).toEqual({ ok: true, value: 200 }); expect(await result.value()).toBe(200);
  });
  it.each(['ETIMEDOUT', 'ECONNREFUSED'])('consumes %s before later assertions, retaining the exact error rather than a success', async code => {
    const f = await serve(); const owner = ownRequests(f.events.emit); cleanups.push(() => owner.close());
    const req = request(f.url); req.on('error', () => undefined); cleanups.push(async () => { req.destroy(); });
    const error = Object.assign(new Error('connect failed'), { code, syscall: 'connect' });
    const unhandled: unknown[] = []; const listener = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      const result = owner.register(req, Promise.reject(error));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]); expect(await result.outcome).toEqual({ ok: false, error });
      await expect(result.value()).rejects.toBe(error);
    } finally { process.removeListener('unhandledRejection', listener); }
  });
  it('poll failure still permits bounded owned request cleanup without manufacturing success', async () => {
    const f = await serve(); const owner = ownRequests(f.events.emit); cleanups.push(() => owner.close());
    let reject!: (error: unknown) => void;
    const req = request(f.url); req.on('error', error => reject(error));
    const result = owner.register(req, new Promise<number>((_, failed) => { reject = failed; }));
    try { await expect.poll(() => 0, { timeout: 20, interval: 5 }).toBe(1); } catch { await owner.close(); }
    expect((await result.outcome).ok).toBe(false);
    await expect(result.value()).rejects.toThrow('FIXTURE_REQUEST_CLEANUP');
  });
  it('synchronous request construction errors remain failures with no fabricated handle', async () => {
    const owner = ownRequests(rows().emit); const error = new Error('HTTP request construction failed');
    const result = owner.register(undefined, Promise.reject(error));
    expect(await result.outcome).toEqual({ ok: false, error });
    await expect(result.value()).rejects.toBe(error); await owner.close();
  });
  it('cleanup waits for the actual owned ClientRequest close event', async () => {
    const f = await serve(); const owner = ownRequests(f.events.emit);
    let reject!: (error: unknown) => void;
    const req = request(f.url); req.on('error', error => reject(error));
    owner.register(req, new Promise<number>((_, failed) => { reject = failed; }));
    await owner.close();
    expect(f.events.records.at(-1)).toMatchObject({ event: 'client-requests-settled', fields: { closeObserved: true } });
    const closeIndex = f.events.records.findIndex(row => row.event === 'client-request-close');
    const settledIndex = f.events.records.findIndex(row => row.event === 'client-requests-settled');
    expect(closeIndex).toBeGreaterThanOrEqual(0); expect(closeIndex).toBeLessThan(settledIndex);
  });
  it('never calls a permanently pending operation successful after a cleanup timeout', async () => {
    const f = await serve(); const owner = ownRequests(f.events.emit);
    const req = request(f.url); req.on('error', () => undefined);
    owner.register(req, new Promise<number>(() => undefined));
    vi.useFakeTimers(); const result = owner.close(50); const assertion = expect(result).rejects.toThrow('FIXTURE_PENDING_REQUEST_TIMEOUT');
    await vi.advanceTimersByTimeAsync(50); await assertion; vi.useRealTimers();
    expect(f.events.records.some(row => row.event === 'client-requests-settled')).toBe(false);
  });
  it('the existing offline guard rejects unauthorized network targets before a request is sent', () => {
    expect(() => fetch('https://example.invalid/models')).toThrow('OFFLINE_TEST_EXECUTION_DENIED');
  });
});

describe('owned asynchronous settlement completion', () => {
  it('does not finish cleanup before its actual callback resolves', async () => {
    let finish!: () => void;
    const callback = new Promise<void>(resolve => { finish = resolve; });
    let done = false;
    const waiting = waitOwnedCompletion(callback).then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    finish(); await waiting; expect(done).toBe(true);
  });
  it('reports an unclosed callback as failure rather than success after a bounded wait', async () => {
    vi.useFakeTimers();
    const waiting = waitOwnedCompletion(new Promise<void>(() => undefined), 50);
    const assertion = expect(waiting).rejects.toThrow('FIXTURE_OWNED_CALLBACK_TIMEOUT');
    await vi.advanceTimersByTimeAsync(50); await assertion;
  });
});
