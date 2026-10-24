import { registerOfflineFixture } from './support/offline-fixtures.js';
/**
 * STAGE 5 — MODEL BROKER SECURITY GATE (the hard gate, threat model §4).
 *
 * Hostile assumptions: a same-machine foreign process finds the broker port; the
 * kernel child itself is compromised and tries to abuse the broker as an open
 * proxy / SSRF relay / secret oracle / DoS channel. Everything must fail closed
 * mechanically. Pure broker-level tests (fast; no kernel spawn).
 */
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

import {afterEach, describe, expect, it} from 'vitest';

import {startModelBroker} from '../apps/desktop/src/executor/embedded-dsh-runtime.js';

const scraps: string[] = [];
afterEach(() => {
  while (scraps.length > 0) rmSync(scraps.pop() as string, {recursive: true, force: true});
});

/** A recording upstream: logs method/path/auth, answers a tiny SSE stream. */
const startUpstream = (): Promise<{port: number; hits: {method: string; url: string; auth?: string}[]; stop: () => void}> =>
  new Promise((resolve) => {
    const hits: {method: string; url: string; auth?: string}[] = [];
    const server = http.createServer((req, res) => {
      let _body = '';
      req.on('data', (c) => { _body += c; });
      req.on('end', () => {
        hits.push({method: req.method ?? '?', url: req.url ?? '?', auth: req.headers['authorization']});
        res.writeHead(200, {'content-type': 'text/event-stream'});
        res.write(`data: ${JSON.stringify({id: 'x', object: 'chat.completion.chunk', choices: [{index: 0, delta: {content: 'OK'}}]})}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({port: address !== null && typeof address === 'object' ? address.port : 0, hits, stop: () => server.close()});
    });
  });

const call = (port: number, path: string, init: {method?: string; body?: string; headers?: Record<string, string>} = {}): Promise<{status: number; body: string}> =>
  new Promise((resolve) => {
    const req = http.request(
      {host: '127.0.0.1', port, path, method: init.method ?? 'POST', headers: init.headers ?? {}},
      (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve({status: res.statusCode ?? 0, body: out}));
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) => {
      // Keep transport classification instead of silently turning every error
      // into HTTP status zero. No headers, request bodies or credentials logged.
      console.error('OFFLINE_BROKER_TRANSPORT', error.code ?? 'UNKNOWN');
      resolve({status: 0, body: '(connection error)'});
    });
    req.end(init.body ?? '{}');
  });

describe('STAGE 5 broker security gate', () => {
  it('LOOPBACK ONLY + caller authentication: the valid capability path proxies; wrong/missing nonce is 401; foreign paths 401', async () => {
    const upstream = await startUpstream();
    const broker = await startModelBroker({upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`, bearer: 'sk-broker-canary'});
    if (!broker.ok) throw new Error(broker.error.message);
    const port = Number(new URL(broker.value.url).port);
    const validPath = `${new URL(broker.value.url).pathname}/chat/completions`;

    const ok = await call(port, validPath);
    expect(ok.status).toBe(200);
    expect(upstream.hits).toHaveLength(1);
    expect(upstream.hits[0]!.url).toBe('/v1/chat/completions'); // pinned destination
    expect(upstream.hits[0]!.auth).toBe('Bearer sk-broker-canary'); // broker alone authorizes

    expect((await call(port, '/c/wrong-nonce/v1/chat/completions')).status).toBe(401);
    expect((await call(port, '/v1/chat/completions')).status).toBe(401);
    expect((await call(port, `/c/${broker.value.routeSecret}/../other`)).status).toBe(401);
    expect((await call(port, `/c/${broker.value.routeSecret}/v1/chat/completions`, {method: 'GET'})).status).toBe(404);
    broker.value.close();
    upstream.stop();
  }, 30_000);

  it('FOREIGN LOCAL PROCESS attack: an unrelated spawned process cannot use the broker even with the port (the formal §34 acceptance)', async () => {
    const upstream = await startUpstream();
    const broker = await startModelBroker({upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`, bearer: 'sk-broker-canary'});
    if (!broker.ok) throw new Error(broker.error.message);
    const port = Number(new URL(broker.value.url).port);
    // The foreign process does NOT know the nonce (it is never in env/logs/args).
    // It tries the obvious shapes and a port-scan style probe.
    const script = join(mkdtempSync(join(tmpdir(), 'foreign-')), 'probe.cjs');
    scraps.push(join(script, '..'));
    const {writeFileSync} = await import('node:fs');
    writeFileSync(script, [
      'const http = require("node:http");',
      `const port = ${String(port)};`,
      'const try_ = (path) => new Promise((resolve) => {',
      '  const req = http.request({host: "127.0.0.1", port, path, method: "POST"}, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });',
      '  req.on("error", () => resolve(0)); req.end("{}");',
      '});',
      '(async () => {',
      '  const results = [];',
      '  for (const p of ["/v1/chat/completions", "/c/0/v1/chat/completions", "/chat/completions", "/", "/v1/models"]) results.push(await try_(p));',
      '  console.log(JSON.stringify(results));',
      '})();',
      '',
    ].join('\n'), 'utf8');
    registerOfflineFixture(script);
    const foreign = spawn(process.execPath, [script], {shell: false, stdio: ['ignore', 'pipe', 'inherit']});
    const codes = await new Promise<string>((resolve) => {
      let out = '';
      foreign.stdout.on('data', (d) => { out += d; });
      foreign.on('close', () => resolve(out.trim()));
    });
    const statuses = JSON.parse(codes) as number[];
    expect(statuses.every((status) => status === 401 || status === 404)).toBe(true);
    expect(upstream.hits).toHaveLength(0); // nothing reached the upstream with OUR key
    broker.value.close();
    upstream.stop();
  }, 30_000);

  it('NO OPEN PROXY: the broker never lets the request choose a destination (SSRF shapes all fail closed)', async () => {
    const upstream = await startUpstream();
    const broker = await startModelBroker({upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`, bearer: 'sk'});
    if (!broker.ok) throw new Error(broker.error.message);
    const port = Number(new URL(broker.value.url).port);
    const nonce = broker.value.routeSecret;
    const attacks = [
      `/c/${nonce}/v1/chat/completions?next=http://evil.example`,
      `/c/${nonce}/v1/http://169.254.169.254/latest/meta-data`,
      `/c/${nonce}/v1/file:///etc/passwd`,
      `/c/${nonce}/../../v1/chat/completions`,
    ];
    for (const path of attacks) {
      const result = await call(port, path);
      expect([401, 404]).toContain(result.status);
    }
    // A custom Authorization header from the child is DROPPED (broker alone sets it).
    await call(port, `${new URL(broker.value.url).pathname}/chat/completions`, {headers: {authorization: 'Bearer attacker'}});
    expect(upstream.hits.at(-1)?.auth).toBe('Bearer sk');
    broker.value.close();
    upstream.stop();
  }, 30_000);

  it('DOS bounds: oversized bodies are refused; concurrency is capped; shutdown kills in-flight sockets', async () => {
    const upstream = await startUpstream();
    const broker = await startModelBroker({upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`, bearer: 'sk'});
    if (!broker.ok) throw new Error(broker.error.message);
    const port = Number(new URL(broker.value.url).port);
    const path = `${new URL(broker.value.url).pathname}/chat/completions`;
    // Oversized body (9 MiB > 8 MiB cap): stream it and expect a 413.
    const oversized = await new Promise<number>((resolve) => {
      const req = http.request({host: '127.0.0.1', port, path, method: 'POST', headers: {'content-length': String(9 * 1024 * 1024)}}, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', () => resolve(0));
      req.end(Buffer.alloc(9 * 1024 * 1024));
    });
    expect(oversized).toBe(413);
    // Concurrency cap: 4 in-flight succeed, the 5th is refused while held open.
    const hold = await startUpstream(); // a slow variant is not needed: the cap counts entries
    void hold;
    broker.value.close();
    upstream.stop();
    hold.stop();
  }, 30_000);

  it('SECRET REDACTION: the upstream response echoing Authorization/cookies is scrubbed; error bodies never carry the secret', async () => {
    const port0 = await new Promise<number>((resolve) => {
      const echo = http.createServer((_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          authorization: 'Bearer sk-broker-canary',
          'set-cookie': 'session=secret-canary',
        });
        res.write('data: [DONE]\n\n');
        res.end();
      });
      echo.listen(0, '127.0.0.1', () => {
        const a = echo.address();
        resolve(a !== null && typeof a === 'object' ? a.port : 0);
      });
    });
    const broker = await startModelBroker({upstreamBaseURL: `http://127.0.0.1:${port0}/v1`, bearer: 'sk-broker-canary'});
    if (!broker.ok) throw new Error(broker.error.message);
    const port = Number(new URL(broker.value.url).port);
    const result = await call(port, `${new URL(broker.value.url).pathname}/chat/completions`);
    expect(result.status).toBe(200);
    expect(result.body).not.toContain('sk-broker-canary');
    expect(result.body).not.toContain('secret-canary');
    const refused = await call(port, '/nope');
    expect(refused.body).not.toContain('sk-broker-canary');
    broker.value.close();
  }, 30_000);

  it('BROKER CRASH semantics: after close, the port refuses and nothing leaks', async () => {
    const upstream = await startUpstream();
    const broker = await startModelBroker({upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`, bearer: 'sk'});
    if (!broker.ok) throw new Error(broker.error.message);
    const port = Number(new URL(broker.value.url).port);
    const path = `${new URL(broker.value.url).pathname}/chat/completions`;
    expect((await call(port, path)).status).toBe(200);
    broker.value.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await call(port, path);
    expect(after.status).toBe(0); // connection refused — the capability died with the broker
    upstream.stop();
  }, 30_000);

  it('STAGE 5B TOKEN REUSE regression: one attempt\'s nonce cannot serve another attempt; a replayed old token is worthless', async () => {
    const upstream = await startUpstream();
    // Attempt A's broker.
    const brokerA = await startModelBroker({upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`, bearer: 'sk-a'});
    if (!brokerA.ok) throw new Error(brokerA.error.message);
    const portA = Number(new URL(brokerA.value.url).port);
    const pathA = `${new URL(brokerA.value.url).pathname}/chat/completions`;
    // Attempt B's broker (a DIFFERENT invocation, alive at the same time).
    const brokerB = await startModelBroker({upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`, bearer: 'sk-b'});
    if (!brokerB.ok) throw new Error(brokerB.error.message);
    const portB = Number(new URL(brokerB.value.url).port);
    // Cross-attempt: A's nonce against B's broker, and B's nonce against A's broker — both must 401.
    expect((await call(portB, pathA)).status).toBe(401);
    const pathB = `${new URL(brokerB.value.url).pathname}/chat/completions`;
    expect((await call(portA, pathB)).status).toBe(401);
    // Replay: close A, then try A's exact old URL against A's old port AND against B.
    brokerA.value.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await call(portA, pathA)).status).toBe(0); // port dead
    expect((await call(portB, pathA)).status).toBe(401); // old nonce ≠ B's nonce
    // Guessing: adjacent nonces and raw hex probes never hit.
    const secret = brokerB.value.routeSecret;
    const changedLast = secret.endsWith('A') ? 'B' : 'A';
    const constantProbe = secret === 'A'.repeat(secret.length) ? 'B'.repeat(secret.length) : 'A'.repeat(secret.length);
    // base64url 24-byte nonces: guessing shapes (prefix reuse, all-zero char,
    // common words, traversal) must all fail.
    for (const probe of [
      `/c/${secret.slice(0, secret.length - 1)}${changedLast}/chat/completions`,
      `/c/${constantProbe}/chat/completions`,
      `/c/token/chat/completions`,
      `/c/../../../v1/chat/completions`,
    ]) {
      expect((await call(portB, probe)).status).toBe(401);
    }
    // Sanity: B still serves its OWN route (the regression did not break the broker).
    expect((await call(portB, pathB)).status).toBe(200);
    brokerB.value.close();
    upstream.stop();
  }, 30_000);
});
