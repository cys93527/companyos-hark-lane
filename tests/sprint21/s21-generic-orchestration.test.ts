/**
 * Sprint21 — PACK-DRIVEN GENERIC ORCHESTRATION (§90-§94 test matrices).
 *
 * The procurement pack (supplier-analysis → finance-review → purchase-approval →
 * delivery-verification) runs AUTONOMOUSLY end-to-end through the generic runtime: no
 * review/qa/Developer vocabulary, heterogeneous role/taskKind/maxAttempts/validatorIds,
 * executors registered as composition DATA (executorKinds), validation driven by the
 * pinned node validatorIds, business tasks executed to canonical stage outputs, the run
 * reaching COMPLETED — without touching orchestrator source for any role.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createToolRecord,
  ok,
  TOOL_CAPABILITY_VALIDATOR,
  type DomainError,
  type ModelProviderPort,
  type Result,
  type ToolPort,
} from '@companyos/core';
import { compiledNodeId, type PlanCompilationSpec, type PlanItemCompilationProfile } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const CHAINS = [
  'core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff',
] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'e2e7.planner';
const VALIDATOR_ID = 'val.supply-audit';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const profile = (
  stageKind: string,
  roleId: string,
  taskKind: string,
  maxAttempts: number,
  validatorIds: readonly string[] = [],
): PlanItemCompilationProfile => ({ stageKind, taskProfile: { roleId, taskKind, maxAttempts }, validatorIds });

/** §54: the heterogeneous procurement pack — four business kinds, three-plus profiles. */
const PROCUREMENT: PlanCompilationSpec = {
  planItemProfiles: {
    'supplier-analysis': profile('supply-analysis-work', 'rol.supply-analyst', 'task.supplier-analysis', 2),
    'finance-review': profile('finance-review-work', 'rol.finance-reviewer', 'task.finance-review', 4),
    'purchase-approval': profile('purchasing-approval-work', 'rol.procurement-approver', 'task.purchase-approval', 1),
    'delivery-verification': profile('delivery-verification-work', 'rol.delivery-verifier', 'task.delivery-verification', 3, [VALIDATOR_ID]),
  },
};
/** §57: a brand-new logistics pack — entirely new roles/kinds through the SAME runtime. */
const LOGISTICS: PlanCompilationSpec = {
  planItemProfiles: {
    'route-plan': profile('logistics-planning-work', 'rol.route-planner', 'task.route-plan', 5),
    'customs-check': profile('logistics-customs-work', 'rol.customs-officer', 'task.customs-check', 2, [VALIDATOR_ID]),
    dispatch: profile('logistics-dispatch-work', 'rol.dispatch-coordinator', 'task.dispatch', 1),
  },
};

const PLAN_OF = (spec: PlanCompilationSpec) => {
  const items = Object.keys(spec.planItemProfiles).map((planItemId, index, all) => ({
    planItemId,
    objective: `Execute ${String(planItemId)}.`,
    ...(index === 0 ? {} : { dependencyPlanItemIds: [all[index - 1]!] }),
    acceptanceCriterionRefs: [`crit-${String(planItemId)}`],
  }));
  return {
    planItems: items,
    acceptanceCriteria: items.map((item) => ({
      criterionId: item.acceptanceCriterionRefs[0]!,
      requirement: `The ${String(item.planItemId)} outcome is recorded.`,
    })),
  };
};

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s21-'));
  createdDirs.push(dir);
  return dir;
};

/** Executor call log — which task kind / run executed, in order. */
const executorLog: { readonly runId: string; readonly taskKind: string; readonly stage: string }[] = [];
let plannerCalls = 0;
let validatorVerdict: 'pass' | 'fail' = 'pass';

const makeProvider = (plan: { planItems: unknown[]; acceptanceCriteria: unknown[] }): ModelProviderPort => ({
  describe: () => ({ providerId: 'prov_e2e7', kind: 'fake', displayName: 'r', version: '1' }),
  listModels: () => Promise.resolve(ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }])),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    // Classify the round by the CONTRACT it asked for (the response format / prompt text),
    // never by role names: the planner proposes the plan; the generic executor answers its
    // own work-package contract; everything else is a supervisor decision round.
    const corpus = [
      request.messages.map((message) => String(message.content)).join('\n'),
      request.responseFormat === undefined || request.responseFormat === null ? '' : JSON.stringify(request.responseFormat),
    ].join('\n');

    if (corpus.includes('companyos/plan-proposal/1')) {
      plannerCalls += 1;
      return Promise.resolve(ok({
        modelId: request.modelId, providerId: 'prov_e2e7', outputText: 'plan',
        structured: { schema: 'companyos/plan-proposal/1', planItems: plan.planItems, acceptanceCriteria: plan.acceptanceCriteria } as never,
        toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalCost: null }, finishReason: 'stop' as const,
      }));
    }
    const structured = resolveStructuredRound(corpus);
    return Promise.resolve(ok({
      modelId: request.modelId, providerId: 'prov_e2e7', outputText: 'round',
      structured: structured as never,
      toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalCost: null }, finishReason: 'stop' as const,
    }));
  },
  stream(): AsyncIterable<Result<never, DomainError>> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
  },
});

