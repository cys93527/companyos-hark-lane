import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SCRATCH_CLEANUP_MARKER,
  createRepoTestContractRunner,
  removeBestEffort,
  sweepStaleScratch,
  type RepoTestContractRun,
} from '../../apps/desktop/src/repo-test-process.js';

/*
 * Live contract-fill run 14 (hark-live-goal 42668857942): all 6 repo.test-check calls failed in seconds
 * with tool error `EPERM, Permission denied: ...\companyos-validator-home-XXXX`. The test contract had
 * run, but removing the per-run scratch profile threw from a `finally` (LibreOffice soffice.bin processes
 * the tests started still held files in the profile), and the throw replaced the verdict -> validation
 * `error` on every stage -> corrective cap (3) ended the goal. Cleanup is now best-effort and never
 * replaces the verdict.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const eperm = (): never => {
  throw Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' });
};

const workspace = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), 'companyos-run14-ws-'));
  dirs.push(cwd);
  return cwd;
};

describe('run 14: validator scratch cleanup never replaces the verdict', () => {
  it('unisolated: a locked scratch keeps the contract verdict and reports the leftover', async () => {
    let scratch = '';
    const run = async (input: { envOverrides?: Readonly<Record<string, string>> }): Promise<RepoTestContractRun> => {
      scratch = input.envOverrides!['USERPROFILE']!;
      return { exitCode: 0, timedOut: false, outputTail: 'Ran 75 tests OK' };
    };
    const runner = createRepoTestContractRunner({ run, platform: 'win32', removeDir: eperm });
    const result = await runner({ cwd: workspace(), timeoutMs: 1000 });
    dirs.push(scratch);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.outputTail).toContain('Ran 75 tests OK');
    expect(result.outputTail).toContain(SCRATCH_CLEANUP_MARKER);
    expect(result.outputTail).toContain('EPERM');
  });

  it('unisolated: a failing contract stays failing (exit code preserved) when cleanup fails', async () => {
    const run = async (): Promise<RepoTestContractRun> => ({ exitCode: 1, timedOut: false, outputTail: 'FAILED (failures=2)' });
    const runner = createRepoTestContractRunner({ run, platform: 'linux', removeDir: eperm });
    const result = await runner({ cwd: workspace(), timeoutMs: 1000 });
    expect(result.exitCode).toBe(1);
    expect(result.outputTail).toContain('FAILED (failures=2)');
  });

  it('unisolated: successful cleanup adds no note and removes the scratch', async () => {
    let scratch = '';
    const run = async (input: { envOverrides?: Readonly<Record<string, string>> }): Promise<RepoTestContractRun> => {
      scratch = input.envOverrides!['HOME']!;
      return { exitCode: 0, timedOut: false, outputTail: 'ok' };
    };
    const runner = createRepoTestContractRunner({ run, platform: 'linux', removeDir: (p) => rmSync(p, { recursive: true, force: true }) });
    const result = await runner({ cwd: workspace(), timeoutMs: 1000 });
    expect(result.outputTail).not.toContain(SCRATCH_CLEANUP_MARKER);
    expect(existsSync(scratch)).toBe(false);
  });

  it('a run that throws still propagates its own error, not the cleanup error', async () => {
    const run = async (): Promise<RepoTestContractRun> => { throw new Error('spawn failed'); };
    const runner = createRepoTestContractRunner({ run, platform: 'linux', removeDir: eperm });
    await expect(runner({ cwd: workspace(), timeoutMs: 1000 })).rejects.toThrow('spawn failed');
  });

  it('removeBestEffort returns null on success and a marker note on failure', () => {
    expect(removeBestEffort('/x', () => undefined)).toBeNull();
    expect(removeBestEffort('/x', eperm)).toContain(SCRATCH_CLEANUP_MARKER);
  });

  it('sweepStaleScratch removes only stale companyos-validator-home-* dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'companyos-run14-sweep-'));
    dirs.push(root);
    const stale = join(root, 'companyos-validator-home-old');
    const fresh = join(root, 'companyos-validator-home-new');
    const other = join(root, 'something-else');
    for (const d of [stale, fresh, other]) mkdirSync(d);
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);
    utimesSync(other, twoHoursAgo, twoHoursAgo);
    sweepStaleScratch(root, (p) => rmSync(p, { recursive: true, force: true }), now);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    // a still-locked leftover is skipped silently
    const locked = join(root, 'companyos-validator-home-locked');
    mkdirSync(locked);
    utimesSync(locked, twoHoursAgo, twoHoursAgo);
    expect(() => sweepStaleScratch(root, eperm, now)).not.toThrow();
  });
});
