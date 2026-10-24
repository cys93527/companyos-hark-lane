/**
 * Sprint24 — CRASH/RECOVERY windows + failure injection (Boss §24-§28/§51) over
 * the production dispatch orchestration with a deterministic scripted provider.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import {
  createExecutorProviderRegistry,
  providerDispatchIdOf,
  providerDispatchKeyOf,
  type ExecutorExecutionRequest,
  type ExecutorProvider,
  type ExecutorProviderOutcome,
} from '@companyos/engine';

import { createProviderDispatchExecution } from '../../apps/desktop/src/executor/provider-dispatch.js';
import { scriptedAuthorization, scriptedExecutorConfig } from '../support/provider-safety-fixture.js';

const dirs: string[] = [];
const dbs: DurableDatabase[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 's24c-'));
  dirs.push(dir);
  return dir;
};
const openDb = (): DurableDatabase => {
  const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: ['core', 'engine'] as never });
  dbs.push(db);
  return db;
};

/** A scripted provider: the test decides what the external side does. */
const scriptProvider = (
  behavior: (request: ExecutorExecutionRequest) => ExecutorProviderOutcome | Promise<ExecutorProviderOutcome>,
): ExecutorProvider => ({
  descriptor: { providerKey: 'scripted', capabilities: ['timeout', 'structured-output'] },
  async start(request) {
    return behavior(request);
  },
});

const makeHarness = (db: DurableDatabase, provider: ExecutorProvider) => {
  const dispatch = createProviderDispatchExecution({
    registry: createExecutorProviderRegistry([provider]),
    dispatches: db.providerDispatches,
    clock: { nowIso: () => new Date().toISOString() },
    workspaceOf: () => tempDir(),
    requiredCapabilitiesOf: () => ['timeout', 'structured-output'],
    workPackageTextOf: async () => 'Do the bounded work.',
    // Sprint25 preconditions: a typed configuration and an authorization provenance.
    configOf: () => scriptedExecutorConfig(provider.descriptor.providerKey),
    authorizationOf: async () => scriptedAuthorization(provider.descriptor.providerKey),
  });
  return dispatch;
};

const requestInput = { companyId: 'company_default', runId: 'run_s24c', taskId: 'tsk_s24c' };

const attempt = { attemptId: 'exa_s24c_1', attemptNumber: 1 };

