/**
 * Sprint 0 acceptance: the shipped Electron baseline is the hardened one
 * (planning-document §四十七 / §三十九 Role permissions).
 */
import { describe, expect, it } from 'vitest';

import {
  CSP,
  REQUIRED_WEB_PREFERENCES,
  auditWindowOptions,
  createWindowOptions,
  hardenedWebPreferences,
  preloadPathOf,
} from '../src/security.js';

const MAIN_DIR = 'C:/app/desktop/dist';

describe('electron window hardening baseline', () => {
  it('sets every required web preference', () => {
    const options = createWindowOptions(MAIN_DIR);
    expect(auditWindowOptions(options)).toEqual([]);

    const preferences = options.webPreferences as Record<string, unknown>;
    for (const [key, expected] of Object.entries(REQUIRED_WEB_PREFERENCES)) {
      expect(preferences[key], `webPreferences.${key}`).toBe(expected);
    }
  });

  it('resolves the sandboxed CommonJS preload next to dist/', () => {
    expect(preloadPathOf(MAIN_DIR).replace(/\\/g, '/')).toBe('C:/app/desktop/preload/preload.cjs');
    expect(hardenedWebPreferences(MAIN_DIR).preload.endsWith('preload.cjs')).toBe(true);
  });

  it('reports a violation when a flag is weakened', () => {
    const weakened = {
      ...createWindowOptions(MAIN_DIR),
      webPreferences: {
        ...hardenedWebPreferences(MAIN_DIR),
        nodeIntegration: true,
        contextIsolation: false,
      },
    } as unknown as Parameters<typeof auditWindowOptions>[0];

    const violations = auditWindowOptions(weakened);
    expect(violations.map((violation) => violation.key).sort()).toEqual([
      'webPreferences.contextIsolation',
      'webPreferences.nodeIntegration',
    ]);
  });

  it('ships a restrictive CSP with no remote code and no network', () => {
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("object-src 'none'");
    expect(CSP).toContain("connect-src 'none'");
    expect(CSP).toContain("frame-ancestors 'none'");
  });
});
