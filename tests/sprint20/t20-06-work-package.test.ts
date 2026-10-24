/**
 * Task-20-06 — Structured Handoff + Generic Work Package Projection (§63-§69: the 44
 * required points + the side-effect assertion), ALL against the REAL production
 * composition: real planning→compile chain from T20-05, real pinned versions, real
 * tasks/stage-output envelopes, real Sprint-11 HandoffService, real durable stores,
 * real restart.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyTaskEvent,
  createTask,
  ok,
  type DomainError,
  type ModelProviderPort,
  type Result,
  type Task,
} from '@companyos/core';
import { compiledNodeId, compiledTemplateId, type PlanCompilationSpec, type PlanItemCompilationProfile } from '@companyos/engine';
import { createHandoffService } from '../../packages/engine/src/handoff/handoff-service.js';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const CHAINS = [
  'core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff',
] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'e2e7.planner';
const STAGE_OUTPUT_SCHEMA = 'companyos/stage-output/1';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const profile = (
  stageKind: string,
  roleId: string,
  taskKind: string,
  maxAttempts: number,
  validatorIds: readonly string[] = [],
): PlanItemCompilationProfile => ({ stageKind, taskProfile: { roleId, taskKind, maxAttempts }, validatorIds });

const PROCUREMENT_SPEC: PlanCompilationSpec = {
  planItemProfiles: {
    'supplier-analysis': profile('procurement-analysis-work', 'rol.procurement-analyst', 'task.procurement-analysis', 2, ['e2e7.unit_validator']),
    'financial-review': profile('procurement-review-work', 'rol.procurement-reviewer', 'task.procurement-review', 4, ['e2e7.unit_validator', 'e2e7.audit_validator']),
    approval: profile('procurement-approval-work', 'rol.procurement-approver', 'task.procurement-approval', 1),
    recommendation: profile('procurement-report-work', 'rol.procurement-analyst', 'task.procurement-recommendation', 3),
  },
};
const softwareItemProfile = profile('work', 'rol.developer', 'e2e7:build', 3);
const SOFTWARE_SPEC: PlanCompilationSpec = {
  planItemProfiles: {
    'supplier-analysis': softwareItemProfile,
    'financial-review': softwareItemProfile,
    approval: softwareItemProfile,
    recommendation: softwareItemProfile,
  },
};

const PLAN_ITEMS = [
  { planItemId: 'supplier-analysis', objective: 'Analyze the three suppliers.', acceptanceCriterionRefs: ['crit-analysis'] },
  { planItemId: 'financial-review', objective: 'Perform the financial review.', dependencyPlanItemIds: ['supplier-analysis'], acceptanceCriterionRefs: ['crit-review', 'crit-analysis'] },
  { planItemId: 'approval', objective: 'Obtain the procurement approval.', dependencyPlanItemIds: ['supplier-analysis'], acceptanceCriterionRefs: ['crit-approval'] },
  { planItemId: 'recommendation', objective: 'Produce the recommendation.', dependencyPlanItemIds: ['financial-review', 'approval'], acceptanceCriterionRefs: ['crit-analysis'] },
];
const PLAN_CRITERIA = [
  { criterionId: 'crit-analysis', requirement: 'All three suppliers have a recorded analysis.' },
  { criterionId: 'crit-review', requirement: 'The financial review report exists and is complete.' },
  { criterionId: 'crit-approval', requirement: 'The approval decision is recorded.' },
];

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t20w-'));
  createdDirs.push(dir);
  return dir;
};

let providerCalls = 0;
const routingProvider = (): ModelProviderPort => ({
  describe: () => ({ providerId: 'prov_e2e7', kind: 'fake', displayName: 'r', version: '1' }),
  listModels: () => Promise.resolve(ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }])),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    providerCalls += 1;
    return Promise.resolve(
      ok({
        modelId: request.modelId, providerId: 'prov_e2e7', outputText: 'plan',
        structured: { schema: 'companyos/plan-proposal/1', planItems: PLAN_ITEMS, acceptanceCriteria: PLAN_CRITERIA } as never,
        toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalCost: null }, finishReason: 'stop' as const,
      }),
    );
  },
  stream(): AsyncIterable<Result<never, DomainError>> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
  },
});

interface Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly planningRunId: string;
  readonly planId: string;
  readonly executionRunId: string;
  readonly tasksByItem: Readonly<Record<string, Task>>;
  readonly versionId: string;
  readonly templateId: string;
}

const makeFixture = async (spec: PlanCompilationSpec = PROCUREMENT_SPEC, commandId = 'compile-1'): Promise<Fixture> => {
  providerCalls = 0;
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: ['companyos:planning', 'task.procurement-analysis', 'task.procurement-review', 'task.procurement-approval', 'task.procurement-recommendation', 'task.logistics-routing', 'task.logistics-audit', 'task.logistics-approval', 'task.logistics-report', 'e2e7:build'] },
    planCompilationSpec: PROCUREMENT_SPEC,
    planExecutionBindings: { planner: MODEL_KEY },
  });
  if (core === null) throw new Error('composition failed');
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(routingProvider(), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
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
    modelBindings: { planner: MODEL_KEY },
    goal: { objective: 'Evaluate three suppliers, perform financial review, obtain approval, and produce a procurement recommendation.', source: { type: 'human' } },
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
    compilationCommandId: commandId, actorId: actor, executionBindings: { planner: MODEL_KEY },
  }, spec);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const tasks = await core.database.tasks.listByRun(compiled.value.executionRunId);
  const byItem: Record<string, Task> = {};
  for (const item of PLAN_ITEMS) {
    const stageId = compiledNodeId(compiled.value.planId, item.planItemId);
    const found = tasks.find((row) => String(row.stageId) === stageId);
    if (found === undefined) throw new Error(`task for ${String(item.planItemId)} missing`);
    byItem[item.planItemId] = found;
  }
  return {
    core, actor, dataDir, casRoot,
    planningRunId: run.value.run.id,
    planId: compiled.value.planId,
    executionRunId: compiled.value.executionRunId,
    tasksByItem: byItem,
    versionId: compiled.value.versionId,
    templateId: compiled.value.templateId,
  };
};

const project = (f: Fixture, taskId: string, companyId = COMPANY) =>
  f.core.workPackageProjector!.project({ companyId, runId: f.executionRunId, taskId });

const reasonOf = (error: { readonly details: Readonly<Record<string, unknown>> }): string =>
  String(error.details['reason'] ?? '');

/** Complete a task through the REAL task machine with a durable stage-output envelope. */
const completeWithOutput = async (
  f: Fixture,
  task: Task,
  options?: { readonly artifactRefs?: readonly string[]; readonly kind?: string },
): Promise<Task> => {
  const envelope = {
    schemaVersion: STAGE_OUTPUT_SCHEMA,
    kind: options?.kind ?? 'task.procurement-analysis',
    executionId: null,
    artifactRefs: [...(options?.artifactRefs ?? [])],
    validationRefs: [] as string[],
    payload: { result: `done:${String(task.id)}` },
  };
  let current = task;
  for (const [event, outputs] of [
    ['PLAN', {}],
    ['START', {}],
    ['COMPLETE', { stageOutput: envelope }],
  ] as const) {
    const next = applyTaskEvent(current, event, '2026-09-29T00:00:00Z', outputs);
    if (!next.ok) throw new Error(next.error.message);
    current = next.value;
  }
  await f.core.database.tasks.put(current);
  return current;
};

