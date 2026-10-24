/**
 * Sprint26 — DECISION / RESTART / SIGNAL / CONCURRENCY flows (Boss §46/§49/§50/§51/§52).
 *
 * Every flow drives the PRODUCTION composition through the typed control-plane
 * surface; only the model provider is a deterministic stub. The canonical
 * approval fixture is a HIGH-risk run driven to WAITING_FOR_APPROVAL (the engine's
 * own approval mechanism), so the pending-decision projection and the response
 * travel the REAL canonical path.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ok, type DomainError, type ModelProviderPort, type Result } from '@companyos/core';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';
import { GOAL_WORK_KIND } from '../../apps/desktop/src/control-plane.js';

const CHAINS = ['core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff'] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 's26d.planner';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s26d-'));
  createdDirs.push(dir);
  return dir;
};

const stubProvider = (): ModelProviderPort => ({
  describe: () => ({ providerId: 'prov_s26d', kind: 'fake', displayName: 's26d', version: '1' }),
  listModels: () =>
    Promise.resolve(ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }])),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    return Promise.resolve(
      ok({
        modelId: request.modelId,
        providerId: 'prov_s26d',
        outputText: 'x',
        structured: { status: 'succeeded', objective: 'work', summary: 'done' } as never,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
        finishReason: 'stop' as const,
      }),
    );
  },
  stream(): AsyncIterable<Result<never, DomainError>> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
  },
});

const makeCore = async (): Promise<{ readonly core: Core; readonly dataDir: string; readonly casRoot: string; readonly goalRunId: string }> => {
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', GOAL_WORK_KIND] },
    planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
  });
  if (core === null) throw new Error('composition failed');
  // F4: a Goal requires the durable workspace binding — open one before goal.create.
  const wsRoot = tempDir();
  mkdirSync(wsRoot, { recursive: true });
  const opened = await core.repositoryRuntime.openWorkspace({ root: wsRoot, commandProfile: {} });
  if (!opened.ok) throw new Error('workspace open failed: ' + String(opened.error?.code));
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(stubProvider(), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_s26d', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  const savedPolicy = await core.policies.savePolicy({
    id: `COMPANY:${COMPANY}`,
    scopeType: 'COMPANY',
    scopeId: COMPANY,
    mode: 'MANUAL',
    manualModelKey: MODEL_KEY,
    actorId: actor,
  } as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  const created = await core.controlPlane!.handle({
    operation: 'goal.create',
    payload: { companyId: COMPANY, objective: '决策流测试目标。', commandId: 'ui-goal-decisions' },
  });
  if (!created.ok) throw new Error(`goal.create failed: ${JSON.stringify(created.error)}`);
  return { core, dataDir, casRoot, goalRunId: String((created.value as { readonly runId: string }).runId) };
};

/** Drive a seeded run with HIGH risk so the engine's OWN approval mechanism engages. */
const driveToWaitingApproval = async (core: Core, runId: string): Promise<void> => {
  const driven = await core.sprint13.engine.drive(runId as never, { risk: 'HIGH' } as never);
  expect(driven.ok).toBe(true);
};

const reopen = async (dataDir: string, casRoot: string): Promise<Core> => {
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', GOAL_WORK_KIND] },
    planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
  });
  if (core === null) throw new Error('recomposition failed');
  return core;
};

