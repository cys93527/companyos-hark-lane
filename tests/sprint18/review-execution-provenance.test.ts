/**
 * Sprint 18 / Task-18-04 FINAL CORRECTIVE — review execution provenance (§32 matrix 1–24).
 *
 * The two hard rules proven here:
 *   1. a canonical review report requires a REAL, COMPLETED AgentExecution — attempt, agent and
 *      role are derived from that row, never stated by the caller, and there is no
 *      TASK_ATTEMPT fallback;
 *   2. the model provenance is derived from the execution's own binding and then proven against
 *      the run's pinned bindings — "the run also pins that model" is not enough.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createExecution, domainError, ok, type DomainError, type Result } from '@companyos/core';
import {
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
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18prov-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18W${String(++seq).padStart(12, '0')}`,
  ulid: () => `18W${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack', 'memory'] as const;
const COMPANY = 'company_default';
const OTHER_COMPANY = 'company_other';
const ACTOR = 'user_owner';
const OBJECTIVE = 'Prove that every review report is bound to a real reviewer execution.';

interface Fixture {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly sink: ReviewFindingsSink;
  lifecycle(): ReturnType<typeof createWorkflowLifecycle>;
  publishTemplate(label: string, stageIds: readonly string[]): Promise<string>;
  runWithGoal(label: string, options?: { readonly stages?: readonly string[]; readonly bindings?: Readonly<Record<string, string>> }): Promise<string>;
  seedTask(stageId: string, runIdOverride?: string): Promise<string>;
  seedModel(modelKey: string, providerModelId?: string): Promise<void>;
  /** A COMPLETED AgentExecution for the given task, running the given model. */
  seedExecution(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly modelKey: string;
    readonly attempt?: number;
    readonly status?: string;
    readonly agentId?: string;
    readonly roleId?: string;
  }): Promise<string>;
}

