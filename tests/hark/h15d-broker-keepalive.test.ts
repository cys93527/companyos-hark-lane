/**
 * Hark lane H15d-fix2 — one keep-alive connection carries many kernel exchanges. The
 * broker used to add a socket 'close' listener per REQUEST, so hark-live-goal 40313767341
 * printed MaxListenersExceededWarning after 11 calls on one socket (a listener leak that
 * grows with every exchange of a long goal). The connection is now tracked once.
 */
import { Agent, createServer, request, type Server } from 'node:http';
import type { Socket, AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { startModelBroker, type ModelBrokerHandle } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';

const servers: Server[] = [];
const brokers: ModelBrokerHandle[] = [];
afterEach(async () => {
  brokers.splice(0).forEach((b) => b.close());
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const STREAM = 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\ndata: [DONE]\n\n';

describe('H15d broker keep-alive connection', () => {
  it('fifteen exchanges on ONE keep-alive socket add no per-exchange close listeners', async () => {
    const upstream = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(STREAM); }); });
    servers.push(upstream);
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const broker = await startModelBroker({
      upstreamBaseURL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      bearer: '',
      upstreamTimeoutMs: 5_000,
      admission: async () => ({ signal: new AbortController().signal, maxOutputTokens: 10, release: () => undefined, settle: async () => undefined }) as never,
    });
    if (!broker.ok) throw broker.error;
    brokers.push(broker.value);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const seen = new Set<Socket>();
    const warnings: string[] = [];
    const onWarning = (w: Error) => { if (w.name === 'MaxListenersExceededWarning') warnings.push(w.message); };
    process.on('warning', onWarning);
    try {
      for (let i = 0; i < 15; i += 1) {
        await new Promise<void>((resolve, reject) => {
          const req = request(`${broker.value.url}/chat/completions`, { method: 'POST', agent }, (res) => { res.resume(); res.once('end', () => resolve()); });
          req.once('socket', (s: Socket) => { seen.add(s); });
          req.once('error', reject);
          req.end(JSON.stringify({ model: 'm', max_tokens: 10, stream: true }));
        });
      }
      // The client side reused one connection, so the server side saw one socket too.
      expect(seen.size).toBe(1);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      agent.destroy();
      process.off('warning', onWarning);
    }
    expect(warnings).toEqual([]);
  });
});
