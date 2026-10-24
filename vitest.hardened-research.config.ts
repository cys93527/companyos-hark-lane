import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * STAGE 5E-B — the HARDENED SECURITY RESEARCH gate (Boss §9).
 *
 * These suites measure the OS-isolation mechanisms the Boss has REJECTED for
 * V1 (AppContainer, dedicated identity, restricted token) — they are preserved
 * as research evidence for a future HARDENED_UNTRUSTED_WORKLOAD mode. Their
 * failures against the V1 Standard baseline are EXPECTED and classified:
 * network vectors = HOST_NETWORK_ISOLATION gap (accepted); process tree =
 * research harness measurement. They are NOT part of the main gate.
 *
 * Run: pnpm test:hardened-security-research
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
    testTimeout: 300_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    include: [
      'tests/sandbox-lab/**/*.test.ts',
      'tests/security-process-boundary.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // These suites spawn heavyweight kernel children; sequential eliminates
    // cross-file resource contention.
    fileParallelism: false,
    environment: 'node',
    reporters: ['default'],
  },
});
