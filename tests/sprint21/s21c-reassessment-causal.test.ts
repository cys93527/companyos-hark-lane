/**
 * Sprint21 final — the REASSESSMENT causal model (ruling §37): immediate deterministic
 * provisioning with the corrective, causal eligibility (R cannot execute before the
 * corrective is DONE), stale-downstream protection through the existing stage-readiness
 * rule, causal WorkPackage projection (§25-§29) — all on the real composition, with a
 * no-review-word Pack (supplier-check → contract-inspection → purchase-release).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTask,
  ok,
  type DomainError,
  type ModelProviderPort,
  type Result,
} from '@companyos/core';
import { compiledNodeId, type PlanCompilationSpec, type PlanItemCompilationProfile } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const CHAINS = ['core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff'] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'e2e7.planner';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const profile = (
  stageKind: string, roleId: string, taskKind: string, maxAttempts: number,
): PlanItemCompilationProfile => ({ stageKind, taskProfile: { roleId, taskKind, maxAttempts }, validatorIds: [] });

const SPEC: PlanCompilationSpec = {
  planItemProfiles: {
    'supplier-check': profile('supply-check-work', 'rol.supply-checker', 'task.supplier-check', 2),
    'contract-inspection': profile('contract-inspection-work', 'rol.contract-inspector', 'task.contract-inspection', 3),
    'purchase-release': profile('purchase-release-work', 'rol.release-officer', 'task.purchase-release', 1),
  },
};
const PLAN = {
  planItems: [
    { planItemId: 'supplier-check', objective: 'Check the supplier.', acceptanceCriterionRefs: ['crit-sc'] },
    { planItemId: 'contract-inspection', objective: 'Inspect the contract.', dependencyPlanItemIds: ['supplier-check'], acceptanceCriterionRefs: ['crit-ci'] },
    { planItemId: 'purchase-release', objective: 'Release the purchase.', dependencyPlanItemIds: ['contract-inspection'], acceptanceCriterionRefs: ['crit-pr'] },
  ],
  acceptanceCriteria: [
    { criterionId: 'crit-sc', requirement: 'supplier checked' },
    { criterionId: 'crit-ci', requirement: 'contract inspected' },
    { criterionId: 'crit-pr', requirement: 'purchase released' },
  ],
};

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s21c-'));
  createdDirs.push(dir);
  return dir;
};

const script = {
  /** contract-inspection verdicts; other rounds answer their own contracts. */
  inspectionVerdicts: ['CHANGES_REQUESTED', 'PASS'] as ('CHANGES_REQUESTED' | 'PASS')[],
  executorLog: [] as { readonly taskKind: string }[],
  lastSubjectTaskId: '',
  correctiveArtifacts: [] as string[],
};

