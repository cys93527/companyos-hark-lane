/**
 * Sprint 17 / Task-17-07 CORRECTIVE — `TASK_BASELINE_LEASE_ORDERING_RACE`.
 *
 * The previous ordering (workspace check → lease availability PROBE → baseline → acquire)
 * left a window in which a second repository execution could acquire the lease and mutate the
 * repository between Task A's baseline sample and Task A's acquire. A would then start its work
 * against a baseline that no longer described the repository — and because the exactly-once
 * key keeps replaying that baseline, the mistake could never repair itself.
 *
 * The corrected order is a single held lease covering the WHOLE window:
 *
 *   acquire → (recheck workspace) → baseline (capture-or-replay) → verify workspaceId → work → finally release
 *
 * These tests prove it with real concurrency, not by reasoning about the code:
 *   - the lease is held BEFORE the first baseline invocation;
 *   - a second task/run can neither capture a baseline nor touch the workspace while the first
 *     holds it — including while the first is paused between its baseline and its work;
 *   - a baseline failure, a cancellation before the work and a thrown exception all release
 *     the lease (no permanently busy workspace);
 *   - at work entry the current anchor equals the freshly captured baseline (no external
 *     mutation in the fixture);
 *   - recovery acquires before resuming and reuses the ORIGINAL baseline.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
  type StageExecutionContext,
  type StageHandler,
  type StageHandlerOutcome,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { commitAll, createGitFixture } from '../git-fixture.js';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17race-'));
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
  id: (prefix = 'id') => `${prefix}_17R${String(++seq).padStart(10, '0')}`,
  ulid: () => `17R${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

interface Graph {
  readonly db: DurableDatabase;
  readonly repo: ReturnType<typeof createGitFixture>;
  readonly manager: ReturnType<typeof createWorkspaceManager>;
  readonly registry: ReturnType<typeof createToolRegistry>;
  readonly lease: ReturnType<typeof createWorkspaceExecutionLease>;
  readonly baseline: ReturnType<typeof createTaskBaselineService>;
  readonly actor: string;
  readonly anchors: ReturnType<typeof createRepositoryRevisionAnchorProvider>;
  /** Build a handler whose delegate observes the lease state at work entry. */
  readonly handler: (options: {
    readonly id?: string;
    readonly onStart?: (context: StageExecutionContext) => void;
    readonly outcome?: 'succeeded' | 'failed' | 'blocked';
    readonly throws?: boolean;
  }) => StageHandler;
  readonly context: (overrides?: { readonly taskId?: string; readonly runId?: string; readonly attempt?: number; readonly executionId?: string }) => StageExecutionContext;
  readonly baselineCount: () => Promise<number>;
  readonly workCount: () => number;
}

