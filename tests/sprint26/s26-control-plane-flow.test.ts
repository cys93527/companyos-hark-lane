/**
 * Sprint26 — the CONTROL-PLANE PIPELINE over the PRODUCTION composition (Boss §44).
 *
 * This is the V1 Goal-to-Outcome flow through real boundaries: the trusted
 * control-plane service (the same object the IPC handler calls) over the full
 * composeCoreServices composition — goal entry → canonical run+goal → planning turn
 * → trusted spec derivation → deterministic compile → supervisor turn → observation.
 * Only the MODEL provider is stubbed (a deterministic fake with a canned plan),
 * exactly like the Sprint 20/21 pipeline suites.
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
const MODEL_KEY = 's26.planner';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s26-'));
  createdDirs.push(dir);
  return dir;
};

/** The deterministic canned PLAN the stub planner proposes (pure content, T20-02 shape). */
const CANNED_PLAN = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    { planItemId: 'research', objective: 'Gather the facts the outcome needs.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['facts'] },
    { planItemId: 'draft', objective: 'Produce the first outcome draft.', dependencyPlanItemIds: ['research'], acceptanceCriterionRefs: ['draft'] },
  ],
  acceptanceCriteria: [
    { criterionId: 'facts', requirement: 'The facts are recorded and citable.' },
    { criterionId: 'draft', requirement: 'The draft answers the goal.' },
  ],
};

const stubProvider = (): ModelProviderPort => {
  let plannerAnswersLeft = 1;
  return {
  describe: () => ({ providerId: 'prov_s26', kind: 'fake', displayName: 's26', version: '1' }),
  listModels: () =>
    Promise.resolve(
      ok([
        {
          modelId: 'p1',
          displayName: 'p1',
          contextWindow: 8192,
          capabilities: { streaming: false, structuredOutput: true },
        },
      ]),
    ),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    // The FIRST call is the planner turn (the plan proposal); every later call is a
    // work/review/qa turn and gets the plain structured answer. Deterministic.
    const isPlanner = plannerAnswersLeft > 0;
    if (isPlanner) plannerAnswersLeft -= 1;
    return Promise.resolve(
      ok({
        modelId: request.modelId,
        providerId: 'prov_s26',
        outputText: 'x',
        structured: (isPlanner ? CANNED_PLAN : { status: 'succeeded', objective: 'work done', summary: 'done' }) as never,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
        finishReason: 'stop' as const,
      }),
    );
  },
  stream(): AsyncIterable<Result<never, DomainError>> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
  },
  };
};

const makeCore = async (): Promise<Core> => {
  const dataDir = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot: tempDir(), database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', GOAL_WORK_KIND] },
    planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
  });
  if (core === null) throw new Error(`composition failed: ${String(await import('../../apps/desktop/src/core-services.js').then((m) => m.lastCoreCompositionError()))}`);
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(stubProvider(), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_s26', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  // The company's canonical model selection (manual pin) — what goal.create resolves.
  const savedPolicy = await core.policies.savePolicy({
    id: `COMPANY:${COMPANY}`,
    scopeType: 'COMPANY',
    scopeId: COMPANY,
    mode: 'MANUAL',
    manualModelKey: MODEL_KEY,
    actorId: actor,
  } as never);
  if (!savedPolicy.ok) throw new Error(`selection policy failed: ${savedPolicy.error.message}`);
  if (core.controlPlane === null) throw new Error('control plane unavailable in composition');
  // F4: a Goal requires the durable workspace binding — open one before goal.create.
  const wsRoot = tempDir();
  mkdirSync(wsRoot, { recursive: true });
  const opened = await core.repositoryRuntime.openWorkspace({ root: wsRoot, commandProfile: {} });
  if (!opened.ok) throw new Error('workspace open failed: ' + String(opened.error?.code));
  return core;
};

