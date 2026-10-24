/**
 * Sprint 18 / Task-18-05 — controlled corrective task provisioning (test matrix §72–§78).
 *
 * Everything runs on the REAL durable layer: real Task rows, real Decisions written by the
 * T18-03 sink, real review reports written by the T18-04 sink, real artifacts in the CAS. The
 * provisioner never executes the work item it creates.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { domainError, ok, type DecisionRecord, type DomainError, type Result, type Task } from '@companyos/core';
import {
  createArtifactService,
  createCorrectiveProvisioner,
  createDecisionService,
  createModelRegistry,
  createProviderRegistry,
  createReviewFindingsSink,
  createRunGoalService,
  createRunModelBindingReader,
  createRunSnapshotVerifier,
  createSupervisorDecisionSink,
  createWorkflowLifecycle,
  supervisorDecisionCommandId,
  type CorrectiveProvisioner,
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
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18corr-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18X${String(++seq).padStart(12, '0')}`,
  ulid: () => `18X${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack', 'memory'] as const;
const COMPANY = 'company_default';
const OTHER_COMPANY = 'company_other';
const ACTOR = 'user_owner';
const OBJECTIVE = 'Provision corrective work items with durable lineage.';

const QA_REPORT_KIND = 'companyos/repository-qa-evidence';

interface Fixture {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly lifecycle: ReturnType<typeof createWorkflowLifecycle>;
  readonly decisions: ReturnType<typeof createDecisionService>;
  readonly reviews: ReviewFindingsSink;
  readonly provisioner: CorrectiveProvisioner;
  publishTemplate(label: string, stageIds: readonly string[]): Promise<string>;
  /** Register and pin the model the reviewer execution runs. */
  seedReviewerModel(): Promise<void>;
  runWithGoal(label: string, options?: { readonly stages?: readonly string[] }): Promise<string>;
  seedTask(stageId: string, over?: { kind?: string; maxAttempts?: number }, runIdOverride?: string): Promise<string>;
  seedReviewExecution(runId: string, reviewTaskId: string, attempt?: number): Promise<string>;
  recordChangesReport(input: {
    readonly runId: string;
    readonly reviewTaskId: string;
    readonly subjectTaskId: string;
    readonly executionId: string;
    readonly blocking?: boolean;
  }): Promise<string>;
  seedQaReport(runId: string, verdict: 'PASS' | 'FAIL', attempt?: number): Promise<string>;
  recordDecision(input: {
    readonly runId: string;
    readonly action: 'CONTINUE' | 'REQUEST_CORRECTIVE' | 'ESCALATE' | 'COMPLETE';
    readonly reasonCode: string;
    readonly summary: string;
    readonly evidenceRefs?: readonly string[];
    readonly identity: string;
  }): Promise<DecisionRecord>;
  taskRows(): Promise<readonly Task[]>;
  qaRows(): number;
}

