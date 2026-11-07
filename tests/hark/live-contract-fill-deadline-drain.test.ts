/**
 * LIVE-CONTRACT-FILL run 5 (hark-live-goal 42367067423): the 600 s attempt deadline killed the
 * kernel while model call 53 was in flight -> usage never observed -> UNKNOWN reservation ->
 * GOAL_USAGE_UNKNOWN -> the goal locked EXTERNAL_PRECONDITION_BLOCKED. Root fix:
 *  - near the deadline the broker admits no NEW model call (refused before reservation/network);
 *  - at the deadline the kill waits (bounded) for the in-flight call to settle;
 *  - a call whose kernel vanished keeps reading upstream so its usage settles KNOWN;
 *  - a kernel ended by the drain is a resumable TIMEOUT, and attempt N>1 is told what the
 *    earlier attempt left in the workspace;
 *  - coding-kernel attempts get a 30 min software-work budget (configurable).
 */
import { registerOfflineInline } from '../support/offline-fixtures.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createProcessExecutorProvider, type ExecutorProviderOutcome } from '@companyos/engine';
import { startModelBroker, type ModelBrokerExchangeObservation, type ModelBrokerHandle } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';
import {
  attemptDrainLeadMs,
  ATTEMPT_DEADLINE_INFLIGHT_GRACE_MS,
  deadlineDrainOutcome,
  resumedAttemptDirective,
  runWithOutputCeilingRecovery,
  workspaceFileInventoryOf,
} from '../../apps/desktop/src/executor/dsh-executor-provider.js';
import {
  DEFAULT_KERNEL_ATTEMPT_TIMEOUT_MS,
  resolveKernelAttemptTimeoutMs,
} from '../../apps/desktop/src/production-composition.js';

const servers: Server[] = [];
const brokers: ModelBrokerHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  brokers.splice(0).forEach((b) => b.close());
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const USAGE_STREAM_TAIL = [
  'data: {"id":"x","choices":[{"index":0,"delta":{"content":" done"},"finish_reason":"stop"}],"usage":{"completion_tokens":40,"prompt_tokens":900,"total_tokens":940}}',
  'data: [DONE]',
  '',
].join('\n\n');

/** An upstream that answers headers + a first chunk at once and the usage chunk after `tailDelayMs`. */
const slowUpstream = async (tailDelayMs: number) => {
  let hits = 0;
  const upstream = createServer((req, res) => {
    hits += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"x","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}],"usage":null}\n\n');
      setTimeout(() => res.end(USAGE_STREAM_TAIL), tailDelayMs);
    });
  });
  servers.push(upstream);
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, hits: () => hits };
};

