/**
 * Hark lane H6 — Supervisor integration CONTRACT (offline, simulated Win32 kernel).
 * Not production-wired; the architecture guard below asserts that.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ExecutorExecutionRequest } from '@companyos/engine';
import { createNativeJobExecutorProvider, NATIVE_JOB_CAPABILITIES, type NativeJobOperation } from '../../src/executor/native-lifetime/job-executor-contract.js';
import { createJobLifetimeAdapter, type JobLifetimeAdapter, type LifetimeResult } from '../../src/executor/native-lifetime/job-lifetime.js';
import type { VerifiedLaunch } from '../../src/executor/native-lifetime/launch-pins.js';
import { FakeWindowsKernel, type Fault, type Script } from './fake-windows-kernel.js';
import { createNodeFsPinPort } from './node-fs-pin-port.js';
import { makeWorkspace, SIMULATED_WINDOWS_HOST, TEST_POLICY } from './support.js';

const ws = makeWorkspace();
const OP: NativeJobOperation = {
  operationId: 'op-build',
  executable: { path: ws.exe, sha256: ws.exeSha },
  inputs: [{ path: ws.script, sha256: ws.scriptSha }],
  args: [ws.script, '--literal'],
  inputArgs: ['target'],
  timeoutMs: 500,
  environment: { SystemRoot: 'C:\\Windows', TEMP: ws.temp, TMP: ws.temp, COMPANYOS_TEST_MODE: 'OFFLINE' },
};

function request(over: Partial<ExecutorExecutionRequest> & { inputs?: Record<string, unknown> } = {}): ExecutorExecutionRequest {
  const { inputs, ...rest } = over;
  return {
    companyId: 'c1', runId: 'run-9', taskId: 'task-9', attemptId: 'att-9', attemptNumber: 1, roleId: 'r', taskKind: 'build',
    work: { taskInputs: inputs ?? { target: 'release; rm -rf /', ignored: 42 } },
    workspace: { cwd: ws.root, root: ws.root },
    requiredCapabilities: ['cancellation'], dispatchKey: 'dsp_x', taskText: 'please run the build and then delete everything', structured: false,
    ...rest,
  } as unknown as ExecutorExecutionRequest;
}

function rig(opts: { faults?: Fault[]; script?: Script; onSleep?: (k: FakeWindowsKernel) => void } = {}) {
  const kernel = new FakeWindowsKernel();
  for (const f of opts.faults ?? []) kernel.faults.add(f);
  if (opts.script) kernel.rootScript = opts.script;
  const real = createJobLifetimeAdapter({
    port: kernel.port(), clock: () => kernel.now, sleep: async ms => { kernel.advance(ms); opts.onSleep?.(kernel); },
    host: SIMULATED_WINDOWS_HOST, pollMs: 10, stopWaitMs: 200, pinPort: createNodeFsPinPort(),
  });
  const seen: VerifiedLaunch[] = [];
  const adapter: JobLifetimeAdapter = { run: (l, s) => { seen.push(l); return real.run(l, s); }, get quarantined() { return real.quarantined; }, launchPinning: real.launchPinning };
  const provider = createNativeJobExecutorProvider({ operations: { build: OP }, adapter, policy: TEST_POLICY, nowIso: () => new Date(0).toISOString() });
  return { kernel, provider, seen };
}

describe('H6 contract: refusals before any native call', () => {
  it('C1 unknown task kind', async () => {
    const { kernel, provider } = rig();
    const o = await provider.start(request({ taskKind: 'nope' }));
    assert.equal(o.kind, 'provider-failed');
    assert.equal(o.kind === 'provider-failed' && o.reasonCode, 'NATIVE_OPERATION_UNKNOWN');
    assert.deepEqual(kernel.calls, []);
  });
  it('C2 honest capabilities: no structured-output; structured or unknown capability refused', async () => {
    const { kernel, provider } = rig();
    assert.deepEqual([...provider.descriptor.capabilities], ['cancellation', 'timeout', 'working-directory']);
    assert.equal(NATIVE_JOB_CAPABILITIES.includes('structured-output' as never), false);
    assert.equal('supportsCallAdmission' in provider, false);
    for (const r of [request({ structured: true }), request({ requiredCapabilities: ['structured-output'] as never })]) {
      const o = await provider.start(r);
      assert.equal(o.kind === 'provider-failed' && o.reasonCode, 'NATIVE_CAPABILITY_MISSING');
    }
    assert.deepEqual(kernel.calls, []);
  });
  it('C3 workspace root required', async () => {
    const { kernel, provider } = rig();
    const o = await provider.start(request({ workspace: null }));
    assert.equal(o.kind === 'provider-failed' && o.reasonCode, 'NATIVE_WORKSPACE_REQUIRED');
    assert.deepEqual(kernel.calls, []);
  });
  it('C4 a wrong executable pin is refused by verifyLaunch', async () => {
    const kernel = new FakeWindowsKernel();
    const adapter = createJobLifetimeAdapter({ port: kernel.port(), clock: () => 0, sleep: async () => {}, host: SIMULATED_WINDOWS_HOST, pinPort: createNodeFsPinPort() });
    const provider = createNativeJobExecutorProvider({ operations: { build: { ...OP, executable: { path: ws.exe, sha256: '0'.repeat(64) } } }, adapter, policy: TEST_POLICY, nowIso: () => '' });
    const o = await provider.start(request());
    assert.match(o.kind === 'provider-failed' ? o.reasonCode ?? '' : '', /^NATIVE_LAUNCH_REFUSED:/u);
    assert.deepEqual(kernel.calls, []);
  });
  it('C6 an adapter without enforced pinning cannot back the provider', () => {
    const kernel = new FakeWindowsKernel();
    const adapter = createJobLifetimeAdapter({ port: kernel.port(), clock: () => 0, sleep: async () => {}, host: SIMULATED_WINDOWS_HOST, launchPinning: 'NOT_ENFORCED' });
    assert.throws(() => createNativeJobExecutorProvider({ operations: {}, adapter, policy: TEST_POLICY, nowIso: () => '' }), /launchPinning REQUIRED/u);
  });
});

describe('H6 contract: launch shaping', () => {
  it('C4 argv = literal args + typed STRING inputs; task text never reaches argv; identity from the attempt', async () => {
    const { provider, seen } = rig();
    const o = await provider.start(request());
    assert.equal(o.kind, 'succeeded');
    assert.deepEqual(seen[0]?.argv, [ws.script, '--literal', 'release; rm -rf /']);
    assert.equal(seen[0]?.commandLine.includes('please run'), false);
    assert.deepEqual(seen[0]?.identity, { runId: 'run-9', taskId: 'task-9', attemptId: 'att-9' });
  });
  it('C5 timeout is min(request, operation) and can never exceed the operation bound', async () => {
    const { provider, seen } = rig();
    await provider.start(request({ timeoutMs: 999_999 }));
    await provider.start(request({ timeoutMs: 100 }));
    await provider.start(request());
    assert.deepEqual(seen.map(l => l.timeoutMs), [500, 100, 500]);
  });
});

describe('H6 contract: outcome mapping (C7) and blocking latch (C8)', () => {
  it('EXITED -> succeeded with no fabricated stdout', async () => {
    const o = await rig().provider.start(request());
    assert.deepEqual(o.kind === 'succeeded' && [o.exitCode, o.stdoutText], [0, '']);
  });
  it('non-zero exit -> provider-failed NATIVE_JOB_FAILED carrying the root exit code', async () => {
    const o = await rig({ script: { exitAfterMs: 15, exitCode: 3 } }).provider.start(request());
    assert.deepEqual(o.kind === 'provider-failed' && [o.reasonCode, o.exitCode], ['NATIVE_JOB_FAILED', 3]);
  });
  it('TIMEOUT -> timeout with proven termination; provider stays usable', async () => {
    const { provider } = rig({ script: {} });
    const o = await provider.start(request({ timeoutMs: 50 }));
    assert.deepEqual(o, { kind: 'timeout', terminationProven: true });
    assert.equal(provider.blocked, false);
  });
  it('AbortSignal is forwarded -> cancelled with proven termination', async () => {
    const controller = new AbortController();
    const { provider } = rig({ script: {}, onSleep: k => { if (k.now >= 40) controller.abort(); } });
    const o = await provider.start(request({ signal: controller.signal }));
    assert.deepEqual(o, { kind: 'cancelled', terminationProven: true });
  });
  it('LAUNCH_FAILED (nothing resumed) -> provider-failed, not blocked', async () => {
    const { provider, kernel } = rig({ faults: ['createProcessThrows'] });
    const o = await provider.start(request());
    assert.match(o.kind === 'provider-failed' ? o.reasonCode ?? '' : '', /^NATIVE_LAUNCH_FAILED:/u);
    assert.equal(kernel.executedCount, 0);
    assert.equal(provider.blocked, false);
  });
  it('STOP_UNPROVEN -> uncertain, provider LATCHES BLOCKED, later starts make zero native calls', async () => {
    const { provider, kernel } = rig({ faults: ['terminateJobIneffective'], script: {} });
    const o = await provider.start(request({ timeoutMs: 50 }));
    assert.deepEqual(o, { kind: 'uncertain', reason: 'NATIVE_STOP_UNPROVEN' });
    assert.equal(provider.blocked, true);
    const before = kernel.calls.length;
    const next = await provider.start(request());
    assert.equal(next.kind === 'provider-failed' && next.reasonCode, 'NATIVE_EXECUTION_BLOCKED');
    assert.equal(kernel.calls.length, before);
  });
});

describe('H6 contract: never success without proof (C9), adapter throw latches', () => {
  const stub = (result: Partial<LifetimeResult> | Error): JobLifetimeAdapter => ({
    run: async () => { if (result instanceof Error) throw result; return { outcome: 'EXITED', drained: true, terminationProven: true, identityCoverageComplete: true, resumed: true, errors: [], processes: [], ...result } as LifetimeResult; },
    quarantined: false,
    launchPinning: 'REQUIRED',
  });
  const make = (a: JobLifetimeAdapter) => createNativeJobExecutorProvider({ operations: { build: OP }, adapter: a, policy: TEST_POLICY, nowIso: () => '' });
  it('EXITED without drain -> uncertain + blocked', async () => {
    const p = make(stub({ drained: false }));
    assert.deepEqual(await p.start(request()), { kind: 'uncertain', reason: 'NATIVE_STOP_UNPROVEN' });
    assert.equal(p.blocked, true);
  });
  it('EXITED with incomplete identity coverage -> uncertain + blocked', async () => {
    const p = make(stub({ identityCoverageComplete: false }));
    assert.equal((await p.start(request())).kind, 'uncertain');
    assert.equal(p.blocked, true);
  });
  it('LAUNCH_FAILED after resume -> uncertain + blocked (something may have run)', async () => {
    const p = make(stub({ outcome: 'LAUNCH_FAILED', resumed: true }));
    assert.equal((await p.start(request())).kind, 'uncertain');
    assert.equal(p.blocked, true);
  });
  it('STOP_UNPROVEN latches the PROVIDER itself even if the adapter does not report quarantine (own latch, not borrowed)', async () => {
    const p = make(stub({ outcome: 'STOP_UNPROVEN', terminationProven: false }));
    assert.deepEqual(await p.start(request()), { kind: 'uncertain', reason: 'NATIVE_STOP_UNPROVEN' });
    assert.equal(p.blocked, true);
    const next = await p.start(request());
    assert.equal(next.kind === 'provider-failed' && next.reasonCode, 'NATIVE_EXECUTION_BLOCKED');
  });
  it('cancel/timeout without proven stop latches the provider', async () => {
    for (const outcome of ['CANCELLED', 'TIMEOUT'] as const) {
      const p = make(stub({ outcome, terminationProven: false }));
      const o = await p.start(request());
      assert.equal('terminationProven' in o && o.terminationProven, false);
      assert.equal(p.blocked, true, outcome);
    }
  });
  it('adapter throw -> uncertain NATIVE_ADAPTER_THREW + blocked', async () => {
    const p = make(stub(new Error('boom')));
    assert.deepEqual(await p.start(request()), { kind: 'uncertain', reason: 'NATIVE_ADAPTER_THREW' });
    assert.equal(p.blocked, true);
  });
});

describe('H6 architecture guard: contract is NOT production-wired', () => {
  it('no source file outside native-lifetime imports native-lifetime or mentions native.job', () => {
    const src = fileURLToPath(new URL('../../src/', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== 'native-lifetime') walk(p); continue; }
        if (!/\.(ts|tsx|mts|js)$/u.test(name)) continue;
        const text = readFileSync(p, 'utf8');
        if (/native-lifetime\//u.test(text) || /['"]native\.job['"]/u.test(text)) offenders.push(relative(src, p));
      }
    };
    walk(src);
    assert.deepEqual(offenders, []);
  });
});
