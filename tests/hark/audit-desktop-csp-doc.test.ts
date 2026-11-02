import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * AUDIT-D9 (docs): docs/SECURITY_MODEL.md claimed the CSP is delivered as an HTTP header through
 * webRequest.onHeadersReceived. The packaged renderer loads from file://, where that header never arrives; the shipped
 * mechanism is the build-time <meta http-equiv> carrying the one string in apps/desktop/src/csp.ts.
 */
const root = join(__dirname, '..', '..');
const doc = readFileSync(join(root, 'docs', 'SECURITY_MODEL.md'), 'utf8');
const vite = readFileSync(join(root, 'apps', 'renderer', 'vite.config.ts'), 'utf8');

describe('AUDIT-D9 security model documents the CSP that actually applies', () => {
  it('no longer claims header-only delivery', () => {
    expect(doc).not.toContain('Delivered as an HTTP header via `session.defaultSession.webRequest.onHeadersReceived` (and mirrored');
    expect(doc).not.toContain('| response-header test |');
  });
  it('names the meta tag, the file:// reason and the single source string', () => {
    expect(doc).toContain('`<meta http-equiv="Content-Security-Policy">`');
    expect(doc).toContain('is **not** delivered for `file://` loads');
    expect(doc).toContain('`apps/desktop/src/csp.ts`');
    expect(vite).toMatch(/cspMetaTag|csp\.js|csp\.ts/);
  });
});
