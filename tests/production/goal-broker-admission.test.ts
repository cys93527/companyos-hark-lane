import { createServer, request, type ClientRequest } from 'node:http';
import { observeLoopback } from '../support/loopback-observation.js';
import { activeHandleSnapshot, identifyOwnedBrokerServer, ownRequests, trackOwnedServer, waitOwnedCompletion, safeError } from '../support/e3-broker-evidence.js';
import { rmSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionSafetyCoordinator } from '../../apps/desktop/src/execution-safety-coordinator.js';
import { startModelBroker, type ModelBrokerHandle } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';
import { COMPANY, composeF5, createdDirs, openDatabases } from './helpers/f5-fixture.js';

const cleanups: (() => Promise<void>)[] = []; const brokers: ModelBrokerHandle[] = []; const releases: (() => void)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  // Request settlement, broker close, upstream close, then observer detach.
  for (const close of cleanups.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } }
  releases.splice(0).forEach(release => release());
  // Fallback for a failure between broker creation and ownership registration.
  brokers.splice(0).forEach(broker => broker.close());
  if (errors.length) {
    // Retain databases/directories if transport shutdown is uncertain.
    throw new AggregateError(errors, 'Broker fixture cleanup failed');
  }
  while (openDatabases.length) openDatabases.pop()?.close(); while (createdDirs.length) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});
