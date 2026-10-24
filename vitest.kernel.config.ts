import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * STAGE 4 — the EMBEDDED KERNEL gate config. These suites spawn the REAL external
 * agent runtime (heavy managed child processes) and therefore run as their OWN
 * named gate (`pnpm test:kernel`), outside the parallel deterministic suite —
 * the same discipline the live provider suites use.
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
    include: ['tests/kernel/**/*.test.ts'],
    // Real-runtime gate: the suites spawn heavyweight managed kernel children;
    // sequential files eliminate cross-file resource contention (one flaky
    // parallel round observed, zero after sequencing).
    fileParallelism: false,
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/kernel/support/**'],
    environment: 'node',
    reporters: ['default'],
  },
});
