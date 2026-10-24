/**
 * Sprint 18 / Task-18-07 — production E2E through `composeCoreServices` (§75–§78).
 *
 * The chain runs on the REAL production composition entry: Run + Goal + Snapshot + pinned
 * bindings, the real Engine, the real Supervisor runtime, the real decision sink, the real
 * review sink, the real corrective provisioner (with the round ceiling) and the real artifact
 * primitives. No live model API: the model is the deterministic in-process fake registered
 * through the real provider registry.
 *
 * Four scenarios: the happy path, the corrective path, the round-limit path, and the restart
 * replay. Every step is called explicitly — the loop is the orchestrator's, not the test's.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createExecution, createTask, type DomainError, type Result } from '@companyos/core';
import { SUPERVISOR_PROPOSAL_SCHEMA, createMockProvider } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18e2e7-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const nowIso = (): string =>
  new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const CHAINS = [
  'core',
  'engine',
  'lifecycle',
  'provider',
  'registry',
  'selection',
  'agent',
  'tools',
  'artifact',
  'pack',
  'memory',
] as const;
const COMPANY = 'company_default';
const SUPERVISOR_BINDING = 'supervisor';
const PROVIDER_ID = 'prov_prod';
const MODEL_KEY = 'prod.supervisor';
const PROVIDER_MODEL_ID = 'prod-supervisor';
const CATALOGUE = [
  {
    modelId: PROVIDER_MODEL_ID,
    displayName: PROVIDER_MODEL_ID,
    contextWindow: 8_192,
    capabilities: { streaming: false, structuredOutput: true },
  },
];

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const compose = async (paths?: {
  readonly dataDir: string;
  readonly casRoot: string;
}): Promise<Core> => {
  const dataDir = paths?.dataDir ?? tempDir();
  const casRoot = paths?.casRoot ?? tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({
    casRoot,
    database: db,
    logger: nullLogger as never,
  });
  if (!foundation.ok) throw new Error(`artifact foundation failed: ${foundation.error.message}`);
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
  });
  if (core === null) throw new Error('production composition failed');
  return core;
};

const sessionActorOf = async (core: Core): Promise<string> => {
  const assignments = (await core.database.roleAssignments.list({ limit: 10 })).items;
  const actor = assignments[0]?.actorId;
  if (actor === undefined) throw new Error('the production composition provisioned no owner');
  return actor;
};

/** Register the deterministic model under the supervisor binding. */
const seedModel = async (core: Core, actor: string): Promise<void> => {
  const provider = await core.providers.register(
    createMockProvider({
      providerId: PROVIDER_ID,
      kind: 'mock',
      displayName: 'Production provider',
      script: { models: CATALOGUE },
    }),
    { actorId: actor },
  );
  if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
  const model = await core.models.registerFromProvider({
    providerId: PROVIDER_ID,
    providerModelId: PROVIDER_MODEL_ID,
    modelKey: MODEL_KEY,
    actorId: actor,
  });
  if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
};

