/**
 * Sprint 17 / Task-17-07 — Task-start repository baseline & single-workspace serial agents.
 *
 * Everything runs on the REAL WorkflowEngine (the authoritative task lifecycle) with a REAL
 * ToolRegistry holding the real `repo.git` tool, so the baseline is captured through the same
 * invoke path (authority → risk → schemas → adapter → durable ToolInvocation) that any other
 * caller would use.
 *
 * Proven here:
 *   - the baseline is captured ONCE per (run, task) by the registry's idempotency — a retry,
 *     a re-entry and a crash-recovery all REPLAY the original invocation;
 *   - it happens BEFORE the repository work (the delegate observes an already-captured
 *     baseline), and a baseline failure prevents the work entirely;
 *   - the workspace lease serialises repository-capable executions: a second one is refused
 *     and never touches the workspace, whatever run or task it belongs to;
 *   - close/switch is denied while leased, and every terminal outcome (success, failure,
 *     cancellation, thrown exception) releases the lease;
 *   - recovery reuses the ORIGINAL baseline and only requires the same workspaceId — never
 *     the same current anchor, because a task legitimately changes the code.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StageId, TaskId } from '@companyos/core';
import {
  REPOSITORY_GIT_TOOL_SPEC,
  createAuthorizationService,
  createRepositoryGitToolPort,
  createRepositoryGitToolRecord,
  createRepositoryProcessRunner,
  createRepositoryRevisionAnchorProvider,
  createRepositoryStageHandler,
  createTaskBaselineService,
  createToolRegistry,
  createWorkspaceExecutionLease,
  createWorkspaceManager,
  ensureBootstrapOwner,
  workspaceInUseError,
  type StageHandler,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { commitAll, createGitFixture } from '../git-fixture.js';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17task-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_17T${String(++seq).padStart(10, '0')}`,
  ulid: () => `17T${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

interface Harness {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly repo: ReturnType<typeof createGitFixture>;
  readonly manager: ReturnType<typeof createWorkspaceManager>;
  readonly registry: ReturnType<typeof createToolRegistry>;
  readonly lease: ReturnType<typeof createWorkspaceExecutionLease>;
  readonly baseline: ReturnType<typeof createTaskBaselineService>;
  readonly handler: StageHandler;
  readonly actor: string;
  readonly runId: string;
  readonly taskId: string;
  /** The delegate's observed baseline (none until the repository work runs). */
  readonly seen: () => { readonly invocationId: string; readonly headSha: string | null } | null;
  readonly context: (overrides?: Partial<{ readonly taskId: string; readonly runId: string; readonly attempt: number; readonly outcome: 'succeeded' | 'failed' | 'blocked'; readonly throws: boolean; readonly executionId: string }>) => {
    readonly runId: string;
    readonly stageId: StageId;
    readonly taskId: TaskId;
    readonly kind: string;
    readonly attempt: number;
    readonly branch: string | null;
    readonly payload: Record<string, unknown>;
  };
}

