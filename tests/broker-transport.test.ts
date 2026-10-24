/**
 * LIVE-SMOKE-FIX-01 — Embedded Model Broker transport + failure-containment tests.
 *
 * The live smoke crashed the CompanyOS host process at the work attempt's first kernel
 * model call: the loopback broker forwarded `node:http.request({protocol: 'https:'})`,
 * which throws ERR_INVALID_PROTOCOL synchronously inside the request 'end' handler —
 * an uncaught exception on the host. These tests mechanically pin the corrected
 * contract (all deterministic, no internet, production TLS verification untouched):
 *
 *   HTTP upstream           still passes end-to-end (method/path/headers/body/stream);
 *   HTTPS upstream          selects the real node:https transport (a TLS-only upstream
 *                           answers 200 — node:http against that port cannot);
 *   unsupported scheme      typed broker refusal BEFORE anything listens;
 *   connection failure      sanitized 502, host alive;
 *   synchronous transport throw   contained to a 502 exchange, host alive (the P1
 *                           regression, forced through a throwing https transport);
 *   mid-stream upstream failure   the exchange ends, never the host;
 *   upstream timeout        bounded, request destroyed, 504, no orphan socket;
 *   secret sentinel         never present in any failure body;
 *   process-level gate      zero uncaughtException / unhandledRejection across the suite.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import https from 'node:https';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Socket} from 'node:net';
import {observeLoopback} from './support/loopback-observation.js';
import {activeHandleSnapshot, identifyOwnedBrokerServer, ownRequests, safeError, trackOwnedServer} from './support/e3-broker-evidence.js';
import {assertObservationComplete, boundedExchange as bounded, captureHostFailures, requireUpstreamArrival} from './support/transport-plan-fixture.js';

type HttpsModule = typeof https;

// The transport-throw containment test replaces node:https.request with a function
// that throws synchronously ONCE — exactly the class of failure that used to kill
// the host. vi.hoisted gives the factory a mutable switch.
const throwSwitch = vi.hoisted(() => ({throwOnce: false}));
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<HttpsModule>();
  return {
    ...actual,
    request: (...args: Parameters<typeof actual.request>) => {
      if (throwSwitch.throwOnce) {
        throwSwitch.throwOnce = false;
        throw new TypeError('ERR_INVALID_PROTOCOL (forced test transport throw)');
      }
      return actual.request(...args);
    },
  };
});

import {startModelBroker} from '../apps/desktop/src/executor/embedded-dsh-runtime.js';

const CERT = readFileSync(fileURLToPath(new URL('./fixtures/broker-test-cert.pem', import.meta.url)), 'utf8');
const KEY = readFileSync(fileURLToPath(new URL('./fixtures/broker-test-key.pem', import.meta.url)), 'utf8');
const SENTINEL = 'sk-broker-t01';

let observation: ReturnType<typeof observeLoopback>;
let requests: ReturnType<typeof ownRequests>;
const timers = new Set<ReturnType<typeof setTimeout>>();
beforeEach(() => {
  observation = observeLoopback(expect.getState().currentTestName ?? 'BROKER_TRANSPORT_TEST_NOT_OBSERVED');
  observation.emit('fixture-start', {worker: process.env['VITEST_POOL_ID'] ?? 'NOT_OBSERVED'});
  requests = ownRequests(observation.emit);
});

/** The original SSE fixture, with actual arrival/close signals and owned cleanup. */
const startUpstream = (options: {readonly tls: boolean; readonly silent?: boolean; readonly killMidStream?: boolean}): Promise<{
  port: number;
  hits: {method: string; url: string; auth?: string; body?: string}[];
  stats: {socketsClosed: number};
  arrived: Promise<void>;
  socketClosed: Promise<void>;
  stop: () => Promise<void>;
}> => new Promise((resolve, reject) => {
  const hits: {method: string; url: string; auth?: string; body?: string}[] = [];
  const stats = {socketsClosed: 0};
  let received!: () => void; let closed!: () => void;
  const arrived = new Promise<void>(done => { received = done; });
  const socketClosed = new Promise<void>(done => { closed = done; });
  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      hits.push({method: req.method ?? '?', url: req.url ?? '?', auth: req.headers['authorization'], body});
      received();
      observation.emit('upstream-request-received', {method: req.method, localPort: req.socket.localPort, remotePort: req.socket.remotePort});
      if (options.silent === true) return;
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write(`data: ${JSON.stringify({object: 'chat.completion.chunk', choices: [{delta: {content: 'OK'}}]})}\n\n`);
      if (options.killMidStream === true) {
        const timer = setTimeout(() => { timers.delete(timer); res.socket?.destroy(); }, 40);
        timers.add(timer);
        return;
      }
      res.write('data: [DONE]\n\n'); res.end();
    });
  };
  const server = options.tls ? https.createServer({key: KEY, cert: CERT}, handle) : http.createServer(handle);
  const owner = trackOwnedServer(server, (event, fields) => observation.emit(event, {server: 'upstream', ...fields}));
  upstreams.push({stop: () => owner.close()}); // Ownership is established before listen can fail.
  server.on('connection', (socket: Socket) => {
    socket.once('close', () => { stats.socketsClosed += 1; closed(); });
  });
  if (options.tls) {
    server.on('secureConnection', (socket: Socket) => observation.emit('tls-server-secure-connection', {localPort: socket.localPort, remotePort: socket.remotePort}));
    server.on('tlsClientError', (error: Error) => observation.emit('tls-server-error', {error: safeError(error, [SENTINEL])}));
  }
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', reject);
    const address = server.address();
    if (address === null || typeof address !== 'object') { reject(new Error('UPSTREAM_BOUND_NO_PORT')); return; }
    observation.emit('upstream-listen-ready', {endpoint: `${options.tls ? 'https' : 'http'}://127.0.0.1:${address.port}`});
    resolve({port: address.port, hits, stats, arrived, socketClosed, stop: () => owner.close()});
  });
});