/** A run-owned artifact to reference from a stage-output envelope (references, not copies). */
const makeArtifact = async (f: Fixture, commandId: string): Promise<string> => {
  const created = await f.core.sprint13.artifactService.create({
    commandId, runId: f.executionRunId as never, taskId: null, kind: 'companyos:work-result',
    content: new TextEncoder().encode(JSON.stringify({ result: commandId })), producedBy: f.actor, traceId: `trace_${String(commandId)}`,
  });
  if (!created.ok) throw new Error(created.error.message);
  return String(created.value.id);
};

/** A corrective task on the SAME stage, with the canonical lineage inputs. */
const correctiveTask = async (
  f: Fixture,
  parent: Task,
  round: number,
  name: string,
  createdAt: string,
): Promise<Task> => {
  const created = createTask({
    runId: parent.runId,
    stageId: parent.stageId,
    roleId: parent.roleId,
    kind: parent.kind,
    maxAttempts: Number(parent.maxAttempts),
    inputs: { corrective: { parentTaskId: String(parent.id), round, origin: 'review' } },
    now: createdAt,
    ids: { ulid: () => 'U', id: (prefix: string) => `${String(prefix)}_${String(name)}` },
  });
  if (!created.ok) throw new Error(created.error.message);
  const written = await f.core.database.tasks.putGuarded(created.value);
  if (!written.ok) throw new Error(written.error.message);
  return created.value;
};

const noAudit = {
  created: async () => {}, ready: async () => {}, accepted: async () => {},
  rejected: async () => {}, superseded: async () => {}, cancelled: async () => {},
};
const handoffServiceOf = (f: Fixture) =>
  createHandoffService({
    store: f.core.database.handoffStore!,
    audit: noAudit,
    clock: { nowIso: () => '2026-09-29T00:00:00Z', now: () => 0 },
    authorize: async () => ok(true),
    actorRoleIds: async () => ['rol.procurement-reviewer'],
  });

