import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

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
    globalSetup: [],
    setupFiles: [r('./tests/support/offline-test-setup.ts')],
    /**
     * Preventive headroom (Closeout-7.5): the durable-database suites open several SQLite
     * files and apply six migration chains, which is heavy under parallel file load.
     *
     * NOTE: this is NOT the cause of the one full-gate `test` failure seen during Sprint 7.5.
     * That failure was deterministic and is fixed elsewhere: `docs/tests/handoff.test.ts`
     * requires the "记录值" field in PROJECT_HANDOFF.md to hold a real 40-hex commit hash, and
     * it briefly held prose instead. No retry, skip or assertion was weakened here.
     */
    testTimeout: 30_000,
    hookTimeout: 60_000,
    teardownTimeout: 60_000,
    // Worker concurrency bound: the birpc onTaskUpdate timeout (60s internal,
    // not configurable) fires when too many parallel workers starve the main
    // thread's event loop under heavy disk I/O. Limiting to 4 workers keeps the
    // RPC responsive while maintaining parallelism.
    maxWorkers: 4,
    minWorkers: 1,
    include: [
      'packages/*/tests/**/*.test.ts',
      'packs/*/tests/**/*.test.ts',
      'apps/*/tests/**/*.test.ts',
      'docs/tests/**/*.test.ts',
      // Integration tests that span packages (engine over the durable persistence layer).
      'tests/**/*.test.ts',
    ],
    // Task-18-08: the real-process crash child runs ONLY under its own spawned config.
    // STAGE 4: embedded-kernel suites spawn the REAL external agent runtime; they run
    // as their own named gate (pnpm test:kernel) instead of contending in the parallel suite.
    // Native Windows association/WSH cases keep their assertions in a separate
    // gate. They are NOT RUN, never counted as offline passes.
    // H14: live external-provider suites run only under vitest.provider-live.config.ts
    // (S26 taxonomy: never part of the deterministic suite).
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/sprint18/child/**', 'tests/kernel/**', 'tests/windows-shell/**', 'tests/sandbox-lab/**', 'tests/security-process-boundary.test.ts', 'tests/provider/**/*-live.test.ts'],
    environment: 'node',
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'apps/*/src/**/*.tsx'],
      exclude: ['**/index.ts', '**/*.d.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
      },
    },
  },
});
