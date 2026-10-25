// H14 — Ubuntu offline gate shape + baseline comparison logic.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs operator script, no type declarations
import { compare, failuresOf } from '../../scripts/hark/compare-vitest-baseline.mjs';

const workflow = readFileSync('.github/workflows/hark-ubuntu.yml', 'utf8');
const baseline = JSON.parse(readFileSync('scripts/hark/ubuntu-vitest-baseline.json', 'utf8')) as { entries: { id: string; reason: string }[] };

describe('H14 hark-ubuntu gate', () => {
  it('runs on ubuntu-24.04 with node 24.19.0, frozen lockfile, no scripts, no Electron download, no secrets', () => {
    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain('node-version: 24.19.0');
    expect(workflow).toContain('version: 11.25.0');
    expect(workflow).toContain('pnpm install --frozen-lockfile --ignore-scripts');
    expect(workflow).toContain("ELECTRON_SKIP_BINARY_DOWNLOAD: '1'");
    // tests/embedded-storage-lifecycle.test.ts spawns node against apps/desktop/dist (gitignored):
    // the dist must be built from this checkout before the suite, never taken from elsewhere.
    const buildAt = workflow.indexOf('pnpm run -s build:libs && pnpm run -s build:desktop');
    expect(buildAt).toBeGreaterThan(0);
    expect(buildAt).toBeLessThan(workflow.indexOf('npx vitest run'));
    expect(workflow).not.toMatch(/secrets\./u);
    for (const gate of ['pnpm -s typecheck', 'pnpm -s lint', 'test-hark-offline.mjs', 'check-boundaries.mjs', 'check-architecture.mjs', 'compare-vitest-baseline.mjs']) {
      expect(workflow).toContain(gate);
    }
  });
  it('every baseline entry carries an environment reason; no product defect is listed', () => {
    expect(baseline.entries.length).toBeGreaterThan(0);
    for (const entry of baseline.entries) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.id).not.toMatch(/sprint17|sprint25|s24-dsh-adapter-profile|s24-real-provider-smoke|dsh-live/u);
    }
  });
  it('an unlisted failure is unexpected; a listed one is baselined; a listed pass is reported', () => {
    const report = {
      testResults: [
        { name: `${process.cwd()}/tests/a.test.ts`, status: 'failed', assertionResults: [{ status: 'failed', ancestorTitles: ['A'], title: 'x', failureMessages: ['boom\nstack'] }] },
        { name: `${process.cwd()}/tests/b.test.ts`, status: 'failed', message: 'import error', assertionResults: [] },
      ],
    };
    const failures = failuresOf(report, process.cwd()) as { id: string }[];
    expect(failures.map((f) => f.id)).toEqual(['tests/a.test.ts > A > x', 'tests/b.test.ts [file]']);
    const result = compare(failures, { entries: [{ id: 'tests/a.test.ts > A > x', reason: 'env' }, { id: 'tests/c.test.ts > gone', reason: 'env' }] }) as { unexpected: { id: string }[]; baselined: unknown[]; nowPassing: string[] };
    expect(result.unexpected.map((u) => u.id)).toEqual(['tests/b.test.ts [file]']);
    expect(result.baselined).toHaveLength(1);
    expect(result.nowPassing).toEqual(['tests/c.test.ts > gone']);
  });
  it('the live DSH provider suite is outside the deterministic suite (S26 taxonomy)', () => {
    expect(readFileSync('vitest.config.ts', 'utf8')).toContain("'tests/provider/**/*-live.test.ts'");
    expect(readFileSync('vitest.provider-live.config.ts', 'utf8')).toContain("include: ['tests/provider/**/*-live.test.ts']");
    expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:provider:dsh:live']).toBe('vitest run --config vitest.provider-live.config.ts');
  });
});