const handoffInput = (f: Fixture, taskId: string, handoffId: string) => ({
  handoffId,
  companyId: COMPANY,
  workflowId: compiledTemplateId(COMPANY, f.planId, 'compile-1'),
  workflowVersionId: f.versionId,
  workflowRunId: f.executionRunId,
  stageId: String(f.tasksByItem['financial-review']!.stageId),
  taskId,
  fromAgentId: 'agent.upstream',
  fromRoleId: 'rol.procurement-analyst',
  toRoleId: 'rol.procurement-reviewer',
  objective: 'Hand over the completed supplier analysis.',
  summary: 'The analysis of the three suppliers is complete and referenced.',
  recommendedNextAction: 'Perform the financial review.',
  traceId: 'trace_t2006',
});

const countOf = (core: Core, sql: string, ...params: readonly (string | number | null)[]): number =>
  Number((core.database.db.prepare(sql).get(...(params as never[])) as { c: number }).c);

const durableCounts = (core: Core): Readonly<Record<string, number>> => ({
  runs: countOf(core, 'SELECT COUNT(*) AS c FROM runs'),
  tasks: countOf(core, 'SELECT COUNT(*) AS c FROM tasks'),
  artifacts: countOf(core, 'SELECT COUNT(*) AS c FROM artifacts'),
  executions: countOf(core, 'SELECT COUNT(*) AS c FROM agent_executions'),
  decisions: countOf(core, 'SELECT COUNT(*) AS c FROM decisions'),
  validations: countOf(core, 'SELECT COUNT(*) AS c FROM validations'),
  handoffs: countOf(core, 'SELECT COUNT(*) AS c FROM handoffs'),
  versions: countOf(core, 'SELECT COUNT(*) AS c FROM workflow_template_versions'),
  templates: countOf(core, 'SELECT COUNT(*) AS c FROM workflow_templates'),
  sessions: countOf(core, "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'") === 1
    ? countOf(core, 'SELECT COUNT(*) AS c FROM agent_sessions')
    : 0,
});

const reopen = async (f: Fixture): Promise<Core> => {
  f.core.database.close();
  const tracked = openDatabases.indexOf(f.core.database);
  if (tracked >= 0) openDatabases.splice(tracked, 1);
  const db2 = openDurableDatabase({ dataDir: f.dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db2);
  const foundation2 = await openArtifactFoundation({ casRoot: f.casRoot, database: db2, logger: nullLogger as never });
  if (!foundation2.ok) throw new Error('foundation2 failed');
  const core2 = await composeCoreServices(db2, nullLogger as never, {
    artifactFoundation: foundation2 as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: ['companyos:planning', 'task.procurement-analysis', 'task.procurement-review', 'task.procurement-approval', 'task.procurement-recommendation', 'task.logistics-routing', 'task.logistics-audit', 'task.logistics-approval', 'task.logistics-report', 'e2e7:build'] },
    planCompilationSpec: PROCUREMENT_SPEC,
    planExecutionBindings: { planner: MODEL_KEY },
  });
  if (core2 === null) throw new Error('composition2 failed');
  const provider = await core2.providers.register(routingProvider(), { actorId: f.actor });
  if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
  return core2;
};

/* --------------------------- §63 core projection (points 1-12) --------------------------- */

