/**
 * Sprint 23 — shared observation fixture (NOT a test file).
 *
 * A production composition (composeCoreServices + artifact foundation) over a
 * real durable database, with a published three-stage workflow (work → review
 * with a review-kind task → qa with pinned validatorIds) and a run driven to
 * EXECUTING. Tests seed canonical rows directly through the real stores —
 * observation reads them; nothing here mutates workflow semantics.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';
import type { ToolPort } from '@companyos/core';

import { composeCoreServices } from '../../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../../apps/desktop/src/artifact-stack.js';

export const CHAINS = [
  'core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff',
] as const;
export const COMPANY = 'company_default';
export const OTHER_COMPANY = 'company_other';
export const MODEL_KEY = 'e2e7.supervisor';
export const VALIDATOR_ID = 'val.observe';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];

export const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s23-'));
  createdDirs.push(dir);
  return dir;
};

export const validatorPort = (): ToolPort => ({
  describe: () => ({
    toolId: VALIDATOR_ID, name: 'observation validator', description: 'fixture validator',
    version: '1', capabilities: ['validator'] as never, riskLevel: 'LOW',
    parameters: { type: 'object', additionalProperties: true },
  }),
  async invoke(request) {
    const at = new Date().toISOString();
    return {
      status: 'ok' as const,
      output: { verdict: 'pass', evidenceRefs: [`command:${VALIDATOR_ID}:${request.idempotencyKey ?? 'once'}`] },
      artifactRefs: [], startedAt: at, finishedAt: at, latencyMs: 1,
    } as never;
  },
});

export interface S23Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly runId: string;
  readonly workTaskId: string;
  readonly reviewTaskId: string;
  readonly qaTaskId: string;
  readonly paths: { readonly dataDir: string; readonly casRoot: string };
  readonly close: () => void;
}

export const composeAt = async (paths: { readonly dataDir: string; readonly casRoot: string }) => {
  const db = openDurableDatabase({ dataDir: paths.dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot: paths.casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error(`foundation failed: ${foundation.error.message}`);
  const core = await composeCoreServices(db, nullLogger as never, {
    // The routing model fake: registers the provider + model the run's pinned
    // supervisor binding resolves to (observations only; no autonomy is driven).
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: ['task.observation-review'], qaKinds: [], executorKinds: ['task.observation-work'] },
    toolPorts: new Map<string, ToolPort>([[VALIDATOR_ID, validatorPort()]]),
  });
  if (core === null) throw new Error('production composition failed');
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  return { core, actor };
};

export const makeFixture = async (): Promise<S23Fixture> => {
  const paths = { dataDir: tempDir(), casRoot: tempDir() };
  const { core, actor } = await composeAt(paths);
  const provider = {
    describe: () => ({ providerId: 'prov_e2e7', kind: 'fake' as const, displayName: 'r', version: '1' }),
    listModels: () => Promise.resolve({ ok: true as const, value: [{ modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }] }),
    health: () => Promise.resolve({ ok: true as const, value: undefined as never }),
    invoke: () => Promise.resolve({ ok: true as const, value: {
      modelId: 'p1', providerId: 'prov_e2e7', outputText: 'observed', structured: {}, toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalCost: null }, finishReason: 'stop' as const,
    } as never }),
    stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) }),
  } as never;
  await core.providers.register(provider, { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: `obs-${core.ids.id('t')}`, actorId: actor });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [
      { id: 'work', kind: 'work' as const, title: 'work', config: { taskProfile: { roleId: 'rol.worker', taskKind: 'task.observation-work', maxAttempts: 2 } } },
      { id: 'review', kind: 'review' as const, title: 'review', config: { taskProfile: { roleId: 'rol.inspector', taskKind: 'task.observation-review', maxAttempts: 2 } } },
      { id: 'qa', kind: 'qa' as const, title: 'qa', config: { taskProfile: { roleId: 'rol.verifier', taskKind: 'task.observation-qa', maxAttempts: 1 }, validatorIds: [VALIDATOR_ID] } },
    ],
    edges: [{ from: 'work', to: 'review' }, { from: 'review', to: 'qa' }],
  } as never;
  const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({ templateId: template.value.id, actorId: actor });
  if (!published.ok) throw new Error(published.error.message);
  const run = await core.lifecycle.createRun({
    templateId: template.value.id, companyId: COMPANY, workflowId: `wf-obs-${core.ids.id('w')}`, actorId: actor,
    goal: { objective: 'Observe this run.', source: { type: 'human' } },
    modelBindings: { supervisor: MODEL_KEY },
  });
  if (!run.ok) throw new Error(run.error.message);
  const driven = await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
  if (!driven.ok) throw new Error(driven.error.message);

  const { createTask } = await import('@companyos/core');
  const mk = async (stageId: string, roleId: string, kind: string) => {
    const made = await createTask({
      runId: run.value.run.id as never, stageId: stageId as never, roleId: roleId as never, kind,
      now: new Date().toISOString(), ids: core.ids,
    });
    if (!made.ok) throw new Error(made.error.message);
    await core.database.tasks.put(made.value);
    return String(made.value.id);
  };
  const workTaskId = await mk('work', 'rol.worker', 'task.observation-work');
  const reviewTaskId = await mk('review', 'rol.inspector', 'task.observation-review');
  const qaTaskId = await mk('qa', 'rol.verifier', 'task.observation-qa');

  return {
    core, actor, runId: String(run.value.run.id), workTaskId, reviewTaskId, qaTaskId, paths,
    close: () => {
      const index = openDatabases.indexOf(core.database);
      if (index >= 0) openDatabases.splice(index, 1);
      core.database.close();
    },
  };
};

export const cleanup = (): void => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
};

/** Seed a durable AgentExecution row the sinks resolve (provenance only). */
export const seedExecution = async (f: S23Fixture, taskId: string, runId = f.runId): Promise<string> => {
  const { createExecution } = await import('@companyos/core');
  const made = await createExecution({
    executionId: f.core.ids.id('exc'),
    agentId: 'agent.inspector',
    roleId: 'rol.inspector' as never,
    taskId: taskId as never,
    runId: runId as never,
    binding: { modelKey: MODEL_KEY, providerId: 'prov_e2e7', providerModelId: 'p1', source: 'EXPLICIT_BINDING' as const },
    attempt: 1,
    traceId: f.core.ids.id('trace'),
    now: new Date().toISOString(),
  });
  if (!made.ok) throw new Error(made.error.message);
  await f.core.database.agentExecutions.put({ ...made.value, status: 'COMPLETED' as never });
  return made.value.executionId;
};

