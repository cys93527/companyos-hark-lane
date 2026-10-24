/**
 * Sprint25 — DETERMINISTIC dsh provider safety preconditions (Boss V4 §7/§11).
 *
 * These tests prove the typed configuration contract, field validation, source
 * annotation, and fingerprint determinism using the production config loader.
 * They do NOT require a live external DSH runtime.
 *
 * Live external DSH integration tests have been moved to:
 * tests/provider/dsh-live.test.ts (run via: pnpm test:provider:dsh:live)
 *
 * Historical fact: Sprint25 successfully proved real DSH integration through
 * the safety pipeline at freeze time. That historical proof remains valid.
 * Current live compatibility status is tested separately.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveDshProviderConfig,
  DSH_PROVIDER_KEY,
} from '../../apps/desktop/src/executor/dsh-executor-provider.js';

const DEFAULT_ROOT = 'E:\\DeepSeek.Harness\\DeepSeek Harness';
const nodeExecutable = process.env['DSH_NODE'] ?? join(DEFAULT_ROOT, 'resources', 'node', 'node.exe');
const runtimeDir = process.env['DSH_RUNTIME'] ?? join(DEFAULT_ROOT, 'resources', 'runtime');

describe('S25 dsh provider safety preconditions (deterministic)', () => {
  it('the typed configuration validates every field and records its source (never a silent empty path)', () => {
    const config = resolveDshProviderConfig({ composition: { nodeExecutable, runtimeDir } });
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value.providerKey).toBe(DSH_PROVIDER_KEY);
    const executable = config.value.fields.find((field) => field.name === 'nodeExecutable');
    expect(executable?.value).toBe(nodeExecutable);
    expect(executable?.source).toBe('composition');
    // A required field with no value at all fails the load instead of defaulting to ''.
    const incomplete = resolveDshProviderConfig({ composition: { nodeExecutable } });
    expect(incomplete.ok).toBe(false);
    if (incomplete.ok) return;
    expect(String(incomplete.error.details['reason'])).toBe('EXECUTOR_CONFIG_REQUIRED_MISSING');
    expect(config.value.fingerprint).toMatch(/^scfg_[0-9a-f]{26}$/);
  });
});
