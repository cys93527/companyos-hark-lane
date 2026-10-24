/**
 * Sprint25 — the CONFIGURATION AUTHORITY (Boss §18-§21/§40).
 *
 * The law under test: provider configuration is typed and validated, its precedence
 * is explicit (composition > environment > default), every effective value records
 * which source produced it, and a frozen ExecutionAttempt never silently runs under a
 * configuration it was not claimed under.
 *
 * Ad-hoc string reads at the composition root (the Sprint24 `?? ''` pattern) are what
 * these tests exist to prevent.
 */
import { describe, expect, it } from 'vitest';

import {
  assertConfigUnchanged,
  configDriftOf,
  configFieldOf,
  executorConfigFingerprint,
  resolveExecutorConfig,
  type ExecutorConfigSchema,
} from '@companyos/engine';

const SCHEMA: ExecutorConfigSchema = {
  executable: { name: 'executable', kind: 'absolute-path', required: true },
  runtimeDir: { name: 'runtimeDir', kind: 'absolute-path', required: true },
  timeoutMs: { name: 'timeoutMs', kind: 'integer', required: false, defaultValue: 120_000, min: 1_000, max: 3_600_000 },
  headless: { name: 'headless', kind: 'boolean', required: false, defaultValue: true },
};

const BASE = {
  providerKey: 'dsh-headless',
  schema: SCHEMA,
  envNames: { executable: 'DSH_NODE', runtimeDir: 'DSH_RUNTIME', timeoutMs: 'DSH_TIMEOUT_MS' },
};

const ENV = {
  DSH_NODE: 'E:\\harness\\node\\node.exe',
  DSH_RUNTIME: 'E:\\harness\\runtime',
};

describe('S25 config authority — typed, validated, explicit precedence (§18-§19)', () => {
  it('1. the environment supplies values when the composition does not, and the source is recorded', () => {
    const resolved = resolveExecutorConfig({ ...BASE, environment: ENV });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(configFieldOf(resolved.value, 'executable')).toEqual({
      name: 'executable',
      value: 'E:\\harness\\node\\node.exe',
      source: 'environment',
    });
    // An undeclared field still carries its declared default as its own source.
    expect(configFieldOf(resolved.value, 'timeoutMs')?.source).toBe('default');
    expect(configFieldOf(resolved.value, 'timeoutMs')?.value).toBe(120_000);
  });

  it('2. a composition override WINS over the environment (composition > environment > default)', () => {
    const resolved = resolveExecutorConfig({
      ...BASE,
      environment: ENV,
      composition: { runtimeDir: 'D:\\composed\\runtime' },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(configFieldOf(resolved.value, 'runtimeDir')?.value).toBe('D:\\composed\\runtime');
    expect(configFieldOf(resolved.value, 'runtimeDir')?.source).toBe('composition');
    expect(configFieldOf(resolved.value, 'executable')?.source).toBe('environment');
  });

  it('3. a missing REQUIRED field fails the load (never a silent empty-string fallback)', () => {
    // executable resolves; runtimeDir is the first missing required field.
    const resolved = resolveExecutorConfig({ ...BASE, environment: { DSH_NODE: ENV.DSH_NODE } });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe('VALIDATION_FAILED');
    expect(String(resolved.error.details['reason'])).toBe('EXECUTOR_CONFIG_REQUIRED_MISSING');
    // The failure names the environment variable an operator should set.
    expect(String(resolved.error.details['field'])).toBe('runtimeDir');
    expect(String(resolved.error.details['envName'])).toBe('DSH_RUNTIME');
  });

  it('4. a non-absolute path and an out-of-range integer are typed validation failures', () => {
    const path = resolveExecutorConfig({
      ...BASE,
      environment: { DSH_NODE: 'node.exe', DSH_RUNTIME: 'E:\\harness\\runtime' },
    });
    expect(path.ok).toBe(false);
    if (path.ok) return;
    expect(String(path.error.details['reason'])).toBe('EXECUTOR_CONFIG_PATH_NOT_ABSOLUTE');

    const range = resolveExecutorConfig({
      ...BASE,
      environment: { ...ENV, DSH_TIMEOUT_MS: '10' },
    });
    expect(range.ok).toBe(false);
    if (range.ok) return;
    expect(String(range.error.details['reason'])).toBe('EXECUTOR_CONFIG_RANGE');
  });

  it('5. an EMPTY override never shadows a lower-precedence source', () => {
    const resolved = resolveExecutorConfig({
      ...BASE,
      environment: ENV,
      composition: { runtimeDir: '' },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(configFieldOf(resolved.value, 'runtimeDir')?.value).toBe('E:\\harness\\runtime');
    expect(configFieldOf(resolved.value, 'runtimeDir')?.source).toBe('environment');
  });
});

describe('S25 config authority — fingerprint and drift safety (§20-§21)', () => {
  it('6. the fingerprint is deterministic, and a different VALUE changes it', () => {
    const first = resolveExecutorConfig({ ...BASE, environment: ENV });
    const same = resolveExecutorConfig({ ...BASE, environment: { ...ENV } });
    const other = resolveExecutorConfig({ ...BASE, environment: { ...ENV, DSH_RUNTIME: 'E:\\other\\runtime' } });
    expect(first.ok && same.ok && other.ok).toBe(true);
    if (!first.ok || !same.ok || !other.ok) return;
    expect(first.value.fingerprint).toBe(same.value.fingerprint);
    expect(first.value.fingerprint).not.toBe(other.value.fingerprint);
    expect(first.value.fingerprint).toMatch(/^scfg_[0-9a-f]{26}$/);
  });

  it('7. the fingerprint changes when only the SOURCE changes (provenance is part of identity)', () => {
    const fromEnv = executorConfigFingerprint([{ name: 'runtimeDir', value: 'E:\\harness\\runtime', source: 'environment' }]);
    const fromComposition = executorConfigFingerprint([{ name: 'runtimeDir', value: 'E:\\harness\\runtime', source: 'composition' }]);
    expect(fromEnv).not.toBe(fromComposition);
  });

  it('8. a frozen attempt refuses a drifted configuration and accepts the one it was claimed under', () => {
    const claimed = 'scfg_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const unchanged = assertConfigUnchanged(claimed, claimed);
    expect(unchanged.ok).toBe(true);

    const drifted = assertConfigUnchanged(claimed, 'scfg_bbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(drifted.ok).toBe(false);
    if (drifted.ok) return;
    expect(drifted.error.code).toBe('CONFLICT');
    expect(String(drifted.error.details['reason'])).toBe('EXECUTOR_CONFIG_DRIFT');

    // No history is its own verdict — neither "matched" nor "drifted".
    expect(configDriftOf(null, claimed).kind).toBe('no-history');
    expect(configDriftOf(claimed, claimed).kind).toBe('match');
    expect(configDriftOf(claimed, 'scfg_bbbbbbbbbbbbbbbbbbbbbbbbbb').kind).toBe('drift');
  });
});