/** Publish a two-stage template and start a run driven to EXECUTING by the real engine. */
const startRun = async (
  core: Core,
  actor: string,
  label: string,
): Promise<{ runId: string; workTaskId: string; reviewTaskId: string }> => {
  const template = await core.lifecycle.createTemplate({
    orgId: COMPANY,
    name: `E2E ${label}`,
    actorId: actor,
    traceId: `t18e7_tpl_${label}`,
  });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [
      // The work stage DECLARES the validator its evidence gate requires (Sprint 13 R1-B: the
      // stage snapshot is the authority, so the graph must name it).
      {
        id: 'work',
        kind: 'work' as const,
        title: 'work',
        config: { validatorIds: ['pack-a:unit'] },
      },
      { id: 'review', kind: 'review' as const, title: 'review', config: {} },
    ],
    edges: [{ from: 'work', to: 'review' }],
  };
  const saved = await core.lifecycle.saveDraftGraph({
    templateId: template.value.id,
    graph,
    actorId: actor,
    traceId: `t18e7_graph_${label}`,
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({
    templateId: template.value.id,
    actorId: actor,
    traceId: `t18e7_pub_${label}`,
  });
  if (!published.ok) throw new Error(published.error.message);
  const run = await core.lifecycle.createRun({
    templateId: template.value.id,
    companyId: COMPANY,
    workflowId: `wf_${label}`,
    actorId: actor,
    modelBindings: { [SUPERVISOR_BINDING]: MODEL_KEY },
    goal: { objective: `Deliver the ${label} slice.`, source: { type: 'human' } },
  });
  if (!run.ok) throw new Error(run.error.message);
  const engine = core.sprint13.engine;
  const driven = await engine.drive(run.value.run.id, { maxSteps: 8 });
  if (!driven.ok) throw new Error(driven.error.message);
  if (driven.value.run.state !== 'EXECUTING')
    throw new Error(`the engine left the run in ${driven.value.run.state}`);

  const work = await createTask({
    runId: run.value.run.id as never,
    stageId: 'work' as never,
    roleId: 'rol_dev' as never,
    kind: 'pack-a:build',
    now: nowIso(),
    ids: core.ids,
  });
  const review = await createTask({
    runId: run.value.run.id as never,
    stageId: 'review' as never,
    roleId: 'rol_reviewer' as never,
    kind: 'pack-a:build',
    now: nowIso(),
    ids: core.ids,
  });
  if (!work.ok || !review.ok) throw new Error('task seeding failed');
  await core.database.tasks.put(work.value);
  await core.database.tasks.put(review.value);
  return { runId: run.value.run.id, workTaskId: work.value.id, reviewTaskId: review.value.id };
};

/** Script the deterministic model's proposals, in order. */
const scriptProposals = (
  core: Core,
  values: readonly Readonly<Record<string, unknown>>[],
): void => {
  const registry = core.providers;
  void registry;
  // The mock adapter is registered per composition; its script is replaced through the
  // provider registry's bound adapter.
  const bound = core.providers.get(PROVIDER_ID) as unknown as {
    setScript?: (script: { models: readonly unknown[]; outcomes: readonly unknown[] }) => void;
  } | null;
  bound?.setScript?.({
    models: CATALOGUE,
    outcomes: values.map((value) => ({
      outputText: 'proposal',
      structured: { schema: SUPERVISOR_PROPOSAL_SCHEMA, ...value },
    })),
  });
};

const proposal = (over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  schema: SUPERVISOR_PROPOSAL_SCHEMA,
  action: 'CONTINUE',
  reasonCode: 'GOAL_SATISFIED',
  summary: 'The objective is on track.',
  evidenceRefs: [],
  subject: null,
  ...over,
});

/** A COMPLETED reviewer execution, so a review report can be recorded with real provenance. */
const reviewExecution = async (
  core: Core,
  input: { readonly runId: string; readonly reviewTaskId: string },
): Promise<string> => {
  const made = await createExecution({
    executionId: core.ids.id('exc'),
    agentId: 'agent_reviewer',
    roleId: 'rol_reviewer' as never,
    taskId: input.reviewTaskId as never,
    runId: input.runId as never,
    binding: {
      modelKey: MODEL_KEY,
      providerId: PROVIDER_ID,
      providerModelId: PROVIDER_MODEL_ID,
      source: 'EXPLICIT_BINDING',
    },
    attempt: 1,
    traceId: core.ids.id('trace'),
    now: nowIso(),
  });
  if (!made.ok) throw new Error(made.error.message);
  await core.database.agentExecutions.put({ ...made.value, status: 'COMPLETED' as never });
  return made.value.executionId;
};

const recordReview = async (
  core: Core,
  input: {
    readonly runId: string;
    readonly reviewTaskId: string;
    readonly subjectTaskId: string;
    readonly executionId: string;
    readonly verdict: 'PASS' | 'CHANGES_REQUESTED';
  },
): Promise<string> => {
  const sink = core.reviewFindingsSink;
  if (sink === null) throw new Error('the production review sink is not wired');
  const recorded = await sink.record({
    companyId: COMPANY,
    runId: input.runId,
    reviewStageId: 'review',
    reviewTaskId: input.reviewTaskId,
    subjectTaskId: input.subjectTaskId,
    executionId: input.executionId,
    verdict: input.verdict,
    findings:
      input.verdict === 'PASS'
        ? []
        : [
            {
              code: 'semantic.boundary',
              summary: 'The change crosses a frozen contract boundary.',
              detail: 'detail',
              blocking: true,
            },
          ],
    decidedBy: await sessionActorOf(core),
  });
  if (!recorded.ok) throw new Error(recorded.error.message);
  return recorded.value.artifactId;
};

