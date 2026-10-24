/**
 * Task-20-07 — Sprint20 FINAL CLOSEOUT E2E (§4/§42/§43): the complete frozen chain
 *
 *   Goal → Planning WorkflowVersion → Planning Run → run-owned Goal → Planner Task
 *   → Planner Runtime → PlanningProposal → T20-02 validator → immutable Plan Artifact
 *   → explicit selection → per-item trusted spec → deterministic compiler → published
 *   WorkflowVersion → Execution Run (permanent identity) → run-owned Goal → baseline
 *   Normal Tasks → WorkPackageProjector → deterministic Work Package
 *
 * against the REAL production composition, with a NON-SOFTWARE heterogeneous scenario
 * (§5): supplier-analysis → finance-review → purchase-approval → delivery-verification.
 * No business Task execution (§44). Includes the Sprint20 restart E2E (§33), the ledger
 * loss re-proof (§20), cross-run/tenant isolation (§32), replan consistency (§9) and the
 * closeout source audits (§8/§11-§13/§18/§19/§24/§28/§35/§36/§37).
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
  planFingerprintOf,
  runGoalCommandId,
  type DomainError,
  type ModelProviderPort,
  type Result,
  type Task,
} from '@companyos/core';
import {
  compiledNodeId,
  compiledTemplateId,
  executionRunIdOf,
  type PlanCompilationSpec,
  type PlanItemCompilationProfile,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';
import { createHandoffService } from '../../packages/engine/src/handoff/handoff-service.js';

const CHAINS = [
  'core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff',
] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'e2e7.planner';
const STAGE_OUTPUT_SCHEMA = 'companyos/stage-output/1';
const GOAL_TEXT =
  'Evaluate suppliers, perform financial review, obtain purchase approval, and verify delivery readiness.';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const profile = (
  stageKind: string,
  roleId: string,
  taskKind: string,
  maxAttempts: number,
  validatorIds: readonly string[] = [],
): PlanItemCompilationProfile => ({ stageKind, taskProfile: { roleId, taskKind, maxAttempts }, validatorIds });

/** §5: heterogeneous, non-software, distinct roles / kinds / validators / retry policies. */
const SPEC: PlanCompilationSpec = {
  planItemProfiles: {
    'supplier-analysis': profile('supply-analysis-work', 'rol.supply-analyst', 'task.supplier-analysis', 2, ['val.supply-audit']),
    'finance-review': profile('finance-review-work', 'rol.finance-reviewer', 'task.finance-review', 4, ['val.finance-audit', 'val.finance-compliance']),
    'purchase-approval': profile('purchasing-approval-work', 'rol.procurement-approver', 'task.purchase-approval', 1),
    'delivery-verification': profile('delivery-verification-work', 'rol.delivery-verifier', 'task.delivery-verification', 3, ['val.delivery-check']),
  },
};
const PLAN_ITEMS = [
  { planItemId: 'supplier-analysis', objective: 'Evaluate the shortlisted suppliers.', acceptanceCriterionRefs: ['crit-suppliers'] },
  { planItemId: 'finance-review', objective: 'Perform the financial review of the leading supplier.', dependencyPlanItemIds: ['supplier-analysis'], acceptanceCriterionRefs: ['crit-finance', 'crit-suppliers'] },
  { planItemId: 'purchase-approval', objective: 'Obtain the purchase approval.', dependencyPlanItemIds: ['finance-review'], acceptanceCriterionRefs: ['crit-approval'] },
  { planItemId: 'delivery-verification', objective: 'Verify delivery readiness before the purchase completes.', dependencyPlanItemIds: ['purchase-approval', 'supplier-analysis'], acceptanceCriterionRefs: ['crit-delivery'] },
];
const PLAN_CRITERIA = [
  { criterionId: 'crit-suppliers', requirement: 'Every shortlisted supplier has a recorded evaluation.' },
  { criterionId: 'crit-finance', requirement: 'The financial review covers cost, risk and terms.' },
  { criterionId: 'crit-approval', requirement: 'The approval decision is recorded with its rationale.' },
  { criterionId: 'crit-delivery', requirement: 'Delivery readiness is verified against the contract terms.' },
];

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t20z-'));
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
  readonly plannerTaskId: string;
  readonly planArtifactId: string;
  readonly planId: string;
  readonly executionRunId: string;
  readonly versionId: string;
  readonly templateId: string;
  readonly tasksByItem: Readonly<Record<string, Task>>;
}

