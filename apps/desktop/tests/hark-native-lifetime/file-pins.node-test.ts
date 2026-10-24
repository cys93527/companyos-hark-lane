/**
 * Hark lane H5 — handle-pinned launch LOGIC under a simulated (Node fs) pin port.
 * Share-mode denial is NOT proven offline; see native/pins-native.win-test.ts.
 */
import assert from 'node:assert/strict';
import { renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ancestorsOf, LaunchPinRefused, pinLaunch, samePinnedPath } from '../../src/executor/native-lifetime/file-pins.js';
import { createJobLifetimeAdapter } from '../../src/executor/native-lifetime/job-lifetime.js';
import { FakeWindowsKernel } from './fake-windows-kernel.js';
import { createNodeFsPinPort } from './node-fs-pin-port.js';
import { makeWorkspace, SIMULATED_WINDOWS_HOST, verified } from './support.js';

const refusal = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof LaunchPinRefused) return e.reason; throw e; }
  return 'NOT-REFUSED';
};

describe('H5 pinLaunch', () => {
  it('pins the whole directory chain BEFORE the files, re-hashes through the handle, releases everything idempotently', () => {
    const ws = makeWorkspace();
    const pinPort = createNodeFsPinPort();
    const pins = pinLaunch(verified(ws), pinPort);
    const firstFile = pinPort.calls.findIndex(c => c.startsWith('openFilePinned'));
    const lastDir = pinPort.calls.map(c => c.startsWith('openDirectoryPinned')).lastIndexOf(true);
    assert.ok(lastDir < firstFile);
    assert.equal(pins.directoryCount, ancestorsOf(ws.exe).length);
    assert.deepEqual(pins.files.map(f => f.role), ['EXECUTABLE', 'INPUT']);
    assert.ok(samePinnedPath(pins.executableFinalPath, ws.exe));
    assert.equal(pinPort.openCount(), pins.directoryCount + 2);
    assert.deepEqual(pins.release(), []);
    assert.equal(pinPort.openCount(), 0);
    assert.deepEqual(pins.release(), []);
  });
  it('a file rewritten after verifyLaunch is refused (hash through handle), and partial pins are released', () => {
    const ws = makeWorkspace();
    const launch = verified(ws);
    writeFileSync(ws.script, '/* swapped */');
    const pinPort = createNodeFsPinPort();
    assert.match(refusal(() => pinLaunch(launch, pinPort)), /^(hash-mismatch|size-changed):/u);
    assert.equal(pinPort.openCount(), 0);
  });
  it('a path swapped to a symlink after verification is refused as a reparse point', () => {
    const ws = makeWorkspace();
    const launch = verified(ws);
    renameSync(ws.script, `${ws.script}.real`);
    symlinkSync(`${ws.script}.real`, ws.script);
    const pinPort = createNodeFsPinPort();
    assert.match(refusal(() => pinLaunch(launch, pinPort)), /^reparse-point:/u);
    assert.equal(pinPort.openCount(), 0);
  });
  it('a handle whose final path differs from the requested path (junction / short name) is refused', () => {
    const ws = makeWorkspace();
    const pinPort = createNodeFsPinPort();
    pinPort.redirect.set(ws.exe, `${ws.root}/elsewhere.exe`);
    assert.match(refusal(() => pinLaunch(verified(ws), pinPort)), /^path-redirected:/u);
    assert.equal(pinPort.openCount(), 0);
  });
  it('windows path helpers: \\\\?\\ prefix, case-insensitive compare, drive-root-first ancestors', () => {
    assert.ok(samePinnedPath('C:\\Work\\A.EXE', 'c:\\work\\a.exe'));
    assert.deepEqual(ancestorsOf('C:\\a\\b\\c.exe'), ['C:\\', 'C:\\a', 'C:\\a\\b']);
  });
});

describe('H5 adapter: pinned launch is the default', () => {
  const base = (kernel: FakeWindowsKernel) => ({ clock: () => kernel.now, sleep: async (ms: number) => { kernel.advance(ms); }, host: SIMULATED_WINDOWS_HOST, pollMs: 10 });
  it('REQUIRED (default) without a pin port refuses with zero native calls', async () => {
    const kernel = new FakeWindowsKernel();
    const r = await createJobLifetimeAdapter({ port: kernel.port(), ...base(kernel) }).run(verified(makeWorkspace()));
    assert.equal(r.outcome, 'LAUNCH_FAILED');
    assert.equal(r.errors[0]?.operation, 'launch-pinning-unavailable');
    assert.deepEqual(kernel.calls, []);
  });
  it('pins before the Job, checks the image path before resume, releases pins after handles close', async () => {
    const kernel = new FakeWindowsKernel();
    const pinPort = createNodeFsPinPort();
    const r = await createJobLifetimeAdapter({ port: kernel.port(), pinPort, ...base(kernel) }).run(verified(makeWorkspace()));
    assert.equal(r.outcome, 'EXITED');
    assert.equal(r.launchPinned, true);
    const order = r.events.map(e => e.name);
    for (const [a, b] of [['launch-pinned', 'job-created'], ['image-path-verified', 'resumed'], ['handles-close-attempted', 'pins-released']] as const) {
      assert.ok(order.indexOf(a) >= 0 && order.indexOf(a) < order.indexOf(b), `${a} before ${b}`);
    }
    assert.equal(pinPort.openCount(), 0);
  });
  it('tampered input -> LAUNCH_FAILED before any Job or process exists', async () => {
    const kernel = new FakeWindowsKernel();
    const ws = makeWorkspace();
    const launch = verified(ws);
    writeFileSync(ws.exe, 'MZ-swapped');
    const pinPort = createNodeFsPinPort();
    const r = await createJobLifetimeAdapter({ port: kernel.port(), pinPort, ...base(kernel) }).run(launch);
    assert.equal(r.outcome, 'LAUNCH_FAILED');
    assert.ok(r.errors.some(e => /^launch-pin-(hash-mismatch|size-changed)$/u.test(e.operation)));
    assert.deepEqual(kernel.calls, []);
    assert.equal(pinPort.openCount(), 0);
  });
  it('root image path differing from the pinned executable -> never resumed, LAUNCH_FAILED, nothing left alive', async () => {
    const kernel = new FakeWindowsKernel();
    const real = kernel.port();
    const port = { ...real, identity: (h: bigint, pid: number) => ({ ...real.identity(h, pid), imagePath: 'C:\\Other\\impostor.exe' }) };
    const pinPort = createNodeFsPinPort();
    const r = await createJobLifetimeAdapter({ port, pinPort, ...base(kernel) }).run(verified(makeWorkspace()));
    assert.equal(r.outcome, 'LAUNCH_FAILED');
    assert.equal(r.resumed, false);
    assert.ok(r.errors.some(e => e.operation === 'image-path-mismatch'));
    assert.equal(kernel.calls.includes('resume'), false);
    assert.equal(kernel.liveProcesses().length, 0);
    assert.equal(pinPort.openCount(), 0);
  });
  it('NOT_ENFORCED is explicit and reported (launchPinned false)', async () => {
    const kernel = new FakeWindowsKernel();
    const r = await createJobLifetimeAdapter({ port: kernel.port(), launchPinning: 'NOT_ENFORCED', ...base(kernel) }).run(verified(makeWorkspace()));
    assert.equal(r.outcome, 'EXITED');
    assert.equal(r.launchPinned, false);
  });
});
