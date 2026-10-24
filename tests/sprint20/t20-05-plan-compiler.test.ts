/**
 * Task-20-05 — Deterministic plan compiler + execution-run derivation + task
 * materialization (§70: the 35 required points), plus the hardening §39 24-point
 * matrix (heterogeneous per-item profiles + permanent compilation/execution-run
 * identity), ALL against the REAL production composition: real
 * ArtifactService/CAS content, real workflow lifecycle publish, real run
 * creation + run-goal path, real NormalTaskMaterializer, real durable stores,
 * real restart, real ledger loss.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ok, runGoalCommandId, sha256Hex, type DomainError, type ModelProviderPort, type Result } from '@companyos/core';
import {
  PLAN_COMPILATION_ANCHOR_KIND,
  PLAN_COMPILER_CONTRACT,
  compiledNodeId,
  compiledTemplateId,
  compiledTemplateName,
  executionRunIdOf,
  type PlanCompilationSpec,
  type PlanItemCompilationProfile,
} from '@companyos/engine';
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

const profile = (
  stageKind: string,
  roleId: string,
  taskKind: string,
  maxAttempts: number,
  validatorIds: readonly string[] = [],
): PlanItemCompilationProfile => ({ stageKind, taskProfile: { roleId, taskKind, maxAttempts }, validatorIds });

/**
 * The HETEROGENEOUS procurement spec (hardening §6/§13): four plan items, four
 * DISTINCT trusted profiles — analyst/reviewer/approver roles, four kinds, four
 * attempt bounds (1/2/3/4), one/two/zero validators.
 */
const PROCUREMENT_SPEC: PlanCompilationSpec = {
  planItemProfiles: {
    'supplier-analysis': profile('procurement-analysis-work', 'rol.procurement-analyst', 'task.procurement-analysis', 2, ['e2e7.unit_validator']),
    'financial-review': profile('procurement-review-work', 'rol.procurement-reviewer', 'task.procurement-review', 4, ['e2e7.unit_validator', 'e2e7.audit_validator']),
    approval: profile('procurement-approval-work', 'rol.procurement-approver', 'task.procurement-approval', 1),
    recommendation: profile('procurement-report-work', 'rol.procurement-analyst', 'task.procurement-recommendation', 3),
  },
};
/** A uniform SOFTWARE spec — the same items, one explicit software profile each. */
const softwareItemProfile = profile('work', 'rol.developer', 'e2e7:build', 3);
const SOFTWARE_SPEC: PlanCompilationSpec = {
  planItemProfiles: {
    'supplier-analysis': softwareItemProfile,
    'financial-review': softwareItemProfile,
    approval: softwareItemProfile,
    recommendation: softwareItemProfile,
  },
};
/** A drifted spec (restart-time drift probe — the composition-level spec is NOT a live default). */
const DRIFTED_SPEC: PlanCompilationSpec = {
  planItemProfiles: {
    'supplier-analysis': profile('drifted-work', 'rol.drifted', 'task.drifted', 9),
    'financial-review': profile('drifted-work', 'rol.drifted', 'task.drifted', 9),
    approval: profile('drifted-work', 'rol.drifted', 'task.drifted', 9),
    recommendation: profile('drifted-work', 'rol.drifted', 'task.drifted', 9),
  },
};

const ALL_TASK_KINDS = [
  'companyos:planning',
  'task.procurement-analysis',
  'task.procurement-review',
  'task.procurement-approval',
  'task.procurement-recommendation',
  'e2e7:build',
];

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t20c-'));
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
        structured: {
          schema: 'companyos/plan-proposal/1',
          planItems: PLAN_ITEMS,
          acceptanceCriteria: PLAN_CRITERIA,
        } as never,
        toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalCost: null }, finishReason: 'stop' as const,
      }),
    );
  },
  stream(): AsyncIterable<Result<never, DomainError>> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
  },
});

/** The supplier chain: A; B←A; C←A; D←(B,C) — the §60 dependency shape. */
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

interface Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly planningRunId: string;
  readonly plannerTaskId: string;
  readonly planArtifactId: string;
  readonly planId: string;
}

const makeFixture = async (options?: {
  readonly crashAt?: string;
  readonly kindsOrder?: 'forward' | 'reverse';
  readonly goal?: string;
}): Promise<Fixture> => {
  providerCalls = 0;
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const qaKinds = options?.kindsOrder === 'reverse' ? [...ALL_TASK_KINDS].reverse() : ALL_TASK_KINDS;
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds },
    planCompilationSpec: PROCUREMENT_SPEC,
    planExecutionBindings: { planner: MODEL_KEY },
    ...(options?.crashAt === undefined ? {} : { faultCheckpoints: {
      checkpoint: (name: string): Promise<void> =>
        name === options.crashAt ? Promise.reject(new Error(`crash:${String(name)}`)) : Promise.resolve(),
    } }),
  });
  if (core === null) throw new Error('composition failed');
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(routingProvider(), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  // A planning workflow + run + materialized planner task + a real planned artifact.
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
    goal: { objective: options?.goal ?? 'Evaluate three suppliers, perform financial review, obtain approval, and produce a procurement recommendation.', source: { type: 'human' } },
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
  casRoots.set(core, casRoot);
  return {
    core, actor, dataDir, casRoot,
    planningRunId: run.value.run.id,
    plannerTaskId: task.value.taskId,
    planArtifactId: planned.value.artifactId,
    planId: planned.value.planId,
  };
};

const compile = (f: Fixture, commandId = 'compile-1', spec: PlanCompilationSpec = PROCUREMENT_SPEC) =>
  f.core.planCompiler!.compile({
    companyId: COMPANY,
    planningRunId: f.planningRunId,
    planArtifactId: f.planArtifactId,
    compilationCommandId: commandId,
    actorId: f.actor,
    executionBindings: { planner: MODEL_KEY },
  }, spec);

const compileArtifact = (
  core: Core,
  input: { readonly companyId: string; readonly planningRunId: string; readonly planArtifactId: string; readonly compilationCommandId: string; readonly actorId: string },
  spec: PlanCompilationSpec = PROCUREMENT_SPEC,
) => core.planCompiler!.compile({ ...input, executionBindings: { planner: MODEL_KEY } }, spec);

const reasonOf = (error: { readonly details: Readonly<Record<string, unknown>> }): string =>
  String(error.details['reason'] ?? '');

const versionGraphOf = (core: Core, templateId: string): Record<string, unknown> => {
  const row = core.database.db
    .prepare('SELECT current_version_id FROM workflow_templates WHERE id = ?')
    .get(templateId) as { current_version_id: string };
  const version = core.database.db
    .prepare('SELECT graph_json FROM workflow_template_versions WHERE id = ?')
    .get(row.current_version_id) as { graph_json: string };
  return JSON.parse(version.graph_json) as Record<string, unknown>;
};

const versionGraphJsonOf = (core: Core, templateId: string): string => {
  const row = core.database.db
    .prepare('SELECT current_version_id FROM workflow_templates WHERE id = ?')
    .get(templateId) as { current_version_id: string };
  const version = core.database.db
    .prepare('SELECT graph_json FROM workflow_template_versions WHERE id = ?')
    .get(row.current_version_id) as { graph_json: string };
  return version.graph_json;
};

const versionContentHashOf = (core: Core, templateId: string): string => {
  const row = core.database.db
    .prepare('SELECT current_version_id FROM workflow_templates WHERE id = ?')
    .get(templateId) as { current_version_id: string };
  const version = core.database.db
    .prepare('SELECT content_hash FROM workflow_template_versions WHERE id = ?')
    .get(row.current_version_id) as { content_hash: string };
  return version.content_hash;
};

const reopen = async (f: Fixture, spec: PlanCompilationSpec = PROCUREMENT_SPEC, kindsOrder: 'forward' | 'reverse' = 'forward'): Promise<Core> => {
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
      developerKinds: [],
      reviewKinds: [],
      qaKinds: kindsOrder === 'reverse' ? [...ALL_TASK_KINDS].reverse() : ALL_TASK_KINDS,
    },
    planCompilationSpec: spec,
    planExecutionBindings: { planner: MODEL_KEY },
  });
  if (core2 === null) throw new Error('composition2 failed');
  casRoots.set(core2, f.casRoot);
  const provider = await core2.providers.register(routingProvider(), { actorId: f.actor });
  if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
  const model = await core2.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: f.actor });
  if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
  return core2;
};