const makeFixture = async (): Promise<Fixture> => {
  providerCalls = 0;
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: {
      developerKinds: [], reviewKinds: [],
      qaKinds: ['companyos:planning', 'task.supplier-analysis', 'task.finance-review', 'task.purchase-approval', 'task.delivery-verification'],
    },
    planCompilationSpec: SPEC,
    planExecutionBindings: { planner: MODEL_KEY },
  });
  if (core === null) throw new Error('composition failed');
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(routingProvider(), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  // Goal → Planning WorkflowVersion → Planning Run (run-owned goal, same transaction).
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
    goal: { objective: GOAL_TEXT, source: { type: 'human' } },
  });
  if (!run.ok) throw new Error(run.error.message);
  // Planner Task via the frozen NormalTaskMaterializer (T20-03B).
  const driven = await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
  if (!driven.ok) throw new Error(driven.error.message);
  const task = await core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: run.value.run.id, stageId: 'plan' });
  if (!task.ok) throw new Error(task.error.message);
  // Planner Runtime (proposal → T20-02 validation → immutable Plan artifact), ONE turn.
  const planned = await core.plannerRuntime!.runPlanningTurn({
    companyId: COMPANY, runId: run.value.run.id, taskId: task.value.taskId,
    planningCommandId: 'plan-C1', actorId: actor,
  });
  if (!planned.ok) throw new Error(planned.error.message);
  // Explicit selection → trusted per-item spec → deterministic compiler → version → run → tasks.
  const compiled = await core.planCompiler!.compile({
    companyId: COMPANY, planningRunId: run.value.run.id, planArtifactId: planned.value.artifactId,
    compilationCommandId: 'compile-1', actorId: actor, executionBindings: { planner: MODEL_KEY },
  }, SPEC);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const tasks = await core.database.tasks.listByRun(compiled.value.executionRunId);
  const byItem: Record<string, Task> = {};
  for (const item of PLAN_ITEMS) {
    const found = tasks.find((row) => String(row.stageId) === compiledNodeId(compiled.value.planId, item.planItemId));
    if (found === undefined) throw new Error(`task for ${String(item.planItemId)} missing`);
    byItem[item.planItemId] = found;
  }
  return {
    core, actor, dataDir, casRoot,
    planningRunId: run.value.run.id,
    plannerTaskId: task.value.taskId,
    planArtifactId: planned.value.artifactId,
    planId: compiled.value.planId,
    executionRunId: compiled.value.executionRunId,
    versionId: compiled.value.versionId,
    templateId: compiled.value.templateId,
    tasksByItem: byItem,
  };
};

const project = (f: Fixture, taskId: string, companyId = COMPANY) =>
  f.core.workPackageProjector!.project({ companyId, runId: f.executionRunId, taskId });

const reasonOf = (error: { readonly details: Readonly<Record<string, unknown>> }): string =>
  String(error.details['reason'] ?? '');

const completeWithOutput = async (f: Fixture, task: Task, kind: string): Promise<Task> => {
  const envelope = {
    schemaVersion: STAGE_OUTPUT_SCHEMA, kind, executionId: null,
    artifactRefs: [] as string[], validationRefs: [] as string[], payload: { result: `done:${String(task.id)}` },
  };
  let current = task;
  for (const [event, outputs] of [['PLAN', {}], ['START', {}], ['COMPLETE', { stageOutput: envelope }]] as const) {
    const next = applyTaskEvent(current, event, '2026-09-29T00:00:00Z', outputs);
    if (!next.ok) throw new Error(next.error.message);
    current = next.value;
  }
  await f.core.database.tasks.put(current);
  return current;
};

const countOf = (core: Core, sql: string, ...params: readonly (string | number | null)[]): number =>
  Number((core.database.db.prepare(sql).get(...(params as never[])) as { c: number }).c);

const versionGraphJsonOf = (core: Core, versionId: string): string =>
  (core.database.db.prepare('SELECT graph_json FROM workflow_template_versions WHERE id = ?').get(versionId) as { graph_json: string }).graph_json;

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
    stageHandlers: {
      developerKinds: [], reviewKinds: [],
      qaKinds: ['companyos:planning', 'task.supplier-analysis', 'task.finance-review', 'task.purchase-approval', 'task.delivery-verification'],
    },
    planCompilationSpec: SPEC,
    planExecutionBindings: { planner: MODEL_KEY },
  });
  if (core2 === null) throw new Error('composition2 failed');
  const provider = await core2.providers.register(routingProvider(), { actorId: f.actor });
  if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
  return core2;
};