/** A pre-response transport error remains a rejected, immediately-owned outcome. */
const callBroker = (port: number, routeSecret: string, body = '{"probe":true}') => {
  let req: http.ClientRequest | undefined;
  let responseBody = ''; let responseError: string | null = null;
  const result = new Promise<number>((resolve, reject) => {
    req = http.request(
      {host: '127.0.0.1', port, path: `/c/${routeSecret}/v1/chat/completions`, method: 'POST', headers: {'content-type': 'application/json'}},
      res => {
        observation.emit('broker-response-headers', {status: res.statusCode});
        res.on('data', chunk => { responseBody += chunk; });
        res.once('end', () => resolve(res.statusCode ?? 0));
        res.once('aborted', () => observation.emit('broker-response-aborted', {status: res.statusCode}));
        res.once('error', error => {
          responseError = String(error);
          observation.emit('broker-response-error', {status: res.statusCode, error: safeError(error, [SENTINEL])});
          // The mid-stream case intentionally accepts a truncated HTTP response.
          if (res.statusCode !== undefined) resolve(res.statusCode); else reject(error);
        });
      },
    );
    req.once('error', reject);
  });
  const operation = requests.register(req, result);
  try { req?.end(body); } catch (error) { req?.destroy(error instanceof Error ? error : new Error('BROKER_REQUEST_WRITE_FAILED')); }
  return {outcome: operation.outcome, value: async () => ({status: await operation.value(), body: responseBody, error: responseError})};
};

// ---------------------------------------------------------------------------
// The host-survival hard gate: any uncaught exception or unhandled rejection
// observed during this suite fails it, whatever the individual assertions say.
// ---------------------------------------------------------------------------
const strayEvents: string[] = [];
const hostFailures = captureHostFailures(strayEvents);
beforeAll(() => { hostFailures.attach(); });
afterAll(() => {
  hostFailures.detach();
  expect(strayEvents, `host-survival gate: ${strayEvents.join(' | ')}`).toEqual([]);
});

