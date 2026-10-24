/**
 * Hark lane H5 — NATIVE handle-pinned launch evidence (Windows x64 CI).
 * While pinned: the executable and inputs cannot be written, deleted or renamed
 * (also not through a hard link), and the directory chain cannot be renamed.
 * Reparse redirection and post-verify tampering are refused before any Job.
 */
import assert from 'node:assert/strict';
import { copyFileSync, linkSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LaunchPinRefused, pinLaunch } from '../../../src/executor/native-lifetime/file-pins.js';
import { createJobLifetimeAdapter } from '../../../src/executor/native-lifetime/job-lifetime.js';
import { createKoffiFilePinPort, createKoffiJobPort } from '../../../src/executor/native-lifetime/koffi-job-port.js';
import { verifyLaunch, type VerifiedLaunch } from '../../../src/executor/native-lifetime/launch-pins.js';
import { evidence, loadKoffi, makeNativeWorkspace, sha256, sleep, waitForJson, type NativeWorkspace } from './native-support.js';

const koffi = loadKoffi();
const port = createKoffiJobPort(koffi);
const pinPort = createKoffiFilePinPort(koffi);

function launchFor(ws: NativeWorkspace, exe: string, script: string, mode: string, tag: string): VerifiedLaunch {
  return verifyLaunch({
    identity: { runId: `h5-${tag}`, taskId: 'pins', attemptId: '1' },
    executable: { path: exe, sha256: sha256(readFileSync(exe)) },
    inputs: [{ path: script, sha256: sha256(readFileSync(script)) }],
    argv: [script, mode, tag],
    workspaceRoot: ws.root,
    cwd: ws.root,
    environment: { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows', TEMP: ws.temp, TMP: ws.temp, COMPANYOS_TEST_MODE: 'OFFLINE' },
    timeoutMs: 60_000,
  }, { platform: 'win32', requireExeSuffix: true, maxTimeoutMs: 600_000 });
}

/** Returns the error code the mutation failed with, or 'ALLOWED'. */
function attempt(fn: () => void): string {
  try { fn(); return 'ALLOWED'; } catch (e) { return (e as NodeJS.ErrnoException).code ?? 'ERROR'; }
}

const refusal = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof LaunchPinRefused) return e.reason; throw e; }
  return 'NOT-REFUSED';
};