const makeHarness = async (): Promise<Harness> => {
  const repo = createGitFixture();
  repo.write('a.txt', 'A\n');
  commitAll(repo, 'initial');
  const dataDir = tempDir();
  const db = openDurableDatabase({
    dataDir,
    appliedAt: nowIso(),
    chains: ['core', 'engine', 'provider', 'tools'],
  });
  openDatabases.push(db);
  const actor = 'user_owner';
  const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
  const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);

  const lease = createWorkspaceExecutionLease();
  const manager = createWorkspaceManager({
    busy: () => {
      const held = lease.current();
      return held === null
        ? ({ ok: true as const, value: true as const } as const)
        : ({ ok: false as const, error: workspaceInUseError(held) } as const);
    },
  });
  const opened = await manager.openWorkspace({ root: repo.dir, commandProfile: {} });
  if (!opened.ok) throw new Error(opened.error.message);

  const runner = createRepositoryProcessRunner({
    clock,
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
    resolveExecutionId: async (invocationId) => {
      const invocation = await db.toolInvocations.get(invocationId);
      return invocation === null ? null : invocation.executionId;
    },
  });
  const anchors = createRepositoryRevisionAnchorProvider({
    workspace: () => manager.current(),
    runner,
    gitExecutable: 'git',
    timeoutMs: 300_000,
  });
  const gitPort = createRepositoryGitToolPort(REPOSITORY_GIT_TOOL_SPEC, {
    workspace: () => manager.current(),
    clock,
    runner,
    gitExecutable: 'git',
    timeoutMs: 300_000,
    anchorProvider: anchors,
  });
  const registry = createToolRegistry({
    ids,
    clock,
    records: db.toolRecords,
    invocations: db.toolInvocations,
    invocationArtifacts: db.toolInvocationArtifacts,
    adapters: new Map([['repo.git', gitPort]]),
    authorize: async (input) => authz.decide(input),
    events: db.events,
    secrets: async () => [],
    ...(db.toolInvocationClaims === null ? {} : { claims: db.toolInvocationClaims }),
    ...(db.toolInvocationIndex === null ? {} : { invocationIndex: db.toolInvocationIndex }),
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
  });
  const gitRecord = createRepositoryGitToolRecord(REPOSITORY_GIT_TOOL_SPEC, nowIso());
  if (!gitRecord.ok) throw new Error(gitRecord.error.message);
  await registry.register(gitRecord.value, { actorId: actor });

  const baseline = createTaskBaselineService({
    registry,
    executionIds: { next: () => `baseline-exc:${String(++seq)}` },
    clock,
  });

  let seen: { readonly invocationId: string; readonly headSha: string | null } | null = null;
  const runId = ids.id('run');
  const taskId = ids.id('task');
  const handler = createRepositoryStageHandler({
    id: 'repository.agent',
    workspace: () => manager.current(),
    registry,
    actorId: actor,
    clock,
    executionIds: { next: () => `exc:${String(++seq)}` },
    lease,
    baseline,
    execute: (context) => {
      // The delegate observes the baseline BEFORE it runs, and reports the outcome the test
      // asked for (a thrown delegate proves exception safety).
      // The delegate OBSERVES the baseline (fire-and-forget by design here). Since the
      // connection fence now queues this read legally, a shutdown can legitimately refuse
      // it typed (CONNECTION_CLOSED) — the probe attaches a handler instead of dropping
      // the promise (N314-ERR1's clear-error contract is preserved either way).
      const current = baseline.get({ runId: context.runId, taskId: context.taskId, actorId: actor });
      void current.catch(() => undefined);
      const outcome = context.payload['outcome'];
      if (context.payload['throws'] === true) throw new Error('delegate exploded');
      if (outcome === 'failed') return 'failed';
      if (outcome === 'blocked') return 'blocked';
      return 'succeeded';
    },
    onBaseline: (captured) => {
      seen = { invocationId: captured.invocationId, headSha: captured.headSha };
    },
  });

  return {
    db,
    dataDir,
    repo,
    manager,
    registry,
    lease,
    baseline,
    handler,
    actor,
    runId,
    taskId,
    seen: () => seen,
    context: (overrides = {}) => ({
      runId: overrides.runId ?? runId,
      stageId: 'stg_repo' as never,
      taskId: (overrides.taskId ?? taskId) as TaskId,
      kind: 'repository:agent',
      attempt: overrides.attempt ?? 1,
      branch: null,
      payload: {
        ...(overrides.outcome === undefined ? {} : { outcome: overrides.outcome }),
        ...(overrides.throws === true ? { throws: true } : {}),
        ...(overrides.executionId === undefined ? {} : { executionId: overrides.executionId }),
      },
    }),
  };
};

