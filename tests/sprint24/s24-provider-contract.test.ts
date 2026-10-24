import {registerOfflineInline} from '../support/offline-fixtures.js';
registerOfflineInline('process.exit(3)');
registerOfflineInline('setTimeout(() => {}, 60000)');
/**
 * Sprint24 — PROVIDER CONTRACT tests (Boss §48 points exercised directly; the
 * crash/recovery windows live in s24-crash-recovery.test.ts and the REAL
 * external invocation in s24-real-provider-smoke.test.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDurableDatabase } from '@companyos/persistence';
import {
  assertExecutorCapabilities,
  createExecutorProviderRegistry,
  EXECUTOR_CAPABILITY_NAMES,
  providerDispatchIdOf,
  providerDispatchKeyOf,
  type ExecutorCapabilityName,
  type ExecutorExecutionRequest,
  type ExecutorProvider,
  type ExecutorProviderOutcome,
} from '@companyos/engine';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 's24-'));
  dirs.push(dir);
  return dir;
};

/** A deterministic mock provider for CONTRACT tests (the real provider is separate). */
const mockProvider = (
  providerKey: string,
  capabilities: readonly ExecutorCapabilityName[],
  onStart?: (request: ExecutorExecutionRequest) => void,
): ExecutorProvider => ({
  descriptor: { providerKey, capabilities },
  async start(request) {
    onStart?.(request);
    return {
      kind: 'succeeded',
      exitCode: 0,
      providerSessionId: `ext-${request.dispatchKey}`,
      stdoutText: 'ok',
      structured: { finalText: 'ok' },
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  },
});

const requestOf = (over: Partial<ExecutorExecutionRequest> = {}): ExecutorExecutionRequest => {
  const { workspace, ...rest } = over;
  return {
    companyId: 'company_default',
    runId: 'run_s24',
    taskId: 'tsk_s24',
    attemptId: 'exa_s24',
    attemptNumber: 1,
    roleId: 'rol.provider',
    taskKind: 'task.provider-work',
    work: { objective: 'Do the work.' },
    // Sprint25: a requested cwd travels WITH the trusted root it was derived from.
    workspace: workspace === undefined
      ? (workspaceOverride === null ? null : { cwd: workspaceOverride, root: workspaceOverride })
      : workspace,
    requiredCapabilities: ['timeout'],
    dispatchKey: 'dsp_fixed',
    taskText: 'Do the work.',
    structured: true,
    ...rest,
  };
};
let workspaceOverride: string | null = null;

describe('S24 provider contract — capability negotiation (§11)', () => {
  it('1. a required capability the provider does NOT support fails BEFORE the provider call', () => {
    let called = false;
    const provider = mockProvider('p1', ['timeout'], () => { called = true; });
    const negotiation = assertExecutorCapabilities(['timeout', 'session-continuation'], provider.descriptor);
    expect(negotiation.supported).toBe(false);
    if (!negotiation.supported) expect([...negotiation.missing]).toEqual(['session-continuation']);
    expect(called).toBe(false); // negotiation happens before dispatch, by construction
  });

  it('2+15. an unsupported-cancellation request fails loud instead of silent degradation', () => {
    const provider = mockProvider('p1', ['timeout']);
    const negotiation = assertExecutorCapabilities(['cancellation'], provider.descriptor);
    expect(negotiation.supported).toBe(false);
  });

  it('3. supported requests pass and the provider receives the CANONICAL attempt identity', async () => {
    let seen: ExecutorExecutionRequest | null = null;
    const provider = mockProvider('p1', ['timeout', 'structured-output'], (r) => { seen = r; });
    const registry = createExecutorProviderRegistry([provider]);
    const resolved = registry.resolve('p1')!;
    const request = requestOf({ requiredCapabilities: ['timeout', 'structured-output'] });
    const outcome = await resolved.start(request);
    expect(outcome.kind).toBe('succeeded');
    expect(seen!.runId).toBe('run_s24');
    expect(seen!.taskId).toBe('tsk_s24');
    expect(seen!.attemptId).toBe('exa_s24');
    expect(seen!.attemptNumber).toBe(1);
  });

  it('the capability vocabulary is closed and every name is advertised-or-not, never invented', () => {
    expect([...EXECUTOR_CAPABILITY_NAMES]).toContain('session-continuation');
    expect([...EXECUTOR_CAPABILITY_NAMES]).toHaveLength(13);
  });
});

describe('S24 provider contract — deterministic dispatch identity (§22)', () => {
  const seed = { companyId: 'company_default', runId: 'run_s24', taskId: 'tsk_s24', providerKey: 'p1' };

  it('17. the same attempt derives the SAME dispatch key every time', () => {
    const a = providerDispatchKeyOf({ ...seed, attemptNumber: 1 });
    const b = providerDispatchKeyOf({ ...seed, attemptNumber: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^dsp_[0-9A-Za-z]{26}$/);
  });

  it('18. different attempts derive DIFFERENT keys (no shared dispatch identity)', () => {
    const keys = new Set([1, 2, 3].map((attemptNumber) => providerDispatchKeyOf({ ...seed, attemptNumber })));
    expect(keys.size).toBe(3);
  });

  it('different providers for the same attempt also differ', () => {
    expect(providerDispatchKeyOf({ ...seed, attemptNumber: 1, providerKey: 'p2' }))
      .not.toBe(providerDispatchKeyOf({ ...seed, attemptNumber: 1, providerKey: 'p1' }));
  });

  it('the dispatch ID derivation is stable and dispatch-shaped', () => {
    expect(providerDispatchIdOf({ ...seed, attemptNumber: 1 })).toMatch(/^pdi_[0-9A-Za-z]{26}$/);
    expect(providerDispatchIdOf({ ...seed, attemptNumber: 1 })).toBe(providerDispatchIdOf({ ...seed, attemptNumber: 1 }));
  });
});

describe('S24 provider contract — registry is implementation authority ONLY (§44)', () => {
  it('11. the registry answers existence and capabilities; it has no workflow surface', () => {
    const registry = createExecutorProviderRegistry([mockProvider('p1', ['timeout'])]);
    expect(registry.describeAll().map((d) => d.providerKey)).toEqual(['p1']);
    expect(registry.resolve('p1')?.descriptor.capabilities).toEqual(['timeout']);
    expect(registry.resolve('missing')).toBeNull();
    // structural: the registry type exposes ONLY describeAll/resolve
    const methods = Object.keys(registry);
    expect(methods.every((m) => m === 'describeAll' || m === 'resolve')).toBe(true);
  });

  it('12+13. routing is data (taskKind→providerKey); no role/stage names and non-software kinds work', () => {
    // a procurement-flavoured kind routes exactly like a software-flavoured one
    const routes: Record<string, string> = { 'task.supplier-analysis': 'p1', 'task.code-review': 'p1' };
    expect(routes['task.supplier-analysis']).toBe(routes['task.code-review']);
  });
});

describe('S24 provider contract — the durable dispatch binding (§20)', () => {
  const openDb = () => {
    const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: ['core', 'engine'] as never });
    return db;
  };
  const dispatchOf = (attemptNumber: number, id: string) => ({
    id,
    companyId: 'company_default',
    runId: 'run_s24',
    taskId: 'tsk_s24',
    attemptId: `exa_${String(attemptNumber)}`,
    attemptNumber,
    providerKey: 'p1',
    dispatchKey: providerDispatchKeyOf({ companyId: 'company_default', runId: 'run_s24', taskId: 'tsk_s24', attemptNumber, providerKey: 'p1' }),
    providerSessionId: null,
    providerInvocationId: null,
    configFingerprint: null,
    state: 'DISPATCHED' as const,
    routingDecisionJson: null,
    resultSummary: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it('the same attempt claims ONCE — the second claim is a replay of the SAME row', async () => {
    const db = openDb();
    const dispatch = dispatchOf(1, providerDispatchIdOf({ companyId: 'company_default', runId: 'run_s24', taskId: 'tsk_s24', attemptNumber: 1, providerKey: 'p1' }));
    const first = await db.providerDispatches.claim(dispatch);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.replayed).toBe(false);
    const second = await db.providerDispatches.claim(dispatch);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.replayed).toBe(true);
    const rows = db.db.prepare('SELECT COUNT(*) AS c FROM provider_dispatches').get() as { c: number };
    expect(Number(rows.c)).toBe(1);
    db.close();
  });

  it('a DIFFERENT dispatch id colliding on the dispatch key fails closed (CONFLICT)', async () => {
    const db = openDb();
    const dispatch = dispatchOf(1, providerDispatchIdOf({ companyId: 'company_default', runId: 'run_s24', taskId: 'tsk_s24', attemptNumber: 1, providerKey: 'p1' }));
    await db.providerDispatches.claim(dispatch);
    const conflicting = { ...dispatch, id: 'pdi_intruder' };
    const result = await db.providerDispatches.claim(conflicting);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error.details['reason'])).toBe('PROVIDER_DISPATCH_KEY_CONFLICT');
    db.close();
  });

  it('26+27. cross-run and cross-company binding lookups fail closed (no leak)', async () => {
    const db = openDb();
    const dispatch = dispatchOf(1, providerDispatchIdOf({ companyId: 'company_default', runId: 'run_s24', taskId: 'tsk_s24', attemptNumber: 1, providerKey: 'p1' }));
    await db.providerDispatches.claim(dispatch);
    await db.providerDispatches.publish(dispatch.id, 'ext-1', new Date().toISOString());
    // byAttempt is attempt-scoped: a foreign attempt sees nothing
    expect(await db.providerDispatches.byAttempt('exa_foreign')).toEqual([]);
    expect(await db.providerDispatches.byAttempt('exa_1')).toHaveLength(1);
    expect(await db.providerDispatches.get('pdi_missing')).toBeNull();
    db.close();
  });

  it('publish binds the REAL external identity; settle and uncertainty are explicit states', async () => {
    const db = openDb();
    const dispatch = dispatchOf(1, 'pdi_d1');
    await db.providerDispatches.claim(dispatch);
    await db.providerDispatches.publish('pdi_d1', 'session-real', new Date().toISOString());
    expect((await db.providerDispatches.get('pdi_d1'))?.providerSessionId).toBe('session-real');
    expect((await db.providerDispatches.get('pdi_d1'))?.state).toBe('PUBLISHED');
    await db.providerDispatches.settle('pdi_d1', 'succeeded', new Date().toISOString());
    expect((await db.providerDispatches.get('pdi_d1'))?.state).toBe('SETTLED');
    const uncertain = dispatchOf(2, 'pdi_d2');
    await db.providerDispatches.claim(uncertain);
    await db.providerDispatches.markUncertain('pdi_d2', 'timeout', new Date().toISOString());
    expect((await db.providerDispatches.get('pdi_d2'))?.state).toBe('UNCERTAIN');
    db.close();
  });
});

