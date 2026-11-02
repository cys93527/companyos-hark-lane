import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { killProcessTree, runRepoTestContract } from '../../apps/desktop/src/repo-test-process.js';

/*
 * AUDIT-D2: the validator deadline killed only cmd.exe / sh and settled on 'close', so npm and the test runner kept
 * the pipes open and the 600 s deadline bounded nothing. The whole tree is now killed and the run settles on the root's
 * exit plus a short grace.
 */
/* Real grandchild trees are refused by the offline test guard (only reviewed single-process fixtures run), so the
 * tree kill is asserted through the injected spawn / killTree seams; tests/two-chain-process-port.test.ts keeps the
 * real-process deadline check. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly pid: number) { super(); }
  kill(): boolean { return true; }
}

describe('AUDIT-D2 validator deadline bounds the whole process tree', () => {
  it('on Windows the deadline runs taskkill /PID <root> /T /F (absolute System32 path)', async () => {
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const root = new FakeChild(4242);
    const fakeSpawn = ((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      if (calls.length === 1) return root;
      const killer = new FakeChild(1);
      setTimeout(() => { root.emit('exit', null, 'SIGTERM'); }, 5);
      return killer;
    }) as never;
    const result = await runRepoTestContract({ cwd: 'C:\\ws', timeoutMs: 10 }, { spawn: fakeSpawn, platform: 'win32', settleGraceMs: 20 });
    expect(calls[0]).toMatchObject({ cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'npm test'] });
    expect(calls[1]!.cmd.toLowerCase()).toMatch(/system32[\\/]taskkill\.exe$/);
    expect(calls[1]!.args).toEqual(['/PID', '4242', '/T', '/F']);
    expect(result).toMatchObject({ timedOut: true, exitCode: -1 });
  });

  it('settles after the root exits even when a descendant keeps the pipes open', async () => {
    const root = new FakeChild(77);
    const killed: number[] = [];
    const fakeSpawn = (() => root) as never;
    const pending = runRepoTestContract({ cwd: '/ws', timeoutMs: 60_000 }, {
      spawn: fakeSpawn, platform: 'linux', settleGraceMs: 20, killTree: (c) => { killed.push(c.pid ?? -1); },
    });
    root.stdout.write('ok\n');
    root.emit('exit', 0, null); // 'close' never fires: a grandchild still holds stdout
    const result = await pending;
    expect(result).toEqual({ exitCode: 0, timedOut: false, outputTail: 'ok' });
    expect(killed).toEqual([77]);
  });

  it('POSIX kill targets the process group (negative pid)', () => {
    const original = process.kill;
    const seen: [number, string | number | undefined][] = [];
    (process as { kill: typeof process.kill }).kill = ((pid: number, sig?: string | number) => { seen.push([pid, sig]); return true; }) as typeof process.kill;
    try { killProcessTree(new FakeChild(555) as never, 'linux'); } finally { (process as { kill: typeof process.kill }).kill = original; }
    expect(seen).toEqual([[-555, 'SIGKILL']]);
  });
});