describe('T20-06 §63 — core projection', () => {
  it('1/5/6/7/8/9/10. valid Task → canonical Work Package from pinned truth only', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const pkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(pkg.ok).toBe(true); // 1
    if (!pkg.ok) return;
    expect(pkg.value.identity.workflowVersionId).toBe(f.versionId); // 5: exact pinned version
    expect(pkg.value.identity.runId).toBe(f.executionRunId);
    expect(pkg.value.identity.taskId).toBe(String(f.tasksByItem['financial-review']!.id));
    expect(pkg.value.work.objective).toBe('Perform the financial review.'); // 6: byte-exact
    expect(pkg.value.execution).toEqual({ // 7: pinned profile
      roleId: 'rol.procurement-reviewer', taskKind: 'task.procurement-review', maxAttempts: 4,
      professionalResponsibility: null,
    });
    expect(pkg.value.acceptance.criteria).toEqual([ // 8: exact frozen criteria
      { criterionId: 'crit-review', requirement: 'The financial review report exists and is complete.' },
      { criterionId: 'crit-analysis', requirement: 'All three suppliers have a recorded analysis.' },
    ]);
    expect(pkg.value.acceptance.validatorRefs).toEqual(['e2e7.unit_validator', 'e2e7.audit_validator']); // 9
    expect(pkg.value.work.taskInputs).toEqual({}); // 10: canonical immutable inputs
    expect(pkg.value.goal.objective).toBe('Evaluate three suppliers, perform financial review, obtain approval, and produce a procurement recommendation.');
    expect(pkg.value.goal.sourceRef).toBe(`plan:${String(f.planId)}`); // run-owned goal, plan = provenance only
    expect(pkg.value.contract).toBe('companyos/work-package/1');
  });

  it('2/3/4. ownership checked; foreign run/task rejected with no-leak NOT_FOUND', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    // 2: a task of another run (the planning run's planner task) is rejected.
    const foreignTask = await project(f, String((await f.core.database.tasks.listByRun(f.planningRunId))[0]!.id));
    expect(foreignTask.ok).toBe(false);
    if (!foreignTask.ok) expect(reasonOf(foreignTask.error)).toBe('WORK_PACKAGE_TASK_RUN_MISMATCH');
    // 3/4: a foreign company sees the SAME NOT_FOUND as a missing run — no existence oracle.
    const foreignCompany = await project(f, String(f.tasksByItem['financial-review']!.id), 'company_other');
    expect(foreignCompany.ok).toBe(false);
    if (!foreignCompany.ok) {
      expect(foreignCompany.error.code).toBe('NOT_FOUND');
      expect(reasonOf(foreignCompany.error)).toBe('WORK_PACKAGE_RUN_NOT_FOUND');
    }
    const missing = await f.core.workPackageProjector!.project({ companyId: COMPANY, runId: 'run_missing', taskId: 'x' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('NOT_FOUND');
  });

  it('11/12/§69. projection is pure: zero provider calls, zero mutation anywhere', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const before = durableCounts(f.core);
    const taskBefore = await f.core.database.tasks.get(String(f.tasksByItem['financial-review']!.id) as never);
    providerCalls = 0;
    const pkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(providerCalls).toBe(0); // 11
    expect(durableCounts(f.core)).toEqual(before); // §69: runs/tasks/artifacts/executions/decisions/validations/handoffs/versions/templates/sessions
    const taskAfter = await f.core.database.tasks.get(String(f.tasksByItem['financial-review']!.id) as never);
    expect(JSON.stringify(taskAfter)).toBe(JSON.stringify(taskBefore)); // 12: no task mutation
    // 44: no durable WorkPackage object exists anywhere.
    const wpTable = f.core.database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%work%package%'")
      .get();
    expect(wpTable).toBeUndefined();
  });
});

/* --------------------------- §64 dependencies (points 13-20) --------------------------- */

