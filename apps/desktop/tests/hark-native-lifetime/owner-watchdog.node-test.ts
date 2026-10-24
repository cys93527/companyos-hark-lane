/**
 * Hark lane 3B-3E — independent owner-hang watchdog contract (SIMULATED kernel).
 * Real watchdog process / DuplicateHandle / lease transport: NOT RUN (BLOCKED).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  armWatchdog, evaluateWatchdog, runOwnerWatchdog, validateWatchdogConfig, WATCHDOG_STOP_EXIT_CODE,
  type LeaseSnapshot, type WatchdogConfig, type WatchdogPort,
} from '../../src/executor/native-lifetime/owner-watchdog.js';
import { FakeWindowsKernel, type Script } from './fake-windows-kernel.js';

const config: WatchdogConfig = { heartbeatTimeoutMs: 100, startGraceMs: 50, hardDeadlineMs: 1_000 };

describe('watchdog decision (pure)', () => {
  it('continues while the sequence advances, terminates after silence on ITS OWN clock', () => {
    let s = armWatchdog(0);
    for (let t = 10, seq = 1; t <= 300; t += 10, seq += 1) {
      const step = evaluateWatchdog(s, { ownerExited: false, lease: { sequence: seq, released: false }, now: t }, config);
      assert.equal(step.decision.kind, 'CONTINUE');
      s = step.state;
    }
    const silent = evaluateWatchdog(s, { ownerExited: false, lease: { sequence: 30, released: false }, now: 399 }, config);
    assert.equal(silent.decision.kind, 'CONTINUE');
    const hung = evaluateWatchdog(s, { ownerExited: false, lease: { sequence: 30, released: false }, now: 400 }, config);
    assert.deepEqual(hung.decision, { kind: 'TERMINATE', trigger: 'OWNER_UNRESPONSIVE' });
  });
  it('owner exit is checked before everything else (watchdog handle disables kill-on-close)', () => {
    const step = evaluateWatchdog(armWatchdog(0), { ownerExited: true, lease: { sequence: 1, released: false }, now: 1 }, config);
    assert.deepEqual(step.decision, { kind: 'TERMINATE', trigger: 'OWNER_EXITED' });
    assert.deepEqual(evaluateWatchdog(armWatchdog(0), { ownerExited: true, lease: null, now: 1 }, config).decision, { kind: 'TERMINATE', trigger: 'OWNER_EXITED' });
  });
  it('H4: owner that released then exited -> RELEASED (drain still verified by the caller); a regressed release is not trusted', () => {
    assert.deepEqual(evaluateWatchdog(armWatchdog(0), { ownerExited: true, lease: { sequence: 15, released: true }, now: 1 }, config).decision, { kind: 'RELEASED' });
    const seen = evaluateWatchdog(armWatchdog(0), { ownerExited: false, lease: { sequence: 9, released: false }, now: 1 }, config).state;
    assert.deepEqual(evaluateWatchdog(seen, { ownerExited: true, lease: { sequence: 3, released: true }, now: 2 }, config).decision, { kind: 'TERMINATE', trigger: 'OWNER_EXITED' });
  });
  it('hard deadline bounds even a heartbeating runaway owner', () => {
    let s = armWatchdog(0);
    let last = evaluateWatchdog(s, { ownerExited: false, lease: { sequence: 1, released: false }, now: 1 }, config);
    for (let t = 10, seq = 2; t <= 1_000; t += 10, seq += 1) {
      last = evaluateWatchdog(s, { ownerExited: false, lease: { sequence: seq, released: false }, now: t }, config);
      s = last.state;
    }
    assert.deepEqual(last.decision, { kind: 'TERMINATE', trigger: 'HARD_DEADLINE' });
  });
  it('never-started lease, regressed sequence and vanished lease all terminate', () => {
    assert.equal(evaluateWatchdog(armWatchdog(0), { ownerExited: false, lease: null, now: 49 }, config).decision.kind, 'CONTINUE');
    assert.deepEqual(evaluateWatchdog(armWatchdog(0), { ownerExited: false, lease: null, now: 50 }, config).decision, { kind: 'TERMINATE', trigger: 'LEASE_NEVER_STARTED' });
    const s = evaluateWatchdog(armWatchdog(0), { ownerExited: false, lease: { sequence: 5, released: false }, now: 5 }, config).state;
    assert.deepEqual(evaluateWatchdog(s, { ownerExited: false, lease: { sequence: 4, released: false }, now: 6 }, config).decision, { kind: 'TERMINATE', trigger: 'LEASE_REGRESSED' });
    assert.deepEqual(evaluateWatchdog(s, { ownerExited: false, lease: null, now: 6 }, config).decision, { kind: 'TERMINATE', trigger: 'LEASE_REGRESSED' });
  });
  it('rejects unbounded or incoherent configuration', () => {
    assert.throws(() => validateWatchdogConfig({ ...config, hardDeadlineMs: 0 }));
    assert.throws(() => validateWatchdogConfig({ ...config, heartbeatTimeoutMs: 2_000 }));
    assert.throws(() => validateWatchdogConfig({ ...config, startGraceMs: 1.5 }));
  });
});

/** Owner launched a job then (simulated) hung or crashed; watchdog holds its own Job handle. */
function launchedJob(script: Script) {
  const k = new FakeWindowsKernel();
  k.rootScript = script;
  const port = k.port();
  const job = port.createJob();
  port.clearInherit(job);
  port.configure(job, 32);
  const root = port.createSuspendedInJob!(job, 'C:\\fixture.exe', 'fixture.exe', 'C:\\ws', new Uint8Array());
  port.resume(root.thread);
  const watchdogJob = k.duplicateJobForWatchdog(job);
  const lease: { current: LeaseSnapshot | null } = { current: null };
  let ownerExited = false;
  let terminateCalls = 0;
  const wport: WatchdogPort = {
    ownerExited: () => ownerExited,
    readLease: () => lease.current,
    terminateJob: code => { terminateCalls += 1; port.terminateJob(watchdogJob, code); },
    jobDrained: () => k.jobDrained(k.jobIdOf(watchdogJob)),
    closeJobHandle: () => port.close(watchdogJob),
  };
  return { k, port, job, lease, wport, setOwnerExited: () => { ownerExited = true; }, terminateCalls: () => terminateCalls };
}
const clockOf = (k: FakeWindowsKernel) => ({ clock: () => k.now, sleep: async (ms: number) => { k.advance(ms); } });