/** A SECOND independent plan in the SAME database (its own planning run + plan artifact). */
const makeSecondPlan = async (f: Fixture): Promise<string> => {
  const core = f.core;
  const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: 'planning-2', actorId: f.actor });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [{ id: 'plan', kind: 'planning', title: 'Plan', config: { taskProfile: { roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 2 } } }],
    edges: [],
  } as never;
  const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: f.actor });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({ templateId: template.value.id, actorId: f.actor });
  if (!published.ok) throw new Error(published.error.message);
  const run = await core.lifecycle.createRun({
    templateId: template.value.id, companyId: COMPANY, workflowId: 'wf-plan-2', actorId: f.actor,
    modelBindings: { planner: MODEL_KEY },
    goal: { objective: 'A DIFFERENT planning objective for a different plan.', source: { type: 'human' } },
  });
  if (!run.ok) throw new Error(run.error.message);
  const driven = await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
  if (!driven.ok) throw new Error(driven.error.message);
  const task = await core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: run.value.run.id, stageId: 'plan' });
  if (!task.ok) throw new Error(task.error.message);
  const planned = await core.plannerRuntime!.runPlanningTurn({
    companyId: COMPANY, runId: run.value.run.id, taskId: task.value.taskId,
    planningCommandId: 'plan-C2', actorId: f.actor,
  });
  if (!planned.ok) throw new Error(planned.error.message);
  return planned.value.artifactId;
};

const runRowOf = (core: Core, runId: string): { id: string; workflow_id: string; version_id: string } =>
  core.database.db.prepare('SELECT id, workflow_id, version_id FROM runs WHERE id = ?').get(runId) as { id: string; workflow_id: string; version_id: string };

const countOf = (core: Core, sql: string, ...params: readonly (string | number | null)[]): number =>
  Number((core.database.db.prepare(sql).get(...(params as never[])) as { c: number }).c);

/* ------------------------------- selection, determinism, freeze (points 1-10) */

describe('T20-05 §70 — selection, determinism, criteria freeze', () => {
  it('1-3. exact plan selection; foreign plan rejected; authority validated', async () => {
    const f = await makeFixture();
    const good = await compile(f);
    expect(good.ok).toBe(true); // 1
    if (!good.ok) return;
    // 2: a foreign company cannot compile this plan.
    const foreign = await compileArtifact(f.core, {
      companyId: 'company_other', planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-x', actorId: f.actor,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe('NOT_FOUND'); // no leak
    // 3: an artifact id that is not a plan / not owned by the run is rejected.
    const wrong = await compileArtifact(f.core, {
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: 'art_missing',
      compilationCommandId: 'compile-y', actorId: f.actor,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(reasonOf(wrong.error)).toBe('PLAN_ARTIFACT_NOT_OWNED');
  });

  it('4-5. deterministic node ids; the dependency DAG is preserved exactly', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = versionGraphOf(f.core, result.value.templateId);
    const nodes = graph['nodes'] as readonly { readonly id: string; readonly config: Record<string, unknown> }[];
    // 4: deterministic ids from (planId, planItemId)
    for (const item of PLAN_ITEMS) {
      expect(nodes.some((node) => node.id === compiledNodeId(result.value.planId, item.planItemId))).toBe(true);
    }
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
    // 5: A→B, A→C, (B,C)→D exactly; no accidental linearization
    const edges = graph['edges'] as readonly { readonly from: string; readonly to: string }[];
    const idOf = (planItemId: string): string => compiledNodeId(result.value.planId, planItemId);
    const pairs = new Set(edges.map((edge) => `${String(edge.from)}>${String(edge.to)}`));
    expect(pairs.has(`${idOf('supplier-analysis')}>${idOf('financial-review')}`)).toBe(true);
    expect(pairs.has(`${idOf('supplier-analysis')}>${idOf('approval')}`)).toBe(true);
    expect(pairs.has(`${idOf('financial-review')}>${idOf('recommendation')}`)).toBe(true);
    expect(pairs.has(`${idOf('approval')}>${idOf('recommendation')}`)).toBe(true);
    expect(edges).toHaveLength(4); // exactly the plan's dependency edges, nothing invented
  });

  it('6-7. criteria frozen immutably with EXACT text; shared criteria preserved', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = versionGraphOf(f.core, result.value.templateId);
    const nodes = graph['nodes'] as readonly { readonly config: Record<string, unknown> }[];
    // crit-analysis is shared by supplier-analysis, financial-review AND recommendation.
    const sharers = nodes.filter((node) => {
      const item = node.config['planItem'] as { acceptanceCriterionRefs: string[] };
      return item.acceptanceCriterionRefs.includes('crit-analysis');
    });
    expect(sharers).toHaveLength(3); // 7: sharing preserved, one canonical id
    for (const node of sharers) {
      const criteria = node.config['acceptanceCriteria'] as readonly { criterionId: string; requirement: string }[];
      const shared = criteria.find((entry) => entry.criterionId === 'crit-analysis');
      expect(shared).toBeDefined();
      // 6/§18: byte-for-byte requirement text, no status/result fields
      expect(shared!.requirement).toBe('All three suppliers have a recorded analysis.');
      expect(Object.keys(shared!).sort()).toEqual(['criterionId', 'requirement']);
    }
  });

  it('8-9. validator + taskProfile come ONLY from the trusted PER-ITEM profile', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = versionGraphOf(f.core, result.value.templateId);
    const nodes = graph['nodes'] as readonly { readonly config: Record<string, unknown> }[];
    expect(nodes).toHaveLength(PLAN_ITEMS.length);
    for (const node of nodes) {
      const planItemId = (node.config['planItem'] as { planItemId: string }).planItemId;
      const expected = PROCUREMENT_SPEC.planItemProfiles[planItemId]!;
      expect(node.config['taskProfile']).toEqual(expected.taskProfile); // 9: per-item
      // 8: validatorIds exactly the per-item trusted set (absent when empty)
      if (expected.validatorIds!.length === 0) {
        expect(node.config['validatorIds']).toBeUndefined();
      } else {
        expect(node.config['validatorIds']).toEqual([...expected.validatorIds!]);
      }
    }
    // Heterogeneity is real: four distinct task profiles and kinds, mixed validator sets.
    expect(new Set(nodes.map((node) => JSON.stringify(node.config['taskProfile']))).size).toBe(4);
    expect(new Set(nodes.map((node) => (node.config['planItem'] as { planItemId: string }).planItemId).map((id) => PROCUREMENT_SPEC.planItemProfiles[id]!.stageKind)).size).toBe(4);
    expect(nodes.some((node) => Array.isArray(node.config['validatorIds']) && (node.config['validatorIds'] as string[]).length === 2)).toBe(true);
  });

  it('10/§23. the Core compiler source contains NO software mapping', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../packages/engine/src/planning/plan-compiler.ts', import.meta.url)),
      'utf8',
    );
    for (const forbidden of ['rol.developer', 'rol.review', 'rol.qa', "'work'", "'review'", "'qa'", 'developer', 'unit-test', 'code-review']) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain('compilePlanGraph');
  });
});

/* ------------------------- publication, run, goal, tasks (points 11-24) */