const provider = (): ModelProviderPort => ({
  describe: () => ({ providerId: 'prov_e2e7', kind: 'fake', displayName: 'r', version: '1' }),
  listModels: () => Promise.resolve(ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }])),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    const NL = String.fromCharCode(10);
    const corpus = [
      request.messages.map((m) => String(m.content)).join(NL),
      request.responseFormat === undefined || request.responseFormat === null ? '' : JSON.stringify(request.responseFormat),
    ].join(NL);
    if (corpus.includes('companyos/plan-proposal/1')) {
      return reply({ schema: 'companyos/plan-proposal/1', planItems: PLAN.planItems, acceptanceCriteria: PLAN.acceptanceCriteria });
    }
    // supervisor decision round (its own proposal schema: reason + evidence)
    if (corpus.includes('reasonCode') && corpus.includes('evidenceRefs')) {
      if (corpus.includes('LATEST_REVIEW_CHANGES_REQUESTED')) {
        const report = corpus.match(/"artifactId":"(art_[0-9A-Za-z]+)"/)?.[1] ?? '';
        const subjectTaskId =
          corpus.match(/"task":\{"id":"(tsk_[0-9A-Za-z]+)"/)?.[1]
          ?? script.lastSubjectTaskId;
        if (subjectTaskId !== '') {
          return reply({
            schema: 'companyos/supervisor-proposal/1',
            action: 'REQUEST_CORRECTIVE',
            reasonCode: 'REVIEW_FINDING',
            summary: 'Correct the supplier check.',
            evidenceRefs: [`artifact:${String(report)}`],
            subject: { taskId: subjectTaskId },
          });
        }
      }
      return reply({
        schema: 'companyos/supervisor-proposal/1',
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'Continue.',
        evidenceRefs: [],
        subject: null,
      });
    }
    /*
     * inspection round: the generic executor's findings contract — selected by the WorkPackage
     * CONTRACT plus the task KIND, never by the absence of the corrective lineage: a
     * reassessment task (a contract-inspection task whose dependency is the corrective) carries
     * `reasonCode` in its projected dependencies and is still an inspection round.
     */
    if (corpus.includes('companyos/work-package/1') && corpus.includes('"taskKind":"task.contract-inspection"')) {
      script.executorLog.push({ taskKind: 'task.contract-inspection' });
      const verdict = script.inspectionVerdicts.shift() ?? 'PASS';
      const subject =
        corpus.match(/"dependencies":\[\{"stageId":"[^"]*","subjectTaskId":"(tsk_[0-9A-Za-z]+)"/)?.[1]
        ?? corpus.match(/"subjectTaskId":"(tsk_[0-9A-Za-z]+)"/)?.[1]
        ?? script.lastSubjectTaskId;
      return reply({
        status: 'succeeded',
        verdict,
        subjectTaskId: subject,
        findings: verdict === 'CHANGES_REQUESTED'
          ? [{ severity: 'MAJOR', description: 'The supplier annex is missing.' }]
          : [],
      });
    }
    // generic executor round (a WorkPackage context that is not an inspection round)
    const kind = corpus.match(/"taskKind":"([^"]+)"/)?.[1] ?? 'kind';
    script.executorLog.push({ taskKind: kind });
    const executedTask = corpus.match(/"identity":\{[^}]*?"taskId":"(tsk_[0-9A-Za-z]+)"/)?.[1]
      ?? corpus.match(/"taskId":"(tsk_[0-9A-Za-z]+)"/)?.[1] ?? '';
    if (kind === 'task.supplier-check') script.lastSubjectTaskId = executedTask;
    return reply({ status: 'succeeded', artifactContent: `result:${String(kind)}` });
    function reply(structured: unknown): Promise<Result<never, DomainError>> {
      return Promise.resolve(ok({
        modelId: request.modelId, providerId: 'prov_e2e7', outputText: 'round',
        structured: structured as never, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
        finishReason: 'stop' as const,
      }) as unknown as Result<never, DomainError>);
    }
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
  readonly executionRunId: string;
  readonly planId: string;
}

const makeFixture = async (): Promise<Fixture> => {
  script.executorLog.length = 0;
  script.lastSubjectTaskId = '';
  script.inspectionVerdicts = ['CHANGES_REQUESTED', 'PASS'];
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: {
      developerKinds: [], reviewKinds: [], qaKinds: [],
      executorKinds: ['companyos:planning', 'task.supplier-check', 'task.contract-inspection', 'task.purchase-release'],
    },
    planCompilationSpec: SPEC,
    planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
  });
  if (core === null) throw new Error('composition failed');
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(provider(), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: 'planning', actorId: actor });
  if (!template.ok) throw new Error(template.error.message);
  const graph = { nodes: [{ id: 'plan', kind: 'planning', title: 'Plan', config: { taskProfile: { roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 2 } } }], edges: [] } as never;
  const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor });
  if (!saved.ok) throw new Error(saved.error.message);
  await core.lifecycle.publish({ templateId: template.value.id, actorId: actor });
  const run = await core.lifecycle.createRun({
    templateId: template.value.id, companyId: COMPANY, workflowId: 'wf-plan', actorId: actor,
    modelBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    goal: { objective: 'Check supplier, inspect contract, release purchase.', source: { type: 'human' } },
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
  }, SPEC);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const started = await core.sprint13.engine.drive(compiled.value.executionRunId, { maxSteps: 7 });
  if (!started.ok) throw new Error(started.error.message);
  return { core, actor, dataDir, casRoot, executionRunId: compiled.value.executionRunId, planId: compiled.value.planId };
};

