import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
import offline from './vitest.config.js';
/** Retained native assertions; separate authorization and supervisor are needed. */
export default defineConfig({
  ...offline,
  test: {
    ...offline.test,
    include: ['tests/windows-shell/**/*.live.test.ts'],
    exclude: ['**/node_modules/**','**/dist/**'],
    setupFiles: [fileURLToPath(new URL('./tests/support/windows-shell-test-setup.ts',import.meta.url))],
    fileParallelism: false,
  },
});