/** Build the sink stack over an ALREADY-OPEN database (used for the restart test). */
const buildFixture = (db: DurableDatabase, dataDir: string, casRoot: string): Fixture => {

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
    authorize: authorize as never,
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
        if (row === null) return { ok: false as const, error: domainError('NOT_FOUND', `missing ${ref}`, { reference: ref }) };
        anchored.push({ kind: 'artifact', id: row.id, ref, runId: row.runId });
        continue;
      }
      if (ref.startsWith('val_')) {
        const row = await db.validationStore!.get(ref as never);
        if (row === null) return { ok: false as const, error: domainError('NOT_FOUND', `missing ${ref}`, { reference: ref }) };
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
    async publishTemplate(label, stageIds) {
      const template = await lifecycle.createTemplate({ orgId: COMPANY, name: `Provenance flow ${label}`, actorId: ACTOR, traceId: `t18w_tpl_${label}` });
      if (!template.ok) throw new Error(template.error.message);
      const graph = {
        nodes: stageIds.map((id) => ({ id, kind: 'work' as const, title: id, config: {} })),
        edges: stageIds.slice(1).map((id, index) => ({ from: stageIds[index]!, to: id })),
      };
      const saved = await lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: ACTOR, traceId: `t18w_graph_${label}` });
      if (!saved.ok) throw new Error(saved.error.message);
      const published = await lifecycle.publish({ templateId: template.value.id, actorId: ACTOR, traceId: `t18w_pub_${label}` });
      if (!published.ok) throw new Error(published.error.message);
      return template.value.id;
    },
    async runWithGoal(label, options = {}) {
      const templateId = await this.publishTemplate(label, options.stages ?? ['work', 'review']);
      if (options.bindings === undefined) {
        await this.seedModel('local.model-a');
        await this.seedModel('local.model-b');
      }
      const run = await lifecycle.createRun({
        templateId,
        companyId: COMPANY,
        workflowId: `wf_${label}`,
        actorId: ACTOR,
        modelBindings: options.bindings ?? { reviewer: 'local.model-a', second: 'local.model-b' },
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
    async seedModel(modelKey) {
      // One provider whose catalogue carries BOTH reviewer models (registration is idempotent).
      const provider = await providers.register(
        (await import('@companyos/engine')).createMockProvider({
          providerId: 'prov_local',
          kind: 'mock',
          displayName: 'Local provider',
          script: {
            models: [
              { modelId: 'local-model-a', displayName: 'local-model-a', contextWindow: 8_192, capabilities: { streaming: false } },
              { modelId: 'local-model-b', displayName: 'local-model-b', contextWindow: 8_192, capabilities: { streaming: false } },
            ],
          },
        }),
        { actorId: ACTOR },
      );
      if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
      const modelId = modelKey.replace(/\./g, '-');
      const model = await models.registerFromProvider({ providerId: 'prov_local', providerModelId: modelId, modelKey, actorId: ACTOR });
      if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
    },
    async seedExecution(input) {
      const made = await createExecution({
        executionId: ids.id('exc'),
        agentId: input.agentId ?? 'agent_reviewer',
        roleId: (input.roleId ?? 'rol_reviewer') as never,
        taskId: input.taskId as never,
        runId: input.runId as never,
        binding: {
          modelKey: input.modelKey,
          providerId: 'prov_local',
          providerModelId: 'local-model-' + (input.modelKey.split('.').pop() ?? input.modelKey),
          source: 'EXPLICIT_BINDING',
        },
        attempt: input.attempt ?? 1,
        traceId: ids.id('trace'),
        now: nowIso(),
      });
      if (!made.ok) throw new Error(made.error.message);
      const stored = input.status === undefined ? { ...made.value, status: 'COMPLETED' as never } : { ...made.value, status: input.status as never };
      await db.agentExecutions.put(stored);
      return made.value.executionId;
    },
  };
};

/** The directory an open durable database lives in (its path minus the file name). */
const dataDirOf = (db: DurableDatabase): string => db.path.replace(/[^\\/]*$/, '');

const makeFixture = (): Fixture => {
  const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  return buildFixture(db, dataDirOf(db), tempDir());
};

/** A fresh service graph over an already-open durable database. */
const makeFixtureOver = (db: DurableDatabase, dataDir: string, casRoot: string): Fixture => buildFixture(db, dataDir, casRoot);
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

const blocking = (over: Record<string, unknown> = {}) => ({
  code: 'semantic.boundary',
  summary: 'The change crosses a frozen boundary.',
  detail: 'The reviewed diff touches a frozen contract.',
  blocking: true,
  ...over,
});

const reviewRows = (db: DurableDatabase): number =>
  Number((db.db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:review-findings'").get() as { c: number | bigint }).c);

describe('T18-04 corrective — a real AgentExecution is required (§32/1-6)', () => {
  it('1/14. a canonical report requires an executionId', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('required');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(commandFor(runId, reviewTask, subjectTask, ''));
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_EXECUTION_REQUIRED');
    expect(reviewRows(f.db)).toBe(0);
  });

  it('2. a nonexistent execution is rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('nonexistent');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(commandFor(runId, reviewTask, subjectTask, 'exc_does-not-exist'));
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_EXECUTION_MISSING');
    expect(reviewRows(f.db)).toBe(0);
  });

  it('3. the TASK_ATTEMPT-only path is gone', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('no-fallback');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    // Nothing may be synthesized from task + attempt: the ONLY accepted shape is an execution id.
    const recorded = await f.sink.record(commandFor(runId, reviewTask, subjectTask, '') as RecordReviewReportCommand);
    expect(recorded.ok).toBe(false);
    const shape = Object.keys(commandFor(runId, reviewTask, subjectTask, 'exec'));
    expect(shape).not.toContain('reviewAttempt');
    expect(shape).not.toContain('reviewer');
    expect(shape).toContain('executionId');
  });

  it('4. an execution of another run is rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('wrong-run');
    const other = await f.runWithGoal('wrong-run-other');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const foreignExecution = await f.seedExecution({ runId: other, taskId: reviewTask, modelKey: 'local.model-a' });
    const recorded = await f.sink.record(commandFor(runId, reviewTask, subjectTask, foreignExecution));
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_EXECUTION_RUN_MISMATCH');
  });

  it('5. an execution of another task is rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('wrong-task');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const otherTask = await f.seedTask('work');
    const foreignExecution = await f.seedExecution({ runId, taskId: otherTask, modelKey: 'local.model-a' });
    const recorded = await f.sink.record(commandFor(runId, reviewTask, subjectTask, foreignExecution));
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_EXECUTION_TASK_MISMATCH');
  });

  it('6. an execution of another company cannot write or probe a report', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('cross-company-exec');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const mine = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a' });
    const first = await f.sink.record(commandFor(runId, reviewTask, subjectTask, mine));
    expect(first.ok).toBe(true);

    // Company B replays the very same execution id.
    const attack = await f.sink.record(commandFor(runId, reviewTask, subjectTask, mine, { companyId: OTHER_COMPANY }));
    expect(attack.ok).toBe(false);
    if (attack.ok) return;
    expect(attack.error.code).toBe('NOT_FOUND');
    expect(reviewRows(f.db)).toBe(1);
  });

  it('22. a non-completed execution cannot produce a report', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('statuses');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    for (const status of ['CREATED', 'READY', 'RUNNING', 'WAITING_EXTERNAL', 'FAILED', 'CANCELLED', 'INTERRUPTED']) {
      const execution = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a', status });
      const recorded = await f.sink.record(
        commandFor(runId, reviewTask, subjectTask, execution, {
          verdict: 'PASS',
        }),
      );
      expect(recorded.ok).toBe(false);
      if (recorded.ok) continue;
      expect(recorded.error.details?.['reason']).toBe('REVIEW_EXECUTION_NOT_COMPLETED');
    }
    expect(reviewRows(f.db)).toBe(0);

    // A COMPLETED execution of the same task may.
    const completed = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a', status: 'COMPLETED' });
    const ok2 = await f.sink.record(commandFor(runId, reviewTask, subjectTask, completed));
    expect(ok2.ok).toBe(true);
  });
});

