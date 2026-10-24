import { createServer, request, type ClientRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { startModelBroker, type ModelBrokerHandle } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';

const clients: ClientRequest[] = [];
const servers: Server[] = [];
const brokers: ModelBrokerHandle[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.destroy());
  brokers.splice(0).forEach((broker) => broker.close());
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});
const start = async () => {
  let arrivals = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      arrivals += 1;
      if (req.headers['x-fixture-fail'] === 'yes') req.socket.destroy();
      else { res.writeHead(200); res.write('held'); }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('fixture address');
  const result = await startModelBroker({ upstreamBaseURL: `http://127.0.0.1:${String(addr.port)}/v1`, bearer: '', upstreamTimeoutMs: 3000 });
  if (!result.ok) throw result.error;
  brokers.push(result.value);
  return { broker: result.value, arrivals: () => arrivals };
};
const call = (url: string, end: boolean, fail = false) => {
  let status: number | null = null;
  let ended = false;
  const client = request(`${url}/chat/completions`, { method: 'POST', headers: { 'x-fixture-fail': fail ? 'yes' : 'no' } }, (res) => {
    status = res.statusCode ?? null;
    res.resume();
    res.on('end', () => { ended = true; });
  });
  client.on('error', () => { ended = true; });
  clients.push(client);
  client.write('{');
  if (end) client.end('}');
  return { client, status: () => status, ended: () => ended };
};
describe('execution safety: real loopback broker competition', () => {
  it('reserves before incomplete bodies can race the four-slot limit', async () => {
    const fixture = await start();
    const held = Array.from({ length: 4 }, () => call(fixture.broker.url, false));
    // Wait for the server to receive all four chunked requests before the competitor.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const fifth = call(fixture.broker.url, true);
    await expect.poll(fifth.status).toBe(503);
    expect(fixture.arrivals()).toBe(0);
    held.forEach(({ client }) => client.end('}'));
    await expect.poll(fixture.arrivals).toBe(4);
  });
  it('error plus close releases exactly one slot, never another active exchange', async () => {
    const fixture = await start();
    Array.from({ length: 3 }, () => call(fixture.broker.url, true));
    await expect.poll(fixture.arrivals).toBe(3);
    const failed = call(fixture.broker.url, true, true);
    await expect.poll(failed.ended).toBe(true);
    expect(failed.status()).toBe(502);
    call(fixture.broker.url, true);
    await expect.poll(fixture.arrivals).toBe(5);
    const competitor = call(fixture.broker.url, true);
    await expect.poll(competitor.status).toBe(503);
    expect(fixture.arrivals()).toBe(5);
  });
  it('bounds incomplete-body occupancy and subsequently admits another request', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fixture address');
    const result = await startModelBroker({ upstreamBaseURL: `http://127.0.0.1:${String(address.port)}`, bearer: '', upstreamTimeoutMs: 100 });
    if (!result.ok) throw result.error;
    brokers.push(result.value);
    const slow = call(result.value.url, false);
    await expect.poll(slow.status).toBe(504);
    const next = call(result.value.url, true);
    await expect.poll(next.ended).toBe(true);
    expect(next.status()).toBe(200);
  });
});
