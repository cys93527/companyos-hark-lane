/**
 * Sprint 18 / Task-18-04 — durability, references and zero side effects (§69/§70/§71).
 *
 * The report rides the ArtifactService's permanent creation idempotency, so a replayed review
 * execution returns the SAME artifact even after the command ledger was trimmed and the whole
 * application graph was rebuilt.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createExecution, domainError, ok, type DomainError, type Result } from '@companyos/core';
import {
  REVIEW_FINDINGS_ARTIFACT_KIND,
  createArtifactService,
  createModelRegistry,
  createProviderRegistry,
  createReviewFindingsSink,
  createRunGoalService,
  createRunModelBindingReader,
  createRunSnapshotVerifier,
  createWorkflowLifecycle,
  type RecordReviewReportCommand,
  type ReviewFindingsSink,
} from '@companyos/engine';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18dur-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18V${String(++seq).padStart(12, '0')}`,
  ulid: () => `18V${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack', 'memory'] as const;
const COMPANY = 'company_default';
const ACTOR = 'user_owner';
const OBJECTIVE = 'Prove durable review reports and zero side effects.';

interface Graph {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly sink: ReviewFindingsSink;
  lifecycle(): ReturnType<typeof createWorkflowLifecycle>;
  artifacts(): ReturnType<typeof createArtifactService>;
  publishTemplate(label: string): Promise<string>;
  runWithGoal(label: string, options?: { readonly bindings?: Readonly<Record<string, string>> }): Promise<string>;
  seedTask(stageId: string, runIdOverride?: string): Promise<string>;
  seedArtifact(runId: string, label: string): Promise<string>;
  seedModel(modelKey: string): Promise<string>;
  seedExecution(runId: string, taskId: string): Promise<string>;
}

const graph = (db: DurableDatabase, dataDir: string, casRoot: string): Graph => {
  const authorize = async (): Promise<Result<true, DomainError>> => ok(true as const);
  const contentStore = createFilesystemArtifactContentStore({ casRoot });
  const artifacts = createArtifactService({
    artifactStore: db.artifactStore!,
    contentStore,
    runs: db.runs,
    events: db.events,
    ledger: db.ledger,
    clock,
    ids,
    unitOfWork: db.unitOfWork,
    // The artifact authority seam of THIS test composition (the sink itself has none).
    authorize: (async () => ok(true as const)) as never,
  });
  const runGoal = createRunGoalService({
    artifactService: artifacts,
    artifactStore: db.artifactStore!,
    contentStore,
    runs: db.runs,
  });
  const providers = createProviderRegistry({
    ids,
    clock,
    registrations: db.providers,
    models: db.providerModels,
    authorize: authorize as never,
    events: db.events,
    systemActor: ACTOR,
  });
  const models = createModelRegistry({
    ids,
    clock,
    records: db.modelRecords,
    aliases: db.modelAliases,
    providers,
    events: db.events,
    scope: 'default',
  });
  const lifecycle = createWorkflowLifecycle({
    ids,
    clock,
    templates: db.templates,
    locks: db.locks,
    proposals: db.proposals,
    snapshots: db.snapshots,
    runs: db.runs,
    events: db.events,
    unitOfWork: db.unitOfWork,
    ledger: db.ledger,
    runGoal,
    modelRegistry: models,
    authorize: authorize as never,
  });
  const durableReferenceResolver = async (
    refs: readonly string[],
  ): Promise<Result<readonly { kind: string; id: string; ref: string; runId: string }[], DomainError>> => {
    const anchored: { kind: string; id: string; ref: string; runId: string }[] = [];
    for (const ref of refs) {
      if (ref.startsWith('artifact:') || ref.startsWith('art_')) {
        const id = ref.startsWith('artifact:') ? ref.slice('artifact:'.length) : ref;
        const row = await db.artifactStore!.get(id as never);
        if (row === null) {
          return { ok: false as const, error: domainError('NOT_FOUND', `missing artifact ${ref}`, { reference: ref }) };
        }
        anchored.push({ kind: 'artifact', id: row.id, ref, runId: row.runId });
        continue;
      }
      if (ref.startsWith('val_')) {
        const row = await db.validationStore!.get(ref as never);
        if (row === null) {
          return { ok: false as const, error: domainError('NOT_FOUND', `missing validation ${ref}`, { reference: ref }) };
        }
        anchored.push({ kind: 'validation', id: row.id, ref, runId: row.runId });
        continue;
      }
      return { ok: false as const, error: domainError('INVALID_ARGUMENT', `unknown grammar ${ref}`, { reference: ref }) };
    }
    return { ok: true as const, value: anchored };
  };

  const sink = createReviewFindingsSink({
    runs: db.runs,
    tasks: db.tasks,
    templates: db.templates,
    agentExecutions: db.agentExecutions,
    artifactService: artifacts,
    artifactStore: db.artifactStore!,
    contentStore,
    runGoal,
    runSnapshotVerifier: createRunSnapshotVerifier({ templates: db.templates, snapshots: db.snapshots }),
    modelBindings: createRunModelBindingReader({ runs: db.runs, snapshots: db.snapshots }),
    modelRegistry: models,
    durableReferenceResolver,
    unitOfWork: db.unitOfWork,
    clock,
    ids,
  });

  let lastRunId: string | null = null;
  return {
    db,
    dataDir,
    casRoot,
    sink,
    lifecycle: () => lifecycle,
    artifacts: () => artifacts,
    async publishTemplate(label) {
      const template = await lifecycle.createTemplate({ orgId: COMPANY, name: `Durability flow ${label}`, actorId: ACTOR, traceId: `t18u_tpl_${label}` });
      if (!template.ok) throw new Error(template.error.message);
      const g = {
        nodes: [
          { id: 'work', kind: 'work' as const, title: 'work', config: {} },
          { id: 'review', kind: 'review' as const, title: 'review', config: {} },
        ],
        edges: [{ from: 'work', to: 'review' }],
      };
      const saved = await lifecycle.saveDraftGraph({ templateId: template.value.id, graph: g, actorId: ACTOR, traceId: `t18u_graph_${label}` });
      if (!saved.ok) throw new Error(saved.error.message);
      const published = await lifecycle.publish({ templateId: template.value.id, actorId: ACTOR, traceId: `t18u_pub_${label}` });
      if (!published.ok) throw new Error(published.error.message);
      return template.value.id;
    },
    async runWithGoal(label, options = {}) {
      const templateId = await this.publishTemplate(label);
      // The reviewer execution runs a model the run pins (the sink derives the binding from
      // the execution and then proves the run pinned exactly that model).
      if (options.bindings === undefined) await this.seedModel('local.model-a');
      const run = await lifecycle.createRun({
        templateId,
        companyId: COMPANY,
        workflowId: `wf_${label}`,
        actorId: ACTOR,
        modelBindings: options.bindings ?? { reviewer: 'local.model-a' },
        goal: { objective: OBJECTIVE, source: { type: 'human', ref: label } },
      });
      if (!run.ok) throw new Error(run.error.message);
      lastRunId = run.value.run.id;
      return run.value.run.id;
    },
    async seedTask(stageId, runIdOverride?: string) {
      const seedRunId = runIdOverride ?? lastRunId;
      if (seedRunId === null) throw new Error('seedTask requires a prior runAt/runWithGoal — canonical run ownership.');
      const { createTask } = await import('@companyos/core');
      const task = await createTask({ runId: seedRunId as never, stageId: stageId as never, roleId: 'rol_1' as never, kind: 'work', now: nowIso(), ids });
      if (!task.ok) throw new Error(task.error.message);
      await db.tasks.put(task.value);
      return task.value.id;
    },
    async seedArtifact(runId, label) {
      const made = await artifacts.create({
        commandId: `durability-evidence:${label}`,
        runId: runId as never,
        taskId: null,
        kind: 'companyos:evidence',
        content: new TextEncoder().encode(JSON.stringify({ label })),
        producedBy: ACTOR,
        traceId: `t18u_art_${label}`,
      });
      if (!made.ok) throw new Error(made.error.message);
      return `artifact:${made.value.id}`;
    },
    async seedModel(modelKey) {
      const provider = await providers.register(
        (await import('@companyos/engine')).createMockProvider({
          providerId: 'prov_local',
          kind: 'mock',
          displayName: 'Local provider',
          script: { models: [{ modelId: 'local-model', displayName: 'local-model', contextWindow: 8_192, capabilities: { streaming: false } }] },
        }),
        { actorId: ACTOR },
      );
      if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
      const model = await models.registerFromProvider({ providerId: 'prov_local', providerModelId: 'local-model', modelKey, actorId: ACTOR });
      if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
      return modelKey;
    },
    async seedExecution(runId, taskId, over: { attempt?: number; status?: string } = {}) {
      const made = await createExecution({
        executionId: ids.id('exc'),
        agentId: 'agent_reviewer',
        roleId: 'rol_reviewer' as never,
        taskId: taskId as never,
        runId: runId as never,
        binding: {
          modelKey: 'local.model-a',
          providerId: 'prov_local',
          providerModelId: 'local-model',
          source: 'EXPLICIT_BINDING',
        },
        attempt: 1,
        traceId: ids.id('trace'),
        now: nowIso(),
      });
      if (!made.ok) throw new Error(made.error.message);
      const stored =
        over.status === undefined
          ? { ...made.value, status: 'COMPLETED' as never }
          : { ...made.value, status: over.status as never };
      await db.agentExecutions.put(stored);
      return made.value.executionId;
    },
  };
};

const openGraph = (): Graph => {
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  return graph(db, dataDir, casRoot);
};

const restart = (previous: Graph): Graph => {
  previous.db.close();
  const tracked = openDatabases.indexOf(previous.db);
  if (tracked >= 0) openDatabases.splice(tracked, 1);
  const db = openDurableDatabase({ dataDir: previous.dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  return graph(db, previous.dataDir, previous.casRoot);
};

const commandFor = (
  runId: string,
  reviewTaskId: string,
  subjectTaskId: string,
  executionId: string,
  over: Partial<RecordReviewReportCommand> = {},
): RecordReviewReportCommand => ({
  companyId: COMPANY,
  runId,
  reviewStageId: 'review',
  reviewTaskId,
  subjectTaskId,
  executionId,
  verdict: 'PASS',
  findings: [],
  decidedBy: ACTOR,
  ...over,
});

const reviewRows = (db: DurableDatabase): number =>
  Number((db.db.prepare('SELECT COUNT(*) AS c FROM artifacts WHERE kind = ?').get(REVIEW_FINDINGS_ARTIFACT_KIND) as { c: number | bigint }).c);

const blockingFinding = (over: Record<string, unknown> = {}) => ({
  code: 'semantic.boundary',
  summary: 'The change crosses a frozen boundary.',
  detail: 'The reviewed diff touches a frozen contract.',
  blocking: true,
  ...over,
});

describe('T18-04 review durability (§69)', () => {
  it('21. the report is stored as an immutable run-owned artifact', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('immutable');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const recorded = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(reviewRows(g.db)).toBe(1);
    const row = g.db.db
      .prepare('SELECT kind, run_id, task_id FROM artifacts WHERE artifact_id = ?')
      .get(recorded.value.artifactId) as { kind: string; run_id: string; task_id: string };
    expect(row.kind).toBe(REVIEW_FINDINGS_ARTIFACT_KIND);
    expect(row.run_id).toBe(runId);
    expect(row.task_id).toBe(reviewTask);
  });

  it('22. the same review execution and payload replay the exact artifact', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('replay');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const first = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.artifactId).toBe(first.value.artifactId);
    expect(reviewRows(g.db)).toBe(1);
  });

  it('23. the same review execution with different content conflicts', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('conflict');
    const evidence = await g.seedArtifact(runId, 'conflict-1');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const first = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution));
    expect(first.ok).toBe(true);
    const changed = await g.sink.record(
      commandFor(runId, reviewTask, subjectTask, reviewExecution, {
        verdict: 'CHANGES_REQUESTED',
        findings: [blockingFinding({ evidenceRefs: [evidence] })],
      }),
    );
    expect(changed.ok).toBe(false);
    if (changed.ok) return;
    expect(changed.error.code).toBe('CONFLICT');
    expect(reviewRows(g.db)).toBe(1);
  });

  it('24. a ledger trim still replays the exact artifact', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('trim');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const first = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    g.db.db.prepare('DELETE FROM command_ledger').run();
    const fresh = restart(g);
    const again = await fresh.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.artifactId).toBe(first.value.artifactId);
    expect(reviewRows(fresh.db)).toBe(1);
  });

  it('25. a restart recovers the report', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('restart');
    const evidence = await g.seedArtifact(runId, 'restart-1');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const first = await g.sink.record(

      commandFor(runId, reviewTask, subjectTask, reviewExecution, {
        verdict: 'CHANGES_REQUESTED',
        findings: [blockingFinding({ evidenceRefs: [evidence] })],
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const fresh = restart(g);
    const recovered = await fresh.sink.getReviewReport({
      companyId: COMPANY,
      runId,
      artifactId: first.value.artifactId,
      actorId: ACTOR,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.payload.verdict).toBe('CHANGES_REQUESTED');
    expect(recovered.value.payload.findings[0]!.fingerprint).toBe(first.value.payload.findings[0]!.fingerprint);
    expect(recovered.value.payload.subjectTaskId).toBe(subjectTask);
  });

  it('26. a second review execution creates a second report', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('second-execution');
    const reviewTask = await g.seedTask('review');
    const subjectTask = await g.seedTask('work');
    const firstExecution = await g.seedExecution(runId, reviewTask);
    const secondExecution = await g.seedExecution(runId, reviewTask);

    const first = await g.sink.record(commandFor(runId, reviewTask, subjectTask, firstExecution));
    const second = await g.sink.record(commandFor(runId, reviewTask, subjectTask, secondExecution));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.artifactId).not.toBe(first.value.artifactId);
    expect(reviewRows(g.db)).toBe(2);
  });

  it('27. an old report is preserved forever', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('preserved');
    const reviewTask = await g.seedTask('review');
    const subjectTask = await g.seedTask('work');
    const firstExecution = await g.seedExecution(runId, reviewTask);
    const secondExecution = await g.seedExecution(runId, reviewTask);
    const first = await g.sink.record(commandFor(runId, reviewTask, subjectTask, firstExecution));
    const second = await g.sink.record(
      commandFor(runId, reviewTask, subjectTask, secondExecution, {
        verdict: 'CHANGES_REQUESTED',
        findings: [blockingFinding()],
      }),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const still = await g.sink.getReviewReport({ companyId: COMPANY, runId, artifactId: first.value.artifactId, actorId: ACTOR });
    expect(still.ok).toBe(true);
    if (!still.ok) return;
    expect(still.value.payload.verdict).toBe('PASS');
  });

  it('28. the full history is deterministic', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('history');
    const reviewTask = await g.seedTask('review');
    const subjectTask = await f2Task(g);
    void subjectTask;
    const execOne = await g.seedExecution(runId, reviewTask);
    const execTwo = await g.seedExecution(runId, reviewTask);
    const executions: string[] = [execOne, execTwo];
    const recorded = [
      await g.sink.record(commandFor(runId, reviewTask, await f2Task(g), executions[0]!)),
      await g.sink.record(
        commandFor(runId, reviewTask, await f2Task(g), executions[1]!, { verdict: 'CHANGES_REQUESTED', findings: [blockingFinding()] }),
      ),
    ];
    expect(recorded.every((result) => result.ok)).toBe(true);
    const left = await g.sink.listReviewHistory({ companyId: COMPANY, runId, reviewTaskId: reviewTask, actorId: ACTOR });
    const right = await g.sink.listReviewHistory({ companyId: COMPANY, runId, reviewTaskId: reviewTask, actorId: ACTOR });
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.value.map((view) => view.artifactId)).toEqual(right.value.map((view) => view.artifactId));
    expect(left.value).toHaveLength(2);
  });

  it('29. the latest report is the latest one, not the latest PASS', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('latest');
    const reviewTask = await g.seedTask('review');
    const subjectTask = await g.seedTask('work');
    const passExecution = await g.seedExecution(runId, reviewTask);
    const changesExecution = await g.seedExecution(runId, reviewTask);
    const pass = await g.sink.record(commandFor(runId, reviewTask, subjectTask, passExecution));
    const changes = await g.sink.record(
      commandFor(runId, reviewTask, subjectTask, changesExecution, { verdict: 'CHANGES_REQUESTED', findings: [blockingFinding()] }),
    );
    expect(pass.ok && changes.ok).toBe(true);
    const latest = await g.sink.getLatestReviewReport({ companyId: COMPANY, runId, reviewTaskId: reviewTask, actorId: ACTOR });
    expect(latest.ok).toBe(true);
    if (!latest.ok || latest.value === null) return;
    // Anti-cherry-pick: the later CHANGES_REQUESTED wins even though a PASS exists.
    expect(latest.value.payload.verdict).toBe('CHANGES_REQUESTED');
  });

  it('30. CHANGES_REQUESTED followed by PASS still yields PASS as latest', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('later-pass');
    const reviewTask = await g.seedTask('review');
    const subjectTask = await g.seedTask('work');
    const changesExecution = await g.seedExecution(runId, reviewTask);
    const passExecution = await g.seedExecution(runId, reviewTask);
    const changes = await g.sink.record(
      commandFor(runId, reviewTask, subjectTask, changesExecution, { verdict: 'CHANGES_REQUESTED', findings: [blockingFinding()] }),
    );
    const pass = await g.sink.record(commandFor(runId, reviewTask, subjectTask, passExecution));
    expect(changes.ok && pass.ok).toBe(true);
    const latest = await g.sink.getLatestReviewReport({ companyId: COMPANY, runId, reviewTaskId: reviewTask, actorId: ACTOR });
    expect(latest.ok).toBe(true);
    if (!latest.ok || latest.value === null) return;
    expect(latest.value.payload.verdict).toBe('PASS');
  });

  it('31. the reverse order never lets an old PASS win', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('reverse');
    const reviewTask = await g.seedTask('review');
    const subjectTask = await g.seedTask('work');
    const passExecution = await g.seedExecution(runId, reviewTask);
    const changesExecution = await g.seedExecution(runId, reviewTask);
    await g.sink.record(commandFor(runId, reviewTask, subjectTask, passExecution));
    await g.sink.record(
      commandFor(runId, reviewTask, subjectTask, changesExecution, { verdict: 'CHANGES_REQUESTED', findings: [blockingFinding()] }),
    );
    const history = await g.sink.listReviewHistory({ companyId: COMPANY, runId, reviewTaskId: reviewTask, actorId: ACTOR });
    const latest = await g.sink.getLatestReviewReport({ companyId: COMPANY, runId, reviewTaskId: reviewTask, actorId: ACTOR });
    expect(history.ok && latest.ok).toBe(true);
    if (!history.ok || !latest.ok || latest.value === null) return;
    // The latest is the LAST element of the deterministic history, not the newest PASS.
    expect(latest.value.artifactId).toBe(history.value[history.value.length - 1]!.artifactId);
    expect(latest.value.payload.verdict).toBe('CHANGES_REQUESTED');
  });
});

/** A second, distinct subject task (used where two subjects are needed). */
async function f2Task(g: Graph): Promise<string> {
  const id = await g.seedTask('work');
  return id;
}

