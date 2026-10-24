/**
 * The LIVE E2E gate config (run EXPLICITLY, never in the default suite):
 *
 *   COS_EXECUTION_ATTEMPT_TIMEOUT_MS=1800000 npx vitest run --config vitest.e2e.config.ts
 *
 * Same aliases as the default config; the include set is ONLY `e2e/**`, so the
 * bounded real-provider headless run never costs wall-clock/provider spend in
 * `pnpm check` — it is its own named gate.
 */
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
    include: ['e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    reporters: ['default'],
    testTimeout: 60 * 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 60_000,
    maxWorkers: 1,
  },
});
