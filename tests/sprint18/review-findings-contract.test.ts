/**
 * Sprint 18 / Task-18-04 — review findings contract + context matrix (§67/§68).
 *
 * Real durable layer throughout: the report is written through the real ArtifactService into
 * the filesystem CAS, and every context check runs against the real stores.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { domainError, ok, type DomainError, type Result } from '@companyos/core';
import {
  REVIEW_FINDINGS_SCHEMA,
  createArtifactService,
  createModelRegistry,
  createProviderRegistry,
  createReviewFindingsSink,
  createRunGoalService,
  createRunModelBindingReader,
  createRunSnapshotVerifier,
  createWorkflowLifecycle,
  reviewFindingFingerprint,
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
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18rev-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18R${String(++seq).padStart(12, '0')}`,
  ulid: () => `18R${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack', 'memory'] as const;
const COMPANY = 'company_default';
const ACTOR = 'user_owner';
const OBJECTIVE = 'Review the implementation work with a durable structured report.';

interface Fixture {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly sink: ReviewFindingsSink;
  readonly lifecycle: ReturnType<typeof createWorkflowLifecycle>;
  publishTemplate(label: string, stageIds: readonly string[]): Promise<string>;
  runWithGoal(label: string, options?: { readonly stages?: readonly string[]; readonly bindings?: Readonly<Record<string, string>> }): Promise<string>;
  seedTask(stageId: string, runIdOverride?: string): Promise<string>;
  /** A COMPLETED AgentExecution for the given review task (binding = local.model-a). */
  seedExecution(runId: string, taskId: string, over?: { attempt?: number; modelKey?: string; status?: string }): Promise<string>;
  seedArtifact(runId: string, label: string): Promise<string>;
  seedModel(modelKey: string): Promise<string>;
  tamperSnapshot(snapshotId: string): void;
  artifactRows(): readonly { artifact_id: string; kind: string }[];
}

const makeFixture = (): Fixture => {
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);


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
    authorize: (async () => ok(true as const)) as never,
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
    authorize: (async () => ok(true as const)) as never,
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
    lifecycle,
    async publishTemplate(label, stageIds) {
      const template = await lifecycle.createTemplate({ orgId: COMPANY, name: `Review flow ${label}`, actorId: ACTOR, traceId: `t18r_tpl_${label}` });
      if (!template.ok) throw new Error(template.error.message);
      const graph = {
        nodes: stageIds.map((id) => ({ id, kind: 'work' as const, title: id, config: {} })),
        edges: stageIds.slice(1).map((id, index) => ({ from: stageIds[index]!, to: id })),
      };
      const saved = await lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: ACTOR, traceId: `t18r_graph_${label}` });
      if (!saved.ok) throw new Error(saved.error.message);
      const published = await lifecycle.publish({ templateId: template.value.id, actorId: ACTOR, traceId: `t18r_pub_${label}` });
      if (!published.ok) throw new Error(published.error.message);
      return template.value.id;
    },
    async runWithGoal(label, options = {}) {
      const templateId = await this.publishTemplate(label, options.stages ?? ['work', 'review']);
      // The reviewer execution runs a model the run pins: the sink derives the binding from
      // the execution and then proves the run pinned exactly that model.
      if (options.bindings === undefined) await this.seedModel("local.model-a");
      const run = await lifecycle.createRun({
        templateId,
        companyId: COMPANY,
        workflowId: `wf_${label}`,
        actorId: ACTOR,
        modelBindings: options.bindings ?? { reviewer: "local.model-a" },
        goal: { objective: OBJECTIVE, source: { type: 'human', ref: label } },
      });
      if (!run.ok) throw new Error(run.error.message);
      lastRunId = run.value.run.id;
      return run.value.run.id;
    },
    async seedExecution(runId, taskId, over: { attempt?: number; modelKey?: string; status?: string } = {}) {
      const { createExecution } = await import('@companyos/core');
      const modelKey = over.modelKey ?? 'local.model-a';
      const made = await createExecution({
        executionId: ids.id('exc'),
        agentId: 'agent_reviewer',
        roleId: 'rol_reviewer' as never,
        taskId: taskId as never,
        runId: runId as never,
        binding: { modelKey, providerId: 'prov_local', providerModelId: 'local-model', source: 'EXPLICIT_BINDING' },
        attempt: over.attempt ?? 1,
        traceId: ids.id('trace'),
        now: nowIso(),
      });
      if (!made.ok) throw new Error(made.error.message);
      const stored = over.status === undefined
        ? { ...made.value, status: 'COMPLETED' as never }
        : { ...made.value, status: over.status as never };
      await db.agentExecutions.put(stored);
      return made.value.executionId;
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
        commandId: `review-evidence:${label}`,
        runId: runId as never,
        taskId: null,
        kind: 'companyos:evidence',
        content: new TextEncoder().encode(JSON.stringify({ label })),
        producedBy: ACTOR,
        traceId: `t18r_art_${label}`,
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
    tamperSnapshot(snapshotId) {
      db.db.prepare('UPDATE run_snapshots SET memory_view_ref = ? WHERE id = ?').run('memory:attacker', snapshotId);
    },
    artifactRows() {
      return db.db.prepare('SELECT artifact_id, kind FROM artifacts').all() as { artifact_id: string; kind: string }[];
    },
  };
};

