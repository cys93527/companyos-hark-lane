// H18 — release assets come only from the tagged commit's own green hark-installer run.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/hark-release-assets.yml', 'utf8');

describe('H18 hark-release-assets', () => {
  it('is manual only, needs only contents:write + actions:read, uses no secrets', () => {
    expect(workflow).toMatch(/on:\n {2}workflow_dispatch:/u);
    expect(workflow).not.toMatch(/\n {2}push:/u);
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('actions: read');
    expect(workflow).not.toMatch(/secrets\./u);
  });

  it('refuses a run that is not the successful hark-installer run of the tagged commit', () => {
    const verify = workflow.indexOf('verify installer run belongs to the tagged commit');
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(workflow.indexOf('actions/download-artifact@v4'));
    expect(workflow).toContain('= "hark-installer" ]');
    expect(workflow).toContain('.conclusion <<<"$run")" = "success" ]');
    expect(workflow).toContain('.head_sha <<<"$run")" = "$tag_sha" ]');
  });

  it('checks the exe hash against that run installer-sha256.txt before uploading, never rebuilds', () => {
    expect(workflow).toContain('dl/evidence/installer-sha256.txt');
    expect(workflow).toContain('installer hash mismatch');
    expect(workflow.indexOf('installer hash mismatch')).toBeLessThan(workflow.indexOf('gh release upload'));
    expect(workflow).toContain('HEAD:scripts/hark/acceptance-fixture');
    expect(workflow).not.toMatch(/iscc|pnpm|npm run|build:/iu);
  });
});