describe('H5 native: share-mode pins', () => {
  it('pinned exe/input cannot be written, deleted, renamed (nor via a hard link); the directory chain cannot be renamed; reads still work; all allowed again after release', () => {
    const ws = makeNativeWorkspace('hark-h5-pin');
    const sub = join(ws.root, 'bin');
    mkdirSync(sub);
    const exe = join(sub, 'node.exe');
    copyFileSync(ws.exe, exe);
    const hard = join(ws.root, 'fixture-hardlink.cjs');
    linkSync(ws.script, hard);
    const pins = pinLaunch(launchFor(ws, exe, ws.script, 'normal', 'pin'), pinPort);
    const held = {
      exeWrite: attempt(() => closeSync(openSync(exe, 'r+'))),
      exeDelete: attempt(() => unlinkSync(exe)),
      exeRename: attempt(() => renameSync(exe, `${exe}.moved`)),
      scriptWrite: attempt(() => writeFileSync(ws.script, 'swapped')),
      scriptRenameOver: attempt(() => { writeFileSync(join(ws.root, 'evil.cjs'), 'evil'); renameSync(join(ws.root, 'evil.cjs'), ws.script); }),
      hardLinkWrite: attempt(() => writeFileSync(hard, 'swapped-through-link')),
      parentDirRename: attempt(() => renameSync(sub, `${sub}-moved`)),
      workspaceRename: attempt(() => renameSync(ws.root, `${ws.root}-moved`)),
      scriptRead: attempt(() => readFileSync(ws.script)),
      exeRead: attempt(() => readFileSync(exe)),
    };
    evidence('pins-held', { held, directoryCount: pins.directoryCount, files: pins.files, executableFinalPath: pins.executableFinalPath });
    assert.deepEqual(pins.release(), []);
    const released = {
      scriptRename: attempt(() => { renameSync(ws.script, `${ws.script}.x`); renameSync(`${ws.script}.x`, ws.script); }),
      parentDirRename: attempt(() => { renameSync(sub, `${sub}-moved`); renameSync(`${sub}-moved`, sub); }),
    };
    evidence('pins-released', released);
    for (const [k, v] of Object.entries(held)) {
      if (k === 'scriptRead' || k === 'exeRead') assert.equal(v, 'ALLOWED', k);
      else assert.notEqual(v, 'ALLOWED', `${k} must be denied while pinned`);
    }
    assert.deepEqual(released, { scriptRename: 'ALLOWED', parentDirRename: 'ALLOWED' });
  });

  it('a junction in the path is refused (reparse point / redirected), nothing stays pinned', () => {
    const ws = makeNativeWorkspace('hark-h5-junction');
    const real = join(ws.root, 'real');
    mkdirSync(real);
    copyFileSync(ws.exe, join(real, 'node.exe'));
    copyFileSync(ws.script, join(real, 'fixture.cjs'));
    const link = join(ws.root, 'link');
    symlinkSync(real, link, 'junction');
    const reason = refusal(() => pinLaunch(launchFor(ws, join(link, 'node.exe'), join(link, 'fixture.cjs'), 'normal', 'junction'), pinPort));
    evidence('junction', { reason });
    assert.match(reason, /^(reparse-point|path-redirected):/u);
    assert.equal(attempt(() => renameSync(real, `${real}-2`)), 'ALLOWED', 'partial pins were released');
  });

  it('file swapped between verifyLaunch and pin -> refused by the hash through the handle', () => {
    const ws = makeNativeWorkspace('hark-h5-swap');
    const launch = launchFor(ws, ws.exe, ws.script, 'normal', 'swap');
    writeFileSync(ws.script, `${readFileSync(ws.script, 'utf8')}\n// swapped after verification\n`);
    const reason = refusal(() => pinLaunch(launch, pinPort));
    evidence('swap', { reason });
    assert.match(reason, /^(hash-mismatch|size-changed):/u);
  });
});

describe('H5 native: adapter runs pinned by default', () => {
  it('input cannot be replaced while the child runs; image path verified before resume; pins released after drain', async () => {
    const ws = makeNativeWorkspace('hark-h5-run');
    const controller = new AbortController();
    const adapter = createJobLifetimeAdapter({ port, pinPort, clock: () => Date.now(), sleep, pollMs: 20, stopWaitMs: 5_000 });
    const running = adapter.run(launchFor(ws, ws.exe, ws.script, 'hold', 'run'), controller.signal);
    await waitForJson(join(ws.root, 'run-root.json'), 30_000);
    const duringRun = attempt(() => writeFileSync(ws.script, 'swapped mid-run'));
    controller.abort();
    const r = await running;
    const afterRun = attempt(() => { renameSync(ws.script, `${ws.script}.x`); renameSync(`${ws.script}.x`, ws.script); });
    const names = r.events.map(e => e.name);
    evidence('pinned-run', { outcome: r.outcome, launchPinned: r.launchPinned, duringRun, afterRun, errors: r.errors, events: names });
    assert.equal(r.outcome, 'CANCELLED');
    assert.equal(r.launchPinned, true);
    assert.notEqual(duringRun, 'ALLOWED');
    assert.equal(afterRun, 'ALLOWED');
    assert.ok(names.indexOf('launch-pinned') < names.indexOf('job-created'));
    assert.ok(names.indexOf('image-path-verified') < names.indexOf('resumed'));
    assert.ok(names.indexOf('handles-close-attempted') < names.indexOf('pins-released'));
    assert.deepEqual(r.errors, []);
  });
});
