/**
 * V1 EFFICIENCY STAGE E2 — MINIMUM-SUFFICIENT PLANNING (contract + shape fixtures).
 *
 * E2 changes ONE thing: the Planner's generation guidance (the system prompt mirror of
 * the canonical contract) now states the minimum-sufficient decomposition principle.
 * The canonical validator stays the ONLY authority; bounded proposal repair, dependency
 * fail-closed, complexity/quality floors, and the independent-validation architecture
 * are untouched. No hard task-count heuristic, no plan-size retry loop, no session or
 * role runtime, no execution change.
 *
 * Fixtures below run the REAL deterministic planner path (proposal → canonical
 * validation → compilation) for cohesive and multi-boundary plan shapes and assert the
 * PLATFORM supports / preserves them; the contract pins guard the guidance itself.
 */
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {
  ok,
  planFingerprintOf,
  type ModelProviderPort,
} from '@companyos/core';
import {compiledNodeId, type PlanCompilationSpec, type PlanItemCompilationProfile} from '@companyos/engine';
import {openDurableDatabase, type DurableDatabase} from '@companyos/persistence';
import {nullLogger} from '@companyos/observability';

import {composeCoreServices} from '../../apps/desktop/src/core-services.js';
import {openArtifactFoundation} from '../../apps/desktop/src/artifact-stack.js';

const CHAINS = [
  'core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff',
] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'e2e22.planner';
const chr = (code: number): string => String.fromCharCode(code);

/* ---------------------------------------------------------- contract pins */