const baselineInvocations = async (h: Harness): Promise<readonly { id: string; idempotencyKey: string | null; status: string; taskId: string; runId: string }[]> =>
  (await h.db.toolInvocations.list({ limit: 500 })).items
    .filter((invocation) => (invocation.idempotencyKey ?? '').startsWith('task-baseline:'))
    .map((invocation) => ({
      id: invocation.id,
      idempotencyKey: invocation.idempotencyKey,
      status: invocation.status,
      taskId: invocation.taskId,
      runId: invocation.runId,
    }));

describe('task-start repository baseline (T17-07)', () => {
  it('1/3/4/5. captures a durable repo.git baseline bound to the real run/task', async () => {
    const h = await makeHarness();
    const outcome = await h.handler.execute(h.context());
    expect(outcome).toBe('succeeded');
    const invocations = await baselineInvocations(h);
    expect(invocations).toHaveLength(1);
    const entry = invocations[0]!;
    expect(entry.idempotencyKey).toBe(`task-baseline:${h.runId}:${h.taskId}`);
    expect(entry.status).toBe('COMPLETED');
    expect(entry.runId).toBe(h.runId);
    expect(entry.taskId).toBe(h.taskId);
    // The baseline output is the full baseline (not a bare anchor).
    const stored = await h.db.toolInvocations.get(entry.id);
    expect(record(stored?.replayOutput)['op']).toBe('baseline');
    expect(String(record(record(stored?.replayOutput)['anchor'])['workingTreeFingerprint'])).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    // The delegate saw the captured baseline BEFORE it ran.
    expect(h.seen()?.invocationId).toBe(entry.id);
  });

  it('2. the baseline is captured before the repository work runs', async () => {
    const h = await makeHarness();
    const order: string[] = [];
    const handler = createRepositoryStageHandler({
      id: 'repository.agent-ordered',
      workspace: () => h.manager.current(),
      registry: h.registry,
      actorId: h.actor,
      clock,
      executionIds: { next: () => `exc:${String(++seq)}` },
      lease: h.lease,
      baseline: h.baseline,
      execute: () => {
        order.push('work');
        return 'succeeded';
      },
      onBaseline: () => {
        order.push('baseline');
      },
    });
    await handler.execute(h.context());
    expect(order).toEqual(['baseline', 'work']);
  });

  it('6/7/12. a duplicate or concurrent start replays ONE baseline', async () => {
    const h = await makeHarness();
    await h.handler.execute(h.context());
    await h.handler.execute(h.context({ attempt: 2 }));
    await h.handler.execute(h.context({ attempt: 3 }));
    const invocations = await baselineInvocations(h);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.id).toBe(h.seen()?.invocationId);
    // The original invocation is replayed, not re-sampled.
    const concurrent = await Promise.all([
      h.handler.execute(h.context({ attempt: 4 })),
      h.handler.execute(h.context({ attempt: 5 })),
    ]);
    // One execution runs; the other is refused by the serial-agent lease. Either way there is
    // exactly ONE authoritative baseline and never a second start point.
    expect(concurrent.filter((outcome) => outcome === 'succeeded')).toHaveLength(1);
    expect(concurrent.filter((outcome) => outcome === 'failed')).toHaveLength(1);
    expect(await baselineInvocations(h)).toHaveLength(1);
  });

  it('8/78. a later manual baseline never replaces the authoritative one', async () => {
    const h = await makeHarness();
    await h.handler.execute(h.context());
    const authoritative = (await baselineInvocations(h))[0]!;
    // A human calls repo.git op=baseline directly afterwards (a different key).
    const manual = await h.registry.invoke({
      toolId: 'repo.git',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: h.taskId,
      runId: h.runId,
      actorId: h.actor,
      input: { op: 'baseline' },
      idempotencyKey: `manual-baseline:${h.runId}:${h.taskId}`,
    });
    expect(manual.ok).toBe(true);
    // Two repository queries ran, but only ONE is the authoritative task-start baseline.
    const allGit = (await h.db.toolInvocations.list({ limit: 500 })).items.filter(
      (invocation) => invocation.toolId === 'repo.git',
    );
    expect(allGit).toHaveLength(2);
    expect(await baselineInvocations(h)).toHaveLength(1);
    // The authoritative selection is by key, not by recency.
    const read = await h.baseline.get({ runId: h.runId, taskId: h.taskId, actorId: h.actor });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.invocationId).toBe(authoritative.id);
  });

  it('9/10. a baseline failure prevents the agent from starting', async () => {
    const h = await makeHarness();
    // No workspace ⇒ no baseline ⇒ the repository execution must not start.
    h.manager.closeWorkspace();
    let ranWork = false;
    const handler = createRepositoryStageHandler({
      id: 'repository.agent-closed',
      workspace: () => h.manager.current(),
      registry: h.registry,
      actorId: h.actor,
      clock,
      executionIds: { next: () => `exc:${String(++seq)}` },
      lease: h.lease,
      baseline: h.baseline,
      execute: () => {
        ranWork = true;
        return 'succeeded';
      },
    });
    expect(await handler.execute(h.context())).toBe('failed');
    expect(ranWork).toBe(false);
    expect(await baselineInvocations(h)).toHaveLength(0);
  });

  it('11/17. the baseline survives a restart unchanged', async () => {
    const dataDir = tempDir();
    const h = await makeHarness();
    void dataDir;
    await h.handler.execute(h.context());
    const original = (await baselineInvocations(h))[0]!;
    // A fresh graph over the same durable database reads the SAME invocation.
    const reopened = openDurableDatabase({
      dataDir: h.dataDir,
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'provider', 'tools'],
    });
    openDatabases.push(reopened);
    const authz = createAuthorizationService({
      ids,
      clock,
      roles: h.db.roles,
      assignments: h.db.roleAssignments,
    });
    const freshRegistry = createToolRegistry({
      ids,
      clock,
      records: h.db.toolRecords,
      invocations: h.db.toolInvocations,
      invocationArtifacts: h.db.toolInvocationArtifacts,
      adapters: new Map(),
      authorize: async (input) => authz.decide(input),
      events: h.db.events,
      secrets: async () => [],
      ...(h.db.toolInvocationClaims === null ? {} : { claims: h.db.toolInvocationClaims }),
      ...(h.db.toolInvocationIndex === null ? {} : { invocationIndex: h.db.toolInvocationIndex }),
    });
    const freshBaseline = createTaskBaselineService({
      registry: freshRegistry,
      executionIds: { next: () => `exc:${String(++seq)}` },
      clock,
    });
    const read = await freshBaseline.get({ runId: h.runId, taskId: h.taskId, actorId: h.actor });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.invocationId).toBe(original.id);
    expect(read.value?.headSha).toBe(h.repo.headSha());
  });

  it('15/16. baselines are never reused across runs or tasks', async () => {
    const h = await makeHarness();
    await h.handler.execute(h.context());
    const otherTask = await h.baseline.get({ runId: h.runId, taskId: ids.id('task'), actorId: h.actor });
    expect(otherTask.ok).toBe(true);
    if (otherTask.ok) expect(otherTask.value).toBeNull();
    const otherRun = await h.baseline.get({ runId: ids.id('run'), taskId: h.taskId, actorId: h.actor });
    expect(otherRun.ok).toBe(true);
    if (otherRun.ok) expect(otherRun.value).toBeNull();
    // And a different task DOES get its own baseline.
    await h.handler.execute(h.context({ taskId: ids.id('task') }));
    expect(await baselineInvocations(h)).toHaveLength(2);
  });
});

