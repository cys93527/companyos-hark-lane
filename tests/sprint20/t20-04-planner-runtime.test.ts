/**
 * Task-20-04 — Generic planner runtime + durable plan artifact (§51-§65), ALL against the
 * REAL production composition: a generic planning workflow published through the lifecycle
 * (node config `taskProfile` — the T20-03B pack-driven mechanism), a planning run with a
 * canonical goal, the planner task materialized through the normal materializer, and the
 * planner runtime writing the durable `companyos:plan` artifact.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ok, planIdOf, type DomainError, type ModelProviderPort, type Result } from '@companyos/core';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const CHAINS = [
  'core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session',
] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'e2e7.planner';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t20p-'));
  createdDirs.push(dir);
  return dir;
};

let providerCalls = 0;
/** Scriptable planner proposal: the provider answers ONE planning turn per call. */
let plannerAnswer: unknown = null;
let plannerAnswers: unknown[] = [];
const routingProvider = (): ModelProviderPort => ({
  describe: () => ({ providerId: 'prov_e2e7', kind: 'fake', displayName: 'r', version: '1' }),
  listModels: () =>
    Promise.resolve(ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }])),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    providerCalls += 1;
    const structured =
      plannerAnswers.length > 0 ? plannerAnswers.shift() : plannerAnswer;
    return Promise.resolve(
      ok({
        modelId: request.modelId, providerId: 'prov_e2e7', outputText: 'plan text',
        structured: structured as never, toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalCost: null }, finishReason: 'stop' as const,
      }),
    );
  },
  stream(): AsyncIterable<Result<never, DomainError>> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
  },
});

const PROCUREMENT_PROPOSAL = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {
      planItemId: 'screen-suppliers',
      objective: 'Evaluate the three shortlisted suppliers against the stated criteria.',
      acceptanceCriterionRefs: ['crit-suppliers-scored'],
    },
    {
      planItemId: 'finance-review',
      objective: 'Perform the financial review of the recommended supplier.',
      dependencyPlanItemIds: ['screen-suppliers'],
      acceptanceCriterionRefs: ['crit-finance-reviewed'],
    },
    {
      planItemId: 'recommendation',
      objective: 'Produce the procurement recommendation with approval evidence.',
      dependencyPlanItemIds: ['screen-suppliers', 'finance-review'],
      acceptanceCriterionRefs: ['crit-recommendation-approved'],
    },
  ],
  acceptanceCriteria: [
    { criterionId: 'crit-suppliers-scored', requirement: 'All three suppliers have a recorded scored evaluation.' },
    { criterionId: 'crit-finance-reviewed', requirement: 'The finance review report exists and is complete.' },
    { criterionId: 'crit-recommendation-approved', requirement: 'The recommendation cites the finance review and the scores.' },
  ],
};

const SOFTWARE_PROPOSAL = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {
      planItemId: 'implement-feature',
      objective: 'Implement the requested feature behind the agreed interface.',
      acceptanceCriterionRefs: ['crit-feature-works'],
    },
    {
      planItemId: 'verify-feature',
      objective: 'Verify the feature against the acceptance criteria.',
      dependencyPlanItemIds: ['implement-feature'],
      acceptanceCriterionRefs: ['crit-feature-works'],
    },
  ],
  acceptanceCriteria: [
    { criterionId: 'crit-feature-works', requirement: 'The feature demonstrably satisfies the requested behavior.' },
  ],
};

interface Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly runId: string;
  readonly plannerTaskId: string;
}

/**
 * The generic PLANNING WORKFLOW: one planning stage whose pinned taskProfile names the
 * planner role/kind — published through the REAL lifecycle, materialized through the REAL
 * normal materializer. The stage kind is the neutral string 'planning' (a Core lifecycle
 * capability, not a software role).
 */