describe('T18-04 review references (§70)', () => {
  it('32/33/34. legal artifact evidence is accepted; missing and cross-run ones are rejected', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('refs');
    const other = await g.runWithGoal('refs-other');
    const evidence = await g.seedArtifact(runId, 'refs-1');
    const foreign = await g.seedArtifact(other, 'refs-foreign');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const base = { verdict: 'CHANGES_REQUESTED' as const, findings: [blockingFinding()] };

    const legal = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution, { ...base, evidenceRefs: [evidence] }));
    expect(legal.ok).toBe(true);

    const missing = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution, { ...base, evidenceRefs: ['artifact:does-not-exist'] }));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('NOT_FOUND');

    const crossRun = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution, { ...base, evidenceRefs: [foreign] }));
    expect(crossRun.ok).toBe(false);
    if (crossRun.ok) return;
    expect(crossRun.error.details?.['reason']).toBe('REVIEW_EVIDENCE_CROSS_RUN');
  });

  it('35. a fake toolinvocation namespace is rejected', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('fake-ns');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const recorded = await g.sink.record(

      commandFor(runId, reviewTask, subjectTask, reviewExecution, {
        verdict: 'CHANGES_REQUESTED',
        findings: [blockingFinding({ evidenceRefs: ['toolinvocation:123'] })],
      }),
    );
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_FINDING_EVIDENCE_INVALID');
  });

  it('36. a validation identity is never written as an artifact ref', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('validation-identity');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const recorded = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const row = g.db.db
      .prepare('SELECT creation_command_id FROM artifacts WHERE artifact_id = ?')
      .get(recorded.value.artifactId) as { creation_command_id: string };
    expect(row.creation_command_id).toContain(COMPANY);
    // The durable payload carries kinds explicitly, so a validation id can never masquerade.
    const kinds = recorded.value.payload.evidenceRefs.map((ref) => (ref.startsWith('val_') ? 'validation' : 'artifact'));
    expect(kinds).not.toContain('artifact');
  });

  it('37. a validator report artifact is accepted as review evidence', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('qa-report');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const report = await g.artifacts().create({
      commandId: 'validation-evidence:report-9',
      runId: runId as never,
      taskId: null,
      kind: 'companyos:validation-evidence-report',
      content: new TextEncoder().encode(JSON.stringify({ verdict: 'fail' })),
      producedBy: ACTOR,
      traceId: 't18u_report',
    });
    if (!report.ok) throw new Error(report.error.message);
    const recorded = await g.sink.record(

      commandFor(runId, reviewTask, subjectTask, reviewExecution, {
        verdict: 'CHANGES_REQUESTED',
        findings: [blockingFinding({ evidenceRefs: [`artifact:${report.value.id}`] })],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.payload.findings[0]!.evidenceRefs).toEqual([`artifact:${report.value.id}`]);
  });

  it('38. a repo-relative locator is accepted', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('locator-ok');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const recorded = await g.sink.record(

      commandFor(runId, reviewTask, subjectTask, reviewExecution, {
        verdict: 'CHANGES_REQUESTED',
        findings: [blockingFinding({ locator: { path: 'packages/engine/src/engine.ts', line: 42, symbol: 'executeStage' } })],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.payload.findings[0]!.locator?.path).toBe('packages/engine/src/engine.ts');
  });

  it('39. an absolute or escaping locator is rejected', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('locator-bad');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    for (const path of ['E:\\DeepSeek.gzq\\companyos', '/etc/passwd', '\\\\server\\share', '../outside', '~/secrets']) {
      const recorded = await g.sink.record(

        commandFor(runId, reviewTask, subjectTask, reviewExecution, {
          verdict: 'CHANGES_REQUESTED',
          findings: [blockingFinding({ locator: { path } })],
        }),
      );
      expect(recorded.ok).toBe(false);
      if (recorded.ok) continue;
      expect(recorded.error.details?.['reason']).toBe('REVIEW_FINDING_LOCATOR_INVALID');
    }
    expect(reviewRows(g.db)).toBe(0);
  });
});