const handoffServiceOf = (f: Fixture) =>
  createHandoffService({
    store: f.core.database.handoffStore!,
    audit: { created: async () => {}, ready: async () => {}, accepted: async () => {}, rejected: async () => {}, superseded: async () => {}, cancelled: async () => {} },
    clock: { nowIso: () => '2026-09-29T00:00:00Z', now: () => 0 },
    authorize: async () => ok(true),
    actorRoleIds: async () => ['rol.finance-reviewer'],
  });

/* ------------------------- §4/§42: the complete frozen chain ------------------------- */

describe('T20-07 — Sprint20 closeout E2E (non-software, heterogeneous)', () => {
  it('§4. Goal → … → Work Package: the complete chain on the real composition', async () => {
    const f = await makeFixture();
    // Planning Run-owned goal (run creation transaction).
    const planningGoal = await f.core.database.artifactStore!.getByCreationCommand(runGoalCommandId(f.planningRunId));
    expect(planningGoal).not.toBeNull();
    // Immutable Plan Artifact: deterministic identity + fingerprint over canonical payload bytes.
    const planRow = await f.core.database.artifactStore!.get(f.planArtifactId as never);
    expect(planRow).not.toBeNull();
    expect(String(planRow!.id)).toBe(f.planArtifactId);
    // Published WorkflowVersion with heterogeneous frozen semantics.
    const graph = JSON.parse(versionGraphJsonOf(f.core, f.versionId)) as { nodes: readonly { config: Record<string, unknown> }[]; edges: unknown[] };
    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(4); // A→B, B→C, C→D, A→D — exactly the plan's dependency edges
    // Execution Run: permanent deterministic identity, truthful workflow identity.
    const run = f.core.database.db.prepare('SELECT id, workflow_id, version_id FROM runs WHERE id = ?').get(f.executionRunId) as { id: string; workflow_id: string; version_id: string };
    expect(run.id).toBe(executionRunIdOf(COMPANY, f.planningRunId, f.planId, 'compile-1'));
    expect(run.workflow_id).toBe(compiledTemplateId(COMPANY, f.planId, 'compile-1'));
    expect(run.version_id).toBe(f.versionId);
    // Baseline normal tasks: one per item, PENDING.
    const tasks = await f.core.database.tasks.listByRun(f.executionRunId);
    expect(tasks).toHaveLength(4);
    expect(tasks.every((t) => t.state === 'PENDING')).toBe(true);
    // Work Package for the downstream task after canonical predecessor results exist.
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!, 'task.supplier-analysis');
    await completeWithOutput(f, f.tasksByItem['finance-review']!, 'task.finance-review');
    await completeWithOutput(f, f.tasksByItem['purchase-approval']!, 'task.purchase-approval');
    const pkg = await project(f, String(f.tasksByItem['delivery-verification']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.work.objective).toBe('Verify delivery readiness before the purchase completes.');
    expect(pkg.value.goal.objective).toBe(GOAL_TEXT);
    expect(pkg.value.dependencies).toHaveLength(2); // C + A (exact DAG parents)
    expect(pkg.value.execution).toEqual({ roleId: 'rol.delivery-verifier', taskKind: 'task.delivery-verification', maxAttempts: 3, professionalResponsibility: null});
  });

  it('§21/§22. one heterogeneous version; criteria frozen byte-exact, shared semantically', async () => {
    const f = await makeFixture();
    const graph = JSON.parse(versionGraphJsonOf(f.core, f.versionId)) as {
      nodes: readonly { config: Record<string, unknown> }[];
    };
    const profiles = graph.nodes.map((node) => JSON.stringify(node.config['taskProfile']));
    expect(new Set(profiles).size).toBe(4); // §21: four distinct execution profiles
    const validators = graph.nodes.map((node) => JSON.stringify(node.config['validatorIds'] ?? null));
    expect(new Set(validators).size).toBe(4); // distinct validator sets (incl. one absent)
    // §22: crit-suppliers shared by supplier-analysis AND finance-review — one canonical id,
    // byte-exact requirement text, zero status fields.
    const sharers = graph.nodes.filter((node) =>
      ((node.config['planItem'] as { acceptanceCriterionRefs: string[] }).acceptanceCriterionRefs.includes('crit-suppliers')));
    expect(sharers).toHaveLength(2);
    for (const node of sharers) {
      const criteria = node.config['acceptanceCriteria'] as readonly Record<string, unknown>[];
      const shared = criteria.find((entry) => entry['criterionId'] === 'crit-suppliers')!;
      expect(shared['requirement']).toBe('Every shortlisted supplier has a recorded evaluation.');
      expect(Object.keys(shared).sort()).toEqual(['criterionId', 'requirement']);
    }
  });

  it('§10. plan contract invariants hold on the closeout artifact', async () => {
    const f = await makeFixture();
    const planRow = await f.core.database.artifactStore!.get(f.planArtifactId as never);
    const reopened = await openArtifactFoundation({ casRoot: f.casRoot, database: f.core.database, logger: nullLogger as never });
    if (!('contentStore' in reopened)) throw new Error('foundation reopen failed');
    const bytes = new TextDecoder().decode(await reopened.contentStore.get(planRow!.contentRef));
    const payload = JSON.parse(bytes) as { schema: string; planItems: unknown[]; acceptanceCriteria: unknown[]; sourceGoal: unknown };
    expect(payload.schema).toBe('companyos/plan/1');
    expect(Object.keys(payload).sort()).toEqual(['acceptanceCriteria', 'planItems', 'schema', 'sourceGoal']);
    expect(payload.planItems).toHaveLength(4);
    expect(payload.acceptanceCriteria).toHaveLength(4);
    // fingerprint = sha256 over the canonical bytes (contentHash IS the fingerprint).
    expect(planFingerprintOf(payload as never)).toBe(String(planRow!.contentHash));
    // every item references a criterion; every criterion is referenced (T20-02 two-way invariant)
    const items = payload.planItems as { acceptanceCriterionRefs: string[] }[];
    const referenced = new Set(items.flatMap((item) => item.acceptanceCriterionRefs));
    const defined = new Set((payload.acceptanceCriteria as { criterionId: string }[]).map((entry) => entry.criterionId));
    expect([...referenced].sort()).toEqual([...defined].sort());
  });

  it('§9. replan consistency: one Planning Run = one planning result', async () => {
    const f = await makeFixture();
    const again = await f.core.plannerRuntime!.runPlanningTurn({
      companyId: COMPANY, runId: f.planningRunId, taskId: f.plannerTaskId,
      planningCommandId: 'plan-C2', actorId: f.actor,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(reasonOf(again.error)).toBe('PLANNER_TASK_ALREADY_SETTLED');
    // Replay of the SAME command returns the SAME plan with ZERO provider calls.
    providerCalls = 0;
    const replay = await f.core.plannerRuntime!.runPlanningTurn({
      companyId: COMPANY, runId: f.planningRunId, taskId: f.plannerTaskId,
      planningCommandId: 'plan-C1', actorId: f.actor,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.planId).toBe(f.planId);
    expect(replay.value.artifactId).toBe(f.planArtifactId);
    expect(providerCalls).toBe(0);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts WHERE kind = ?', 'companyos:plan')).toBe(1);
  });

  it('§14/§23. pinned semantics + execution goal ownership', async () => {
    const f = await makeFixture();
    // §23: the execution run owns its own run-goal artifact; the planning goal stays
    // planning-owned; nothing consumed it as same-run evidence.
    const execGoal = await f.core.database.artifactStore!.getByCreationCommand(runGoalCommandId(f.executionRunId));
    expect(execGoal).not.toBeNull();
    expect(String(execGoal!.artifact.runId)).toBe(f.executionRunId);
    expect(String(execGoal!.artifact.runId)).not.toBe(f.planningRunId);
    // §14: V2-becomes-current never changes the run pin or any projection semantics.
    const before = await project(f, String(f.tasksByItem['supplier-analysis']!.id));
    if (!before.ok) throw new Error(before.error.message);
    const graphV2 = JSON.parse(versionGraphJsonOf(f.core, f.versionId));
    graphV2.nodes[0].title = 'unrelated-later';
    f.core.database.db
      .prepare("INSERT INTO workflow_template_versions (id, template_id, semver, content_hash, snapshot_hash, graph_json, change_proposal_id, created_at, created_by) VALUES (?, ?, '2.0.0', ?, ?, ?, NULL, '2026-02-01T00:00:00Z', ?)")
      .run('ver_close_v2', f.templateId, 'h2', 's2', JSON.stringify(graphV2), f.actor);
    f.core.database.db.prepare('UPDATE workflow_templates SET current_version_id = ? WHERE id = ?').run('ver_close_v2', f.templateId);
    const after = await project(f, String(f.tasksByItem['supplier-analysis']!.id));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(JSON.stringify(after.value)).toBe(JSON.stringify(before.value));
    const pin = f.core.database.db.prepare('SELECT version_id FROM runs WHERE id = ?').get(f.executionRunId) as { version_id: string };
    expect(pin.version_id).toBe(f.versionId);
  });

  it('§44. side-effect assertion: the pipeline executes nothing', async () => {
    const f = await makeFixture();
    const before = {
      executions: countOf(f.core, 'SELECT COUNT(*) AS c FROM agent_executions'),
      tasks: countOf(f.core, 'SELECT COUNT(*) AS c FROM tasks'),
      handoffs: countOf(f.core, 'SELECT COUNT(*) AS c FROM handoffs'),
      decisions: countOf(f.core, 'SELECT COUNT(*) AS c FROM decisions'),
      validations: countOf(f.core, 'SELECT COUNT(*) AS c FROM validations'),
      artifacts: countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts'),
    };
    providerCalls = 0;
    const pkg = await project(f, String(f.tasksByItem['supplier-analysis']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(providerCalls).toBe(0); // business execution provider calls: 0
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM agent_executions')).toBe(before.executions);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM decisions')).toBe(before.decisions);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM validations')).toBe(before.validations);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM handoffs')).toBe(before.handoffs); // autonomous edge: zero packets
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts')).toBe(before.artifacts);
    const tasks = await f.core.database.tasks.listByRun(f.executionRunId);
    expect(tasks.every((t) => t.state === 'PENDING' && t.attempts === 0)).toBe(true); // nothing started
    expect(tasks.every((t) => t.inputs['corrective'] === undefined)).toBe(true); // zero corrective tasks
  });

  it('§33. Sprint20 restart E2E: same plan/version/run/goal/tasks/package/handoff', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!, 'task.supplier-analysis');
    // An accepted durable handoff for the downstream task, through the REAL service.
    const service = handoffServiceOf(f);
    const target = String(f.tasksByItem['finance-review']!.id);
    const draft = await service.createDraft({
      handoffId: 'hnd_closeout', companyId: COMPANY,
      workflowId: compiledTemplateId(COMPANY, f.planId, 'compile-1'), workflowVersionId: f.versionId,
      workflowRunId: f.executionRunId, stageId: String(f.tasksByItem['finance-review']!.stageId), taskId: target,
      fromAgentId: 'agent.supply', fromRoleId: 'rol.supply-analyst', toRoleId: 'rol.finance-reviewer',
      objective: 'Supplier evaluation complete.', summary: 'The evaluation is complete and durable.',
      recommendedNextAction: 'Perform the financial review.', traceId: 'trace_closeout',
      actorId: f.actor,
    });
    if (!draft.ok) throw new Error(draft.error.message);
    const readied = await service.ready({ handoffId: 'hnd_closeout', version: 1, actorId: f.actor });
    if (!readied.ok) throw new Error(readied.error.message);
    const accepted = await service.accept({ handoffId: 'hnd_closeout', version: 1, actorId: f.actor });
    if (!accepted.ok) throw new Error(accepted.error.message);
    const pkgBefore = await project(f, target);
    if (!pkgBefore.ok) throw new Error(pkgBefore.error.message);
    const taskIdsBefore = (await f.core.database.tasks.listByRun(f.executionRunId)).map((t) => String(t.id)).sort();
    const planHashBefore = String((await f.core.database.artifactStore!.get(f.planArtifactId as never))!.contentHash);
    // Real restart.
    const core2 = await reopen(f);
    const planRow2 = await core2.database.artifactStore!.get(f.planArtifactId as never);
    expect(String(planRow2!.contentHash)).toBe(planHashBefore); // same Plan (immutable artifact)
    const pkgAfter = await core2.workPackageProjector!.project({ companyId: COMPANY, runId: f.executionRunId, taskId: target });
    expect(pkgAfter.ok).toBe(true);
    if (!pkgAfter.ok) return;
    expect(JSON.stringify(pkgAfter.value)).toBe(JSON.stringify(pkgBefore.value)); // same Work Package semantics
    expect(pkgAfter.value.handoff).toHaveLength(1); // same accepted handoff semantics
    expect(pkgAfter.value.handoff[0]!.handoffId).toBe('hnd_closeout');
    expect((await core2.database.tasks.listByRun(f.executionRunId)).map((t) => String(t.id)).sort())
      .toEqual(taskIdsBefore);
    providerCalls = 0;
    const replay = await core2.planCompiler!.compile({
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-1', actorId: f.actor, executionBindings: { planner: MODEL_KEY },
    }, SPEC);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.executionRunId).toBe(f.executionRunId);
    expect(replay.value.versionId).toBe(f.versionId);
    expect(providerCalls).toBe(0);
  });

  it('§20. ledger loss: compile → run exists → ledger gone → restart → same everything', async () => {
    const f = await makeFixture();
    f.core.database.db.exec('DELETE FROM command_ledger');
    const core2 = await reopen(f);
    expect(countOf(core2, 'SELECT COUNT(*) AS c FROM command_ledger')).toBe(0);
    const replay = await core2.planCompiler!.compile({
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-1', actorId: f.actor, executionBindings: { planner: MODEL_KEY },
    }, SPEC);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.executionRunId).toBe(f.executionRunId);
    expect(replay.value.versionId).toBe(f.versionId);
    expect((await core2.database.tasks.listByRun(f.executionRunId))).toHaveLength(4);
    expect(countOf(core2, 'SELECT COUNT(*) AS c FROM runs')).toBe(2); // no duplicate durable objects
    expect(countOf(core2, 'SELECT COUNT(*) AS c FROM workflow_templates WHERE name LIKE ?', 'plan-compile:%')).toBe(1);
    expect(countOf(core2, 'SELECT COUNT(*) AS c FROM artifacts WHERE run_id = ? AND kind = ?', f.executionRunId, 'companyos:run-goal')).toBe(1);
  });

  it('§32. cross-run and cross-tenant isolation across the Sprint20 surfaces', async () => {
    const f = await makeFixture();
    await completeWithOutput(f, f.tasksByItem['supplier-analysis']!, 'task.supplier-analysis');
    // cross-company: indistinguishable NOT_FOUND.
    const foreignCompany = await project(f, String(f.tasksByItem['finance-review']!.id), 'company_other');
    expect(foreignCompany.ok).toBe(false);
    if (!foreignCompany.ok) expect(foreignCompany.error.code).toBe('NOT_FOUND');
    // cross-run task: the planning run's own task can never be projected for the execution run.
    const foreignTask = await project(f, f.plannerTaskId);
    expect(foreignTask.ok).toBe(false);
    if (!foreignTask.ok) expect(reasonOf(foreignTask.error)).toBe('WORK_PACKAGE_TASK_RUN_MISMATCH');
    // cross-run predecessor rows never leak into dependency selection.
    const decoy = createTask({
      runId: f.planningRunId as never, stageId: f.tasksByItem['supplier-analysis']!.stageId,
      roleId: 'rol.planner' as never, kind: 'companyos:planning', maxAttempts: 1, inputs: {},
      now: '2026-09-28T00:00:00Z', ids: { ulid: () => 'U', id: (p: string) => `${String(p)}_iso_decoy` },
    });
    if (!decoy.ok) throw new Error(decoy.error.message);
    await f.core.database.tasks.put(decoy.value);
    const pkg = await project(f, String(f.tasksByItem['finance-review']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.dependencies[0]!.subjectTaskId).toBe(String(f.tasksByItem['supplier-analysis']!.id));
    // cross-run/cross-tenant handoff scope: nothing foreign applies.
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM handoffs WHERE company_id != ? OR workflow_run_id != ?', COMPANY, f.executionRunId)).toBe(0);
  });

  it('§27. same-round corrective tie-break is deterministic and restart-stable', async () => {
    const f = await makeFixture();
    const stage = f.tasksByItem['supplier-analysis']!;
    await completeWithOutput(f, stage, 'task.supplier-analysis'); // baseline terminal-successful
    // Two SAME-ROUND (round 1) corrective tasks — legal: identity is per-decision, the
    // provisioner enforces no one-per-(stage,round) rule (source-audited).
    const mk = async (name: string, at: string): Promise<Task> => {
      const created = createTask({
        runId: stage.runId, stageId: stage.stageId, roleId: stage.roleId, kind: stage.kind,
        maxAttempts: Number(stage.maxAttempts),
        inputs: { corrective: { parentTaskId: String(stage.id), round: 1, origin: 'review' } },
        now: at, ids: { ulid: () => 'U', id: (p: string) => `${String(p)}_${String(name)}` },
      });
      if (!created.ok) throw new Error(created.error.message);
      const written = await f.core.database.tasks.putGuarded(created.value);
      if (!written.ok) throw new Error(written.error.message);
      return created.value;
    };
    const c1 = await mk('corrA', '2026-09-28T01:00:00Z');
    const c2 = await mk('corrB', '2026-09-28T02:00:00Z'); // same round, LATER createdAt
    await completeWithOutput(f, c1, 'task.supplier-analysis');
    await completeWithOutput(f, c2, 'task.supplier-analysis');
    const pkg = await project(f, String(f.tasksByItem['finance-review']!.id));
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    expect(pkg.value.dependencies[0]!.subjectTaskId).toBe(String(c1.id)); // the repository tie-break at equal round: earliest (createdAt, id) — mirrored exactly from workSubjectTaskOf
    const core2 = await reopen(f);
    const pkg2 = await core2.workPackageProjector!.project({
      companyId: COMPANY, runId: f.executionRunId, taskId: String(f.tasksByItem['finance-review']!.id),
    });
    expect(pkg2.ok).toBe(true);
    if (!pkg2.ok) return;
    expect(pkg2.value.dependencies[0]!.subjectTaskId).toBe(String(c1.id)); // restart-stable
  });
});