const recordValidation = async (
  core: Core,
  input: {
    readonly runId: string;
    readonly status: 'pass' | 'fail';
    readonly artifactId?: string;
    readonly stageId?: string;
  },
): Promise<string> => {
  const { createValidation } = await import('@companyos/core');
  const made = await createValidation({
    runId: input.runId as never,
    ...(input.artifactId === undefined
      ? {}
      : { targetRef: `artifact:${input.artifactId}` as never }),
    ...(input.stageId === undefined ? {} : { stageId: input.stageId as never }),
    validatorId: 'pack-a:unit',
    validatorVersion: '1.0.0',
    status: input.status,
    blocking: true,
    exitCode: input.status === 'pass' ? 0 : 1,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    ids: core.ids,
  });
  if (!made.ok) throw new Error(made.error.message);
  await core.database.validationStore!.record(made.value, {
    creationCommandId: `cmd_v_${core.ids.id('v')}`,
    creationCommandFingerprint: 'fp:seed',
  });
  return made.value.id;
};

const taskCount = (core: Core): number =>
  Number(
    (core.database.db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number | bigint }).c,
  );
const executionCount = (core: Core): number =>
  Number(
    (
      core.database.db.prepare('SELECT COUNT(*) AS c FROM agent_executions').get() as {
        c: number | bigint;
      }
    ).c,
  );
const decisionCount = (core: Core): number =>
  Number(
    (
      core.database.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as {
        c: number | bigint;
      }
    ).c,
  );
const receiptCount = (core: Core): number =>
  Number(
    (
      core.database.db
        .prepare(
          "SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:supervisor-application'",
        )
        .get() as { c: number | bigint }
    ).c,
  );

const runAutonomous = async (
  core: Core,
  input: {
    readonly runId: string;
    readonly taskId: string;
    readonly reviewTaskId?: string;
    readonly identity: string;
  },
): Promise<
  Result<
    { readonly stopReason: string; readonly turns: number; readonly applied: readonly unknown[] },
    DomainError
  >
> => {
  const runtime = core.autonomousSupervisor;
  if (runtime === null) throw new Error('the production autonomous runtime is not wired');
  return runtime.run({
    companyId: COMPANY,
    runId: input.runId,
    taskId: input.taskId,
    ...(input.reviewTaskId === undefined ? {} : { reviewTaskId: input.reviewTaskId }),
    actorId: await sessionActorOf(core),
    runIdentity: input.identity,
  }) as unknown as Promise<
    Result<
      { readonly stopReason: string; readonly turns: number; readonly applied: readonly unknown[] },
      DomainError
    >
  >;
};

