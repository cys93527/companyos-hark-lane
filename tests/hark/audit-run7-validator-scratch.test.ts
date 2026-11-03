import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRepoTestContractRunner, type RepoTestContractRun } from '../../apps/desktop/src/repo-test-process.js';

/*
 * AUDIT-RUN7-1 (v0.1.1 acceptance run 7, hark-live-goal 41641255275): every repo.test-check validation
 * ended status=error with tool error "EPERM: operation not permitted, mkdir 'C:'". Root cause: the
 * AUDIT-D1 "isolation not configured" branch created a directory for EVERY redirected env value,
 * including HOMEDRIVE ('C:', a drive, not a directory) and HOMEPATH (a drive-relative path). On Windows
 * a recursive mkdir of a drive root throws EPERM, so the validator threw before `npm test` ever ran and
 * every otherwise-valid test run became a blocking validation error (-> corrective loop).
 * On POSIX the same code path (platform win32) tries mkdir('/t') (scratch.slice(0, 2)) -> EACCES, which
 * is what this test reproduces without Windows.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type RunInput = Parameters<NonNullable<Parameters<typeof createRepoTestContractRunner>[0]['run']>>[0];

describe('AUDIT-RUN7-1 unconfigured-isolation validator scratch profile', () => {
  it('win32: only directory-valued keys are created; HOMEDRIVE/HOMEPATH are derived, never mkdir-ed', async () => {
    const seen: RunInput[] = [];
    const existed: Record<string, boolean> = {};
    const run = async (input: RunInput): Promise<RepoTestContractRun> => {
      seen.push(input);
      for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
        existed[key] = existsSync(input.envOverrides![key]!);
      }
      return { exitCode: 0, timedOut: false, outputTail: 'ok' };
    };
    const cwd = mkdtempSync(join(tmpdir(), 'companyos-run7-ws-'));
    dirs.push(cwd);
    const runner = createRepoTestContractRunner({ run, platform: 'win32' });
    const result = await runner({ cwd, timeoutMs: 1000 });
    expect(result.exitCode).toBe(0);
    expect(result.outputTail.startsWith('[validator: 未隔离]')).toBe(true);
    expect(seen).toHaveLength(1);
    const env = seen[0]!.envOverrides!;
    expect(existed).toEqual({ USERPROFILE: true, APPDATA: true, LOCALAPPDATA: true, TEMP: true, TMP: true });
    // HOMEDRIVE + HOMEPATH name the scratch profile itself.
    expect(`${env['HOMEDRIVE']}${env['HOMEPATH']}`).toBe(env['USERPROFILE']);
    expect(existsSync(env['USERPROFILE']!)).toBe(false); // scratch removed after the run
  });
});
