/**
 * Hark lane H4 — NATIVE owner crash / owner hang / watchdog evidence (Windows x64 CI).
 *
 * A separate OWNER process (fixtures/owner-fixture.ts, stand-in for the
 * Supervisor) runs the real lifetime adapter; the test kills it (crash) or it
 * blocks its own event loop (hang). Evidence required by the outline: root and
 * descendant really exit and the Job reaches active zero.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createKoffiJobPort } from '../../../src/executor/native-lifetime/koffi-job-port.js';
import type { NativeProcessHandles } from '../../../src/executor/native-lifetime/job-port.js';
import { alive, environmentBlock, evidence, helperEnvironment, loadKoffi, makeNativeWorkspace, nodeCommandLine, sleep, waitDead, waitForJson, type NativeWorkspace } from './native-support.js';

const port = createKoffiJobPort(loadKoffi());
const ownerEntry = join(import.meta.dirname, 'fixtures', 'owner-fixture.ts');
const cleanup: (() => void)[] = [];
after(() => { for (const c of cleanup.reverse()) { try { c(); } catch { /* best effort */ } } });

interface OwnerInfo { ownerPid: number; watchdogPid: number | null }
interface WatchdogOut { outcome: string; trigger: string | null; errors: string[]; handleClosed: boolean; ticks: number }

function startOwner(ws: NativeWorkspace, mode: string, tag: string): NativeProcessHandles {
  const owner = port.createSuspended(ws.exe, nodeCommandLine(ws.exe, ownerEntry, [mode, ws.root, ws.control, tag]), ws.control, environmentBlock(helperEnvironment(ws.temp)));
  cleanup.push(() => { try { if (!port.hasExited(owner.process)) port.terminateProcess(owner.process, 1); } finally { port.close(owner.process); } });
  port.resume(owner.thread);
  port.close(owner.thread);
  return owner;
}

function killPid(pid: number | null): void {
  if (pid === null || !alive(pid)) return;
  const h = port.openProcess(pid);
  try { port.terminateProcess(h, 1); } finally { port.close(h); }
}

async function treeUp(ws: NativeWorkspace, tag: string): Promise<{ rootPid: number; leafPid: number }> {
  const rootPid = (await waitForJson<{ pid: number }>(join(ws.root, `${tag}-root.json`), 30_000)).pid;
  const leafPid = (await waitForJson<{ pid: number }>(join(ws.root, `${tag}-leaf.json`), 30_000)).pid;
  return { rootPid, leafPid };
}

async function waitExited(h: bigint, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (port.hasExited(h)) return true;
  return port.hasExited(h);
}

describe('H4 native: owner (Supervisor stand-in) crash and hang', () => {
  it('owner hard-killed, no watchdog: kill-on-last-close reaps root and grandchild', async () => {
    const ws = makeNativeWorkspace('hark-h4-crash');
    const owner = startOwner(ws, 'crash', 'crash');
    const { rootPid, leafPid } = await treeUp(ws, 'crash');
    cleanup.push(() => { killPid(rootPid); killPid(leafPid); });
    assert.equal(alive(rootPid) && alive(leafPid), true);
    port.terminateProcess(owner.process, 0xdead);
    assert.equal(await waitExited(owner.process, 5_000), true);
    const dead = await waitDead([rootPid, leafPid], 10_000);
    evidence('owner-crash', { ownerPid: owner.pid, rootPid, leafPid, dead });
    assert.equal(dead, true);
  });

  it('owner hard-killed WITH watchdog (which holds a Job handle): watchdog sees OWNER_EXITED and drains the Job', async () => {
    const ws = makeNativeWorkspace('hark-h4-crashwd');
    const owner = startOwner(ws, 'crash-wd', 'crashwd');
    const { rootPid, leafPid } = await treeUp(ws, 'crashwd');
    const info = await waitForJson<OwnerInfo>(join(ws.control, 'owner-info.json'), 5_000);
    cleanup.push(() => { killPid(rootPid); killPid(leafPid); killPid(info.watchdogPid); });
    assert.ok(info.watchdogPid);
    port.terminateProcess(owner.process, 0xdead);
    const out = await waitForJson<WatchdogOut>(join(ws.control, 'watchdog-result.json'), 20_000);
    const dead = await waitDead([rootPid, leafPid], 10_000);
    const watchdogGone = await waitDead([info.watchdogPid], 10_000);
    evidence('owner-crash-watchdog', { out, rootPid, leafPid, watchdogPid: info.watchdogPid, dead, watchdogGone });
    assert.equal(out.outcome, 'TERMINATED_DRAINED');
    assert.equal(out.trigger, 'OWNER_EXITED');
    assert.equal(out.handleClosed, true);
    assert.equal(dead, true);
    assert.equal(watchdogGone, true);
  });

  it('owner alive but hung (event loop blocked): watchdog sees OWNER_UNRESPONSIVE and drains the Job while the owner is still running', async () => {
    const ws = makeNativeWorkspace('hark-h4-hang');
    const owner = startOwner(ws, 'hang-wd', 'hang');
    const { rootPid, leafPid } = await treeUp(ws, 'hang');
    const info = await waitForJson<OwnerInfo>(join(ws.control, 'owner-info.json'), 5_000);
    cleanup.push(() => { killPid(rootPid); killPid(leafPid); killPid(info.watchdogPid); });
    await waitForJson(join(ws.control, 'owner-hanging.json'), 10_000);
    const out = await waitForJson<WatchdogOut>(join(ws.control, 'watchdog-result.json'), 30_000);
    const dead = await waitDead([rootPid, leafPid], 10_000);
    const ownerStillRunning = !port.hasExited(owner.process);
    evidence('owner-hang-watchdog', { out, rootPid, leafPid, dead, ownerStillRunning });
    assert.equal(out.outcome, 'TERMINATED_DRAINED');
    assert.equal(out.trigger, 'OWNER_UNRESPONSIVE');
    assert.equal(dead, true);
    assert.equal(ownerStillRunning, true, 'the hang is real: the owner never noticed');
  });

  it('normal run with watchdog: owner EXITED, releases the lease, watchdog ends RELEASED_DRAINED', async () => {
    const ws = makeNativeWorkspace('hark-h4-release');
    const owner = startOwner(ws, 'release-wd', 'release');
    const result = await waitForJson<{ outcome: string; errors: unknown[] }>(join(ws.control, 'owner-result.json'), 30_000);
    const out = await waitForJson<WatchdogOut>(join(ws.control, 'watchdog-result.json'), 10_000);
    evidence('owner-release-watchdog', { result, out, lease: readFileSync(join(ws.control, 'lease.rec'), 'ascii').trim() });
    assert.equal(result.outcome, 'EXITED');
    assert.equal(out.outcome, 'RELEASED_DRAINED');
    assert.equal(await waitExited(owner.process, 10_000), true);
  });
});
