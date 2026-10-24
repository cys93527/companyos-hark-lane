/**
 * Sprint 18 / Task-18-04 — production E2E and restart E2E (§72/§73).
 *
 * Everything goes through `composeCoreServices` (the same module the desktop bootstrap uses),
 * including the canonical goal, the pinned binding, the review sink and the decision sink. The
 * Decision Sink is only used to prove that a review report Artifact is LEGAL
 * `REVIEW_FINDING` provenance — the decision is created explicitly by the test, never
 * automatically by the review sink.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nullLogger } from '@companyos/observability';
import { createMockProvider, supervisorDecisionCommandId } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18e2e-'));
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

const compose = async (paths?: {
  readonly dataDir: string;
  readonly casRoot: string;
}): Promise<NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>> => {
  const dataDir = paths?.dataDir ?? tempDir();
  const casRoot = paths?.casRoot ?? tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error(`artifact foundation failed: ${foundation.error.message}`);
  const core = await composeCoreServices(db, nullLogger as never, { artifactFoundation: foundation as never });
  if (core === null) throw new Error("production composition failed");
  return core;
};

/** The production composition authorizes the session actor; read it from the durable bootstrap. */
const sessionActorOf = async (core: { database: DurableDatabase }): Promise<string> => {
  const assignments = (await core.database.roleAssignments.list({ limit: 10 })).items;
  const actor = assignments[0]?.actorId;
  if (actor === undefined) throw new Error('the production composition provisioned no owner');
  return actor;
};

const setting = async (
  core: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>,
  actor: string,
  label: string,
  options: { readonly bindings?: Readonly<Record<string, string>> } = {},
): Promise<{ readonly runId: string; readonly reviewTaskId: string; readonly subjectTaskId: string }> => {
  if (options.bindings !== undefined) {
    // Register the pinned model through the REAL production registry.
    const provider = await core.providers.register(
      createMockProvider({
        providerId: 'prov_local',
        kind: 'mock',
        displayName: 'Local provider',
        script: {
          models: [
            { modelId: 'local-model-a', displayName: 'local-model-a', contextWindow: 8_192, capabilities: { streaming: false } },
          ],
        },
      }),
      { actorId: actor },
    );
    if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
    const model = await core.models.registerFromProvider({
      providerId: 'prov_local',
      providerModelId: 'local-model-a',
      modelKey: options.bindings['reviewer'] ?? 'local.model-a',
      actorId: actor,
    });
    if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
  }
  const template = await core.lifecycle.createTemplate({
    orgId: COMPANY,
    name: `Review e2e ${label}`,
    actorId: actor,
    traceId: `t18e_tpl_${label}`,
  });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [
      { id: 'work', kind: 'work' as const, title: 'work', config: {} },
      { id: 'review', kind: 'review' as const, title: 'review', config: {} },
    ],
    edges: [{ from: 'work', to: 'review' }],
  };
  const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor, traceId: `t18e_graph_${label}` });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({ templateId: template.value.id, actorId: actor, traceId: `t18e_pub_${label}` });
  if (!published.ok) throw new Error(published.error.message);
  const run = await core.lifecycle.createRun({
    templateId: template.value.id,
    companyId: COMPANY,
    workflowId: `wf_e2e_${label}`,
    actorId: actor,
    ...(options.bindings === undefined ? {} : { modelBindings: options.bindings }),
    goal: { objective: `Review the implementation work for ${label}.`, source: { type: 'human' } },
  });
  if (!run.ok) throw new Error(run.error.message);

  const { createTask } = await import('@companyos/core');
  const ids = core.ids;
  const review = await createTask({ runId: run.value.run.id as never,  stageId: 'review' as never, roleId: 'rol_reviewer' as never, kind: 'review', now: nowIso(), ids });
  // (the destructured ids come from the composition)
  const subject = await createTask({ runId: run.value.run.id as never,  stageId: 'work' as never, roleId: 'rol_dev' as never, kind: 'work', now: nowIso(), ids });
  if (!review.ok || !subject.ok) throw new Error('task seed failed');
  await core.database.tasks.put(review.value);
  await core.database.tasks.put(subject.value);
  return { runId: run.value.run.id, reviewTaskId: review.value.id, subjectTaskId: subject.value.id };
};