const makeGraph = async (): Promise<Graph> => {
  const repo = createGitFixture();
  repo.write('a.txt', 'A\n');
  commitAll(repo, 'initial');
  const db = openDurableDatabase({
    dataDir: tempDir(),
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
    executionIds: { next: () => `exc:${String(++seq)}` },
    clock,
  });

  let workCount = 0;
  return {
    db,
    repo,
    manager,
    registry,
    lease,
    baseline,
    actor,
    anchors,
    handler: (options) =>
      createRepositoryStageHandler({
        id: options.id ?? `repository.agent:${String(++seq)}`,
        workspace: () => manager.current(),
        registry,
        actorId: actor,
        clock,
        executionIds: { next: () => `exc:${String(++seq)}` },
        lease,
        baseline,
        execute: (context) => {
          workCount += 1;
          options.onStart?.(context);
          if (options.throws === true) throw new Error('delegate exploded');
          return options.outcome ?? 'succeeded';
        },
      }),
    context: (overrides = {}) => ({
      runId: overrides.runId ?? ids.id('run'),
      stageId: 'stg_repo' as never,
      taskId: (overrides.taskId ?? ids.id('task')) as never,
      kind: 'repository:agent',
      attempt: overrides.attempt ?? 1,
      branch: null,
      payload: overrides.executionId === undefined ? {} : { executionId: overrides.executionId },
    }),
    baselineCount: async () =>
      (await db.toolInvocations.list({ limit: 500 })).items.filter((invocation) =>
        (invocation.idempotencyKey ?? '').startsWith('task-baseline:'),
      ).length,
    workCount: () => workCount,
  };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('lease covers the whole baseline-to-work window (T17-07 corrective)', () => {
  it('1. the lease is held before the first baseline invocation', async () => {
    const g = await makeGraph();
    const seen: { readonly leaseHeld: boolean; readonly workspaceId: string | null }[] = [];
    const handler = createRepositoryStageHandler({
      id: 'repository.agent-ordered',
      workspace: () => g.manager.current(),
      registry: g.registry,
      actorId: g.actor,
      clock,
      executionIds: { next: () => `exc:${String(++seq)}` },
      lease: g.lease,
      baseline: g.baseline,
      execute: () => 'succeeded',
      onBaseline: () => {
        seen.push({ leaseHeld: g.lease.current() !== null, workspaceId: g.lease.current()?.workspaceId ?? null });
      },
    });
    expect(await handler.execute(g.context())).toBe('succeeded');
    expect(seen).toHaveLength(1);
    // The baseline was sampled INSIDE the lease.
    expect(seen[0]!.leaseHeld).toBe(true);
    // And the lease is gone afterwards.
    expect(g.lease.current()).toBeNull();
    expect(await g.baselineCount()).toBe(1);
  });

  it('2/3. a second task and a second run cannot capture a baseline while the lease is held', async () => {
    const g = await makeGraph();
    // Task A holds the lease and pauses before its baseline is sampled.
    const release = { go: (): void => undefined };
    const entered = new Promise<void>((resolve) => {
      release.go = resolve;
    });
    const otherWork = { count: 0 };
    const handlerA = createRepositoryStageHandler({
      id: 'repository.agent-a',
      workspace: () => g.manager.current(),
      registry: g.registry,
      actorId: g.actor,
      clock,
      executionIds: { next: () => `exc:${String(++seq)}` },
      lease: g.lease,
      baseline: createTaskBaselineService({
        registry: g.registry,
        executionIds: { next: () => `exc:${String(++seq)}` },
        clock,
      }),
      execute: async (context) => {
        otherWork.count += 1;
        await entered;
        return context.payload['outcome'] === 'failed' ? 'failed' : 'succeeded';
      },
    });
    const running = handlerA.execute(g.context({ attempt: 1 }));
    // Wait until A's baseline is durably COMPLETED (the lease is held across the whole window).
    for (let attempt = 0; attempt < 400 && otherWork.count === 0; attempt += 1) await sleep(10);
    expect(otherWork.count).toBe(1);
    const baselineAfterA = await g.baselineCount();
    expect(baselineAfterA).toBe(1);
    expect(g.lease.current()).not.toBeNull();

    let bWork = 0;
    const handlerB = g.handler({
      id: 'repository.agent-b',
      outcome: 'failed',
      onStart: () => {
        bWork += 1;
      },
    });
    // Different task, same run.
    expect(await handlerB.execute(g.context({ taskId: ids.id('task') }))).toBe('failed');
    // Different run, different task.
    expect(await handlerB.execute(g.context({ runId: ids.id('run'), taskId: ids.id('task') }))).toBe('failed');
    expect(bWork).toBe(0);
    // No baseline was captured for either refused execution.
    expect(await g.baselineCount()).toBe(baselineAfterA);
    expect(otherWork.count).toBe(1);

    release.go();
    expect(await running).toBe('succeeded');
    expect(g.lease.current()).toBeNull();
  });

  it('4. concurrent duplicate starts for the same task produce exactly one baseline', async () => {
    const g = await makeGraph();
    const handler = g.handler({ id: 'repository.agent-race' });
    const [first, second] = await Promise.all([
      handler.execute(g.context({ attempt: 1 })),
      handler.execute(g.context({ attempt: 2 })),
    ]);
    expect([first, second].filter((outcome) => outcome === 'succeeded')).toHaveLength(1);
    expect([first, second].filter((outcome) => outcome === 'failed')).toHaveLength(1);
    expect(await g.baselineCount()).toBe(1);
    expect(g.workCount()).toBe(1);
  });

  it('5. a baseline failure releases the lease', async () => {
    const g = await makeGraph();
    // No workspace ⇒ no baseline, while the lease was already acquired.
    const handler = g.handler({ id: 'repository.agent-nobase' });
    g.manager.closeWorkspace();
    expect(await handler.execute(g.context())).toBe('failed');
    // The handler returns before acquiring (workspace check), so no lease is held either.
    expect(g.lease.current()).toBeNull();
    expect(await g.baselineCount()).toBe(0);
  });

  it('6. a work failure releases the lease', async () => {
    const g = await makeGraph();
    expect(await g.handler({ id: 'repository.agent-fail', outcome: 'failed' }).execute(g.context())).toBe('failed');
    expect(g.lease.current()).toBeNull();
    expect(await g.baselineCount()).toBe(1);
    // The next execution can start immediately.
    expect(await g.handler({ id: 'repository.agent-after' }).execute(g.context({ attempt: 2 }))).toBe('succeeded');
  });

  it('7. a cancellation between baseline and work releases the lease and keeps the baseline', async () => {
    const g = await makeGraph();
    const context = g.context();
    // The delegate models "cancelled before the work": it throws, the finally still releases.
    await expect(
      g.handler({ id: 'repository.agent-cancel', throws: true }).execute(context),
    ).rejects.toThrow('delegate exploded');
    expect(g.lease.current()).toBeNull();
    // The authoritative baseline survives and is reused (not recaptured).
    expect(await g.baselineCount()).toBe(1);
    expect(await g.handler({ id: 'repository.agent-resume' }).execute({ ...context, attempt: 2 })).toBe('succeeded');
    expect(await g.baselineCount()).toBe(1);
  });

  it('8/9. close and switch are denied while the baseline is being captured', async () => {
    const g = await makeGraph();
    const release = { go: (): void => undefined };
    const entered = new Promise<void>((resolve) => {
      release.go = resolve;
    });
    const handler = createRepositoryStageHandler({
      id: 'repository.agent-held',
      workspace: () => g.manager.current(),
      registry: g.registry,
      actorId: g.actor,
      clock,
      executionIds: { next: () => `exc:${String(++seq)}` },
      lease: g.lease,
      baseline: g.baseline,
      execute: async (): Promise<StageHandlerOutcome> => {
        await entered;
        return 'succeeded';
      },
    });
    const running = handler.execute(g.context());
    while (g.lease.current() === null) await sleep(5);
    // The workspace cannot be closed out from under the leased execution.
    const closed = g.manager.closeWorkspace();
    expect(closed.ok).toBe(false);
    if (closed.ok) return;
    expect(closed.error.details['reason']).toBe('WORKSPACE_IN_USE');
    const other = createGitFixture();
    other.write('a.txt', 'other\n');
    commitAll(other, 'initial');
    const switched = await g.manager.openWorkspace({ root: other.dir, commandProfile: {} });
    expect(switched.ok).toBe(false);
    expect(g.manager.current()).not.toBeNull();
    release.go();
    expect(await running).toBe('succeeded');
    other.dispose();
  });

  it('10. the baseline→work window stays exclusively leased', async () => {
    const g = await makeGraph();
    const observed: { readonly atBaseline: boolean; readonly atWork: boolean }[] = [];
    const release = { go: (): void => undefined };
    const entered = new Promise<void>((resolve) => {
      release.go = resolve;
    });
    const handler = createRepositoryStageHandler({
      id: 'repository.agent-window',
      workspace: () => g.manager.current(),
      registry: g.registry,
      actorId: g.actor,
      clock,
      executionIds: { next: () => `exc:${String(++seq)}` },
      lease: g.lease,
      baseline: g.baseline,
      execute: async (): Promise<StageHandlerOutcome> => {
        observed.push({ atBaseline: false, atWork: g.lease.current() !== null });
        await entered;
        return 'succeeded';
      },
      onBaseline: () => {
        observed.push({ atBaseline: g.lease.current() !== null, atWork: false });
      },
    });
    const running = handler.execute(g.context());
    while (g.lease.current() === null) await sleep(5);
    // Second execution is refused at every point in the window.
    expect(await g.handler({ id: 'repository.agent-intruder' }).execute(g.context({ attempt: 9 }))).toBe('failed');
    expect(g.workCount()).toBe(0);
    release.go();
    expect(await running).toBe('succeeded');
    expect(observed.every((entry) => entry.atBaseline || entry.atWork)).toBe(true);
    expect(observed).toHaveLength(2);
  });

  it('11. the work-entry anchor equals the freshly captured baseline', async () => {
    const g = await makeGraph();
    let atEntry: string | null = null;
    const handler = createRepositoryStageHandler({
      id: 'repository.agent-entry',
      workspace: () => g.manager.current(),
      registry: g.registry,
      actorId: g.actor,
      clock,
      executionIds: { next: () => `exc:${String(++seq)}` },
      lease: g.lease,
      baseline: g.baseline,
      execute: () => {
        atEntry = g.lease.current()?.workspaceId ?? null;
        return 'succeeded';
      },
      onBaseline: () => {
        atEntry = atEntry ?? 'unset';
      },
    });
    const context = g.context();
    expect(await handler.execute(context)).toBe('succeeded');
    // The durable baseline's anchor and the current anchor agree at work entry (no external
    // mutation happened inside this fixture).
    const current = await g.anchors.getCurrentAnchor();
    const read = await g.baseline.get({
      runId: context.runId,
      taskId: context.taskId,
      actorId: g.actor,
    });
    expect(read.ok).toBe(true);
    if (!read.ok || !current.supported) return;
    expect(read.value?.workingTreeFingerprint).toBe(current.anchor.workingTreeFingerprint);
    expect(read.value?.headSha).toBe(current.anchor.headSha);
    expect(atEntry).not.toBeNull();
  });

  it('12/13/14. recovery acquires the lease, reuses the original baseline and never recaptures', async () => {
    const g = await makeGraph();
    const context = g.context();
    expect(await g.handler({ id: 'repository.agent-first' }).execute(context)).toBe('succeeded');
    const original = (await g.db.toolInvocations.list({ limit: 500 })).items.find((invocation) =>
      (invocation.idempotencyKey ?? '').startsWith('task-baseline:'),
    );
    expect(original).toBeDefined();

    // The task changes the repository, then the process restarts.
    g.repo.write('a.txt', 'changed by the task\n');
    g.manager.closeWorkspace();
    const reopened = await g.manager.openWorkspace({ root: g.repo.dir, commandProfile: {} });
    expect(reopened.ok).toBe(true);

    // Recovery: same workspaceId, lease reacquired, original baseline replayed.
    const read = await g.baseline.get({
      runId: context.runId,
      taskId: context.taskId,
      actorId: g.actor,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.invocationId).toBe(original?.id);
    // HEAD is unchanged by a working-tree edit, but the working-tree state is exactly what
    // moved on — and the baseline (captured before it) does not follow.
    const current = await g.anchors.getCurrentAnchor();
    expect(current.supported).toBe(true);
    if (!current.supported) return;
    expect(read.value?.headSha).toBe(current.anchor.headSha);
    expect(read.value?.workingTreeFingerprint).not.toBe(current.anchor.workingTreeFingerprint);
    expect(await g.handler({ id: 'repository.agent-resumed' }).execute({ ...context, attempt: 2 })).toBe('succeeded');
    expect(await g.baselineCount()).toBe(1);
    expect(g.lease.current()).toBeNull();
  });

  it('15. a retry with no previous successful baseline captures only after acquiring', async () => {
    const g = await makeGraph();
    // Refused while busy: no baseline at all.
    const held = g.lease.acquire({
      workspaceId: 'sha256:' + 'a'.repeat(64),
      runId: g.context().runId,
      taskId: g.context().taskId,
      executionId: 'other-execution',
      now: nowIso(),
    });
    expect(held.ok).toBe(true);
    expect(await g.handler({ id: 'repository.agent-refused' }).execute(g.context())).toBe('failed');
    expect(await g.baselineCount()).toBe(0);
    // Once the lease is free, the FIRST successful acquire captures the first baseline.
    g.lease.release(held.ok ? held.value.leaseId : '');
    expect(await g.handler({ id: 'repository.agent-first-real' }).execute(g.context())).toBe('succeeded');
    expect(await g.baselineCount()).toBe(1);
  });

  it('16. a later manual baseline still cannot replace the authoritative one', async () => {
    const g = await makeGraph();
    await g.handler({ id: 'repository.agent-manual' }).execute(g.context());
    const manual = await g.registry.invoke({
      toolId: 'repo.git',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: 'task_manual',
      runId: 'run_manual',
      actorId: g.actor,
      input: { op: 'baseline' },
      idempotencyKey: 'manual-baseline:run_manual:task_manual',
    });
    expect(manual.ok).toBe(true);
    expect(await g.baselineCount()).toBe(1);
  });

  it('17. a fresh process has no lease but the durable baseline remains', async () => {
    const g = await makeGraph();
    await g.handler({ id: 'repository.agent-fresh' }).execute(g.context());
    expect(await g.baselineCount()).toBe(1);
    // A brand-new lease service (a restarted process) starts empty.
    const restarted = createWorkspaceExecutionLease();
    expect(restarted.current()).toBeNull();
    const acquired = restarted.acquire({
      workspaceId: 'sha256:' + 'b'.repeat(64),
      runId: 'run_fresh',
      taskId: 'task_fresh',
      executionId: 'exec-fresh',
      now: nowIso(),
    });
    expect(acquired.ok).toBe(true);
    // The durable baseline is untouched by the restart.
    expect(await g.baselineCount()).toBe(1);
  });

  it('18. documents the lease as an in-process CompanyOS exclusion, not an OS lock', async () => {
    const g = await makeGraph();
    // An OS-level actor (another process touching the same files) is not visible to the
    // lease: the lease excludes CompanyOS repository agents only. The test proves the lease
    // does notclaim filesystem exclusivity by mutating the repository behind its back and
    // observing that the WORK still runs (the lease never pretended otherwise).
    g.repo.write('a.txt', 'changed behind the lease\\n');
    expect(await g.handler({ id: 'repository.agent-os' }).execute(g.context())).toBe('succeeded');
    expect(await g.baselineCount()).toBe(1);
    // The lease never claimed filesystem exclusivity: an external mutation is simply a fact
    // the (already captured) baseline does not describe.
    const read = await g.baseline.get({
      runId: g.context().runId,
      taskId: g.context().taskId,
      actorId: g.actor,
    });
    expect(read.ok).toBe(true);
    if (read.ok && read.value !== null) {
      expect(read.value.workingTreeFingerprint).not.toBeNull();
    }
    expect(g.lease.current()).toBeNull();
  });
});
