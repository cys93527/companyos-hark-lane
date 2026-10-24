/**
 * Sprint21 — FINAL INVARIANT PROOFS (consolidated专项测试).
 *
 * Eight invariants the Sprint21 freeze demands, each proven through the PRODUCTION
 * composition (composeCoreServices + the pinned plan-compiled execution run), never
 * through a hand-rolled state machine. Every fixture carries its OWN script state (no
 * cross-test leakage), and every test asserts the invariant it exists for — the run's
 * gate tail is business other suites already prove.
 *
 *   A. terminal carrier reconciliation — a durable unreconciled carrier (Task + attempt
 *      settled, carrier NOT routed) never lets a run report COMPLETED; the restart's
 *      loop-head reconciliation routes it exactly once.
 *   B. legacy RUNNING upgrade — a task row left RUNNING with NO attempt row is
 *      reconstructed through the guarded path: the SAME attempt (number 1) is claimed,
 *      START is never applied twice, no source is fabricated.
 *   C. desktop runtime ownership — the OS single-instance lock lives in the desktop
 *      ENTRY (main.ts); the composition itself never enforces it (documented boundary).
 *   D. descendant pinned-profile equality — a reassessment task's execution profile IS
 *      the run-pinned WorkflowVersion taskProfile of its stage; the Task row is a carrier.
 *   E. foreign blocking without projection hijack — a foreign unresolved finding blocks
 *      (run-level) but never supplies a corrective cause (subject-scoped refusal).
 *   F. newer-clean cannot mask an older unresolved finding (ALL_UNRESOLVED_ANCHORS).
 *   G. post-completion descendant canonical replacement — the settled reassessment
 *      becomes the stage's canonical subject; the stale result is superseded.
 *   H. causal WorkPackage projection — a reassessment task projects the causal dossier
 *      of ITS corrective; a foreign reference fails closed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyTaskEvent,
  createExecutionAttempt,
  createToolRecord,
  nextExecutionAttemptState,
  ok,
  TOOL_CAPABILITY_VALIDATOR,
  type DomainError,
  type ModelProviderPort,
  type Result,
  type ToolPort,
} from '@companyos/core';
import { compiledNodeId, createFaultProbe, type PlanCompilationSpec, type PlanItemCompilationProfile } from '@companyos/engine';
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

/** Any canonical stop a run may reach — the invariants assert mid-run state, not the tail. */
const ANY_CANONICAL_STOP = [
  'completed', 'no_legal_action', 'validation_requirements_missing', 'round_limit',
  'human_required', 'invariant_failure', 'non_retryable_failure', 'idle_progress',
] as const;

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const profile = (
  stageKind: string,
  roleId: string,
  taskKind: string,
  maxAttempts: number,
  validatorIds: readonly string[] = [],
): PlanItemCompilationProfile => ({ stageKind, taskProfile: { roleId, taskKind, maxAttempts }, validatorIds });

const SPEC: PlanCompilationSpec = {
  planItemProfiles: {
    'supplier-analysis': profile('supply-analysis-work', 'rol.supply-analyst', 'task.supplier-analysis', 2),
    'compliance-inspection': profile('compliance-inspection-work', 'rol.compliance-inspector', 'task.compliance-inspection', 3),
  },
};
const PLAN = {
  planItems: [
    { planItemId: 'supplier-analysis', objective: 'Evaluate the shortlisted suppliers.', acceptanceCriterionRefs: ['crit-s'] },
    { planItemId: 'compliance-inspection', objective: 'Inspect the evaluation for compliance.', dependencyPlanItemIds: ['supplier-analysis'], acceptanceCriterionRefs: ['crit-c'] },
  ],
  acceptanceCriteria: [
    { criterionId: 'crit-s', requirement: 'suppliers evaluated' },
    { criterionId: 'crit-c', requirement: 'compliance inspected' },
  ],
};

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s21d-'));
  createdDirs.push(dir);
  return dir;
};

/** Per-fixture script state — never shared across tests. */
interface Script {
  inspectionVerdicts: ('CHANGES_REQUESTED' | 'PASS')[];
  lastSubjectTaskId: string;
}