/** Build the whole stack over an ALREADY-OPEN database (used by the restart assertions). */
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
      const id = ref.startsWith('artifact:') ? ref.slice('artifact:'.length) : ref;
      const row = await db.artifactStore!.get(id as never);
      if (row === null) return { ok: false as const, error: domainError('NOT_FOUND', `missing ${ref}`, { reference: ref }) };
      anchored.push({ kind: 'artifact', id: row.id, ref, runId: row.runId });
    }
    return { ok: true as const, value: anchored };
  };
  const decisions = createDecisionService({
    store: db.decisions!,
    clock,
    ids,
    authorize: authorize as never,
  });
  const decisionSink = createSupervisorDecisionSink({
    runs: db.runs,
    tasks: db.tasks,
    templates: db.templates,
    decisions: db.decisions!,
    runGoal,
    runSnapshotVerifier: createRunSnapshotVerifier({ templates: db.templates, snapshots: db.snapshots }),
    modelBindings: createRunModelBindingReader({ runs: db.runs, snapshots: db.snapshots }),
    modelRegistry: models,
    durableReferenceResolver,
    authorize: authorize as never,
    unitOfWork: db.unitOfWork,
    clock,
    ids,
  });
  const reviews = createReviewFindingsSink({
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
  const provisioner = createCorrectiveProvisioner({
    runs: db.runs,
    tasks: db.tasks,
    templates: db.templates,
    decisions: db.decisions!,
    artifacts: db.artifactStore!,
    content: { get: (contentRef) => contentStore.get(contentRef) },
    toolInvocations: db.toolInvocations ?? undefined,
    runSnapshot: createRunSnapshotVerifier({ templates: db.templates, snapshots: db.snapshots }),
    reviewReports: {
      latestReviewReport: async ({ companyId, runId, reviewTaskId, actorId }) => {
        const latest = await reviews.getLatestReviewReport({ companyId, runId, reviewTaskId, actorId });
        if (!latest.ok) return latest;
        return latest.value === null
          ? { ok: true as const, value: null }
          : { ok: true as const, value: { artifactId: latest.value.artifactId, verdict: latest.value.payload.verdict } };
      },
    },
    unitOfWork: db.unitOfWork,
  });

  let lastRunId: string | null = null;
  return {
    db,
    dataDir,
    casRoot,
    lifecycle,
    decisions,
    reviews,
    provisioner,
    async publishTemplate(label, stageIds) {
      const template = await lifecycle.createTemplate({ orgId: COMPANY, name: `Corrective flow ${label}`, actorId: ACTOR, traceId: `t18x_tpl_${label}` });
      if (!template.ok) throw new Error(template.error.message);
      const graph = {
        nodes: stageIds.map((id) => ({ id, kind: 'work' as const, title: id, config: {} })),
        edges: stageIds.slice(1).map((id, index) => ({ from: stageIds[index]!, to: id })),
      };
      const saved = await lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: ACTOR, traceId: `t18x_graph_${label}` });
      if (!saved.ok) throw new Error(saved.error.message);
      const published = await lifecycle.publish({ templateId: template.value.id, actorId: ACTOR, traceId: `t18x_pub_${label}` });
      if (!published.ok) throw new Error(published.error.message);
      return template.value.id;
    },
    async seedReviewerModel() {
      const provider = await providers.register(
        (await import('@companyos/engine')).createMockProvider({
          providerId: 'prov_local',
          kind: 'mock',
          displayName: 'Local provider',
          script: {
            models: [
              { modelId: 'local-model-a', displayName: 'local-model-a', contextWindow: 8_192, capabilities: { streaming: false } },
            ],
          },
        }),
        { actorId: ACTOR },
      );
      if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
      const model = await models.registerFromProvider({
        providerId: 'prov_local',
        providerModelId: 'local-model-a',
        modelKey: 'local.model-a',
        actorId: ACTOR,
      });
      if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
    },
    async runWithGoal(label, options = {}) {
      const templateId = await this.publishTemplate(label, options.stages ?? ['work', 'review']);
      // The reviewer execution runs a model this run pins.
      await this.seedReviewerModel();
      const run = await lifecycle.createRun({
        templateId,
        companyId: COMPANY,
        workflowId: `wf_${label}`,
        actorId: ACTOR,
        modelBindings: { reviewer: 'local.model-a' },
        goal: { objective: OBJECTIVE, source: { type: 'human', ref: label } },
      });
      if (!run.ok) throw new Error(run.error.message);
      lastRunId = run.value.run.id;
      return run.value.run.id;
    },
    async seedTask(stageId, over = {}, runIdOverride?: string) {
      const seedRunId = runIdOverride ?? lastRunId;
      if (seedRunId === null) throw new Error('seedTask requires a prior runAt/runWithGoal — canonical run ownership.');
      const { createTask } = await import('@companyos/core');
      const task = await createTask({ runId: seedRunId as never,
        stageId: stageId as never,
        roleId: 'rol_1' as never,
        kind: over.kind ?? 'pack-a:build',
        now: nowIso(),
        ids,
        ...(over.maxAttempts === undefined ? {} : { maxAttempts: over.maxAttempts }),
      });
      if (!task.ok) throw new Error(task.error.message);
      await db.tasks.put(task.value);
      return task.value.id;
    },
    async seedReviewExecution(runId, reviewTaskId, attempt = 1) {
      const { createExecution } = await import('@companyos/core');
      const made = await createExecution({
        executionId: ids.id('exc'),
        agentId: 'agent_reviewer',
        roleId: 'rol_reviewer' as never,
        taskId: reviewTaskId as never,
        runId: runId as never,
        binding: { modelKey: 'local.model-a', providerId: 'prov_local', providerModelId: 'local-model-a', source: 'EXPLICIT_BINDING' },
        attempt,
        traceId: ids.id('trace'),
        now: nowIso(),
      });
      if (!made.ok) throw new Error(made.error.message);
      await db.agentExecutions.put({ ...made.value, status: 'COMPLETED' as never });
      return made.value.executionId;
    },
    async recordChangesReport(input) {
      const recorded = await reviews.record({
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
            summary: 'The change crosses a frozen boundary.',
            detail: 'The reviewed diff touches a frozen contract.',
            blocking: input.blocking ?? true,
          },
        ],
        decidedBy: ACTOR,
      });
      if (!recorded.ok) throw new Error(recorded.error.message);
      return `artifact:${recorded.value.artifactId}`;
    },
    async seedQaReport(runId, verdict, attempt = 1) {
      const made = await artifacts.create({
        commandId: `qa-report:${runId}:${attempt}:${verdict}`,
        runId: runId as never,
        taskId: null,
        kind: QA_REPORT_KIND,
        content: new TextEncoder().encode(JSON.stringify({ purpose: 'companyos/repository-qa-evidence/1', verdict, evidence: {} })),
        producedBy: ACTOR,
        traceId: `t18x_qa_${attempt}`,
      });
      if (!made.ok) throw new Error(made.error.message);
      return `artifact:${made.value.id}`;
    },
    async recordDecision(input) {
      const recorded = await decisionSink.record({
        commandId: supervisorDecisionCommandId(input.runId, input.identity),
        companyId: COMPANY,
        runId: input.runId,
        action: input.action,
        reasonCode: input.reasonCode as never,
        summary: input.summary,
        ...(input.evidenceRefs === undefined ? {} : { evidenceRefs: input.evidenceRefs }),
        decidedBy: ACTOR,
      });
      if (!recorded.ok) throw new Error(recorded.error.message);
      // The decision record is exactly the durable row the provisioner must honor.
      const row = await db.decisions!.get(recorded.value.decisionId, 1);
      if (row === null) throw new Error('the decision row is missing');
      return row;
    },
    async taskRows(): Promise<readonly Task[]> {
      // Read through the STORE, so the payload is mapped exactly as the engine sees it.
      return (await db.tasks.list({ limit: 500 })).items;
    },
    qaRows() {
      return Number((db.db.prepare('SELECT COUNT(*) AS c FROM validations').get() as { c: number | bigint }).c);
    },
  };
};