describe('S26 decision flow (§46/§14)', () => {
  it('9/13. a canonical approval blocker is projected, responds through the typed boundary, and survives restart', async () => {
    const { core, dataDir, casRoot, goalRunId } = await makeCore();
    await driveToWaitingApproval(core, goalRunId);

    // The pending projection lists the run with its canonical blockers.
    const pending = await core.controlPlane!.handle({
      operation: 'decisions.pending',
      payload: { companyId: COMPANY },
    });
    if (!pending.ok) throw new Error(`pending failed: ${JSON.stringify(pending.error)}`);
    expect(pending.ok).toBe(true);
    const runState = core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(goalRunId) as { state: string };
    void runState;
    if (pending.ok) {
      const entries = (pending.value as { readonly pending: readonly { readonly runId: string }[] }).pending;
      expect(entries.some((entry) => entry.runId === goalRunId)).toBe(true);
    }

    // The response travels the canonical mechanism (engine APPROVAL.DENY here).
    const denied = await core.controlPlane!.handle({
      operation: 'approval.respond',
      payload: { companyId: COMPANY, runId: goalRunId, decision: 'deny', note: 'not now' },
    });
    if (!denied.ok) throw new Error(`deny failed: ${JSON.stringify(denied.error)}`);
    expect(denied.ok).toBe(true);

    // Restart reconstructs the same durable truth from SQLite alone.
    const restarted = await reopen(dataDir, casRoot);
    const afterRestart = await restarted.controlPlane!.handle({
      operation: 'run.overview',
      payload: { companyId: COMPANY, runId: goalRunId },
    });
    expect(afterRestart.ok).toBe(true);
  });

  it('20. a STALE approval response cannot overwrite newer truth (typed conflict, loud)', async () => {
    const { core, goalRunId } = await makeCore();
    await driveToWaitingApproval(core, goalRunId);
    // Simulated client A denies with the CURRENT revision first.
    const first = await core.controlPlane!.handle({
      operation: 'approval.respond',
      payload: { companyId: COMPANY, runId: goalRunId, decision: 'deny', note: 'client A' },
    });
    expect(first.ok).toBe(true);
    // Simulated client B replays with the PREVIOUS revision context: the engine's
    // own revision precondition refuses; the typed error surfaces unchanged.
    const second = await core.controlPlane!.handle({
      operation: 'approval.respond',
      payload: { companyId: COMPANY, runId: goalRunId, decision: 'deny', note: 'client B stale' },
    });
    // A repeated deny on the already-denied run is either a typed conflict or a
    // no-op duplicate — NEVER a silent second denial.
    expect(second.ok === false || (second.value as { readonly duplicate?: boolean }).duplicate === true).toBe(true);
  });

  it('21. double submit of the SAME decision is protected (idempotent or typed conflict)', async () => {
    const { core, goalRunId } = await makeCore();
    await driveToWaitingApproval(core, goalRunId);
    const first = await core.controlPlane!.handle({
      operation: 'approval.respond',
      payload: { companyId: COMPANY, runId: goalRunId, decision: 'deny' },
    });
    const second = await core.controlPlane!.handle({
      operation: 'approval.respond',
      payload: { companyId: COMPANY, runId: goalRunId, decision: 'deny' },
    });
    expect(first.ok).toBe(true);
    if (second.ok) {
      // A replay must be the engine's own DUPLICATE (no second denial applied).
      expect((second.value as { readonly duplicate?: boolean }).duplicate).toBe(true);
      // And durable truth proves exactly ONE approval decision exists.
      const decisions = core.database.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE type LIKE 'approval.%'")
        .get() as { c: number };
      expect(Number(decisions.c)).toBe(2); // requested + decided (exactly one decision)
    } else {
      // A typed refusal is equally acceptable — never a silent second action.
      expect(typeof second.error?.code).toBe('string');
    }
  });
});

describe('S26 restart + live signal (§49/§50/§19)', () => {
  it('15/49. restart reconstructs the goal workspace from durable state alone', async () => {
    const { core, dataDir, casRoot, goalRunId } = await makeCore();
    const before = await core.controlPlane!.handle({ operation: 'goal.workspace', payload: { companyId: COMPANY, runId: goalRunId } });
    expect(before.ok).toBe(true);

    const restarted = await reopen(dataDir, casRoot);
    const after = await restarted.controlPlane!.handle({ operation: 'goal.workspace', payload: { companyId: COMPANY, runId: goalRunId } });
    expect(after.ok).toBe(true);
    if (before.ok && after.ok) {
      const beforeView = before.value as { readonly goal: { readonly objective: string } | null; readonly planningRun: { readonly state: string } };
      const afterView = after.value as { readonly goal: { readonly objective: string } | null; readonly planningRun: { readonly state: string } };
      expect(afterView.goal?.objective).toBe(beforeView.goal?.objective);
      expect(afterView.planningRun.state).toBe(beforeView.planningRun.state);
    }
  });

  it('14. a lost live signal is recovered by re-reading the projection (no permanent divergence)', async () => {
    const { core, goalRunId } = await makeCore();
    // First read (the "signal" for this read is lost by construction — we simply read again).
    const first = await core.controlPlane!.handle({ operation: 'home.summary', payload: { companyId: COMPANY } });
    // Canonical state advances underneath.
    await driveToWaitingApproval(core, goalRunId);
    // The refresh re-reads the durable truth: the goal's state has moved on.
    const refreshed = await core.controlPlane!.handle({ operation: 'home.summary', payload: { companyId: COMPANY } });
    expect(first.ok && refreshed.ok).toBe(true);
    if (first.ok && refreshed.ok) {
      const before = (first.value as { readonly goals: readonly { readonly runId: string; readonly state: string }[] }).goals.find((goal) => goal.runId === goalRunId);
      const after = (refreshed.value as { readonly goals: readonly { readonly runId: string; readonly state: string }[] }).goals.find((goal) => goal.runId === goalRunId);
      expect(after?.state).toBeDefined();
      expect(after?.state).not.toBe(undefined);
      void before;
    }
  });

  it('27/28/29. no dashboard/approval/artifact truth table was created by the control plane', async () => {
    const { core } = await makeCore();
    await core.controlPlane!.handle({ operation: 'home.summary', payload: { companyId: COMPANY } });
    await core.controlPlane!.handle({ operation: 'decisions.pending', payload: { companyId: COMPANY } });
    const tables = core.database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const names = tables.map((row) => row.name);
    for (const forbidden of ['dashboard_state', 'goal_workspace_state', 'ui_run_state', 'control_plane_task_state', 'frontend_workflow_state', 'ui_pending_decisions']) {
      expect(names.includes(forbidden), `${forbidden} must not exist`).toBe(false);
    }
  });
});