describe('T20-06 §64 — dependency authority', () => {
  it('13. root task → empty dependency projection', async () => {
    const f = await makeFixture();
    const pkg = await project(f, String(f.tasksByItem['supplier-analysis']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.dependencies).toEqual([]);
  });

  it('14/21. one ready predecessor → canonical output reference included', async () => {
    const f = await makeFixture();
    const artifactId = await makeArtifact(f, 'result:supplier-analysis');
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!, { artifactRefs: [artifactId] });
    const pkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.dependencies).toHaveLength(1);
    const dep = pkg.value.dependencies[0]!;
    expect(dep.stageId).toBe(String(f.tasksByItem['supplier-analysis']!.stageId));
    expect(dep.subjectTaskId).toBe(String(f.tasksByItem['supplier-analysis']!.id)); // 21: baseline result
    expect(dep.artifactRefs).toEqual([artifactId]); // references, not copies
    expect(dep.resultKind).toBe('task.procurement-analysis');
  });

  it('15/16. multiple predecessors → exact DAG parents only; siblings excluded', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    await completeWithOutput(f, f.tasksByItem['financial-review']!, { kind: 'task.procurement-review' });
    await completeWithOutput(f, f.tasksByItem.approval!, { kind: 'task.procurement-approval' });
    const pkg = await project(f, String(f.tasksByItem.recommendation!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.dependencies).toHaveLength(2); // 15: B + C exactly, never A
    const stages = pkg.value.dependencies.map((dep) => dep.stageId).sort();
    expect(stages).toEqual([
      String(f.tasksByItem.approval!.stageId),
      String(f.tasksByItem['financial-review']!.stageId),
    ].sort());
    // 16: an unrelated sibling (approval for financial-review's package) is excluded there.
    const siblingPkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    if (!siblingPkg.ok) return;
    expect(siblingPkg.value.dependencies).toHaveLength(1);
    expect(siblingPkg.value.dependencies[0]!.stageId).toBe(String(f.tasksByItem['supplier-analysis']!.stageId));
  });

  it('17. incomplete predecessor → FAIL CLOSED WORK_PACKAGE_DEPENDENCY_NOT_READY', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    // approval still PENDING → recommendation cannot be projected.
    const pkg = await project(f, String(f.tasksByItem.recommendation!.id));
    expect(pkg.ok).toBe(false);
    if (!pkg.ok) expect(reasonOf(pkg.error)).toBe('WORK_PACKAGE_DEPENDENCY_NOT_READY');
    // a FAILED-only predecessor stage is equally not a successful result.
    const failed = applyTaskEvent(f.tasksByItem.approval!, 'PLAN', '2026-09-29T00:00:00Z');
    const started = failed.ok ? applyTaskEvent(failed.value, 'START', '2026-09-29T00:00:00Z') : failed;
    const failedEnd = started.ok ? applyTaskEvent(started.value, 'FAIL', '2026-09-29T00:00:00Z') : started;
    if (!failedEnd.ok) throw new Error(failedEnd.error.message);
    await f.core.database.tasks.put(failedEnd.value);
    const pkg2 = await project(f, String(f.tasksByItem.recommendation!.id));
    expect(pkg2.ok).toBe(false);
    if (!pkg2.ok) expect(reasonOf(pkg2.error)).toBe('WORK_PACKAGE_DEPENDENCY_NOT_READY');
  });

  it('18. foreign-run predecessor rows are never visible (run-scoped reads only)', async () => {
    const f = await makeFixture();
    const artifactId = await makeArtifact(f, 'result:foreign-decoy');
    // A DONE task with the SAME stage id, but owned by the PLANNING run (another run).
    const decoy = createTask({
      runId: f.planningRunId as never,
      stageId: f.tasksByItem['supplier-analysis']!.stageId,
      roleId: 'rol.planner' as never, kind: 'companyos:planning', maxAttempts: 1,
      inputs: {}, now: '2026-09-28T00:00:00Z', ids: { ulid: () => 'U', id: (p: string) => `${String(p)}_decoy` },
    });
    if (!decoy.ok) throw new Error(decoy.error.message);
    let current = decoy.value;
    for (const event of ['PLAN', 'START', 'COMPLETE'] as const) {
      const next = applyTaskEvent(current, event, '2026-09-28T00:00:00Z', event === 'COMPLETE' ? {
        stageOutput: { schemaVersion: STAGE_OUTPUT_SCHEMA, kind: 'decoy', executionId: null, artifactRefs: [artifactId], validationRefs: [], payload: null },
      } : {});
      if (!next.ok) throw new Error(next.error.message);
      current = next.value;
    }
    await f.core.database.tasks.put(current);
    // The real predecessor completes too; the projection must select THIS run's subject only.
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const pkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.dependencies[0]!.subjectTaskId).toBe(String(f.tasksByItem['supplier-analysis']!.id));
    expect(pkg.value.dependencies[0]!.artifactRefs).not.toContain(artifactId);
  });

  it('19/39/40/41. restart determinism: same semantic dependency projection', async () => {
    const f = await makeFixture();
    const artifactId = await makeArtifact(f, 'result:supplier-analysis');
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!, { artifactRefs: [artifactId] });
    const before = await project(f, String(f.tasksByItem['financial-review']!.id)); // 39
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const core2 = await reopen(f); // 40: real restart
    const after = await core2.workPackageProjector!.project({
      companyId: COMPANY, runId: f.executionRunId, taskId: String(f.tasksByItem['financial-review']!.id),
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(JSON.stringify(after.value)).toBe(JSON.stringify(before.value)); // 41: same semantics
  });

  it('20/§50. a later V2 current version never alters the V1-run projection', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const before = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    // Adversarial (test seam): an unrelated V2 becomes the lineage CURRENT version.
    const graphV2 = JSON.parse(
      (f.core.database.db.prepare('SELECT graph_json FROM workflow_template_versions WHERE id = ?').get(f.versionId) as { graph_json: string }).graph_json,
    );
    graphV2.nodes[0].title = 'unrelated-later-version';
    f.core.database.db
      .prepare("INSERT INTO workflow_template_versions (id, template_id, semver, content_hash, snapshot_hash, graph_json, change_proposal_id, created_at, created_by) VALUES (?, ?, '2.0.0', ?, ?, ?, NULL, '2026-02-01T00:00:00Z', ?)")
      .run('ver_wp_v2', f.templateId, 'hash_v2', 'snap_v2', JSON.stringify(graphV2), f.actor);
    f.core.database.db.prepare('UPDATE workflow_templates SET current_version_id = ? WHERE id = ?').run('ver_wp_v2', f.templateId);
    const after = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(JSON.stringify(after.value)).toBe(JSON.stringify(before.value)); // V1 semantics, V1 profile, V1 deps
  });
});

/* --------------------------- §65 corrective output (points 21-25) --------------------------- */