const baseCommand = (
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

const finding = (over: Partial<{ code: string; summary: string; detail: string; blocking: boolean; evidenceRefs: readonly string[]; locator: { path: string; line?: number; symbol?: string } }> = {}) => ({
  code: 'semantic.boundary',
  summary: 'The change crosses a frozen boundary.',
  detail: 'The reviewed diff touches a frozen contract.',
  blocking: true,
  ...over,
});

describe('T18-04 review findings contract (§67)', () => {
  it('1. the report schema is versioned', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('schema');
    const reviewTask = await f.seedTask('review', runId);
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work', runId);
    const recorded = await f.sink.record(baseCommand(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.payload.schemaVersion).toBe(REVIEW_FINDINGS_SCHEMA);
    expect(recorded.value.payload.reportFingerprint).toBeTruthy();
  });

  it('2. PASS with zero findings is accepted', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('pass-empty');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(baseCommand(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.payload.verdict).toBe('PASS');
    expect(recorded.value.payload.findings).toEqual([]);
  });

  it('3. PASS with a blocking finding is rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('pass-blocking');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(
      baseCommand(runId, reviewTask, subjectTask, reviewExecution, { findings: [finding({ blocking: true })] }),
    );
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_VERDICT_FINDINGS_CONFLICT');
    expect(f.artifactRows().filter((row) => row.kind === 'companyos:review-findings')).toEqual([]);
  });

  it('4. CHANGES_REQUESTED with findings is accepted', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('changes');
    const evidence = await f.seedArtifact(runId, 'changes-1');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(
      baseCommand(runId, reviewTask, subjectTask, reviewExecution, {
        verdict: 'CHANGES_REQUESTED',
        findings: [finding({ blocking: true, evidenceRefs: [evidence] })],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.payload.findings).toHaveLength(1);
    expect(recorded.value.payload.findings[0]!.evidenceRefs).toEqual([evidence]);
  });

  it('5. CHANGES_REQUESTED with no findings is rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('changes-empty');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(baseCommand(runId, reviewTask, subjectTask, reviewExecution, { verdict: 'CHANGES_REQUESTED' }));
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_VERDICT_FINDINGS_CONFLICT');
  });

  it('6. BLOCKED with a blocker is accepted', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('blocked');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(
      baseCommand(runId, reviewTask, subjectTask, reviewExecution, {
        verdict: 'BLOCKED',
        findings: [finding({ code: 'review.blocked', summary: 'The reviewed diff is unavailable.', detail: 'The subject artifact is missing.', blocking: true })],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.payload.verdict).toBe('BLOCKED');
  });

  it('7. BLOCKED with no blocker is rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('blocked-empty');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(
      baseCommand(runId, reviewTask, subjectTask, reviewExecution, { verdict: 'BLOCKED', findings: [finding({ blocking: false })] }),
    );
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_VERDICT_FINDINGS_CONFLICT');
  });

  it('8. duplicate semantic findings are canonically deduped', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('dedupe');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const repeated = finding({ blocking: true });
    const recorded = await f.sink.record(
      baseCommand(runId, reviewTask, subjectTask, reviewExecution, { verdict: 'CHANGES_REQUESTED', findings: [repeated, { ...repeated }] }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.payload.findings).toHaveLength(1);
  });

  it('9. the finding fingerprint is deterministic', () => {
    const left = reviewFindingFingerprint({
      code: 'semantic.boundary',
      blocking: true,
      summary: 'Crosses a frozen boundary.',
      detail: 'Details.',
      subject: 'contract',
      locator: { path: 'src/a.ts', line: 3 },
      evidenceRefs: ['artifact:art_0000000001', 'artifact:art_0000000002'],
    });
    const right = reviewFindingFingerprint({
      code: 'Semantic.Boundary',
      blocking: true,
      summary: '  Crosses a frozen boundary.  ',
      detail: 'Details.',
      subject: 'contract',
      locator: { path: 'src/a.ts', line: 3 },
      // Order must not matter.
      evidenceRefs: ['artifact:art_0000000002', 'artifact:art_0000000001'],
    });
    expect(left).toBe(right);
  });

  it('10. the finding identity is system generated', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('finding-id');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(
      baseCommand(runId, reviewTask, subjectTask, reviewExecution, {
        verdict: 'CHANGES_REQUESTED',
        findings: [{ ...finding({ blocking: true }), findingId: 'rf_attacker-supplied', fingerprint: 'forged' } as never],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const stored = recorded.value.payload.findings[0]!;
    expect(stored.findingId).not.toBe('rf_attacker-supplied');
    expect(stored.findingId.startsWith('rf_')).toBe(true);
    expect(stored.fingerprint).not.toBe('forged');
    expect(stored.fingerprint).toBe(
      reviewFindingFingerprint({
        code: stored.code,
        blocking: stored.blocking,
        summary: stored.summary,
        detail: stored.detail,
        subject: stored.subject ?? null,
        locator: stored.locator ?? null,
        evidenceRefs: stored.evidenceRefs,
      }),
    );
  });
});