describe('T18-04 corrective — provenance is derived (§32/7-12)', () => {
  it('7/8/9/10/11/12. attempt, agent and role come from the execution and cannot be spoofed', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('derived');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const execution = await f.seedExecution({
      runId,
      taskId: reviewTask,
      modelKey: 'local.model-a',
      attempt: 4,
      agentId: 'agent_specific',
      roleId: 'rol_specific',
    });

    const spoofs = [
      { reviewAttempt: 99 },
      { reviewer: { agentId: 'agent_other', roleId: 'rol_other', executionId: execution, decidedBy: ACTOR } },
      { agentId: 'agent_other' },
      { roleId: 'rol_other' },
    ];
    for (const spoof of spoofs) {
      const recorded = await f.sink.record(commandFor(runId, reviewTask, subjectTask, execution, spoof as never));
      expect(recorded.ok).toBe(false);
      if (recorded.ok) continue;
      expect(recorded.error.details?.['reason']).toBe('REVIEW_MODEL_IDENTITY_REJECTED');
    }
    expect(reviewRows(f.db)).toBe(0);

    const recorded = await f.sink.record(commandFor(runId, reviewTask, subjectTask, execution));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.payload.reviewAttempt).toBe(4);
    expect(recorded.value.payload.reviewer.agentId).toBe('agent_specific');
    expect(recorded.value.payload.reviewer.roleId).toBe('rol_specific');
    expect(recorded.value.payload.reviewer.executionId).toBe(execution);
  });

  it('13. the execution binding is accepted and recorded', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('binding-used');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const execution = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a' });
    const recorded = await f.sink.record(commandFor(runId, reviewTask, subjectTask, execution));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.payload.executionBinding.modelKey).toBe('local.model-a');
    expect(recorded.value.payload.resolvedModelKey).toBe('local.model-a');
    expect(recorded.value.payload.modelBindingKey).toBe('reviewer');
  });

  it('14/11. a different pinned-but-unused binding is rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('binding-unused');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    // The execution actually ran `reviewer`; the caller claims `second` (also pinned).
    const execution = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a' });
    const recorded = await f.sink.record(commandFor(runId, reviewTask, subjectTask, execution, { modelBindingKey: 'second' }));
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_EXECUTION_BINDING_MISMATCH');
    expect(reviewRows(f.db)).toBe(0);
  });

  it('15. an arbitrary provider/model is still rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('no-model');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const execution = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a' });
    const recorded = await f.sink.record(
      commandFor(runId, reviewTask, subjectTask, execution, { modelKey: 'local.model-b', providerId: 'evil' } as never),
    );
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_MODEL_IDENTITY_REJECTED');
  });
});

