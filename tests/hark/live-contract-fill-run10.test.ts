/**
 * Live contract-fill run 10 (hark-live-goal 42441418492) regression: step 1 finished, step 2 made
 * 126 model calls in six minutes and then went completely silent (no model call, no kernel output)
 * for 15 minutes; the attempt would only have ended at its 30-minute deadline, and the live
 * harness gave up first (IDLE_NO_PROGRESS). Fixes:
 *  1. an attempt that can no longer progress ends EARLY, exactly like its deadline (drain, proven
 *     stop, resumable `timeout`): a kernel silent past COS_KERNEL_SILENCE_MS (default 10 min,
 *     longer than the kernel shell's own 300 s tool timeout), or a wrap-up whose model calls are
 *     no longer admitted (the run-9 drain used to leave the kernel waiting until the deadline);
 *  2. the process provider exposes that early deadline as a composition seam (`earlyTimeout`);
 *  3. the retry's notes say why the attempt was stopped and how to avoid it;
 *  4. the live harness waits longer than silence + drain, and its JSON carries the last events.
 */
import { registerOfflineInline } from '../support/offline-fixtures.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createProcessExecutorProvider } from '@companyos/engine';
import {
  createAttemptEarlyStop,
  DEFAULT_KERNEL_SILENCE_MS,
  earlyStopHintOf,
  KERNEL_SILENCE_MAX_MS,
  KERNEL_SILENCE_MIN_MS,
  kernelSilenceMsOf,
} from '../../apps/desktop/src/executor/attempt-early-stop.js';
import { ATTEMPT_DEADLINE_INFLIGHT_GRACE_MS } from '../../apps/desktop/src/executor/dsh-executor-provider.js';
import { attemptNotesOf, renderAttemptNotes } from '../../apps/desktop/src/executor/kernel-failure-detail.js';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** A manual clock + timer queue (no real waiting). */
const fakeClock = () => {
  let now = 0;
  let timers: { at: number; callback: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    armTimer: (ms: number, callback: () => void) => {
      const timer = { at: now + ms, callback, live: true };
      timers.push(timer);
      return () => { timer.live = false; };
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        now = due.at;
        due.live = false;
        due.callback();
      }
      now = target;
      timers = timers.filter((t) => t.live);
    },
    pending: () => timers.filter((t) => t.live).length,
  };
};