/** Forge a lineage override onto an existing corrective row (test-only). */
const forgeLineage = async (f: Fixture, taskId: string, over: Record<string, unknown>): Promise<void> => {
  const row = await (await f.taskRows()).find((task) => task.id === taskId);
  if (row === undefined) throw new Error("the corrective row is missing");
  const inputs = row.inputs as Record<string, unknown>;
  const lineage = { ...(inputs["corrective"] as Record<string, unknown>), ...over };
  // The task store upsert deliberately does NOT rewrite inputs_json (mutable state is never
  // caller-overwritable), so the corruption is written straight onto the row, exactly the way
  // real storage tampering would be.
  f.db.db
    .prepare("UPDATE tasks SET inputs_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...inputs, corrective: lineage }), taskId);
};
const provision = (f: Fixture, decisionId: string, over: { readonly companyId?: string; readonly decisionVersion?: number | null } = {}) =>
  f.provisioner.provision({
    companyId: over.companyId ?? COMPANY,
    runId: currentRunOf(f),
    decisionId,
    ...(over.decisionVersion === undefined ? {} : { decisionVersion: over.decisionVersion }),
    actorId: ACTOR,
  });

/** The run of the most recently created decision (decisions are recorded per run). */
let lastRunId = '';
const currentRunOf = (_f: Fixture): string => lastRunId;

describe('T18-05 corrective provisioning — carrier & decision (§72/§73)', () => {
  it('1/2/3. the existing Task table is reused with no new table and no migration', () => {
    const f = makeFixture();
    const tables = (f.db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    expect(tables).toContain('tasks');
    for (const forbidden of ['corrective_tasks', 'work_items', 'supervisor_tasks']) {
      expect(tables).not.toContain(forbidden);
    }
    void f;
  });

  it('4/8. the lineage payload is versioned and the task starts in a legal initial state', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('initial');
    lastRunId = runId;
    const work = await f.seedTask('work');
    const review = await f.seedTask('review');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({
      runId,
      identity: 'first',
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'The reviewer requires corrective work.',
      evidenceRefs: [report],
    });

    const result = await provision(f, decision.decisionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await (await f.taskRows()).find((task) => task.id === result.value.taskId);
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.state).toBe('PENDING');
    expect(row.attempts).toBe(0);
    const lineage = (row.inputs as Record<string, unknown>)['corrective'] as Record<string, unknown>;
    expect(lineage['schemaVersion']).toBe('companyos/corrective-task/1');
  });

  it('5/6/7. the workflow, snapshot and stage graph are unchanged', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('frozen');
    lastRunId = runId;
    const before = await f.db.runs.get(runId as never);
    const template = await f.db.templates.get(before!.templateId as never);
    const versionCount = template!.versions.length;
    const snapshotBefore = await f.db.snapshots.get(before!.snapshotId as never);
    const work = await f.seedTask('work');
    const review = await f.seedTask('review');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'frozen', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });

    const result = await provision(f, decision.decisionId);
    expect(result.ok).toBe(true);
    const after = await f.db.runs.get(runId as never);
    expect(after!.versionId).toBe(before!.versionId);
    expect(after!.snapshotId).toBe(before!.snapshotId);
    expect(after!.revision).toBe(before!.revision);
    expect((await f.db.templates.get(before!.templateId as never))!.versions.length).toBe(versionCount);
    expect(await f.db.snapshots.get(before!.snapshotId as never)).toEqual(snapshotBefore);
  });

  it('9. a REQUEST_CORRECTIVE decision is accepted', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('accept');
    lastRunId = runId;
    const work = await f.seedTask('work');
    const review = await f.seedTask('review');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'ok', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });
    const result = await provision(f, decision.decisionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lineage.reasonCode).toBe('REVIEW_FINDING');
    expect(result.value.replayed).toBe(false);
  });

  it('10/11/12. CONTINUE, COMPLETE and ESCALATE decisions are rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('actions');
    lastRunId = runId;
    const work = await f.seedTask('work');
    const review = await f.seedTask('review');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    for (const [index, action] of (['CONTINUE', 'COMPLETE', 'ESCALATE'] as const).entries()) {
      const decision = await f.recordDecision({
        runId,
        identity: `action-${action}`,
        action,
        reasonCode: 'GOAL_SATISFIED',
        summary: 'A non-corrective decision.',
        evidenceRefs: [report],
      });
      const result = await provision(f, decision.decisionId);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.details?.['reason']).toBe('CORRECTIVE_DECISION_ACTION_INVALID');
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(await f.taskRows()).toHaveLength(2);
  });

  it('13/14. revoked and superseded decisions cannot provision', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('revoke');
    lastRunId = runId;
    const work = await f.seedTask('work');
    const review = await f.seedTask('review');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'revocable', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });

    // Revoked afterwards: the row is REVOKED, so no new work may be authorized by it.
    const revoked = await f.decisions.revoke({ decisionId: decision.decisionId, version: 1, actorId: ACTOR });
    expect(revoked.ok).toBe(true);
    const afterRevoke = await provision(f, decision.decisionId);
    expect(afterRevoke.ok).toBe(false);
    if (afterRevoke.ok) return;
    expect(afterRevoke.error.details?.['reason']).toBe('CORRECTIVE_DECISION_NOT_ACTIONABLE');

    // Superseded afterwards: only the CURRENT version may authorize work.
    const supersededDecision = await f.recordDecision({
      runId,
      identity: 'revocable-2',
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'A later revision of the same decision.',
      evidenceRefs: [report],
    });
    const superseded = await f.decisions.supersede({
      decisionId: supersededDecision.decisionId,
      version: 1,
      actorId: ACTOR,
      next: {
        companyId: COMPANY,
        scope: { type: 'WORKFLOW', id: runId },
        subjectKey: decision.subjectKey,
        title: 'REQUEST_CORRECTIVE — REVIEW_FINDING (revised)',
        question: OBJECTIVE,
        decision: 'REQUEST_CORRECTIVE',
        rationale: 'A later revision of the same decision.',
        alternativesConsidered: [],
        constraints: [],
        consequences: [],
        relatedMemoryRefs: [],
        relatedHandoffRefs: [],
        relatedArtifactRefs: [report.replace('artifact:', '')],
        decidedBy: ACTOR,
        traceId: ids.id('trace'),
        provenance: { sourceType: 'WORKFLOW', sourceRefs: [`run:${runId}`] },
        metadata: { supervisor: { schema: 'companyos/supervisor-decision/1', companyId: COMPANY, runId, action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', evidenceRefs: [{ kind: 'artifact', ref: report, id: report.replace('artifact:', '') }], commandId: supersededDecision.subjectKey, fingerprint: 'x', executionStatus: 'RECORDED_ONLY' } },
      },
    });
    if (!superseded.ok) throw new Error(`supersede failed: ${superseded.error.code} ${superseded.error.message}`);
    expect(superseded.ok).toBe(true);
    // The old version is no longer actionable.
    const stale = await provision(f, supersededDecision.decisionId, { decisionVersion: 1 });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.details?.['reason']).toBe('CORRECTIVE_DECISION_NOT_ACTIONABLE');
  });

  it('15/16. cross-company and cross-run decisions are rejected', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('scope');
    lastRunId = runId;
    const work = await f.seedTask('work');
    const review = await f.seedTask('review');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'scoped', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });

    const otherCompany = await provision(f, decision.decisionId, { companyId: OTHER_COMPANY });
    expect(otherCompany.ok).toBe(false);
    if (otherCompany.ok) return;
    expect(['RUN_MISSING', 'CORRECTIVE_DECISION_MISSING']).toContain(otherCompany.error.details?.['reason']);

    const otherRun = await f.runWithGoal('scope-other');
    const wrongRun = await f.provisioner.provision({ companyId: COMPANY, runId: otherRun, decisionId: decision.decisionId, actorId: ACTOR });
    expect(wrongRun.ok).toBe(false);
    if (wrongRun.ok) return;
    expect(wrongRun.error.details?.['reason']).toBe('CORRECTIVE_DECISION_RUN_MISMATCH');
  });
});