describe('E2 — planner contract pins (guidance only, authority unchanged)', () => {
  it('composed planner runtime prompt carries the minimum-sufficient decomposition principle', async () => {
    const fixture = await makeFixture(() => ok({
      schema: 'companyos/plan-proposal/1',
      planItems: [
        {planItemId: 'e2e-one', objective: 'Cohesive out turn.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['e2e-c1']},
      ],
      acceptanceCriteria: [{criterionId: 'e2e-c1', requirement: 'one criterion.'}],
    }));
    const prompt = fixture.core.plannerRuntime?.plannerSystemPrompt?.() ?? '';
    expect(prompt).toContain('FEWEST work items that are actually justified');
    expect(prompt).toContain('Plan');
    expect(prompt).toContain('not procedural steps');
    expect(prompt).toContain('tightly coupled sequential');
    expect(prompt).toContain('independent review/validation authority');
    expect(prompt).toContain('self-certifying');
    // no hard-count heuristic in the guidance
    expect(prompt).not.toMatch(/exactly \d+ work items/i);
    expect(prompt).not.toMatch(/max(?:imum)? \d+ items/i);
    await fixture.close();
  });
});

/* ------------------------------------------------- deterministic plan fixtures */

/** Fixture plan shapes exercised through the REAL planner → validator → compiler path. */
const SHAPES: Record<string, unknown> = {
  // CASE B — cohesive business analysis: read → compute → compare → find in ONE analysis
  // item (3 criteria), independent validation preserved as its own item.
  caseB: {
    schema: 'companyos/plan-proposal/1',
    planItems: [
      {planItemId: 'analyze-orders', objective: 'Analyze the ledger: profile the source, compute core metrics, compare slices, and identify anomalies as one analytical deliverable.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['a1', 'a2', 'a3']},
      {planItemId: 'author-findings', objective: 'Author the findings report from the analysis output.', dependencyPlanItemIds: ['analyze-orders'], acceptanceCriterionRefs: ['a4']},
      {planItemId: 'independent-validation', objective: 'Independently validate every reported fact against the source before delivery.', dependencyPlanItemIds: ['author-findings'], acceptanceCriterionRefs: ['v1']},
    ],
    acceptanceCriteria: [
      {criterionId: 'a1', requirement: 'metrics recomputed from the source.'},
      {criterionId: 'a2', requirement: 'comparisons consistent.'},
      {criterionId: 'a3', requirement: 'anomalies supported.'},
      {criterionId: 'a4', requirement: 'report separates facts from interpretation.'},
      {criterionId: 'v1', requirement: 'validation passes with durable evidence.'},
    ],
  },
  // CASE C — true multi-component project: genuine boundaries + parallel algorithm.
  caseC: {
    schema: 'companyos/plan-proposal/1',
    planItems: [
      {planItemId: 'scanner', objective: 'Build the directory scanner component.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['s1']},
      {planItemId: 'metrics', objective: 'Build the metrics engine component.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['m1']},
      {planItemId: 'integrate', objective: 'Integrate scanner + metrics into the CLI.', dependencyPlanItemIds: ['scanner', 'metrics'], acceptanceCriterionRefs: ['i1']},
    ],
    acceptanceCriteria: [
      {criterionId: 's1', requirement: 'scanner tests pass.'},
      {criterionId: 'm1', requirement: 'metrics tests pass.'},
      {criterionId: 'i1', requirement: 'CLI matrix matches the oracle.'},
    ],
  },
  // CASE A — small cohesive software change + independent validation
  caseA: {
    schema: 'companyos/plan-proposal/1',
    planItems: [
      {planItemId: 'impl', objective: 'Implement the change end to end: code, structure, and docs as one implementation responsibility.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['c1', 'c2']},
      {planItemId: 'validate', objective: 'Independently validate the delivered change.', dependencyPlanItemIds: ['impl'], acceptanceCriterionRefs: ['v1']},
    ],
    acceptanceCriteria: [
      {criterionId: 'c1', requirement: 'behavior implemented.'},
      {criterionId: 'c2', requirement: 'usage documented.'},
      {criterionId: 'v1', requirement: 'independent validation passes.'},
    ],
  },
  // CASE E — distinct professional responsibilities stay separable
  caseE: {
    schema: 'companyos/plan-proposal/1',
    planItems: [
      {planItemId: 'data', objective: 'Prepare the dataset.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['d1'], professionalResponsibility: {responsibilityIntent: 'data analysis'}},
      {planItemId: 'legal', objective: 'Review regulatory obligations.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['l1'], professionalResponsibility: {responsibilityIntent: 'legal compliance review'}},
      {planItemId: 'assemble', objective: 'Assemble the submission.', dependencyPlanItemIds: ['data', 'legal'], acceptanceCriterionRefs: ['x1']},
    ],
    acceptanceCriteria: [
      {criterionId: 'd1', requirement: 'dataset prepared.'},
      {criterionId: 'l1', requirement: 'obligations reviewed.'},
      {criterionId: 'x1', requirement: 'submission complete.'},
    ],
  },
};

/** One compilation profile per plan item (the compiler requires exact coverage). */
function profile(maxAttempts: number): PlanItemCompilationProfile {
  return {stageKind: 'work', taskProfile: {roleId: 'rol.planner', taskKind: 'companyos:work', maxAttempts}, validatorIds: []};
}

/** The compilation spec for ONE shape (profiles exactly covering that plan's items). */
const specOf = (proposal: unknown): PlanCompilationSpec => {
  const items = (proposal as {planItems: {planItemId: string}[]}).planItems;
  const planItemProfiles: Record<string, PlanItemCompilationProfile> = {};
  for (const item of items) planItemProfiles[item.planItemId] = profile(2);
  return {planItemProfiles};
};

describe('E2 — deterministic plan-shape fixtures through the real planner path', () => {
  for (const [name, proposal] of Object.entries(SHAPES)) {
    it(`${name}: proposal validates, compiles, and its boundaries survive`, {timeout: 120_000}, async () => {
      const fixture = await makeFixture(() => ok(proposal));
      const planned = await fixture.core.plannerRuntime!.runPlanningTurn({
        companyId: COMPANY,
        runId: fixture.runId,
        taskId: fixture.taskId,
        planningCommandId: `e2-${name}-1`,
        actorId: fixture.actor,
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      const compiled = await fixture.core.planCompiler!.compile({
        companyId: COMPANY,
        planningRunId: fixture.runId,
        planArtifactId: planned.value.artifactId,
        compilationCommandId: `e2-${name}-compile-1`,
        actorId: fixture.actor,
        executionBindings: {planner: MODEL_KEY, supervisor: MODEL_KEY},
      }, specOf(proposal));
      if (!compiled.ok) throw new Error(`compile failed: ${compiled.error.message} ${JSON.stringify((compiled.error as {details?: unknown}).details ?? {})}`);
      expect(compiled.ok).toBe(true);
      const items = (proposal as {planItems: {planItemId: string; dependencyPlanItemIds: string[]; acceptanceCriterionRefs?: string[]; professionalResponsibility?: unknown}[]}).planItems;

      // every planned item materialized as exactly one task (platform never rewrites plans)
      const planId = String(planned.value.planId);
      const tasks = await fixture.core.database.tasks.listByRun(compiled.value.executionRunId);
      expect(tasks.length).toBe(items.length);
      for (const item of items) {
        const stageId = compiledNodeId(planId, item.planItemId);
        const matched = tasks.filter((task) => String(task.stageId) === stageId);
        expect(matched.length).toBe(1); // missing stage would prove compiler dropped an item
      }

      // shape semantics
      if (name === 'caseB') {
        expect(items.length).toBe(3); // analysis + authoring + independent validation
        // the analysis item keeps its three acceptance criteria (criteria never imply items)
        const analysis = items[0]!;
        expect(analysis.acceptanceCriterionRefs?.length ?? 0).toBeGreaterThanOrEqual(3);
        // independent validation is its own item with the analysis as prerequisite
        expect(items[2]!.planItemId).toContain('validation');
        expect(items[2]!.dependencyPlanItemIds).toEqual(['author-findings']);
      }
      if (name === 'caseC') {
        expect(items.length).toBe(3);
        // parallel component boundary preserved: scanner and metrics are independent
        expect(items[0]!.dependencyPlanItemIds).toEqual([]);
        expect(items[1]!.dependencyPlanItemIds).toEqual([]);
        expect(items[2]!.dependencyPlanItemIds).toEqual(['scanner', 'metrics']);
      }
      if (name === 'caseA') {
        expect(items.length).toBe(2);
        expect(items[1]!.planItemId).toContain('validate');
      }
      if (name === 'caseE') {
        expect(items.length).toBe(3);
        expect(items[0]!.professionalResponsibility).toBeDefined();
        expect(items[1]!.professionalResponsibility).toBeDefined();
      }
      await fixture.close();
    });
  }

  it('dependency validation still fails closed (guard rail unchanged)', {timeout: 120_000}, async () => {
    const dangling = {
      schema: 'companyos/plan-proposal/1',
      planItems: [
        {planItemId: 'plan-02-core', objective: 'Deliver.', dependencyPlanItemIds: ['plan-01'], acceptanceCriterionRefs: ['c1']},
      ],
      acceptanceCriteria: [{criterionId: 'c1', requirement: 'c1 met.'}],
    };
    const fixture = await makeFixture(() => ok(dangling));
    const planned = await fixture.core.plannerRuntime!.runPlanningTurn({
      companyId: COMPANY, runId: fixture.runId, taskId: fixture.taskId,
      planningCommandId: 'e2-dangling-1', actorId: fixture.actor,
    });
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      // fail-closed intact: every proposal attempt refuses the unknown dependency
      const attemptFailures = (planned.error.details['attemptFailures'] as readonly {code?: string}[] | undefined) ?? [];
      expect(planned.error.message).toContain('PLAN_DEPENDENCY');
      expect(attemptFailures.every((entry) => String(entry.code) === 'PLAN_DEPENDENCY_UNKNOWN')).toBe(true);
    }
    await fixture.close();
  });

  it('deterministic plan fingerprint: identical canonical payloads fingerprint identically', () => {
    // the plan FINGERPRINT is the content-addressable replay primitive: same payload (schema +
    // source goal + items + criteria), same fingerprint — never timestamps/usage/related ids
    // unrelated to planning semantics.
    const payload: Parameters<typeof planFingerprintOf>[0] = {
      schema: 'companyos/plan/1',
      sourceGoal: { goalArtifactId: 'art_e2det' },
      planItems: (SHAPES.caseB as {planItems: never}).planItems,
      acceptanceCriteria: (SHAPES.caseB as {acceptanceCriteria: never}).acceptanceCriteria,
    };
    expect(planFingerprintOf(payload)).toBe(planFingerprintOf({...payload}));
    // a structural drift is detectable: an extra item changes the fingerprint
    const drifted = {...payload, planItems: [...payload.planItems, payload.planItems[0]!]};
    expect(planFingerprintOf(drifted)).not.toBe(planFingerprintOf(payload));
  });

  it('the decomposition guidance actually REACHES the model request (not inert)', {timeout: 120_000}, async () => {
    // E2 PHASE C regression: the guidance must travel as the planner system preamble —
    // otherwise the contract changes nothing (budget accounting alone proved insufficient).
    const fixture = await makeFixture(() => ok(SHAPES.caseB));
    const planned = await fixture.core.plannerRuntime!.runPlanningTurn({
      companyId: COMPANY, runId: fixture.runId, taskId: fixture.taskId,
      planningCommandId: 'e2-delivery-1', actorId: fixture.actor,
    });
    expect(planned.ok).toBe(true);
    const corpus = fixture.corpusOf();
    expect(corpus).toContain('FEWEST work items that are actually justified');
    expect(corpus).toContain('tightly coupled sequential');
    expect(corpus).toContain('self-certifying');
    await fixture.close();
  });

  it('a settled planning task refuses a second plan: no duplicate plan truth (guard rail unchanged)', {timeout: 120_000}, async () => {
    const fixture = await makeFixture(() => ok(SHAPES.caseB));
    const turn = async (commandId: string) => fixture.core.plannerRuntime!.runPlanningTurn({
      companyId: COMPANY, runId: fixture.runId, taskId: fixture.taskId,
      planningCommandId: commandId, actorId: fixture.actor,
    });
    const first = await turn('e2-det-a');
    expect(first.ok).toBe(true);
    // a new planning command on the already-settled task fails CLOSED typed instead of minting
    // a second plan over the same goal
    const second = await turn('e2-det-b');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toContain('already settled');
    await fixture.close();
  });
});

/* ------------------------------------------------------------------ fixture */

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) { try { rmSync(createdDirs.pop() as string, {recursive: true, force: true}); } catch { /* disposable */ } }
});

interface Fixture {
  readonly corpusOf: () => string;
  readonly core: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;
  readonly actor: string;
  readonly runId: string;
  readonly taskId: string;
  readonly close: () => Promise<void>;
}

const makeFixture = async (reply: () => unknown): Promise<Fixture> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-e2-'));
  createdDirs.push(dataDir);
  const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never});
  if (!foundation.ok) throw new Error('foundation failed');
  let lastCorpus = '';
  const provider: ModelProviderPort = {
    describe: () => ({providerId: 'prov_e2e22', kind: 'fake', displayName: 'e2', version: '1'}),
    listModels: () => Promise.resolve(ok([{modelId: 'p2', displayName: 'p2', contextWindow: 8192, capabilities: {streaming: false, structuredOutput: true}}])),
    health: () => Promise.resolve(ok(undefined as never)),
    invoke(request) {
      lastCorpus = (Array.isArray(request.messages) ? request.messages : []).map((message) => String(message.content ?? '')).join(chr(10));
      // reply() may return a raw proposal or a Result wrapper (ok(...)) — normalize to the raw payload
      const payload = reply() as unknown;
      const proposal = payload !== null && typeof payload === 'object' && 'value' in (payload as object) && 'ok' in (payload as object)
        ? (payload as {ok: boolean; value: unknown}).value
        : payload;
      const structured = lastCorpus.includes('companyos/plan-proposal/1') ? proposal : {};
      return Promise.resolve(ok({modelId: 'p2', providerId: 'prov_e2e22', outputText: 'plan', structured, toolCalls: [], usage: {inputTokens: 1, outputTokens: 1, totalCost: null}, finishReason: 'stop' as const}));
    },
    stream(): AsyncIterable<never> { return {[Symbol.asyncIterator]: () => ({next: () => Promise.resolve({done: true as const, value: undefined})})}; },
  };
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: {developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', 'companyos:work']},
  } as never);
  if (core === null) throw new Error('composition failed');
  const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
  // register the fixture provider through the production registry, THEN the model + policy (s21 pattern)
  const providerRegistration = await core.providers.register(provider, {actorId: actor});
  if (!providerRegistration.ok) throw new Error(`fixture provider registration failed: ${providerRegistration.error.message}`);
  const registered = await core.models.registerFromProvider({providerId: 'prov_e2e22', providerModelId: 'p2', modelKey: MODEL_KEY, actorId: actor});
  if (!registered.ok) throw new Error(registered.error.message);
  const savedPolicy = await core.policies.savePolicy({id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor} as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  const template = await core.lifecycle.createTemplate({orgId: COMPANY, name: 'planning', actorId: actor});
  if (!template.ok) throw new Error(template.error.message);
  const graph = {nodes: [{id: 'plan', kind: 'planning', title: 'Plan', config: {taskProfile: {roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 2}}}], edges: []} as never;
  const saved = await core.lifecycle.saveDraftGraph({templateId: template.value.id, graph, actorId: actor});
  if (!saved.ok) throw new Error(saved.error.message);
  await core.lifecycle.publish({templateId: template.value.id, actorId: actor});
  const run = await core.lifecycle.createRun({templateId: template.value.id, companyId: COMPANY, workflowId: 'wf-e2', actorId: actor, modelBindings: {planner: MODEL_KEY, supervisor: MODEL_KEY}, goal: {objective: 'E2 fixture goal.', source: {type: 'human'}}});
  if (!run.ok) throw new Error(run.error.message);
  const materialized = await core.normalTaskMaterializer!.materialize({companyId: COMPANY, runId: run.value.run.id, stageId: 'plan'});
  if (!materialized.ok) throw new Error(materialized.error.message);
  return {core, actor, runId: run.value.run.id, taskId: materialized.value.taskId, corpusOf: () => lastCorpus, close: async () => undefined};
};
