import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { cspMetaTag } from '../desktop/src/csp.js';

/**
 * AUDIT-D9 — the packaged app loads index.html over file://, where a response-header CSP
 * is not delivered, so the BUILT index.html carries the same CSP (apps/desktop/src/csp.ts)
 * as a <meta http-equiv>. Build only: the Vite dev server (HMR inline preamble + websocket)
 * keeps its defaults, as before.
 */
export const companyosCspMeta = (): Plugin => ({
  name: 'companyos-csp-meta',
  apply: 'build',
  transformIndexHtml: () => [cspMetaTag()],
});

/**
 * Renderer build.
 *
 * Sprint 0 hard rule: the renderer must not import Node built-ins or Electron —
 * it talks to the main process exclusively through the typed preload bridge
 * (`window.companyos`). `apps/renderer/tests/no-node-builtins.test.ts` enforces it.
 */
export default defineConfig({
  base: './',
  plugins: [react(), companyosCspMeta()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome130',
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