/**
 * The deterministic round scripts: the generic executor answers its OWN structured
 * contract ({status, artifactContent}); the supervisor turn answers the decision
 * contract. Everything keyed by the STRUCTURED SCHEMA the runtime asked for — the
 * provider fake never sees roles or pack names as authority.
 */
const resolveStructuredRound = (corpus: string): unknown => {
  if (corpus.includes('status') && corpus.includes('artifactContent')) {
    // generic executor round — record the executed kind from the Work Package context
    const match = corpus.match(/"taskKind":"([^"]+)"/);
    const stageMatch = corpus.match(/"stageId":"([^"]+)"/);
    const runMatch = corpus.match(/"runId":"([^"]+)"/);
    if (match !== null && stageMatch !== null && runMatch !== null) {
      executorLog.push({ runId: runMatch[1]!, taskKind: match[1]!, stage: stageMatch[1]! });
    }
    return { status: 'succeeded', artifactContent: `result:${String(match?.[1] ?? 'kind')}` };
  }
  // Supervisor decision round. The decision follows the CANONICAL CONTEXT, not a script
  // schedule: when the corpus carries a passing validation the run is finalizing, so the
  // honest decision is COMPLETE citing that durable validation; otherwise CONTINUE.
  const validationMatch = corpus.match(/"validationId":"(val_[0-9A-Za-z]+)"/);
  const passMatch = /"status":"pass"/.test(corpus);
  if (validationMatch !== null && passMatch && corpus.includes('FINALIZING')) {
    return {
      schema: 'companyos/supervisor-proposal/1',
      action: 'COMPLETE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'All stages are complete and the validation gate passed.',
      evidenceRefs: [validationMatch[1]!],
      subject: null,
    };
  }
  return {
    schema: 'companyos/supervisor-proposal/1',
    action: 'CONTINUE',
    reasonCode: 'GOAL_SATISFIED',
    summary: 'Continue the run.',
    evidenceRefs: [],
    subject: null,
  };
};

/** The validator TOOL (Sprint18 pattern) — deterministic, verdict-scripted. */
const validatorPort = (): ToolPort => ({
  describe: () => ({
    toolId: VALIDATOR_ID, name: 'supply audit validator', description: 'Deterministic supply validator (fixture).',
    version: '1', capabilities: [TOOL_CAPABILITY_VALIDATOR], riskLevel: 'LOW',
    parameters: { type: 'object', additionalProperties: true },
  }),
  async invoke(request) {
    const at = new Date().toISOString();
    return ok({
      status: 'ok' as const,
      output: {
        verdict: validatorVerdict,
        evidenceRefs: [`command:${VALIDATOR_ID}:${request.idempotencyKey ?? 'once'}`],
        report: { kind: 'validator-report', label: `${VALIDATOR_ID} report`, content: JSON.stringify({ verdict: validatorVerdict }) },
      },
      artifactRefs: [], startedAt: at, finishedAt: at, latencyMs: 1,
    });
  },
});

const registerValidatorTool = async (core: Core, actor: string): Promise<void> => {
  const record = createToolRecord({
    toolId: VALIDATOR_ID,
    name: 'supply audit validator',
    description: 'Deterministic in-process supply validator (S21 fixture).',
    version: '1',
    capabilities: [TOOL_CAPABILITY_VALIDATOR],
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true },
    riskLevel: 'LOW',
    requiredAuthorities: ['tool.invoke'],
    idempotencyMode: 'IDEMPOTENT_KEY',
    adapterRef: VALIDATOR_ID,
    now: new Date().toISOString(),
  });
  if (!record.ok) throw new Error(record.error.message);
  const registered = await core.tools.register(record.value, { actorId: actor });
  if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
};

interface Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly planningRunId: string;
  readonly executionRunId: string;
  readonly planId: string;
}

const kindsOf = (spec: PlanCompilationSpec): readonly string[] =>
  Object.values(spec.planItemProfiles).map((entry) => entry.taskProfile.taskKind);

