/**
 * Sprint 0 acceptance: the renderer surfaces the version that came over the
 * preload bridge, and degrades safely when the bridge is absent.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_KEY,
  FALLBACK_APP_VERSION,
  bridgeAvailability,
  getBridge,
  isCompanyOsBridge,
  resolveAppVersion,
  resolveDatabaseStatus,
  type CompanyOsBridge,
} from '../src/bridge.js';

const makeBridge = (overrides: Partial<CompanyOsBridge> = {}): CompanyOsBridge => ({
  appVersion: async () => '1.2.3',
  platformInfo: async () => ({
    platform: 'win32',
    arch: 'x64',
    electron: '33.0.0',
    node: '22.0.0',
    chrome: '130.0.0',
  }),
  databaseStatus: async () => ({ path: 'C:/data/companyos.sqlite', journalMode: 'wal', schemaVersion: 1 }),
  channels: () => ['companyos:app-version'],
  ...overrides,
});

describe('renderer bridge', () => {
  it('surfaces the app version provided by the bridge', async () => {
    await expect(resolveAppVersion(makeBridge())).resolves.toBe('1.2.3');
  });

  it('falls back when there is no bridge', async () => {
    expect(getBridge(globalThis)).toBeNull();
    expect(bridgeAvailability({})).toBe('missing');
    await expect(resolveAppVersion(null)).resolves.toBe(FALLBACK_APP_VERSION);
  });

  it('falls back instead of throwing when the bridge rejects', async () => {
    const failing = makeBridge({
      appVersion: async () => {
        throw new Error('ipc failed');
      },
    });
    await expect(resolveAppVersion(failing, 'fallback')).resolves.toBe('fallback');
  });

  it('reads the bridge off an injected scope and validates its shape', () => {
    const fakeWindow: Record<string, unknown> = { [BRIDGE_KEY]: makeBridge() };
    expect(bridgeAvailability(fakeWindow)).toBe('available');
    expect(getBridge(fakeWindow)?.channels()).toEqual(['companyos:app-version']);

    const incomplete: Record<string, unknown> = { [BRIDGE_KEY]: { appVersion: () => 'x' } };
    expect(getBridge(incomplete)).toBeNull();
    expect(isCompanyOsBridge({})).toBe(false);
    expect(isCompanyOsBridge('companyos')).toBe(false);
  });

  it('returns database status, and null when unavailable', async () => {
    await expect(resolveDatabaseStatus(makeBridge())).resolves.toEqual({
      path: 'C:/data/companyos.sqlite',
      journalMode: 'wal',
      schemaVersion: 1,
    });
    const failing = makeBridge({
      databaseStatus: async () => {
        throw new Error('no db');
      },
    });
    await expect(resolveDatabaseStatus(failing)).resolves.toBeNull();
    await expect(resolveDatabaseStatus(null)).resolves.toBeNull();
  });

  it('never probes storage or the network on its own', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    void getBridge({});
    void bridgeAvailability({});
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