describe('T18-05 corrective provisioning — cause verification (§74)', () => {
  const setup = async (label: string) => {
    const f = makeFixture();
    const runId = await f.runWithGoal(label);
    lastRunId = runId;
    const work = await f.seedTask('work');
    const review = await f.seedTask('review');
    const execution = await f.seedReviewExecution(runId, review);
    return { f, runId, work, review, execution };
  };

  it('17/23. the latest CHANGES_REQUESTED report is accepted and its subject task becomes the parent', async () => {
    const { f, runId, work, review, execution } = await setup('latest-changes');
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'changes', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });
    const result = await provision(f, decision.decisionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lineage.parentTaskId).toBe(work);
    expect(result.value.lineage.rootTaskId).toBe(work);
    expect(result.value.lineage.round).toBe(1);
  });

  it('18. a PASS report cannot cause corrective work', async () => {
    const { f, runId, work, review, execution } = await setup('pass-report');
    const recorded = await f.reviews.record({
      companyId: COMPANY,
      runId,
      reviewStageId: 'review',
      reviewTaskId: review,
      subjectTaskId: work,
      executionId: execution,
      verdict: 'PASS',
      findings: [],
      decidedBy: ACTOR,
    });
    if (!recorded.ok) throw new Error(recorded.error.message);
    const decision = await f.recordDecision({
      runId,
      identity: 'pass-cause',
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'Claiming corrective work from a passing review.',
      evidenceRefs: [`artifact:${recorded.value.artifactId}`],
    });
    const result = await provision(f, decision.decisionId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.['reason']).toBe('CORRECTIVE_CAUSE_NOT_ACTIONABLE');
  });

  it('19. a BLOCKED report does not auto-create corrective work', async () => {
    const { f, runId, work, review, execution } = await setup('blocked-report');
    const recorded = await f.reviews.record({
      companyId: COMPANY,
      runId,
      reviewStageId: 'review',
      reviewTaskId: review,
      subjectTaskId: work,
      executionId: execution,
      verdict: 'BLOCKED',
      findings: [{ code: 'review.blocked', summary: 'The reviewed diff is unavailable.', detail: 'The subject artifact is missing.', blocking: true }],
      decidedBy: ACTOR,
    });
    if (!recorded.ok) throw new Error(recorded.error.message);
    const decision = await f.recordDecision({
      runId,
      identity: 'blocked-cause',
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'Claiming corrective work from a blocked review.',
      evidenceRefs: [`artifact:${recorded.value.artifactId}`],
    });
    const result = await provision(f, decision.decisionId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.['reason']).toBe('CORRECTIVE_CAUSE_NOT_ACTIONABLE');
  });

  it('20/21. a missing or cross-run report is rejected', async () => {
    const { f, runId, work, review, execution } = await setup('missing-report');
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });

    // (a) A decision that authorizes corrective work MUST cite evidence: the sink refuses to
    // record one without it, so the no-evidence case is a tampered row.
    const empty = await f.recordDecision({
      runId,
      identity: 'missing',
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'No evidence cited.',
      evidenceRefs: [report],
    });
    f.db.db
      .prepare('UPDATE decisions SET metadata_json = ? WHERE decision_id = ? AND version = ?')
      .run(
        JSON.stringify({
          supervisor: {
            schema: 'companyos/supervisor-decision/1',
            companyId: COMPANY,
            runId,
            action: 'REQUEST_CORRECTIVE',
            reasonCode: 'REVIEW_FINDING',
            evidenceRefs: [],
            commandId: empty.subjectKey,
            fingerprint: 'tampered',
            executionStatus: 'RECORDED_ONLY',
          },
        }),
        empty.decisionId,
        1,
      );
    const missingResult = await provision(f, empty.decisionId);
    expect(missingResult.ok).toBe(false);
    if (missingResult.ok) return;
    expect(missingResult.error.details?.['reason']).toBe('CORRECTIVE_CAUSE_EVIDENCE_MISSING');

    // (b) A cited report of ANOTHER run: the decision sink refuses to record such a
    // citation, so the row is tampered the way real corruption would be.
    const otherRun = await f.runWithGoal('missing-report-other');
    const otherWork = await f.seedTask('work');
    const otherReview = await f.seedTask('review');
    const otherExecution = await f.seedReviewExecution(otherRun, otherReview);
    const otherReport = await f.recordChangesReport({
      runId: otherRun,
      reviewTaskId: otherReview,
      subjectTaskId: otherWork,
      executionId: otherExecution,
    });
    const foreign = await f.recordDecision({
      runId: otherRun,
      identity: 'foreign',
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'Citing a report of another run.',
      evidenceRefs: [otherReport],
    });
    f.db.db
      .prepare('UPDATE decisions SET metadata_json = ? WHERE decision_id = ? AND version = ?')
      .run(
        JSON.stringify({
          supervisor: {
            schema: 'companyos/supervisor-decision/1',
            companyId: COMPANY,
            runId: otherRun,
            action: 'REQUEST_CORRECTIVE',
            reasonCode: 'REVIEW_FINDING',
            evidenceRefs: [{ kind: 'artifact', ref: report, id: report.replace('artifact:', '') }],
            commandId: foreign.subjectKey,
            fingerprint: 'tampered',
            executionStatus: 'RECORDED_ONLY',
          },
        }),
        foreign.decisionId,
        1,
      );
    const crossRun = await f.provisioner.provision({
      companyId: COMPANY,
      runId: otherRun,
      decisionId: foreign.decisionId,
      actorId: ACTOR,
    });
    expect(crossRun.ok).toBe(false);
    if (crossRun.ok) return;
    expect(crossRun.error.details?.['reason']).toBe('CORRECTIVE_CAUSE_EVIDENCE_CROSS_RUN');
  });
  it('22. an old CHANGES_REQUESTED followed by a newer PASS cannot authorize work', async () => {
    const { f, runId, work, review, execution } = await setup('superseded-report');
    const executionTwo = await f.seedReviewExecution(runId, review, 2);
    const oldReport = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'old-cause', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Citing an older report.', evidenceRefs: [oldReport] });

    // A newer reviewer execution PASSES.
    const newer = await f.reviews.record({
      companyId: COMPANY,
      runId,
      reviewStageId: 'review',
      reviewTaskId: review,
      subjectTaskId: work,
      executionId: executionTwo,
      verdict: 'PASS',
      findings: [],
      decidedBy: ACTOR,
    });
    expect(newer.ok).toBe(true);

    const result = await provision(f, decision.decisionId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.['reason']).toBe('CORRECTIVE_CAUSE_REPORT_SUPERSEDED');
  });

  it('15b/57. VALIDATION_FAILED requires the latest failing QA report', async () => {
    const { f, runId, work } = await setup('qa-cause');
    // A newer PASS report must block an older failing one.
    const failing = await f.seedQaReport(runId, 'FAIL', 1);
    const passing = await f.seedQaReport(runId, 'PASS', 2);
    const oldDecision = await f.recordDecision({ runId, identity: 'qa-old', action: 'REQUEST_CORRECTIVE', reasonCode: 'VALIDATION_FAILED', summary: 'Citing an older failing batch.', evidenceRefs: [failing] });
    const oldResult = await provision(f, oldDecision.decisionId);
    expect(oldResult.ok).toBe(false);
    if (oldResult.ok) return;
    expect(oldResult.error.details?.['reason']).toBe('CORRECTIVE_CAUSE_REPORT_SUPERSEDED');

    // The latest report passes: no corrective is actionable.
    const latestDecision = await f.recordDecision({ runId, identity: 'qa-latest', action: 'REQUEST_CORRECTIVE', reasonCode: 'VALIDATION_FAILED', summary: 'Citing the latest passing batch.', evidenceRefs: [passing] });
    const latestResult = await provision(f, latestDecision.decisionId);
    expect(latestResult.ok).toBe(false);
    if (latestResult.ok) return;
    expect(latestResult.error.details?.['reason']).toBe('CORRECTIVE_CAUSE_NOT_ACTIONABLE');
    void work;
  });

  it('16. unsupported causes are refused for V1', async () => {
    const { f, runId } = await setup('unsupported');
    const evidence = await f.seedQaReport(runId, 'FAIL', 9);
    for (const reasonCode of ['TASK_FAILED', 'TOOL_FAILED']) {
      const decision = await f.recordDecision({ runId, identity: `unsupported-${reasonCode}`, action: 'REQUEST_CORRECTIVE', reasonCode, summary: 'A free-text cause.', evidenceRefs: [evidence] });
      const result = await provision(f, decision.decisionId);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.details?.['reason']).toBe('CORRECTIVE_CAUSE_UNSUPPORTED');
    }
  });
});