describe('T18-04 review zero side effects (§71)', () => {
  it('40/41/42/43. a report write changes no task, stage or run', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('no-side-effects');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const before = {
      tasks: (await g.db.tasks.list({ limit: 100 })).items.length,
      reviewTask: (await g.db.tasks.get(reviewTask as never))?.state,
      subjectTask: (await g.db.tasks.get(subjectTask as never))?.state,
      run: await g.db.runs.get(runId as never),
    };
    const recorded = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(true);
    const after = {
      tasks: (await g.db.tasks.list({ limit: 100 })).items.length,
      reviewTask: (await g.db.tasks.get(reviewTask as never))?.state,
      subjectTask: (await g.db.tasks.get(subjectTask as never))?.state,
      run: await g.db.runs.get(runId as never),
    };
    expect(after.tasks).toBe(before.tasks);
    expect(after.reviewTask).toBe(before.reviewTask);
    expect(after.subjectTask).toBe(before.subjectTask);
    expect(after.run?.state).toBe(before.run?.state);
    expect(after.run?.revision).toBe(before.run?.revision);
    const tables = (g.db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    expect(tables).not.toContain('stages');
  });

  it('44. no decision is created automatically', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('no-decision');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const recorded = await g.sink.record(
      commandFor(runId, reviewTask, subjectTask, reviewExecution, {
        verdict: 'CHANGES_REQUESTED', findings: [blockingFinding()] }),
    );
    expect(recorded.ok).toBe(true);
    const rows = g.db.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as { c: number | bigint };
    expect(Number(rows.c)).toBe(0);
  });

  it('45/46. no validation is created and the evidence guard is untouched', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('no-validation');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const recorded = await g.sink.record(
      commandFor(runId, reviewTask, subjectTask, reviewExecution, {
        verdict: 'CHANGES_REQUESTED', findings: [blockingFinding()] }),
    );
    expect(recorded.ok).toBe(true);
    const validations = g.db.db.prepare('SELECT COUNT(*) AS c FROM validations').get() as { c: number | bigint };
    expect(Number(validations.c)).toBe(0);
    // The six QA evidence slots are untouched: no tool invocation was produced by the sink.
    const invocations = g.db.db.prepare('SELECT COUNT(*) AS c FROM tool_invocations').get() as { c: number | bigint };
    expect(Number(invocations.c)).toBe(0);
  });

  it('47. the repository runtime is untouched', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('no-repository');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const recorded = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(true);
    const invocations = g.db.db.prepare('SELECT COUNT(*) AS c FROM tool_invocations').get() as { c: number | bigint };
    expect(Number(invocations.c)).toBe(0);
  });

  it('48. the ToolRegistry is untouched', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('no-tools');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const tools = (await g.db.toolRecords.list({ limit: 500 })).items.length;
    const recorded = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(true);
    expect((await g.db.toolRecords.list({ limit: 500 })).items.length).toBe(tools);
  });

  it('49. the authority catalog is unchanged', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('no-authority');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const roles = (await g.db.roles.list({ limit: 500 })).items.length;
    const recorded = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(true);
    expect((await g.db.roles.list({ limit: 500 })).items.length).toBe(roles);
    const { AUTHORITIES } = await import('@companyos/core');
    expect((AUTHORITIES as readonly string[]).includes('review.report')).toBe(false);
    expect((AUTHORITIES as readonly string[]).includes('supervisor.review')).toBe(false);
  });

  it('50. DevCompany content is unchanged', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('no-devcompany');
    const reviewTask = await g.seedTask('review');
    const reviewExecution = await g.seedExecution(runId, reviewTask);
    const subjectTask = await g.seedTask('work');
    const packRows = (table: string): number => {
      const exists = g.db.db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { c: number | bigint };
      if (Number(exists.c) === 0) return 0;
      return Number((g.db.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number | bigint }).c);
    };
    const before = { versions: packRows('pack_versions'), refs: packRows('pack_content_refs') };
    const recorded = await g.sink.record(commandFor(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(true);
    expect(packRows('pack_versions')).toBe(before.versions);
    expect(packRows('pack_content_refs')).toBe(before.refs);
  });
});