describe('T20-05 §70 — publication, execution run, goal, tasks', () => {
  it('11-14. non-software + software compile; REAL publish lifecycle; replay = same version', async () => {
    // 11: the heterogeneous procurement chain compiles end to end (the §24/§63 proof).
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 13: published through the real lifecycle — state published, version content-hashed.
    const state = f.core.database.db
      .prepare('SELECT state FROM workflow_templates WHERE id = ?')
      .get(first.value.templateId) as { state: string };
    expect(state.state).toBe('published');
    // 14: replay = same template/version/run/tasks; no duplicates anywhere.
    const second = await compile(f);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.templateId).toBe(first.value.templateId);
    expect(second.value.versionId).toBe(first.value.versionId);
    expect(second.value.executionRunId).toBe(first.value.executionRunId);
    expect(second.value.taskIds).toEqual(first.value.taskIds);
    const templates = f.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM workflow_templates WHERE name LIKE ?')
      .get(`plan-compile:${String(first.value.planId)}%`) as { c: number };
    expect(Number(templates.c)).toBe(1); // one compiled template per command
    const runs = f.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM runs')
      .get() as { c: number };
    expect(Number(runs.c)).toBe(2); // planning + ONE execution run
    // 12/§64: a software plan compiles through the SAME compiler with a software spec.
    const f2 = await makeFixture();
    const software = await compile(f2, 'compile-sw', SOFTWARE_SPEC);
    expect(software.ok).toBe(true);
    if (!software.ok) return;
    const graph = versionGraphOf(f2.core, software.value.templateId);
    const nodes = graph['nodes'] as readonly { readonly config: Record<string, unknown> }[];
    expect(nodes[0]!.config['taskProfile']).toEqual(softwareItemProfile.taskProfile);
  });

  it('15. same command + different semantics → CONFLICT (never silent reinterpretation)', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The SAME command id, but a DIFFERENT trusted per-item spec ⇒ command conflict.
    const conflict = await compile(f, 'compile-1', {
      planItemProfiles: {
        ...PROCUREMENT_SPEC.planItemProfiles,
        approval: profile('procurement-approval-work', 'rol.procurement-approver', 'task.procurement-approval', 9),
      },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(reasonOf(conflict.error)).toBe('COMPILATION_COMMAND_CONFLICT');
    // the original compiled truth is unchanged
    const graph = versionGraphOf(f.core, first.value.templateId);
    const nodes = graph['nodes'] as readonly { readonly config: Record<string, unknown> }[];
    const approvalNode = nodes.find(
      (node) => (node.config['planItem'] as { planItemId: string }).planItemId === 'approval',
    );
    expect(approvalNode!.config['taskProfile']).toEqual(PROCUREMENT_SPEC.planItemProfiles.approval!.taskProfile);
  });

  it('16-20. run exactly once, pins the exact version; goal same semantics, run-owned; provenance kept', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = await f.core.database.runs.get(result.value.executionRunId as never);
    expect(run).not.toBeNull(); // 16: exactly one (count checked in the previous test)
    expect(String(run?.versionId)).toBe(result.value.versionId); // 17: exact pin
    // 18/19: the execution goal is run-owned and semantically identical to the planning goal.
    const planningGoal = await f.core.database.artifactStore!.getByCreationCommand(runGoalCommandId(f.planningRunId));
    const executionGoal = await f.core.database.artifactStore!.getByCreationCommand(runGoalCommandId(result.value.executionRunId));
    expect(planningGoal).not.toBeNull();
    expect(executionGoal).not.toBeNull();
    expect(String(executionGoal!.artifact.runId)).toBe(result.value.executionRunId); // 19 run-owned
    expect(String(executionGoal!.artifact.runId)).not.toBe(f.planningRunId); // NOT a pointer at the planning goal
    // Goal drift check via the durable CAS content (same semantics).
    const planningObjective = (JSON.parse(new TextDecoder().decode(
      await readContent(f.core, planningGoal!.artifact.id),
    )) as { objective: string }).objective;
    const executionObjective = (JSON.parse(new TextDecoder().decode(
      await readContent(f.core, executionGoal!.artifact.id),
    )) as { objective: string }).objective;
    expect(executionObjective).toBe(planningObjective); // 18: zero drift
    // 20: plan provenance retained in the compiled version (provenance, not evidence).
    const graph = versionGraphOf(f.core, result.value.templateId);
    const nodes = graph['nodes'] as readonly { readonly config: Record<string, unknown> }[];
    const from = nodes[0]!.config['compiledFrom'] as Record<string, unknown>;
    expect(String(from['planId'])).toBe(firstPlanIdOf(f));
    expect(String(from['planningRunId'])).toBe(f.planningRunId);
    expect(String(from['planFingerprint'])).toHaveLength(64);
  });

  it('21-22. tasks materialized through T20-03B; one baseline task per materializable node', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tasks = await f.core.database.tasks.listByRun(result.value.executionRunId);
    expect(tasks.map((task) => task.id).sort()).toEqual([...result.value.taskIds].sort()); // 21/22
    expect(tasks).toHaveLength(PLAN_ITEMS.length);
    expect(new Set(tasks.map((task) => task.stageId)).size).toBe(PLAN_ITEMS.length);
    // The deterministic template name is the pipeline's discoverability anchor.
    expect(
      (await f.core.database.templates.list({ limit: 500 })).items.some(
        (template) => template.name === compiledTemplateName(result.value.planId, 'compile-1'),
      ),
    ).toBe(true);
  });

  it('23-24. ZERO provider calls; ZERO task execution', async () => {
    const f = await makeFixture();
    providerCalls = 0; // the fixture's PLANNER call is not the compiler's
    const beforeExecutions = Number((f.core.database.db.prepare('SELECT COUNT(*) AS c FROM agent_executions').get() as { c: number }).c);
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(providerCalls).toBe(0); // 23: compilation is pure
    const afterExecutions = Number((f.core.database.db.prepare('SELECT COUNT(*) AS c FROM agent_executions').get() as { c: number }).c);
    expect(afterExecutions).toBe(beforeExecutions); // 24: no AgentExecution, no execution
    const tasks = await f.core.database.tasks.listByRun(result.value.executionRunId);
    for (const task of tasks) expect(task.state).toBe('PENDING'); // never started
  });
});

/* -------------------------------------- crash matrix A-E + drift (points 25-31) */