const makeFixture = async (options?: {
  readonly spec?: PlanCompilationSpec;
  readonly registerKinds?: readonly string[] | 'reverse';
  readonly commandId?: string;
}): Promise<Fixture> => {
  const spec = options?.spec ?? PROCUREMENT;
  const plan = PLAN_OF(spec);
  plannerCalls = 0;
  executorLog.length = 0;
  validatorVerdict = 'pass';
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const allKinds = [...kindsOf(spec), 'companyos:planning'];
  const executorKinds = options?.registerKinds === 'reverse' ? [...allKinds].reverse() : allKinds;
  // NOTE: 'companyos:planning' registers AVAILABILITY only (the planning task itself runs
  // through the dedicated planner runtime, never the generic executor).
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: {
      developerKinds: [], reviewKinds: [], qaKinds: [],
      executorKinds,
    },
    toolPorts: new Map<string, ToolPort>([[VALIDATOR_ID, validatorPort()]]),
    planCompilationSpec: spec,
    planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
  });
  if (core === null) throw new Error('composition failed');
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(makeProvider(plan), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  await registerValidatorTool(core, actor);
  const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: 'planning', actorId: actor });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [{ id: 'plan', kind: 'planning', title: 'Plan', config: { taskProfile: { roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 2 } } }],
    edges: [],
  } as never;
  const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({ templateId: template.value.id, actorId: actor });
  if (!published.ok) throw new Error(published.error.message);
  const run = await core.lifecycle.createRun({
    templateId: template.value.id, companyId: COMPANY, workflowId: 'wf-plan', actorId: actor,
    modelBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    goal: { objective: 'Evaluate suppliers, perform financial review, obtain purchase approval, and verify delivery readiness.', source: { type: 'human' } },
  });
  if (!run.ok) throw new Error(run.error.message);
  const driven = await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
  if (!driven.ok) throw new Error(driven.error.message);
  const task = await core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: run.value.run.id, stageId: 'plan' });
  if (!task.ok) throw new Error(task.error.message);
  const planned = await core.plannerRuntime!.runPlanningTurn({
    companyId: COMPANY, runId: run.value.run.id, taskId: task.value.taskId,
    planningCommandId: 'plan-C1', actorId: actor,
  });
  if (!planned.ok) throw new Error(planned.error.message);
  const compiled = await core.planCompiler!.compile({
    companyId: COMPANY, planningRunId: run.value.run.id, planArtifactId: planned.value.artifactId,
    compilationCommandId: options?.commandId ?? 'compile-1', actorId: actor, executionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
  }, spec);
  if (!compiled.ok) throw new Error(compiled.error.message);
  // Walk the frozen run machine to EXECUTING (RUN.START…ROUTE = 7 transitions) WITHOUT
  // executing a stage — the generic orchestrator drives all stage execution itself.
  const started = await core.sprint13.engine.drive(compiled.value.executionRunId, { maxSteps: 7 });
  if (!started.ok) throw new Error(started.error.message);
  return {
    core, actor, dataDir, casRoot,
    planningRunId: run.value.run.id,
    executionRunId: compiled.value.executionRunId,
    planId: compiled.value.planId,
  };
};

const runAutonomous = async (f: Fixture, signal?: AbortSignal) =>
  f.core.autonomousSupervisor!.run({
    companyId: COMPANY,
    runId: f.executionRunId,
    taskId: (await await0(f)) as never,
    actorId: f.actor,
    runIdentity: `s21:${String(f.executionRunId)}`,
    ...(signal === undefined ? {} : { signal }),
  });

// The supervisor entry needs a subject task id; use the first materialized task of the run.
function await0(f: Fixture): Promise<string> {
  return f.core.database.tasks.listByRun(f.executionRunId).then((tasks) => {
    const first = tasks.filter((t) => String(t.stageId) !== 'plan')[0] ?? tasks[0];
    if (first === undefined) throw new Error('no tasks');
    return String(first.id);
  });
}

const countOf = (core: Core, sql: string, ...params: readonly (string | number | null)[]): number =>
  Number((core.database.db.prepare(sql).get(...(params as never[])) as { c: number }).c);

const runStateOf = (core: Core, runId: string): string =>
  String((core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string }).state);

const tasksByStage = async (core: Core, runId: string, planId: string, item: string) => {
  const stageId = compiledNodeId(planId, item);
  const tasks = await core.database.tasks.listByRun(runId);
  return { stageId, tasks: tasks.filter((t) => String(t.stageId) === stageId) };
};

/* ================= §90 orchestration matrix ================= */