describe('T18-05 corrective provisioning — lineage & idempotency (§75/§76)', () => {
  const chain = async (label: string) => {
    const f = makeFixture();
    const runId = await f.runWithGoal(label);
    lastRunId = runId;
    const work = await f.seedTask('work');
    const review = await f.seedTask('review');
    return { f, runId, work, review };
  };

  const provisionFor = async (
    f: Fixture,
    input: { readonly runId: string; readonly reviewTask: string; readonly subjectTask: string; readonly identity: string },
  ): Promise<string> => {
    const execution = await f.seedReviewExecution(input.runId, input.reviewTask);
    const report = await f.recordChangesReport({ runId: input.runId, reviewTaskId: input.reviewTask, subjectTaskId: input.subjectTask, executionId: execution });
    const decision = await f.recordDecision({
      runId: input.runId,
      identity: input.identity,
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'Corrective required.',
      evidenceRefs: [report],
    });
    const result = await provision(f, decision.decisionId);
    if (!result.ok) throw new Error(result.error.message);
    return result.value.taskId;
  };

  it('24/25/26. first, second and third corrective rounds chain correctly', async () => {
    const { f, runId, work, review } = await chain('rounds');
    const t1 = await provisionFor(f, { runId, reviewTask: review, subjectTask: work, identity: 'round-1' });
    const t2 = await provisionFor(f, { runId, reviewTask: review, subjectTask: t1, identity: 'round-2' });
    const t3 = await provisionFor(f, { runId, reviewTask: review, subjectTask: t2, identity: 'round-3' });
    expect(t1).not.toBe(t2);
    expect(t2).not.toBe(t3);

    const l1 = await f.provisioner.getCorrectiveLineage({ companyId: COMPANY, runId, taskId: t1 });
    const l2 = await f.provisioner.getCorrectiveLineage({ companyId: COMPANY, runId, taskId: t2 });
    const l3 = await f.provisioner.getCorrectiveLineage({ companyId: COMPANY, runId, taskId: t3 });
    expect(l1.ok && l2.ok && l3.ok).toBe(true);
    if (!l1.ok || !l2.ok || !l3.ok || l1.value === null || l2.value === null || l3.value === null) return;
    expect([l1.value.parentTaskId, l1.value.rootTaskId, l1.value.round]).toEqual([work, work, 1]);
    expect([l2.value.parentTaskId, l2.value.rootTaskId, l2.value.round]).toEqual([t1, work, 2]);
    expect([l3.value.parentTaskId, l3.value.rootTaskId, l3.value.round]).toEqual([t2, work, 3]);

    const children = await f.provisioner.listCorrectiveChildren({ companyId: COMPANY, runId, parentTaskId: work });
    expect(children.ok).toBe(true);
    if (!children.ok) return;
    expect(children.value.map((lineage) => lineage.round)).toEqual([1]);
  });

  it('27/28/29. a caller cannot supply the parent, root or round', async () => {
    const { f, runId, work, review } = await chain('no-spoof');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'no-spoof', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });
    const result = await f.provisioner.provision({
      companyId: COMPANY,
      runId,
      decisionId: decision.decisionId,
      actorId: ACTOR,
      parentTaskId: review,
      rootTaskId: review,
      round: 9,
    } as never);
    // The inherited fields are simply ignored: the derived lineage wins.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lineage.parentTaskId).toBe(work);
    expect(result.value.lineage.rootTaskId).toBe(work);
    expect(result.value.lineage.round).toBe(1);
  });

  it('30/33. a cycle and a missing parent are rejected', async () => {
    const { f, runId, work, review } = await chain('cycle');
    const t1 = await provisionFor(f, { runId, reviewTask: review, subjectTask: work, identity: 'cyc-1' });
    // Forge a self-parent chain and let the reader reject it.
    const row = await (await f.taskRows()).find((task) => task.id === t1);
    expect(row).toBeDefined();
    if (row === undefined) return;
    await forgeLineage(f, t1, { parentTaskId: t1 });
    const cycled = await f.provisioner.getCorrectiveLineage({ companyId: COMPANY, runId, taskId: t1 });
    expect(cycled.ok).toBe(false);
    if (cycled.ok) return;
    expect(cycled.error.details?.['reason']).toBe('CORRECTIVE_LINEAGE_CYCLE');

    await forgeLineage(f, t1, { parentTaskId: 'tsk_missing' });
    const gone = await f.provisioner.getCorrectiveLineage({ companyId: COMPANY, runId, taskId: t1 });
    expect(gone.ok).toBe(false);
    if (gone.ok) return;
    expect(gone.error.details?.['reason']).toBe('CORRECTIVE_LINEAGE_PARENT_MISSING');
  });

  it('31/32. round and root mismatches are rejected', async () => {
    const { f, runId, work, review } = await chain('mismatch');
    const t1 = await provisionFor(f, { runId, reviewTask: review, subjectTask: work, identity: 'mm-1' });
    const row = await (await f.taskRows()).find((task) => task.id === t1);
    if (row === undefined) throw new Error('the corrective row is missing');
    await forgeLineage(f, t1, { round: 5 });
    const roundMismatch = await f.provisioner.getCorrectiveLineage({ companyId: COMPANY, runId, taskId: t1 });
    expect(roundMismatch.ok).toBe(false);
    if (roundMismatch.ok) return;
    expect(roundMismatch.error.details?.['reason']).toBe('CORRECTIVE_LINEAGE_ROUND_MISMATCH');

    await forgeLineage(f, t1, { round: 1, rootTaskId: review });
    const rootMismatch = await f.provisioner.getCorrectiveLineage({ companyId: COMPANY, runId, taskId: t1 });
    expect(rootMismatch.ok).toBe(false);
    if (rootMismatch.ok) return;
    expect(rootMismatch.error.details?.['reason']).toBe('CORRECTIVE_LINEAGE_ROOT_MISMATCH');
  });

  it('34. an origin decision that is not REQUEST_CORRECTIVE is rejected', async () => {
    const { f, runId, work, review } = await chain('origin');
    const t1 = await provisionFor(f, { runId, reviewTask: review, subjectTask: work, identity: 'origin-1' });
    const row = await (await f.taskRows()).find((task) => task.id === t1);
    if (row === undefined) throw new Error('the corrective row is missing');
    await forgeLineage(f, t1, { originDecisionId: 'dec_not-a-corrective' });
    const result = await f.provisioner.getCorrectiveLineage({ companyId: COMPANY, runId, taskId: t1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.['reason']).toBe('CORRECTIVE_LINEAGE_DECISION_MISSING');
  });

  it('35/37/38/41/42. replay, ledger trim, restart and tenant scope are permanent', async () => {
    const { f, runId, work, review } = await chain('permanent');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'perm', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });

    const first = await provision(f, decision.decisionId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = await provision(f, decision.decisionId);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.taskId).toBe(first.value.taskId);
    expect(again.value.replayed).toBe(true);
    expect((await f.taskRows()).filter((task) => (task.inputs as Record<string, unknown>)['corrective'] !== undefined)).toHaveLength(1);

    // The ledger is bounded: trim it and replay in a fresh graph.
    f.db.db.prepare('DELETE FROM command_ledger').run();
    f.db.close();
    const tracked = openDatabases.indexOf(f.db);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const reopened = openDurableDatabase({ dataDir: f.dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
    openDatabases.push(reopened);
    const fresh = buildFixture(reopened, f.dataDir, f.casRoot);
    lastRunId = runId;
    const afterRestart = await fresh.provisioner.provision({ companyId: COMPANY, runId, decisionId: decision.decisionId, actorId: ACTOR });
    expect(afterRestart.ok).toBe(true);
    if (!afterRestart.ok) return;
    expect(afterRestart.value.taskId).toBe(first.value.taskId);
    expect(reopened.db.prepare('SELECT COUNT(*) AS c FROM tasks').get()).toMatchObject({ c: 4 });

    // Tenant scope: the same decision id in another company is a different namespace.
    const foreignId = fresh.provisioner.provision({ companyId: OTHER_COMPANY, runId, decisionId: decision.decisionId, actorId: ACTOR });
    await expect(foreignId).resolves.toMatchObject({ ok: false });
  });

  it('36. a conflicting payload for the same identity is refused', async () => {
    const { f, runId, work, review } = await chain('conflict');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'conf', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });
    const first = await provision(f, decision.decisionId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Forge different content under the same derived identity.
    const row = await (await f.taskRows()).find((task) => task.id === first.value.taskId);
    if (row === undefined) throw new Error('the corrective row is missing');
    await forgeLineage(f, first.value.taskId, { round: 4 });
    const conflict = await provision(f, decision.decisionId);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.details?.['reason']).toBe('CORRECTIVE_TASK_FINGERPRINT_MISMATCH');
  });

  it('39. concurrent provisions of one decision yield one task', async () => {
    const { f, runId, work, review } = await chain('concurrent');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'conc', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });
    const results = await Promise.all([provision(f, decision.decisionId), provision(f, decision.decisionId), provision(f, decision.decisionId)]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => (result.ok ? result.value.taskId : ''))).size).toBe(1);
    expect((await f.taskRows()).filter((task) => (task.inputs as Record<string, unknown>)['corrective'] !== undefined)).toHaveLength(1);
  });

  it('40. the same decision id across companies cannot collide', async () => {
    const { f, runId, work, review } = await chain('tenant');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'tenant', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });
    const mine = await provision(f, decision.decisionId);
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    const other = await provision(f, decision.decisionId, { companyId: OTHER_COMPANY });
    expect(other.ok).toBe(false);
    expect((await f.taskRows()).filter((task) => (task.inputs as Record<string, unknown>)['corrective'] !== undefined)).toHaveLength(1);
  });
});

