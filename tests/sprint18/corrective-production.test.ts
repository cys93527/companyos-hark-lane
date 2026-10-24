/**
 * Sprint 18 / Task-18-05 — production E2E through `composeCoreServices` (§79/§80/§81).
 *
 * The chain runs on the REAL production composition entry: Run + Goal + Snapshot + pinned
 * binding, a real AgentExecution, a real review report, a real REQUEST_CORRECTIVE Decision and
 * the real corrective provisioner. Every step is called explicitly — no loop, no automation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createExecution } from '@companyos/core';
import { createMockProvider, supervisorDecisionCommandId } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18e2e5-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack', 'memory'] as const;
const COMPANY = 'company_default';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const compose = async (paths?: { readonly dataDir: string; readonly casRoot: string }): Promise<Core> => {
  const dataDir = paths?.dataDir ?? tempDir();
  const casRoot = paths?.casRoot ?? tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error(`artifact foundation failed: ${foundation.error.message}`);
  const core = await composeCoreServices(db, nullLogger as never, { artifactFoundation: foundation as never });
  if (core === null) throw new Error('production composition failed');
  return core;
};

const sessionActorOf = async (core: Core): Promise<string> => {
  const assignments = (await core.database.roleAssignments.list({ limit: 10 })).items;
  const actor = assignments[0]?.actorId;
  if (actor === undefined) throw new Error('the production composition provisioned no owner');
  return actor;
};

/** Publish a two-stage template and start a run with a goal and a pinned binding. */
const startRun = async (
  core: Core,
  actor: string,
  label: string,
): Promise<{ readonly runId: string; readonly workTaskId: string; readonly reviewTaskId: string }> => {
  const provider = await core.providers.register(
    createMockProvider({
      providerId: 'prov_prod',
      kind: 'mock',
      displayName: 'Production provider',
      script: { models: [{ modelId: 'prod-model', displayName: 'prod-model', contextWindow: 8_192, capabilities: { streaming: false } }] },
    }),
    { actorId: actor },
  );
  if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
  const model = await core.models.registerFromProvider({ providerId: 'prov_prod', providerModelId: 'prod-model', modelKey: 'prod.reviewer', actorId: actor });
  if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);

  const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: `E2E ${label}`, actorId: actor, traceId: `t18e5_tpl_${label}` });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [
      { id: 'work', kind: 'work' as const, title: 'work', config: {} },
      { id: 'review', kind: 'review' as const, title: 'review', config: {} },
    ],
    edges: [{ from: 'work', to: 'review' }],
  };
  const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor, traceId: `t18e5_graph_${label}` });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({ templateId: template.value.id, actorId: actor, traceId: `t18e5_pub_${label}` });
  if (!published.ok) throw new Error(published.error.message);
  const run = await core.lifecycle.createRun({
    templateId: template.value.id,
    companyId: COMPANY,
    workflowId: `wf_${label}`,
    actorId: actor,
    modelBindings: { reviewer: 'prod.reviewer' },
    goal: { objective: `Deliver the ${label} slice.`, source: { type: 'human' } },
  });
  if (!run.ok) throw new Error(run.error.message);

  const { createTask } = await import('@companyos/core');
  const work = await createTask({ runId: run.value.run.id as never,  stageId: 'work' as never, roleId: 'rol_dev' as never, kind: 'pack-a:build', now: nowIso(), ids: core.ids });
  const review = await createTask({ runId: run.value.run.id as never,  stageId: 'review' as never, roleId: 'rol_reviewer' as never, kind: 'review', now: nowIso(), ids: core.ids });
  if (!work.ok || !review.ok) throw new Error('task seeding failed');
  await core.database.tasks.put(work.value);
  await core.database.tasks.put(review.value);
  return { runId: run.value.run.id, workTaskId: work.value.id, reviewTaskId: review.value.id };
};

