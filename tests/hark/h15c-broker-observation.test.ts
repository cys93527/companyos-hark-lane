/**
 * Hark lane H15c — the loopback model broker records ONE evidence observation per
 * exchange, so a budget reservation left UNKNOWN is explainable from durable evidence
 * (hark-live-goal 40266877047 left one unexplained). The DeepSeek streaming shape
 * (usage:null on every chunk, statistics on the last content chunk) settles KNOWN.
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { startModelBroker, type ModelBrokerExchangeObservation, type ModelBrokerHandle } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';

const servers: Server[] = [];
const brokers: ModelBrokerHandle[] = [];
afterEach(async () => {
  brokers.splice(0).forEach((b) => b.close());
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const DEEPSEEK_STREAM = [
  'data: {"id":"x","choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":null}],"usage":null}',
  'data: {"id":"x","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}],"usage":null}',
  'data: {"id":"x","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"completion_tokens":9,"prompt_tokens":17,"total_tokens":26,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":17}}',
  'data: [DONE]',
  '',
].join('\n\n');

const run = async (body: string, status = 200) => {
  const upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(status, { 'content-type': 'text/event-stream' }); res.end(body); });
  });
  servers.push(upstream);
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const settled: unknown[] = [];
  const observations: ModelBrokerExchangeObservation[] = [];
  const broker = await startModelBroker({
    upstreamBaseURL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    bearer: '',
    upstreamTimeoutMs: 5_000,
    admission: async () => ({
      signal: new AbortController().signal,
      maxOutputTokens: 10,
      release: () => undefined,
      settle: async (usage: unknown) => { settled.push(usage); },
    }) as never,
    observe: (o) => observations.push(o),
  });
  if (!broker.ok) throw broker.error;
  brokers.push(broker.value);
  const code = await new Promise<number>((resolve, reject) => {
    const req = request(`${broker.value.url}/chat/completions`, { method: 'POST' }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode ?? 0)); });
    req.once('error', reject);
    req.end(JSON.stringify({ model: 'm', max_tokens: 10, stream: true }));
  });
  await expect.poll(() => observations.length).toBe(1);
  return { code, settled, observation: observations[0]! };
};

describe('H15c broker exchange observation', () => {
  it('DeepSeek stream shape (usage null until the last chunk) settles the observed usage', async () => {
    const r = await run(DEEPSEEK_STREAM);
    expect(r.code).toBe(200);
    expect(r.settled).toEqual([{ inputTokens: 17, outputTokens: 9, totalCost: null }]);
    expect(r.observation).toMatchObject({ sequence: 1, endedBy: 'upstream-end', upstreamStatus: 200, usageDisposition: 'observed', usage: { inputTokens: 17, outputTokens: 9 } });
    expect(r.observation.requestBytes).toBeGreaterThan(0);
    expect(r.observation.responseBytes).toBe(Buffer.byteLength(DEEPSEEK_STREAM));
  });

  it('a stream without usage is observed as absent (the reason an UNKNOWN reservation carries)', async () => {
    const r = await run('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    expect(r.settled).toEqual([null]);
    expect(r.observation).toMatchObject({ endedBy: 'upstream-end', usageDisposition: 'absent', usage: null });
  });

  it('an upstream HTTP error is observed as http-error with its status', async () => {
    const r = await run('{"error":"nope"}', 401);
    expect(r.code).toBe(401);
    expect(r.observation).toMatchObject({ upstreamStatus: 401, usageDisposition: 'http-error', usage: null });
  });
});

import { routeWireCompat, routeWireCompatYamlLine } from '../../apps/desktop/src/models/route-wire-compat.js';

describe('H15c route wire compat (judged from the real upstream, never the loopback broker URL)', () => {
  it('DeepSeek upstream caps output with max_tokens and replays reasoning_content', () => {
    expect(routeWireCompat('https://api.deepseek.com')).toEqual({ maxTokensField: 'max_tokens', supportsStore: false, supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true });
    expect(routeWireCompatYamlLine('https://api.deepseek.com/v1')).toBe('compat: {"maxTokensField":"max_tokens","supportsStore":false,"supportsDeveloperRole":false,"requiresReasoningContentOnAssistantMessages":true}');
  });
  it('unknown or loopback upstreams keep the kernel detection (a YAML comment, no override)', () => {
    expect(routeWireCompat('http://127.0.0.1:5555/c/x')).toBeNull();
    expect(routeWireCompat('https://notdeepseek.com.evil.example')).toBeNull();
    expect(routeWireCompatYamlLine('not a url').startsWith('#')).toBe(true);
  });
});