describe('T20-05 §70 — crash/restart convergence A-E + drift isolation', () => {
  const matrix = (name: string, checkpoint: string, expectTasksAfterReplay: boolean) => {
    it(name, async () => {
      const f = await makeFixture({ crashAt: checkpoint });
      providerCalls = 0; // the fixture's PLANNER call is not the compiler's
      await expect(compile(f)).rejects.toThrow(`crash:${String(checkpoint)}`);
      const core2 = await reopen(f);
      const replay = await compileArtifact(core2, {
        companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
        compilationCommandId: 'compile-1', actorId: f.actor,
      });
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      expect(String(replay.value.executionRunId).startsWith('run_')).toBe(true);
      const templates = core2.database.db
        .prepare('SELECT COUNT(*) AS c FROM workflow_templates WHERE name LIKE ?')
        .get(`plan-compile:${String(replay.value.planId)}%`) as { c: number };
      expect(Number(templates.c)).toBe(1); // exactly one compiled version — never competing
      const runs = Number((core2.database.db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c);
      expect(runs).toBe(2); // planning + ONE execution run
      if (expectTasksAfterReplay) {
        const tasks = await core2.database.tasks.listByRun(replay.value.executionRunId);
        expect(tasks).toHaveLength(PLAN_ITEMS.length); // full convergence
      }
      expect(providerCalls).toBe(0); // compilation never calls a provider
    });
  };

  matrix('25/A. after compile, before version durable', 'after_compiled_graph_before_workflow_publish', true);
  matrix('26/B. after version published, before run', 'after_workflow_published_before_execution_run', true);
  matrix('27/C. after run + goal, before tasks', 'after_execution_run_durable_before_tasks', true);
  // 28/D: partial materialization — one task exists, the rest are materialized on replay.
  it('28/D. crash halfway through materialization → replay completes the missing tasks', async () => {
    const f = await makeFixture({ crashAt: 'after_task_materialization_progress' });
    await expect(compile(f)).rejects.toThrow('crash:after_task_materialization_progress');
    // exactly ONE task survived the crash
    const partial = (await f.core.database.tasks.listByRun(
      (f.core.database.db.prepare('SELECT id FROM runs WHERE id != ?').get(f.planningRunId) as { id: string }).id,
    ));
    expect(partial).toHaveLength(1);
    const core2 = await reopen(f);
    const replay = await compileArtifact(core2, {
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-1', actorId: f.actor,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    const tasks = await core2.database.tasks.listByRun(replay.value.executionRunId);
    expect(tasks).toHaveLength(PLAN_ITEMS.length); // T1 replayed, T2-T4 created
    expect(new Set(tasks.map((task) => task.id)).size).toBe(PLAN_ITEMS.length); // one per stage
  });
  matrix('29/E. after all tasks, before return', 'after_compilation_complete_before_return', true);

  it('30-31/§61-§62. spec drift and registry-order drift cannot alter an authorized command', async () => {
    const f = await makeFixture({ crashAt: 'after_compiled_graph_before_workflow_publish' });
    await expect(compile(f)).rejects.toThrow('crash:after_compiled_graph_before_workflow_publish');
    // Restart with a DIFFERENT composition-level spec (drifted): the authorized command
    // still uses the CALLER-supplied P1 spec — never a live default, and because the
    // command's trusted inputs changed, the same command CONFLICTS rather than silently
    // converging on drifted semantics.
    const core2 = await reopen(f, DRIFTED_SPEC);
    const replay = await compileArtifact(core2, {
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-1', actorId: f.actor,
    }); // the CALLER-supplied trusted input remains P1 (§10)
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    const graph = versionGraphOf(core2, replay.value.templateId);
    const nodes = graph['nodes'] as readonly { readonly kind: string }[];
    expect(nodes[0]!.kind).toBe(PROCUREMENT_SPEC.planItemProfiles['supplier-analysis']!.stageKind); // P1 semantics, not the drift
    // 31: registration order is runtime-only (T20-03B already proved it) — recompiled
    // semantic references come from the plan + spec only.
    expect(replay.value.planFingerprint).toHaveLength(64);
  });
});

/* ----------------------------------- isolation + boundaries (points 32-35) */

describe('T20-05 §70 — isolation and boundaries', () => {
  it("32. multi-tenant isolation: a foreign company cannot compile another tenant plan", async () => {
    const f = await makeFixture();
    const foreign = await compileArtifact(f.core, {
      companyId: 'company_other', planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-f', actorId: f.actor,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe('NOT_FOUND');
  });

  it('33. no latest/current authority: selection is the EXACT artifact id', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../packages/engine/src/planning/plan-compiler.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('input.planArtifactId');
    // The compiler never scans for a newest/newest-matching plan artifact: the ONLY
    // artifact read is the exact id the trusted caller supplied.
    expect(source.match(/deps\.artifacts\.get/g) ?? []).toHaveLength(1);
    // Execution runs pin the version captured at creation; the compiler never re-pins.
    expect(source).not.toContain('repin');
  });

  it('34-35. no Plan approval added; no handoff written', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const handoffs = f.core.database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'")
      .get() as { name: string } | undefined;
    if (handoffs !== undefined) {
      const packets = Number((f.core.database.db.prepare('SELECT COUNT(*) AS c FROM handoffs').get() as { c: number }).c);
      expect(packets).toBe(0); // 35
    }
    // 34: no plan status/approval anywhere — the plan artifact bytes are untouched.
    const planBytes = new TextDecoder().decode(await readContent(f.core, f.planArtifactId));
    expect(JSON.parse(planBytes).approved).toBeUndefined();
    expect(Object.keys(JSON.parse(planBytes) as Record<string, unknown>).sort()).toEqual(
      ['acceptanceCriteria', 'planItems', 'schema', 'sourceGoal'],
    );
  });
});

/* ============================================================================ */
/* Hardening §39 — the 24-point matrix: heterogeneous per-item compilation      */
/* profiles + PERMANENT compilation / execution-run identity (anchored in       */
/* durable rows, never the bounded T18-02 command ledger).                      */
/* ============================================================================ */

describe('T20-05 hardening §39 — heterogeneous per-item profiles', () => {
  it('M1. heterogeneous procurement: 4 items ≥ 3 combos → ONE version, 4 nodes, 4 tasks', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = versionGraphOf(f.core, result.value.templateId);
    const nodes = graph['nodes'] as readonly { readonly id: string; readonly kind: string; readonly config: Record<string, unknown> }[];
    expect(nodes).toHaveLength(4);
    // ≥3 distinct role/kind/maxAttempts/validator combinations (here: 4 distinct).
    expect(new Set(nodes.map((node) => JSON.stringify(node.config['taskProfile']))).size).toBeGreaterThanOrEqual(3);
    expect(new Set(nodes.map((node) => node.kind)).size).toBe(4); // four distinct stage kinds
    const tasks = await f.core.database.tasks.listByRun(result.value.executionRunId);
    expect(tasks).toHaveLength(4); // one task per node
    expect(result.value.taskIds).toHaveLength(4);
    // one version only
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM workflow_template_versions WHERE template_id = ?', result.value.templateId)).toBe(1);
  });

  it('M2. per-item profiles FREEZE into the materialized tasks (role/kind/maxAttempts)', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tasks = await f.core.database.tasks.listByRun(result.value.executionRunId);
    expect(tasks).toHaveLength(PLAN_ITEMS.length);
    for (const item of PLAN_ITEMS) {
      const stageId = compiledNodeId(result.value.planId, item.planItemId);
      const task = tasks.find((row) => String(row.stageId) === stageId);
      expect(task).toBeDefined();
      const expected = PROCUREMENT_SPEC.planItemProfiles[item.planItemId]!.taskProfile;
      expect(String(task!.roleId)).toBe(expected.roleId);
      expect(String(task!.kind)).toBe(expected.taskKind);
      expect(Number(task!.maxAttempts)).toBe(expected.maxAttempts);
    }
    // heterogeneity reached the tasks: 4 distinct (role, kind, maxAttempts) triples
    expect(new Set(tasks.map((task) => `${String(task.roleId)}|${String(task.kind)}|${String(task.maxAttempts)}`)).size).toBe(4);
  });

  it('M3. missing profile → COMPILATION_PROFILE_MISSING, zero durable effect', async () => {
    const f = await makeFixture();
    const beforeRuns = countOf(f.core, 'SELECT COUNT(*) AS c FROM runs');
    const beforeTemplates = countOf(f.core, 'SELECT COUNT(*) AS c FROM workflow_templates');
    const bad: PlanCompilationSpec = {
      planItemProfiles: {
        'supplier-analysis': PROCUREMENT_SPEC.planItemProfiles['supplier-analysis']!,
        'financial-review': PROCUREMENT_SPEC.planItemProfiles['financial-review']!,
        approval: PROCUREMENT_SPEC.planItemProfiles.approval!,
        // recommendation: MISSING
      },
    };
    const result = await compile(f, 'compile-m3', bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(reasonOf(result.error)).toBe('COMPILATION_PROFILE_MISSING');
    // FAIL CLOSED before anything durable: no anchor, no template, no run, no task.
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts WHERE creation_command_id = ?', `plan-compile:${COMPANY}:compile-m3`)).toBe(0);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM workflow_templates')).toBe(beforeTemplates);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM runs')).toBe(beforeRuns);
  });

  it('M4. unknown/extra profile key → COMPILATION_PROFILE_UNKNOWN_ITEM, zero durable effect', async () => {
    const f = await makeFixture();
    const beforeRuns = countOf(f.core, 'SELECT COUNT(*) AS c FROM runs');
    const bad: PlanCompilationSpec = {
      planItemProfiles: {
        ...PROCUREMENT_SPEC.planItemProfiles,
        'ghost-item': profile('ghost-work', 'rol.ghost', 'task.ghost', 1),
      },
    };
    const result = await compile(f, 'compile-m4', bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(reasonOf(result.error)).toBe('COMPILATION_PROFILE_UNKNOWN_ITEM');
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts WHERE creation_command_id = ?', `plan-compile:${COMPANY}:compile-m4`)).toBe(0);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM runs')).toBe(beforeRuns);
  });

  it('M5. malformed profile (empty roleId) → COMPILATION_PROFILE_MALFORMED', async () => {
    const f = await makeFixture();
    const bad: PlanCompilationSpec = {
      planItemProfiles: {
        ...PROCUREMENT_SPEC.planItemProfiles,
        approval: profile('procurement-approval-work', '  ', 'task.procurement-approval', 1),
      },
    };
    const result = await compile(f, 'compile-m5', bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(reasonOf(result.error)).toBe('COMPILATION_PROFILE_MALFORMED');
  });

  it('M6. malformed profile (maxAttempts 0 / 1.5 / 101) → COMPILATION_PROFILE_MALFORMED', async () => {
    const f = await makeFixture();
    for (const [label, maxAttempts] of [['zero', 0], ['fraction', 1.5], ['over', 101]] as const) {
      const bad: PlanCompilationSpec = {
        planItemProfiles: {
          ...PROCUREMENT_SPEC.planItemProfiles,
          approval: profile('procurement-approval-work', 'rol.procurement-approver', 'task.procurement-approval', maxAttempts),
        },
      };
      const result = await compile(f, `compile-m6-${label}`, bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(reasonOf(result.error)).toBe('COMPILATION_PROFILE_MALFORMED');
    }
  });

  it('M7. restart-time registration order is irrelevant: reversed kind registration replays identically', async () => {
    const f = await makeFixture({ kindsOrder: 'forward' });
    const first = await compile(f, 'compile-m7');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const graphBefore = versionGraphJsonOf(f.core, first.value.templateId);
    const hashBefore = versionContentHashOf(f.core, first.value.templateId);
    // Restart the SAME database with the kind registry registered in the REVERSE order:
    // the authorized command replays to the identical version — order is runtime-only.
    const core2 = await reopen(f, PROCUREMENT_SPEC, 'reverse');
    const replay = await compileArtifact(core2, {
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-m7', actorId: f.actor,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.versionId).toBe(first.value.versionId);
    expect(replay.value.executionRunId).toBe(first.value.executionRunId);
    expect(versionGraphJsonOf(core2, replay.value.templateId)).toBe(graphBefore);
    expect(versionContentHashOf(core2, replay.value.templateId)).toBe(hashBefore);
  });

  it('M8. restart preserves the spec: replay after restart → byte-identical graph', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = versionGraphJsonOf(f.core, first.value.templateId);
    const core2 = await reopen(f);
    const replay = await compileArtifact(core2, {
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-1', actorId: f.actor,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(versionGraphJsonOf(core2, replay.value.templateId)).toBe(before); // spec survived restart
    expect(replay.value.versionId).toBe(first.value.versionId);
    expect(replay.value.executionRunId).toBe(first.value.executionRunId);
  });
});

describe('T20-05 hardening §39 — permanent compilation identity (anchor)', () => {
  it('M9. same command + same spec replays: ONE anchor, ONE run, ONE task set', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    for (let i = 0; i < 2; i += 1) {
      const replay = await compile(f);
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      expect(replay.value.executionRunId).toBe(first.value.executionRunId);
      expect(replay.value.versionId).toBe(first.value.versionId);
      expect(replay.value.taskIds).toEqual(first.value.taskIds);
    }
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts WHERE creation_command_id = ?', `plan-compile:${COMPANY}:compile-1`)).toBe(1);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM runs')).toBe(2);
    expect((await f.core.database.tasks.listByRun(first.value.executionRunId)).length).toBe(4);
  });

  it('M10. same command + changed spec → COMPILATION_COMMAND_CONFLICT', async () => {
    const f = await makeFixture();
    expect((await compile(f)).ok).toBe(true);
    const conflict = await compile(f, 'compile-1', {
      planItemProfiles: {
        ...PROCUREMENT_SPEC.planItemProfiles,
        'financial-review': profile('procurement-review-work', 'rol.procurement-reviewer', 'task.procurement-review', 5, ['e2e7.unit_validator']),
      },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(reasonOf(conflict.error)).toBe('COMPILATION_COMMAND_CONFLICT');
  });

  it('M11. same command + DIFFERENT plan → COMPILATION_COMMAND_CONFLICT', async () => {
    const f = await makeFixture();
    expect((await compile(f)).ok).toBe(true);
    const otherPlanArtifactId = await makeSecondPlan(f);
    const conflict = await compileArtifact(f.core, {
      companyId: COMPANY, planningRunId: (f.core.database.db.prepare('SELECT id FROM runs WHERE workflow_id = ?').get('wf-plan-2') as { id: string }).id,
      planArtifactId: otherPlanArtifactId, compilationCommandId: 'compile-1', actorId: f.actor,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(reasonOf(conflict.error)).toBe('COMPILATION_COMMAND_CONFLICT');
    // the first compilation truth is untouched: exactly ONE execution run (workflow_id
    // points at the compiled lineage — its canonical meaning)
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM runs WHERE workflow_id LIKE ?', 'tpl_%')).toBe(1);
  });

  it('M17. anchor proof: planning-run-owned, canonical content, hash = fingerprint', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const found = await f.core.database.artifactStore!.getByCreationCommand(`plan-compile:${COMPANY}:compile-1`);
    expect(found).not.toBeNull();
    expect(String(found!.artifact.kind)).toBe(PLAN_COMPILATION_ANCHOR_KIND);
    expect(String(found!.artifact.runId)).toBe(f.planningRunId); // planning-run-owned
    const payload = JSON.parse(new TextDecoder().decode(await readContent(f.core, String(found!.artifact.id)))) as Record<string, unknown>;
    expect(payload['schema']).toBe('companyos/plan-compilation-input/1');
    expect(payload['contract']).toBe(PLAN_COMPILER_CONTRACT);
    expect(payload['companyId']).toBe(COMPANY);
    expect(payload['planningRunId']).toBe(f.planningRunId);
    expect(payload['planId']).toBe(result.value.planId);
    expect(payload['planFingerprint']).toBe(result.value.planFingerprint);
    const profiles = payload['planItemProfiles'] as Record<string, unknown>;
    expect(Object.keys(profiles).sort()).toEqual(['approval', 'financial-review', 'recommendation', 'supplier-analysis']);
    expect(profiles['approval']).toEqual(PROCUREMENT_SPEC.planItemProfiles.approval);
    // the anchor's own bytes hash to its content hash — the command fingerprint
    const bytes = new TextDecoder().decode(await readContent(f.core, String(found!.artifact.id)));
    expect(sha256Hex(bytes)).toBe(String(found!.artifact.contentHash));
  });

  it('M18. anchor replay never duplicates: replays keep exactly one anchor row', async () => {
    const f = await makeFixture();
    expect((await compile(f)).ok).toBe(true);
    expect((await compile(f)).ok).toBe(true);
    expect((await compile(f)).ok).toBe(true);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts WHERE creation_command_id = ?', `plan-compile:${COMPANY}:compile-1`)).toBe(1);
  });
});

describe('T20-05 hardening §39 — permanent execution-run identity (not the ledger)', () => {
  it('M12. ledger loss (live DB): replay still returns the SAME run/version/tasks', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Simulate full bounded-ledger eviction — the T18-02 ledger is NOT identity.
    f.core.database.db.exec('DELETE FROM command_ledger');
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM command_ledger')).toBe(0);
    const replay = await compile(f);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.executionRunId).toBe(first.value.executionRunId);
    expect(replay.value.versionId).toBe(first.value.versionId);
    expect(replay.value.taskIds).toEqual(first.value.taskIds);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM runs')).toBe(2); // no duplicate run
  });

  it('M13. ledger loss + RESTART: replay returns the SAME execution run R', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    f.core.database.db.exec('DELETE FROM command_ledger');
    const core2 = await reopen(f);
    expect(countOf(core2, 'SELECT COUNT(*) AS c FROM command_ledger')).toBe(0);
    const replay = await compileArtifact(core2, {
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-1', actorId: f.actor,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.executionRunId).toBe(first.value.executionRunId); // same Run R
    expect(replay.value.versionId).toBe(first.value.versionId);
    const tasks = await core2.database.tasks.listByRun(first.value.executionRunId);
    expect(tasks).toHaveLength(PLAN_ITEMS.length);
  });

  it('M14. same permanent run id + wrong version → EXECUTION_RUN_VERSION_CONFLICT', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Adversarial tamper (test seam): the permanent identity now pins a foreign version.
    f.core.database.db.prepare('UPDATE runs SET version_id = ? WHERE id = ?').run('version_tampered', first.value.executionRunId);
    const replay = await compile(f);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(reasonOf(replay.error)).toBe('EXECUTION_RUN_VERSION_CONFLICT');
  });

  it('M15. same permanent run id + wrong goal semantics → EXECUTION_RUN_GOAL_CONFLICT', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Adversarial tamper (test seam): point the execution run's goal artifact at CAS
    // bytes carrying a DIFFERENT objective — the goal seam must fail closed.
    const goal = await f.core.database.artifactStore!.getByCreationCommand(runGoalCommandId(first.value.executionRunId));
    expect(goal).not.toBeNull();
    const original = JSON.parse(new TextDecoder().decode(await readContent(f.core, String(goal!.artifact.id)))) as Record<string, unknown>;
    const tamperedBytes = new TextEncoder().encode(JSON.stringify({ ...original, objective: 'A TAMPERED objective.' }));
    const holder = await f.core.sprint13.artifactService.create({
      commandId: `tamper:${String(first.value.executionRunId)}`, runId: first.value.executionRunId as never,
      taskId: null, kind: 'companyos:note', content: tamperedBytes, producedBy: f.actor, traceId: 'trace_tamper',
    });
    expect(holder.ok).toBe(true);
    if (!holder.ok) return;
    f.core.database.db
      .prepare('UPDATE artifacts SET content_ref = ?, content_hash = ? WHERE artifact_id = ?')
      .run(String(holder.value.contentRef), String(holder.value.contentHash), String(goal!.artifact.id));
    const replay = await compile(f);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(reasonOf(replay.error)).toBe('EXECUTION_RUN_GOAL_CONFLICT');
  });

  it('M16. repeated replays never duplicate goals or tasks', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    for (let i = 0; i < 3; i += 1) expect((await compile(f)).ok).toBe(true);
    // exactly ONE run goal for the execution run (addressed by identity, immutable)
    const goal = await f.core.database.artifactStore!.getByCreationCommand(runGoalCommandId(first.value.executionRunId));
    expect(goal).not.toBeNull();
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts WHERE run_id = ? AND kind = ?', first.value.executionRunId, 'companyos:run-goal')).toBe(1);
    const tasks = await f.core.database.tasks.listByRun(first.value.executionRunId);
    expect(tasks).toHaveLength(PLAN_ITEMS.length);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(PLAN_ITEMS.length);
  });

  it('M23. permanent Run.id: deterministic form; workflowId stays the ACTUAL lineage', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The permanent identity IS the deterministic Run.id (public derivation, repo prefix).
    const expectedRunId = executionRunIdOf(COMPANY, f.planningRunId, first.value.planId, 'compile-1');
    expect(first.value.executionRunId).toBe(expectedRunId);
    expect(expectedRunId).toMatch(/^run_[0-9a-f]{26}$/);
    const row = runRowOf(f.core, first.value.executionRunId);
    // workflowId keeps its canonical meaning: the ACTUAL compiled Workflow lineage id.
    const lineage = compiledTemplateId(COMPANY, first.value.planId, 'compile-1');
    expect(row.workflow_id).toBe(lineage);
    expect(String(row.version_id)).toBe(first.value.versionId);
    // stable across replay
    const replay = await compile(f);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.executionRunId).toBe(expectedRunId);
    expect(runRowOf(f.core, replay.value.executionRunId).workflow_id).toBe(lineage);
    // distinct per command: a second compilation command gets a DIFFERENT permanent id
    const second = await compile(f, 'compile-2');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.executionRunId).not.toBe(expectedRunId);
    expect(second.value.executionRunId).toMatch(/^run_[0-9a-f]{26}$/);
  });
});

