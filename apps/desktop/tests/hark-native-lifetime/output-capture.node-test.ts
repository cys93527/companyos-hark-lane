/**
 * Hark lane H7 — stdout/stderr capture LOGIC under the simulated Win32 kernel.
 * Real pipe/HANDLE_LIST behaviour: native/output-native.win-test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExecutorExecutionRequest } from '@companyos/engine';
import { createNativeJobExecutorProvider } from '../../src/executor/native-lifetime/job-executor-contract.js';
import { createJobLifetimeAdapter, type LifetimeOptions } from '../../src/executor/native-lifetime/job-lifetime.js';
import { FakeWindowsKernel, withoutAtomic, type Fault, type Script } from './fake-windows-kernel.js';
import { createNodeFsPinPort } from './node-fs-pin-port.js';
import { makeWorkspace, SIMULATED_WINDOWS_HOST, TEST_POLICY, verified } from './support.js';

const ws = makeWorkspace();
const text = (b: Uint8Array | undefined): string => Buffer.from(b ?? new Uint8Array()).toString('utf8');

function rig(opts: { script?: Script; faults?: Fault[]; maxBytes?: number; extra?: Partial<LifetimeOptions>; noAtomic?: boolean } = {}) {
  const kernel = new FakeWindowsKernel();
  for (const f of opts.faults ?? []) kernel.faults.add(f);
  if (opts.script) kernel.rootScript = opts.script;
  const adapter = createJobLifetimeAdapter({
    port: opts.noAtomic ? withoutAtomic(kernel.port()) : kernel.port(),
    clock: () => kernel.now, sleep: async ms => { kernel.advance(ms); }, host: SIMULATED_WINDOWS_HOST, pollMs: 10, stopWaitMs: 200,
    pinPort: createNodeFsPinPort(), captureOutput: { maxBytes: opts.maxBytes ?? 1024 }, ...opts.extra,
  });
  return { kernel, adapter };
}

describe('H7 adapter output capture', () => {
  it('captures stdout and stderr to EOF; owner write ends close right after create; no handle left open', async () => {
    const { kernel, adapter } = rig({ script: { exitAfterMs: 20, exitCode: 0, stdout: '{"ok":true}', stderr: 'warn' } });
    const r = await adapter.run(verified(ws));
    assert.equal(r.outcome, 'EXITED');
    assert.equal(text(r.output?.stdout), '{"ok":true}');
    assert.equal(text(r.output?.stderr), 'warn');
    assert.equal(r.output?.complete, true);
    const c = kernel.calls;
    assert.ok(c.indexOf('createOutputPipe') < c.indexOf('createSuspendedInJob'));
    assert.equal(c[c.indexOf('createSuspendedInJob') + 1], 'close', 'first write end closed immediately after create');
    assert.equal(kernel.openHandleCount(), 0);
  });
  it('bounded: bytes beyond maxBytes are counted, never kept', async () => {
    const { adapter } = rig({ maxBytes: 5, script: { exitAfterMs: 20, exitCode: 0, stdout: 'hello world' } });
    const r = await adapter.run(verified(ws));
    assert.equal(text(r.output?.stdout), 'hello');
    assert.equal(r.output?.droppedBytes.stdout, 6);
    assert.equal(r.output?.complete, true);
  });
  it('descendants inherit the pipe: their output is captured and EOF waits for them', async () => {
    const { adapter } = rig({ script: { exitAfterMs: 10, exitCode: 0, stdout: 'root;', spawn: [{ afterMs: 2, script: { exitAfterMs: 40, exitCode: 0, stdout: 'child;' } }] } });
    const r = await adapter.run(verified(ws));
    assert.equal(r.outcome, 'EXITED');
    assert.equal(text(r.output?.stdout), 'root;child;');
    assert.equal(r.output?.complete, true);
  });
  it('timeout: output written before the stop is kept and streams still reach EOF after drain', async () => {
    const { adapter } = rig({ script: { stdout: 'partial' } });
    const r = await adapter.run(verified(ws, { timeoutMs: 50 }));
    assert.equal(r.outcome, 'TIMEOUT');
    assert.equal(text(r.output?.stdout), 'partial');
    assert.equal(r.output?.complete, true);
  });
  it('capture without an atomic launch path is refused with zero native calls', async () => {
    const { kernel, adapter } = rig({ noAtomic: true, extra: { assignment: 'LEGACY_ASSIGN_ALLOWED' } });
    const r = await adapter.run(verified(ws));
    assert.equal(r.errors[0]?.operation, 'output-capture-unavailable');
    assert.deepEqual(kernel.calls, []);
  });
  it('a write end the kernel refuses to inherit -> LAUNCH_FAILED, never resumed, all pipe handles closed', async () => {
    const { kernel, adapter } = rig({ faults: ['pipeWriteNotInheritable'] });
    const r = await adapter.run(verified(ws));
    assert.equal(r.outcome, 'LAUNCH_FAILED');
    assert.equal(r.resumed, false);
    assert.equal(kernel.executedCount, 0);
    assert.equal(kernel.openHandleCount(), 0);
  });
});

describe('H7 contract: structured-output only with capture (C11)', () => {
  const op = (script: Script, maxBytes = 1024) => {
    const { adapter } = rig({ script, maxBytes });
    return createNativeJobExecutorProvider({
      operations: { k: { operationId: 'o', executable: { path: ws.exe, sha256: ws.exeSha }, inputs: [{ path: ws.script, sha256: ws.scriptSha }], args: [ws.script], timeoutMs: 500, environment: { SystemRoot: 'C:\\Windows', TEMP: ws.temp, TMP: ws.temp } } },
      adapter, policy: TEST_POLICY, nowIso: () => '',
    });
  };
  const req = (structured: boolean) => ({
    companyId: 'c', runId: 'r', taskId: 't', attemptId: 'a', attemptNumber: 1, roleId: 'x', taskKind: 'k', work: {},
    workspace: { cwd: ws.root, root: ws.root }, requiredCapabilities: structured ? ['structured-output'] : [], dispatchKey: 'd', taskText: '', structured,
  }) as unknown as ExecutorExecutionRequest;
  it('advertises structured-output and returns the parsed JSON object', async () => {
    const p = op({ exitAfterMs: 20, exitCode: 0, stdout: '{"answer":42}' });
    assert.ok(p.descriptor.capabilities.includes('structured-output'));
    const o = await p.start(req(true));
    assert.equal(o.kind, 'succeeded');
    assert.deepEqual(o.kind === 'succeeded' && o.structured, { schema: 'companyos/native-result/1', value: { answer: 42 } });
  });
  it('non-object JSON -> NATIVE_STRUCTURED_OUTPUT_MALFORMED', async () => {
    const o = await op({ exitAfterMs: 20, exitCode: 0, stdout: '[1,2]' }).start(req(true));
    assert.equal(o.kind === 'provider-failed' && o.reasonCode, 'NATIVE_STRUCTURED_OUTPUT_MALFORMED');
  });
  it('truncated stdout -> NATIVE_OUTPUT_INCOMPLETE for structured; marker for plain text', async () => {
    const s = await op({ exitAfterMs: 20, exitCode: 0, stdout: '{"a":"0123456789"}' }, 4).start(req(true));
    assert.equal(s.kind === 'provider-failed' && s.reasonCode, 'NATIVE_OUTPUT_INCOMPLETE');
    const t = await op({ exitAfterMs: 20, exitCode: 0, stdout: 'abcdefgh' }, 4).start(req(false));
    assert.equal(t.kind === 'succeeded' && t.stdoutText, 'abcd\n[companyos: 4 bytes truncated]');
  });
  it('failure carries bounded stdout/stderr diagnostics', async () => {
    const o = await op({ exitAfterMs: 20, exitCode: 2, stdout: 'out', stderr: 'boom' }).start(req(false));
    assert.equal(o.kind, 'provider-failed');
    assert.equal(o.kind === 'provider-failed' && o.stdoutText, 'out');
    assert.match(o.kind === 'provider-failed' ? o.stderrText : '', /^boom/u);
  });
});