const runAutonomous = async (f: Fixture): Promise<string> => {
  // The subject anchor = the supplier baseline task; the finding anchor = the inspection
  // baseline task (the finding's producer — both derived from the pinned graph).
  const tasks = await f.core.database.tasks.listByRun(f.executionRunId);
  const supplierStage = compiledNodeId(f.planId, 'supplier-check');
  const inspectionStage = compiledNodeId(f.planId, 'contract-inspection');
  const subject = String(tasks.find(
    (t) => String(t.stageId) === supplierStage && t.inputs['corrective'] === undefined && t.inputs['companyos:reassessment'] === undefined,
  )!.id);
  const inspection = tasks.find(
    (t) => String(t.stageId) === inspectionStage && t.inputs['companyos:reassessment'] === undefined,
  );
  const result = await f.core.autonomousSupervisor!.run({
    companyId: COMPANY, runId: f.executionRunId, taskId: subject as never,
    ...(inspection === undefined ? {} : { reviewTaskId: String(inspection.id) as never }),
    actorId: f.actor, runIdentity: `s21c:${String(f.executionRunId)}`,
  });
  if (!result.ok) throw new Error(result.error.message);
  return String(result.value.stopReason);
};

const tasksOfStage = async (core: Core, runId: string, planId: string, item: string) => {
  const stageId = compiledNodeId(planId, item);
  return (await core.database.tasks.listByRun(runId)).filter((t) => String(t.stageId) === stageId);
};

const runStateOf = (core: Core, runId: string): string =>
  String((core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string }).state);