describe('T18-04 production review E2E (§72)', () => {
  it('records a CHANGES_REQUESTED report and exposes it as the latest, with decision compatibility', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
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
    expect(model.ok).toBe(true);

    const { runId, reviewTaskId, subjectTaskId } = await setting(core, actor, 'changes');
    // Re-create the run with the pinned binding through the production lifecycle.
    const template = await core.lifecycle.createTemplate({
      orgId: COMPANY,
      name: 'Review e2e bound',
      actorId: actor,
      traceId: 't18e_tpl_bound',
    });
    if (!template.ok) throw new Error(template.error.message);
    const graph = {
      nodes: [
        { id: 'work', kind: 'work' as const, title: 'work', config: {} },
        { id: 'review', kind: 'review' as const, title: 'review', config: {} },
      ],
      edges: [{ from: 'work', to: 'review' }],
    };
    await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor, traceId: 't18e_graph_bound' });
    await core.lifecycle.publish({ templateId: template.value.id, actorId: actor, traceId: 't18e_pub_bound' });
    const bound = await core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_e2e_bound',
      actorId: actor,
      modelBindings: { reviewer: 'prod.reviewer' },
      goal: { objective: 'Review the implementation work with a pinned binding.', source: { type: 'human' } },
    });
    if (!bound.ok) throw new Error(bound.error.message);
    const { createTask } = await import('@companyos/core');
    const review = await createTask({ runId: bound.value.run.id as never,  stageId: 'review' as never, roleId: 'rol_reviewer' as never, kind: 'review', now: nowIso(), ids: core.ids });
    const subject = await createTask({ runId: bound.value.run.id as never,  stageId: 'work' as never, roleId: 'rol_dev' as never, kind: 'work', now: nowIso(), ids: core.ids });
    if (!review.ok || !subject.ok) throw new Error('task seed failed');
    await core.database.tasks.put(review.value);
    await core.database.tasks.put(subject.value);
    void runId;
    void reviewTaskId;
    void subjectTaskId;

    const sink = core.reviewFindingsSink;
    if (sink === null) throw new Error('the production review sink is not wired');
    // The review execution that produced this report: a COMPLETED AgentExecution running the
    // pinned binding.
    const { createExecution } = await import('@companyos/core');
    const execution = await createExecution({
      executionId: core.ids.id('exc'),
      agentId: 'agent_reviewer',
      roleId: 'rol_reviewer' as never,
      taskId: review.value.id as never,
      runId: bound.value.run.id as never,
      binding: { modelKey: 'prod.reviewer', providerId: 'prov_prod', providerModelId: 'prod-model', source: 'EXPLICIT_BINDING' },
      attempt: 1,
      traceId: core.ids.id('trace'),
      now: nowIso(),
    });
    if (!execution.ok) throw new Error(execution.error.message);
    await core.database.agentExecutions.put({ ...execution.value, status: 'COMPLETED' as never });

    const recorded = await sink.record({
      companyId: COMPANY,
      runId: bound.value.run.id,
      reviewStageId: 'review',
      reviewTaskId: review.value.id,
      subjectTaskId: subject.value.id,
      executionId: execution.value.executionId,
      verdict: 'CHANGES_REQUESTED',
      findings: [
        {
          code: 'semantic.boundary',
          summary: 'The change crosses a frozen contract boundary.',
          detail: 'The reviewed diff edits a frozen interface.',
          blocking: true,
          subject: 'packages/core/src/lifecycle',
          locator: { path: 'packages/core/src/lifecycle/review-findings.ts', line: 40 },
        },
      ],
      modelBindingKey: 'reviewer',
      decidedBy: actor,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.payload.resolvedModelKey).toBe('prod.reviewer');
    expect(recorded.value.createdAt).not.toBe('');

    const latest = await sink.getLatestReviewReport({
      companyId: COMPANY,
      runId: bound.value.run.id,
      reviewTaskId: review.value.id,
      actorId: actor,
    });
    expect(latest.ok).toBe(true);
    if (!latest.ok || latest.value === null) return;
    expect(latest.value.payload.verdict).toBe('CHANGES_REQUESTED');

    // §62: the Decision Sink must ACCEPT the review report Artifact as REVIEW_FINDING
    // provenance — created explicitly here, never automatically by the review sink.
    const decisions = core.supervisorDecisionSink;
    if (decisions === null) throw new Error('the production decision sink is not wired');
    const decision = await decisions.record({
      commandId: supervisorDecisionCommandId(bound.value.run.id, 'review-findings'),
      companyId: COMPANY,
      runId: bound.value.run.id,
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'The reviewer report requires corrective work.',
      evidenceRefs: [`artifact:${recorded.value.artifactId}`],
      decidedBy: actor,
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.value.relatedArtifactRefs).toEqual([`artifact:${recorded.value.artifactId}`]);

    // And the review sink created no decision on its own.
    const rows = core.database.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as { c: number | bigint };
    expect(Number(rows.c)).toBe(1);
  });

  it('survives a restart: the report, its history and its binding provenance are durable', async () => {
    const durablePaths = { dataDir: tempDir(), casRoot: tempDir() };
    const first = await compose(durablePaths);
    const actor = await sessionActorOf(first);
    const { runId, reviewTaskId, subjectTaskId } = await setting(first, actor, 'restart', {
      bindings: { reviewer: 'local.model-a' },
    });
    const sink = first.reviewFindingsSink;
    if (sink === null) throw new Error('the production review sink is not wired');

    // Two DISTINCT durable AgentExecutions of the same review task: a new review execution is
    // what makes a new report legal (same execution ⇒ replay, never a second report).
    const { createExecution } = await import("@companyos/core");
    const executions: string[] = [];
    for (const attempt of [1, 2]) {
      const made = await createExecution({
        executionId: first.ids.id("exc"),
        agentId: 'agent_reviewer',
        roleId: 'rol_reviewer' as never,
        taskId: reviewTaskId as never,
        runId: runId as never,
        binding: { modelKey: 'local.model-a', providerId: 'prov_local', providerModelId: 'local-model-a', source: 'EXPLICIT_BINDING' },
        attempt,
        traceId: first.ids.id("trace"),
        now: nowIso(),
      });
      if (!made.ok) throw new Error(made.error.message);
      await first.database.agentExecutions.put({ ...made.value, status: 'COMPLETED' as never });
      executions.push(made.value.executionId);
    }

    const recorded = await sink.record({
      companyId: COMPANY,
      runId,
      reviewStageId: 'review',
      reviewTaskId,
      subjectTaskId,
      verdict: 'PASS',
      findings: [],
      executionId: executions[0]!,
      decidedBy: actor,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const secondRecorded = await sink.record({
      companyId: COMPANY,
      runId,
      reviewStageId: 'review',
      reviewTaskId,
      subjectTaskId,
      verdict: 'CHANGES_REQUESTED',
      findings: [
        {
          code: 'semantic.scope',
          summary: 'The reviewed scope drifted from the objective.',
          detail: 'The diff edits files outside the reviewed scope.',
          blocking: true,
        },
      ],
      executionId: executions[1]!,
      decidedBy: actor,
    });
    expect(secondRecorded.ok).toBe(true);
    if (!secondRecorded.ok) return;

    // Close the graph and rebuild through the SAME production entry over the SAME files.
    first.database.close();
    const tracked = openDatabases.indexOf(first.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);

    const second = await compose(durablePaths);
    const actorAgain = await sessionActorOf(second);
    expect(actorAgain).toBe(actor);
    const freshSink = second.reviewFindingsSink;
    if (freshSink === null) throw new Error('the production review sink is not wired');

    const history = await freshSink.listReviewHistory({ companyId: COMPANY, runId, reviewTaskId, actorId: actor });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value.map((view) => view.payload.verdict)).toEqual(['PASS', 'CHANGES_REQUESTED']);
    const latest = await freshSink.getLatestReviewReport({ companyId: COMPANY, runId, reviewTaskId, actorId: actor });
    expect(latest.ok).toBe(true);
    if (!latest.ok || latest.value === null) return;
    expect(latest.value.payload.verdict).toBe('CHANGES_REQUESTED');
    expect(latest.value.payload.subjectTaskId).toBe(subjectTaskId);
    // Same durable bytes: the artifact identity is stable across the restart.
    expect(latest.value.artifactId).toBe(secondRecorded.value.artifactId);
  });
});
