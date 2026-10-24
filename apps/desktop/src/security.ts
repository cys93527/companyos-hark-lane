/**
 * Electron hardening baseline (planning-document §四十七 Workspace 隔离与
 * §四十四 Audit): the renderer is untrusted. It gets no Node built-ins, no
 * `require`, no `ipcRenderer`, and it may not navigate anywhere or open windows.
 *
 * Everything here is a pure function over plain options so it can be unit-tested
 * without launching Electron — `apps/desktop/tests/security.test.ts` asserts that
 * the shipped baseline is exactly the hardened one.
 */
import { join } from 'node:path';

import type { BrowserWindowConstructorOptions } from 'electron';

/** Content-Security-Policy served to the renderer (dev server overrides it). */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface HardenedWebPreferences {
  readonly preload: string;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly experimentalFeatures: false;
  readonly webviewTag: false;
  readonly spellcheck: false;
}

/** The four flags every CompanyOS window MUST carry. */
export const REQUIRED_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
} as const;

/** Sandboxed preloads must be CommonJS: a `.cjs` file, next to `dist/`. */
export const preloadPathOf = (mainDir: string): string =>
  join(mainDir, '..', 'preload', 'preload.cjs');

export function hardenedWebPreferences(mainDir: string): HardenedWebPreferences {
  return {
    preload: preloadPathOf(mainDir),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    spellcheck: false,
  };
}

export function createWindowOptions(mainDir: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    title: 'CompanyOS',
    webPreferences: hardenedWebPreferences(mainDir),
  };
}

export interface SecurityViolation {
  readonly key: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

const readPreference = (
  options: BrowserWindowConstructorOptions,
  key: string,
): unknown => {
  const preferences = options.webPreferences as Record<string, unknown> | undefined;
  return preferences?.[key];
};

/** Audit any window options object against the baseline (empty = hardened). */
export function auditWindowOptions(
  options: BrowserWindowConstructorOptions,
): readonly SecurityViolation[] {
  const violations: SecurityViolation[] = [];
  for (const [key, expected] of Object.entries(REQUIRED_WEB_PREFERENCES)) {
    const actual = readPreference(options, key);
    if (actual !== expected) violations.push({ key: `webPreferences.${key}`, expected, actual });
  }
  const preload = readPreference(options, 'preload');
  if (typeof preload !== 'string' || !preload.endsWith('preload.cjs')) {
    violations.push({
      key: 'webPreferences.preload',
      expected: '<dir>/preload/preload.cjs',
      actual: preload,
    });
  }
  return violations;
}