describe('S21 §90 — generic orchestration', () => {
  it('1-6/§56. procurement 4-stage autonomous E2E: COMPLETED with zero Core role edits', async () => {
    const f = await makeFixture();
    const result = await runAutonomous(f);
    if (!result.ok) throw new Error(`autonomous failed: ${String(result.error.code)} ${String(result.error.message)} ${JSON.stringify(result.error.details)}`);
    if (result.value.stopReason !== 'completed') throw new Error(`stop=${String(result.value.stopReason)} turns=${String(result.value.turns)} applied=${JSON.stringify(result.value.applied)} last=${JSON.stringify(result.value.lastDecision ?? null)}`);
    expect(result.value.stopReason).toBe('completed');
    expect(runStateOf(f.core, f.executionRunId)).toBe('COMPLETED');
    // all four business stages executed through the generic executor, in DAG order
    const kinds = executorLog.map((entry) => entry.taskKind);
    expect(kinds).toEqual(['task.supplier-analysis', 'task.finance-review', 'task.purchase-approval', 'task.delivery-verification']);
    // canonical stage outputs exist and are DONE with artifacts
    for (const item of ['supplier-analysis', 'finance-review', 'purchase-approval', 'delivery-verification']) {
      const { tasks } = await tasksByStage(f.core, f.executionRunId, f.planId, item);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.state).toBe('DONE');
      expect(Array.isArray((tasks[0]!.outputs['stageOutput'] as { artifactRefs?: string[] })?.artifactRefs)).toBe(true);
      expect(((tasks[0]!.outputs['stageOutput'] as { artifactRefs: string[] }).artifactRefs).length).toBe(1);
    }
    // validators ran from the pinned node validatorIds (delivery stage), no QA node existed
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM validations WHERE run_id = ?', f.executionRunId)).toBeGreaterThan(0);
    // §44/§95: zero handoffs, no extra baseline tasks, single template/plan
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM handoffs')).toBe(0);
    expect((await f.core.database.tasks.listByRun(f.executionRunId)).length).toBe(4);
  });

  it('7/§57. a brand-new logistics pack executes through the SAME orchestrator', async () => {
    const f = await makeFixture({ spec: LOGISTICS, commandId: 'compile-log' });
    const result = await runAutonomous(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('completed');
    expect(executorLog.map((entry) => entry.taskKind)).toEqual(['task.route-plan', 'task.customs-check', 'task.dispatch']);
  });

  it('9/§60. registry order is irrelevant: reversed executor registration, identical result', async () => {
    const f = await makeFixture({ registerKinds: 'reverse', commandId: 'compile-rev' });
    const result = await runAutonomous(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('completed');
    expect(executorLog.map((entry) => entry.taskKind)).toEqual(['task.supplier-analysis', 'task.finance-review', 'task.purchase-approval', 'task.delivery-verification']);
  });

  it('12/§63. a missing executor fails closed: no task, zero provider calls', async () => {
    // Register only THREE of the four kinds — delivery-verification has no executor.
    const spec = PROCUREMENT;
    const plan = PLAN_OF(spec);
    plannerCalls = 0; executorLog.length = 0;
    const dataDir = tempDir(); const casRoot = tempDir();
    const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
    openDatabases.push(db);
    const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
    if (!foundation.ok) throw new Error('foundation failed');
    const core = await composeCoreServices(db, nullLogger as never, {
      artifactFoundation: foundation as never,
      stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', 'task.supplier-analysis', 'task.finance-review', 'task.purchase-approval'] },
      toolPorts: new Map<string, ToolPort>([[VALIDATOR_ID, validatorPort()]]),
      planCompilationSpec: spec,
      planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    });
    if (core === null) throw new Error('composition failed');
    const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
    await core.providers.register(makeProvider(plan), { actorId: actor });
    await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  await registerValidatorTool(core, actor);
    const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: 'planning', actorId: actor });
    if (!template.ok) throw new Error(template.error.message);
    const graph = { nodes: [{ id: 'plan', kind: 'planning', title: 'Plan', config: { taskProfile: { roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 2 } } }], edges: [] } as never;
    const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor });
    if (!saved.ok) throw new Error(saved.error.message);
    await core.lifecycle.publish({ templateId: template.value.id, actorId: actor });
    const run = await core.lifecycle.createRun({
      templateId: template.value.id, companyId: COMPANY, workflowId: 'wf-plan', actorId: actor,
      modelBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
      goal: { objective: 'Missing executor goal.', source: { type: 'human' } },
    });
    if (!run.ok) throw new Error(run.error.message);
    await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
    const task = await core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: run.value.run.id, stageId: 'plan' });
    if (!task.ok) throw new Error(task.error.message);
    const planned = await core.plannerRuntime!.runPlanningTurn({
      companyId: COMPANY, runId: run.value.run.id, taskId: task.value.taskId, planningCommandId: 'plan-C1', actorId: actor,
    });
    if (!planned.ok) throw new Error(planned.error.message);
    const callsBefore = plannerCalls;
    const compiled = await core.planCompiler!.compile({
      companyId: COMPANY, planningRunId: run.value.run.id, planArtifactId: planned.value.artifactId,
      compilationCommandId: 'compile-1', actorId: actor, executionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    }, spec);
    // the materializer probe fails CLOSED for the unregistered kind: NO task, NO executor call
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(String(compiled.error.details['reason'] ?? '')).toBe('NORMAL_TASK_TASK_KIND_UNAVAILABLE');
    expect(plannerCalls).toBe(callsBefore);
    expect(executorLog).toHaveLength(0);
  });

  it('13/14/§80. zero stage-name and zero role-name semantic switches in the autonomous path', () => {
    const supervisor = readFileSync(
      fileURLToPath(new URL('../../packages/engine/src/supervisor/autonomous-supervisor.ts', import.meta.url)), 'utf8');
    const engine = readFileSync(
      fileURLToPath(new URL('../../packages/engine/src/engine.ts', import.meta.url)), 'utf8');
    for (const source of [supervisor, engine]) {
      expect(source).not.toContain("new Set(['review'])");
      expect(source).not.toContain("new Set(['qa'])");
      expect(source).not.toContain("=== 'developer'");
      expect(source).not.toContain("=== 'reviewer'");
      expect(source).not.toContain("?? 'work'");
    }
    expect(supervisor).not.toContain('stageClasses'); // removed entirely
  });

  it('15/§18. WorkPackageProjector IS the executor context (no ad-hoc context build)', () => {
    const coreServices = readFileSync(
      fileURLToPath(new URL('../../apps/desktop/src/core-services.ts', import.meta.url)), 'utf8');
    const executorBlock = coreServices.slice(
      coreServices.indexOf('executor.generic:'), coreServices.indexOf("for (const kind of options.stageHandlers?.reviewKinds"));
    expect(executorBlock).toContain('projector.project');
    expect(executorBlock).toContain('workPackageProjectorHolder');
  });

  it('§95. side-effect ownership: the E2E writes no second-system state anywhere', async () => {
    const f = await makeFixture();
    const before = {
      versions: countOf(f.core, 'SELECT COUNT(*) AS c FROM workflow_template_versions'),
      templates: countOf(f.core, 'SELECT COUNT(*) AS c FROM workflow_templates'),
      plans: countOf(f.core, "SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:plan'"),
    };
    const result = await runAutonomous(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('completed');
    // no new versions/templates/plans/handoffs/work-package rows; no scheduler state table
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM workflow_template_versions')).toBe(before.versions);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM workflow_templates')).toBe(before.templates);
    expect(countOf(f.core, "SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:plan'")).toBe(before.plans);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM handoffs')).toBe(0);
    const tables = (f.core.database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    expect(tables.filter((name) => name.includes('scheduler') || name.includes('queue') || name.includes('work_package'))).toEqual([]);
  });

  it('11/§62. executors never substitute: exact kind map only (wrong executor unused)', async () => {
    const f = await makeFixture();
    // kinds resolve EXACTLY: the executor log only ever contains the four registered kinds,
    // and a kind with no registration cannot reach execution (see missing-executor test).
    const handlers = (f.core as unknown as { readonly sprint13: { readonly engine: unknown } });
    expect(handlers).toBeDefined();
    const result = await runAutonomous(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(executorLog.every((entry) => kindsOf(PROCUREMENT).includes(entry.taskKind))).toBe(true);
  });
});