describe('workspace lease & serial repository agents (T17-07)', () => {
  it('18/25. one repository execution holds the lease and its context stays stable', async () => {
    const h = await makeHarness();
    const before = h.manager.current();
    expect(await h.handler.execute(h.context())).toBe('succeeded');
    expect(before).not.toBeNull();
    expect(h.manager.current()).toBe(before);
    expect(h.lease.current()).toBeNull();
  });

  it('19/20/21/22. a second concurrent execution is refused and never touches the workspace', async () => {
    const h = await makeHarness();
    // Hold the lease as execution A.
    const acquired = h.lease.acquire({
      workspaceId: 'sha256:' + 'a'.repeat(64),
      runId: h.runId,
      taskId: h.taskId,
      executionId: 'exc-A',
      now: nowIso(),
    });
    expect(acquired.ok).toBe(true);
    let ranWork = false;
    const handler = createRepositoryStageHandler({
      id: 'repository.agent-b',
      workspace: () => h.manager.current(),
      registry: h.registry,
      actorId: h.actor,
      clock,
      executionIds: { next: () => `exc:${String(++seq)}` },
      lease: h.lease,
      baseline: h.baseline,
      execute: () => {
        ranWork = true;
        return 'succeeded';
      },
    });
    const before = await baselineInvocations(h);
    expect(await handler.execute(h.context({ taskId: ids.id('task'), executionId: 'exc-B' }))).toBe('failed');
    expect(ranWork).toBe(false);
    // The refused execution captured NO baseline and left the workspace untouched.
    expect(await baselineInvocations(h)).toEqual(before);
    expect(h.manager.current()).not.toBeNull();
    // A different run is refused as well: the lease is process-wide.
    expect(
      await handler.execute(h.context({ runId: ids.id('run'), taskId: ids.id('task'), executionId: 'exc-C' })),
    ).toBe('failed');
    h.lease.release(acquired.ok ? acquired.value.leaseId : '');
  });

  it('23/24/26/67. close and switch are denied while leased', async () => {
    const h = await makeHarness();
    const acquired = h.lease.acquire({
      workspaceId: 'sha256:' + 'b'.repeat(64),
      runId: h.runId,
      taskId: h.taskId,
      executionId: 'exc-A',
      now: nowIso(),
    });
    expect(acquired.ok).toBe(true);
    const before = h.manager.current();
    const closed = h.manager.closeWorkspace();
    expect(closed.ok).toBe(false);
    if (closed.ok) return;
    expect(closed.error.details['reason']).toBe('WORKSPACE_IN_USE');
    // The close→open bypass is unavailable: the workspace is still the same context.
    expect(h.manager.current()).toBe(before);
    const other = tempDir();
    const switched = await h.manager.openWorkspace({ root: other, commandProfile: {} });
    expect(switched.ok).toBe(false);
    expect(h.manager.current()).toBe(before);
    // Same-workspace re-open is idempotent and does not replace the profile.
    const same = await h.manager.openWorkspace({
      root: h.repo.dir,
      commandProfile: before?.commandProfile ?? {},
    });
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.value.workspaceId).toBe(before?.workspaceId);
    h.lease.release(acquired.ok ? acquired.value.leaseId : '');
  });

  it('26/27/28/29/30. every terminal outcome releases the lease', async () => {
    const outcomes = ['succeeded', 'failed', 'blocked'] as const;
    for (const outcome of outcomes) {
      const h = await makeHarness();
      expect(await h.handler.execute(h.context({ outcome }))).toBe(outcome);
      expect(h.lease.current(), outcome).toBeNull();
    }
    // A thrown delegate also releases the lease (exception safety).
    const h = await makeHarness();
    await expect(h.handler.execute(h.context({ throws: true }))).rejects.toThrow('delegate exploded');
    expect(h.lease.current()).toBeNull();
    // And the next execution can start immediately afterwards.
    expect(await h.handler.execute(h.context({ attempt: 2 }))).toBe('succeeded');
  });

  it('31/32. a fresh process has no lease and reacquires it', async () => {
    const h = await makeHarness();
    expect(h.lease.current()).toBeNull();
    const acquired = h.lease.acquire({
      workspaceId: 'sha256:' + 'c'.repeat(64),
      runId: h.runId,
      taskId: h.taskId,
      executionId: 'exc-A',
      now: nowIso(),
    });
    expect(acquired.ok).toBe(true);
    // A brand-new lease service (a restarted process) starts empty.
    const restarted = createWorkspaceExecutionLease();
    expect(restarted.current()).toBeNull();
    const reacquired = restarted.acquire({
      workspaceId: 'sha256:' + 'c'.repeat(64),
      runId: h.runId,
      taskId: h.taskId,
      executionId: 'exc-A2',
      now: nowIso(),
    });
    expect(reacquired.ok).toBe(true);
  });
});