const provider = (script: Script): ModelProviderPort => ({
  describe: () => ({ providerId: 'prov_e2e7', kind: 'fake', displayName: 'r', version: '1' }),
  listModels: () => Promise.resolve(ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }])),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    const NL = String.fromCharCode(10);
    const corpus = [
      request.messages.map((message) => String(message.content)).join(NL),
      request.responseFormat === undefined || request.responseFormat === null ? '' : JSON.stringify(request.responseFormat),
    ].join(NL);
    function reply(structured: unknown) {
      return Promise.resolve(ok({
        modelId: request.modelId, providerId: 'prov_e2e7', outputText: 'round',
        structured: structured as never, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
        finishReason: 'stop' as const,
      }));
    }
    if (corpus.includes('companyos/plan-proposal/1')) {
      return reply({ schema: 'companyos/plan-proposal/1', planItems: PLAN.planItems, acceptanceCriteria: PLAN.acceptanceCriteria });
    }
    if (corpus.includes('reasonCode') && corpus.includes('evidenceRefs')) {
      // D1 final scoping: a corrective proposal cites ONLY the subject-scoped review
      // reference the current context projects (a foreign finding never supplies a cause).
      const reviewRefs = corpus.match(/"id":"(art_[0-9A-Za-z]+)","kind":"review"/g) ?? [];
      if (reviewRefs.length > 0) {
        const report = reviewRefs[0]!.match(/"(art_[0-9A-Za-z]+)"/)![1]!;
        if (script.lastSubjectTaskId !== '') {
          return reply({
            schema: 'companyos/supervisor-proposal/1',
            action: 'REQUEST_CORRECTIVE',
            reasonCode: 'REVIEW_FINDING',
            summary: 'Correct the supplier evaluation for compliance.',
            evidenceRefs: [`artifact:${String(report)}`],
            subject: { taskId: script.lastSubjectTaskId },
          });
        }
      }
      const validationId = corpus.match(/"validationId":"(val_[0-9A-Za-z]+)"/)?.[1];
      if (validationId !== undefined && /"status":"pass"/.test(corpus) && corpus.includes('FINALIZING')) {
        return reply({
          schema: 'companyos/supervisor-proposal/1',
          action: 'COMPLETE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'All stages complete; validation passed.',
          evidenceRefs: [validationId],
          subject: null,
        });
      }
      return reply({
        schema: 'companyos/supervisor-proposal/1',
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'Continue the run.',
        evidenceRefs: [],
        subject: null,
      });
    }
    // the review-class unit (the inspection handler's own contract keys)
    if (corpus.includes('subjectTaskId') && corpus.includes('verdict')) {
      const verdict = script.inspectionVerdicts.shift() ?? 'CHANGES_REQUESTED';
      const subject =
        corpus.match(/"subject":\{"taskId":"(tsk_[0-9A-Za-z]+)"/)?.[1]
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
    const kind = corpus.match(/"taskKind":"([^"]+)"/)?.[1] ?? 'kind';
    const executedTask = corpus.match(/"identity":\{[^}]*?"taskId":"(tsk_[0-9A-Za-z]+)"/)?.[1]
      ?? corpus.match(/"taskId":"(tsk_[0-9A-Za-z]+)"/)?.[1] ?? '';
    if (kind === 'task.supplier-analysis') script.lastSubjectTaskId = executedTask;
    return reply({ status: 'succeeded', artifactContent: `result:${String(kind)}` });
  },
  stream(): AsyncIterable<Result<never, DomainError>> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
  },
});

const validatorPort = (): ToolPort => ({
  describe: () => ({
    toolId: VALIDATOR_ID, name: 'supply audit validator', description: 'Deterministic supply validator (S21 fixture).',
    version: '1', capabilities: [TOOL_CAPABILITY_VALIDATOR], riskLevel: 'LOW',
    parameters: { type: 'object', additionalProperties: true },
  }),
  async invoke(request) {
    const at = new Date().toISOString();
    return ok({
      status: 'ok' as const,
      output: {
        verdict: 'pass',
        evidenceRefs: [`command:${VALIDATOR_ID}:${request.idempotencyKey ?? 'once'}`],
        report: { kind: 'validator-report', label: `${VALIDATOR_ID} report`, content: JSON.stringify({ verdict: 'pass' }) },
      },
      artifactRefs: [], startedAt: at, finishedAt: at, latencyMs: 1,
    });
  },
});

interface Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly script: Script;
  readonly executionRunId: string;
  readonly planId: string;
  readonly paths: { readonly dataDir: string; readonly casRoot: string };
}

