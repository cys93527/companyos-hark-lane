// TEST-SPEED — the fast dev-loop commands never replace the full suite (docs/hark-lane/TEST_SPEED.md).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

const workflow = readFileSync('.github/workflows/hark-ubuntu.yml', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
const doc = readFileSync('docs/hark-lane/TEST_SPEED.md', 'utf8');

/** The single command the hark-ubuntu "Full vitest" step runs. */
const fullVitestCommand = (): string => {
  const step = workflow.indexOf('- name: Full vitest (deterministic suite)');
  expect(step).toBeGreaterThan(0);
  const line = workflow.slice(step).split('\n').find((row) => row.includes('npx vitest run'));
  expect(line).toBeDefined();
  return (line ?? '').trim();
};

interface ProjectEntry {
  readonly test: { readonly name: string; readonly include: readonly string[]; readonly exclude: readonly string[]; readonly isolate?: boolean };
}

describe('TEST-SPEED full-suite rule', () => {
  it('hark-ubuntu runs the WHOLE suite: no shard, changed, since-last-run, related, project or file filter', () => {
    const command = fullVitestCommand();
    for (const narrowing of ['--shard', '--changed', '--since-last-run', '--lastFailed', '--last-failed', '--related', '--project', '--testNamePattern', ' -t ', '--bail', '--passWithNoTests']) {
      expect(command, `full vitest step must not narrow the suite with ${narrowing}`).not.toContain(narrowing);
    }
    // After `run`, only reporter/output options: no positional file filter.
    const args = command.split(/\s+/u).slice(command.split(/\s+/u).indexOf('run') + 1).filter((arg) => arg !== '>' && !arg.startsWith('hark-evidence/') && arg !== '2>&1');
    for (const arg of args) expect(arg, `unexpected full-suite argument ${arg}`).toMatch(/^--(?:reporter|outputFile)/u);
    expect(workflow).toContain('compare-vitest-baseline.mjs');
  });

  it('the default and full scripts stay the whole suite; the fast scripts are separate names', () => {
    expect(pkg.scripts['test']).toBe('vitest run');
    expect(pkg.scripts['test:full']).toBe('vitest run');
    expect(pkg.scripts['test:since']).toBe('vitest run --since-last-run');
    expect(pkg.scripts['test:changed']).toBe('node scripts/hark/test-changed.mjs');
    expect(pkg.scripts['test:shard']).toBe('vitest run --shard');
  });

  it('isolate:false applies ONLY to the pure-Node packages project; the two projects partition the old include list', () => {
    const projects = (config.test?.projects ?? []) as unknown as ProjectEntry[];
    expect(projects.map((project) => project.test.name)).toEqual(['packages', 'isolated']);
    const [packages, isolated] = projects;
    expect(packages?.test.include).toEqual(['packages/*/tests/**/*.test.ts']);
    expect(packages?.test.isolate).toBe(false);
    expect(isolated?.test.isolate).toBeUndefined();
    expect([...(packages?.test.include ?? []), ...(isolated?.test.include ?? [])].sort()).toEqual(
      ['packages/*/tests/**/*.test.ts', 'packs/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts', 'docs/tests/**/*.test.ts', 'tests/**/*.test.ts'].sort(),
    );
    expect(packages?.test.exclude).toEqual(isolated?.test.exclude);
    expect(isolated?.test.exclude).toContain('tests/kernel/**');
    expect(isolated?.test.exclude).toContain('tests/provider/**/*-live.test.ts');
  });

  it('the guide states the full-suite rule', () => {
    expect(doc).toContain('The full suite stays mandatory');
    expect(doc).toContain('hark-ubuntu');
    expect(doc).toContain('before any tag/release');
  });
});