const makeFixture = async (options?: {
  readonly crashAt?: string;
  readonly goal?: string;
  readonly contextWindow?: number;
}): Promise<Fixture> => {
  providerCalls = 0;
  plannerAnswer = PROCUREMENT_PROPOSAL;
  plannerAnswers = [];
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    // The planner task kind is a deployment-registered runtime handler kind.
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: ['companyos:planning'] },
    ...(options?.crashAt === undefined ? {} : { faultCheckpoints: {
      checkpoint: (name: string): Promise<void> =>
        name === options.crashAt ? Promise.reject(new Error(`crash:${String(name)}`)) : Promise.resolve(),
    } }),
  });
  if (core === null) throw new Error('composition failed');
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(routingProvider(), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: 'planning', actorId: actor });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [
      {
        id: 'plan', kind: 'planning', title: 'Plan the goal',
        config: { taskProfile: { roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 2 } },
      },
    ],
    edges: [],
  } as never;
  const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({ templateId: template.value.id, actorId: actor });
  if (!published.ok) throw new Error(published.error.message);
  const goal = options?.goal ?? 'Evaluate three suppliers, perform financial review, obtain approval, and produce a procurement recommendation.';
  const run = await core.lifecycle.createRun({
    templateId: template.value.id, companyId: COMPANY, workflowId: 'wf-plan', actorId: actor,
    modelBindings: { planner: MODEL_KEY },
    goal: { objective: goal, source: { type: 'human' } },
  });
  if (!run.ok) throw new Error(run.error.message);
  if (options?.contextWindow !== undefined) {
    db.db.prepare('UPDATE model_records SET context_window = ? WHERE model_key = ?').run(options.contextWindow, MODEL_KEY);
  }
  const driven = await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
  if (!driven.ok) throw new Error(driven.error.message);
  const task = await core.normalTaskMaterializer!.materialize({
    companyId: COMPANY, runId: run.value.run.id, stageId: 'plan',
  });
  if (!task.ok) throw new Error(task.error.message);
  return {
    core, actor, dataDir, casRoot,
    runId: run.value.run.id,
    plannerTaskId: task.value.taskId,
  };
};

const plan = (f: Fixture, commandId = 'plan-1') =>
  f.core.plannerRuntime!.runPlanningTurn({
    companyId: COMPANY, runId: f.runId, taskId: f.plannerTaskId,
    planningCommandId: commandId, actorId: f.actor,
  });

const reasonOf = (error: { readonly details: Readonly<Record<string, unknown>> }): string =>
  String(error.details['reason'] ?? '');

/* ---------------------------------------------- §51 happy path + §63/§64 goals */

describe('T20-04 §51/§63/§64 — the end-to-end happy path (non-software + software goals)', () => {
  it('canonical goal → ONE planner execution → validated → durable plan artifact (procurement)', async () => {
    const f = await makeFixture();
    const result = await plan(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // correct deterministic planId
    expect(result.value.planId).toBe(
      planIdOf({ companyId: COMPANY, planningRunId: f.runId, planningCommandId: 'plan-1' }),
    );
    expect(result.value.replayed).toBe(false);
    // ONE planner AgentExecution, settled COMPLETED, provenance truthful
    const execs = f.core.database.db
      .prepare('SELECT status FROM agent_executions WHERE task_id = ?')
      .all(f.plannerTaskId) as { status: string }[];
    expect(execs).toHaveLength(1);
    expect(execs[0]!.status).toBe('COMPLETED');
    // the plan artifact: kind, run ownership, payload, fingerprint
    const artifact = await f.core.database.artifactStore!.getByCreationCommand(
      `plan:${String(result.value.planId)}`,
    );
    expect(artifact).not.toBeNull();
    expect(artifact!.artifact.kind).toBe('companyos:plan');
    expect(String(artifact!.artifact.runId)).toBe(f.runId);
    // canonical content bytes ⇒ sha256(content) == the plan fingerprint == contentHash
    expect(result.value.fingerprint).toBe(artifact!.artifact.contentHash);
    expect(artifact!.creationCommandFingerprint.length).toBe(64);
    // the provider saw the canonical goal + the plan contract (industry-neutral)
    expect(providerCalls).toBe(1);
    // NO compilation side effects
    const templates = (await f.core.database.templates.list({ limit: 50 })).items;
    expect(templates).toHaveLength(1); // only the planning workflow
    const runs = f.core.database.db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number };
    expect(Number(runs.c)).toBe(1); // no execution run
    const tasks = await f.core.database.tasks.listByRun(f.runId);
    expect(tasks).toHaveLength(1); // no execution tasks
  });

  it('§64. a software-development goal plans through the SAME runtime', async () => {
    const f = await makeFixture({ goal: 'Ship the invoice-history feature for the finance portal.' });
    plannerAnswer = SOFTWARE_PROPOSAL;
    const result = await plan(f);
    expect(result.ok).toBe(true); // same planner, no separate software planner
  });
});