describe('T18-05 corrective provisioning — no execution & history (§77/§78)', () => {
  it('43-50. provisioning creates only the task', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('no-exec');
    lastRunId = runId;
    const work = await f.seedTask('work');
    const review = await f.seedTask('review');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'no-exec', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });

    const before = {
      tasks: await (await f.taskRows()).length,
      executions: Number((f.db.db.prepare('SELECT COUNT(*) AS c FROM agent_executions').get() as { c: number | bigint }).c),
      invocations: Number((f.db.db.prepare('SELECT COUNT(*) AS c FROM tool_invocations').get() as { c: number | bigint }).c),
      decisions: Number((f.db.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as { c: number | bigint }).c),
      reviews: Number((f.db.db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:review-findings'").get() as { c: number | bigint }).c),
      qa: f.qaRows(),
    };
    const result = await provision(f, decision.decisionId);
    expect(result.ok).toBe(true);
    const after = {
      tasks: await (await f.taskRows()).length,
      executions: Number((f.db.db.prepare('SELECT COUNT(*) AS c FROM agent_executions').get() as { c: number | bigint }).c),
      invocations: Number((f.db.db.prepare('SELECT COUNT(*) AS c FROM tool_invocations').get() as { c: number | bigint }).c),
      decisions: Number((f.db.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as { c: number | bigint }).c),
      reviews: Number((f.db.db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:review-findings'").get() as { c: number | bigint }).c),
      qa: f.qaRows(),
    };
    expect(after.tasks).toBe(before.tasks + 2); // corrective + deterministic reassessment
    expect(after.executions).toBe(before.executions);
    expect(after.invocations).toBe(before.invocations);
    expect(after.decisions).toBe(before.decisions);
    expect(after.reviews).toBe(before.reviews);
    expect(after.qa).toBe(before.qa);
  });

  it('44/45. the corrective task carries no attempt and no inherited mutable state', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('inheritance');
    lastRunId = runId;
    const work = await f.seedTask('work', { kind: 'pack-a:review-target', maxAttempts: 5 });
    // The parent already ran once and failed.
    const { applyTaskEvent } = await import('@companyos/core');
    const parent = (await f.db.tasks.get(work as never))!;
    const planned = await applyTaskEvent(parent, 'PLAN', nowIso());
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const started = await applyTaskEvent(planned.value, 'START', nowIso());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await f.db.tasks.put(started.value);
    const review = await f.seedTask('review');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'inherit', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });
    const result = await provision(f, decision.decisionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await (await f.taskRows()).find((task) => task.id === result.value.taskId);
    if (row === undefined) throw new Error('the corrective row is missing');
    expect(row.attempts).toBe(0);
    expect(row.state).toBe('PENDING');
    expect(row.maxAttempts).toBe(5);
    expect(row.kind).toBe('pack-a:review-target');
    expect(row.outputs).toEqual({});
  });

  it('51-58. history, isolation and deterministic children survive', async () => {
    const f = makeFixture();
    const runId = await f.runWithGoal('history');
    lastRunId = runId;
    const work = await f.seedTask('work');
    const review = await f.seedTask('review');
    const execution = await f.seedReviewExecution(runId, review);
    const report = await f.recordChangesReport({ runId, reviewTaskId: review, subjectTaskId: work, executionId: execution });
    const decision = await f.recordDecision({ runId, identity: 'hist', action: 'REQUEST_CORRECTIVE', reasonCode: 'REVIEW_FINDING', summary: 'Corrective required.', evidenceRefs: [report] });
    const provisioned = await provision(f, decision.decisionId);
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;

    // Revoking the Decision afterwards must not erase the task or its lineage.
    const revoked = await f.decisions.revoke({ decisionId: decision.decisionId, version: 1, actorId: ACTOR });
    expect(revoked.ok).toBe(true);
    const lineage = await f.provisioner.getCorrectiveLineage({ companyId: COMPANY, runId, taskId: provisioned.value.taskId });
    expect(lineage.ok).toBe(true);
    if (!lineage.ok || lineage.value === null) return;
    expect(lineage.value.parentTaskId).toBe(work);

    // Tenant and run isolation of the readers.
    const foreign = await f.provisioner.getCorrectiveLineage({ companyId: OTHER_COMPANY, runId, taskId: provisioned.value.taskId });
    expect(foreign.ok).toBe(false);
    const otherRun = await f.runWithGoal('history-other');
    const wrongRun = await f.provisioner.getCorrectiveLineage({ companyId: COMPANY, runId: otherRun, taskId: provisioned.value.taskId });
    expect(wrongRun.ok).toBe(false);
    const foreignChildren = await f.provisioner.listCorrectiveChildren({ companyId: OTHER_COMPANY, runId, parentTaskId: work });
    expect(foreignChildren.ok).toBe(false);
  });
});

const makeFixture = (): Fixture => {
  const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  return buildFixture(db, dirOf(db), tempDir());
};

/** The directory an open durable database lives in (its path minus the file name). */
const dirOf = (db: DurableDatabase): string => db.path.replace(/[^\\/]*$/, '');