/** Record a canonical review report through the T18-04 sink. */
export const recordReport = async (f: S23Fixture, input: {
  readonly reviewTaskId: string;
  readonly subjectTaskId: string;
  readonly verdict: 'PASS' | 'CHANGES_REQUESTED';
  readonly runId?: string;
}) => {
  const sink = f.core.reviewFindingsSink;
  if (sink === null) throw new Error('the review findings sink is not wired');
  const executionId = await seedExecution(f, input.reviewTaskId, input.runId);
  const task = await f.core.database.tasks.get(input.reviewTaskId as never);
  const recorded = await sink.record({
    companyId: COMPANY, runId: (input.runId ?? f.runId) as never, reviewStageId: String(task?.stageId),
    reviewTaskId: input.reviewTaskId, subjectTaskId: input.subjectTaskId,
    executionId, verdict: input.verdict,
    findings: input.verdict === 'CHANGES_REQUESTED'
      ? [{ code: 'observe.blocked', summary: 'A blocking finding.', detail: 'd', blocking: true }]
      : [],
    decidedBy: f.actor,
  });
  if (!recorded.ok) throw new Error(recorded.error.message);
  return String(recorded.value.artifactId);
};

/** Flip the run row's canonical state (test seeding of durable truth). */
export const setRunState = async (f: S23Fixture, state: string): Promise<void> => {
  const run = await f.core.database.runs.get(f.runId as never);
  if (run === null) throw new Error('run missing');
  await f.core.database.runs.put({ ...run, state: state as never } as never);
};

/** Insert a validation row directly (canonical truth, minimal columns). */
export const seedValidation = async (f: S23Fixture, input: {
  readonly validatorId: string;
  readonly status: 'pass' | 'fail';
  readonly taskId?: string;
}): Promise<void> => {
  const at = new Date().toISOString();
  f.core.database.db
    .prepare(
      `INSERT INTO validations (validation_id, run_id, stage_id, task_id, validator_id, validator_version,
         status, command, exit_code, blocking, evidence_refs_json, started_at, finished_at, created_at)
       VALUES (?, ?, NULL, ?, ?, '1', ?, NULL, 0, 1, '[]', ?, ?, ?)`,
    )
    .run(`val_${f.core.ids.id('v')}`, f.runId, input.taskId ?? null, input.validatorId, input.status, at, at, at);
};
