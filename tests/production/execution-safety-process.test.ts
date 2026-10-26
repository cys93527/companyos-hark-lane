import { registerOfflineInline } from '../support/offline-fixtures.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProcessExecutorProvider, type ExecutorExecutionRequest } from '@companyos/engine';

const killMode = vi.hoisted(() => ({ fail: false }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcesses>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (args[0] === 'taskkill' && killMode.fail) return actual.spawn(process.execPath, ['-e', 'process.exit(5)'], args[2]);
    return actual.spawn(...args);
  } };
});
for (const code of ['process.exit(5)', 'console.log(process.pid);setInterval(()=>{},1000)', 'setInterval(()=>{},1000)', "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)"]) registerOfflineInline(code);
const dirs: string[] = [];
const owned: number[] = [];
const nativeKill = process.kill.bind(process);
beforeEach(() => {
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid < 0 && signal === 'SIGKILL' && killMode.fail) throw new Error('fixture tree termination denied');
    return nativeKill(pid, signal);
  });
});
afterEach(() => {
  killMode.fail = false;
  owned.splice(0).forEach((pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* fixture already exited */ } });
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
const fixture = (code: string, timerScale = false) => {
  registerOfflineInline(code);
  const dir = mkdtempSync(join(tmpdir(), 'bounded-process-'));
  dirs.push(dir);
  return { dir, provider: createProcessExecutorProvider({
    providerKey: 'local-fixture', capabilities: ['timeout', 'cancellation'], executable: process.execPath,
    baseArgv: ['-e', code], fallbackCwd: dir, buildArgs: () => [],
    timer: (ms, callback) => { const handle = setTimeout(callback, timerScale && ms === 5000 ? 40 : ms); return () => clearTimeout(handle); },
  }) };
};
const requestOf = (signal?: AbortSignal): ExecutorExecutionRequest => ({
  companyId: 'company', runId: 'run', taskId: 'task', attemptId: 'attempt', attemptNumber: 1, roleId: 'role', taskKind: 'fixture', work: { objective: 'local no-model fixture' }, workspace: null,
  requiredCapabilities: ['cancellation'], dispatchKey: 'dispatch', taskText: '', structured: false, signal,
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('execution safety: local owned process only (no kernel or ACL)', () => {
  it('does not spawn an already-cancelled request', async () => {
    const { dir, provider } = fixture("require('node:fs').writeFileSync('spawned.txt','unexpected')");
    const controller = new AbortController(); controller.abort();
    expect(await provider.start(requestOf(controller.signal))).toMatchObject({ kind: 'cancelled', terminationProven: true });
    expect(existsSync(join(dir, 'spawned.txt'))).toBe(false);
  });
  it('refuses an unenforceable requested deadline before creating a process', async () => {
    const { dir } = fixture('');
    const provider = createProcessExecutorProvider({ providerKey: 'fixture', capabilities: ['timeout'], executable: process.execPath, baseArgv: ['--version'], fallbackCwd: dir });
    expect(await provider.start({ ...requestOf(), timeoutMs: 10 })).toMatchObject({ kind: 'transport-failed', reasonCode: 'EXECUTOR_TIMER_REQUIRED' });
  });
  it('rechecks cancellation after argument preparation and before spawn', async () => {
    const { dir } = fixture('');
    const controller = new AbortController();
    const provider = createProcessExecutorProvider({
      providerKey: 'fixture', capabilities: ['cancellation'], executable: process.execPath, baseArgv: ['-e', "require('node:fs').writeFileSync('spawned.txt','unexpected')"], fallbackCwd: dir,
      buildArgs: () => { controller.abort(); return []; },
      timer: (ms, callback) => { const h = setTimeout(callback, ms); return () => clearTimeout(h); },
    });
    expect(await provider.start(requestOf(controller.signal))).toMatchObject({ kind: 'cancelled', terminationProven: true });
    expect(existsSync(join(dir, 'spawned.txt'))).toBe(false);
  });
  it('handles cancellation during a local execution and proves actual tree exit', async () => {
    const { dir } = fixture('');
    const controller = new AbortController();
    const pids: number[] = [];
    const provider = createProcessExecutorProvider({
      providerKey: 'fixture', capabilities: ['cancellation'], executable: process.execPath, baseArgv: ['-e', 'console.log(process.pid);setInterval(()=>{},1000)'], fallbackCwd: dir, buildArgs: () => [],
      tapStdoutLine: (line) => { pids.push(Number(line)); owned.push(Number(line)); controller.abort(); },
      timer: (ms, callback) => { const h = setTimeout(callback, ms); return () => clearTimeout(h); },
    });
    expect(await provider.start(requestOf(controller.signal))).toMatchObject({ kind: 'cancelled', terminationProven: true });
    expect(pids).toHaveLength(1);
    await expect.poll(() => alive(pids[0]!)).toBe(false);
  });
  it('captures actual timeout and stops the owned root and grandchild', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owned-tree-')); dirs.push(dir);
    const pids: number[] = [];
    // Load-independent (H15 CI hark-ubuntu 40254706085): the request deadline fires only once
    // the root has printed both pids, so a slow runner can no longer time the root out before
    // the grandchild exists (which made the run observe zero pids).
    let fireDeadline: (() => void) | undefined;
    let deadlineArmed = false;
    const provider = createProcessExecutorProvider({
      providerKey: 'fixture', capabilities: ['timeout'], executable: process.execPath, fallbackCwd: dir, buildArgs: () => [],
      baseArgv: ['-e', "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)"],
      tapStdoutLine: (line) => { const parsed = JSON.parse(line) as number[]; pids.push(...parsed); owned.push(...parsed); deadlineArmed = true; fireDeadline?.(); },
      timer: (ms, callback) => {
        if (ms === 800) {
          fireDeadline = callback;
          if (deadlineArmed) queueMicrotask(callback);
          return () => { fireDeadline = undefined; };
        }
        const handle = setTimeout(callback, ms); return () => clearTimeout(handle);
      },
    });
    const outcome = await provider.start({ ...requestOf(), timeoutMs: 800 });
    expect(pids).toHaveLength(2);
    expect(outcome).toMatchObject({ kind: 'timeout', terminationProven: true });
    await expect.poll(() => pids.some(alive)).toBe(false);
  });
  it('does not call a failed tree-kill proven merely because the root later exits', async () => {
    killMode.fail = true;
    const { provider } = fixture('setTimeout(()=>process.exit(0),250)');
    const outcome = await provider.start({ ...requestOf(), timeoutMs: 100 });
    expect(outcome).toMatchObject({ kind: 'timeout', terminationProven: false });
  });
  it('bounds failed cleanup, records residual uncertainty, and rejects late success', async () => {
    // Load-independent (H14): the fixture cannot exit until the test releases it, so the
    // provider can only return through the bounded cleanup timer (5000ms scaled to 40ms),
    // never by waiting for the unkillable process. No wall-clock bound is asserted.
    killMode.fail = true;
    const code = "console.log(process.pid);setInterval(()=>{if(require('node:fs').existsSync('release'))process.exit(0)},20)";
    registerOfflineInline(code);
    const dir = mkdtempSync(join(tmpdir(), 'bounded-process-')); dirs.push(dir);
    const pids: number[] = [];
    let fireDeadline: (() => void) | undefined;
    const provider = createProcessExecutorProvider({
      providerKey: 'local-fixture', capabilities: ['timeout', 'cancellation'], executable: process.execPath,
      baseArgv: ['-e', code], fallbackCwd: dir, buildArgs: () => [],
      // The request deadline fires only once the fixture is observably running (its pid line).
      tapStdoutLine: (line) => { pids.push(Number(line)); owned.push(Number(line)); fireDeadline?.(); },
      timer: (ms, callback) => {
        if (ms === 100) { fireDeadline = callback; return () => { fireDeadline = undefined; }; }
        const handle = setTimeout(callback, ms === 5000 ? 40 : ms); return () => clearTimeout(handle);
      },
    });
    const outcome = await provider.start({ ...requestOf(), timeoutMs: 100 });
    expect(outcome).toMatchObject({ kind: 'timeout', terminationProven: false });
    expect(pids).toHaveLength(1);
    // The provider returned while the owned process was still running: cleanup was bounded.
    expect(alive(pids[0]!)).toBe(true);
    // Late success: release the fixture, wait for its real exit, the outcome stays a timeout.
    writeFileSync(join(dir, 'release'), '');
    await expect.poll(() => alive(pids[0]!), { timeout: 30_000 }).toBe(false);
    expect(outcome).toMatchObject({ kind: 'timeout', terminationProven: false });
  });
  it('keeps output overflow uncertain when tree termination failed', async () => {
    killMode.fail = true;
    const { provider } = fixture("process.stdout.write('x'.repeat(1100000));setTimeout(()=>process.exit(0),250)");
    expect(await provider.start(requestOf())).toMatchObject({ kind: 'uncertain', reason: 'EXECUTOR_OUTPUT_LIMIT_TERMINATION_UNPROVEN' });
  });
});
import type * as ChildProcesses from 'node:child_process';
