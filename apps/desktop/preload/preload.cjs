'use strict';
/**
 * Preload bridge — the ONLY surface the renderer ever sees.
 *
 * Hard rules (planning-document §四十七):
 *   - `ipcRenderer` is never handed to the renderer; only these three wrappers are.
 *   - every channel goes through the allow-list below, so a renderer cannot call
 *     an arbitrary main-process handler even if it is compromised.
 *   - the exposed object is frozen.
 *
 * This file is CommonJS because it runs in a sandboxed preload context, where ES
 * modules are unavailable. The channel list MUST stay identical to
 * `apps/desktop/src/channels.ts`; `apps/desktop/tests/channels.test.ts` enforces it.
 */
const { contextBridge, ipcRenderer } = require('electron');

const BRIDGE_KEY = 'companyos';

const ALLOWED_CHANNELS = Object.freeze([
  'companyos:app-version',
  'companyos:platform-info',
  'companyos:database-status',
  'companyos:workflow',
  'companyos:control-plane',
  'companyos:workspace-select',
  'companyos:workspace-open',
  'companyos:workspace-current',
  'companyos:workspace-switch',
  'companyos:artifacts',
]);

function invoke(channel, ...args) {
  if (!ALLOWED_CHANNELS.includes(channel)) {
    return Promise.reject(new Error(`Channel "${channel}" is not allow-listed by CompanyOS.`));
  }
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld(
  BRIDGE_KEY,
  Object.freeze({
    appVersion: () => invoke('companyos:app-version'),
    platformInfo: () => invoke('companyos:platform-info'),
    databaseStatus: () => invoke('companyos:database-status'),
    // The Designer gets exactly one method; it cannot reach any other channel.
    workflowRequest: (request) => invoke('companyos:workflow', request),
    controlPlaneRequest: (request) => invoke('companyos:control-plane', request),
    workspaceSelect: () => invoke('companyos:workspace-select'),
    workspaceOpen: (root) => invoke('companyos:workspace-open', root),
    workspaceCurrent: () => invoke('companyos:workspace-current'),
    // Canonical single-workspace change: trusted close→open lifecycle, fail-closed.
    workspaceSwitch: (root) => invoke('companyos:workspace-switch', root),
    // STAGE 3: bounded artifact actions. The renderer names a canonical artifact id only.
    artifactAction: (request) => invoke('companyos:artifacts', request),
    channels: () => [...ALLOWED_CHANNELS],
  }),
);
