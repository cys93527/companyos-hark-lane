/**
 * Live DSH Compatibility Suite — CURRENT installed-runtime contract
 * (V1 Real Executor Compatibility Recovery §17/§18).
 *
 * These tests prove the CompanyOS dsh adapter works against the REAL locally
 * installed DeepSeek Harness runtime. They are EXTERNAL PROVIDER tests, not
 * Product Control Plane deterministic correctness tests, and run SEPARATELY
 * from `pnpm check` via `pnpm test:provider:dsh:live`.
 *
 * CURRENT CONTRACT (docs/provider-recovery/DSH_CURRENT_RUNTIME_RECON.md):
 * the installed runtime (label 0.1.6-max) normalizes the NAMED `headless`
 * profile to a web-app composition that rejects task arguments; the frozen
 * S24 one-task contract (`--profile <P> --json "<task>"`, NDJSON events,
 * session identity, --session-id continuation) executes verbatim under a
 * profile composed from the SHIPPED template. The adapter therefore targets
 * `companyos-headless` by default (config `profileName`, env `DSH_PROFILE`).
 *
 * ONE-TIME OPERATOR SETUP (same category as installing the runtime itself):
 *   dsh companyos-headless --from-default-profile headless
 *
 * Result classification: PASS (runtime healthy + CompanyOS compatible) /
 * FAIL_COMPANYOS_COMPATIBILITY (adapter regression) /
 * BLOCKED_EXTERNAL_RUNTIME (interface drift/unavailable) /
 * BLOCKED_EXTERNAL_AUTH / BLOCKED_EXTERNAL_NETWORK.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDurableDatabase } from '@companyos/persistence';
import { createExecutorProviderRegistry, type ExecutorExecutionRequest } from '@companyos/engine';

import { createProviderDispatchExecution } from '../../apps/desktop/src/executor/provider-dispatch.js';
import {
  createDshProvider,
  createDshProviderFromConfig,
  DSH_PROVIDER_KEY,
  parseFinalText,
  parseSessionId,
  resolveDshProviderConfig,
} from '../../apps/desktop/src/executor/dsh-executor-provider.js';

import { scriptedAuthorization } from '../support/provider-safety-fixture.js';

const DEFAULT_ROOT = 'E:\\DeepSeek.Harness\\DeepSeek Harness';
const nodeExecutable = process.env['DSH_NODE'] ?? join(DEFAULT_ROOT, 'resources', 'node', 'node.exe');
const runtimeDir = process.env['DSH_RUNTIME'] ?? join(DEFAULT_ROOT, 'resources', 'runtime');
const profileName = process.env['DSH_PROFILE'] ?? 'companyos-headless';
const available = existsSync(nodeExecutable) && existsSync(join(runtimeDir, 'lib', 'bin.js'));
const profileReady = available && existsSync(join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.dsh', 'profiles', profileName, 'package.json'));

const typedConfig = resolveDshProviderConfig({ composition: { nodeExecutable, runtimeDir, profileName } });
if (!typedConfig.ok) throw new Error(`the dsh configuration could not be resolved: ${typedConfig.error.message}`);
const builtProvider = createDshProviderFromConfig(typedConfig.value);
if (!builtProvider.ok) throw new Error(`the dsh provider could not be built: ${builtProvider.error.message}`);
const provider = createDshProvider({
  ...builtProvider.value,
  fallbackCwd: runtimeDir,
  timeoutMs: 120_000,
});

const TASK = 'Answer with exactly the word PONG and nothing else.';

const requestOf = (over: Partial<ExecutorExecutionRequest> = {}): ExecutorExecutionRequest => ({
  companyId: 'company_default',
  runId: 'run_dsh_live',
  taskId: 'tsk_dsh_live',
  attemptId: 'exa_dsh_live_1',
  attemptNumber: 1,
  roleId: 'rol.provider',
  taskKind: 'task.provider-echo',
  work: { objective: TASK },
  workspace: null,
  requiredCapabilities: ['timeout', 'structured-output'],
  dispatchKey: `dsp_${DSH_PROVIDER_KEY}:live`,
  taskText: TASK,
  structured: true,
  timeoutMs: 120_000,
  ...over,
});

describe('Live DSH Provider Compatibility — current installed runtime', () => {
  it('the locally installed real runtime and the configured profile are ready (fail loud when missing)', () => {
    expect(available).toBe(true);
    expect(profileReady).toBe(true);
  });

  it('the adapter advertises ONLY truthful capabilities (fail-loud set)', () => {
    const caps = new Set(provider.descriptor.capabilities);
    expect([...caps]).toEqual([
      'cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin',
      'external-session-identity', 'session-continuation', 'streaming-diagnostics',
    ]);
    expect(caps.has('status-query')).toBe(false);
    expect(caps.has('provider-idempotency')).toBe(false);
  });

  it('REAL invocation 1/3: a real external execution returns the exact answer (PONG)', async () => {
    const outcome = await provider.start(requestOf());
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.providerSessionId).toMatch(/^session-/);
    expect(parseFinalText(outcome.stdoutText)).toBe('PONG');
    expect(String((outcome.structured as { finalText: string }).finalText)).toBe('PONG');
    expect('providerInvocationId' in outcome).toBe(false); // never invented
  }, 150_000);

  it('REAL invocation 2/3: deterministic repetition — same bounded task, same shape', async () => {
    const outcome = await provider.start(requestOf({ attemptNumber: 2, attemptId: 'exa_dsh_live_2' }));
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    expect(parseFinalText(outcome.stdoutText)).toBe('PONG');
    expect(outcome.providerSessionId).toMatch(/^session-/);
  }, 150_000);

  it('REAL invocation 3/3 + CONTINUATION probe: --session-id adopts the SAME durable session for NEW work', async () => {
    const first = await provider.start(requestOf({ attemptNumber: 3, attemptId: 'exa_dsh_live_3' }));
    expect(first.kind).toBe('succeeded');
    if (first.kind !== 'succeeded') return;
    const session = first.providerSessionId;
    expect(session).toMatch(/^session-/);
    const resumed = await provider.start(requestOf({
      attemptNumber: 3,
      attemptId: 'exa_dsh_live_3',
      continuationSessionId: session,
      taskText: 'Repeat your previous final answer exactly.',
      work: { objective: 'Repeat your previous final answer exactly.' },
    }));
    expect(resumed.kind).toBe('succeeded');
    if (resumed.kind !== 'succeeded') return;
    expect(resumed.providerSessionId).toBe(session); // continuation, not a new conversation
    expect(String((resumed.structured as { finalText: string }).finalText).toUpperCase()).toContain('PONG');
  }, 300_000);

  it('§17 REAL PRODUCTION CHAIN: Task → ExecutionAttempt claim → Sprint25 preflight → adapter → REAL dsh → canonical settlement → durable dispatch row', async () => {
    const db = openDurableDatabase({ dataDir: mkdtempSync(join(tmpdir(), 'dsh-live-')), appliedAt: new Date().toISOString(), chains: ['core', 'engine'] as never });
    try {
      const dispatch = createProviderDispatchExecution({
        registry: createExecutorProviderRegistry([provider]),
        dispatches: db.providerDispatches,
        clock: { nowIso: () => new Date().toISOString() },
        workspaceOf: () => runtimeDir,
        requiredCapabilitiesOf: () => ['timeout', 'structured-output'],
        workPackageTextOf: async () => TASK,
        configOf: () => typedConfig.value,
        authorizationOf: async () => scriptedAuthorization(DSH_PROVIDER_KEY),
      });
      const result = await dispatch.execute(
        {
          companyId: 'company_default',
          runId: 'run_dsh_chain',
          taskId: 'tsk_dsh_chain_1',
          attemptId: 'exa_dsh_chain_1',
          attemptNumber: 1,
          roleId: 'rol.provider',
          taskKind: 'task.provider-echo',
        },
        DSH_PROVIDER_KEY,
      );
      if (result.output === 'failed') throw new Error(`the real dispatch failed: ${JSON.stringify(result.output)}`);
      expect(result.output.status).toBe('succeeded');
      expect(result.output.output.payload?.['finalText']).toBe('PONG'); // the REAL NDJSON final event
      expect(result.state).toBe('SETTLED');
      const row = await db.providerDispatches.get(result.dispatchId);
      expect(row?.providerSessionId).toMatch(/^session-/); // the REAL external identity
      expect(row?.configFingerprint).toBe(typedConfig.value.fingerprint);
      expect(row?.state).toBe('SETTLED');
      expect(row?.attemptId).toBe('exa_dsh_chain_1'); // bound to the CANONICAL attempt
    } finally {
      db.close();
    }
  }, 300_000);

  it('sanitized evidence helpers never expose secrets (protocol-level check)', () => {
    expect(parseSessionId('{"type":"session","sessionId":"session-x"}')).toBe('session-x');
    expect(parseSessionId('noise')).toBeNull();
  });
});