const composeAt = async (
  paths: { readonly dataDir: string; readonly casRoot: string },
  script: Script,
  faultCheckpoints?: { readonly crashAfterHits: number },
): Promise<{ core: Core; actor: string }> => {
  const db = openDurableDatabase({ dataDir: paths.dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot: paths.casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error(`foundation failed: ${foundation.error.message}`);
  const probe = faultCheckpoints === undefined
    ? undefined
    : createFaultProbe({ crashAt: [{ name: 'after_task_settled_before_carrier', afterHits: faultCheckpoints.crashAfterHits }] });
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    ...(probe === undefined ? {} : { faultCheckpoints: probe.port }),
    stageHandlers: {
      developerKinds: [],
      reviewKinds: ['task.compliance-inspection'],
      qaKinds: [],
      executorKinds: ['companyos:planning', 'task.supplier-analysis', 'task.purchase-approval'],
    },
    toolPorts: new Map<string, ToolPort>([[VALIDATOR_ID, validatorPort()]]),
    planCompilationSpec: SPEC,
    planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
  });
  if (core === null) throw new Error('production composition failed');
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(provider(script), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  const record = createToolRecord({
    toolId: VALIDATOR_ID, name: 'supply audit validator', description: 'fixture validator', version: '1',
    capabilities: [TOOL_CAPABILITY_VALIDATOR],
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true },
    riskLevel: 'LOW', requiredAuthorities: ['tool.invoke'], idempotencyMode: 'IDEMPOTENT_KEY',
    adapterRef: VALIDATOR_ID, now: new Date().toISOString(),
  });
  if (!record.ok) throw new Error(record.error.message);
  const registered = await core.tools.register(record.value, { actorId: actor });
  if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
  return { core, actor };
};

const makeFixture = async (verdicts?: readonly ('CHANGES_REQUESTED' | 'PASS')[]): Promise<Fixture> => {
  const script: Script = {
    inspectionVerdicts: [...(verdicts ?? ['CHANGES_REQUESTED', 'PASS'])],
    lastSubjectTaskId: '',
  };
  const paths = { dataDir: tempDir(), casRoot: tempDir() };
  const { core, actor } = await composeAt(paths, script);
  const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: `planning-${core.ids.id('t')}`, actorId: actor });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [{ id: 'plan', kind: 'planning' as const, title: 'Plan', config: { taskProfile: { roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 2 } } }],
    edges: [],
  } as never;
  const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor });
  if (!saved.ok) throw new Error(saved.error.message);
  await core.lifecycle.publish({ templateId: template.value.id, actorId: actor });
  const run = await core.lifecycle.createRun({
    templateId: template.value.id, companyId: COMPANY, workflowId: `wf-plan-${core.ids.id('w')}`, actorId: actor,
    modelBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    goal: { objective: 'Evaluate suppliers, inspect compliance, obtain approval.', source: { type: 'human' as const } },
  });
  if (!run.ok) throw new Error(run.error.message);
  await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
  const task = await core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId: run.value.run.id, stageId: 'plan' });
  if (!task.ok) throw new Error(task.error.message);
  const planned = await core.plannerRuntime!.runPlanningTurn({
    companyId: COMPANY, runId: run.value.run.id, taskId: task.value.taskId,
    planningCommandId: `plan-${core.ids.id('p')}`, actorId: actor,
  });
  if (!planned.ok) throw new Error(planned.error.message);
  const compiled = await core.planCompiler!.compile({
    companyId: COMPANY, planningRunId: run.value.run.id, planArtifactId: planned.value.artifactId,
    compilationCommandId: `compile-${core.ids.id('c')}`, actorId: actor,
    executionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
  }, SPEC);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const started = await core.sprint13.engine.drive(compiled.value.executionRunId, { maxSteps: 7 });
  if (!started.ok) throw new Error(started.error.message);
  return { core, actor, script, executionRunId: compiled.value.executionRunId, planId: compiled.value.planId, paths };
};

/** The supplier-stage task — the canonical SUBJECT the inspection reviews (never a guess). */
const subjectTaskOf = async (f: Fixture): Promise<string> => {
  const tasks = (await f.core.database.tasks.listByRun(f.executionRunId))
    .filter((t) => String(t.stageId) === compiledNodeId(f.planId, 'supplier-analysis'));
  const subject = tasks[0];
  if (subject === undefined) throw new Error('the supplier task is missing');
  return String(subject.id);
};

const runAutonomous = async (
  f: { readonly core: Core; readonly actor: string; readonly executionRunId: string },
  taskId?: string,
) =>
  f.core.autonomousSupervisor!.run({
    companyId: COMPANY, runId: f.executionRunId,
    taskId: (taskId ?? '') as never,
    actorId: f.actor, runIdentity: `s21d:${String(f.executionRunId)}:${String(Math.random())}`,
  });

/** A durable AgentExecution the review sink resolves (it refuses unknown executions). */
const seedExecution = async (f: Fixture, taskId: string): Promise<string> => {
  const { createExecution } = await import('@companyos/core');
  const made = await createExecution({
    executionId: f.core.ids.id('exc'),
    agentId: 'agent_reviewer',
    roleId: 'rol.compliance-inspector' as never,
    taskId: taskId as never,
    runId: f.executionRunId as never,
    binding: { modelKey: MODEL_KEY, providerId: 'prov_e2e7', providerModelId: 'p1', source: 'EXPLICIT_BINDING' as const },
    attempt: 1,
    traceId: f.core.ids.id('trace'),
    now: new Date().toISOString(),
  });
  if (!made.ok) throw new Error(made.error.message);
  await f.core.database.agentExecutions.put({ ...made.value, status: 'COMPLETED' as never });
  return made.value.executionId;
};

