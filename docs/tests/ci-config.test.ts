/**
 * CI gate: the workflow must actually run the same gate we run locally, on both
 * supported Node lines, with a frozen lockfile and superseded runs cancelled.
 * This is a static assertion — no GitHub runner required.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
  'utf8',
);

describe('GitHub Actions workflow', () => {
  it('runs pnpm check', () => {
    expect(workflow).toMatch(/run:\s*pnpm check/);
  });

  it('installs from the frozen lockfile', () => {
    expect(workflow).toMatch(/pnpm install --frozen-lockfile/);
  });

  it('pins the Node matrix to 22 and 24', () => {
    expect(workflow).toContain("'22.x'");
    expect(workflow).toContain("'24.x'");
    expect(workflow).toMatch(/node-version:/);
  });

  it('cancels superseded runs', () => {
    expect(workflow).toMatch(/concurrency:/);
    expect(workflow).toMatch(/cancel-in-progress:\s*true/);
  });

  it('runs on push and pull_request', () => {
    expect(workflow).toMatch(/^on:/m);
    expect(workflow).toMatch(/pull_request:/);
    expect(workflow).toMatch(/push:/);
  });

  it('also runs the tooling self-tests and the workspace check', () => {
    expect(workflow).toMatch(/pnpm test:scripts/);
    expect(workflow).toMatch(/scripts\/check-workspace\.mjs/);
  });

  it('does not download the Electron binary in CI', () => {
    expect(workflow).toContain('ELECTRON_SKIP_BINARY_DOWNLOAD');
  });
});