type UpstreamReply = string | null | { readonly body: Buffer; readonly headers: Record<string, string> };
let seenAcceptEncoding: (string | undefined)[] = [];
const start = async (response: UpstreamReply, maxCalls = 2, durationMs = 120000, reconciliationFails = false) => {
  const observation = observeLoopback(expect.getState().currentTestName ?? 'BROKER_TEST_ID_NOT_OBSERVED');
  observation.emit('fixture-start', { worker: process.env['VITEST_POOL_ID'] ?? 'NOT_OBSERVED' });
  cleanups.push(async () => observation.dispose());
  const f = await composeF5();
  const created = await f.core.controlPlane!.handle({ operation: 'goal.create', payload: { companyId: COMPANY, commandId: 'broker-offline-fixture', objective: 'local transport only' } }); if (!created.ok) throw created.error;
  const runId = (created.value as { runId: string }).runId;
  const config = { policyId: 'OFFLINE_BROKER_ONLY', maxCalls, maxTokens: 1000, maxCostMicros: 1000, durationMs, boundOf: ({ modelKey }: { modelKey: string }) => ({ modelKey, inputTokens: 100, outputTokens: 10, costMicros: 50, evidenceRef: 'OFFLINE_FIXED_OUTPUT_NOT_TARIFF', validUntilMs: Date.now() + 120000 }), costOf: () => { if (reconciliationFails) throw new Error('offline billing evidence unavailable'); return 2; } };
  const safety = createExecutionSafetyCoordinator(f.core.database, config, Date.now); await safety.initialize(runId);
  let arrivals = 0;
  const server = createServer((req, res) => { seenAcceptEncoding.push(req.headers['accept-encoding']); req.resume(); req.on('end', () => { arrivals++; if (response === null) return; if (typeof response === 'string') { res.end(response); return; } res.writeHead(200, response.headers); res.end(response.body); }); });
  observation.attach(server);
  const upstreamOwner = trackOwnedServer(server, observation.emit);
  cleanups.push(() => upstreamOwner.close());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); const address = server.address(); if (address === null || typeof address === 'string') throw new Error('loopback address');
  const admission = await safety.prepareExecutor({ runId, attemptId: 'offline-executor', fallback: { providerId: 'offline', modelId: 'fixture-model', maxTokens: 10 } }); releases.push(admission.release);
  const admissions: Promise<unknown>[] = [];
  const leaseCloses: Promise<void>[] = [];
  const observedAdmission: typeof admission.admitBody = bytes => {
    const result = admission.admitBody(bytes).then(lease => {
      let closed!: () => void;
      leaseCloses.push(new Promise<void>(resolve => { closed = resolve; }));
      observation.emit('broker-admitted', { runId });
      return { ...lease,
        settle: (usage: Parameters<typeof lease.settle>[0]) => {
          observation.emit('broker-settlement-start', { runId, usage: usage === null ? 'UNKNOWN' : 'PROVIDED' });
          const settled = lease.settle(usage);
          void settled.then(() => observation.emit('broker-settlement-complete', { runId }),
            error => observation.emit('broker-settlement-error', { runId, error: safeError(error) }));
          return settled; // Original settlement value/error semantics unchanged.
        },
        release: () => { lease.release(); closed(); observation.emit('broker-lease-released', { runId }); },
      };
    });
    admissions.push(result.then(() => undefined, error => observation.emit('broker-admission-error', { runId, error: safeError(error) })));
    return result; // Production Broker still receives actual admission rejection.
  };
  cleanups.push(async () => {
    await waitOwnedCompletion(Promise.all(admissions).then(() => Promise.all(leaseCloses)));
    observation.emit('broker-owned-callbacks-complete', { runId, admissions: admissions.length, leases: leaseCloses.length });
  });
  const beforeBroker = activeHandleSnapshot();
  const broker = await startModelBroker({ upstreamBaseURL: `http://127.0.0.1:${address.port}`, bearer: '', admission: observedAdmission, upstreamTimeoutMs: 1000 }); if (!broker.ok) throw broker.error; brokers.push(broker.value);
  const brokerServer = identifyOwnedBrokerServer(broker.value.url, beforeBroker);
  const brokerOwner = trackOwnedServer(brokerServer, (event, fields) => observation.emit(event, { server: 'broker', ...fields }));
  observation.emit('broker-listen-observed', { endpoint: new URL(broker.value.url).origin });
  brokers.splice(brokers.indexOf(broker.value), 1);
  cleanups.push(() => brokerOwner.close(() => broker.value.close()));
  const owned = ownRequests(observation.emit);
  cleanups.push(() => owned.close());
  const send = (body: unknown = { model: 'fixture-model', max_tokens: 10 }) => {
    let req: ClientRequest | undefined;
    const result = new Promise<number>((resolve, reject) => {
      req = request(`${broker.value.url}/chat/completions`, { method: 'POST' }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode ?? 0));
        res.once('error', reject);
        res.once('aborted', () => reject(new Error('BROKER_RESPONSE_ABORTED')));
      });
      req.once('error', reject);
    });
    const operation = owned.register(req, result);
    try { req?.end(JSON.stringify(body)); } catch (error) { req?.destroy(error instanceof Error ? error : new Error('BROKER_REQUEST_WRITE_FAILED')); }
    return operation;
  };
  return { runId, safety, arrivals: () => arrivals, send };
};
const known = JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
describe('ADR-A/B real loopback nested broker + canonical SQLite (no paid provider)', () => {
  it('a failed billing reconciliation persists UNKNOWN rather than refunding usage or leaving an open reservation', async () => { const f = await start(known, 2, 120000, true); expect(await f.send().value()).toBe(200); await expect.poll(async () => (await f.safety.budget.read(f.runId)).reservations[0]?.status).toBe('UNKNOWN'); expect(await f.send().value()).toBe(403); expect(f.arrivals()).toBe(1); });
  it('reserves before HTTP, settles actual usage, and caps later physical calls', async () => { const f = await start(known, 1); expect(await f.send().value()).toBe(200); await expect.poll(async () => (await f.safety.budget.read(f.runId)).reservations[0]?.status).toBe('KNOWN'); expect((await f.safety.budget.read(f.runId)).reservations[0]?.usage).toEqual({ tokens: 5, costMicros: 2 }); expect(await f.send().value()).toBe(403); expect(f.arrivals()).toBe(1); });
  it('missing usage remains UNKNOWN and blocks a second nested call', async () => { const f = await start('{"choices":[]}'); expect(await f.send().value()).toBe(200); await expect.poll(async () => (await f.safety.budget.read(f.runId)).reservations[0]?.status).toBe('UNKNOWN'); expect(await f.send().value()).toBe(403); expect(f.arrivals()).toBe(1); });
  it('rejects a kernel model switch or unbounded output before upstream HTTP', async () => { const f = await start(known); expect(await f.send({ model: 'other', max_tokens: 10 }).value()).toBe(403); expect(await f.send({ model: 'fixture-model' }).value()).toBe(403); expect(await f.send({ model: 'fixture-model', max_tokens: 11 }).value()).toBe(403); expect(f.arrivals()).toBe(0); expect((await f.safety.budget.read(f.runId)).reservations).toHaveLength(0); });
  it('durable cancel aborts local transport without claiming remote cancellation', async () => { const f = await start(null); const pending = f.send(); await expect.poll(f.arrivals).toBe(1); await f.safety.requestCancel(f.runId); expect(await pending.value()).toBe(403); await expect.poll(async () => (await f.safety.budget.read(f.runId)).reservations[0]?.status).toBe('UNKNOWN'); expect((await f.safety.budget.read(f.runId)).cancellation).not.toBeNull(); expect(await f.send().value()).toBe(403); });
  it('a persistent Goal deadline aborts an in-flight local broker exchange', async () => { const f = await start(null, 2, 300); const pending = f.send(); await expect.poll(f.arrivals).toBe(1); expect(await pending.value()).toBe(403); await expect(f.safety.budget.check(f.runId)).rejects.toMatchObject({ details: { reason: 'GOAL_DEADLINE_EXCEEDED' } }); });
  it('conflicting streamed usage is UNKNOWN, not whichever usage arrived last', async () => { const f = await start('data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n'); expect(await f.send().value()).toBe(200); await expect.poll(async () => (await f.safety.budget.read(f.runId)).reservations[0]?.status).toBe('UNKNOWN'); });
  // H15c (hark-live-goal 40266877047 / 40291557860): DeepSeek opens a waiting stream with SSE keep-alive comments and sends usage:null on content chunks before a final usage-only chunk.
  // H15c-fix9 (hark-live-goal 40296992054): DeepSeek compresses the stream for a client that offers gzip; the broker must meter the DECODED body.
  const deepseekStream = ': keep-alive\n\ndata: {"choices":[{"index":0,"delta":{"content":"hi"}}],"usage":null}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
  it('a gzip-encoded DeepSeek stream settles its real usage KNOWN', async () => { const f = await start({ body: gzipSync(deepseekStream), headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' } }, 1); expect(await f.send().value()).toBe(200); await expect.poll(async () => (await f.safety.budget.read(f.runId)).reservations[0]?.status).toBe('KNOWN'); expect((await f.safety.budget.read(f.runId)).reservations[0]?.usage).toEqual({ tokens: 5, costMicros: 2 }); });
  it('a brotli-encoded stream settles KNOWN too', async () => { const f = await start({ body: brotliCompressSync(deepseekStream), headers: { 'content-type': 'text/event-stream', 'content-encoding': 'br' } }, 1); expect(await f.send().value()).toBe(200); await expect.poll(async () => (await f.safety.budget.read(f.runId)).reservations[0]?.status).toBe('KNOWN'); });
  it('an undecodable coding stays UNKNOWN', async () => { const f = await start({ body: Buffer.from('not-zstd'), headers: { 'content-type': 'text/event-stream', 'content-encoding': 'zstd' } }, 1); expect(await f.send().value()).toBe(200); await expect.poll(async () => (await f.safety.budget.read(f.runId)).reservations[0]?.status).toBe('UNKNOWN'); });
  it('forwards only decodable codings upstream', async () => { seenAcceptEncoding = []; const f = await start(known, 1); expect(await f.send().value()).toBe(200); expect(seenAcceptEncoding[0]).toBe('identity'); });
  it('a DeepSeek stream led by keep-alive comments settles its real usage KNOWN', async () => { const f = await start(': keep-alive\n\n: keep-alive\n\ndata: {"choices":[{"index":0,"delta":{"content":"hi"}}],"usage":null}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n', 1); expect(await f.send().value()).toBe(200); await expect.poll(async () => (await f.safety.budget.read(f.runId)).reservations[0]?.status).toBe('KNOWN'); expect((await f.safety.budget.read(f.runId)).reservations[0]?.usage).toEqual({ tokens: 5, costMicros: 2 }); });
});
