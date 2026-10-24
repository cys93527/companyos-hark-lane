/**
 * Sprint 18 / Task-18-06 — production E2E through `composeCoreServices` (§79/§80/§81).
 *
 * The chain runs on the REAL production composition entry: Run + Goal + Snapshot + pinned
 * binding, the real T18-04 review sink, the real validation store, the real agent runtime and
 * the real T18-03 decision sink. The model is the deterministic in-process fake registered
 * through the real provider registry — there is NO live model API anywhere in this file.
 *
 * Three proposals end to end (a review failure, a QA failure and a completion), plus the
 * restart replay that proves one turn identity yields ONE durable Decision. Every step is
 * called explicitly: no loop, no autonomous drive, no engine advance, no corrective creation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createExecution, createTask, createValidation } from '@companyos/core';
import {
  SUPERVISOR_PROPOSAL_SCHEMA,
  createMockProvider,
  supervisorDecisionCommandId,
  type SupervisorDecisionRuntime,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18e2e6-'));
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

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;
type TurnResult = Awaited<ReturnType<SupervisorDecisionRuntime['runOneSupervisorDecisionTurn']>>;

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

const envelopeOf = (core: Core): Record<string, unknown> => {
  const rows = core.database.db.prepare('SELECT * FROM decisions').all() as Record<
    string,
    unknown
  >[];
  const metadata = rows[0]?.['metadata_json'];
  expect(rows.length).toBe(1);
  const parsed = JSON.parse(String(metadata)) as { supervisor?: Record<string, unknown> };
  return parsed.supervisor ?? {};
};

/** The decision payload carries evidence as `{ kind, ref }` entries; the ref is what matters. */
const refsOf = (envelope: Readonly<Record<string, unknown>>): readonly string[] =>
  (Array.isArray(envelope['evidenceRefs'])
    ? (envelope['evidenceRefs'] as readonly { ref: string }[])
    : []
  ).map((entry) => entry.ref);

const count = (core: Core, table: string): number =>
  Number(
    (core.database.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number | bigint })
      .c,
  );

interface RunShape {
  readonly runId: string;
  readonly workTaskId: string;
  readonly reviewTaskId: string;
  /** The deterministic model handle: a scenario scripts its OWN proposal through it. */
  readonly model: ReturnType<typeof createMockProvider>;
}

/** The catalogue the mock provider must keep declared, or the registry's preflight refuses it. */
const PROD_MODELS = [
  {
    modelId: 'prod-supervisor',
    displayName: 'prod-supervisor',
    contextWindow: 8_192,
    capabilities: { streaming: false, structuredOutput: true },
  },
] as const;

/** Script the deterministic model's next (and only) structured proposal. */
const scriptProposal = (shape: RunShape, proposal: Readonly<Record<string, unknown>>): void => {
  shape.model.setScript({
    models: [...PROD_MODELS],
    outcomes: [
      { outputText: 'proposal', structured: { schema: SUPERVISOR_PROPOSAL_SCHEMA, ...proposal } },
    ],
  });
};

/** Publish a two-stage template, register a model under the supervisor binding and start a run. */
const startRun = async (core: Core, actor: string, label: string): Promise<RunShape> => {
  const registered = createMockProvider({
    providerId: 'prov_prod',
    kind: 'mock',
    displayName: 'Production provider',
    script: { models: [...PROD_MODELS] },
  });
  const provider = await core.providers.register(registered, { actorId: actor });
  if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
  const model = await core.models.registerFromProvider({
    providerId: 'prov_prod',
    providerModelId: 'prod-supervisor',
    modelKey: 'prod.supervisor',
    actorId: actor,
  });
  if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);

  const template = await core.lifecycle.createTemplate({
    orgId: COMPANY,
    name: `E2E ${label}`,
    actorId: actor,
    traceId: `t18e6_tpl_${label}`,
  });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [
      { id: 'work', kind: 'work' as const, title: 'work', config: {} },
      { id: 'review', kind: 'review' as const, title: 'review', config: {} },
    ],
    edges: [{ from: 'work', to: 'review' }],
  };
  const saved = await core.lifecycle.saveDraftGraph({
    templateId: template.value.id,
    graph,
    actorId: actor,
    traceId: `t18e6_graph_${label}`,
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({
    templateId: template.value.id,
    actorId: actor,
    traceId: `t18e6_pub_${label}`,
  });
  if (!published.ok) throw new Error(published.error.message);
  const run = await core.lifecycle.createRun({
    templateId: template.value.id,
    companyId: COMPANY,
    workflowId: `wf_${label}`,
    actorId: actor,
    modelBindings: { [SUPERVISOR_BINDING]: 'prod.supervisor' },
    goal: { objective: `Deliver the ${label} slice.`, source: { type: 'human' } },
  });
  if (!run.ok) throw new Error(run.error.message);

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
    kind: 'review',
    now: nowIso(),
    ids: core.ids,
  });
  if (!work.ok || !review.ok) throw new Error('task seeding failed');
  await core.database.tasks.put(work.value);
  await core.database.tasks.put(review.value);
  return {
    runId: run.value.run.id,
    workTaskId: work.value.id,
    reviewTaskId: review.value.id,
    model: registered,
  };
};