describe('watchdog against the simulated kernel', () => {
  it('live-but-hung owner: lease stops advancing -> watchdog terminates the Job and proves drain', async () => {
    const t = launchedJob({ spawn: [{ afterMs: 5, script: {} }] });
    t.lease.current = { sequence: 7, released: false }; // owner beat, then its event loop stalled forever
    const r = await runOwnerWatchdog({ port: t.wport, config, ...clockOf(t.k), pollMs: 10 });
    assert.equal(r.outcome, 'TERMINATED_DRAINED');
    assert.equal(r.trigger, 'OWNER_UNRESPONSIVE');
    assert.equal(t.k.liveProcesses().length, 0);
    assert.ok([...t.k.procs.values()].every(p => p.exitCode === WATCHDOG_STOP_EXIT_CODE));
  });
  it('HAZARD: with the watchdog holding a Job handle, owner crash alone does NOT kill; watchdog OWNER_EXITED does', async () => {
    const t = launchedJob({});
    t.lease.current = { sequence: 1, released: false };
    t.k.crashOwner();
    t.setOwnerExited();
    assert.equal(t.k.liveProcesses().length, 1, 'kill-on-close suppressed by the watchdog duplicate handle');
    const r = await runOwnerWatchdog({ port: t.wport, config, ...clockOf(t.k) });
    assert.equal(r.trigger, 'OWNER_EXITED');
    assert.equal(r.outcome, 'TERMINATED_DRAINED');
    assert.equal(t.k.liveProcesses().length, 0);
  });
  it('released lease with a drained Job ends quietly without terminating', async () => {
    const t = launchedJob({ exitAfterMs: 5, exitCode: 0 });
    t.k.advance(10);
    t.lease.current = { sequence: 3, released: true };
    const r = await runOwnerWatchdog({ port: t.wport, config, ...clockOf(t.k) });
    assert.equal(r.outcome, 'RELEASED_DRAINED');
    assert.equal(t.terminateCalls(), 0);
  });
  it('released lease while members still live is treated as a stop trigger', async () => {
    const t = launchedJob({});
    t.lease.current = { sequence: 3, released: true };
    const r = await runOwnerWatchdog({ port: t.wport, config, ...clockOf(t.k) });
    assert.equal(r.trigger, 'RELEASE_NOT_DRAINED');
    assert.equal(r.outcome, 'TERMINATED_DRAINED');
  });
  it('unreadable lease fails toward stopping', async () => {
    const t = launchedJob({});
    const r = await runOwnerWatchdog({ port: { ...t.wport, readLease: () => { throw new Error('lease-transport-broken'); } }, config, ...clockOf(t.k) });
    assert.equal(r.trigger, 'LEASE_REGRESSED');
    assert.equal(r.outcome, 'TERMINATED_DRAINED');
    assert.deepEqual(r.errors, ['lease-transport-broken']);
  });
  it('unkillable member -> STOP_UNPROVEN, reported, handle still closed', async () => {
    const t = launchedJob({ unkillable: true });
    t.lease.current = { sequence: 1, released: false };
    const r = await runOwnerWatchdog({ port: t.wport, config, ...clockOf(t.k), stopWaitMs: 100 });
    assert.equal(r.outcome, 'STOP_UNPROVEN');
    assert.equal(r.handleClosed, true);
    assert.equal(t.k.liveProcesses().length, 1);
  });
});