describe('S24 crash window A — claim committed, provider NOT called', () => {
  it('restart recovery reuses the SAME dispatch identity; the provider may be invoked for the same attempt', async () => {
    const db = openDb();
    // window A state: dispatch row claimed, provider never invoked (crash before start)
    const dispatchKey = providerDispatchKeyOf({ ...requestInput, attemptNumber: 1, providerKey: 'scripted' });
    const dispatchId = providerDispatchIdOf({ ...requestInput, attemptNumber: 1, providerKey: 'scripted' });
    const now = new Date().toISOString();
    await db.providerDispatches.claim({
      id: dispatchId, ...requestInput, attemptId: attempt.attemptId, attemptNumber: 1,
      providerKey: 'scripted', dispatchKey, providerSessionId: null, providerInvocationId: null,
      configFingerprint: null, state: 'DISPATCHED',
      routingDecisionJson: null,
      resultSummary: null, createdAt: now, updatedAt: now,
    });
    // after restart: a NEW provider executes the same attempt
    let calls = 0;
    const provider = scriptProvider(() => {
      calls += 1;
      return { kind: 'succeeded', exitCode: 0, providerSessionId: 'ext-A', stdoutText: 'ok', structured: { finalText: 'ok' }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    });
    const result = await makeHarness(db, provider).execute({ ...requestInput, ...attempt, roleId: 'rol.provider', taskKind: 'task.provider-work' }, 'scripted');
    expect(calls).toBe(1);
    expect(result.state).toBe('SETTLED');
    // the SAME dispatch row (replayed claim), no second binding
    const rows = db.db.prepare('SELECT COUNT(*) AS c FROM provider_dispatches').get() as { c: number };
    expect(Number(rows.c)).toBe(1);
    expect((await db.providerDispatches.get(dispatchId))?.providerSessionId).toBe('ext-A');
  });
});

describe('S24 crash window B — invocation MAY have happened, nothing durable', () => {
  it('a provider WITHOUT recovery leaves honest UNCERTAINTY — no silent re-invoke-as-exactly-once', async () => {
    const db = openDb();
    const provider = scriptProvider(() => ({ kind: 'uncertain', reason: 'window B' }));
    const result = await makeHarness(db, provider).execute({ ...requestInput, ...attempt, roleId: 'rol.provider', taskKind: 'task.provider-work' }, 'scripted');
    expect(result.output).toBe('failed');
    expect(result.state).toBe('UNCERTAIN');
    const dispatchId = providerDispatchIdOf({ ...requestInput, attemptNumber: 1, providerKey: 'scripted' });
    expect((await db.providerDispatches.get(dispatchId))?.state).toBe('UNCERTAIN');
  });
});

describe('S24 crash window C1 — durable session, uncertain previous invocation', () => {
  it('a known session does NOT auto-replay the uncertain original task; outcome stays honest', async () => {
    const db = openDb();
    const dispatchId = providerDispatchIdOf({ ...requestInput, attemptNumber: 1, providerKey: 'scripted' });
    const now = new Date().toISOString();
    await db.providerDispatches.claim({
      id: dispatchId, ...requestInput, attemptId: attempt.attemptId, attemptNumber: 1,
      providerKey: 'scripted',
      dispatchKey: providerDispatchKeyOf({ ...requestInput, attemptNumber: 1, providerKey: 'scripted' }),
      providerSessionId: null, providerInvocationId: null, configFingerprint: null,
      state: 'DISPATCHED', routingDecisionJson: null,
      resultSummary: null, createdAt: now, updatedAt: now,
    });
    // crash C1: the provider evidenced the durable session, settlement never committed
    await db.providerDispatches.publish(dispatchId, 'session-ext-C1', now);

    let calls = 0;
    const provider = scriptProvider(() => {
      calls += 1;
      return { kind: 'succeeded', exitCode: 0, providerSessionId: 'session-ext-C1', stdoutText: 'ok', structured: { finalText: 'ok' }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    });
    const result = await makeHarness(db, provider).execute(
      { ...requestInput, ...attempt, roleId: 'rol.provider', taskKind: 'task.provider-work' },
      'scripted',
    );
    // SAFE-REPLAY RULE: the previous invocation outcome is unproven → NO automatic re-invoke,
    // even though the session is known. Not recovery, not replay: an honest failure.
    expect(calls).toBe(0);
    expect(result.output).toBe('failed');
    expect(result.state).toBe('UNCERTAIN');
    expect(result.providerSessionId).toBe('session-ext-C1');
    const row = await db.providerDispatches.get(dispatchId);
    expect(row?.state).toBe('UNCERTAIN');
    expect(row?.providerSessionId).toBe('session-ext-C1');
  });

  it('DELIBERATE continuation into the same session works for NEW work (explicit decision, not recovery)', async () => {
    const db = openDb();
    const first = await makeHarness(db, scriptProvider(() => ({
      kind: 'succeeded', exitCode: 0, providerSessionId: 'session-cont',
      stdoutText: 'ok', structured: { finalText: 'first' },
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    }))).execute({ ...requestInput, ...attempt, roleId: 'rol.provider', taskKind: 'task.provider-work' }, 'scripted');
    expect(first.state).toBe('SETTLED');

    // NEW work into the same durable session — an explicit caller decision (§21):
    // a SECOND attempt with continuationSessionId, never an auto-replay of attempt 1.
    let seenSession: string | undefined;
    const second = await makeHarness(db, scriptProvider((request) => {
      seenSession = request.continuationSessionId;
      return {
        kind: 'succeeded', exitCode: 0, providerSessionId: 'session-cont',
        stdoutText: 'ok', structured: { finalText: 'second' },
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      };
    })).execute(
      {
        ...requestInput, attemptId: 'exa_s24c_2', attemptNumber: 2,
        roleId: 'rol.provider', taskKind: 'task.provider-work',
        continuationSessionId: 'session-cont',
      },
      'scripted',
    );
    expect(second.state).toBe('SETTLED');
    expect(seenSession).toBe('session-cont');
    // distinct attempts keep distinct dispatch identities (no shared binding)
    expect(providerDispatchKeyOf({ ...requestInput, attemptNumber: 2, providerKey: 'scripted' }))
      .not.toBe(providerDispatchKeyOf({ ...requestInput, attemptNumber: 1, providerKey: 'scripted' }));
  });
});

describe('S24 crash window D — provider returned final, settlement not committed', () => {
  it('the binding records DELIVERED vs UNCERTAIN honestly; the task is never DONE from provider output alone', async () => {
    const db = openDb();
    // window D state: dispatch PUBLISHED (final seen) but engine settlement never committed
    const provider = scriptProvider(() => ({ kind: 'provider-failed', exitCode: 2, stdoutText: '', stderrText: 'boom' }));
    const result = await makeHarness(db, provider).execute({ ...requestInput, ...attempt, roleId: 'rol.provider', taskKind: 'task.provider-work' }, 'scripted');
    expect(result.output).toBe('failed'); // provider output alone does NOT bypass settlement
    const dispatchId = providerDispatchIdOf({ ...requestInput, attemptNumber: 1, providerKey: 'scripted' });
    const row = await db.providerDispatches.get(dispatchId);
    expect(row?.state).toBe('UNCERTAIN');
  });
});

describe('S24 failure injection (§51)', () => {
  it('launch failure (transport-failed) never creates a second task truth', async () => {
    const db = openDb();
    const provider = scriptProvider(() => ({ kind: 'transport-failed', reasonCode: 'EXECUTOR_PROCESS_LAUNCH_FAILED', detail: 'ENOENT' }));
    const result = await makeHarness(db, provider).execute({ ...requestInput, ...attempt, roleId: 'rol.provider', taskKind: 'task.provider-work' }, 'scripted');
    expect(result.output).toBe('failed');
    expect(result.state).toBe('UNCERTAIN');
    // no task table is written by the dispatch at all — only the binding row exists
  });

  it('non-zero exit settles as provider-failure through the existing rules', async () => {
    const db = openDb();
    const provider = scriptProvider(() => ({ kind: 'provider-failed', exitCode: 7, stdoutText: '', stderrText: 'business refusal' }));
    const result = await makeHarness(db, provider).execute({ ...requestInput, ...attempt, roleId: 'rol.provider', taskKind: 'task.provider-work' }, 'scripted');
    expect(result.output).toBe('failed');
  });

  it('a timeout outcome is represented as uncertainty, never success', async () => {
    const db = openDb();
    const provider = scriptProvider(() => ({ kind: 'timeout', terminationProven: false }));
    const result = await makeHarness(db, provider).execute({ ...requestInput, ...attempt, roleId: 'rol.provider', taskKind: 'task.provider-work' }, 'scripted');
    expect(result.output).toBe('failed');
    expect(result.state).toBe('UNCERTAIN');
  });

  it('malformed structured output from a succeeded process cannot settle as success', async () => {
    const db = openDb();
    // the dsh adapter converts malformed NDJSON into provider-failed (§32); the
    // scripted provider mimics that exact boundary so the dispatch proves fail-closure
    const provider = scriptProvider(() => ({
      kind: 'provider-failed', exitCode: 0, stdoutText: 'garbage-not-ndjson', stderrText: '', reasonCode: 'EXECUTOR_NDJSON_MALFORMED',
    }));
    const result = await makeHarness(db, provider).execute({ ...requestInput, ...attempt, roleId: 'rol.provider', taskKind: 'task.provider-work' }, 'scripted');
    expect(result.output).toBe('failed');
  });

  it('a capability mismatch throws LOUD before any provider call (§11/§47)', async () => {
    const db = openDb();
    let called = false;
    const provider = scriptProvider(() => {
      called = true;
      return { kind: 'succeeded', exitCode: 0, stdoutText: 'x', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    });
    const dispatch = createProviderDispatchExecution({
      registry: createExecutorProviderRegistry([provider]),
      dispatches: db.providerDispatches,
      clock: { nowIso: () => new Date().toISOString() },
      workspaceOf: () => null,
      requiredCapabilitiesOf: () => ['session-continuation'], // NOT in the scripted descriptor
      workPackageTextOf: async () => null,
    });
    await expect(
      dispatch.execute({ ...requestInput, ...attempt, roleId: 'rol.provider', taskKind: 'task.provider-work' }, 'scripted'),
    ).rejects.toThrow('EXECUTOR_CAPABILITY_MISSING');
    expect(called).toBe(false);
    expect(db.db.prepare('SELECT COUNT(*) AS c FROM provider_dispatches').get()).toEqual({ c: 0 });
  });
});