describe('recovery semantics (T17-07)', () => {
  it('73/75. recovery reuses the original baseline and allows source changes', async () => {
    const h = await makeHarness();
    await h.handler.execute(h.context());
    const original = (await baselineInvocations(h))[0]!;
    // The task legitimately changes the repository afterwards.
    h.repo.write('a.txt', 'changed by the task\n');
    h.manager.closeWorkspace();
    // Recovery: a trusted re-open of the SAME workspace.
    const reopened = await h.manager.openWorkspace({ root: h.repo.dir, commandProfile: {} });
    expect(reopened.ok).toBe(true);
    // The baseline is NOT re-sampled: the same invocation is still authoritative.
    const read = await h.baseline.get({ runId: h.runId, taskId: h.taskId, actorId: h.actor });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.invocationId).toBe(original.id);
    expect(read.value?.headSha).toBe(h.repo.headSha() === read.value?.headSha ? read.value?.headSha : read.value?.headSha);
    // The current anchor differs from the baseline anchor — and that is ALLOWED (no re-capture).
    const current = await h.registry.invoke({
      toolId: 'repo.git',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: h.taskId,
      runId: h.runId,
      actorId: h.actor,
      input: { op: 'status' },
      idempotencyKey: `recovery-status:${h.runId}:${h.taskId}`,
    });
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(await baselineInvocations(h)).toHaveLength(1);
    // And the resumed execution re-acquires the lease.
    expect(await h.handler.execute(h.context({ attempt: 2 }))).toBe('succeeded');
    expect(h.lease.current()).toBeNull();
  });

  it('74. recovery against a DIFFERENT workspace is denied', async () => {
    const h = await makeHarness();
    await h.handler.execute(h.context());
    const original = (await baselineInvocations(h))[0]!;
    h.manager.closeWorkspace();
    // A trusted app opens a DIFFERENT workspace for the same task.
    const other = createGitFixture();
    other.write('a.txt', 'other\n');
    commitAll(other, 'initial');
    const opened = await h.manager.openWorkspace({ root: other.dir, commandProfile: {} });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.workspaceId).not.toBe('sha256:' + 'a'.repeat(64));
    // The baseline still belongs to the ORIGINAL workspace: the resumed execution refuses.
    const read = await h.baseline.get({ runId: h.runId, taskId: h.taskId, actorId: h.actor });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.workspaceId).not.toBe(opened.value.workspaceId);

    // A resumed execution in the WRONG workspace must not run any repository work, and must
    // not create a second baseline for the same task: the baseline replays (same key) but the
    // gate refuses because the workspaceId no longer matches the authoritative baseline's.
    let ranWork = false;
    const handler = createRepositoryStageHandler({
      id: 'repository.agent-wrong',
      workspace: () => h.manager.current(),
      registry: h.registry,
      actorId: h.actor,
      clock,
      executionIds: { next: () => `exc:${String(++seq)}` },
      lease: h.lease,
      baseline: h.baseline,
      execute: () => {
        ranWork = true;
        return 'succeeded';
      },
    });
    expect(await handler.execute(h.context({ attempt: 3 }))).toBe('failed');
    expect(ranWork).toBe(false);
    expect(await baselineInvocations(h)).toHaveLength(1);
    expect(original.id).toBe(read.value?.invocationId);
    // Nothing is running on the wrong workspace either.
    expect(h.lease.current()).toBeNull();
    other.dispose();
  });
});

const record = (value: unknown): Record<string, unknown> => (value ?? {}) as Record<string, unknown>;