describe('T20-06 §65 — corrective output authority', () => {
  it('22/§53. a corrective task package carries its canonical lineage inputs', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const t1 = await correctiveTask(f, f.tasksByItem['supplier-analysis']!, 1, 'corr1', '2026-09-28T01:00:00Z');
    const pkg = await project(f, String(t1.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.work.taskInputs).toEqual({ corrective: { parentTaskId: String(f.tasksByItem['supplier-analysis']!.id), round: 1, origin: 'review' } });
    expect(pkg.value.observational.taskState).toBe('PENDING');
  });

  it('23. downstream consumes the repository-authoritative corrected result', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const t1 = await correctiveTask(f, f.tasksByItem['supplier-analysis']!, 1, 'corr1', '2026-09-28T01:00:00Z');
    const correctedArtifact = await makeArtifact(f, 'result:corrected');
    await completeWithOutput(f, t1, { artifactRefs: [correctedArtifact], kind: 'task.procurement-analysis' });
    const pkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.dependencies[0]!.subjectTaskId).toBe(String(t1.id)); // corrective child wins
    expect(pkg.value.dependencies[0]!.artifactRefs).toEqual([correctedArtifact]);
  });

  it('24. timestamp ordering cannot hijack: lineage round beats recency', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const t1 = await correctiveTask(f, f.tasksByItem['supplier-analysis']!, 1, 'corr1', '2026-09-28T01:00:00Z');
    await completeWithOutput(f, t1, { kind: 'task.procurement-analysis' });
    // T2 has round 2 but an EARLIER createdAt than T1 — round wins, not the clock.
    const t2 = await correctiveTask(f, f.tasksByItem['supplier-analysis']!, 2, 'corr2', '2026-09-27T00:00:00Z');
    await completeWithOutput(f, t2, { kind: 'task.procurement-analysis' });
    const pkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.dependencies[0]!.subjectTaskId).toBe(String(t2.id));
  });

  it('25. a broken corrective lineage (unknown parent) never wins the subject', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const t1 = await correctiveTask(f, f.tasksByItem['supplier-analysis']!, 1, 'corr1', '2026-09-28T01:00:00Z');
    await completeWithOutput(f, t1, { kind: 'task.procurement-analysis' });
    // A decoy whose parentTaskId points OUTSIDE the stage set: not a child, excluded from
    // the children pool; the canonical child T1 stays the subject.
    const decoy = createTask({
      runId: f.executionRunId as never,
      stageId: f.tasksByItem['supplier-analysis']!.stageId,
      roleId: 'rol.procurement-analyst' as never, kind: 'task.procurement-analysis', maxAttempts: 1,
      inputs: { corrective: { parentTaskId: 'tsk_unknown_parent', round: 9, origin: 'review' } },
      now: '2026-09-28T02:00:00Z', ids: { ulid: () => 'U', id: (p: string) => `${String(p)}_brokencorr` },
    });
    if (!decoy.ok) throw new Error(decoy.error.message);
    let current = decoy.value;
    for (const event of ['PLAN', 'START', 'COMPLETE'] as const) {
      const next = applyTaskEvent(current, event, '2026-09-28T02:00:00Z', {});
      if (!next.ok) throw new Error(next.error.message);
      current = next.value;
    }
    await f.core.database.tasks.put(current);
    const pkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.dependencies[0]!.subjectTaskId).toBe(String(t1.id));
  });

  it('43. the corrected predecessor output remains canonical after restart', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const t1 = await correctiveTask(f, f.tasksByItem['supplier-analysis']!, 1, 'corr1', '2026-09-28T01:00:00Z');
    await completeWithOutput(f, t1, { kind: 'task.procurement-analysis' });
    const core2 = await reopen(f);
    const pkg = await core2.workPackageProjector!.project({
      companyId: COMPANY, runId: f.executionRunId, taskId: String(f.tasksByItem['financial-review']!.id),
    });
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.dependencies[0]!.subjectTaskId).toBe(String(t1.id));
  });
});

/* --------------------------- §66 handoff integration (points 26-33) --------------------------- */

