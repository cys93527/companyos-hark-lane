/**
 * Hark lane H3 — NATIVE Windows x64 Job Object evidence (koffi@3.3.3, CI only).
 *
 * Runs only through scripts/hark/test-hark-native.mjs on a win32/x64 host with
 * HARK_KOFFI_DIR pointing at the separately installed, integrity-checked koffi.
 * The child is a byte-pinned copy of node.exe running a pinned fixture script
 * inside a temporary workspace. No network, no Provider, no system settings.
 * Not matched by the offline runner (*.node-test.ts) and never run on Linux.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createJobLifetimeAdapter, type LifetimeOptions } from '../../../src/executor/native-lifetime/job-lifetime.js';
import { JOB_FORBIDDEN_FLAGS, JOB_REQUIRED_FLAGS, type WindowsJobPort } from '../../../src/executor/native-lifetime/job-port.js';
import { createKoffiFilePinPort, createKoffiJobPort, type KoffiLike } from '../../../src/executor/native-lifetime/koffi-job-port.js';
import { verifyLaunch, type LaunchRequest, type VerifiedLaunch } from '../../../src/executor/native-lifetime/launch-pins.js';

const koffiDir = process.env['HARK_KOFFI_DIR'];
if (process.platform !== 'win32' || process.arch !== 'x64' || !koffiDir) {
  throw new Error('HARK_NATIVE_HOST_REFUSED: requires win32/x64 and HARK_KOFFI_DIR');
}
const koffi = createRequire(join(koffiDir, 'package.json'))('koffi') as KoffiLike;
const port: WindowsJobPort = createKoffiJobPort(koffi);
const pinPort = createKoffiFilePinPort(koffi);

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const FIXTURE = `/* Hark H3 native fixture: deterministic, no network, no credentials. */
const fs = require('node:fs');
const path = require('node:path');
const [mode, tag] = process.argv.slice(2);
const write = (name, value) => fs.writeFileSync(path.join(process.cwd(), name), JSON.stringify(value));
if (mode === 'normal') { write(tag + '-root.json', { pid: process.pid }); }
else if (mode === 'error') { process.exitCode = 17; }
else if (mode === 'hold') { write(tag + '-root.json', { pid: process.pid }); setInterval(() => {}, 1000); }
else if (mode === 'tree') {
  write(tag + '-root.json', { pid: process.pid });
  const child = require('node:child_process').spawn(process.execPath, [__filename, 'leaf', tag], { stdio: 'ignore', windowsHide: true, shell: false });
  child.on('error', e => write(tag + '-spawn-error.json', { code: e.code }));
  setInterval(() => {}, 1000);
} else if (mode === 'leaf') { write(tag + '-leaf.json', { pid: process.pid }); setInterval(() => {}, 1000); }
else { process.exitCode = 99; }
`;

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hark-h3-native-')));
const temp = join(root, 'tmp');
mkdirSync(temp);
const exe = join(root, 'node.exe');
copyFileSync(process.execPath, exe);
const exeSha = sha(readFileSync(exe));
const script = join(root, 'fixture.cjs');
writeFileSync(script, FIXTURE);
const scriptSha = sha(readFileSync(script));
const policy = { platform: 'win32' as NodeJS.Platform, requireExeSuffix: true, maxTimeoutMs: 600_000 };

function launch(mode: string, tag: string, timeoutMs: number): VerifiedLaunch {
  const request: LaunchRequest = {
    identity: { runId: `h3-${tag}`, taskId: 'native', attemptId: '1' },
    executable: { path: exe, sha256: exeSha },
    inputs: [{ path: script, sha256: scriptSha }],
    argv: [script, mode, tag],
    workspaceRoot: root,
    cwd: root,
    environment: { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows', TEMP: temp, TMP: temp, COMPANYOS_TEST_MODE: 'OFFLINE' },
    timeoutMs,
  };
  return verifyLaunch(request, policy);
}

function adapter() {
  const options: LifetimeOptions = { port, clock: () => Date.now(), sleep, assignment: 'ATOMIC_REQUIRED', pollMs: 20, stopWaitMs: 5_000, pinPort };
  return createJobLifetimeAdapter(options);
}

async function waitForFile(name: string, ms: number): Promise<{ pid: number }> {
  const file = join(root, name);
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) {
    if (existsSync(file)) {
      try { return JSON.parse(readFileSync(file, 'utf8')) as { pid: number }; } catch { /* partially written */ }
    }
  }
  throw new Error(`fixture-file-missing:${name}`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const report = (name: string, value: unknown): void => { console.log(`HARK_NATIVE_EVIDENCE ${name} ${JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`); };

describe('H3 native: Job Object primitives (kernel32 via koffi 3.3.3)', () => {
  it('job handle is non-inheritable; kill-on-close + active limit set and read back; no breakaway', () => {
    const job = port.createJob();
    try {
      port.clearInherit(job);
      assert.equal(port.handleFlags(job) & 0x1, 0);
      port.configure(job, 8);
      const limits = port.limits(job);
      report('limits', limits);
      assert.equal(limits.flags & JOB_REQUIRED_FLAGS, JOB_REQUIRED_FLAGS);
      assert.equal(limits.flags & JOB_FORBIDDEN_FLAGS, 0);
      assert.equal(limits.activeProcessLimit, 8);
      assert.deepEqual(port.members(job), { assigned: 0, listed: [] });
      assert.equal(port.accounting(job).activeProcesses, 0);
    } finally {
      port.close(job);
    }
  });

  it('PROC_THREAD_ATTRIBUTE_JOB_LIST: child is a member while still suspended; closing the Job kills it', async () => {
    const job = port.createJob();
    port.clearInherit(job);
    port.configure(job, 8);
    const l = launch('hold', 'killonclose', 60_000);
    assert.ok(port.createSuspendedInJob);
    const child = port.createSuspendedInJob(job, l.executablePath, l.commandLine, l.cwd, l.environmentBlock);
    try {
      assert.equal(port.isInJob(job, child.process), true);
      const members = port.members(job);
      assert.deepEqual(members, { assigned: 1, listed: [child.pid] });
      assert.equal(port.resume(child.thread), 1);
      await waitForFile('killonclose-root.json', 10_000);
      assert.equal(port.hasExited(child.process), false);
      const id = port.identity(child.process, child.pid);
      report('identity', id);
      assert.equal(id.imagePath.toLowerCase(), exe.toLowerCase());
      port.close(job); // last Job handle: kill-on-close must reap the member
      let exited = false;
      for (const end = Date.now() + 5_000; Date.now() < end && !exited; await sleep(25)) exited = port.hasExited(child.process);
      assert.equal(exited, true);
      report('kill-on-close-exit', port.exitCode(child.process));
    } finally {
      port.close(child.thread);
      port.close(child.process);
    }
  });

  it('legacy create-then-assign: outside the Job until assigned, then a member; TerminateJobObject reaps it', async () => {
    const job = port.createJob();
    port.clearInherit(job);
    port.configure(job, 8);
    const l = launch('hold', 'legacy', 60_000);
    const child = port.createSuspended(l.executablePath, l.commandLine, l.cwd, l.environmentBlock);
    try {
      assert.equal(port.isInJob(job, child.process), false);
      port.assign(job, child.process);
      assert.equal(port.isInJob(job, child.process), true);
      port.terminateJob(job, 0xe0003e02);
      let exited = false;
      for (const end = Date.now() + 5_000; Date.now() < end && !exited; await sleep(25)) exited = port.hasExited(child.process);
      assert.equal(exited, true);
      assert.equal(port.exitCode(child.process), 0xe0003e02);
      assert.equal(port.accounting(job).activeProcesses, 0);
    } finally {
      port.close(child.thread);
      port.close(child.process);
      port.close(job);
    }
  });
});

describe('H3 native: lifetime adapter end to end', () => {
  it('normal zero exit -> EXITED (ATOMIC, drained, full identity coverage, handles closed)', async () => {
    const r = await adapter().run(launch('normal', 'normal', 30_000));
    report('normal', { outcome: r.outcome, mode: r.assignmentMode, processes: r.processes, accounting: r.accounting, errors: r.errors });
    assert.equal(r.outcome, 'EXITED');
    assert.equal(r.assignmentMode, 'ATOMIC');
    assert.equal(r.orphanWindowExposed, false);
    assert.equal(r.drained, true);
    assert.equal(r.identityCoverageComplete, true);
    assert.equal(r.handlesClosed, true);
    assert.equal(r.quarantined, false);
    assert.equal(r.processes[0]?.exitCode, 0);
    assert.equal(r.processes[0]?.imagePath.toLowerCase(), exe.toLowerCase());
  });

  it('non-zero native exit -> FAILED with the real exit code', async () => {
    const r = await adapter().run(launch('error', 'error', 30_000));
    report('error', { outcome: r.outcome, processes: r.processes, errors: r.errors });
    assert.equal(r.outcome, 'FAILED');
    assert.equal(r.processes[0]?.exitCode, 17);
    assert.equal(r.drained, true);
  });

  it('timeout with a live descendant -> TIMEOUT; root and grandchild are both gone', async () => {
    const run = adapter().run(launch('tree', 'tree', 6_000));
    const rootPid = (await waitForFile('tree-root.json', 15_000)).pid;
    const leafPid = (await waitForFile('tree-leaf.json', 15_000)).pid;
    const r = await run;
    report('tree', { outcome: r.outcome, processes: r.processes, accounting: r.accounting, errors: r.errors, rootPid, leafPid });
    assert.equal(r.outcome, 'TIMEOUT');
    assert.equal(r.terminationProven, true);
    assert.equal(r.drained, true);
    assert.ok(r.processes.some(p => p.role === 'DESCENDANT' && p.pid === leafPid));
    assert.equal(alive(rootPid), false);
    assert.equal(alive(leafPid), false);
  });

  it('cancellation -> CANCELLED and drained', async () => {
    const controller = new AbortController();
    const run = adapter().run(launch('hold', 'cancel', 60_000), controller.signal);
    const rootPid = (await waitForFile('cancel-root.json', 15_000)).pid;
    controller.abort();
    const r = await run;
    report('cancel', { outcome: r.outcome, errors: r.errors });
    assert.equal(r.outcome, 'CANCELLED');
    assert.deepEqual(r.errors, [], 'H4: no racing TerminateProcess on a verified member root');
    assert.equal(r.drained, true);
    assert.equal(alive(rootPid), false);
  });
});
