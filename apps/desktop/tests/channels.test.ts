/**
 * Sprint 0 acceptance: the preload exposes only allow-listed channels, and the
 * two copies of the allow-list (TypeScript + sandboxed CommonJS) never drift.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ALLOWED_CHANNELS, BRIDGE_KEY, CHANNELS, isAllowedChannel } from '../src/channels.js';

const preloadSource = readFileSync(
  fileURLToPath(new URL('../preload/preload.cjs', import.meta.url)),
  'utf8',
);

const channelsQuotedInPreload = (): readonly string[] => {
  const matches = preloadSource.match(/'companyos:[a-z0-9-]+'/g) ?? [];
  return [...new Set(matches.map((match) => match.slice(1, -1)))].sort();
};

describe('ipc channel allow-list', () => {
  it('exposes exactly the declared channels', () => {
    // Sprint 5 CONTRACT CHANGE (user STEP 3): one feature channel was added for the
    // Workflow Designer. The assertion stays an exact match (never "contains"), so the
    // allow-list cannot drift or grow silently.
    expect([...ALLOWED_CHANNELS].sort()).toEqual(
      [
        CHANNELS.appVersion,
        CHANNELS.platformInfo,
        CHANNELS.databaseStatus,
        CHANNELS.workflow,
        CHANNELS.controlPlane,
        CHANNELS.workspaceSelect,
        CHANNELS.workspaceOpen,
        CHANNELS.workspaceCurrent,
        // BUG BASH closure: the canonical single-workspace CHANGE command.
        CHANNELS.workspaceSwitch,
        // DESKTOP STAGE 3: the ONE bounded artifact channel (typed { operation, artifactId }).
        CHANNELS.artifacts,
      ].sort(),
    );
  });

  it('has exactly the declared feature channels (Designer + Control Plane + Workspace)', () => {
    const featureChannels = ALLOWED_CHANNELS.filter(
      (channel) =>
        channel !== CHANNELS.appVersion &&
        channel !== CHANNELS.platformInfo &&
        channel !== CHANNELS.databaseStatus,
    );
    // Sprint26: the Goal-to-Outcome runtime gets its own ONE channel, exactly like the
    // Designer did (Sprint 5 CONTRACT CHANGE discipline: exact match, never "contains").
    // DESKTOP STAGE 1: the workspace-selection seams join the feature set (exact match
    // discipline preserved — the allow-list cannot drift or grow silently).
    // DESKTOP STAGE 3: ONE bounded artifact channel joins them. It is typed
    // ({ operation, artifactId }) — the renderer may name a canonical artifact id and
    // nothing else, so there is still no generic filesystem primitive on this surface.
    expect(featureChannels).toEqual([
      CHANNELS.workflow,
      CHANNELS.controlPlane,
      CHANNELS.workspaceSelect,
      CHANNELS.workspaceOpen,
      CHANNELS.workspaceCurrent,
      CHANNELS.workspaceSwitch,
      CHANNELS.artifacts,
    ]);
  });

  it('keeps preload.cjs in sync with channels.ts', () => {
    expect(channelsQuotedInPreload()).toEqual([...ALLOWED_CHANNELS].sort());
  });

  it('rejects any channel that is not allow-listed', () => {
    expect(isAllowedChannel(CHANNELS.appVersion)).toBe(true);
    expect(isAllowedChannel('companyos:read-any-file')).toBe(false);
    expect(isAllowedChannel('companyos:')).toBe(false);
    expect(isAllowedChannel('')).toBe(false);
  });

  it('never hands ipcRenderer itself to the renderer', () => {
    expect(preloadSource).not.toMatch(/exposeInMainWorld\(\s*BRIDGE_KEY\s*,\s*ipcRenderer\s*\)/);
    expect(preloadSource).toMatch(/contextBridge\.exposeInMainWorld/);
    expect(preloadSource).toMatch(/Object\.freeze\(/);
    expect(BRIDGE_KEY).toBe('companyos');
  });
});
