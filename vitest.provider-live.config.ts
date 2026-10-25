import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * H14 — the LIVE external-provider gate (`pnpm test:provider:dsh:live`), per the S26
 * test taxonomy: real-provider compatibility runs SEPARATELY from the deterministic
 * suite (`pnpm test` / `pnpm check`). Before H14 the default config still included
 * `tests/provider/dsh-live.test.ts`, so every machine without the installed DSH
 * runtime failed the deterministic suite at import time. Not run in CI (no real
 * Provider/DSH without approval).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@companyos/core': r('./packages/core/src/index.ts'),
      '@companyos/contracts': r('./packages/contracts/src/index.ts'),
      '@companyos/engine': r('./packages/engine/src/index.ts'),
      '@companyos/persistence': r('./packages/persistence/src/index.ts'),
      '@companyos/observability': r('./packages/observability/src/index.ts'),
      '@companyos/pack-dev-company': r('./packs/dev-company/src/index.ts'),
    },
  },
  test: {
    setupFiles: [r('./tests/support/real-dsh-test-setup.ts')],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    include: ['tests/provider/**/*-live.test.ts'],
    fileParallelism: false,
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    reporters: ['default'],
  },
});