describe('S26 control plane — the Goal-to-Outcome flow over the production composition', () => {
  it('1-10. goal entry → planning → compile → supervisor turn → observation, all through the typed surface', async () => {
    const core = await makeCore();
    const cp = core.controlPlane!;

    // 1-2. The user expresses the goal; the canonical run + goal are created.
    const created = await cp.handle({
      operation: 'goal.create',
      payload: { companyId: COMPANY, objective: '把这份调研变成一份数据报告。', commandId: 'ui-goal-1' },
    });
    if (!created.ok) throw new Error(`goal.create failed: ${JSON.stringify(created.error)}`);
    expect(created.ok).toBe(true);
    const runId = String((created.value as { readonly runId: string }).runId);
    expect(runId.length).toBeGreaterThan(0);

    // The goal is canonical: it rides the run's own immutable artifact (T18-02).
    const goalArtifacts = core.database.db
      .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:run-goal'")
      .get() as { c: number };
    expect(Number(goalArtifacts.c)).toBe(1);

    // 3-7. One bounded advance runs planning → compile → a supervisor turn.
    const advanced = await cp.handle({
      operation: 'goal.advance',
      payload: { companyId: COMPANY, runId },
    });
    if (!advanced.ok) throw new Error(`advance failed: ${JSON.stringify(advanced.error)}`);
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) {
      throw new Error(`advance failed: ${JSON.stringify(advanced.error)}`);
    }
    const advancedValue = advanced.value as {
      readonly executionRunId: string;
      readonly planId: string;
      readonly steps: readonly string[];
    };
    expect(advancedValue.steps).toEqual(['planned', 'compiled', 'supervised']);
    expect(advancedValue.executionRunId).toMatch(/^run_/);

    // The compiled execution run is durable with REAL materialized tasks.
    const tasks = await core.database.tasks.listByRun(advancedValue.executionRunId as never);
    expect(tasks.length).toBe(2);

    // 8-9. Observation through the same typed surface.
    const overview = await cp.handle({ operation: 'run.overview', payload: { companyId: COMPANY, runId: advancedValue.executionRunId } });
    expect(overview.ok).toBe(true);

    // 10. The goal workspace groups the planning run with its derived execution run.
    const workspace = await cp.handle({ operation: 'goal.workspace', payload: { companyId: COMPANY, runId } });
    expect(workspace.ok).toBe(true);
    if (workspace.ok) {
      const ws = workspace.value as { readonly goal: { readonly objective: string } | null; readonly executionRuns: readonly { readonly runId: string }[] };
      expect(ws.goal?.objective).toBe('把这份调研变成一份数据报告。');
      expect(ws.executionRuns.map((entry) => entry.runId)).toEqual([advancedValue.executionRunId]);
    }

    // Home lists the goal.
    const home = await cp.handle({ operation: 'home.summary', payload: { companyId: COMPANY } });
    expect(home.ok).toBe(true);
    if (home.ok) {
      const goals = (home.value as { readonly goals: readonly { readonly runId: string; readonly objective: string | null }[] }).goals;
      expect(goals.some((entry) => entry.runId === runId && entry.objective === '把这份调研变成一份数据报告。')).toBe(true);
    }
  });

  it('17-19. cross-company and cross-run access fail CLOSED on read AND command surfaces', async () => {
    const core = await makeCore();
    const cp = core.controlPlane!;
    const created = await cp.handle({
      operation: 'goal.create',
      payload: { companyId: COMPANY, objective: 'A goal for scope proofs.', commandId: 'ui-goal-scope' },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const runId = String((created.value as { readonly runId: string }).runId);

    const wrongCompany = await cp.handle({ operation: 'run.overview', payload: { companyId: 'company_other', runId } });
    expect(wrongCompany.ok).toBe(false);
    expect((wrongCompany.error as { readonly details?: { readonly reason?: string } }).details?.reason).toBe('CONTROL_PLANE_CROSS_COMPANY_REFUSED');

    const crossCompanyCommand = await cp.handle({
      operation: 'goal.advance',
      payload: { companyId: 'company_other', runId },
    });
    expect(crossCompanyCommand.ok).toBe(false);

    const unknownRun = await cp.handle({ operation: 'run.overview', payload: { companyId: COMPANY, runId: 'run_does_not_exist' } });
    expect(unknownRun.ok).toBe(false);
    expect(unknownRun.error?.code).toBe('NOT_FOUND');
  });

  it('21. a double goal.create with the SAME command id replays the SAME run (no duplicate goal)', async () => {
    const core = await makeCore();
    const cp = core.controlPlane!;
    const first = await cp.handle({
      operation: 'goal.create',
      payload: { companyId: COMPANY, objective: 'One goal, clicked twice.', commandId: 'ui-goal-double' },
    });
    const second = await cp.handle({
      operation: 'goal.create',
      payload: { companyId: COMPANY, objective: 'One goal, clicked twice.', commandId: 'ui-goal-double' },
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect((second.value as { readonly runId: string }).runId).toBe((first.value as { readonly runId: string }).runId);
    const goals = core.database.db
      .prepare("SELECT COUNT(*) AS c FROM runs WHERE workflow_id = 'wf-companyos-goal'")
      .get() as { c: number };
    expect(Number(goals.c)).toBe(1);
  });

  it('35. malformed requests fail closed with typed errors (schema, unknown operation, missing fields)', async () => {
    const core = await makeCore();
    const cp = core.controlPlane!;
    const unknown = await cp.handle({ operation: 'goal.explode', payload: {} });
    expect(unknown.ok).toBe(false);

    const missing = await cp.handle({ operation: 'goal.create', payload: { companyId: COMPANY } });
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe('INVALID_ARGUMENT');

    const notAnObject = await cp.handle('not-a-request');
    expect(notAnObject.ok).toBe(false);
  });

  it('22. with no canonical model selection, goal creation fails CLOSED (nothing is guessed)', async () => {
    const core = await makeCore();
    // Remove the company selection: the product must refuse to guess a model.
    const removed = await core.policies.deletePolicy('COMPANY', COMPANY, (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId);
    expect(removed.ok).toBe(true);
    const cp = core.controlPlane!;
    const created = await cp.handle({
      operation: 'goal.create',
      payload: { companyId: COMPANY, objective: 'A goal without a model.', commandId: 'ui-goal-nomodel' },
    });
    expect(created.ok).toBe(false);
    expect(created.error?.code).toBe('MODEL_SELECTION_REQUIRED');
  });
});