describe('run 10 root fix: a silent attempt ends early', () => {
  it('fires KERNEL_SILENT only after the configured silence; activity postpones it', () => {
    const clock = fakeClock();
    const stop = createAttemptEarlyStop({ silenceMs: 600_000, now: clock.now, armTimer: clock.armTimer });
    const fired: string[] = [];
    stop.subscribe(() => fired.push('fired'));
    stop.start();
    clock.advance(400_000);
    stop.activity(); // kernel output at 400 s
    clock.advance(500_000); // 900 s: only 500 s of silence
    expect(fired).toEqual([]);
    expect(stop.reason()).toBeNull();
    clock.advance(100_000); // 1000 s: 600 s of silence
    expect(fired).toEqual(['fired']);
    expect(stop.reason()).toBe('KERNEL_SILENT');
    expect(clock.pending()).toBe(0);
  });

  it('the first reason wins, a late subscriber fires at once, and stop() disarms the watchdog', () => {
    const clock = fakeClock();
    const stop = createAttemptEarlyStop({ silenceMs: 600_000, now: clock.now, armTimer: clock.armTimer });
    stop.start();
    stop.fire('WRAP_UP_DRAINED');
    stop.fire('KERNEL_SILENT');
    expect(stop.reason()).toBe('WRAP_UP_DRAINED');
    let late = 0;
    stop.subscribe(() => { late += 1; });
    expect(late).toBe(1);

    const quiet = createAttemptEarlyStop({ silenceMs: 600_000, now: clock.now, armTimer: clock.armTimer });
    quiet.start();
    quiet.stop();
    clock.advance(10_000_000);
    expect(quiet.reason()).toBeNull();
  });

  it('the silence limit is configurable within bounds and outlasts the kernel shell timeout and the drain grace', () => {
    expect(kernelSilenceMsOf({})).toBe(DEFAULT_KERNEL_SILENCE_MS);
    expect(kernelSilenceMsOf({ COS_KERNEL_SILENCE_MS: '300000' })).toBe(300_000);
    expect(kernelSilenceMsOf({ COS_KERNEL_SILENCE_MS: String(KERNEL_SILENCE_MIN_MS - 1) })).toBe(DEFAULT_KERNEL_SILENCE_MS);
    expect(kernelSilenceMsOf({ COS_KERNEL_SILENCE_MS: String(KERNEL_SILENCE_MAX_MS + 1) })).toBe(DEFAULT_KERNEL_SILENCE_MS);
    expect(kernelSilenceMsOf({ COS_KERNEL_SILENCE_MS: 'soon' })).toBe(DEFAULT_KERNEL_SILENCE_MS);
    const materialize = readFileSync(join(process.cwd(), 'scripts', 'materialize-embedded-dsh.mjs'), 'utf8');
    const shellTimeout = Number(/timeoutMs: (\d+)/u.exec(materialize)?.[1]);
    expect(shellTimeout).toBeGreaterThan(0);
    expect(DEFAULT_KERNEL_SILENCE_MS).toBeGreaterThan(shellTimeout + 90_000);
  });

  it('the process provider ends a run on the early deadline exactly like the deadline (drain first, outcome timeout)', async () => {
    const code = 'setInterval(()=>{},1000)';
    registerOfflineInline(code);
    const dir = mkdtempSync(join(tmpdir(), 'early-'));
    dirs.push(dir);
    const order: string[] = [];
    let fireEarly: (() => void) | null = null;
    const provider = createProcessExecutorProvider({
      providerKey: 'fixture', capabilities: ['timeout'], executable: process.execPath,
      baseArgv: ['-e', code], fallbackCwd: dir, buildArgs: () => [],
      timer: (ms, callback) => { const handle = setTimeout(callback, ms === 5000 ? 40 : ms); return () => clearTimeout(handle); },
      beforeTimeoutStop: async () => { order.push('drain'); },
      earlyTimeout: (fire) => { fireEarly = fire; order.push('armed'); return () => { order.push('disarmed'); }; },
    });
    setTimeout(() => fireEarly?.(), 150);
    const started = Date.now();
    const outcome = await provider.start({
      companyId: 'c', runId: 'r', taskId: 't', attemptId: 'a', attemptNumber: 1, roleId: 'role', taskKind: 'k',
      work: { objective: 'fixture' }, workspace: null, requiredCapabilities: ['timeout'], dispatchKey: 'd', taskText: '', structured: false,
      timeoutMs: 60_000, // the real deadline is far away: only the early deadline can end it
    });
    expect(outcome.kind).toBe('timeout');
    expect(order).toEqual(['armed', 'drain', 'disarmed']);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe('run 10 root fix: the embedded kernel provider is wired to the early stop', () => {
  it('kernel output and model exchanges are activity; a drained wrap-up and the silence end the attempt early', () => {
    const source = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'executor', 'dsh-executor-provider.ts'), 'utf8');
    expect(source).toContain('earlyTimeout: (fire: () => void) => earlyStop.subscribe(fire)');
    expect(source).toMatch(/drainForWrapUp\(\);\s*earlyStop\.fire\('WRAP_UP_DRAINED'\)/u);
    expect(source).toMatch(/const tapStdoutLine = \(line: string\): void => \{\s*earlyStop\.activity\(\);/u);
    expect(source).toMatch(/observe: \(observation: ModelBrokerExchangeObservation\) => \{\s*earlyStop\.activity\(\);/u);
    expect(source).toContain("shouldStop: () => deadlineDraining || earlyStop.reason() !== null");
    expect(source).toContain('endReason: earlyStop.reason() ??');
  });
});

describe('run 10 root fix: the retry learns why the attempt was stopped', () => {
  it('notes of a silent or drained attempt carry an actionable hint; other reasons carry none', () => {
    const silent = renderAttemptNotes(attemptNotesOf({ taskId: 'tsk_2', attemptNumber: 1, outcome: 'timeout', endReason: 'KERNEL_SILENT', stdoutText: '' }));
    expect(silent).toContain('KERNEL_SILENT');
    expect(silent).toContain('never returned');
    expect(silent).toContain('background');
    expect(earlyStopHintOf('WRAP_UP_DRAINED')).toContain('wrap-up');
    expect(earlyStopHintOf('EXECUTOR_KERNEL_TURN_ERROR')).toBeNull();
    expect(earlyStopHintOf(null)).toBeNull();
  });
});

describe('run 10: the live harness waits longer than silence + drain and records the last events', () => {
  it('LIVE_IDLE_STOP_MS exceeds the silence limit plus the in-flight grace', () => {
    const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'hark-live-goal.yml'), 'utf8');
    const idle = Number(/LIVE_IDLE_STOP_MS: '(\d+)'/u.exec(workflow)?.[1]);
    expect(idle).toBeGreaterThan(DEFAULT_KERNEL_SILENCE_MS + ATTEMPT_DEADLINE_INFLIGHT_GRACE_MS);
  });
  it('the live JSON carries recentEvents and the summary prints them', () => {
    expect(readFileSync(join(process.cwd(), 'scripts', 'hark', 'live-goal-gui.mjs'), 'utf8')).toContain('recentEvents:');
    expect(readFileSync(join(process.cwd(), 'scripts', 'hark', 'live-summary.mjs'), 'utf8')).toContain('g.recentEvents');
  });
});
