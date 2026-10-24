import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Renderer build.
 *
 * Sprint 0 hard rule: the renderer must not import Node built-ins or Electron —
 * it talks to the main process exclusively through the typed preload bridge
 * (`window.companyos`). `apps/renderer/tests/no-node-builtins.test.ts` enforces it.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
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