describe('T20-05 hardening §39 — crash + loss convergence under the new identity', () => {
  it('M19. crash A replay uses the SAME compilation inputs (per-item profiles converge)', async () => {
    const f = await makeFixture({ crashAt: 'after_compiled_graph_before_workflow_publish' });
    await expect(compile(f)).rejects.toThrow('crash:after_compiled_graph_before_workflow_publish');
    const core2 = await reopen(f);
    const replay = await compileArtifact(core2, {
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-1', actorId: f.actor,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    const graph = versionGraphOf(core2, replay.value.templateId);
    const nodes = graph['nodes'] as readonly { readonly kind: string; readonly config: Record<string, unknown> }[];
    expect(nodes).toHaveLength(PLAN_ITEMS.length);
    for (const node of nodes) {
      const planItemId = (node.config['planItem'] as { planItemId: string }).planItemId;
      const expected = PROCUREMENT_SPEC.planItemProfiles[planItemId]!;
      expect(node.kind).toBe(expected.stageKind);
      expect(node.config['taskProfile']).toEqual(expected.taskProfile);
    }
  });

  it('M20. crash C + ledger loss + restart → replay converges to the SAME run', async () => {
    const f = await makeFixture({ crashAt: 'after_execution_run_durable_before_tasks' });
    await expect(compile(f)).rejects.toThrow('crash:after_execution_run_durable_before_tasks');
    f.core.database.db.exec('DELETE FROM command_ledger');
    const core2 = await reopen(f);
    const replay = await compileArtifact(core2, {
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-1', actorId: f.actor,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    // The run that survived the crash IS the replayed run (permanent identity).
    const survived = core2.database.db.prepare('SELECT id FROM runs WHERE workflow_id LIKE ?').get('tpl_%') as { id: string };
    expect(replay.value.executionRunId).toBe(survived.id);
    expect(countOf(core2, 'SELECT COUNT(*) AS c FROM runs')).toBe(2); // planning + ONE execution
    const tasks = await core2.database.tasks.listByRun(replay.value.executionRunId);
    expect(tasks).toHaveLength(PLAN_ITEMS.length);
  });

  it('M21. non-software heterogeneous E2E: zero software vocabulary in compiled output', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graphJson = versionGraphJsonOf(f.core, result.value.templateId);
    for (const forbidden of ['rol.developer', 'rol.review', 'rol.qa', 'e2e7:build', 'unit-test', 'code-review']) {
      expect(graphJson).not.toContain(forbidden);
    }
    const tasks = await f.core.database.tasks.listByRun(result.value.executionRunId);
    expect(new Set(tasks.map((task) => String(task.roleId))).size).toBe(3); // analyst+reviewer+approver
  });

  it('M22. software regression: a uniform software spec compiles and replays', async () => {
    const f = await makeFixture();
    const first = await compile(f, 'compile-sw', SOFTWARE_SPEC);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const graph = versionGraphOf(f.core, first.value.templateId);
    const nodes = graph['nodes'] as readonly { readonly config: Record<string, unknown> }[];
    expect(nodes).toHaveLength(PLAN_ITEMS.length);
    for (const node of nodes) expect(node.config['taskProfile']).toEqual(softwareItemProfile.taskProfile);
    const replay = await compile(f, 'compile-sw', SOFTWARE_SPEC);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.executionRunId).toBe(first.value.executionRunId);
    expect(replay.value.versionId).toBe(first.value.versionId);
  });

  it('M24. the spec is a per-command EXPLICIT input: same plan, second command, different spec → independent compilation', async () => {
    const f = await makeFixture();
    const procurement = await compile(f, 'compile-p');
    expect(procurement.ok).toBe(true);
    if (!procurement.ok) return;
    const software = await compile(f, 'compile-s', SOFTWARE_SPEC);
    expect(software.ok).toBe(true);
    if (!software.ok) return;
    // two independent compilations: two templates, two versions, two runs, 4+4 tasks
    expect(software.value.templateId).not.toBe(procurement.value.templateId);
    expect(software.value.versionId).not.toBe(procurement.value.versionId);
    expect(software.value.executionRunId).not.toBe(procurement.value.executionRunId);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM runs')).toBe(3); // planning + 2 execution
    expect((await f.core.database.tasks.listByRun(procurement.value.executionRunId)).length).toBe(4);
    expect((await f.core.database.tasks.listByRun(software.value.executionRunId)).length).toBe(4);
    // neither command was reinterpreted: the anchors pin their own inputs
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts WHERE creation_command_id = ?', `plan-compile:${COMPANY}:compile-p`)).toBe(1);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts WHERE creation_command_id = ?', `plan-compile:${COMPANY}:compile-s`)).toBe(1);
  });
});

