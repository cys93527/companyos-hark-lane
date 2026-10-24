/**
 * Hark lane 3B-3E — lifetime adapter contract under a SIMULATED Win32 kernel.
 * Native Windows evidence: NOT RUN (Linux host, binding not approved).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createJobLifetimeAdapter, type LifetimeOptions, type OwnerLeaseWriter } from '../../src/executor/native-lifetime/job-lifetime.js';
import { COMPANYOS_STOP_EXIT_CODE } from '../../src/executor/native-lifetime/job-port.js';
import type { VerifiedLaunch } from '../../src/executor/native-lifetime/launch-pins.js';
import { FakeWindowsKernel, withoutAtomic, type Fault, type Script } from './fake-windows-kernel.js';
import { makeWorkspace, SIMULATED_WINDOWS_HOST, verified } from './support.js';

const ws = makeWorkspace();

function setup(opts: { faults?: Fault[]; script?: Script; legacy?: boolean; noAtomic?: boolean; lease?: OwnerLeaseWriter; onSleep?: (k: FakeWindowsKernel) => void; stopWaitMs?: number } = {}) {
  const kernel = new FakeWindowsKernel();
  for (const f of opts.faults ?? []) kernel.faults.add(f);
  if (opts.script) kernel.rootScript = opts.script;
  const port = opts.noAtomic ? withoutAtomic(kernel.port()) : kernel.port();
  const options: LifetimeOptions = {
    port,
    clock: () => kernel.now,
    sleep: async ms => { kernel.advance(ms); opts.onSleep?.(kernel); },
    host: SIMULATED_WINDOWS_HOST,
    assignment: opts.legacy ? 'LEGACY_ASSIGN_ALLOWED' : 'ATOMIC_REQUIRED',
    pollMs: 10,
    stopWaitMs: opts.stopWaitMs ?? 200,
    ...(opts.lease ? { lease: opts.lease } : {}),
  };
  return { kernel, adapter: createJobLifetimeAdapter(options) };
}
const launch = (timeoutMs = 1_000): VerifiedLaunch => verified(ws, { timeoutMs });
const idx = (calls: string[], name: string): number => calls.indexOf(name);

describe('3B-3E lifetime: normal completion', () => {
  it('EXITED only after drain, with Job configured before any process exists', async () => {
    const { kernel, adapter } = setup();
    const r = await adapter.run(launch());
    assert.equal(r.outcome, 'EXITED');
    assert.equal(r.assignmentMode, 'ATOMIC');
    assert.equal(r.orphanWindowExposed, false);
    assert.equal(r.resumed, true);
    assert.equal(r.drained, true);
    assert.equal(r.identityCoverageComplete, true);
    assert.deepEqual(r.processes.map(p => [p.role, p.exitCode]), [['ROOT', 0]]);
    assert.ok(idx(kernel.calls, 'configure') < idx(kernel.calls, 'createSuspendedInJob'));
    assert.ok(idx(kernel.calls, 'clearInherit') < idx(kernel.calls, 'createSuspendedInJob'));
    assert.ok(idx(kernel.calls, 'createSuspendedInJob') < idx(kernel.calls, 'resume'));
    assert.equal(kernel.calls.filter(c => c === 'resume').length, 1);
    assert.equal(kernel.openHandleCount(), 0);
    assert.equal(kernel.liveProcesses().length, 0);
    assert.equal(r.quarantined, false);
  });

  it('non-zero native exit is FAILED, never EXITED', async () => {
    const { adapter } = setup({ script: { exitAfterMs: 15, exitCode: 3 } });
    const r = await adapter.run(launch());
    assert.equal(r.outcome, 'FAILED');
    assert.equal(r.terminationProven, true);
  });

  it('observes descendants by Job membership and waits for them', async () => {
    const { kernel, adapter } = setup({ script: { exitAfterMs: 12, exitCode: 0, spawn: [{ afterMs: 3, script: { exitAfterMs: 60, exitCode: 0 } }] } });
    const r = await adapter.run(launch());
    assert.equal(r.outcome, 'EXITED');
    assert.deepEqual(r.processes.map(p => p.role), ['ROOT', 'DESCENDANT']);
    assert.ok(r.processes.every(p => p.exitCode === 0));
    assert.equal(r.accounting?.totalProcesses, 2);
    assert.equal(kernel.liveProcesses().length, 0);
  });

  it('a drained Job with an unobserved fast-exit member is FAILED (coverage incomplete), not EXITED and not a timeout', async () => {
    const { adapter } = setup({ script: { exitAfterMs: 25, exitCode: 0, spawn: [{ afterMs: 12, script: { exitAfterMs: 0, exitCode: 0 } }] } });
    const r = await adapter.run(launch());
    assert.equal(r.outcome, 'FAILED');
    assert.equal(r.identityCoverageComplete, false);
    assert.equal(r.terminationProven, true);
    assert.ok(r.errors.some(e => e.operation === 'unobserved-member-exit'));
    assert.ok((r.events.at(-1)?.atMs ?? 0) < 1_000, 'decided on drain, not by waiting for the deadline');
  });
});

describe('3B-3E lifetime: cancellation, timeout, races', () => {
  it('TIMEOUT stops root and descendants; Job active count reaches zero', async () => {
    const { kernel, adapter } = setup({ script: { spawn: [{ afterMs: 5, script: { spawn: [{ afterMs: 5, script: {} }] } }] } });
    const r = await adapter.run(launch(100));
    assert.equal(r.outcome, 'TIMEOUT');
    assert.equal(r.terminationProven, true);
    assert.equal(r.processes.length, 3);
    assert.ok(r.processes.every(p => p.exitCode === COMPANYOS_STOP_EXIT_CODE));
    assert.equal(r.accounting?.activeProcesses, 0);
    assert.equal(kernel.liveProcesses().length, 0);
  });

  it('cancellation observed first wins over a late zero exit', async () => {
    const controller = new AbortController();
    const { adapter } = setup({ script: { exitAfterMs: 35, exitCode: 0 }, onSleep: k => { if (k.now >= 30) controller.abort(); } });
    const r = await adapter.run(launch(), controller.signal);
    assert.equal(r.outcome, 'CANCELLED');
    assert.equal(r.terminationProven, true);
  });

  it('abort before create performs zero native calls', async () => {
    const controller = new AbortController();
    controller.abort();
    const { kernel, adapter } = setup();
    const r = await adapter.run(launch(), controller.signal);
    assert.equal(r.outcome, 'CANCELLED');
    assert.deepEqual(kernel.calls, []);
  });

  it('a concurrent second launch on one adapter instance is refused, not queued', async () => {
    const controller = new AbortController();
    const { kernel, adapter } = setup({ script: {}, onSleep: k => { if (k.now >= 50) controller.abort(); } });
    const first = adapter.run(launch(), controller.signal);
    const second = await adapter.run(launch());
    assert.equal(second.outcome, 'LAUNCH_FAILED');
    assert.equal(second.errors[0]?.operation, 'adapter-busy');
    assert.equal((await first).outcome, 'CANCELLED');
    assert.equal(kernel.liveProcesses().length, 0);
  });

  it('active process limit bounds a fork storm; everything is reaped on timeout', async () => {
    const storm = Array.from({ length: 40 }, (_, i) => ({ afterMs: 1 + i, script: {} }));
    const { kernel, adapter } = setup({ script: { spawn: storm } });
    const r = await adapter.run(launch(200));
    assert.equal(r.outcome, 'TIMEOUT');
    assert.ok((r.accounting?.totalProcesses ?? 99) <= 32);
    assert.equal(kernel.liveProcesses().length, 0);
  });
});

describe('3B-3E lifetime: fail-closed launch (never resume)', () => {
  const neverRan = (k: FakeWindowsKernel): void => {
    assert.equal(k.executedCount, 0, 'no process ever executed code');
    assert.equal(k.liveProcesses().length, 0);
    assert.equal(k.openHandleCount(), 0);
  };
  it('ATOMIC_REQUIRED without the atomic path refuses before any native call', async () => {
    const { kernel, adapter } = setup({ noAtomic: true });
    const r = await adapter.run(launch());
    assert.equal(r.outcome, 'LAUNCH_FAILED');
    assert.equal(r.errors[0]?.operation, 'atomic-job-assignment-unavailable');
    assert.deepEqual(kernel.calls, []);
  });
  for (const [fault, expected] of [
    ['createJobThrows', 'CreateJobObjectW'],
    ['inheritStuck', 'job-handle-inheritable'],
    ['configureDropsKillOnClose', 'job-limits-unverified'],
    ['configureAddsBreakaway', 'job-limits-unverified'],
    ['createProcessThrows', 'CreateProcessW'],
    ['atomicCreateNotMember', 'membership-unverified'],
    ['resumeReturnsZero', 'unexpected-suspend-count'],
    ['resumeReturnsTwo', 'unexpected-suspend-count'],
  ] as const) {
    it(`${fault} -> LAUNCH_FAILED (${expected}), nothing executed`, async () => {
      const { kernel, adapter } = setup({ faults: [fault] });
      const r = await adapter.run(launch());
      assert.equal(r.outcome, 'LAUNCH_FAILED');
      assert.equal(r.resumed, false);
      assert.equal(r.errors[0]?.operation, expected);
      assert.equal(r.terminationProven, true);
      neverRan(kernel);
      if (['inheritStuck', 'configureDropsKillOnClose', 'configureAddsBreakaway'].includes(fault)) {
        assert.equal(kernel.calls.includes('createSuspendedInJob'), false, 'no process created in an unverified Job');
      }
    });
  }
  it('legacy path works only when explicitly allowed and reports the orphan window', async () => {
    const { adapter } = setup({ legacy: true, noAtomic: true });
    const r = await adapter.run(launch());
    assert.equal(r.outcome, 'EXITED');
    assert.equal(r.assignmentMode, 'LEGACY_ASSIGN');
    assert.equal(r.orphanWindowExposed, true);
  });
  for (const fault of ['assignThrows', 'assignSilentlyIgnored'] as const) {
    it(`legacy ${fault}: suspended root is terminated, never resumed`, async () => {
      const { kernel, adapter } = setup({ legacy: true, noAtomic: true, faults: [fault] });
      const r = await adapter.run(launch());
      assert.equal(r.outcome, 'LAUNCH_FAILED');
      assert.equal(kernel.calls.includes('resume'), false);
      assert.equal(kernel.calls.includes('terminateProcess'), true);
      neverRan(kernel);
    });
  }
  it('an unminted launch object and a non-Windows host are refused with zero native calls', async () => {
    const { kernel, adapter } = setup();
    const forged = { ...launch() } as VerifiedLaunch;
    assert.equal((await adapter.run(forged)).errors[0]?.operation, 'launch-not-verified');
    const linux = createJobLifetimeAdapter({ port: kernel.port(), clock: () => 0, sleep: async () => {}, host: { platform: 'linux', arch: 'x64' } });
    assert.equal((await linux.run(launch())).errors[0]?.operation, 'unsupported-host');
    assert.deepEqual(kernel.calls, []);
  });
});

describe('3B-3E lifetime: uncertain stop is STOP_UNPROVEN and quarantines', () => {
  it('truncated member list is never treated as complete: run fails, stop must re-prove an empty Job', async () => {
    const { kernel, adapter } = setup({ faults: ['membersTruncated'], script: { exitAfterMs: 15 } });
    const r = await adapter.run(launch());
    assert.equal(r.outcome, 'FAILED', 'not EXITED even though the root would have exited 0');
    assert.ok(r.errors.some(e => e.operation === 'member-list-truncated'));
    assert.equal(r.terminationProven, true, 'post-terminate read-back is consistent (assigned 0, listed 0)');
    assert.equal(kernel.liveProcesses().length, 0);
  });
  it('persistent truncation with a surviving member -> STOP_UNPROVEN, quarantined, next launch refused', async () => {
    const { adapter } = setup({ faults: ['membersTruncated'], script: { unkillable: true } });
    const r = await adapter.run(launch());
    assert.equal(r.outcome, 'STOP_UNPROVEN');
    assert.equal(adapter.quarantined, true);
    const next = await adapter.run(launch());
    assert.equal(next.errors[0]?.operation, 'adapter-quarantined');
  });
  it('ineffective terminate -> STOP_UNPROVEN; closing the Job still kills via kill-on-close', async () => {
    const { kernel, adapter } = setup({ faults: ['terminateJobIneffective'], script: {} });
    const r = await adapter.run(launch(50));
    assert.equal(r.outcome, 'STOP_UNPROVEN');
    assert.equal(r.quarantined, true);
    assert.equal(kernel.liveProcesses().length, 0, 'last Job handle close reaped the members');
  });
  it('an unkillable member stays reported, never hidden as success', async () => {
    const { kernel, adapter } = setup({ script: { unkillable: true } });
    const r = await adapter.run(launch(50));
    assert.equal(r.outcome, 'STOP_UNPROVEN');
    assert.equal(r.drained, false);
    assert.equal(kernel.liveProcesses().length, 1);
  });
  it('query failure during supervision -> STOP_UNPROVEN', async () => {
    const { adapter } = setup({ faults: ['membersThrowAfterResume'], script: {} });
    const r = await adapter.run(launch());
    assert.equal(r.outcome, 'STOP_UNPROVEN');
  });
  it('a failed handle close turns a drained run into STOP_UNPROVEN', async () => {
    const { adapter } = setup({ faults: ['closeThrows'] });
    const r = await adapter.run(launch());
    assert.equal(r.drained, true);
    assert.equal(r.handlesClosed, false);
    assert.equal(r.outcome, 'STOP_UNPROVEN');
  });
});

describe('3B-3E lifetime: owner crash and lease', () => {
  it('owner crash mid-run: kill-on-close reaps root and descendants; zero exit is never promoted', async () => {
    let crashed = false;
    const { kernel, adapter } = setup({
      script: { exitAfterMs: 500, exitCode: 0, spawn: [{ afterMs: 5, script: {} }] },
      onSleep: k => { if (!crashed && k.now >= 30) { crashed = true; k.crashOwner(); } },
    });
    const r = await adapter.run(launch());
    assert.equal(crashed, true);
    assert.equal(kernel.liveProcesses().length, 0);
    assert.notEqual(r.outcome, 'EXITED');
  });
  it('heartbeats advance monotonically; release only after proven drain', async () => {
    const beats: number[] = [];
    let released = 0;
    const lease: OwnerLeaseWriter = { beat: s => { beats.push(s); }, release: () => { released += 1; } };
    const { adapter } = setup({ lease });
    assert.equal((await adapter.run(launch())).outcome, 'EXITED');
    assert.ok(beats.length >= 2);
    assert.ok(beats.every((b, i) => b === i + 1));
    assert.equal(released, 1);
    const bad = setup({ lease: { beat: () => {}, release: () => { released += 10; } }, script: { unkillable: true } });
    assert.equal((await bad.adapter.run(launch(30))).outcome, 'STOP_UNPROVEN');
    assert.equal(released, 1, 'no release after an unproven stop');
  });
});