/* ------------------------- closeout source audits (§8/§11-§13/§18/§19/§24/§28/§35/§36/§37) ------------------------- */

describe('T20-07 — Sprint20 source and schema audits', () => {
  const sourceOf = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

  it('§8. no repin, no dynamic task graph, no second scheduler', () => {
    const runStore = sourceOf('../../packages/persistence/src/durable/sqlite-run-store.ts');
    // The run upsert updates lifecycle ONLY — creation pins (workflow/template/version) are immutable.
    const upsert = runStore.slice(runStore.indexOf('ON CONFLICT(id) DO UPDATE'), runStore.indexOf('ON CONFLICT(id) DO UPDATE') + 320);
    for (const frozen of ['workflow_id', 'template_id', 'version_id', 'company_id']) {
      expect(upsert).not.toContain(frozen);
    }
  });

  it('§9. no latestPlan authority anywhere in Sprint20 planning', () => {
    for (const relative of [
      '../../packages/engine/src/planning/planner-runtime.ts',
      '../../packages/engine/src/planning/plan-compiler.ts',
      '../../packages/engine/src/projection/work-package-projector.ts',
    ]) {
      expect(sourceOf(relative)).not.toContain('latestPlanOf');
      expect(sourceOf(relative)).not.toContain('deps.latestPlan');
    }
    expect(sourceOf('../../packages/engine/src/planning/planner-runtime.ts')).toContain('PLANNER_TASK_ALREADY_SETTLED');
  });

  it('§11/§12. task ownership and creation identity unchanged through Sprint20', () => {
    const supervisor = sourceOf('../../packages/engine/src/supervisor/autonomous-supervisor.ts');
    expect(supervisor).toContain('listByRun'); // run-scoped claim reads, not stage-only scans
    const session = sourceOf('../../packages/engine/src/session/work-session-runtime.ts');
    expect(session).toContain('SESSION_TASK_RUN_MISMATCH');
    const taskStore = sourceOf('../../packages/persistence/src/durable/sqlite-task-store.ts');
    const arrayStart = taskStore.indexOf('const SCALAR_SEED_FIELDS');
    const seedArray = taskStore.slice(arrayStart, taskStore.indexOf('] as const;', arrayStart));
    for (const member of ['runId', 'stageId', 'roleId', 'kind', 'maxAttempts']) {
      expect(seedArray).toContain(member);
    }
    for (const excluded of ['createdAt', 'updatedAt', 'state', 'attempts', 'outputs']) {
      expect(seedArray).not.toContain(excluded);
    }
    // inputs join the seed through canonical JSON comparison, never through mutation-prone copies
    expect(taskStore).toContain('canonicalJson(existing.inputs) === canonicalJson(candidate.inputs)');
  });

  it('§13. one baseline task per run+stage; no localKey, no UNIQUE(run_id,stage_id), no task DAG', async () => {
    const f = await makeFixture();
    const materializer = sourceOf('../../packages/engine/src/planning/normal-task-materializer.ts');
    expect(materializer).not.toContain('localKey');
    expect(materializer).toContain('companyos/normal-task/1');
    const indexes = f.core.database.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'").all() as { name: string; sql: string | null }[];
    for (const index of indexes) {
      expect(index.sql === null ? '' : index.sql.toUpperCase()).not.toContain('UNIQUE');
    }
    const tasks = await f.core.database.tasks.listByRun(f.executionRunId);
    expect(new Set(tasks.map((t) => String(t.stageId))).size).toBe(tasks.length);
    expect(tasks.every((t) => t.inputs['dependsOn'] === undefined && t.inputs['dag'] === undefined)).toBe(true);
  });

  it('§18/§19. workflow + execution-run permanent identity: name not authority, no findByWorkflowId, ledger not sole identity', () => {
    const compiler = sourceOf('../../packages/engine/src/planning/plan-compiler.ts');
    expect(compiler).not.toContain('templates.list'); // no find-by-name discovery path
    expect(compiler).not.toContain('findByWorkflowId');
    expect(compiler).not.toContain('deps.ledger');
    expect(compiler).not.toContain('currentVersionId');
    expect(compiler).not.toContain('wf_exec');
    expect(compiler).toContain('compiledTemplateId');
    expect(compiler).toContain('executionRunIdOf');
    const lifecycle = sourceOf('../../packages/engine/src/lifecycle-service.ts');
    expect(lifecycle).toContain('putGuarded'); // PK-arbitrated guarded creation seams
    expect(lifecycle).toContain('RUN_IDENTITY_SEED_CONFLICT');
  });

  it('§24/§28/§35. no second systems, no WorkPackage persistence, no UI truth', async () => {
    const f = await makeFixture();
    const tables = (f.core.database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((row) => row.name);
    expect(tables).not.toContain('work_packages');
    expect(tables.filter((name) => name.includes('work_package'))).toEqual([]);
    expect(tables.filter((name) => name.includes('handoff')).sort()).toEqual(['handoff_refs', 'handoffs']); // the ONE durable handoff owner
    expect(tables.filter((name) => name.includes('plan'))).toEqual([]); // Plan lives as an artifact kind, never a table
    expect(tables.filter((name) => name.includes('session')).length).toBeGreaterThan(0); // the ONE session system (Sprint 19)
    // Projector: zero persistence imports/seams.
    const projector = sourceOf('../../packages/engine/src/projection/work-package-projector.ts');
    expect(projector).not.toContain('put(');
    expect(projector).not.toContain('INSERT');
    expect(projector).not.toContain('create(');
  });

  it('§36. Sprint20 Core + projector + compiler sources carry no business-domain branching', () => {
    for (const relative of [
      '../../packages/core/src/lifecycle/plan.ts',
      '../../packages/engine/src/planning/plan-compiler.ts',
      '../../packages/engine/src/projection/work-package-projector.ts',
      '../../packages/engine/src/planning/normal-task-materializer.ts',
      '../../packages/engine/src/planning/planner-runtime.ts',
    ]) {
      const source = sourceOf(relative);
      for (const forbidden of [
        "'developer'", "'reviewer'", "'qa'", "'software'", "'procurement'", "'finance'", "'legal'",
        "'marketing'", "'content'", "'supplier'", "'approval'", 'code-review', 'rol.developer',
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it('§37. GENERIC_ROLE_ORCHESTRATION: closed by Sprint21 — no stage-kind string branches remain', () => {
    const supervisor = sourceOf('../../packages/engine/src/supervisor/autonomous-supervisor.ts');
    // Sprint21 closed the frozen gap: the orchestrator classifies stages through the
    // deployment-declared class sets (taskProfile.taskKind keyed), never through the
    // legacy software vocabulary.
    expect(supervisor).not.toContain("new Set(['review'])");
    expect(supervisor).not.toContain("new Set(['qa'])");
    expect(supervisor).not.toContain("?? 'work'");
    expect(supervisor).not.toContain('stageClasses'); // removed entirely
  });
});