const brokers: {close: () => Promise<void>}[] = [];
const upstreams: {stop: () => Promise<void>}[] = [];
afterEach(async () => {
  for (const timer of timers) clearTimeout(timer); timers.clear();
  const errors: unknown[] = [];
  try { await requests.close(); } catch (error) { errors.push(error); }
  while (brokers.length > 0) { try { await brokers.pop()!.close(); } catch (error) { errors.push(error); } }
  while (upstreams.length > 0) { try { await upstreams.pop()!.stop(); } catch (error) { errors.push(error); } }
  observation.dispose();
  try { assertObservationComplete(observation.directory); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Broker transport fixture cleanup failed');
});

const openBroker = async (upstreamBaseURL: string, options: {readonly upstreamTimeoutMs?: number} = {}) => {
  const before = activeHandleSnapshot();
  const broker = await startModelBroker({upstreamBaseURL, bearer: SENTINEL, ...options});
  expect(broker.ok).toBe(true);
  if (!broker.ok) throw new Error(broker.error.message);
  const fallback = {close: async () => { broker.value.close(); }};
  brokers.push(fallback);
  const server = identifyOwnedBrokerServer(broker.value.url, before);
  const owner = trackOwnedServer(server, (event, fields) => observation.emit(event, {server: 'broker', ...fields}));
  brokers.splice(brokers.indexOf(fallback), 1);
  brokers.push({close: () => owner.close(() => broker.value.close())});
  observation.emit('broker-listen-ready', {endpoint: new URL(broker.value.url).origin});
  return broker.value;
};

describe('LIVE-SMOKE-FIX-01 — broker transport selection', () => {
  it('HTTP upstream still proxies end-to-end (method, path, auth, body, SSE stream)', async () => {
    const upstream = await startUpstream({tls: false});
    const broker = await openBroker(`http://127.0.0.1:${String(upstream.port)}/v1`);
    const answer = await bounded(callBroker(portOf(broker.url), broker.routeSecret).value(), 5_000);
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('chat.completion.chunk');
    expect(answer.body).toContain('[DONE]');
    expect(upstream.hits).toHaveLength(1);
    expect(upstream.hits[0]!.method).toBe('POST');
    expect(upstream.hits[0]!.url).toBe('/v1/chat/completions');
    expect(upstream.hits[0]!.auth).toBe(`Bearer ${SENTINEL}`);
    expect(upstream.hits[0]!.body).toBe('{"probe":true}');
  });

  it('HTTPS upstream selects the REAL https transport (a TLS-only upstream answers 200; node:http against that port cannot)', async () => {
    const upstream = await startUpstream({tls: true});
    const broker = await openBroker(`https://127.0.0.1:${String(upstream.port)}/v1`);
    // Test-process trust configuration ONLY: the production broker call performs full
    // TLS verification against the test CA — rejectUnauthorized stays true.
    const savedAgent = https.globalAgent;
    https.globalAgent = new https.Agent({ca: CERT});
    try {
      const answer = await bounded(callBroker(portOf(broker.url), broker.routeSecret).value(), 5_000);
      expect(answer.status).toBe(200);
      expect(answer.body).toContain('[DONE]');
      expect(upstream.hits).toHaveLength(1);
      expect(upstream.hits[0]!.url).toBe('/v1/chat/completions');
      expect(upstream.hits[0]!.auth).toBe(`Bearer ${SENTINEL}`);
    } finally {
      https.globalAgent = savedAgent;
    }
  });

  it('an UNSUPPORTED scheme is a typed refusal before anything listens (ftp://)', async () => {
    const refused = await startModelBroker({upstreamBaseURL: 'ftp://127.0.0.1/v1', bearer: SENTINEL});
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected refusal');
    expect(refused.error.details['reason']).toBe('EXECUTOR_EMBEDDED_BROKER_UPSTREAM_SCHEME_UNSUPPORTED');
    expect(refused.error.details['scheme']).toBe('ftp:');
    expect(refused.error.message).not.toContain(SENTINEL);
  });
});

describe('LIVE-SMOKE-FIX-01 — broker failure containment (host process survives)', () => {
  it('a SYNCHRONOUS transport throw is contained to a 502 exchange (the live P1 regression)', async () => {
    const upstream = await startUpstream({tls: true});
    const broker = await openBroker(`https://127.0.0.1:${String(upstream.port)}/v1`);
    throwSwitch.throwOnce = true;
    const savedAgent = https.globalAgent;
    https.globalAgent = new https.Agent({ca: CERT});
    try {
      const answer = await bounded(callBroker(portOf(broker.url), broker.routeSecret).value(), 5_000);
      expect(answer.status).toBe(502);
      expect(answer.body).toBe('upstream unavailable');
      expect(answer.body).not.toContain(SENTINEL);
    } finally {
      https.globalAgent = savedAgent;
    }
  });

  it('a CONNECTION-REFUSED upstream answers a sanitized 502 (no raw error text, no secret)', async () => {
    const ghost = await startUpstream({tls: false});
    const deadPort = ghost.port;
    await ghost.stop();
    const broker = await openBroker(`http://127.0.0.1:${String(deadPort)}/v1`);
    const answer = await bounded(callBroker(portOf(broker.url), broker.routeSecret).value(), 5_000);
    expect(answer.status).toBe(502);
    expect(answer.body).toBe('upstream unavailable');
    expect(answer.body).not.toContain('ECONNREFUSED');
    expect(answer.body).not.toContain(SENTINEL);
  });

  it('a MID-STREAM upstream failure ends the exchange (truncated stream), never the host', async () => {
    const upstream = await startUpstream({tls: false, killMidStream: true});
    const broker = await openBroker(`http://127.0.0.1:${String(upstream.port)}/v1`);
    const answer = await bounded(callBroker(portOf(broker.url), broker.routeSecret).value(), 5_000);
    // The exchange settled (not hung); the kernel sees a cut-off stream or the sanitized 502.
    expect([200, 502]).toContain(answer.status);
    expect(answer.body).not.toContain(SENTINEL);
  });

  it('an upstream TIMEOUT is bounded: 504, sanitized, and the upstream socket is released (no orphan)', async () => {
    const upstream = await startUpstream({tls: false, silent: true});
    const broker = await openBroker(`http://127.0.0.1:${String(upstream.port)}/v1`, {upstreamTimeoutMs: 200});
    const answer = await bounded(callBroker(portOf(broker.url), broker.routeSecret).value(), 5_000);
    expect(answer.status).toBe(504);
    expect(answer.body).toBe('upstream timeout');
    expect(answer.body).not.toContain(SENTINEL);
    // The destroyed request releases its socket — the silent upstream sees the close.
    await bounded(upstream.socketClosed, 3_000);
    expect(upstream.stats.socketsClosed).toBeGreaterThanOrEqual(1);
  });

  it('a KERNEL-SIDE abort releases the upstream request (no orphaned forward)', async () => {
    const upstream = await startUpstream({tls: false, silent: true});
    const broker = await openBroker(`http://127.0.0.1:${String(upstream.port)}/v1`, {upstreamTimeoutMs: 30_000});
    // Start the exchange, then abort the client side mid-flight.
    const exchange = callBroker(portOf(broker.url), broker.routeSecret);
    await requireUpstreamArrival(upstream.arrived, exchange.outcome, 5_000);
    observation.emit('abort-prerequisite-confirmed');
    broker.close(); // tears down the loopback side the kernel talks to
    const outcome = await bounded(exchange.outcome, 5_000);
    // A transport error is accepted ONLY after the observed arrival and deliberate close.
    const answer = outcome.ok ? {status: outcome.value} : {status: 0};
    if (!outcome.ok) observation.emit('intentional-client-abort-error', {error: safeError(outcome.error, [SENTINEL])});
    expect([0, 502, 504]).toContain(answer.status);
    // The broker must have destroyed the in-flight upstream request on the kernel-side close.
    await bounded(upstream.socketClosed, 3_000);
    expect(upstream.stats.socketsClosed).toBeGreaterThanOrEqual(1);
  });
});

const portOf = (brokerUrl: string): number => Number(new URL(brokerUrl).port);
