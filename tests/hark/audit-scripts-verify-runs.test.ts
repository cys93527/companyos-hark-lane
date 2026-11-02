import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// @ts-expect-error -- plain ESM script without types
import { verifyInstallerRun, verifyReleaseRuns, RELEASE_GATES } from '../../scripts/hark/verify-workflow-runs.mjs';

/*
 * AUDIT-S12: hark-release-assets only checked that the given hark-installer run succeeded on the tag; live workflows
 * checked nothing (live-model even defaulted to a stale run id). A release could ship an installer whose windows /
 * ubuntu / upgrade / restart / isolation gates failed.
 */
const root = join(__dirname, '..', '..');
const SHA = 'a'.repeat(40);
const run = (id: number, name: string, conclusion = 'success', sha = SHA, n = id) => ({ id, name, status: 'completed', conclusion, head_sha: sha, run_number: n, created_at: `2026-11-0${String(n % 9)}` });
const green = () => [run(1, 'hark-installer'), ...RELEASE_GATES.map((g: string, i: number) => run(10 + i, g))];

describe('AUDIT-S12 release consumes only fully green commits', () => {
  it('all gates green -> ok', () => {
    expect(verifyReleaseRuns({ runs: green(), sha: SHA, installerRunId: '1', isolationRuns: [run(50, 'hark-isolation', 'success', 'b'.repeat(40))], isolationShas: ['b'.repeat(40), SHA] })).toEqual({ ok: true, problems: [] });
  });
  it('a failed sibling gate refuses', () => {
    const runs = green().map((r) => (r.name === 'hark-upgrade' ? { ...r, conclusion: 'failure' } : r));
    const v = verifyReleaseRuns({ runs, sha: SHA, installerRunId: '1' });
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toContain('hark-upgrade');
  });
  it('a missing gate, a rerun that failed last, or an installer for another sha refuses', () => {
    expect(verifyReleaseRuns({ runs: green().filter((r) => r.name !== 'hark-restart'), sha: SHA, installerRunId: '1' }).problems.join()).toContain('hark-restart: no completed run');
    const rerun = [...green(), run(99, 'hark-windows', 'failure', SHA, 99)];
    expect(verifyReleaseRuns({ runs: rerun, sha: SHA, installerRunId: '1' }).problems.join()).toContain('hark-windows: latest run 99');
    expect(verifyInstallerRun(run(1, 'hark-installer', 'success', 'c'.repeat(40)), SHA, '1').ok).toBe(false);
    expect(verifyInstallerRun(run(1, 'hark-windows'), SHA, '1').ok).toBe(false);
    expect(verifyInstallerRun(undefined, SHA, '1').ok).toBe(false);
  });
  it('isolation: no run since the last isolation change, or a failed latest one, refuses', () => {
    expect(verifyReleaseRuns({ runs: green(), sha: SHA, installerRunId: '1', isolationRuns: [run(50, 'hark-isolation', 'success', 'd'.repeat(40))], isolationShas: [SHA] }).ok).toBe(false);
    expect(verifyReleaseRuns({ runs: green(), sha: SHA, installerRunId: '1', isolationRuns: [run(50, 'hark-isolation'), run(51, 'hark-isolation', 'failure')], isolationShas: [SHA] }).ok).toBe(false);
  });
  it('the workflows call the verifier; live-model has no stale default run id', () => {
    const rel = readFileSync(join(root, '.github', 'workflows', 'hark-release-assets.yml'), 'utf8');
    expect(rel).toContain('node scripts/hark/verify-workflow-runs.mjs --mode release');
    expect(rel).toContain('fetch-depth: 0');
    for (const wf of ['hark-live-goal.yml', 'hark-live-model.yml']) {
      const text = readFileSync(join(root, '.github', 'workflows', wf), 'utf8');
      expect(text, wf).toContain('node scripts/hark/verify-workflow-runs.mjs --mode installer --sha "$env:GITHUB_SHA"');
      expect(text.indexOf('verify-workflow-runs.mjs'), wf).toBeLessThan(text.indexOf('actions/download-artifact@v4'));
    }
    expect(readFileSync(join(root, '.github', 'workflows', 'hark-live-model.yml'), 'utf8')).not.toContain("default: '40112501131'");
  });
});