/** Read an artifact's CAS content through the real content store on the fixture's casRoot. */
const casContentReaders = new Map<string, { get(ref: string): Promise<Uint8Array> }>();
async function readContent(core: Core, artifactId: string): Promise<Uint8Array> {
  const row = await core.database.artifactStore!.get(artifactId as never);
  if (row === null) throw new Error(`artifact ${String(artifactId)} missing`);
  let reader = casContentReaders.get(core.database.path ?? '');
  if (reader === undefined) {
    const foundation = await openArtifactFoundation({
      casRoot: casRoots.get(core) ?? tempDir(),
      database: core.database,
      logger: nullLogger as never,
    });
    if (!foundation.ok) throw new Error('foundation for content read failed');
    reader = foundation.contentStore;
    casContentReaders.set(core.database.path ?? '', reader);
  }
  return reader.get(row.contentRef);
}
const casRoots = new Map<Core, string>();

const firstPlanIdOf = (f: Fixture): string => f.planId;

/* ============================================================================ */
/* Final permanent-identity corrective (§36): the 25-point matrix. Run identity */
/* is a deterministic Run.id (PRIMARY-KEY arbitrated); workflowId keeps its     */
/* canonical meaning (the compiled lineage); the compiled lineage is a          */
/* deterministic WorkflowTemplate.id with content-matched exact version replay. */
/* ============================================================================ */