const brokerFor = async (upstreamURL: string) => {
  const settled: unknown[] = [];
  const observations: ModelBrokerExchangeObservation[] = [];
  const broker = await startModelBroker({
    upstreamBaseURL: upstreamURL,
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
  return { broker: broker.value, settled, observations };
};

describe('run 5 root fix: the broker drains instead of losing usage', () => {
  it('after stopAdmitting a new model call is refused before any upstream request or reservation', async () => {
    const up = await slowUpstream(0);
    const { broker, settled, observations } = await brokerFor(up.url);
    broker.stopAdmitting();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${broker.url}/chat/completions`, { method: 'POST' }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode ?? 0)); });
      req.once('error', reject);
      req.end('{"model":"m","stream":true}');
    });
    expect(status).toBe(403);
    expect(up.hits()).toBe(0);
    expect(settled).toEqual([]);
    expect(observations).toEqual([]);
    expect(broker.inFlight()).toBe(0);
  });

  it('a call whose kernel vanished mid-stream keeps reading upstream and settles the usage KNOWN', async () => {
    const up = await slowUpstream(300);
    const { broker, settled, observations } = await brokerFor(up.url);
    await new Promise<void>((resolve, reject) => {
      const req = request(`${broker.url}/chat/completions`, { method: 'POST' }, (res) => {
        // the kernel is killed after the first chunk (the attempt deadline in run 5)
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.once('error', () => undefined);
      req.on('timeout', reject);
      req.end('{"model":"m","stream":true}');
    });
    expect(broker.inFlight()).toBe(1);
    expect(await broker.whenIdle(5_000)).toBe(true);
    expect(settled).toEqual([{ inputTokens: 900, outputTokens: 40, totalCost: null }]);
    expect(observations[0]).toMatchObject({ endedBy: 'upstream-end-orphaned', usageDisposition: 'observed', usage: { inputTokens: 900, outputTokens: 40 } });
  });

  it('whenIdle is bounded: it answers false when an exchange outlives the grace', async () => {
    const up = await slowUpstream(2_000);
    const { broker } = await brokerFor(up.url);
    const req = request(`${broker.url}/chat/completions`, { method: 'POST' }, (res) => { res.resume(); });
    req.once('error', () => undefined);
    req.end('{"model":"m","stream":true}');
    await expect.poll(() => broker.inFlight()).toBe(1);
    expect(await broker.whenIdle(50)).toBe(false);
    expect(await broker.whenIdle(5_000)).toBe(true);
  });
});

describe('run 5 root fix: the deadline stop waits for the drain hook', () => {
  it('the process provider runs beforeTimeoutStop before killing, and still reports a timeout', async () => {
    const code = 'setInterval(()=>{},1000)';
    registerOfflineInline(code);
    const dir = mkdtempSync(join(tmpdir(), 'drain-'));
    dirs.push(dir);
    const order: string[] = [];
    const provider = createProcessExecutorProvider({
      providerKey: 'fixture', capabilities: ['timeout'], executable: process.execPath,
      baseArgv: ['-e', code], fallbackCwd: dir, buildArgs: () => [],
      timer: (ms, callback) => { const handle = setTimeout(callback, ms === 5000 ? 40 : ms); return () => clearTimeout(handle); },
      beforeTimeoutStop: async () => {
        order.push('drain-start');
        await new Promise((r) => setTimeout(r, 200));
        order.push('drain-end');
      },
    });
    const started = Date.now();
    const outcome = await provider.start({
      companyId: 'c', runId: 'r', taskId: 't', attemptId: 'a', attemptNumber: 1, roleId: 'role', taskKind: 'k',
      work: { objective: 'fixture' }, workspace: null, requiredCapabilities: ['timeout'], dispatchKey: 'd', taskText: '', structured: false,
      timeoutMs: 100,
    });
    expect(outcome.kind).toBe('timeout');
    expect(order).toEqual(['drain-start', 'drain-end']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });
});

describe('run 5 root fix: drained attempts are resumable', () => {
  const failed = { kind: 'provider-failed', exitCode: 1, stderrText: '', stdoutText: 'tail', reasonCode: 'EXECUTOR_KERNEL_TURN_ERROR' } as unknown as ExecutorProviderOutcome;
  it('a kernel that ended after the drain began is a TIMEOUT (resumable), not a provider failure', () => {
    expect(deadlineDrainOutcome(failed, true)).toEqual({ kind: 'timeout', terminationProven: true, stdoutText: 'tail' });
    expect(deadlineDrainOutcome(failed, false)).toBe(failed);
    const ok = { kind: 'succeeded' } as unknown as ExecutorProviderOutcome;
    expect(deadlineDrainOutcome(ok, true)).toBe(ok);
  });
  it('the drain starts a bounded lead before the deadline and the in-flight grace covers the model timeout', () => {
    expect(attemptDrainLeadMs(1_800_000)).toBe(30_000);
    expect(attemptDrainLeadMs(120_000)).toBe(6_000);
    expect(ATTEMPT_DEADLINE_INFLIGHT_GRACE_MS).toBeGreaterThan(90_000);
  });
  it('attempt N>1 starts with the earlier attempt\'s workspace inventory and no relaunch happens while draining', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.js'), 'x');
    const inventory = workspaceFileInventoryOf(dir);
    const directive = resumedAttemptDirective({ attemptNumber: 2, files: inventory.files, filesTruncated: inventory.truncated });
    expect(directive).toMatch(/RESUMED STEP \(attempt 2\).*index\.js \(1 B\).*Do not start over/u);
    const seen: (string | undefined)[] = [];
    const ceiling = { kind: 'provider-failed', exitCode: 1, stderrText: '', stdoutText: '{"type":"status","phase":"turn_end","reason":{"kind":"max-tokens"}}' } as unknown as ExecutorProviderOutcome;
    const result = await runWithOutputCeilingRecovery({
      workspaceRoot: dir, timeoutMs: 600_000, initialDirective: directive, shouldStop: () => true,
      start: async (_ms, d) => { seen.push(d); return ceiling; },
    });
    expect(seen).toEqual([directive]);
    expect(result.continuations).toBe(0);
  });
});

describe('run 5 root fix: software-work attempt budget', () => {
  it('coding-kernel attempts default to 30 min; the kernel override wins; a deployment override still applies', () => {
    expect(DEFAULT_KERNEL_ATTEMPT_TIMEOUT_MS).toBe(1_800_000);
    expect(resolveKernelAttemptTimeoutMs({})).toBe(1_800_000);
    expect(resolveKernelAttemptTimeoutMs({ COS_KERNEL_ATTEMPT_TIMEOUT_MS: '900000' })).toBe(900_000);
    expect(resolveKernelAttemptTimeoutMs({ COS_EXECUTION_ATTEMPT_TIMEOUT_MS: '120000' })).toBe(120_000);
    expect(() => resolveKernelAttemptTimeoutMs({ COS_KERNEL_ATTEMPT_TIMEOUT_MS: '5' })).toThrow(/COS_KERNEL_ATTEMPT_TIMEOUT_MS/u);
  });
});