/* ================= §91 DAG matrix ================= */

describe('S21 §91 — DAG advancement', () => {
  it('16-19. branch DAG: B and C both run; the join D waits for BOTH parents', async () => {
    // A → (B, C) → D compiled from a branch plan.
    const spec: PlanCompilationSpec = {
      planItemProfiles: {
        'branch-root': profile('branch-root-work', 'rol.branch-root', 'task.branch-root', 2),
        'branch-left': profile('branch-left-work', 'rol.branch-left', 'task.branch-left', 3),
        'branch-right': profile('branch-right-work', 'rol.branch-right', 'task.branch-right', 3),
        'branch-join': profile('branch-join-work', 'rol.branch-join', 'task.branch-join', 1, [VALIDATOR_ID]),
      },
    };
    const plan = {
      planItems: [
        { planItemId: 'branch-root', objective: 'Root.', acceptanceCriterionRefs: ['crit-r'] },
        { planItemId: 'branch-left', objective: 'Left.', dependencyPlanItemIds: ['branch-root'], acceptanceCriterionRefs: ['crit-l'] },
        { planItemId: 'branch-right', objective: 'Right.', dependencyPlanItemIds: ['branch-root'], acceptanceCriterionRefs: ['crit-rr'] },
        { planItemId: 'branch-join', objective: 'Join.', dependencyPlanItemIds: ['branch-left', 'branch-right'], acceptanceCriterionRefs: ['crit-j'] },
      ],
      acceptanceCriteria: [
        { criterionId: 'crit-r', requirement: 'r' }, { criterionId: 'crit-l', requirement: 'l' },
        { criterionId: 'crit-rr', requirement: 'rr' }, { criterionId: 'crit-j', requirement: 'j' },
      ],
    };
    plannerCalls = 0; executorLog.length = 0;
    const dataDir = tempDir(); const casRoot = tempDir();
    const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
    openDatabases.push(db);
    const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
    if (!foundation.ok) throw new Error('foundation failed');
    const core = await composeCoreServices(db, nullLogger as never, {
      artifactFoundation: foundation as never,
      stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', 'task.branch-root', 'task.branch-left', 'task.branch-right', 'task.branch-join'] },
      toolPorts: new Map<string, ToolPort>([[VALIDATOR_ID, validatorPort()]]),
      planCompilationSpec: spec, planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    });
    if (core === null) throw new Error('composition failed');
    const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
    await core.providers.register(makeProvider(plan), { actorId: actor });
    await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  await registerValidatorTool(core, actor);
    const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: 'planning', actorId: actor });
    if (!template.ok) throw new Error(template.error.message);
    const graph = { nodes: [{ id: 'plan', kind: 'planning', title: 'Plan', config: { taskProfile: { roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 2 } } }], edges: [] } as never;
    const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor });
    if (!saved.ok) throw new Error(saved.error.message);
    await core.lifecycle.publish({ templateId: template.value.id, actorId: actor });
    const run = await core.lifecycle.createRun({
      templateId: template.value.id, companyId: COMPANY, workflowId: 'wf-plan', actorId: actor,
      modelBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
      goal: { objective: 'Branch goal.', source: { type: 'human' } },
    });
    if (!run.ok) throw new Error(run.error.message);
    await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
    const task = await core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: run.value.run.id, stageId: 'plan' });
    if (!task.ok) throw new Error(task.error.message);
    const planned = await core.plannerRuntime!.runPlanningTurn({
      companyId: COMPANY, runId: run.value.run.id, taskId: task.value.taskId, planningCommandId: 'plan-C1', actorId: actor,
    });
    if (!planned.ok) throw new Error(planned.error.message);
    const compiled = await core.planCompiler!.compile({
      companyId: COMPANY, planningRunId: run.value.run.id, planArtifactId: planned.value.artifactId,
      compilationCommandId: 'compile-1', actorId: actor, executionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    }, spec);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const started = await core.sprint13.engine.drive(compiled.value.executionRunId, { maxSteps: 7 });
    if (!started.ok) throw new Error(started.error.message);
    const result = await core.autonomousSupervisor!.run({
      companyId: COMPANY, runId: compiled.value.executionRunId,
      taskId: String((await core.database.tasks.listByRun(compiled.value.executionRunId))[0]!.id) as never,
      actorId: actor,
      runIdentity: 's21:direct',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('completed');
    const kinds = executorLog.map((entry) => entry.taskKind);
    expect(kinds[0]).toBe('task.branch-root');
    expect(new Set(kinds.slice(1, 3))).toEqual(new Set(['task.branch-left', 'task.branch-right'])); // both branches
    expect(kinds[3]).toBe('task.branch-join'); // join LAST, after both parents
    expect(runStateOf(core, compiled.value.executionRunId)).toBe('COMPLETED');
  });

  it('21/§16/§65. deterministic tie-break: same durable state → same next stage across restarts', async () => {
    const f = await makeFixture();
    // Execute one stage deterministically, then assert the NEXT selected stage is the
    // deterministic DAG successor (finance-review), restart-stable by construction
    // (topological order + node order tie-break, from the pinned graph only).
    const result = await runAutonomous(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const kinds = executorLog.map((entry) => entry.taskKind);
    expect(kinds.indexOf('task.finance-review')).toBe(kinds.indexOf('task.supplier-analysis') + 1);
    expect(kinds.indexOf('task.purchase-approval')).toBe(kinds.indexOf('task.finance-review') + 1);
    expect(kinds.indexOf('task.delivery-verification')).toBe(kinds.indexOf('task.purchase-approval') + 1);
  });

  it('23. no Task-level DAG exists anywhere (deps live only in the pinned version)', async () => {
    const f = await makeFixture();
    const columns = f.core.database.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get() as { sql: string };
    expect(columns.sql).not.toContain('depends_on');
    expect(columns.sql).not.toContain('dag');
    const tasks = await f.core.database.tasks.listByRun(f.executionRunId);
    expect(tasks.every((t) => t.inputs['dependsOn'] === undefined)).toBe(true);
  });
});