describe('T18-04 review findings context (§68)', () => {
  it('11. a canonical goal is required', async () => {
    const f = makeFixture();
    const templateId = await f.publishTemplate('goalless', ['work', 'review']);
    const run = await f.lifecycle.createRun({ templateId, companyId: COMPANY, workflowId: 'wf_goalless', actorId: ACTOR });
    if (!run.ok) throw new Error(run.error.message);
    const reviewTask = await f.seedTask('review', run.value.run.id);
    const reviewExecution = await f.seedExecution(run.value.run.id, reviewTask);
    const subjectTask = await f.seedTask('work', run.value.run.id);
    const recorded = await f.sink.record(baseCommand(run.value.run.id, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('RUN_GOAL_MISSING');
  });

  it('12. the snapshot is verified before recording', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('snapshot');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(baseCommand(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(true);
  });

  it('13. a tampered snapshot is rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('tampered');
    const run = await f.db.runs.get(runId as never);
    f.tamperSnapshot(run!.snapshotId);
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(baseCommand(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.code).toBe('SNAPSHOT_MISMATCH');
    expect(f.artifactRows().filter((row) => row.kind === 'companyos:review-findings')).toEqual([]);
  });

  it('14. review task ownership is validated', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('review-ownership');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    // A stage that is not the review task's stage is refused.
    const wrongStage = await f.sink.record(baseCommand(runId, reviewTask, subjectTask, reviewExecution, { reviewStageId: 'work' }));
    expect(wrongStage.ok).toBe(false);
    if (wrongStage.ok) return;
    expect(wrongStage.error.details?.['reason']).toBe('REVIEW_TASK_STAGE_MISMATCH');
    // A task that is not part of the pinned graph is refused.
    const unknownTask = await f.seedTask('stage-from-elsewhere');
    const unknownExecution = await f.seedExecution(runId, unknownTask);
    const unknown = await f.sink.record(baseCommand(runId, unknownTask, subjectTask, unknownExecution, { reviewStageId: 'stage-from-elsewhere' }));
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.details?.['reason']).toBe('REVIEW_TASK_STAGE_MISMATCH');
  });

  it('15. subject task ownership is validated', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('subject-ownership');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const unknownSubject = await f.seedTask('stage-from-elsewhere');
    const recorded = await f.sink.record(baseCommand(runId, reviewTask, unknownSubject, reviewExecution));
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_SUBJECT_STAGE_MISMATCH');

    // The review task itself may not be the subject.
    const itself = await f.sink.record(baseCommand(runId, reviewTask, reviewTask, reviewExecution));
    expect(itself.ok).toBe(false);
    if (itself.ok) return;
    expect(itself.error.details?.['reason']).toBe('REVIEW_SUBJECT_TASK_IS_REVIEW_TASK');
  });

  it('16. a cross-run subject is rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('cross-run-subject');
    const other = await f.runWithGoal('cross-run-other');
    void other;
    // A task of another run's pinned graph cannot be anchored here: the subject stage must be
    // part of THIS run's pinned version.
    const foreignStage = await f.seedTask('foreign-stage');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const recorded = await f.sink.record(baseCommand(runId, reviewTask, foreignStage, reviewExecution));
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_SUBJECT_STAGE_MISMATCH');
  });

  it('17. cross-company access is rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('cross-company');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(baseCommand(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const read = await f.sink.getReviewReport({
      companyId: 'company_other',
      runId,
      artifactId: recorded.value.artifactId,
      actorId: ACTOR,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe('VALIDATION_FAILED');
    const history = await f.sink.listReviewHistory({ companyId: 'company_other', runId, reviewTaskId: reviewTask, actorId: ACTOR });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value).toEqual([]);
  });

  it('18. a pinned model binding is accepted and recorded', async () => {
    const f = makeFixture();
    await f.seedModel('local.model-a');
    const runId = await f.runWithGoal('binding', { bindings: { reviewer: 'local.model-a' } });
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(baseCommand(runId, reviewTask, subjectTask, reviewExecution, { modelBindingKey: 'reviewer' }));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.payload.modelBindingKey).toBe('reviewer');
    expect(recorded.value.payload.resolvedModelKey).toBe('local.model-a');
  });

  it('19. a review whose execution ran a model the run never pinned fails closed', async () => {
    const f = makeFixture();
    // The run pins nothing: the execution’s own model cannot be attributed to it.
    const runId = await f.runWithGoal('no-binding', { bindings: {} });
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(baseCommand(runId, reviewTask, subjectTask, reviewExecution));
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_EXECUTION_BINDING_NOT_PINNED');
  });

  it('20. an arbitrary provider/model cannot be supplied', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('no-model-identity');
    const reviewTask = await f.seedTask('review');
    const reviewExecution = await f.seedExecution(runId, reviewTask);
    const subjectTask = await f.seedTask('work');
    const recorded = await f.sink.record(
      baseCommand(runId, reviewTask, subjectTask, reviewExecution, { modelKey: 'local.model-b', providerId: 'evil' } as never),
    );
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    expect(recorded.error.details?.['reason']).toBe('REVIEW_MODEL_IDENTITY_REJECTED');
  });
});
