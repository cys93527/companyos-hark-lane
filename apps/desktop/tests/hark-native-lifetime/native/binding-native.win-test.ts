/**
 * Hark lane H4 — NATIVE binding-failure evidence (Windows x64 CI): a process
 * that cannot be bound to its Job is never resumed and really exits.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createJobLifetimeAdapter } from '../../../src/executor/native-lifetime/job-lifetime.js';
import { COMPANYOS_STOP_EXIT_CODE, NativeJobError, type WindowsJobPort } from '../../../src/executor/native-lifetime/job-port.js';
import { createKoffiJobPort } from '../../../src/executor/native-lifetime/koffi-job-port.js';
import { verifyLaunch, type VerifiedLaunch } from '../../../src/executor/native-lifetime/launch-pins.js';
import { evidence, loadKoffi, makeNativeWorkspace, sleep } from './native-support.js';

const port = createKoffiJobPort(loadKoffi());
const ws = makeNativeWorkspace('hark-h4-bind');
const createInJob: NonNullable<WindowsJobPort['createSuspendedInJob']> = (() => {
  const f = port.createSuspendedInJob;
  if (!f) throw new Error('atomic-create-missing');
  return f;
})();

function launch(mode: string, tag: string): VerifiedLaunch {
  return verifyLaunch({
    identity: { runId: `h4-${tag}`, taskId: 'bind', attemptId: '1' },
    executable: { path: ws.exe, sha256: ws.exeSha },
    inputs: [{ path: ws.script, sha256: ws.scriptSha }],
    argv: [ws.script, mode, tag],
    workspaceRoot: ws.root,
    cwd: ws.root,
    environment: { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows', TEMP: ws.temp, TMP: ws.temp, COMPANYOS_TEST_MODE: 'OFFLINE' },
    timeoutMs: 30_000,
  }, { platform: 'win32', requireExeSuffix: true, maxTimeoutMs: 600_000 });
}

async function waitExited(h: bigint, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (port.hasExited(h)) return true;
  return port.hasExited(h);
}

describe('H4 native: binding failure never resumes', () => {
  it('legacy assign into a Job at its active-process limit fails natively; the suspended process is terminated, never ran', async () => {
    const job = port.createJob();
    port.clearInherit(job);
    port.configure(job, 1);
    const holder = launch('hold', 'full-holder');
    const first = createInJob(job, holder.executablePath, holder.commandLine, holder.cwd, holder.environmentBlock);
    const second = launch('normal', 'never-ran');
    const victim = port.createSuspended(second.executablePath, second.commandLine, second.cwd, second.environmentBlock);
    try {
      let code: number | null = null;
      try { port.assign(job, victim.process); } catch (e) { code = e instanceof NativeJobError ? e.nativeCode : -1; }
      evidence('assign-over-limit', { nativeCode: code });
      assert.notEqual(code, null, 'AssignProcessToJobObject must fail over the active limit');
      assert.equal(port.isInJob(job, victim.process), false);
      port.terminateProcess(victim.process, COMPANYOS_STOP_EXIT_CODE);
      assert.equal(await waitExited(victim.process, 5_000), true);
      assert.equal(port.exitCode(victim.process), COMPANYOS_STOP_EXIT_CODE);
      assert.equal(existsSync(join(ws.root, 'never-ran-root.json')), false, 'the process never executed');
    } finally {
      port.close(victim.thread); port.close(victim.process);
      port.terminateJob(job, COMPANYOS_STOP_EXIT_CODE);
      port.close(first.thread); port.close(first.process); port.close(job);
    }
  });

  it('ATOMIC create into a Job at its active-process limit: no process runs outside the Job', async () => {
    const job = port.createJob();
    port.clearInherit(job);
    port.configure(job, 1);
    const holder = launch('hold', 'atomic-holder');
    const first = createInJob(job, holder.executablePath, holder.commandLine, holder.cwd, holder.environmentBlock);
    const second = launch('normal', 'atomic-never-ran');
    try {
      let code: number | null = null;
      let created: { pid: number; inJob: boolean } | null = null;
      try {
        const p = createInJob(job, second.executablePath, second.commandLine, second.cwd, second.environmentBlock);
        created = { pid: p.pid, inJob: port.isInJob(job, p.process) };
        port.terminateProcess(p.process, COMPANYOS_STOP_EXIT_CODE);
        port.close(p.thread); port.close(p.process);
      } catch (e) { code = e instanceof NativeJobError ? e.nativeCode : -1; }
      evidence('atomic-over-limit', { nativeCode: code, created });
      // Either CreateProcessW refuses outright, or (never observed) it would have to be inside the Job.
      assert.ok(code !== null || created?.inJob === true);
      assert.deepEqual(port.members(job), { assigned: 1, listed: [first.pid] });
      await sleep(300);
      assert.equal(existsSync(join(ws.root, 'atomic-never-ran-root.json')), false);
    } finally {
      port.terminateJob(job, COMPANYOS_STOP_EXIT_CODE);
      port.close(first.thread); port.close(first.process); port.close(job);
    }
  });

  it('adapter: membership read-back failure -> LAUNCH_FAILED, never resumed, root really exits with the stop code', async () => {
    // Only the ROOT membership read-back lies (first call); later identity checks are real.
    let calls = 0;
    const lying: WindowsJobPort = { ...port, isInJob: (job, p) => (calls++ === 0 ? false : port.isInJob(job, p)) };
    const r = await createJobLifetimeAdapter({ port: lying, clock: () => Date.now(), sleep, pollMs: 20, stopWaitMs: 5_000 }).run(launch('normal', 'unverified'));
    evidence('membership-unverified', { outcome: r.outcome, resumed: r.resumed, processes: r.processes, errors: r.errors });
    assert.equal(r.outcome, 'LAUNCH_FAILED');
    assert.equal(r.resumed, false);
    assert.ok(r.errors.some(e => e.operation === 'membership-unverified'));
    assert.equal(r.errors.some(e => e.operation === 'TerminateProcess'), false, 'H4: ACCESS_DENIED on an exiting root is benign once exit is proven');
    assert.equal(r.processes[0]?.exitCode, COMPANYOS_STOP_EXIT_CODE);
    assert.equal(existsSync(join(ws.root, 'unverified-root.json')), false, 'the root never executed');
  });
});