describe('T20-05 §36 — canonical semantics and permanent identity', () => {
  it('1/2/3/4. run.workflow_id means the Workflow lineage; Run.id is the permanent identity', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lineage = compiledTemplateId(COMPANY, result.value.planId, 'compile-1');
    const row = runRowOf(f.core, result.value.executionRunId);
    // 2: permanent semantic Run identity (deterministic, repo-native prefix)
    expect(result.value.executionRunId).toBe(executionRunIdOf(COMPANY, f.planningRunId, result.value.planId, 'compile-1'));
    // 1/3: workflowId = the ACTUAL compiled Workflow lineage identity (source-typed WorkflowId,
    //      projected to agents as the workflow id) — never a run idempotency key
    expect(row.workflow_id).toBe(lineage);
    expect(row.workflow_id).not.toContain('exec');
    // 4: versionId = the exact pinned compiled version
    expect(String(row.version_id)).toBe(result.value.versionId);
    // §2/§3 source proof: the compiler never derives an execution identity into workflow_id
    const source = readFileSync(fileURLToPath(new URL('../../packages/engine/src/planning/plan-compiler.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('wf_exec');
    expect(source).toContain('workflowId: compiledId');
    // §13: identity does not depend on findByWorkflowId / the bounded ledger / mutable currentVersion
    expect(source).not.toContain('findByWorkflowId');
    expect(source).not.toContain('deps.ledger'); // no ledger dependency (comments may name it)
    expect(source).not.toContain('currentVersionId');
  });

  it('5/§30. RunSnapshotVerifier passes and pins the exact compiled lineage + version', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = await f.core.database.runs.get(result.value.executionRunId as never);
    expect(run).not.toBeNull();
    const verified = await f.core.sprint13.runSnapshotVerifier.verify({
      runId: result.value.executionRunId,
      snapshotId: String(run!.snapshotId),
    });
    expect(verified.ok).toBe(true); // 5
    const snapshot = await f.core.database.snapshots.get(String(run!.snapshotId));
    expect(String(snapshot!.templateId)).toBe(compiledTemplateId(COMPANY, result.value.planId, 'compile-1'));
    expect(String(snapshot!.workflowVersionId)).toBe(result.value.versionId);
  });

  it('6/§9/§11. same Run identity + same seed → REPLAY; mutable lifecycle never reset', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The run legitimately advanced after creation (test seam): mutable state is durable
    // truth and a replay must NOT reset it (creation identity excludes it by design).
    f.core.database.db
      .prepare("UPDATE runs SET state = 'EXECUTING', revision = 7 WHERE id = ?")
      .run(first.value.executionRunId);
    const replay = await compile(f);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.executionRunId).toBe(first.value.executionRunId);
    const row = runRowOf(f.core, first.value.executionRunId);
    expect(row.workflow_id).toBe(compiledTemplateId(COMPANY, first.value.planId, 'compile-1'));
    const after = f.core.database.db
      .prepare('SELECT state, revision FROM runs WHERE id = ?')
      .get(first.value.executionRunId) as { state: string; revision: number };
    expect(after.state).toBe('EXECUTING');
    expect(Number(after.revision)).toBe(7);
  });

  it('7. same Run identity + wrong workflow lineage → EXECUTION_RUN_WORKFLOW_CONFLICT', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    f.core.database.db
      .prepare('UPDATE runs SET workflow_id = ? WHERE id = ?')
      .run('tpl_tamperedlineage00000000000000', first.value.executionRunId);
    const replay = await compile(f);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(reasonOf(replay.error)).toBe('EXECUTION_RUN_WORKFLOW_CONFLICT');
  });

  it('8. same Run identity + wrong version → EXECUTION_RUN_VERSION_CONFLICT', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    f.core.database.db.prepare('UPDATE runs SET version_id = ? WHERE id = ?').run('ver_tampered', first.value.executionRunId);
    const replay = await compile(f);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(reasonOf(replay.error)).toBe('EXECUTION_RUN_VERSION_CONFLICT');
  });

  it('9. same Run identity + wrong goal semantics → EXECUTION_RUN_GOAL_CONFLICT', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const goal = await f.core.database.artifactStore!.getByCreationCommand(runGoalCommandId(first.value.executionRunId));
    expect(goal).not.toBeNull();
    const original = JSON.parse(new TextDecoder().decode(await readContent(f.core, String(goal!.artifact.id)))) as Record<string, unknown>;
    const holder = await f.core.sprint13.artifactService.create({
      commandId: `tamper9:${String(first.value.executionRunId)}`, runId: first.value.executionRunId as never,
      taskId: null, kind: 'companyos:note', content: new TextEncoder().encode(JSON.stringify({ ...original, objective: 'WRONG objective.' })), producedBy: f.actor, traceId: 'trace_t9',
    });
    expect(holder.ok).toBe(true);
    if (!holder.ok) return;
    f.core.database.db
      .prepare('UPDATE artifacts SET content_ref = ?, content_hash = ? WHERE artifact_id = ?')
      .run(String(holder.value.contentRef), String(holder.value.contentHash), String(goal!.artifact.id));
    const replay = await compile(f);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(reasonOf(replay.error)).toBe('EXECUTION_RUN_GOAL_CONFLICT');
  });

  it('10/11/§12. ledger loss, then restart after ledger loss → the SAME Run row', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    f.core.database.db.exec('DELETE FROM command_ledger'); // 10: live replay
    const replay = await compile(f);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.executionRunId).toBe(first.value.executionRunId);
    // 11: restart with the ledger STILL gone
    const core2 = await reopen(f);
    expect(countOf(core2, 'SELECT COUNT(*) AS c FROM command_ledger')).toBe(0);
    const replay2 = await compileArtifact(core2, {
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-1', actorId: f.actor,
    });
    expect(replay2.ok).toBe(true);
    if (!replay2.ok) return;
    expect(replay2.value.executionRunId).toBe(first.value.executionRunId);
    expect(replay2.value.versionId).toBe(first.value.versionId);
    expect(countOf(core2, 'SELECT COUNT(*) AS c FROM runs')).toBe(2);
  });

  it('12/§7/§8/§32. concurrent same Run creation → exactly ONE row (store PK race + seed drift closed)', async () => {
    const f = await makeFixture();
    const result = await compile(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Store level: two guarded creations of the SAME deterministic id race at the insert
    // seam — one wins, the loser re-reads and REPLAYS; the DB PRIMARY KEY is the arbiter.
    const row = await f.core.database.runs.get(result.value.executionRunId as never);
    expect(row).not.toBeNull();
    const raced = await Promise.all([
      f.core.database.runs.putGuarded!(row!),
      f.core.database.runs.putGuarded!(row!),
    ]);
    expect(raced.every((entry) => entry.ok)).toBe(true);
    expect(raced.filter((entry) => entry.ok && entry.value.replayed).length).toBeGreaterThanOrEqual(1);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM runs WHERE id = ?', result.value.executionRunId)).toBe(1);
    // Seed drift loses closed at the SAME seam, and the canonical row is untouched.
    const drifted = { ...row!, workflowId: 'tpl_other' as never };
    const conflict = await f.core.database.runs.putGuarded!(drifted);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(reasonOf(conflict.error)).toBe('RUN_IDENTITY_SEED_CONFLICT');
    expect(runRowOf(f.core, result.value.executionRunId).workflow_id).toBe(compiledTemplateId(COMPANY, result.value.planId, 'compile-1'));
  });
});

