/**
 * Hark lane H6 — Supervisor integration contract, NATIVE end to end (Windows x64 CI).
 * ExecutorProvider.start -> verifyLaunch -> pinned Job launch -> outcome mapping.
 * Not production-wired.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ExecutorExecutionRequest } from '@companyos/engine';
import { createNativeJobExecutorProvider } from '../../../src/executor/native-lifetime/job-executor-contract.js';
import { createJobLifetimeAdapter } from '../../../src/executor/native-lifetime/job-lifetime.js';
import { createKoffiFilePinPort, createKoffiJobPort } from '../../../src/executor/native-lifetime/koffi-job-port.js';
import { alive, evidence, loadKoffi, makeNativeWorkspace, sleep, waitDead, waitForJson } from './native-support.js';

const koffi = loadKoffi();
const ws = makeNativeWorkspace('hark-h6-contract');
const provider = createNativeJobExecutorProvider({
  operations: {
    fixture: {
      operationId: 'native-fixture',
      executable: { path: ws.exe, sha256: ws.exeSha },
      inputs: [{ path: ws.script, sha256: ws.scriptSha }],
      args: [ws.script],
      inputArgs: ['mode', 'tag'],
      timeoutMs: 30_000,
      environment: { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows', TEMP: ws.temp, TMP: ws.temp, COMPANYOS_TEST_MODE: 'OFFLINE' },
    },
  },
  adapter: createJobLifetimeAdapter({ port: createKoffiJobPort(koffi), pinPort: createKoffiFilePinPort(koffi), clock: () => Date.now(), sleep, pollMs: 20, stopWaitMs: 5_000 }),
  policy: { platform: 'win32', requireExeSuffix: true, maxTimeoutMs: 600_000 },
  nowIso: () => new Date().toISOString(),
});

const req = (mode: string, tag: string, extra: Partial<ExecutorExecutionRequest> = {}): ExecutorExecutionRequest => ({
  companyId: 'c', runId: `h6-${tag}`, taskId: 't', attemptId: 'a', attemptNumber: 1, roleId: 'r', taskKind: 'fixture',
  work: { taskInputs: { mode, tag } }, workspace: { cwd: ws.root, root: ws.root }, requiredCapabilities: ['cancellation', 'timeout'],
  dispatchKey: `dsp_${tag}`, taskText: 'native fixture', structured: false, ...extra,
} as unknown as ExecutorExecutionRequest);

describe('H6 native: ExecutorProvider contract over the real Job adapter', () => {
  it('normal -> succeeded; error -> provider-failed with exit 17; cancel -> cancelled with proven termination; timeout -> timeout proven', async () => {
    const ok = await provider.start(req('normal', 'ok'));
    const bad = await provider.start(req('error', 'bad'));
    const controller = new AbortController();
    const holding = provider.start(req('tree', 'cancel', { signal: controller.signal }));
    const root = await waitForJson<{ pid: number }>(join(ws.root, 'cancel-root.json'), 30_000);
    const leaf = await waitForJson<{ pid: number }>(join(ws.root, 'cancel-leaf.json'), 30_000);
    controller.abort();
    const cancelled = await holding;
    const cancelDead = await waitDead([root.pid, leaf.pid], 5_000);
    const timedOut = await provider.start(req('hold', 'timeout', { timeoutMs: 1_500 }));
    evidence('contract-native', { ok, bad, cancelled, cancelDead, timedOut, blocked: provider.blocked, rootAlive: alive(root.pid) });
    assert.equal(ok.kind, 'succeeded');
    assert.deepEqual(bad.kind === 'provider-failed' && [bad.reasonCode, bad.exitCode], ['NATIVE_JOB_FAILED', 17]);
    assert.deepEqual(cancelled, { kind: 'cancelled', terminationProven: true });
    assert.equal(cancelDead, true);
    assert.deepEqual(timedOut, { kind: 'timeout', terminationProven: true });
    assert.equal(provider.blocked, false);
  });
  it('structured request is refused before any process exists (no stdout capture yet)', async () => {
    const o = await provider.start(req('normal', 'structured', { structured: true }));
    assert.equal(o.kind === 'provider-failed' && o.reasonCode, 'NATIVE_CAPABILITY_MISSING');
  });
});
