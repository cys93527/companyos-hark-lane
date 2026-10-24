/**
 * Hark lane H7 — NATIVE stdout/stderr capture (Windows x64 CI): anonymous pipes,
 * HANDLE_LIST inheritance, bounded capture, descendant EOF, contract structured-output.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { ExecutorExecutionRequest } from '@companyos/engine';
import { createNativeJobExecutorProvider } from '../../../src/executor/native-lifetime/job-executor-contract.js';
import { createJobLifetimeAdapter } from '../../../src/executor/native-lifetime/job-lifetime.js';
import { createKoffiFilePinPort, createKoffiJobPort } from '../../../src/executor/native-lifetime/koffi-job-port.js';
import { verifyLaunch } from '../../../src/executor/native-lifetime/launch-pins.js';
import { evidence, loadKoffi, makeNativeWorkspace, sha256, sleep } from './native-support.js';

const koffi = loadKoffi();
const port = createKoffiJobPort(koffi);
const pinPort = createKoffiFilePinPort(koffi);
const ws = makeNativeWorkspace('hark-h7-output');
const env = { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows', TEMP: ws.temp, TMP: ws.temp, COMPANYOS_TEST_MODE: 'OFFLINE' };
const adapter = (maxBytes: number) => createJobLifetimeAdapter({ port, pinPort, clock: () => Date.now(), sleep, pollMs: 20, stopWaitMs: 5_000, captureOutput: { maxBytes } });
const launch = (mode: string, tag: string) => verifyLaunch({
  identity: { runId: `h7-${tag}`, taskId: 'out', attemptId: '1' },
  executable: { path: ws.exe, sha256: ws.exeSha }, inputs: [{ path: ws.script, sha256: sha256(readFileSync(ws.script)) }],
  argv: [ws.script, mode, tag], workspaceRoot: ws.root, cwd: ws.root, environment: env, timeoutMs: 60_000,
}, { platform: 'win32', requireExeSuffix: true, maxTimeoutMs: 600_000 });
const text = (b: Uint8Array | undefined): string => Buffer.from(b ?? new Uint8Array()).toString('utf8');

describe('H7 native: output capture', () => {
  it('stdout and stderr are captured separately to EOF', async () => {
    const r = await adapter(1 << 20).run(launch('print', 'print'));
    evidence('output-print', { outcome: r.outcome, stdout: text(r.output?.stdout), stderr: text(r.output?.stderr), complete: r.output?.complete, errors: r.errors });
    assert.equal(r.outcome, 'EXITED');
    assert.deepEqual(JSON.parse(text(r.output?.stdout)).ok, true);
    assert.equal(text(r.output?.stderr), 'diag-line');
    assert.equal(r.output?.complete, true);
  });
  it('3 MiB flood with a 64 KiB cap: child never blocks forever, 64 KiB kept, rest counted', async () => {
    const r = await adapter(64 * 1024).run(launch('flood', 'flood'));
    evidence('output-flood', { outcome: r.outcome, kept: r.output?.stdout.length, dropped: r.output?.droppedBytes, complete: r.output?.complete });
    assert.equal(r.outcome, 'EXITED');
    assert.equal(r.output?.stdout.length, 64 * 1024);
    assert.equal((r.output?.stdout.length ?? 0) + (r.output?.droppedBytes.stdout ?? 0), 48 * 64 * 1024);
    assert.equal(r.output?.complete, true);
  });
  it('a descendant inheriting the pipe: its output is captured and EOF waits for it', async () => {
    const r = await adapter(1 << 20).run(launch('inheritleaf', 'leaf'));
    evidence('output-descendant', { outcome: r.outcome, stdout: text(r.output?.stdout), complete: r.output?.complete, processes: r.processes.map(p => [p.role, p.imagePath, p.exitCode]) });
    assert.equal(r.outcome, 'EXITED');
    assert.equal(text(r.output?.stdout), 'root-out;leaf-out;');
    assert.equal(r.output?.complete, true);
  });
  it('contract: structured-output advertised and the JSON object returned', async () => {
    const provider = createNativeJobExecutorProvider({
      operations: { print: { operationId: 'print', executable: { path: ws.exe, sha256: ws.exeSha }, inputs: [{ path: ws.script, sha256: sha256(readFileSync(ws.script)) }], args: [ws.script, 'print', 'contract'], timeoutMs: 30_000, environment: env } },
      adapter: adapter(1 << 20), policy: { platform: 'win32', requireExeSuffix: true, maxTimeoutMs: 600_000 }, nowIso: () => new Date().toISOString(),
    });
    const o = await provider.start({
      companyId: 'c', runId: 'h7-c', taskId: 't', attemptId: 'a', attemptNumber: 1, roleId: 'r', taskKind: 'print', work: {},
      workspace: { cwd: ws.root, root: ws.root }, requiredCapabilities: ['structured-output'], dispatchKey: 'd', taskText: '', structured: true,
    } as unknown as ExecutorExecutionRequest);
    evidence('output-contract', o);
    assert.equal(o.kind, 'succeeded');
    assert.equal((o.kind === 'succeeded' ? (o.structured as { value: { ok: boolean } }).value.ok : false), true);
  });
});