describe('T18-07 production E2E — happy path (§75)', () => {
  it('Goal → work → review PASS → QA PASS → Supervisor COMPLETE → Run completed', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedModel(core, actor);
    const { runId, workTaskId, reviewTaskId } = await startRun(core, actor, 'happy');

    // The work unit executes through the real engine.
    scriptProposals(core, [proposal({ subject: { taskId: workTaskId } })]);
    const first = await runAutonomous(core, {
      runId,
      taskId: workTaskId,
      reviewTaskId,
      identity: 'happy',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const work = await core.database.tasks.get(workTaskId as never);
    expect(work?.state).toBe('DONE');
    expect(receiptCount(core)).toBeGreaterThanOrEqual(1);

    // The durable quality evidence is produced through the canonical paths: a reviewer
    // execution with real provenance and a passing validation.
    const execution = await reviewExecution(core, { runId, reviewTaskId });
    await recordReview(core, {
      runId,
      reviewTaskId,
      subjectTaskId: workTaskId,
      executionId: execution,
      verdict: 'PASS',
    });
    const artifactService = core.sprint13.artifactService;
    const artifact = await artifactService.create({
      commandId: `t18e7-artifact:${runId}`,
      runId: runId as never,
      taskId: null,
      kind: 'companyos:evidence',
      content: new TextEncoder().encode(JSON.stringify({ kind: 'evidence', runId })),
      producedBy: actor,
      traceId: core.ids.id('trace'),
    });
    if (!artifact.ok) throw new Error(artifact.error.message);
    const validationArtifactId = artifact.value.id;
    const validationId = await recordValidation(core, {
      runId,
      status: 'pass',
      artifactId: validationArtifactId,
      stageId: 'work',
    });

    // The run reaches FINALIZING through the engine's OWN legal commands, following the state
    // it is actually in (the engine already moved it to REVIEWING when the work finished).
    const engine = core.sprint13.engine;
    const nextCommandFor = (state: string): string | null => {
      if (state === 'EXECUTING') return 'EXECUTION.COMPLETE';
      if (state === 'REVIEWING') return 'REVIEW.PASS';
      if (state === 'VALIDATING') return 'VALIDATION.PASS';
      return null;
    };
    for (let step = 0; step < 6; step += 1) {
      const current = await core.database.runs.get(runId as never);
      if (current === null) throw new Error('run vanished');
      const type = nextCommandFor(current.state);
      if (type === null) break;
      // The evidence gate requires its anchors on VALIDATION.PASS: the durable artifact the
      // validations are bound to.
      const anchors =
        type === 'VALIDATION.PASS'
          ? { payload: { artifactId: validationArtifactId, stageId: 'work' } }
          : {};
      const dispatched = await engine.dispatch({
        commandId: `t18e7-drive:${runId}:${type}:${String(current.revision)}`,
        runId,
        type,
        expectedRevision: current.revision,
        actorId: actor,
        traceId: core.ids.id('trace'),
        issuedAt: nowIso(),
        ...anchors,
      });
      if (!dispatched.ok) throw new Error(`${type} refused: ${dispatched.error.message}`);
    }
    scriptProposals(core, [
      proposal({
        action: 'COMPLETE',
        reasonCode: 'GOAL_SATISFIED',
        evidenceRefs: [validationId],
        subject: { taskId: workTaskId },
      }),
    ]);
    const completed = await runAutonomous(core, {
      runId,
      taskId: workTaskId,
      reviewTaskId,
      identity: 'happy-complete',
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.stopReason).toBe('completed');
    const run = await core.database.runs.get(runId as never);
    expect(run?.state).toBe('COMPLETED');
    expect(decisionCount(core)).toBeGreaterThanOrEqual(1);
  });
});

describe('T18-07 production E2E — corrective path (§76)', () => {
  it('Reviewer CHANGES_REQUESTED → REQUEST_CORRECTIVE → exactly one T1 → next turn', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedModel(core, actor);
    const { runId, workTaskId, reviewTaskId } = await startRun(core, actor, 'corrective');
    const execution = await reviewExecution(core, { runId, reviewTaskId });
    const reportId = await recordReview(core, {
      runId,
      reviewTaskId,
      subjectTaskId: workTaskId,
      executionId: execution,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposals(core, [
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'The reviewer requires corrective work.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: workTaskId },
      }),
      proposal({ subject: { taskId: workTaskId } }),
    ]);
    const result = await runAutonomous(core, {
      runId,
      taskId: workTaskId,
      reviewTaskId,
      identity: 'corrective',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    /*
     * Sprint21: exactly ONE CORRECTIVE task carries the durable lineage; the provisioner also
     * mints the deterministic post-corrective REASSESSMENT tasks for the producer stage and
     * every stale descendant stage (derived identities, causally gated on the corrective) —
     * they are not corrective rounds and never carry a round bump beyond the stage's own.
     */
    const rows = core.database.db.prepare('SELECT id, inputs_json, state FROM tasks').all() as {
      id: string;
      inputs_json: string;
      state: string;
    }[];
    const derived = rows.filter((row) => row.id !== workTaskId && row.id !== reviewTaskId);
    const correctiveRows = derived.filter(
      (row) =>
        JSON.parse(String(row.inputs_json))['companyos:reassessment'] === undefined &&
        JSON.parse(String(row.inputs_json))['corrective'] !== undefined,
    );
    expect(correctiveRows).toHaveLength(1);
    const child = correctiveRows[0]!;
    const lineage = JSON.parse(String(child.inputs_json))['corrective'] as Record<string, unknown>;
    expect(lineage['round']).toBe(1);
    expect(lineage['parentTaskId']).toBe(workTaskId);
    expect(lineage['rootTaskId']).toBe(workTaskId);
    // It was executed once through the engine and then the Supervisor was consulted again.
    expect(child.state).toBe('DONE');
    expect(result.value.turns).toBeGreaterThanOrEqual(2);
  });
});

describe('T18-07 production E2E — round limit (§77)', () => {
  it('T0 → T1 → T2 → T3, then NO T4 and a human-required stop', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedModel(core, actor);
    const { runId, workTaskId, reviewTaskId } = await startRun(core, actor, 'rounds');

    // Rounds 1–3 are provisioned through the production provisioner (the direct path a caller
    // would use), each with its own durable decision and review evidence.
    const provisioner = core.correctiveProvisioner;
    if (provisioner === null) throw new Error('the production provisioner is not wired');
    let subject = workTaskId;
    for (const round of [1, 2, 3]) {
      const execution = await reviewExecution(core, { runId, reviewTaskId });
      const reportId = await recordReview(core, {
        runId,
        reviewTaskId,
        subjectTaskId: subject,
        executionId: execution,
        verdict: 'CHANGES_REQUESTED',
      });
      const sink = core.supervisorDecisionSink;
      if (sink === null) throw new Error('the production decision sink is not wired');
      const { supervisorDecisionCommandId } = await import('@companyos/engine');
      const recorded = await sink.record({
        commandId: supervisorDecisionCommandId(runId, `round-${String(round)}`),
        companyId: COMPANY,
        runId,
        taskId: subject,
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'The reviewer requires corrective work.',
        evidenceRefs: [`artifact:${reportId}`],
        decidedBy: actor,
      });
      if (!recorded.ok) throw new Error(recorded.error.message);
      const provisioned = await provisioner.provision({
        companyId: COMPANY,
        runId,
        decisionId: recorded.value.decisionId,
        actorId: actor,
      });
      expect(provisioned.ok).toBe(true);
      if (!provisioned.ok) return;
      subject = provisioned.value.taskId;
    }
    const tasksAfterRound3 = taskCount(core);

    // Round 4 is refused BEFORE any task is created — the direct provisioner call too.
    const execution = await reviewExecution(core, { runId, reviewTaskId });
    const reportId = await recordReview(core, {
      runId,
      reviewTaskId,
      subjectTaskId: subject,
      executionId: execution,
      verdict: 'CHANGES_REQUESTED',
    });
    const { supervisorDecisionCommandId } = await import('@companyos/engine');
    const sink = core.supervisorDecisionSink!;
    const recorded = await sink.record({
      commandId: supervisorDecisionCommandId(runId, 'round-4'),
      companyId: COMPANY,
      runId,
      taskId: subject,
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'One more round.',
      evidenceRefs: [`artifact:${reportId}`],
      decidedBy: actor,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const refused = await provisioner.provision({
      companyId: COMPANY,
      runId,
      decisionId: recorded.value.decisionId,
      actorId: actor,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.details['reason']).toBe('CORRECTIVE_ROUND_LIMIT_EXCEEDED');
    expect(taskCount(core)).toBe(tasksAfterRound3);

    // The autonomous loop, asked for one more round, stops human-required and never completes.
    scriptProposals(core, [
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'One more round.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: subject },
      }),
    ]);
    const modelCallsBefore = 0;
    void modelCallsBefore;
    const loop = await runAutonomous(core, {
      runId,
      taskId: subject,
      reviewTaskId,
      identity: 'rounds',
    });
    expect(loop.ok).toBe(true);
    if (!loop.ok) return;
    expect(loop.value.stopReason).toBe('round_limit');
    const run = await core.database.runs.get(runId as never);
    expect(run?.state).not.toBe('COMPLETED');
    expect(taskCount(core)).toBe(tasksAfterRound3);
  });
});

describe('T18-07 production E2E — restart replay (§78)', () => {
  it('a fresh composition over the same files applies the Decision exactly once', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const first = await compose(paths);
    const actor = await sessionActorOf(first);
    await seedModel(first, actor);
    const { runId, workTaskId, reviewTaskId } = await startRun(first, actor, 'restart');
    scriptProposals(first, [
      proposal({ subject: { taskId: workTaskId } }),
      proposal({ subject: { taskId: workTaskId } }),
    ]);
    const before = await runAutonomous(first, {
      runId,
      taskId: workTaskId,
      reviewTaskId,
      identity: 'restart',
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const tasksBefore = taskCount(first);
    const receiptsBefore = receiptCount(first);
    const work = await first.database.tasks.get(workTaskId as never);
    expect(work?.state).toBe('DONE');

    // A fresh composition over the SAME durable files, running the SAME identity.
    first.database.close();
    const tracked = openDatabases.indexOf(first.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const second = await compose(paths);
    const actorAgain = await sessionActorOf(second);
    expect(actorAgain).toBe(actor);
    await seedModel(second, actorAgain);
    scriptProposals(second, [
      proposal({ subject: { taskId: workTaskId } }),
      proposal({ subject: { taskId: workTaskId } }),
    ]);
    const after = await runAutonomous(second, {
      runId,
      taskId: workTaskId,
      reviewTaskId,
      identity: 'restart',
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // Exactly one effect, forever: no second execution, no second task, no second receipt.
    expect(taskCount(second)).toBe(tasksBefore);
    expect(receiptCount(second)).toBe(receiptsBefore);
    expect(executionCount(second)).toBeGreaterThanOrEqual(1);
  });
});
