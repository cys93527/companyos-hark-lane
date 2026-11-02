/**
 * AUDIT-D9 — the packaged renderer (file://) gets its CSP from a build-time <meta http-equiv>
 * equal to the header CSP, and the session denies every permission request/check by default.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CSP as CSP_SOURCE, cspMetaTag } from '../src/csp.js';
import { CSP, denyAllPermissions } from '../src/security.js';
import viteConfig, { companyosCspMeta } from '../../renderer/vite.config.js';

describe('AUDIT-D9 CSP meta + default-deny permissions', () => {
  it('the header CSP and the build-time meta CSP are the same string', () => {
    expect(CSP).toBe(CSP_SOURCE);
    expect(cspMetaTag()).toEqual({ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' });
  });

  it('the renderer build injects the CSP meta (build only) and is registered in the vite config', () => {
    const plugin = companyosCspMeta();
    expect(plugin.apply).toBe('build');
    const transform = plugin.transformIndexHtml as () => unknown;
    expect(transform()).toEqual([cspMetaTag()]);
    const plugins = ((viteConfig as { plugins?: unknown[] }).plugins ?? []).flat(5) as { name?: string }[];
    expect(plugins.some((p) => p?.name === 'companyos-csp-meta')).toBe(true);
  });

  it('every permission request and check is denied', () => {
    let request: ((wc: unknown, permission: string, cb: (granted: boolean) => void, details: unknown) => void) | null = null;
    let check: ((wc: unknown, permission: string, origin: string, details: unknown) => boolean) | null = null;
    denyAllPermissions({
      setPermissionRequestHandler: (h: never) => { request = h; },
      setPermissionCheckHandler: (h: never) => { check = h; },
    } as never);
    expect(request).not.toBeNull();
    expect(check).not.toBeNull();
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'hid', 'serial', 'openExternal']) {
      let granted: boolean | null = null;
      request!(null, permission, (g) => { granted = g; }, {});
      expect(granted).toBe(false);
      expect(check!(null, permission, 'file://', {})).toBe(false);
    }
  });

  it('main.ts installs the default-deny policy unconditionally (before the dev early-return)', () => {
    const main = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
    const fn = main.slice(main.indexOf('function applyContentSecurityPolicy'));
    expect(fn.indexOf('denyAllPermissions(session.defaultSession)')).toBeGreaterThan(-1);
    expect(fn.indexOf('denyAllPermissions(session.defaultSession)')).toBeLessThan(fn.indexOf('if (isDev)'));
  });
});