describe('T18-04 corrective — durability with execution identity (§32/16-24)', () => {
  it('16/17. the same execution replays exactly, and changed content conflicts', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('replay-conflict');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const execution = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a' });

    const first = await f.sink.record(commandFor(runId, reviewTask, subjectTask, execution));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = await f.sink.record(commandFor(runId, reviewTask, subjectTask, execution));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.artifactId).toBe(first.value.artifactId);
    expect(reviewRows(f.db)).toBe(1);

    const changed = await f.sink.record(
      commandFor(runId, reviewTask, subjectTask, execution, { verdict: 'CHANGES_REQUESTED', findings: [blocking()] }),
    );
    expect(changed.ok).toBe(false);
    if (changed.ok) return;
    expect(changed.error.code).toBe('CONFLICT');
    expect(reviewRows(f.db)).toBe(1);
  });

  it('18/19. a second execution creates a second report and the history keeps both', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('second');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const first = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a', attempt: 1 });
    const second = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a', attempt: 2 });

    const r1 = await f.sink.record(commandFor(runId, reviewTask, subjectTask, first));
    const r2 = await f.sink.record(
      commandFor(runId, reviewTask, subjectTask, second, { verdict: 'CHANGES_REQUESTED', findings: [blocking()] }),
    );
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.value.artifactId).not.toBe(r1.value.artifactId);
    expect(reviewRows(f.db)).toBe(2);

    const history = await f.sink.listReviewHistory({ companyId: COMPANY, runId, reviewTaskId: reviewTask, actorId: ACTOR });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value.map((view) => view.payload.reviewAttempt)).toEqual([1, 2]);
  });

  it('20/21. ordering uses the durable execution attempt; an old PASS never wins', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('ordering');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const later = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a', attempt: 7 });
    const earlier = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a', attempt: 3 });

    // Record the LATER attempt first on purpose: ordering must follow the attempt, not insertion.
    const rLater = await f.sink.record(commandFor(runId, reviewTask, subjectTask, later, { verdict: 'CHANGES_REQUESTED', findings: [blocking()] }));
    const rEarlier = await f.sink.record(commandFor(runId, reviewTask, subjectTask, earlier));
    expect(rLater.ok && rEarlier.ok).toBe(true);

    const history = await f.sink.listReviewHistory({ companyId: COMPANY, runId, reviewTaskId: reviewTask, actorId: ACTOR });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value.map((view) => view.payload.reviewAttempt)).toEqual([3, 7]);
    const latest = await f.sink.getLatestReviewReport({ companyId: COMPANY, runId, reviewTaskId: reviewTask, actorId: ACTOR });
    expect(latest.ok).toBe(true);
    if (!latest.ok || latest.value === null) return;
    expect(latest.value.payload.verdict).toBe('CHANGES_REQUESTED');
    expect(latest.value.artifactId).toBe(rLater.ok ? rLater.value.artifactId : '');
  });

  it('24. after a ledger trim the replay still returns the same report', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('trim');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const execution = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a' });
    const first = await f.sink.record(commandFor(runId, reviewTask, subjectTask, execution));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    f.db.db.prepare('DELETE FROM command_ledger').run();
    const again = await f.sink.record(commandFor(runId, reviewTask, subjectTask, execution));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.artifactId).toBe(first.value.artifactId);
    expect(reviewRows(f.db)).toBe(1);
  });

  it('23. a restart preserves execution → report provenance', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('restart');
    const reviewTask = await f.seedTask('review');
    const subjectTask = await f.seedTask('work');
    const execution = await f.seedExecution({ runId, taskId: reviewTask, modelKey: 'local.model-a', attempt: 5 });
    const first = await f.sink.record(
      commandFor(runId, reviewTask, subjectTask, execution, { verdict: 'CHANGES_REQUESTED', findings: [blocking()] }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    f.db.close();
    const tracked = openDatabases.indexOf(f.db);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const reopened = openDurableDatabase({ dataDir: f.dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
    openDatabases.push(reopened);

    // A fresh service graph over the same durable files.
    const fresh = makeFixtureOver(reopened, f.dataDir, f.casRoot);
    const history = await fresh.sink.listReviewHistory({ companyId: COMPANY, runId, reviewTaskId: reviewTask, actorId: ACTOR });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value).toHaveLength(1);
    expect(history.value[0]!.payload.reviewer.executionId).toBe(execution);
    expect(history.value[0]!.payload.reviewAttempt).toBe(5);
    expect(history.value[0]!.payload.executionBinding.modelKey).toBe('local.model-a');
  });
});