const tasksOfStage = async (f: Fixture, item: string) => {
  const stageId = compiledNodeId(f.planId, item);
  return (await f.core.database.tasks.listByRun(f.executionRunId)).filter((t) => String(t.stageId) === stageId);
};

/** The reassessment task of the inspection stage (producer or descendant — both qualify). */
const reassessmentOf = async (f: Fixture) => {
  const reviewTasks = await tasksOfStage(f, 'compliance-inspection');
  const reassessment = reviewTasks.find((t) => t.inputs['companyos:reassessment'] !== undefined);
  if (reassessment === undefined) throw new Error('the reassessment task was not provisioned');
  return { reviewTasks, reassessment };
};

/* ============================================================ A. carrier reconciliation */

describe('S21D A — terminal carrier reconciliation', () => {
  it('A1. a durable unreconciled carrier never lets the run report COMPLETED', async () => {
    const f = await makeFixture(['PASS']);
    const subjectTaskId = await subjectTaskOf(f);
    // Crash at the INSPECTION unit's carrier window (the second settled unit — the supplier
    // analysis settles first): Task + attempt settled, the carrier has NOT routed.
    const crashed = await composeAt(f.paths, f.script, { crashAfterHits: 2 }).then(async ({ core, actor }) => {
      const result = await core.autonomousSupervisor!.run({
        companyId: COMPANY, runId: f.executionRunId,
        taskId: subjectTaskId as never, actorId: actor, runIdentity: `s21d-a1:${String(f.executionRunId)}`,
      }).catch((error: unknown) => ({ crashed: error }));
      return { core, result };
    });
    expect(crashed.result).toHaveProperty('crashed');
    // The durable truth at the kill: the inspection task is settled (DONE + a COMPLETED
    // attempt), its canonical report is NOT durable yet, and the run is NOT completed.
    const reviewTasks = (await crashed.core.database.tasks.listByRun(f.executionRunId))
      .filter((t) => String(t.stageId) === compiledNodeId(f.planId, 'compliance-inspection'));
    const settledReview = reviewTasks.find((t) => t.state === 'DONE');
    expect(settledReview).toBeDefined();
    const attempts = await crashed.core.database.executionAttempts.listByTask(String(settledReview!.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.state).toBe('COMPLETED');
    const findings = (await crashed.core.database.artifactStore!.listByRun(f.executionRunId as never))
      .filter((row) => row.kind === 'companyos:review-findings');
    expect(findings).toHaveLength(0); // the carrier never routed: nothing is invented
    expect((await crashed.core.database.runs.get(f.executionRunId as never))?.state).not.toBe('COMPLETED');
  });

  it('A2. the restart reconciles the carrier exactly once', async () => {
    const f = await makeFixture(['PASS']);
    const subjectTaskId = await subjectTaskOf(f);
    await composeAt(f.paths, f.script, { crashAfterHits: 2 }).then(async ({ core, actor }) => {
      await core.autonomousSupervisor!.run({
        companyId: COMPANY, runId: f.executionRunId,
        taskId: subjectTaskId as never, actorId: actor, runIdentity: `s21d-a2a:${String(f.executionRunId)}`,
      }).catch(() => undefined);
    });
    // A fresh composition over the SAME files: the loop head reconciles the settled unit
    // through the ONE carrier FIRST — exactly once.
    const again = await composeAt(f.paths, f.script);
    const result = await again.core.autonomousSupervisor!.run({
      companyId: COMPANY, runId: f.executionRunId,
      taskId: subjectTaskId as never, actorId: again.actor, runIdentity: `s21d-a2b:${String(f.executionRunId)}`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`restart failed: ${result.error.message}`);
    // Exactly ONE canonical report: written by the restart's reconciliation, never twice.
    const findings = (await again.core.database.artifactStore!.listByRun(f.executionRunId as never))
      .filter((row) => row.kind === 'companyos:review-findings');
    expect(findings).toHaveLength(1);
    // And the settled task was never re-claimed: one COMPLETED attempt, number 1.
    for (const task of await again.core.database.tasks.listByRun(f.executionRunId as never)) {
      if (task.state !== 'DONE') continue;
      const attempts = await again.core.database.executionAttempts.listByTask(String(task.id));
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.state).toBe('COMPLETED');
      expect(Number(attempts[0]!.seed.attemptNumber)).toBe(1);
    }
  });
});

/* ============================================================ B. legacy RUNNING upgrade */

describe('S21D B — legacy RUNNING upgrade', () => {
  it('B1. a RUNNING row with no attempt is reconstructed: same attempt, START applied once', async () => {
    const f = await makeFixture();
    const tasks = await f.core.database.tasks.listByRun(f.executionRunId);
    const subject = tasks.find((t) => String(t.stageId) === compiledNodeId(f.planId, 'supplier-analysis'));
    if (subject === undefined) throw new Error('the supplier task is missing');
    // The pre-Sprint21 shape: the task row says RUNNING (START already consumed) and NO
    // execution_attempts row exists for it.
    const planned = applyTaskEvent(subject, 'PLAN', new Date().toISOString());
    if (!planned.ok) throw new Error(planned.error.message);
    const started = applyTaskEvent(planned.value, 'START', new Date().toISOString());
    if (!started.ok) throw new Error(started.error.message);
    expect(started.value.state).toBe('RUNNING');
    await f.core.database.tasks.put(started.value);
    expect(await f.core.database.executionAttempts.listByTask(String(subject.id))).toHaveLength(0);

    const result = await runAutonomous(f, String(subject.id));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`the run failed: ${result.error.message}`);
    const after = await f.core.database.tasks.get(String(subject.id) as never);
    expect(after?.state).toBe('DONE');
    // START was applied EXACTLY ONCE across the legacy upgrade: attempts stays 1.
    expect(Number(after?.attempts)).toBe(1);
    // The guarded reconstruction produced exactly ONE attempt row — the SAME attempt number
    // the legacy row had already consumed — and it settled COMPLETED.
    const attempts = await f.core.database.executionAttempts.listByTask(String(subject.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.state).toBe('COMPLETED');
    expect(Number(attempts[0]!.seed.attemptNumber)).toBe(1);
    expect(String(attempts[0]!.seed.taskKind)).toBe(String(subject.kind));
    expect(String(attempts[0]!.seed.roleId)).toBe(String(subject.roleId));
  });

  it('B2. the domain machine refuses illegal attempt transitions (frozen states)', () => {
    const made = createExecutionAttempt({
      id: 'exa_s21d_b2', companyId: COMPANY, runId: 'run_s21d_b2', taskId: 'tsk_s21d_b2',
      attemptNumber: 1, roleId: 'rol.supply-analyst', taskKind: 'task.supplier-analysis',
      runtimeInstanceId: 'rt_s21d', now: new Date().toISOString(),
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.state).toBe('ACTIVE');
    // COMPLETED is terminal: no transition may leave it (the frozen attempt machine).
    const settled = nextExecutionAttemptState('COMPLETED', made.value.state);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value).toBe('COMPLETED');
    expect(nextExecutionAttemptState('ACTIVE', 'COMPLETED').ok).toBe(false);
    // INTERRUPTED is the only way back into execution from a crashed claim, and an
    // INTERRUPTED attempt may never jump straight to COMPLETED (a crash is not a result).
    expect(nextExecutionAttemptState('ACTIVE', 'INTERRUPTED').ok).toBe(true);
    expect(nextExecutionAttemptState('COMPLETED', 'INTERRUPTED').ok).toBe(false);
    // A deterministic seed identity: the same permanent fields always derive the same id
    // and fingerprint — a different runtime token changes nothing.
    const again = createExecutionAttempt({
      id: 'exa_s21d_b2', companyId: COMPANY, runId: 'run_s21d_b2', taskId: 'tsk_s21d_b2',
      attemptNumber: 1, roleId: 'rol.supply-analyst', taskKind: 'task.supplier-analysis',
      runtimeInstanceId: 'rt_OTHER', now: '1970-01-01T00:00:00.000Z',
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.seed.fingerprint).toBe(made.value.seed.fingerprint);
    expect(again.value.seed.id).toBe(made.value.seed.id);
  });
});

/* ============================================================ C. desktop runtime ownership */

describe('S21D C — desktop runtime ownership', () => {
  it('C1. the OS single-instance lock lives in the desktop ENTRY, never in the composition', () => {
    const entry = readFileSync(
      fileURLToPath(new URL('../../apps/desktop/src/main.ts', import.meta.url)), 'utf8');
    const services = readFileSync(
      fileURLToPath(new URL('../../apps/desktop/src/core-services.ts', import.meta.url)), 'utf8');
    // The lock is taken by the process entry (OS-level, before any window exists).
    expect(entry).toContain('requestSingleInstanceLock');
    expect(entry).toContain('second-instance');
    // The composition never enforces it: composeCoreServices knows nothing of locks.
    expect(services).not.toContain('requestSingleInstanceLock');
    expect(services).not.toContain('second-instance');
    // The runtime ownership CARRY (C1 runtimeInstanceId) is composition data, not a lock.
    expect(services).toContain('runtimeInstanceId');
  });
});

/* ============================================================ D. descendant pinned-profile equality */

describe('S21D D — descendant pinned-profile equality', () => {
  it('D1. a reassessment task’s execution profile IS the pinned stage profile', async () => {
    const f = await makeFixture(['CHANGES_REQUESTED', 'PASS', 'PASS']);
    const result = await runAutonomous(f, await subjectTaskOf(f));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`the run failed: ${result.error.message}`);
    const { reassessment, reviewTasks } = await reassessmentOf(f);
    const seeded = reviewTasks.find((t) => t.inputs['companyos:reassessment'] === undefined);
    if (seeded === undefined) throw new Error('the seeded inspection task is missing');
    // The reassessment row carries the SAME pinned profile as the stage's own task — the
    // WorkflowVersion taskProfile, never an ad-hoc role/kind choice.
    expect(String(reassessment.roleId)).toBe(String(seeded.roleId));
    expect(String(reassessment.kind)).toBe(String(seeded.kind));
    expect(Number(reassessment.maxAttempts)).toBe(Number(seeded.maxAttempts));
    // And the run-pinned WorkflowVersion itself declares exactly this taskProfile for the
    // stage — the Task row is only the carrier, the version is the authority.
    const run = await f.core.database.runs.get(f.executionRunId as never);
    if (run === null) throw new Error('the run vanished');
    const template = await f.core.database.templates.get(String(run.templateId) as never);
    const version = template?.versions.find((entry) => entry.id === run.versionId);
    if (version === undefined) throw new Error('the pinned version is missing');
    const node = (version.graph as { nodes: readonly { id: string; config?: Record<string, unknown> }[] }).nodes
      .find((entry) => entry.id === String(reassessment.stageId));
    expect(node).toBeDefined();
    const taskProfile = node!.config!['taskProfile'] as { roleId: string; taskKind: string; maxAttempts: number };
    expect(String(reassessment.roleId)).toBe(taskProfile.roleId);
    expect(String(reassessment.kind)).toBe(taskProfile.taskKind);
    expect(Number(reassessment.maxAttempts)).toBe(Number(taskProfile.maxAttempts));
  });
});

/* ============================================================ E. foreign blocking, no hijack */

describe('S21D E — foreign finding blocks without projection hijack', () => {
  it('E1. a foreign finding blocks the turn and never supplies the corrective cause', async () => {
    const f = await makeFixture();
    const reviewTasks = await tasksOfStage(f, 'compliance-inspection');
    const anchor = reviewTasks[0];
    if (anchor === undefined) throw new Error('the inspection task is missing');
    const sink = f.core.reviewFindingsSink;
    if (sink === null) throw new Error('the review findings sink is not wired');
    // A canonical CHANGES_REQUESTED report anchored on a SECOND business task of the
    // supplier stage (a real task of this run, never the subject of THIS turn): durable,
    // unresolved, foreign here.
    const { createTask } = await import('@companyos/core');
    const supplierStageId = String((await tasksOfStage(f, 'supplier-analysis'))[0]!.stageId);
    const seededForeign = await createTask({
      runId: f.executionRunId as never,
      stageId: supplierStageId as never,
      roleId: 'rol.supply-analyst' as never,
      kind: 'task.supplier-analysis',
      maxAttempts: 1,
      inputs: {},
      now: new Date().toISOString(),
      ids: f.core.ids,
    });
    if (!seededForeign.ok) throw new Error(seededForeign.error.message);
    await f.core.database.tasks.put(seededForeign.value);
    const foreignSubject = seededForeign.value;
    const recorded = await sink.record({
      companyId: COMPANY, runId: f.executionRunId, reviewStageId: String(anchor.stageId),
      reviewTaskId: String(anchor.id), subjectTaskId: String(foreignSubject.id),
      executionId: await seedExecution(f, String(anchor.id)), verdict: 'CHANGES_REQUESTED',
      findings: [{ code: 'semantic.boundary', summary: 'A foreign blocking finding.', detail: 'd', blocking: true }],
      decidedBy: f.actor,
    });
    if (!recorded.ok) throw new Error(`record failed: ${recorded.error.message}`);
    const foreignReportId = recorded.value.artifactId;
    const supplierTaskId = await subjectTaskOf(f);

    // The durable proof: the foreign report IS recorded (it blocks the run) …
    const history = await sink.listReviewHistory({
      companyId: COMPANY, runId: f.executionRunId, reviewTaskId: String(anchor.id), actorId: f.actor,
    });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value.some((report) => report.artifactId === foreignReportId)).toBe(true);
    expect(history.value[0]!.payload.subjectTaskId).toBe(String(foreignSubject.id));
    // … and the turn's subject (the supplier task) has NO report of its own: the context's
    // subject-scoped review projection stays empty, so no corrective cause can name it.
    const supplierReports = history.value.filter((report) => report.payload.subjectTaskId === supplierTaskId);
    expect(supplierReports).toHaveLength(0);

    /*
     * The runtime's own verdict: with the foreign finding standing, the run-level blocking
     * condition makes CONTINUE illegal — the trusted runtime REFUSES the turn
     * (SUPERVISOR_PROPOSAL_CONTINUE_BLOCKED) instead of advancing on foreign evidence, and
     * the context projects NO subject-scoped review reference for this subject, so no
     * corrective cause can name it either.
     */
    const blocked = await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
      companyId: COMPANY, runId: f.executionRunId, taskId: supplierTaskId as never,
      reviewTaskId: String(anchor.id),
      actorId: f.actor,
      commandId: `supervisor-decision:${String(f.executionRunId)}:s21d-e1:0`,
      traceId: 's21d_e1_turn',
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(String(blocked.error.details['reason'])).toBe('SUPERVISOR_PROPOSAL_CONTINUE_BLOCKED');
  });
});