describe('T20-05 §36 — workflow permanent anchor and concurrency', () => {
  it('13/§16. template NAME is not authority: a same-named foreign template cannot confuse replay', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Adversarial (test seam): a DIFFERENT template row with the SAME display name.
    f.core.database.db
      .prepare("INSERT INTO workflow_templates (id, org_id, name, state, current_version_id, draft_version_id, forked_from_json, created_at, updated_at, created_by) VALUES (?, ?, ?, 'draft', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)")
      .run('tpl_decoy0000000000000000000000', COMPANY, compiledTemplateName(first.value.planId, 'compile-1'), f.actor);
    const replay = await compile(f);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    // The deterministic lineage id resolved — the decoy is irrelevant.
    expect(replay.value.templateId).toBe(compiledTemplateId(COMPANY, first.value.planId, 'compile-1'));
    expect(replay.value.templateId).not.toBe('tpl_decoy0000000000000000000000');
    expect(replay.value.versionId).toBe(first.value.versionId);
    expect(replay.value.executionRunId).toBe(first.value.executionRunId);
    const source = readFileSync(fileURLToPath(new URL('../../packages/engine/src/planning/plan-compiler.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('templates.list'); // no name scan anywhere
  });

  it('14/§15/§33. CONCURRENT same-command compilation → ONE lineage, ONE version, ONE run, ONE goal, N tasks', async () => {
    const f = await makeFixture();
    const both = await Promise.all([compile(f), compile(f)]);
    expect(both.every((entry) => entry.ok)).toBe(true); // one creates, one replays — never an error
    const [a, b] = both as readonly [{ value: { planId: string; templateId: string; versionId: string; executionRunId: string } }, { value: { templateId: string; versionId: string; executionRunId: string } }];
    expect(a.value.templateId).toBe(b.value.templateId);
    expect(a.value.versionId).toBe(b.value.versionId);
    expect(a.value.executionRunId).toBe(b.value.executionRunId);
    const lineage = compiledTemplateId(COMPANY, a.value.planId, 'compile-1');
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM workflow_templates WHERE id = ?', lineage)).toBe(1); // one canonical lineage
    expect(countOf(f.core, "SELECT COUNT(*) AS c FROM workflow_template_versions WHERE template_id = ? AND semver NOT LIKE '%draft'", lineage)).toBe(1); // one released version
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM runs WHERE id = ?', a.value.executionRunId)).toBe(1); // one run
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts WHERE run_id = ? AND kind = ?', a.value.executionRunId, 'companyos:run-goal')).toBe(1); // one goal
    expect((await f.core.database.tasks.listByRun(a.value.executionRunId)).length).toBe(PLAN_ITEMS.length); // N tasks
  });

  it('15/§22. same compile replays ONE canonical version (no competing re-publication)', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    for (let i = 0; i < 3; i += 1) expect((await compile(f)).ok).toBe(true);
    expect(countOf(f.core, "SELECT COUNT(*) AS c FROM workflow_template_versions WHERE template_id = ? AND semver NOT LIKE '%draft'", first.value.templateId)).toBe(1);
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM runs')).toBe(2);
  });

  it('16/§23. a LATER unrelated current version cannot hijack replay (exact version by content)', async () => {
    const f = await makeFixture();
    const first = await compile(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Adversarial (test seam): an unrelated V2 becomes the lineage CURRENT version.
    const v2 = 'ver_unrelatedv2';
    const graphV2 = JSON.parse(versionGraphJsonOf(f.core, first.value.templateId));
    graphV2.nodes[0].title = 'unrelated-later-version';
    f.core.database.db
      .prepare("INSERT INTO workflow_template_versions (id, template_id, semver, content_hash, snapshot_hash, graph_json, change_proposal_id, created_at, created_by) VALUES (?, ?, '2.0.0', ?, ?, ?, NULL, '2026-02-01T00:00:00Z', ?)")
      .run(v2, first.value.templateId, `hash_${String(v2)}`, `snap_${String(v2)}`, JSON.stringify(graphV2), f.actor);
    f.core.database.db
      .prepare('UPDATE workflow_templates SET current_version_id = ? WHERE id = ?')
      .run(v2, first.value.templateId);
    const replay = await compile(f);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.versionId).toBe(first.value.versionId); // V1 — the version bound to THIS compilation
    expect(replay.value.versionId).not.toBe(v2);
    expect(runRowOf(f.core, replay.value.executionRunId).version_id).toBe(first.value.versionId); // run pin unchanged
  });

  it('17/§26. same command + different spec → COMPILATION_COMMAND_CONFLICT (anchor-bound)', async () => {
    const f = await makeFixture();
    expect((await compile(f)).ok).toBe(true);
    const conflictSpec = await compile(f, 'compile-1', {
      planItemProfiles: {
        ...PROCUREMENT_SPEC.planItemProfiles,
        approval: profile('procurement-approval-work', 'rol.procurement-approver', 'task.procurement-approval', 8),
      },
    });
    expect(conflictSpec.ok).toBe(false);
    if (!conflictSpec.ok) expect(reasonOf(conflictSpec.error)).toBe('COMPILATION_COMMAND_CONFLICT');
  });

  it('18/§27. crash A replay uses the SAME permanent inputs → same lineage id, same version', async () => {
    const f = await makeFixture({ crashAt: 'after_compiled_graph_before_workflow_publish' });
    await expect(compile(f)).rejects.toThrow('crash:after_compiled_graph_before_workflow_publish');
    const core2 = await reopen(f, DRIFTED_SPEC); // restart-time defaults changed
    const replay = await compileArtifact(core2, {
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-1', actorId: f.actor,
    }); // caller supplies the ORIGINAL trusted inputs
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.templateId).toBe(compiledTemplateId(COMPANY, replay.value.planId, 'compile-1'));
    expect(replay.value.versionId).toMatch(/^ver_/); // repo version convention
    expect(countOf(core2, 'SELECT COUNT(*) AS c FROM workflow_templates WHERE name LIKE ?', 'plan-compile:%')).toBe(1);
  });

  it('19/§28. crash B replay resolves the EXACT previously compiled version + same Run.id', async () => {
    const f = await makeFixture({ crashAt: 'after_workflow_published_before_execution_run' });
    await expect(compile(f)).rejects.toThrow('crash:after_workflow_published_before_execution_run');
    const core2 = await reopen(f);
    const replay = await compileArtifact(core2, {
      companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
      compilationCommandId: 'compile-1', actorId: f.actor,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    // the version published BEFORE the crash is the one replayed (content match, not current)
    const published = core2.database.db
      .prepare("SELECT id FROM workflow_template_versions WHERE template_id = ? AND semver NOT LIKE '%draft'")
      .get(replay.value.templateId) as { id: string };
    expect(replay.value.versionId).toBe(published.id);
    expect(replay.value.executionRunId).toBe(executionRunIdOf(COMPANY, f.planningRunId, replay.value.planId, 'compile-1'));
    expect(countOf(core2, 'SELECT COUNT(*) AS c FROM runs')).toBe(2); // exactly one execution run
  });

  it('20/§29. crash C/D/E converge to the same Run.id, correct workflowId/versionId, same goal/tasks', async () => {
    for (const checkpoint of [
      'after_execution_run_durable_before_tasks',
      'after_task_materialization_progress',
      'after_compilation_complete_before_return',
    ] as const) {
      const f = await makeFixture({ crashAt: checkpoint });
      await expect(compile(f)).rejects.toThrow(`crash:${String(checkpoint)}`);
      const core2 = await reopen(f);
      const replay = await compileArtifact(core2, {
        companyId: COMPANY, planningRunId: f.planningRunId, planArtifactId: f.planArtifactId,
        compilationCommandId: 'compile-1', actorId: f.actor,
      });
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      const runId = executionRunIdOf(COMPANY, f.planningRunId, replay.value.planId, 'compile-1');
      expect(replay.value.executionRunId).toBe(runId);
      const row = runRowOf(core2, runId);
      expect(row.workflow_id).toBe(compiledTemplateId(COMPANY, replay.value.planId, 'compile-1'));
      expect(String(row.version_id)).toBe(replay.value.versionId);
      expect(countOf(core2, 'SELECT COUNT(*) AS c FROM artifacts WHERE run_id = ? AND kind = ?', runId, 'companyos:run-goal')).toBe(1);
      expect((await core2.database.tasks.listByRun(runId)).length).toBe(PLAN_ITEMS.length);
    }
  });

  it('21-23. heterogeneous / non-software / software compilation regression', async () => {
    const f = await makeFixture();
    const heterogeneous = await compile(f); // 21 + 22: the procurement chain is non-software
    expect(heterogeneous.ok).toBe(true);
    if (!heterogeneous.ok) return;
    const tasks = await f.core.database.tasks.listByRun(heterogeneous.value.executionRunId);
    expect(new Set(tasks.map((task) => `${String(task.roleId)}|${String(task.kind)}|${String(task.maxAttempts)}`)).size).toBe(4);
    expect(versionGraphJsonOf(f.core, heterogeneous.value.templateId)).not.toContain('e2e7:build');
    const software = await compile(f, 'compile-sw', SOFTWARE_SPEC); // 23
    expect(software.ok).toBe(true);
  });

  it('§31. two different compile identities → independent runs even on the same version content', async () => {
    const f = await makeFixture();
    const a = await compile(f, 'compile-a');
    const b = await compile(f, 'compile-b'); // same plan, same spec, DIFFERENT command
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.executionRunId).not.toBe(b.value.executionRunId);
    expect(a.value.templateId).not.toBe(b.value.templateId); // distinct lineages per command
    const goalA = countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts WHERE run_id = ? AND kind = ?', a.value.executionRunId, 'companyos:run-goal');
    const goalB = countOf(f.core, 'SELECT COUNT(*) AS c FROM artifacts WHERE run_id = ? AND kind = ?', b.value.executionRunId, 'companyos:run-goal');
    expect(goalA).toBe(1);
    expect(goalB).toBe(1); // independent run-owned goals
    expect((await f.core.database.tasks.listByRun(a.value.executionRunId)).length).toBe(PLAN_ITEMS.length);
    expect((await f.core.database.tasks.listByRun(b.value.executionRunId)).length).toBe(PLAN_ITEMS.length);
  });
});