describe('T20-06 §66 — handoff integration (existing Sprint-11 owner)', () => {
  it('26/§35. autonomous task edge creates ZERO HandoffPackets', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const pkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.handoff).toEqual([]);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM handoffs')).toBe(0); // 26
  });

  it('27/28. explicit durable handoff through the EXISTING service projects accepted context', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const service = handoffServiceOf(f);
    const target = String(f.tasksByItem['financial-review']!.id);
    const draft = await service.createDraft({ ...handoffInput(f, target, 'hnd_t2006_1'), actorId: f.actor }); // 27
    if (!draft.ok) throw new Error(`handoff createDraft failed: ${String(draft.error.code)} ${String(draft.error.message)} ${JSON.stringify(draft.error.details)}`);
    const readied = await service.ready({ handoffId: 'hnd_t2006_1', version: 1, actorId: f.actor });
    if (!readied.ok) throw new Error(readied.error.message);
    const accepted = await service.accept({ handoffId: 'hnd_t2006_1', version: 1, actorId: f.actor });
    if (!accepted.ok) throw new Error(accepted.error.message);
    const pkg = await project(f, target);
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.handoff).toHaveLength(1); // 28
    expect(pkg.value.handoff[0]!.handoffId).toBe('hnd_t2006_1');
    expect(pkg.value.handoff[0]!.version).toBe(1);
    expect(String(pkg.value.handoff[0]!.view.objective)).toContain('supplier analysis');
    expect(String(pkg.value.handoff[0]!.view.recommendedNextAction)).toBe('Perform the financial review.');
  });

  it('29. a REJECTED handoff is never active context', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const service = handoffServiceOf(f);
    const target = String(f.tasksByItem['financial-review']!.id);
    await service.createDraft({ ...handoffInput(f, target, 'hnd_t2006_2'), actorId: f.actor });
    await service.ready({ handoffId: 'hnd_t2006_2', version: 1, actorId: f.actor });
    const rejected = await service.reject({
      handoffId: 'hnd_t2006_2', version: 1, actorId: f.actor,
      reasonCodes: ['INCOMPLETE_SUMMARY'], comment: 'references missing',
    });
    if (!rejected.ok) throw new Error(rejected.error.message);
    const pkg = await project(f, target);
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.handoff).toEqual([]);
  });

  it('30/§38. a SUPERSEDED handoff stops being active; the accepted successor projects', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const service = handoffServiceOf(f);
    const target = String(f.tasksByItem['financial-review']!.id);
    await service.createDraft({ ...handoffInput(f, target, 'hnd_t2006_3'), actorId: f.actor });
    await service.ready({ handoffId: 'hnd_t2006_3', version: 1, actorId: f.actor });
    await service.accept({ handoffId: 'hnd_t2006_3', version: 1, actorId: f.actor });
    // v2 legitimately supersedes v1 through the existing lifecycle.
    const superseded = await service.supersede({
      handoffId: 'hnd_t2006_3', previousVersion: 1, actorId: f.actor,
      next: { ...handoffInput(f, target, 'hnd_t2006_3'), summary: 'Refreshed handoff context v2.' },
    });
    if (!superseded.ok) throw new Error(superseded.error.message);
    const afterSupersede = await project(f, target);
    expect(afterSupersede.ok).toBe(true);
    if (!afterSupersede.ok) return;
    expect(afterSupersede.value.handoff).toEqual([]); // v1 superseded, v2 not accepted yet
    await service.ready({ handoffId: 'hnd_t2006_3', version: 2, actorId: f.actor });
    await service.accept({ handoffId: 'hnd_t2006_3', version: 2, actorId: f.actor });
    const afterAccept = await project(f, target);
    expect(afterAccept.ok).toBe(true);
    if (!afterAccept.ok) return;
    expect(afterAccept.value.handoff).toHaveLength(1);
    expect(afterAccept.value.handoff[0]!.version).toBe(2);
    expect(String(afterAccept.value.handoff[0]!.view.summary)).toContain('v2');
  });

  it('31/32. handoff scope is exact: other tasks / other companies never leak in', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const service = handoffServiceOf(f);
    // Accepted, but scoped to a DIFFERENT task of the same run.
    await service.createDraft({ ...handoffInput(f, String(f.tasksByItem.approval!.id), 'hnd_t2006_4'), actorId: f.actor });
    await service.ready({ handoffId: 'hnd_t2006_4', version: 1, actorId: f.actor });
    await service.accept({ handoffId: 'hnd_t2006_4', version: 1, actorId: f.actor });
    const pkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.handoff).toEqual([]); // 31: correct scope only
    // 32: a foreign company/run/task scope never matches either.
    const foreign = f.core.database.db
      .prepare("SELECT COUNT(*) AS c FROM handoffs WHERE company_id != ? OR workflow_run_id != ?").get(COMPANY, f.executionRunId) as { c: number };
    expect(Number(foreign.c)).toBe(0);
  });

  it('33/§61. handoff identity: same (handoffId, version) replay cannot duplicate', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const service = handoffServiceOf(f);
    const target = String(f.tasksByItem['financial-review']!.id);
    await service.createDraft({ ...handoffInput(f, target, 'hnd_t2006_5'), actorId: f.actor });
    const replay = await service.createDraft({ ...handoffInput(f, target, 'hnd_t2006_5'), actorId: f.actor });
    expect(replay.ok).toBe(false); // versions are immutable — PK arbitrated, no duplicate row
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM handoffs')).toBe(1);
  });

  it('42. an accepted handoff survives restart and still projects', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const service = handoffServiceOf(f);
    const target = String(f.tasksByItem['financial-review']!.id);
    await service.createDraft({ ...handoffInput(f, target, 'hnd_t2006_6'), actorId: f.actor });
    await service.ready({ handoffId: 'hnd_t2006_6', version: 1, actorId: f.actor });
    await service.accept({ handoffId: 'hnd_t2006_6', version: 1, actorId: f.actor });
    const core2 = await reopen(f);
    const pkg = await core2.workPackageProjector!.project({ companyId: COMPANY, runId: f.executionRunId, taskId: target });
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.handoff).toHaveLength(1);
    expect(pkg.value.handoff[0]!.handoffId).toBe('hnd_t2006_6');
  });
});