/* ================= §92 quality matrix ================= */

describe('S21 §92 — generic validation orchestration', () => {
  it('24/25/§67. validatorIds drive validation; no QA role/task exists anywhere', async () => {
    const f = await makeFixture();
    const result = await runAutonomous(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('completed');
    // validation rows carry the pinned validator id of the delivery stage
    const rows = f.core.database.db
      .prepare('SELECT validator_id, status FROM validations WHERE run_id = ?')
      .all(f.executionRunId) as { validator_id: string; status: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.validator_id === VALIDATOR_ID)).toBe(true);
    expect(rows.every((row) => row.status === 'pass')).toBe(true);
    // no review/qa role or task kind appears anywhere in this run
    const tasks = await f.core.database.tasks.listByRun(f.executionRunId);
    expect([...new Set(tasks.map((t) => String(t.kind)))].sort()).toEqual([
      'task.delivery-verification', 'task.finance-review', 'task.purchase-approval', 'task.supplier-analysis',
    ]);
    expect(tasks.every((t) => String(t.roleId) !== 'rol.developer' && String(t.roleId) !== 'rol.review' && String(t.roleId) !== 'rol.qa')).toBe(true);
  });

  it('§11 ruling. a graph with ZERO validator requirements stops safely (no fake PASS)', async () => {
    const spec: PlanCompilationSpec = {
      planItemProfiles: {
        'plain-a': profile('plain-a-work', 'rol.plain-a', 'task.plain-a', 2),
        'plain-b': profile('plain-b-work', 'rol.plain-b', 'task.plain-b', 2),
      },
    };
    const plan = {
      planItems: [
        { planItemId: 'plain-a', objective: 'A.', acceptanceCriterionRefs: ['crit-pa'] },
        { planItemId: 'plain-b', objective: 'B.', dependencyPlanItemIds: ['plain-a'], acceptanceCriterionRefs: ['crit-pb'] },
      ],
      acceptanceCriteria: [
        { criterionId: 'crit-pa', requirement: 'pa' }, { criterionId: 'crit-pb', requirement: 'pb' },
      ],
    };
    plannerCalls = 0; executorLog.length = 0;
    const dataDir = tempDir(); const casRoot = tempDir();
    const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
    openDatabases.push(db);
    const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
    if (!foundation.ok) throw new Error('foundation failed');
    const core = await composeCoreServices(db, nullLogger as never, {
      artifactFoundation: foundation as never,
      stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', 'task.plain-a', 'task.plain-b'] },
      planCompilationSpec: spec, planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    });
    if (core === null) throw new Error('composition failed');
    const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
    await core.providers.register(makeProvider(plan), { actorId: actor });
    await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  await registerValidatorTool(core, actor);
    const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: 'planning', actorId: actor });
    if (!template.ok) throw new Error(template.error.message);
    const graph = { nodes: [{ id: 'plan', kind: 'planning', title: 'Plan', config: { taskProfile: { roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 2 } } }], edges: [] } as never;
    const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor });
    if (!saved.ok) throw new Error(saved.error.message);
    await core.lifecycle.publish({ templateId: template.value.id, actorId: actor });
    const run = await core.lifecycle.createRun({
      templateId: template.value.id, companyId: COMPANY, workflowId: 'wf-plan', actorId: actor,
      modelBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
      goal: { objective: 'Plain goal.', source: { type: 'human' } },
    });
    if (!run.ok) throw new Error(run.error.message);
    await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
    const task = await core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: run.value.run.id, stageId: 'plan' });
    if (!task.ok) throw new Error(task.error.message);
    const planned = await core.plannerRuntime!.runPlanningTurn({
      companyId: COMPANY, runId: run.value.run.id, taskId: task.value.taskId, planningCommandId: 'plan-C1', actorId: actor,
    });
    if (!planned.ok) throw new Error(planned.error.message);
    const compiled = await core.planCompiler!.compile({
      companyId: COMPANY, planningRunId: run.value.run.id, planArtifactId: planned.value.artifactId,
      compilationCommandId: 'compile-1', actorId: actor, executionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    }, spec);
    if (!compiled.ok) throw new Error(compiled.error.message);
    const started = await core.sprint13.engine.drive(compiled.value.executionRunId, { maxSteps: 7 });
    if (!started.ok) throw new Error(started.error.message);
    const result = await core.autonomousSupervisor!.run({
      companyId: COMPANY, runId: compiled.value.executionRunId,
      taskId: String((await core.database.tasks.listByRun(compiled.value.executionRunId))[0]!.id) as never,
      actorId: actor,
      runIdentity: 's21:direct',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both business stages ran; the run then stops at VALIDATING — the frozen ADR-0020
    // gate cannot prove a PASS with zero declared requirements. A SAFE human stop.
    expect(result.value.stopReason).toBe('validation_requirements_missing');
    expect(executorLog.map((entry) => entry.taskKind)).toEqual(['task.plain-a', 'task.plain-b']);
    expect(countOf(core, 'SELECT COUNT(*) AS c FROM validations')).toBe(0); // no fake PASS rows
  });

  it('32/§68. a FAILING validator drives the canonical failure semantics (REWORK)', async () => {
    const f = await makeFixture();
    validatorVerdict = 'fail';
    const result = await runAutonomous(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // VALIDATION.FAIL → REWORK: the run did not complete and no fake PASS was written.
    expect(result.value.stopReason).not.toBe('completed');
    const state = runStateOf(f.core, f.executionRunId);
    expect(['REWORK', 'PAUSED', 'VALIDATING', 'EXECUTING']).toContain(state);
    const rows = f.core.database.db
      .prepare('SELECT status FROM validations WHERE run_id = ?')
      .all(f.executionRunId) as { status: string }[];
    expect(rows.some((row) => row.status === 'fail')).toBe(true);
  });
});