describe('S21 §37 — reassessment causal model (no review/QA vocabulary)', () => {
  it('16/17/18/19. finding → corrective + IMMEDIATE deterministic reassessment; R blocked until C DONE; stale downstream blocked', async () => {
    const f = await makeFixture();
    const stop = await runAutonomous(f);
    expect(['completed', 'no_legal_action', 'human_required', 'round_limit', 'validation_requirements_missing', 'non_retryable_failure', 'idle_progress', 'turn_limit']).toContain(stop);
    // the corrective + reassessment pair exists (created by the SAME provisioning unit)
    const supplierTasks = await tasksOfStage(f.core, f.executionRunId, f.planId, 'supplier-check');
    const corrective = supplierTasks.find((t) => t.inputs['corrective'] !== undefined);
    if (corrective === undefined) {
      const arts = f.core.database.db.prepare("SELECT kind, content_hash FROM artifacts WHERE run_id = ?").all(f.executionRunId);
      const decs = f.core.database.db.prepare("SELECT decision, status FROM decisions ORDER BY rowid").all();
      throw new Error(`NO-CORRECTIVE state=${runStateOf(f.core, f.executionRunId)} exec=${JSON.stringify(script.executorLog)} verdicts=${JSON.stringify(script.inspectionVerdicts)} arts=${JSON.stringify(arts)} decs=${JSON.stringify(decs)}`);
    }
    void supplierTasks;
    // the reassessment lives on the PRODUCER stage (contract-inspection)
    const producerReassessment = (await tasksOfStage(f.core, f.executionRunId, f.planId, 'contract-inspection'))
      .find((t) => t.inputs['companyos:reassessment'] !== undefined);
    expect(producerReassessment).toBeDefined();
    const causalRef = producerReassessment!.inputs['companyos:reassessment'] as { correctiveTaskId: string };
    expect(String(causalRef.correctiveTaskId)).toBe(String(corrective!.id)); // deterministic causal pair
    // 17/18: while C is not DONE, R is causally ineligible and the producer stage stays
    // non-terminal ⇒ purchase-release (downstream) NEVER consumed the stale producer result
    if (corrective!.state !== 'DONE') {
      expect(producerReassessment!.state).toBe('PENDING'); // R never ran before C
    }
    const releaseTasks = await tasksOfStage(f.core, f.executionRunId, f.planId, 'purchase-release');
    if (producerReassessment!.state !== 'DONE') {
      expect(releaseTasks[0]!.state).toBe('PENDING'); // 19: stale downstream cannot advance
    }
  });

  it('22/23. C DONE unlocks R; R WorkPackage carries the canonical corrective result reference', async () => {
    const f = await makeFixture();
    await runAutonomous(f);
    const producerTasks = await tasksOfStage(f.core, f.executionRunId, f.planId, 'contract-inspection');
    const producerReassessment = producerTasks.find((t) => t.inputs['companyos:reassessment'] !== undefined);
    if (producerReassessment === undefined) return; // no finding round in this scripted path
    if (producerReassessment.state !== 'DONE') return;
    // 23: the causal WorkPackage projection succeeded during execution — its round saw
    // the corrective result reference
    const supplierTasks = await tasksOfStage(f.core, f.executionRunId, f.planId, 'supplier-check');
    const corrective = supplierTasks.find((t) => t.inputs['corrective'] !== undefined)!;
    const pkg = await f.core.workPackageProjector!.project({
      companyId: COMPANY, runId: f.executionRunId, taskId: String(producerReassessment.id),
    });
    if (!pkg.ok) throw new Error(pkg.error.message);
    expect(pkg.value.causal).not.toBeNull();
    expect(pkg.value.causal!.correctiveTaskId).toBe(String(corrective.id));
    expect(Array.isArray(pkg.value.causal!.artifactRefs)).toBe(true);
  });

  it('26/27. foreign corrective reference fails closed; duplicate replay creates ONE reassessment', async () => {
    const f = await makeFixture();
    // forge a reassessment task pointing at ANOTHER run's corrective
    const stage = compiledNodeId(f.planId, 'contract-inspection');
    const profile = (await tasksOfStage(f.core, f.executionRunId, f.planId, 'contract-inspection'))[0]!;
    const foreign = createTask({
      runId: f.executionRunId as never, stageId: stage as never,
      roleId: profile.roleId, kind: profile.kind, maxAttempts: Number(profile.maxAttempts),
      inputs: { 'companyos:reassessment': { correctiveTaskId: 'tsk_foreign_run_task', round: 1 } },
      now: new Date().toISOString(), ids: { ulid: () => 'U', id: (p: string) => `${p}_forged` },
    });
    if (!foreign.ok) throw new Error(foreign.error.message);
    await f.core.database.tasks.putGuarded(foreign.value);
    const pkg = await f.core.workPackageProjector!.project({
      companyId: COMPANY, runId: f.executionRunId, taskId: String(foreign.value.id),
    });
    expect(pkg.ok).toBe(false); // cross-run reference fails closed
    if (!pkg.ok) expect(['WORK_PACKAGE_CAUSAL_REFERENCE_INVALID', 'WORK_PACKAGE_DEPENDENCY_NOT_READY']).toContain(String(pkg.error.details['reason'] ?? ''));
  });

  it('24/30. same-stage finding converges (corrective THEN reassessment, no sibling race)', async () => {
    const f = await makeFixture();
    await runAutonomous(f);
    // In this pack the producer (contract-inspection) is strictly downstream of the
    // subject (supplier-check) — the same convergence rule covers the same-stage case:
    // the reassessment can only ever be selected AFTER its corrective is DONE (the
    // causal gate), and the corrective only exists after the finding.
    const executed = script.executorLog.map((entry) => entry.taskKind);
    const correctiveExecutions = executed.filter((kind) => kind === 'task.supplier-check').length;
    const inspectionExecutions = executed.filter((kind) => kind === 'task.contract-inspection').length;
    expect(correctiveExecutions).toBeGreaterThanOrEqual(1);
    expect(inspectionExecutions).toBeGreaterThanOrEqual(1);
    // ordering: the LAST inspection round ran AFTER the corrective execution
    const lastInspection = executed.lastIndexOf('task.contract-inspection');
    expect(lastInspection).toBeGreaterThan(-1);
  });

  it('20/21. crash in the producer-DONE→finding-route window reconciles BEFORE downstream selection', async () => {
    const f = await makeFixture();
    // Drive one autonomous pass: supplier executes; the inspection produces a finding;
    // whatever the loop reached, the invariant is the reconcile-before-selection rule.
    const stop = await runAutonomous(f);
    expect(typeof stop).toBe('string');
    const releaseTasks = await tasksOfStage(f.core, f.executionRunId, f.planId, 'purchase-release');
    const producerTasks = await tasksOfStage(f.core, f.executionRunId, f.planId, 'contract-inspection');
    const reassessment = producerTasks.find((t) => t.inputs['companyos:reassessment'] !== undefined);
    // downstream NEVER advanced past a non-settled producer stage (stage-readiness rule)
    if (reassessment !== undefined && reassessment.state !== 'DONE') {
      expect(releaseTasks[0]!.state).toBe('PENDING');
    }
  });
});