/* --------------------------- §67 genericity (points 34-38) --------------------------- */

describe('T20-06 §67 — genericity and industry neutrality', () => {
  it('34/35. heterogeneous procurement: three different profiles project correctly', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    for (const [item, roleId, taskKind, maxAttempts] of [
      ['financial-review', 'rol.procurement-reviewer', 'task.procurement-review', 4],
      ['approval', 'rol.procurement-approver', 'task.procurement-approval', 1],
      ['recommendation', 'rol.procurement-analyst', 'task.procurement-recommendation', 3],
    ] as const) {
      for (const dep of item === 'recommendation' ? ['financial-review', 'approval'] : ['supplier-analysis']) {
        await completeWithOutput(f, f.tasksByItem[dep]!, { kind: PROCUREMENT_SPEC.planItemProfiles[dep]!.taskProfile.taskKind });
      }
      const pkg = await project(f, String(f.tasksByItem[item]!.id));
      expect(pkg.ok).toBe(true);
      if (!pkg.ok) return;
      expect(pkg.value.execution).toEqual({ roleId, taskKind, maxAttempts, professionalResponsibility: null }); // 35
      expect(pkg.value.work.objective).toBe(PLAN_ITEMS.find((entry) => entry.planItemId === item)!.objective); // 34
    }
  });

  it('36. software workflow projects through the SAME projector', async () => {
    const f = await makeFixture(SOFTWARE_SPEC, 'compile-sw');
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!, { kind: 'e2e7:build' });
    const pkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.execution).toEqual({ roleId: 'rol.developer', taskKind: 'e2e7:build', maxAttempts: 3, professionalResponsibility: null});
  });

  it('37. Core + projector sources contain no software-role branch', () => {
    const projector = readFileSync(
      fileURLToPath(new URL('../../packages/engine/src/projection/work-package-projector.ts', import.meta.url)),
      'utf8',
    );
    for (const forbidden of ['developer', 'reviewer', "'qa'", 'code-review', 'procurement-analyst', 'procurement-reviewer', 'software', 'rol.']) {
      expect(projector).not.toContain(forbidden);
    }
    expect(projector).toContain('taskProfileOf'); // config-driven only
  });

  it('38. a brand-new Pack role/kind projects without any projector change', async () => {
    const novelSpec: PlanCompilationSpec = {
      planItemProfiles: {
        'supplier-analysis': profile('logistics-work', 'rol.logistics-coordinator', 'task.logistics-routing', 5, ['e2e7.logistics_validator']),
        'financial-review': profile('logistics-review-work', 'rol.logistics-auditor', 'task.logistics-audit', 2),
        approval: profile('logistics-approval-work', 'rol.logistics-approver', 'task.logistics-approval', 1),
        recommendation: profile('logistics-report-work', 'rol.logistics-coordinator', 'task.logistics-report', 3),
      },
    };
    const f = await makeFixture(novelSpec, 'compile-novel');
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!, { kind: 'task.logistics-routing' });
    const pkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.execution).toEqual({ roleId: 'rol.logistics-auditor', taskKind: 'task.logistics-audit', maxAttempts: 2, professionalResponsibility: null});
    expect(pkg.value.acceptance.validatorRefs).toEqual([]);
  });
});

/* --------------------------- §52 lifecycle + boundaries --------------------------- */

describe('T20-06 — lifecycle safety and boundaries', () => {
  it('§52. projection is audit-capable for DONE tasks and never implies authorization', async () => {
    const f = await makeFixture();
    const completed = await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const pkg = await project(f, String(f.tasksByItem['supplier-analysis']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.observational.taskState).toBe('DONE'); // clearly labeled observational metadata
    // The task row is untouched — no re-execution authorization, no attempts bump.
    const row = await f.core.database.tasks.get(String(f.tasksByItem['supplier-analysis']!.id) as never);
    expect(Number(row!.attempts)).toBe(Number(completed.attempts));
    expect(row!.state).toBe('DONE');
  });

  it('§12. a task that drifted from the pinned profile fails closed', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!);
    const pkg = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(pkg.ok).toBe(true); // sanity: profile matches
    if (!pkg.ok) return;
    // Adversarial (test seam): rewrite the task row role — no longer the pinned semantics.
    f.core.database.db
      .prepare('UPDATE tasks SET role_id = ? WHERE id = ?')
      .run('rol.drifted', String(f.tasksByItem['financial-review']!.id));
    const drifted = await project(f, String(f.tasksByItem['financial-review']!.id));
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) expect(reasonOf(drifted.error)).toBe('WORK_PACKAGE_TASK_PROFILE_MISMATCH');
  });
});