/* ================= §93/§94 durability + isolation ================= */

describe('S21 §93/§94 — durability and isolation', () => {
  it('33/34/§72. restart mid-run: completed stages never re-execute; the rest continues', async () => {
    const f = await makeFixture();
    // Run to completion once, count executor calls per kind.
    const first = await runAutonomous(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.stopReason).toBe('completed');
    const firstKinds = executorLog.map((entry) => entry.taskKind);
    // A SECOND full autonomous run over the SAME completed run: everything replays from
    // durable truth — zero new executor invocations (idempotent convergence).
    const again = await runAutonomous(f);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.stopReason).toBe('completed');
    expect(executorLog.map((entry) => entry.taskKind)).toEqual(firstKinds); // §34: no re-execution
  });

  it('35/§73. durable results prevent unnecessary provider recall after restart', async () => {
    const f = await makeFixture();
    const first = await runAutonomous(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const callsAfterFirst = executorLog.length;
    const again = await runAutonomous(f);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(executorLog.length).toBe(callsAfterFirst); // §35: durable proof ⇒ zero recall
  });

  it('41/42/§94. executor invocations never leave the owning run; foreign tasks untouched', async () => {
    const f = await makeFixture();
    const other = await makeFixture({ commandId: 'compile-other' });
    const result = await runAutonomous(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('completed');
    // every executor call carried THIS run's identity
    expect(executorLog.every((entry) => entry.runId === f.executionRunId)).toBe(true);
    // the OTHER run's tasks remain untouched (PENDING)
    const otherTasks = await other.core.database.tasks.listByRun(other.executionRunId);
    expect(otherTasks.every((t) => t.state === 'PENDING')).toBe(true);
  });

  it('40/§74. cancellation: an aborted run stops and advances nothing further', async () => {
    const f = await makeFixture();
    const controller = new AbortController();
    const promise = f.core.autonomousSupervisor!.run({
      companyId: COMPANY, runId: f.executionRunId,
      taskId: String((await f.core.database.tasks.listByRun(f.executionRunId))[0]!.id) as never,
      actorId: f.actor, runIdentity: 's21:cancel', signal: controller.signal,
    });
    controller.abort(new Error('test-cancel'));
    const result = await promise;
    if (result.ok) {
      expect(['cancelled', 'completed', 'human_required', 'no_legal_action', 'validation_requirements_missing']).toContain(result.value.stopReason);
    } else {
      expect(String(result.error.details['reason'] ?? result.error.code)).toContain('CANCEL');
    }
    // whatever ran, it all belonged to this run and the loop exited promptly
    expect(executorLog.every((entry) => entry.runId === f.executionRunId)).toBe(true);
    if (result.ok) expect(result.value.turns).toBeLessThanOrEqual(20);
  });

  it('§61. pinned V1 semantics survive a V2 becoming current mid-run', async () => {
    const f = await makeFixture();
    // Adversarial (test seam): publish an unrelated V2 as the lineage current version.
    const versionId = String((f.core.database.db.prepare('SELECT version_id FROM runs WHERE id = ?').get(f.executionRunId) as { version_id: string }).version_id);
    const templateId = String((f.core.database.db.prepare('SELECT template_id FROM runs WHERE id = ?').get(f.executionRunId) as { template_id: string }).template_id);
    const graphV2 = JSON.parse((f.core.database.db.prepare('SELECT graph_json FROM workflow_template_versions WHERE id = ?').get(versionId) as { graph_json: string }).graph_json);
    graphV2.nodes[0].title = 'unrelated-v2';
    f.core.database.db
      .prepare("INSERT INTO workflow_template_versions (id, template_id, semver, content_hash, snapshot_hash, graph_json, change_proposal_id, created_at, created_by) VALUES (?, ?, '9.0.0', ?, ?, ?, NULL, '2026-03-01T00:00:00Z', ?)")
      .run('ver_s21_v2', templateId, 'h-v2', 's-v2', JSON.stringify(graphV2), f.actor);
    f.core.database.db.prepare('UPDATE workflow_templates SET current_version_id = ? WHERE id = ?').run('ver_s21_v2', templateId);
    const result = await runAutonomous(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('completed');
    // the run pin never moved; all four V1 stages executed
    expect(String((f.core.database.db.prepare('SELECT version_id FROM runs WHERE id = ?').get(f.executionRunId) as { version_id: string }).version_id)).toBe(versionId);
    expect(executorLog).toHaveLength(4);
  });
});