/** A COMPLETED reviewer execution, bound to the model the run pinned. */
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
      modelKey: 'prod.supervisor',
      providerId: 'prov_prod',
      providerModelId: 'prod-supervisor',
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

const changesReport = async (
  core: Core,
  input: {
    readonly runId: string;
    readonly reviewTaskId: string;
    readonly subjectTaskId: string;
    readonly executionId: string;
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
    verdict: 'CHANGES_REQUESTED',
    findings: [
      {
        code: 'semantic.boundary',
        summary: 'The change crosses a frozen contract boundary.',
        detail: 'The reviewed diff edits a frozen interface.',
        blocking: true,
      },
    ],
    decidedBy: await sessionActorOf(core),
  });
  if (!recorded.ok) throw new Error(recorded.error.message);
  return `artifact:${recorded.value.artifactId}`;
};

const recordValidation = async (
  core: Core,
  input: { readonly runId: string; readonly status: 'pass' | 'fail' },
): Promise<string> => {
  const made = await createValidation({
    runId: input.runId as never,
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

const supervisorTurn = async (
  core: Core,
  input: {
    readonly runId: string;
    readonly taskId: string;
    readonly reviewTaskId?: string;
    readonly identity: string;
  },
): Promise<TurnResult> => {
  const runtime = core.supervisorDecisionRuntime;
  if (runtime === null) throw new Error('the production supervisor runtime is not wired');
  return runtime.runOneSupervisorDecisionTurn({
    companyId: COMPANY,
    runId: input.runId,
    taskId: input.taskId,
    ...(input.reviewTaskId === undefined ? {} : { reviewTaskId: input.reviewTaskId }),
    actorId: await sessionActorOf(core),
    commandId: supervisorDecisionCommandId(input.runId, input.identity),
  });
};

const supervisorExecutionRow = (core: Core): Record<string, unknown> | undefined =>
  (
    core.database.db.prepare('SELECT * FROM agent_executions').all() as Record<string, unknown>[]
  ).find((row) => row['agent_id'] === 'supervisor-runtime');

describe('T18-06 production supervisor decision E2E (§79)', () => {
  it('a CHANGES_REQUESTED review produces ONE REQUEST_CORRECTIVE decision and nothing else', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    const shape = await startRun(core, actor, 'reviewfail');
    const { runId, workTaskId, reviewTaskId } = shape;
    const execution = await reviewExecution(core, { runId, reviewTaskId });
    const reportRef = await changesReport(core, {
      runId,
      reviewTaskId,
      subjectTaskId: workTaskId,
      executionId: execution,
    });
    // The model answers the review failure with a corrective request citing the report.
    scriptProposal(shape, {
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'The reviewer requires corrective work on the frozen boundary.',
      evidenceRefs: [reportRef],
      subject: { taskId: workTaskId },
    });

    const result = await supervisorTurn(core, {
      runId,
      taskId: workTaskId,
      reviewTaskId,
      identity: 'reviewfail',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.action).toBe('REQUEST_CORRECTIVE');
    expect(result.value.reasonCode).toBe('REVIEW_FINDING');
    expect(result.value.replayed).toBe(false);

    // ONE decision, citing the durable review report that caused it, marked RECORDED_ONLY.
    const envelope = envelopeOf(core);
    expect(envelope['action']).toBe('REQUEST_CORRECTIVE');
    expect(envelope['reasonCode']).toBe('REVIEW_FINDING');
    expect(refsOf(envelope)).toEqual([reportRef]);
    expect(envelope['executionStatus']).toBe('RECORDED_ONLY');
    expect(envelope['modelBindingKey']).toBe(SUPERVISOR_BINDING);
    expect(envelope['resolvedModelKey']).toBe('prod.supervisor');

    // It RECORDS ONLY: no corrective task, no tool, no validation.
    expect(count(core, 'tasks')).toBe(2);
    expect(count(core, 'tool_invocations')).toBe(0);
    expect(count(core, 'validations')).toBe(0);

    // The supervisor's own execution is COMPLETED, and it is joined to the Decision by the
    // traceId both durable rows carry — no invented `decision:<id>@<version>` ref namespace.
    const supervisorExecution = supervisorExecutionRow(core);
    expect(supervisorExecution).toBeDefined();
    expect(supervisorExecution?.['status']).toBe('COMPLETED');
    expect(supervisorExecution?.['result_ref']).toBeNull();
    const decisionRow = (
      core.database.db.prepare('SELECT trace_id FROM decisions').all() as Record<string, unknown>[]
    )[0];
    expect(decisionRow?.['trace_id']).toBe(supervisorExecution?.['trace_id']);
  });

  it('a failing validation produces ONE VALIDATION_FAILED request', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    const shape = await startRun(core, actor, 'qafail');
    const { runId, workTaskId, reviewTaskId } = shape;
    const execution = await reviewExecution(core, { runId, reviewTaskId });
    await changesReport(core, {
      runId,
      reviewTaskId,
      subjectTaskId: workTaskId,
      executionId: execution,
    });
    const failing = await recordValidation(core, { runId, status: 'fail' });
    scriptProposal(shape, {
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'VALIDATION_FAILED',
      summary: 'The latest validation of this run failed.',
      evidenceRefs: [failing],
      subject: { taskId: workTaskId },
    });

    const result = await supervisorTurn(core, {
      runId,
      taskId: workTaskId,
      reviewTaskId,
      identity: 'qafail',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.action).toBe('REQUEST_CORRECTIVE');
    expect(result.value.reasonCode).toBe('VALIDATION_FAILED');

    const envelope = envelopeOf(core);
    expect(envelope['reasonCode']).toBe('VALIDATION_FAILED');
    // The failing validation itself is the durable cause.
    expect(refsOf(envelope)).toEqual([failing]);
    // Still no corrective work item: provisioning is not this runtime's job.
    expect(count(core, 'tasks')).toBe(2);
  });

  it('a DONE subject task with a passing validation completes the turn', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    const shape = await startRun(core, actor, 'completefail');
    const { runId, workTaskId, reviewTaskId } = shape;
    const execution = await reviewExecution(core, { runId, reviewTaskId });
    const sink = core.reviewFindingsSink;
    if (sink === null) throw new Error('the production review sink is not wired');
    const passed = await sink.record({
      companyId: COMPANY,
      runId,
      reviewStageId: 'review',
      reviewTaskId,
      subjectTaskId: workTaskId,
      executionId: execution,
      verdict: 'PASS',
      findings: [],
      decidedBy: actor,
    });
    if (!passed.ok) throw new Error(passed.error.message);
    const validationId = await recordValidation(core, { runId, status: 'pass' });
    const done = await core.database.tasks.get(workTaskId as never);
    await core.database.tasks.put({ ...done!, state: 'DONE' as never });
    scriptProposal(shape, {
      action: 'COMPLETE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'The objective is delivered and the validation passes.',
      evidenceRefs: [validationId],
      subject: { taskId: workTaskId },
    });

    const result = await supervisorTurn(core, {
      runId,
      taskId: workTaskId,
      reviewTaskId,
      identity: 'completefail',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.action).toBe('COMPLETE');
    expect(result.value.reasonCode).toBe('GOAL_SATISFIED');

    const envelope = envelopeOf(core);
    expect(envelope['action']).toBe('COMPLETE');
    expect(refsOf(envelope)).toEqual([validationId]);
    // The run itself was NOT advanced: the decision is a durable fact, never an action.
    const run = await core.database.runs.get(runId as never);
    expect(run?.state).not.toBe('COMPLETED');
  });
});

describe('T18-06 production supervisor restart replay (§80)', () => {
  it('the same turn identity over the same durable files replays ONE decision with ZERO model calls', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const first = await compose(paths);
    const actor = await sessionActorOf(first);
    const shape = await startRun(first, actor, 'restart');
    const { runId, workTaskId, reviewTaskId } = shape;
    const execution = await reviewExecution(first, { runId, reviewTaskId });
    const reportRef = await changesReport(first, {
      runId,
      reviewTaskId,
      subjectTaskId: workTaskId,
      executionId: execution,
    });
    scriptProposal(shape, {
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'The reviewer requires corrective work.',
      evidenceRefs: [reportRef],
      subject: { taskId: workTaskId },
    });

    const before = await supervisorTurn(first, {
      runId,
      taskId: workTaskId,
      reviewTaskId,
      identity: 'restart',
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const executionsBefore = count(first, 'agent_executions');

    // A fresh composition over the SAME durable files, running the SAME turn identity.
    first.database.close();
    const tracked = openDatabases.indexOf(first.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const second = await compose(paths);
    const actorAgain = await sessionActorOf(second);
    expect(actorAgain).toBe(actor);
    const after = await supervisorTurn(second, {
      runId,
      taskId: workTaskId,
      reviewTaskId,
      identity: 'restart',
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.replayed).toBe(true);
    expect(after.value.decisionId).toBe(before.value.decisionId);
    expect(after.value.executionId).toBe(before.value.executionId);

    // ZERO new executions, ZERO new decisions, and the review evidence ref is unchanged.
    expect(count(second, 'agent_executions')).toBe(executionsBefore);
    const envelope = envelopeOf(second);
    expect(refsOf(envelope)).toEqual([reportRef]);
  });
});
