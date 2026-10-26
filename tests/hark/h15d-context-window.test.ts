/**
 * Hark lane H15d-fix3 — acceptance run 3 (hark-live-goal 40320541076) lost three kernel
 * attempts to the admission's input bound: the kernel was given a 128k-token window, had
 * no compactor mounted, and every attempt died at step ~13-19 with 'AUTH: 403 budget
 * admission refused' once its request body passed 48 000 bytes. Root fix:
 *  1. the kernel's working window is derived from the admission byte bound;
 *  2. the profile mounts the official compaction rows sized for the CompanyOS route;
 *  3. an oversize body is answered in the OpenAI context-length shape (never a budget 403),
 *     so the kernel compacts and retries; it reached no network and reserved nothing.
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { domainError } from '@companyos/core';
import { startModelBroker, type ModelBrokerHandle } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';
import { kernelContextWindowFor, KERNEL_BYTES_PER_TOKEN } from '../../apps/desktop/src/executor/dsh-executor-provider.js';
// @ts-expect-error untyped test-data helper (.mjs)
import { renderFixtureText } from '../../scripts/prepare-offline-resources.mjs';

const servers: Server[] = [];
const brokers: ModelBrokerHandle[] = [];
afterEach(async () => {
  brokers.splice(0).forEach((b) => b.close());
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

// The pinned kernel's classifier (packages/llm/llm/src/error.ts STRUCTURED_CONTEXT_OVERFLOW
// and the "maximum context length" rule), restated so a wording drift fails here.
const kernelSeesOverflow = (detail: string): boolean =>
  /(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])/iu.test(detail)
  || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/iu.test(detail);

const template = JSON.parse(readFileSync('installer/budget/deepseek-flash.h15d.approval-template.json', 'utf8')) as {
  proof: { tokens: { inputUpperBound: number; outputUpperBound: number } };
};

describe('H15d-fix3 kernel working window follows the admission bound', () => {
  it('window = min(route window, bound / 4); no bound keeps the route window', () => {
    expect(kernelContextWindowFor(128_000, 96_000)).toBe(24_000);
    expect(kernelContextWindowFor(16_000, 96_000)).toBe(16_000);
    expect(kernelContextWindowFor(128_000, undefined)).toBe(128_000);
  });

  it('the compaction threshold for the acceptance route sits well under the byte bound', () => {
    const bound = template.proof.tokens.inputUpperBound;
    const out = template.proof.tokens.outputUpperBound;
    const window = kernelContextWindowFor(128_000, bound);
    // compaction-basic resolveCompactSpec with headroomTokens = maxTokens = route max_tokens.
    const threshold = Math.floor(Math.min(window * 0.8, window - out - out));
    const retain = Math.floor((window - out) * 0.16);
    expect(threshold).toBeGreaterThan(retain);
    expect(threshold * KERNEL_BYTES_PER_TOKEN).toBeLessThanOrEqual(bound * 0.7);
  });

  it('the profile mounts token-meter, tool-result-pruner and compaction-basic sized by the route', () => {
    const patch = (renderFixtureText(readFileSync('scripts/materialize-embedded-dsh.mjs', 'utf8'), 'profile-patch-template.yml') as Buffer).toString('utf8');
    expect(patch).toMatch(/- id: token-meter\n\s+name: '@deepseek-ai\/dsh-token-meter'/u);
    expect(patch).toMatch(/- id: tool-result-pruner\n\s+name: '@deepseek-ai\/dsh-compaction-tool-result-pruner'/u);
    expect(patch).toMatch(/- id: compaction-basic\n\s+name: '@deepseek-ai\/dsh-compaction-basic'\n\s+config:\n\s+headroomTokens: \{\{ROUTE_MAX_TOKENS\}\}\n\s+maxTokens: \{\{ROUTE_MAX_TOKENS\}\}/u);
  });
});

describe('H15d-fix3 broker answers an oversize body as a context limit', () => {
  const post = async (url: string, body: string): Promise<{ status: number; type: string; text: string }> =>
    new Promise((resolve, reject) => {
      const req = request(`${url}/chat/completions`, { method: 'POST' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.once('error', reject);
      req.end(body);
    });

  const start = async (refusal: Error) => {
    let upstreamHits = 0;
    const upstream = createServer((req, res) => { upstreamHits += 1; req.resume(); res.end(); });
    servers.push(upstream);
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const broker = await startModelBroker({
      upstreamBaseURL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      bearer: '',
      upstreamTimeoutMs: 5_000,
      admission: async () => { throw refusal; },
    });
    if (!broker.ok) throw broker.error;
    brokers.push(broker.value);
    return { url: broker.value.url, hits: () => upstreamHits };
  };

  it('GOAL_KERNEL_REQUEST_INPUT_UNBOUNDED -> 400 context_length_exceeded the kernel classifies as overflow', async () => {
    const b = await start(domainError('POLICY_DENIED', 'Kernel request is larger than the proven input bound.', { reason: 'GOAL_KERNEL_REQUEST_INPUT_UNBOUNDED', retryable: false, requestBytes: 96_001, inputUpperBound: 96_000 }));
    const r = await post(b.url, JSON.stringify({ model: 'm', max_tokens: 10, stream: true }));
    expect(r.status).toBe(400);
    expect(r.type).toMatch(/application\/json/u);
    const err = (JSON.parse(r.text) as { error: { code: string; type: string; message: string } }).error;
    expect(err.code).toBe('context_length_exceeded');
    expect(kernelSeesOverflow(`${err.code} ${err.type} ${err.message}`)).toBe(true);
    expect(kernelSeesOverflow(err.message)).toBe(true);
    expect(b.hits()).toBe(0);
  });

  it('any other refusal stays the opaque 403 and is NOT an overflow', async () => {
    const b = await start(domainError('POLICY_DENIED', 'cap', { reason: 'GOAL_BUDGET_EXHAUSTED', retryable: false }));
    const r = await post(b.url, JSON.stringify({ model: 'm', max_tokens: 10, stream: true }));
    expect(r.status).toBe(403);
    expect(r.text).toBe('budget admission refused');
    expect(kernelSeesOverflow(r.text)).toBe(false);
    expect(b.hits()).toBe(0);
  });
});