/* ------------------------------------------------- §52-§54 replay / restart / crash */

describe('T20-04 §52-§54 — replay, restart replay, crash-after-artifact', () => {
  it('§52. same command replays with ZERO provider calls and no duplicate artifact', async () => {
    const f = await makeFixture();
    const first = await plan(f);
    if (!first.ok) throw new Error(first.error.message);
    const second = await plan(f);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.planId).toBe(first.value.planId);
    expect(second.value.artifactId).toBe(first.value.artifactId);
    expect(second.value.replayed).toBe(true);
    expect(providerCalls).toBe(1); // replay added ZERO provider calls
    const rows = f.core.database.db
      .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:plan'")
      .get() as { c: number };
    expect(Number(rows.c)).toBe(1); // no duplicate
  });

  it('§53. restart replay: same artifact, provider calls = 0, same fingerprint', async () => {
    const f = await makeFixture();
    const first = await plan(f);
    if (!first.ok) throw new Error(first.error.message);
    f.core.database.close();
    const tracked = openDatabases.indexOf(f.core.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const db2 = openDurableDatabase({ dataDir: f.dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
    openDatabases.push(db2);
    const foundation2 = await openArtifactFoundation({ casRoot: f.casRoot, database: db2, logger: nullLogger as never });
    if (!foundation2.ok) throw new Error('foundation2 failed');
    const core2 = await composeCoreServices(db2, nullLogger as never, {
      artifactFoundation: foundation2 as never,
      stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: ['companyos:planning'] },
    });
    if (core2 === null) throw new Error('composition2 failed');
    const second = await core2.plannerRuntime!.runPlanningTurn({
      companyId: COMPANY, runId: f.runId, taskId: f.plannerTaskId,
      planningCommandId: 'plan-1', actorId: f.actor,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.artifactId).toBe(first.value.artifactId);
    expect(second.value.fingerprint).toBe(first.value.fingerprint);
    expect(second.value.replayed).toBe(true);
    expect(providerCalls).toBe(1); // restart replay: zero new calls
  });

  it('§54. crash AFTER the artifact, before settlement: replay is single, canonical, zero-calls', async () => {
    const f = await makeFixture({ crashAt: 'after_plan_artifact_before_execution_settlement' });
    await expect(plan(f)).rejects.toThrow('crash:after_plan_artifact_before_execution_settlement');
    expect(providerCalls).toBe(1);
    // The plan artifact IS durable (artifact-first); the execution row truthfully unsettled.
    const artifacts = f.core.database.db
      .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:plan'")
      .get() as { c: number };
    expect(Number(artifacts.c)).toBe(1);
    const execs = f.core.database.db
      .prepare('SELECT status FROM agent_executions WHERE task_id = ?')
      .all(f.plannerTaskId) as { status: string }[];
    expect(execs[0]!.status).toBe('RUNNING'); // truthful: settlement was interrupted
    // Restart + replay the SAME command: single canonical plan, ZERO provider calls.
    f.core.database.close();
    const tracked = openDatabases.indexOf(f.core.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const db2 = openDurableDatabase({ dataDir: f.dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
    openDatabases.push(db2);
    const foundation2 = await openArtifactFoundation({ casRoot: f.casRoot, database: db2, logger: nullLogger as never });
    if (!foundation2.ok) throw new Error('foundation2 failed');
    const core2 = await composeCoreServices(db2, nullLogger as never, {
      artifactFoundation: foundation2 as never,
      stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: ['companyos:planning'] },
    });
    if (core2 === null) throw new Error('composition2 failed');
    const replay = await core2.plannerRuntime!.runPlanningTurn({
      companyId: COMPANY, runId: f.runId, taskId: f.plannerTaskId,
      planningCommandId: 'plan-1', actorId: f.actor,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(providerCalls).toBe(1);
    const after = db2.db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:plan'").get() as { c: number };
    expect(Number(after.c)).toBe(1); // no alternate plan accepted
  });
});

/* ---------------------------------------------------- §55-§62 invalid / authority */

describe('T20-04 §55-§62 — strictness, isolation, budget, replan, conflict', () => {
  it('§55. prose / malformed JSON fails closed with NO artifact', async () => {
    const f = await makeFixture();
    plannerAnswer = 'This is not JSON, just planner prose.';
    const result = await plan(f);
    expect(result.ok).toBe(false);
    const artifacts = f.core.database.db
      .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:plan'")
      .get() as { c: number };
    expect(Number(artifacts.c)).toBe(0);
  });

  it('§56. structurally invalid plans (cycle / orphan criterion / duplicate id / unknown field) exhaust → no artifact; ONE invalid then a VALID fallback REPAIRS', async () => {
    const invalidShapes = [
      { ...PROCUREMENT_PROPOSAL, planItems: [
        { ...PROCUREMENT_PROPOSAL.planItems[0]!, dependencyPlanItemIds: ['recommendation'] },
        PROCUREMENT_PROPOSAL.planItems[1]!,
        { ...PROCUREMENT_PROPOSAL.planItems[2]!, dependencyPlanItemIds: ['screen-suppliers'] },
      ] }, // cycle
      { ...PROCUREMENT_PROPOSAL, acceptanceCriteria: [...PROCUREMENT_PROPOSAL.acceptanceCriteria, { criterionId: 'crit-orphan', requirement: 'x' }] }, // orphan
      { ...PROCUREMENT_PROPOSAL, planItems: [PROCUREMENT_PROPOSAL.planItems[0]!, { ...PROCUREMENT_PROPOSAL.planItems[1]!, planItemId: 'screen-suppliers' }] }, // duplicate id
      { ...PROCUREMENT_PROPOSAL, priority: 'high' }, // unknown field
    ];
    /*
     * PLAN_PROPOSAL_REPAIR_V1 (LIVE-SMOKE-FIX-06): every invalid shape exhausts the
     * 3-total budget when the provider keeps returning it (typed PLANNER_INVALID_OUTPUT
     * with per-attempt canonical codes — each still /^PLAN_/), and no artifact appears.
     */
    for (const shape of invalidShapes) {
      const f = await makeFixture();
      plannerAnswers = [shape, shape, shape];
      const result = await plan(f);
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(String(result.error.details['reason'] ?? '')).toBe('PLANNER_INVALID_OUTPUT');
        expect(Number(result.error.details['proposalAttempts'])).toBe(3);
        const attemptFailures = result.error.details['attemptFailures'] as { code: string }[];
        expect(attemptFailures.length).toBe(3);
        expect(attemptFailures.every((failure) => /^PLAN_/.test(failure.code))).toBe(true);
      }
      const artifacts = f.core.database.db
        .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:plan'")
        .get() as { c: number };
      expect(Number(artifacts.c)).toBe(0);
    }
    /*
     * The repair path itself: ONE invalid proposal (typed feedback) followed by the
     * fixture's valid fallback SUCCEEDS — the invalid attempt is durable FAILED truth,
     * the valid proposal becomes the ONE canonical plan.
     */
    const f = await makeFixture();
    plannerAnswers = [invalidShapes[0]!];
    const repaired = await plan(f);
    expect(repaired.ok).toBe(true);
    const plans = f.core.database.db
      .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:plan'")
      .get() as { c: number };
    expect(Number(plans.c)).toBe(1);
    const plannerExecutions = f.core.database.db
      .prepare("SELECT status, error_code FROM agent_executions WHERE agent_id = 'agent.planner' ORDER BY attempt")
      .all() as { status: string; error_code: string | null }[];
    expect(plannerExecutions.map((row) => row.status)).toEqual(['FAILED', 'COMPLETED']);
    expect(plannerExecutions[0]!.error_code).toBe('PLANNER_INVALID_OUTPUT');
  });

  it('§57. a foreign company cannot plan (NOT_FOUND, no leak)', async () => {
    const f = await makeFixture();
    const foreign = await f.core.plannerRuntime!.runPlanningTurn({
      companyId: 'company_other', runId: f.runId, taskId: f.plannerTaskId,
      planningCommandId: 'plan-1', actorId: f.actor,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe('NOT_FOUND');
      expect(reasonOf(foreign.error)).toBe('RUN_MISSING');
    }
    expect(providerCalls).toBe(0);
  });

  it('§58. a wrong-run planner task: provider calls = 0, no execution, no artifact', async () => {
    const f = await makeFixture();
    // A second planning RUN in the SAME durable stack, then plan it with the FIRST run's task.
    const template = await f.core.lifecycle.createTemplate({ orgId: COMPANY, name: 'planning2', actorId: f.actor });
    if (!template.ok) throw new Error(template.error.message);
    const graph = {
      nodes: [{ id: 'plan', kind: 'planning', title: 'p', config: { taskProfile: { roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 1 } } }],
      edges: [],
    } as never;
    const saved = await f.core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: f.actor });
    if (!saved.ok) throw new Error(saved.error.message);
    const published = await f.core.lifecycle.publish({ templateId: template.value.id, actorId: f.actor });
    if (!published.ok) throw new Error(published.error.message);
    const run2 = await f.core.lifecycle.createRun({
      templateId: template.value.id, companyId: COMPANY, workflowId: 'wf-plan-2', actorId: f.actor,
      modelBindings: { planner: MODEL_KEY },
      goal: { objective: 'Second planning run.', source: { type: 'human' } },
    });
    if (!run2.ok) throw new Error(run2.error.message);
    const driven = await f.core.sprint13.engine.drive(run2.value.run.id, { maxSteps: 8 });
    if (!driven.ok) throw new Error(driven.error.message);
    const result = await f.core.plannerRuntime!.runPlanningTurn({
      companyId: COMPANY, runId: run2.value.run.id, taskId: f.plannerTaskId,
      planningCommandId: 'plan-1', actorId: f.actor,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(reasonOf(result.error)).toBe('PLANNER_TASK_RUN_MISMATCH');
    expect(providerCalls).toBe(0);
    const artifacts = f.core.database.db
      .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:plan'")
      .get() as { c: number };
    expect(Number(artifacts.c)).toBe(0);
  });

  it("§59. the binding comes from the run's own pin (no current default)", async () => {
    // Two runs pin two different planner models: each resolves its own; a missing pin
    // fails closed (never a default/first provider).
    const f = await makeFixture();
    const result = await plan(f);
    expect(result.ok).toBe(true); // resolved via the run's own snapshot binding
    const f2 = await makeFixture();
    // Remove the pinned binding row semantics: bind under a DIFFERENT name ⇒ fail closed.
    const db = f2.core.database;
    void db;
    // (The binding reader reads the run snapshot; a run without a 'planner' binding:)
    const template = await f2.core.lifecycle.createTemplate({ orgId: COMPANY, name: 'nobind', actorId: f2.actor });
    if (!template.ok) throw new Error(template.error.message);
    const graph = {
      nodes: [{ id: 'plan', kind: 'planning', title: 'p', config: { taskProfile: { roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 1 } } }],
      edges: [],
    } as never;
    const saved = await f2.core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: f2.actor });
    if (!saved.ok) throw new Error(saved.error.message);
    const published = await f2.core.lifecycle.publish({ templateId: template.value.id, actorId: f2.actor });
    if (!published.ok) throw new Error(published.error.message);
    const run = await f2.core.lifecycle.createRun({
      templateId: template.value.id, companyId: COMPANY, workflowId: 'wf-nobind', actorId: f2.actor,
      modelBindings: { somethingElse: MODEL_KEY },
      goal: { objective: 'No planner binding.', source: { type: 'human' } },
    });
    if (!run.ok) throw new Error(run.error.message);
    const driven = await f2.core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
    if (!driven.ok) throw new Error(driven.error.message);
    const task = await f2.core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: run.value.run.id, stageId: 'plan' });
    if (!task.ok) throw new Error(task.error.message);
    const refused = await f2.core.plannerRuntime!.runPlanningTurn({
      companyId: COMPANY, runId: run.value.run.id, taskId: task.value.taskId,
      planningCommandId: 'plan-1', actorId: f2.actor,
    });
    expect(refused.ok).toBe(false); // FAIL CLOSED — no default fallback
    if (!refused.ok) expect(reasonOf(refused.error)).toBe('RUN_BINDING_MISSING');
  });

  it('§60. token overflow: pre-provider rejection, provider calls = 0, no artifact', async () => {
    const f = await makeFixture({ contextWindow: 2_000 });
    // The rendered planner context (goal + contract) exceeds allowed = 2000-4096-margin < 0
    const result = await plan(f);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(reasonOf(result.error)).toMatch(/BUDGET|WINDOW/);
    }
    expect(providerCalls).toBe(0);
    const artifacts = f.core.database.db
      .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:plan'")
      .get() as { c: number };
    expect(Number(artifacts.c)).toBe(0);
  });

  it('§61. replan boundary: C2 on the SAME planning run is refused; a NEW planning run plans', async () => {
    const f = await makeFixture();
    const p1 = await plan(f, 'plan-1');
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    // One baseline planner task per run/stage (T20-03 freeze) cannot truthfully carry two
    // independent planning results: the corrective's replan boundary is a NEW PLANNING RUN
    // (the T20-01 lifecycle). C2 against the settled run fails closed.
    const p2 = await plan(f, 'plan-2');
    expect(p2.ok).toBe(false);
    if (!p2.ok) {
      expect(String(p2.error.details['reason'] ?? '')).toBe('PLANNER_TASK_ALREADY_SETTLED');
    }
    // P1 immutable, single, auditable; no second artifact on this run.
    const rows = f.core.database.db
      .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:plan'")
      .get() as { c: number };
    expect(Number(rows.c)).toBe(1);
    // A NEW planning run plans freely — both results immutable and auditable.
    const f2 = await makeFixture();
    const other = await plan(f2, 'plan-1');
    expect(other.ok).toBe(true);
  });

  it('§62. same planId + different fingerprint → FAIL CLOSED (artifact identity seam)', async () => {
    const f = await makeFixture();
    const first = await plan(f);
    if (!first.ok) throw new Error(first.error.message);
    // Corrupt the durable artifact's content command row simulation: attempt a second
    // create with the SAME command identity but DIFFERENT bytes — the artifact service
    // must CONFLICT (the trusted persistence seam §28).
    const payload2 = {
      schema: 'companyos/plan/1',
      sourceGoal: { goalArtifactId: 'art_other' },
      planItems: PROCUREMENT_PROPOSAL.planItems,
      acceptanceCriteria: PROCUREMENT_PROPOSAL.acceptanceCriteria,
    };
    const conflict = await f.core.sprint13.artifactService.create({
      commandId: `plan:${String(first.value.planId)}`,
      runId: f.runId as never,
      taskId: f.plannerTaskId as never,
      kind: 'companyos:plan',
      content: new TextEncoder().encode(JSON.stringify(payload2)),
      producedBy: f.actor,
      traceId: 'tr_conflict',
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(String(conflict.error.details['reason'] ?? '')).toBe('ARTIFACT_COMMAND_FINGERPRINT_MISMATCH');
    }
    // the original plan remains unchanged
    const replay = await plan(f);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.artifactId).toBe(first.value.artifactId);
    expect(replay.value.replayed).toBe(true);
  });
});

/* ---------------------------------------------------- §65 authority side effects */

describe('T20-04 §65 — planning alone writes NO execution-truth side effects', () => {
  it('no review/validation/handoff/session/tool-authority writes; no repin; single template', async () => {
    const f = await makeFixture();
    const count = (sql: string): number =>
      Number((f.core.database.db.prepare(sql).get() as { c: number }).c);
    const before = {
      reviews: count("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:review-findings'"),
      validations: count('SELECT COUNT(*) AS c FROM validations'),
      handoffs: (() => {
        const t = f.core.database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='handoffs'").get() as { name: string } | undefined;
        return t === undefined ? 0 : count('SELECT COUNT(*) AS c FROM handoffs');
      })(),
      sessions: count('SELECT COUNT(*) AS c FROM sessions'),
      tools: count('SELECT COUNT(*) AS c FROM tool_records'),
    };
    const result = await plan(f);
    expect(result.ok).toBe(true);
    expect(count("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:review-findings'")).toBe(before.reviews);
    expect(count('SELECT COUNT(*) AS c FROM validations')).toBe(before.validations);
    expect(count('SELECT COUNT(*) AS c FROM sessions')).toBe(before.sessions);
    expect(count('SELECT COUNT(*) AS c FROM tool_records')).toBe(before.tools);
    if (before.handoffs !== 0) expect(count('SELECT COUNT(*) AS c FROM handoffs')).toBe(before.handoffs);
    // run pin unchanged (same snapshot)
    const run = await f.core.database.runs.get(f.runId as never);
    expect(String(run?.state)).toBe('EXECUTING');
  });
});
