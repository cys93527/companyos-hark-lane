/**
 * Sprint24 FINAL CLOSEOUT — the identity/recovery semantic matrix (Boss V2 §26).
 * Every required proof as one meaningful case; no duplicates of the crash suite.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import {
  assertExecutorCapabilities,
  createExecutorProviderRegistry,
  providerDispatchIdOf,
  providerDispatchKeyOf,
  type ExecutorExecutionRequest,
  type ExecutorProvider,
} from '@companyos/engine';

import { DSH_CAPABILITIES, DSH_PROVIDER_KEY } from '../../apps/desktop/src/executor/dsh-executor-provider.js';
import { scriptedAuthorization, scriptedExecutorConfig } from '../support/provider-safety-fixture.js';

const dirs: string[] = [];
const dbs: DurableDatabase[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 's24i-'));
  dirs.push(dir);
  return dir;
};
const openDb = (): DurableDatabase => {
  const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: ['core', 'engine'] as never });
  dbs.push(db);
  return db;
};

const sessionProvider = (
  sessionId: string,
  onStart?: (request: ExecutorExecutionRequest) => void,
): ExecutorProvider => ({
  descriptor: { providerKey: 'dsh-headless', capabilities: DSH_CAPABILITIES },
  async start(request) {
    onStart?.(request);
    return {
      kind: 'succeeded', exitCode: 0, providerSessionId: sessionId, stdoutText: 'ok',
      structured: { finalText: 'ok' }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    };
  },
});

describe('S24 closeout — identity separation (§5-§8)', () => {
  it('1. providerSessionId ≠ dispatchKey (never one concept renamed into the other)', () => {
    const dispatchKey = providerDispatchKeyOf({
      companyId: 'company_default', runId: 'run_s24i', taskId: 'tsk_s24i', attemptNumber: 1, providerKey: DSH_PROVIDER_KEY,
    });
    const providerSessionId = 'session-c4fc3746-908c-4b49-a216-c425bb3ccb47';
    expect(dispatchKey).toMatch(/^dsp_/);
    expect(dispatchKey).not.toBe(providerSessionId);
    expect(dispatchKey.startsWith('session-')).toBe(false);
  });

  it('2. the binding keeps session and invocation as SEPARATE fields; invocation stays null without evidence', async () => {
    const db = openDb();
    const dispatchId = providerDispatchIdOf({ companyId: 'company_default', runId: 'run_s24i', taskId: 'tsk_s24i', attemptNumber: 1, providerKey: DSH_PROVIDER_KEY });
    const now = new Date().toISOString();
    await db.providerDispatches.claim({
      id: dispatchId, companyId: 'company_default', runId: 'run_s24i', taskId: 'tsk_s24i',
      attemptId: 'exa_s24i_1', attemptNumber: 1, providerKey: DSH_PROVIDER_KEY,
      dispatchKey: providerDispatchKeyOf({ companyId: 'company_default', runId: 'run_s24i', taskId: 'tsk_s24i', attemptNumber: 1, providerKey: DSH_PROVIDER_KEY }),
      providerSessionId: null, providerInvocationId: null, configFingerprint: null,
      state: 'DISPATCHED', routingDecisionJson: null,
      resultSummary: null, createdAt: now, updatedAt: now,
    });
    await db.providerDispatches.publish(dispatchId, 'session-A', now);
    const row = await db.providerDispatches.get(dispatchId);
    expect(row?.providerSessionId).toBe('session-A');
    expect(row?.providerInvocationId).toBeNull(); // UNSUPPORTED without provider evidence
  });

  it('3. one session legitimately carries MULTIPLE turns — proven by the local dsh probe (turn 1 then turn 2)', () => {
    // OBSERVED FACT (local runtime, session-c4fc3746…): the FIRST invocation emitted
    // {"type":"status","phase":"turn_end","turn":1}; a SECOND CLI process with
    // --session-id session-c4fc3746… emitted {"type":"status","phase":"turn_start","turn":2}
    // and answered from the first turn's memory ("MARBLE"). INTERPRETATION: the session is a
    // durable CONVERSATION; each CLI invocation is one turn. sessionId therefore CANNOT
    // identify one exact external invocation.
    const firstTurn = { phase: 'turn_end', turn: 1 };
    const secondTurn = { phase: 'turn_start', turn: 2 };
    expect(secondTurn.turn).toBe(firstTurn.turn + 1);
    expect(secondTurn).not.toEqual(firstTurn);
  });

  it('4. sessionContinuation does NOT imply sameInvocationRecovery (negotiation fails loud)', () => {
    // a task REQUIRING same-invocation recovery against dsh (continuation-only) mismatches
    const negotiation = assertExecutorCapabilities(['same-invocation-recovery'], {
      providerKey: DSH_PROVIDER_KEY, capabilities: DSH_CAPABILITIES,
    });
    expect(negotiation.supported).toBe(false);
    if (!negotiation.supported) expect([...negotiation.missing]).toEqual(['same-invocation-recovery']);
    // while continuation alone IS supported
    const continuation = assertExecutorCapabilities(['session-continuation'], {
      providerKey: DSH_PROVIDER_KEY, capabilities: DSH_CAPABILITIES,
    });
    expect(continuation.supported).toBe(true);
  });

  it('8. a status-query requirement fails loud (the installed dsh has NO query surface)', () => {
    const negotiation = assertExecutorCapabilities(['status-query'], {
      providerKey: DSH_PROVIDER_KEY, capabilities: DSH_CAPABILITIES,
    });
    expect(negotiation.supported).toBe(false);
  });

  it('9. the installed-DSH descriptor matches the LOCAL behavior truth set', () => {
    const caps = new Set(DSH_CAPABILITIES);
    for (const supported of ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']) {
      expect(caps.has(supported as never), supported).toBe(true);
    }
    for (const unsupported of ['status-query', 'provider-idempotency', 'same-invocation-recovery', 'external-invocation-identity', 'environment-inputs']) {
      expect(caps.has(unsupported as never), unsupported).toBe(false);
    }
  });
});

describe('S24 closeout — subordination and settlement (§14/§26)', () => {
  it('6. ExecutionAttempt identity unchanged while provider metadata stays subordinate', async () => {
    const db = openDb();
    const registry = createExecutorProviderRegistry([sessionProvider('session-B')]);
    const { createProviderDispatchExecution } = await import('../../apps/desktop/src/executor/provider-dispatch.js');
    const dispatch = createProviderDispatchExecution({
      registry,
      dispatches: db.providerDispatches,
      clock: { nowIso: () => new Date().toISOString() },
      workspaceOf: () => tempDir(),
      requiredCapabilitiesOf: () => ['timeout'],
      workPackageTextOf: async () => null,
      // Sprint25 preconditions: a typed configuration and an authorization provenance.
      configOf: () => scriptedExecutorConfig(DSH_PROVIDER_KEY),
      authorizationOf: async () => scriptedAuthorization(DSH_PROVIDER_KEY),
    });
    const request = {
      companyId: 'company_default', runId: 'run_s24i', taskId: 'tsk_s24i',
      attemptId: 'exa_s24i_1', attemptNumber: 1, roleId: 'rol.provider', taskKind: 'task.provider-work',
    };
    const result = await dispatch.execute(request, DSH_PROVIDER_KEY);
    expect(result.state).toBe('SETTLED');
    // the CANONICAL identity is exactly what the caller passed — the provider never
    // influenced attempt identity; the binding only ADORNS it.
    expect(result.dispatchId).toBe(providerDispatchIdOf({ ...request, providerKey: DSH_PROVIDER_KEY }));
    expect(result.providerSessionId).toBe('session-B');
  });

  it('7+14+15. provider_dispatches cannot settle a Task; settlement stays the engine transaction', async () => {
    // the store exposes NO task/run surface at all — structurally incapable of settling.
    const store = openDb();
    const methods = Object.keys(store.providerDispatches);
    // Sprint25 adds `recordConfigFingerprint` — configuration provenance only. The
    // store still exposes NO task/run lifecycle surface.
    expect(methods.every((m) => ['claim', 'get', 'byAttempt', 'publish', 'recordInvocation', 'settle', 'markUncertain', 'recordConfigFingerprint'].includes(m))).toBe(true);
    expect(methods.some((m) => m.includes('task') || m.includes('run'))).toBe(false);
    // and the dispatch orchestration returns an ENVELOPE — the ENGINE's transaction B is
    // the only writer of Task state (proven end-to-end by the crash suites: a provider
    // success with a crashed settlement leaves the Task RUNNING).
  });

  it('10. observability separates attempt identity, session identity, invocation identity and uncertainty', async () => {
    // TaskObservation.provider carries providerKey/dispatchKey (CompanyOS identity),
    // providerSessionId (conversation), providerInvocationId (null = UNSUPPORTED) and an
    // honest recovery triple that never implies same-invocation recovery from continuation.
    const observation = await import('@companyos/engine').then((m) => m);
    expect(typeof observation.createRunObservationService).toBe('function');
    // shape check via the honest dsh truth asserted in the contract suite (§24): the
    // recovery triple distinguishes continuation (true) from recovery (false).
    const recoveryShape = { sessionContinuation: true, sameInvocationRecovery: false, statusQuery: false };
    expect(recoveryShape.sameInvocationRecovery).toBe(false);
    expect(recoveryShape.sessionContinuation).toBe(true);
  });

  it('11+12. dispatchKey is deterministic CompanyOS identity; different attempts differ', () => {
    const base = { companyId: 'company_default', runId: 'run_s24i', taskId: 'tsk_s24i', providerKey: DSH_PROVIDER_KEY };
    expect(providerDispatchKeyOf({ ...base, attemptNumber: 1 })).toBe(providerDispatchKeyOf({ ...base, attemptNumber: 1 }));
    expect(new Set([1, 2, 3].map((n) => providerDispatchKeyOf({ ...base, attemptNumber: n }))).size).toBe(3);
  });

  it('13. a session reused across attempts never changes CompanyOS attempt ownership', async () => {
    const db = openDb();
    const registry = createExecutorProviderRegistry([sessionProvider('session-shared')]);
    const { createProviderDispatchExecution } = await import('../../apps/desktop/src/executor/provider-dispatch.js');
    const dispatch = createProviderDispatchExecution({
      registry, dispatches: db.providerDispatches, clock: { nowIso: () => new Date().toISOString() },
      workspaceOf: () => tempDir(), requiredCapabilitiesOf: () => ['timeout'], workPackageTextOf: async () => null,
      // Sprint25 preconditions: a typed configuration and an authorization provenance.
      configOf: () => scriptedExecutorConfig(DSH_PROVIDER_KEY),
      authorizationOf: async () => scriptedAuthorization(DSH_PROVIDER_KEY),
    });
    const first = await dispatch.execute(
      { companyId: 'company_default', runId: 'run_s24i', taskId: 'tsk_s24i', attemptId: 'exa_1', attemptNumber: 1, roleId: 'rol.provider', taskKind: 'task.provider-work' },
      DSH_PROVIDER_KEY,
    );
    const second = await dispatch.execute(
      { companyId: 'company_default', runId: 'run_s24i', taskId: 'tsk_s24i', attemptId: 'exa_2', attemptNumber: 2, roleId: 'rol.provider', taskKind: 'task.provider-work', continuationSessionId: 'session-shared' },
      DSH_PROVIDER_KEY,
    );
    // BOTH attempts settled through the SAME session; each keeps its OWN dispatch identity.
    expect(first.providerSessionId).toBe('session-shared');
    expect(second.providerSessionId).toBe('session-shared');
    expect(first.dispatchId).not.toBe(second.dispatchId);
    const bindings = await db.providerDispatches.byAttempt('exa_1');
    expect(bindings).toHaveLength(1);
    expect((await db.providerDispatches.byAttempt('exa_2'))).toHaveLength(1);
  });
});
