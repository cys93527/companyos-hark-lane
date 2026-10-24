/**
 * The DEDICATED config for the Task-18-08 real-process crash child. The main suite excludes
 * `tests/sprint18/child/**` (see the root vitest.config.ts): this file is a spawned child
 * harness, not a suite member — it only runs when the parent test spawns vitest with this
 * config and the T18_08_* environment, and it terminates abruptly by design.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@companyos/core': r('../../../packages/core/src/index.ts'),
      '@companyos/contracts': r('../../../packages/contracts/src/index.ts'),
      '@companyos/engine': r('../../../packages/engine/src/index.ts'),
      '@companyos/persistence': r('../../../packages/persistence/src/index.ts'),
      '@companyos/observability': r('../../../packages/observability/src/index.ts'),
    },
  },
  test: {
    testTimeout: 120_000,
    // The child harness file ONLY; the root stays the config's own directory.
    include: ['**/crash-child.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