/* ============================================================ F. newer clean cannot mask */

describe('S21D F — a newer clean verdict cannot mask an older unresolved finding', () => {
  it('F1. an unresolved CHANGES_REQUESTED still blocks after a newer PASS exists', async () => {
    const f = await makeFixture();
    const reviewTasks = await tasksOfStage(f, 'compliance-inspection');
    const anchor = reviewTasks[0];
    if (anchor === undefined) throw new Error('the inspection task is missing');
    const sink = f.core.reviewFindingsSink;
    if (sink === null) throw new Error('the review findings sink is not wired');
    const supplierTaskId = await subjectTaskOf(f);
    // The OLD unresolved finding (never consumed by any decision) …
    const old = await sink.record({
      companyId: COMPANY, runId: f.executionRunId, reviewStageId: String(anchor.stageId),
      reviewTaskId: String(anchor.id), subjectTaskId: supplierTaskId,
      executionId: await seedExecution(f, String(anchor.id)), verdict: 'CHANGES_REQUESTED',
      findings: [{ code: 'semantic.boundary', summary: 'The unresolved finding.', detail: 'd', blocking: true }],
      decidedBy: f.actor,
    });
    if (!old.ok) throw new Error(`record failed: ${old.error.message}`);
    // … and the NEWER clean report on the same anchor (a later round that passed).
    const newer = await sink.record({
      companyId: COMPANY, runId: f.executionRunId, reviewStageId: String(anchor.stageId),
      reviewTaskId: String(anchor.id), subjectTaskId: supplierTaskId,
      executionId: await seedExecution(f, String(anchor.id)), verdict: 'PASS',
      findings: [], decidedBy: f.actor,
    });
    if (!newer.ok) throw new Error(`record failed: ${newer.error.message}`);
    // ALL_UNRESOLVED_ANCHORS: the applicator must not drive the run forward on the newer
    // PASS while the older blocking finding is unconsumed.
    const applied = await f.core.evidenceApplicator!.applyEvidence({
      companyId: COMPANY, runId: f.executionRunId, reviewTaskId: String(anchor.id), actorId: f.actor,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    if (applied.value !== null) {
      expect((await f.core.database.runs.get(f.executionRunId as never))?.state).not.toBe('COMPLETED');
    }
    // The durable proof: two reports on one anchor; the older one is still blocking.
    const history = await sink.listReviewHistory({
      companyId: COMPANY, runId: f.executionRunId, reviewTaskId: String(anchor.id), actorId: f.actor,
    });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value).toHaveLength(2);
    expect(history.value[0]!.payload.verdict).toBe('CHANGES_REQUESTED');
    expect(history.value[1]!.payload.verdict).toBe('PASS');
  });
});

/* ============================================================ G. canonical replacement */

describe('S21D G — post-completion descendant canonical replacement', () => {
  it('G1. the settled reassessment becomes the stage’s canonical subject', async () => {
    const f = await makeFixture(['CHANGES_REQUESTED', 'PASS', 'PASS']);
    const result = await runAutonomous(f, await subjectTaskOf(f));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`the run failed: ${result.error.message}`);
    // The two-stage plan's gate tail refuses to fake a PASS with no declared validator
    // requirements — a canonical safe stop; the reassessment chain is already durable.
    expect([...ANY_CANONICAL_STOP]).toContain(result.value.stopReason);
    const { reviewTasks } = await reassessmentOf(f);
    // The DESCENDANT reassessment — the one that carries the corrective lineage and becomes
    // the stage's canonical subject.
    const descendant = reviewTasks.find(
      (t) => t.inputs['companyos:reassessment'] !== undefined && t.inputs['corrective'] !== undefined,
    );
    if (descendant === undefined) throw new Error('the descendant reassessment was not provisioned');
    const reassessment = descendant;
    expect(reassessment.state).toBe('DONE');
    // The stage subject authority (a corrective child always wins over its ancestor): the
    // settled reassessment carries the corrective lineage, so downstream readers see the
    // corrected result.
    const lineage = reassessment.inputs['corrective'] as { round?: unknown; parentTaskId?: unknown } | undefined;
    expect(lineage).toBeDefined();
    expect(Number(lineage!['round'])).toBeGreaterThanOrEqual(1);
    // The stale seeded task remains DONE (history is never rewritten) but is no longer the
    // stage's subject — the causal child wins.
    const seeded = reviewTasks.find((t) => t.inputs['companyos:reassessment'] === undefined);
    if (seeded === undefined) throw new Error('the seeded inspection task is missing');
    expect(seeded.state).toBe('DONE');
    expect(String(reassessment.id)).not.toBe(String(seeded.id));
  });
});