/** A COMPLETED reviewer execution running the pinned binding. */
const reviewExecution = async (core: Core, input: { readonly runId: string; readonly reviewTaskId: string }): Promise<string> => {
  const made = await createExecution({
    executionId: core.ids.id('exc'),
    agentId: 'agent_reviewer',
    roleId: 'rol_reviewer' as never,
    taskId: input.reviewTaskId as never,
    runId: input.runId as never,
    binding: { modelKey: 'prod.reviewer', providerId: 'prov_prod', providerModelId: 'prod-model', source: 'EXPLICIT_BINDING' },
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
  input: { readonly runId: string; readonly reviewTaskId: string; readonly subjectTaskId: string; readonly executionId: string },
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

const correctiveDecision = async (
  core: Core,
  input: { readonly runId: string; readonly identity: string; readonly evidenceRefs: readonly string[] },
): Promise<string> => {
  const sink = core.supervisorDecisionSink;
  if (sink === null) throw new Error('the production decision sink is not wired');
  const recorded = await sink.record({
    commandId: supervisorDecisionCommandId(input.runId, input.identity),
    companyId: COMPANY,
    runId: input.runId,
    action: 'REQUEST_CORRECTIVE',
    reasonCode: 'REVIEW_FINDING',
    summary: 'The reviewer requires corrective work.',
    evidenceRefs: input.evidenceRefs,
    decidedBy: await sessionActorOf(core),
  });
  if (!recorded.ok) throw new Error(recorded.error.message);
  return recorded.value.decisionId;
};

describe('T18-05 production corrective E2E (§79)', () => {
  it('creates T1 with parent/root/round and never executes it', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    const { runId, workTaskId, reviewTaskId } = await startRun(core, actor, 'basic');
    const execution = await reviewExecution(core, { runId, reviewTaskId });
    const report = await changesReport(core, { runId, reviewTaskId, subjectTaskId: workTaskId, executionId: execution });
    const decisionId = await correctiveDecision(core, { runId, identity: 'basic', evidenceRefs: [report] });

    const provisioner = core.correctiveProvisioner;
    if (provisioner === null) throw new Error('the production provisioner is not wired');
    const provisioned = await provisioner.provision({ companyId: COMPANY, runId, decisionId, actorId: actor });
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;
    expect(provisioned.value.lineage.parentTaskId).toBe(workTaskId);
    expect(provisioned.value.lineage.rootTaskId).toBe(workTaskId);
    expect(provisioned.value.lineage.round).toBe(1);

    const task = await core.database.tasks.get(provisioned.value.taskId as never);
    expect(task?.state).toBe('PENDING');
    expect(task?.attempts).toBe(0);
    // Nothing was executed, no baseline, no QA, no extra execution.
    const counts = {
      executions: Number((core.database.db.prepare('SELECT COUNT(*) AS c FROM agent_executions').get() as { c: number | bigint }).c),
      invocations: Number((core.database.db.prepare('SELECT COUNT(*) AS c FROM tool_invocations').get() as { c: number | bigint }).c),
      validations: Number((core.database.db.prepare('SELECT COUNT(*) AS c FROM validations').get() as { c: number | bigint }).c),
    };
    expect(counts.executions).toBe(1);
    expect(counts.invocations).toBe(0);
    expect(counts.validations).toBe(0);
  });

  it('nested corrective chains T2 onto T1 (§80)', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    const { runId, workTaskId, reviewTaskId } = await startRun(core, actor, 'nested');
    let subject = workTaskId;
    const taskIds: string[] = [];
    for (const round of [1, 2]) {
      const execution = await reviewExecution(core, { runId, reviewTaskId });
      const report = await changesReport(core, { runId, reviewTaskId, subjectTaskId: subject, executionId: execution });
      const decisionId = await correctiveDecision(core, { runId, identity: `nested-${round}`, evidenceRefs: [report] });
      const provisioner = core.correctiveProvisioner;
      if (provisioner === null) throw new Error('the production provisioner is not wired');
      const provisioned = await provisioner.provision({ companyId: COMPANY, runId, decisionId, actorId: actor });
      expect(provisioned.ok).toBe(true);
      if (!provisioned.ok) return;
      taskIds.push(provisioned.value.taskId);
      subject = provisioned.value.taskId;
    }
    const provisioner = core.correctiveProvisioner;
    if (provisioner === null) throw new Error('the production provisioner is not wired');
    const second = await provisioner.getCorrectiveLineage({ companyId: COMPANY, runId, taskId: taskIds[1]! });
    expect(second.ok).toBe(true);
    if (!second.ok || second.value === null) return;
    expect(second.value.parentTaskId).toBe(taskIds[0]);
    expect(second.value.rootTaskId).toBe(workTaskId);
    expect(second.value.round).toBe(2);
  });

  it('a crash window replays the same task (§81)', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const first = await compose(paths);
    const actor = await sessionActorOf(first);
    const { runId, workTaskId, reviewTaskId } = await startRun(first, actor, 'crash');
    const execution = await reviewExecution(first, { runId, reviewTaskId });
    const report = await changesReport(first, { runId, reviewTaskId, subjectTaskId: workTaskId, executionId: execution });
    const decisionId = await correctiveDecision(first, { runId, identity: 'crash', evidenceRefs: [report] });

    const provisioner = first.correctiveProvisioner;
    if (provisioner === null) throw new Error('the production provisioner is not wired');
    const provisioned = await provisioner.provision({ companyId: COMPANY, runId, decisionId, actorId: actor });
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;

    // A fresh composition over the SAME durable files, provisioning the SAME decision.
    first.database.close();
    const tracked = openDatabases.indexOf(first.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const second = await compose(paths);
    const actorAgain = await sessionActorOf(second);
    expect(actorAgain).toBe(actor);
    const freshProvisioner = second.correctiveProvisioner;
    if (freshProvisioner === null) throw new Error('the production provisioner is not wired');
    const replayed = await freshProvisioner.provision({ companyId: COMPANY, runId, decisionId, actorId: actorAgain });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.taskId).toBe(provisioned.value.taskId);
    expect(replayed.value.replayed).toBe(true);
    /*
     * Sprint21: the crash window replays the WHOLE deterministic unit — the corrective
     * (singular, same permanent identity) plus its derived reassessment tasks (deterministic
     * identities, so the replay writes none of them twice). The row set is exactly the seeded
     * pair, the one corrective, and the one producer-stage reassessment.
     */
    const rowsAfter = second.database.db
      .prepare('SELECT id, inputs_json FROM tasks')
      .all() as { id: string; inputs_json: string }[];
    expect(rowsAfter).toHaveLength(4);
    const correctiveRows = rowsAfter.filter(
      (row) =>
        row.id !== workTaskId &&
        row.id !== reviewTaskId &&
        JSON.parse(String(row.inputs_json))['companyos:reassessment'] === undefined &&
        JSON.parse(String(row.inputs_json))['corrective'] !== undefined,
    );
    expect(correctiveRows).toHaveLength(1);
    expect(correctiveRows[0]!.id).toBe(provisioned.value.taskId);
    const reassessmentRows = rowsAfter.filter(
      (row) => JSON.parse(String(row.inputs_json))['companyos:reassessment'] !== undefined,
    );
    expect(reassessmentRows).toHaveLength(1);
    const lineage = await freshProvisioner.getCorrectiveLineage({ companyId: COMPANY, runId, taskId: replayed.value.taskId });
    expect(lineage.ok).toBe(true);
    if (!lineage.ok || lineage.value === null) return;
    expect(lineage.value.parentTaskId).toBe(workTaskId);
    expect(lineage.value.round).toBe(1);
  });
});