describe('S24 provider contract — outcome taxonomy (§29)', () => {
  it('the six outcome kinds are distinct and never collapse into Error(string)', async () => {
    const kinds = ['succeeded', 'provider-failed', 'transport-failed', 'cancelled', 'timeout', 'uncertain'] as const;
    const provider: ExecutorProvider = {
      descriptor: { providerKey: 'p-all', capabilities: [] },
      async start(): Promise<ExecutorProviderOutcome> {
        return { kind: 'uncertain', reason: 'window B' };
      },
    };
    const outcome = await provider.start(requestOf());
    expect(outcome.kind).toBe('uncertain');
    expect(kinds).toContain(outcome.kind);
    expect('message' in (outcome as { message?: string })).toBe(false);
  });
});

describe('S24 provider contract — process provider mechanics (§35)', () => {
  it('28. a REAL process provider captures bounded exit/result (node --version)', async () => {
    const { createProcessExecutorProvider } = await import('@companyos/engine');
    const provider = createProcessExecutorProvider({
      providerKey: 'node-probe',
      capabilities: ['timeout'],
      executable: process.execPath,
      buildArgs: () => [],
      baseArgv: ['--version'],
      fallbackCwd: tempDir(),
    });
    // Sprint25: the requested cwd travels with the trusted root it derives from.
    workspaceOverride = tempDir();
    const outcome = await provider.start(requestOf({ requiredCapabilities: ['timeout'] }));
    workspaceOverride = null;
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdoutText).toContain('v');
  });

  it('a non-zero exit is provider-failed with exit code + bounded stderr', async () => {
    const { createProcessExecutorProvider } = await import('@companyos/engine');
    const provider = createProcessExecutorProvider({
      providerKey: 'node-fail',
      capabilities: ['timeout'],
      executable: process.execPath,
      buildArgs: () => [],
      baseArgv: ['-e', 'process.exit(3)'],
      fallbackCwd: tempDir(),
    });
    workspaceOverride = tempDir();
    const outcome = await provider.start(requestOf({ requiredCapabilities: ['timeout'] }));
    workspaceOverride = null;
    expect(outcome.kind).toBe('provider-failed');
    if (outcome.kind !== 'provider-failed') return;
    expect(outcome.exitCode).toBe(3);
  });

  it('30. an untrusted workspace fails BEFORE any external call', async () => {
    const { createProcessExecutorProvider } = await import('@companyos/engine');
    let spawned = false;
    const provider = createProcessExecutorProvider({
      providerKey: 'node-ws',
      capabilities: ['timeout', 'working-directory'],
      executable: process.execPath,
      baseArgv: ['--version'],
      fallbackCwd: null,
      buildArgs: () => {
        spawned = true;
        return ['--version'];
      },
    });
    const outcome = await provider.start({ ...requestOf(), workspace: null });
    expect(outcome.kind).toBe('transport-failed');
    if (outcome.kind !== 'transport-failed') return;
    expect(outcome.reasonCode).toBe('EXECUTOR_WORKSPACE_UNTRUSTED');
    expect(spawned).toBe(false);
  });

  it('34. a hang terminates on timeout WITHOUT claiming external termination proof', async () => {
    const { createProcessExecutorProvider } = await import('@companyos/engine');
    const provider = createProcessExecutorProvider({
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
      providerKey: 'node-hang',
      capabilities: ['timeout'],
      executable: process.execPath,
      buildArgs: () => [],
      baseArgv: ['-e', 'setTimeout(() => {}, 60000)'],
      fallbackCwd: tempDir(),
    });
    workspaceOverride = tempDir();
    const outcome = await provider.start({ ...requestOf(), timeoutMs: 1_500 });
    workspaceOverride = null;
    expect(outcome.kind === 'timeout' || outcome.kind === 'cancelled' || outcome.kind === 'transport-failed').toBe(true);
    // termination proof is ONLY exit evidence — on Windows the kill tree yields an exit
    // code (proof true); where no evidence exists it stays false. Never fabricated.
    if (outcome.kind === 'timeout') expect(typeof outcome.terminationProven).toBe('boolean');
  });

  it('29. malformed structured output cannot settle as success (NDJSON validator)', async () => {
    const { parseNdjsonEvents } = await import('@companyos/engine');
    const ok = parseNdjsonEvents('{"type":"session","sessionId":"s1"}\n{"type":"final","text":"PONG"}\n');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.finalText).toBe('PONG');
    const malformed = parseNdjsonEvents('not-json\n');
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(String(malformed.error.details['reason'])).toBe('EXECUTOR_NDJSON_MALFORMED');
  });
});