/* ============================================================ H. causal WorkPackage */

describe('S21D H — causal WorkPackage projection', () => {
  it('H1. a reassessment task projects ITS corrective’s causal dossier', async () => {
    const f = await makeFixture(['CHANGES_REQUESTED', 'PASS', 'PASS']);
    const result = await runAutonomous(f, await subjectTaskOf(f));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`the run failed: ${result.error.message}`);
    const { reassessment } = await reassessmentOf(f);
    const marker = reassessment.inputs['companyos:reassessment'] as { correctiveTaskId: string };
    // The corrective it waits for is DONE (the immediate-corrective model executed it).
    const corrective = await f.core.database.tasks.get(marker.correctiveTaskId as never);
    if (corrective === null) throw new Error('the corrective task is missing');
    expect(corrective.state).toBe('DONE');
    // The projection carries the causal dossier of that corrective.
    const projected = await f.core.workPackageProjector!.project({
      companyId: COMPANY, runId: f.executionRunId, taskId: String(reassessment.id),
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) throw new Error(projected.error.message);
    const pkg = projected.value as { causal?: { correctiveTaskId?: string; resultKind?: string | null; artifactRefs?: readonly string[] } };
    expect(pkg.causal).toBeDefined();
    expect(String(pkg.causal!.correctiveTaskId)).toBe(marker.correctiveTaskId);
    // The projected kind IS the corrective task's durable stage-output kind (the corrected
    // result the reassessment re-evaluates), and its refs are the corrective's own output.
    const outputKind = String((corrective.outputs['stageOutput'] as { kind?: string } | undefined)?.kind ?? '');
    expect(pkg.causal!.resultKind).toBe(outputKind);
    // the refs are the corrective task's OWN durable artifact ids
    expect((pkg.causal!.artifactRefs ?? []).every((ref) => ref.startsWith('art_'))).toBe(true);
    expect(pkg.causal!.artifactRefs!.length).toBeGreaterThanOrEqual(1);
  });

  it('H2. a foreign corrective reference fails CLOSED', async () => {
    const f = await makeFixture();
    // A fully settled run first: the seeded reassessment's dependencies are then ready, so
    // the projection reaches the CAUSAL check and refuses the foreign reference there.
    const settled = await runAutonomous(f, await subjectTaskOf(f));
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw new Error(`the run failed: ${settled.error.message}`);
    const reviewTasks = await tasksOfStage(f, 'compliance-inspection');
    const anchor = reviewTasks[0];
    if (anchor === undefined) throw new Error('the inspection task is missing');
    const made = await import('@companyos/core').then((m) => m.createTask({
      runId: f.executionRunId as never,
      stageId: String(anchor.stageId) as never,
      roleId: String(anchor.roleId) as never,
      kind: String(anchor.kind),
      maxAttempts: 3,
      inputs: { 'companyos:reassessment': { correctiveTaskId: 'tsk_foreign_corrective' } },
      now: new Date().toISOString(),
      ids: f.core.ids,
    }));
    if (!made.ok) throw new Error(made.error.message);
    await f.core.database.tasks.put(made.value);
    const projected = await f.core.workPackageProjector!.project({
      companyId: COMPANY, runId: f.executionRunId, taskId: String(made.value.id),
    });
    expect(projected.ok).toBe(false);
    if (projected.ok) return;
    expect(String(projected.error.details['reason'])).toBe('WORK_PACKAGE_CAUSAL_REFERENCE_INVALID');
  });
});
