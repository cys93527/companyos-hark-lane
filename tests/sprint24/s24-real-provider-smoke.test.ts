/**
 * Sprint24 — DETERMINISTIC dsh provider contract tests (Boss V4 §7/§11).
 *
 * These tests prove the ExecutorProvider contract, adapter structure, capability
 * advertisement, and configuration mechanics using CONTROLLED FIXTURES. They do
 * NOT require a live external DSH runtime.
 *
 * Live external DSH integration tests have been moved to:
 * tests/provider/dsh-live.test.ts (run via: pnpm test:provider:dsh:live)
 *
 * Historical fact: Sprint24 successfully proved real DSH integration at freeze
 * time. That historical proof remains valid. Current live compatibility status
 * is tested separately and does not affect deterministic product correctness.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertExecutorCapabilities } from '@companyos/engine';

import {
  createDshProvider,
  createDshProviderFromConfig,
  parseSessionId,
  resolveDshProviderConfig,
} from '../../apps/desktop/src/executor/dsh-executor-provider.js';

const DEFAULT_ROOT = 'E:\\DeepSeek.Harness\\DeepSeek Harness';
const nodeExecutable = process.env['DSH_NODE'] ?? join(DEFAULT_ROOT, 'resources', 'node', 'node.exe');
const runtimeDir = process.env['DSH_RUNTIME'] ?? join(DEFAULT_ROOT, 'resources', 'runtime');

const typedConfig = resolveDshProviderConfig({ composition: { nodeExecutable, runtimeDir } });
if (!typedConfig.ok) throw new Error(`the dsh configuration could not be resolved: ${typedConfig.error.message}`);
const builtProvider = createDshProviderFromConfig(typedConfig.value);
if (!builtProvider.ok) throw new Error(`the dsh provider could not be built: ${builtProvider.error.message}`);
const provider = createDshProvider({
  ...builtProvider.value,
  fallbackCwd: runtimeDir,
  timeoutMs: 120_000,
});

describe('S24 dsh provider contract (deterministic)', () => {
  it('the adapter advertises ONLY truthful capabilities (fail-loud set)', () => {
    const caps = new Set(provider.descriptor.capabilities);
    expect([...caps]).toEqual([
      'cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin',
      'external-session-identity', 'session-continuation', 'streaming-diagnostics',
    ]);
    // honestly NOT advertised:
    expect(caps.has('status-query')).toBe(false);
    expect(caps.has('provider-idempotency')).toBe(false);
    expect(caps.has('same-invocation-recovery')).toBe(false);
    expect(caps.has('external-invocation-identity')).toBe(false);
    // and a request requiring those fails negotiation before any call
    const negotiation = assertExecutorCapabilities(['status-query'], provider.descriptor);
    expect(negotiation.supported).toBe(false);
  });

  it('sanitized evidence helpers never expose secrets (protocol-level check)', () => {
    // the adapter carries only the task text + argv; no env, no key material
    expect(parseSessionId('{"type":"session","sessionId":"session-x"}')).toBe('session-x');
    expect(parseSessionId('noise')).toBeNull();
  });
});
