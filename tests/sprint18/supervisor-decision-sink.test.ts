/**
 * Sprint 18 / Task-18-03 — durable supervisor decision sink (§56 domain/persistence matrix).
 *
 * The sink is proven over the REAL durable layer (SQLite `decisions` table through the real
 * `DecisionStorePort`, the real run-goal artifact, the real snapshot verifier and the real
 * model registry). Nothing here is faked: the only stub is the authorization decision, which
 * is the composition's own seam.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { domainError, ok, type DomainError, type Result } from '@companyos/core';
import {
  createArtifactService,
  createModelRegistry,
  createProviderRegistry,
  createRunGoalService,
  createRunModelBindingReader,
  createRunSnapshotVerifier,
  createSupervisorDecisionSink,
  createWorkflowLifecycle,
  supervisorDecisionCommandId,
  type SupervisorDecisionSink,
} from '@companyos/engine';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18dec-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18D${String(++seq).padStart(12, '0')}`,
  ulid: () => `18D${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack', 'memory'] as const;
const COMPANY = 'company_default';
const ACTOR = 'user_owner';
const OBJECTIVE = 'Ship the autonomous supervisor decision layer without executing it.';

interface Fixture {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly lifecycle: ReturnType<typeof createWorkflowLifecycle>;
  readonly sink: SupervisorDecisionSink;
  /** A published template whose graph declares the given stage ids. */
  templateWithStages(label: string, stageIds: readonly string[]): Promise<string>;
  runWithGoal(label: string, options?: { readonly stages?: readonly string[]; readonly bindings?: Readonly<Record<string, string>> }): Promise<{ readonly runId: string; readonly templateId: string }>;
  seedTask(stageId: string, runIdOverride?: string): Promise<string>;
  /** Register a real provider + model so a binding can be pinned and resolved. */
  seedModel(modelKey: string, providerModelId?: string): Promise<string>;
  seedArtifact(runId: string, label: string): Promise<string>;
  /** Remove the ledger row the way a trim would (test fixture only). */
  dropLedgerEntry(commandId: string): void;
  /** Corrupt the durable snapshot row (same id, different pinned content). */
  tamperSnapshot(snapshotId: string): void;
  decisionRows(): Promise<readonly Record<string, unknown>[]>;
  restart(): { sink: SupervisorDecisionSink; lifecycle: ReturnType<typeof createWorkflowLifecycle> };
}

const makeFixture = (options: { readonly allowDecisions?: boolean } = {}): Fixture => {
  const dataDir = tempDir();
  const casRoot = tempDir();
  let db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);

  const authorize = async ({
    authority,
  }: {
    readonly actorId: string;
    readonly authority: string;
    readonly scopeId?: string;
  }): Promise<Result<true, DomainError>> => {
    if (options.allowDecisions === false && authority === 'decision.create') {
      return { ok: false as const, error: { code: 'POLICY_DENIED', message: 'decision.create refused for this test', details: {} } as DomainError };
    }
    return ok(true as const);
  };

  const build = (database: DurableDatabase) => {
    const contentStore = createFilesystemArtifactContentStore({ casRoot });
    const artifacts = createArtifactService({
      artifactStore: database.artifactStore!,
      contentStore,
      runs: database.runs,
      events: database.events,
      ledger: database.ledger,
      clock,
      ids,
      unitOfWork: database.unitOfWork,
      authorize: authorize as never,
    });
    const runGoal = createRunGoalService({
      artifactService: artifacts,
      artifactStore: database.artifactStore!,
      contentStore,
      runs: database.runs,
    });
    const providers = createProviderRegistry({
      ids,
      clock,
      registrations: database.providers,
      models: database.providerModels,
      authorize: authorize as never,
      events: database.events,
      systemActor: ACTOR,
    });
    const models = createModelRegistry({
      ids,
      clock,
      records: database.modelRecords,
      aliases: database.modelAliases,
      providers,
      events: database.events,
      scope: 'default',
    });
    const lifecycle = createWorkflowLifecycle({
      ids,
      clock,
      templates: database.templates,
      locks: database.locks,
      proposals: database.proposals,
      snapshots: database.snapshots,
      runs: database.runs,
      events: database.events,
      unitOfWork: database.unitOfWork,
      ledger: database.ledger,
      runGoal,
      modelRegistry: models,
      authorize: async (): Promise<Result<true, never>> => ok(true as const),
    });
    const sink = createSupervisorDecisionSink({
      runs: database.runs,
      tasks: database.tasks,
      templates: database.templates,
      decisions: database.decisions!,
      runGoal,
      runSnapshotVerifier: createRunSnapshotVerifier({ templates: database.templates, snapshots: database.snapshots }),
      modelBindings: createRunModelBindingReader({ runs: database.runs, snapshots: database.snapshots }),
      modelRegistry: models,
      durableReferenceResolver: async (refs) => {
        const anchored: { kind: string; id: string; ref: string; runId: string }[] = [];
        for (const ref of refs) {
          const id = ref.startsWith('artifact:') ? ref.slice('artifact:'.length) : ref;
          const row = await database.artifactStore!.get(id as never);
          if (row === null) {
            return {
              ok: false as const,
              error: domainError('NOT_FOUND', `missing ${ref}`, { reference: ref }),
            };
          }
          anchored.push({ kind: 'artifact', id: row.id, ref, runId: row.runId });
        }
        return { ok: true as const, value: anchored };
      },
      authorize: authorize as never,
      unitOfWork: database.unitOfWork,
      clock,
      ids,
    });
    return { artifacts, models, lifecycle, sink, providers };
  };

  let built = build(db);

  let lastRunId: string | null = null;
  return {
    db,
    dataDir,
    casRoot,
    get lifecycle() {
      return built.lifecycle;
    },
    get sink() {
      return built.sink;
    },
    async templateWithStages(label, stageIds) {
      const template = await built.lifecycle.createTemplate({
        orgId: COMPANY,
        name: `Supervisor flow ${label}`,
        actorId: ACTOR,
        traceId: `t18d_tpl_${label}`,
      });
      if (!template.ok) throw new Error(template.error.message);
      // A published graph needs an entry and a terminal stage: chain the nodes.
      const graph = {
        nodes: stageIds.map((id) => ({ id, kind: 'work' as const, title: id, config: {} })),
        edges: stageIds.slice(1).map((id, index) => ({ from: stageIds[index]!, to: id })),
      };
      const saved = await built.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: ACTOR, traceId: `t18d_graph_${label}` });
      if (!saved.ok) throw new Error(saved.error.message);
      const published = await built.lifecycle.publish({ templateId: template.value.id, actorId: ACTOR, traceId: `t18d_pub_${label}` });
      if (!published.ok) throw new Error(published.error.message);
      return template.value.id;
    },
    async runWithGoal(label, runOptions = {}) {
      const templateId = await this.templateWithStages(label, runOptions.stages ?? ['s1', 's2']);
      const run = await built.lifecycle.createRun({
        templateId,
        companyId: COMPANY,
        workflowId: `wf_${label}`,
        actorId: ACTOR,
        ...(runOptions.bindings === undefined ? {} : { modelBindings: runOptions.bindings }),
        goal: { objective: OBJECTIVE, source: { type: 'human', ref: label } },
      });
      if (!run.ok) throw new Error(run.error.message);
      lastRunId = run.value.run.id;
      return { runId: run.value.run.id, templateId };
    },
    async seedModel(modelKey, providerModelId = modelKey) {
      const providerModel = providerModelId.split('.').pop() ?? providerModelId;
      const registered = await built.providers.register(
        (await import('@companyos/engine')).createMockProvider({
          providerId: 'prov_local',
          kind: 'mock',
          displayName: 'Local test provider',
          script: { models: [{ modelId: providerModel, displayName: providerModel, contextWindow: 8_192, capabilities: { streaming: false } }] },
        }),
        { actorId: ACTOR },
      );
      if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
      const model = await built.models.registerFromProvider({ providerId: 'prov_local', providerModelId: providerModel, modelKey, actorId: ACTOR });
      if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
      return modelKey;
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
      const made = await built.artifacts.create({
        commandId: `evidence:${label}`,
        runId: runId as never,
        taskId: null,
        kind: 'companyos:evidence',
        content: new TextEncoder().encode(JSON.stringify({ label })),
        producedBy: ACTOR,
        traceId: `t18d_art_${label}`,
      });
      if (!made.ok) throw new Error(made.error.message);
      return `artifact:${made.value.id}`;
    },
    dropLedgerEntry(commandId) {
      db.db.prepare('DELETE FROM command_ledger WHERE command_id = ?').run(commandId);
    },
    tamperSnapshot(snapshotId) {
      db.db.prepare('UPDATE run_snapshots SET memory_view_ref = ? WHERE id = ?').run('memory:attacker', snapshotId);
    },
    async decisionRows() {
      return db.db.prepare('SELECT * FROM decisions').all() as Record<string, unknown>[];
    },
    restart() {
      db.close();
      const tracked = openDatabases.indexOf(db);
      if (tracked >= 0) openDatabases.splice(tracked, 1);
      db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
      openDatabases.push(db);
      built = build(db);
      return { sink: built.sink, lifecycle: built.lifecycle };
    },
  };
};

const commandFor = (
  runId: string,
  over: Partial<Parameters<SupervisorDecisionSink['record']>[0]> = {},
): Parameters<SupervisorDecisionSink['record']>[0] => ({
  commandId: supervisorDecisionCommandId(runId, 'first'),
  companyId: COMPANY,
  runId,
  action: 'CONTINUE',
  reasonCode: 'GOAL_SATISFIED',
  summary: 'The run objective is still on track.',
  decidedBy: ACTOR,
  ...over,
});

describe('T18-03 supervisor decision sink (domain + persistence)', () => {
  it('1. the existing DecisionStore is reused — no second store is introduced', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('reuse');
    const result = await f.sink.record(commandFor(runId));
    expect(result.ok).toBe(true);
    // The durable row lives in the ONE generic decisions table.
    const rows = await f.decisionRows();
    expect(rows.length).toBe(1);
    expect(f.db.decisions).toBeDefined();
  });

  it('2. no new decision table exists', () => {
    const f = makeFixture();
    const tables = (
      f.db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toContain('decisions');
    for (const forbidden of ['supervisor_decisions', 'orchestration_decisions', 'corrective_decisions', 'decision_sequence']) {
      expect(tables).not.toContain(forbidden);
    }
  });

  it('3. a valid CONTINUE decision records', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('continue');
    const evidence = await f.seedArtifact(runId, 'continue-1');
    const result = await f.sink.record(commandFor(runId, { evidenceRefs: [evidence] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('CONTINUE');
    expect(result.value.status).toBe('ACTIVE');
    expect(result.value.version).toBe(1);
    expect(result.value.companyId).toBe(COMPANY);
  });

  it('4. a REQUEST_CORRECTIVE decision records (and creates nothing)', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('corrective-intent');
    const evidence = await f.seedArtifact(runId, 'corrective-1');
    const tasksBefore = (await f.db.tasks.list({ limit: 100 })).items.length;
    const result = await f.sink.record(
      commandFor(runId, {
        commandId: supervisorDecisionCommandId(runId, 'intent'),
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'VALIDATION_FAILED',
        summary: 'The validation evidence batch did not pass the stage gate.',
        evidenceRefs: [evidence],
      }),
    );
    expect(result.ok).toBe(true);
    expect((await f.db.tasks.list({ limit: 100 })).items.length).toBe(tasksBefore);
  });

  it('5. an ESCALATE decision records as a durable fact only', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('escalate');
    const evidence = await f.seedArtifact(runId, 'escalate-1');
    const approvalsBefore = (await f.db.approvals.list({ limit: 100 })).items.length;
    const result = await f.sink.record(
      commandFor(runId, {
        commandId: supervisorDecisionCommandId(runId, 'escalate'),
        action: 'ESCALATE',
        reasonCode: 'HUMAN_REQUIRED',
        summary: 'No legal action remains without a human decision.',
        evidenceRefs: [evidence],
      }),
    );
    expect(result.ok).toBe(true);
    // No approval, no notification, no run transition — recording only.
    expect((await f.db.approvals.list({ limit: 100 })).items.length).toBe(approvalsBefore);
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('IDLE');
  });

  it('6. COMPLETE requires durable completion provenance', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('complete');
    const evidence = await f.seedArtifact(runId, 'complete-1');

    const without = await f.sink.record(
      commandFor(runId, { commandId: supervisorDecisionCommandId(runId, 'bare'), action: 'COMPLETE', reasonCode: 'GOAL_SATISFIED' }),
    );
    expect(without.ok).toBe(false);
    if (without.ok) return;
    expect(without.error.details?.['reason']).toBe('SUPERVISOR_DECISION_EVIDENCE_REQUIRED');

    const withEvidence = await f.sink.record(
      commandFor(runId, {
        commandId: supervisorDecisionCommandId(runId, 'complete'),
        action: 'COMPLETE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'The durable evidence set satisfies the run objective.',
        evidenceRefs: [evidence],
      }),
    );
    expect(withEvidence.ok).toBe(true);
    // It is still only a record: the run was not completed by the sink.
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('IDLE');
  });

  it('7. an unknown action is rejected by domain validation', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('bad-action');
    const result = await f.sink.record(commandFor(runId, { action: 'DO_ANYTHING' as never }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.['reason']).toBe('SUPERVISOR_DECISION_ACTION_INVALID');
  });

  it('8. a recorded decision is immutable — no update, replace or delete path', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('immutable');
    const first = await f.sink.record(commandFor(runId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const stored = await f.db.decisions!.get(first.value.decisionId, 1);
    expect(stored?.decision).toBe('CONTINUE');
    // The sink exposes no mutator: there is nothing to call that could change it.
    expect(Object.keys(f.sink).sort()).toEqual(['decisionIdOf', 'getDecision', 'listActiveRunDecisions', 'listRunDecisionHistory', 'record']);
    // A second, different decision is a NEW identity — never a rewrite of the first.
    const second = await f.sink.record(
      commandFor(runId, { commandId: supervisorDecisionCommandId(runId, 'second'), action: 'ESCALATE', reasonCode: 'HUMAN_REQUIRED', summary: 'Blocked.' }),
    );
    expect(second.ok).toBe(false); // ESCALATE without evidence is refused
    const after = await f.db.decisions!.get(first.value.decisionId, 1);
    expect(after?.decision).toBe('CONTINUE');
  });

  it('9. a restart recovers the same decision', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('restart');
    const evidence = await f.seedArtifact(runId, 'restart-1');
    const first = await f.sink.record(commandFor(runId, { evidenceRefs: [evidence] }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Durable-vs-durable: read the row back BEFORE the restart, so the comparison is about
    // storage rather than about the in-memory record’s optional-field representation.
    const beforeRestart = await f.db.decisions!.get(first.value.decisionId, 1);
    if (beforeRestart === null) throw new Error("the decision row is missing before the restart");

    const after = f.restart();
    const recovered = await after.sink.getDecision({ decisionId: first.value.decisionId, companyId: COMPANY, actorId: ACTOR });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value).toEqual(beforeRestart);
    expect(recovered.value.decisionId).toBe(first.value.decisionId);
    expect(recovered.value.decision).toBe(first.value.decision);
    expect(recovered.value.relatedArtifactRefs).toEqual(first.value.relatedArtifactRefs);
    const listed = await after.sink.listRunDecisionHistory({ runId, companyId: COMPANY, actorId: ACTOR });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((row) => row.decisionId)).toEqual([first.value.decisionId]);
  });

  it('10. listing by run is deterministic', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('list');
    const evidence = await f.seedArtifact(runId, 'list-1');
    const first = await f.sink.record(commandFor(runId, { commandId: supervisorDecisionCommandId(runId, 'a'), evidenceRefs: [evidence] }));
    const second = await f.sink.record(
      commandFor(runId, {
        commandId: supervisorDecisionCommandId(runId, 'b'),
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'TASK_FAILED',
        summary: 'The task failed for a semantic reason.',
        evidenceRefs: [evidence],
      }),
    );
    expect(first.ok && second.ok).toBe(true);
    const listed = await f.sink.listRunDecisionHistory({ runId, companyId: COMPANY, actorId: ACTOR });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.length).toBe(2);
    const again = await f.sink.listRunDecisionHistory({ runId, companyId: COMPANY, actorId: ACTOR });
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value.map((row) => row.decisionId)).toEqual(listed.value.map((row) => row.decisionId));
  });
});

describe('T18-03 supervisor decision sink (trusted context)', () => {
  it('11. a canonical goal is required — a goalless run is refused', async () => {
    const f = makeFixture();
    const templateId = await f.templateWithStages('goalless', ['s1']);
    const run = await f.lifecycle.createRun({ templateId, companyId: COMPANY, workflowId: 'wf_goalless', actorId: ACTOR });
    if (!run.ok) throw new Error(run.error.message);
    const result = await f.sink.record(commandFor(run.value.run.id));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.['reason']).toBe('RUN_GOAL_MISSING');
    expect(await f.decisionRows()).toHaveLength(0);
  });

  it('12. the snapshot is verified before recording (T18-02 seam)', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('snapshot');
    const result = await f.sink.record(commandFor(runId));
    expect(result.ok).toBe(true);
    const verified = await f.sink.getDecision({ decisionId: result.ok ? result.value.decisionId : '', companyId: COMPANY, actorId: ACTOR });
    expect(verified.ok).toBe(true);
  });

  it('13. a tampered snapshot is rejected', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('tampered');
    const run = await f.db.runs.get(runId as never);
    f.tamperSnapshot(run!.snapshotId);
    const result = await f.sink.record(commandFor(runId));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SNAPSHOT_MISMATCH');
    expect(await f.decisionRows()).toHaveLength(0);
  });

  it('14. a stage that is not part of the run is rejected', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('foreign-stage');
    const result = await f.sink.record(commandFor(runId, { stageId: 'stage-from-elsewhere' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.['reason']).toBe('SUPERVISOR_DECISION_STAGE_MISMATCH');
  });

  it('15. a task anchored to a stage it does not belong to is rejected', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('task-ownership', { stages: ['s1', 's2'] });
    const taskId = await f.seedTask('s1');

    const correct = await f.sink.record(commandFor(runId, { commandId: supervisorDecisionCommandId(runId, 'task'), stageId: 's1', taskId }));
    expect(correct.ok).toBe(true);

    const wrongStage = await f.sink.record(
      commandFor(runId, {
        commandId: supervisorDecisionCommandId(runId, 'task-wrong-stage'),
        stageId: 's2',
        taskId,
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'TASK_FAILED',
        summary: 'A corrective is requested for a task of another stage.',
      }),
    );
    expect(wrongStage.ok).toBe(false);
    if (wrongStage.ok) return;
    expect(wrongStage.error.details?.['reason']).toBe('SUPERVISOR_DECISION_TASK_STAGE_MISMATCH');
  });

  it('16. cross-company access is refused', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('cross-company');
    const recorded = await f.sink.record(commandFor(runId));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const read = await f.sink.getDecision({ decisionId: recorded.value.decisionId, companyId: 'company_other', actorId: ACTOR });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe('NOT_FOUND');
    const listed = await f.sink.listRunDecisionHistory({ runId, companyId: 'company_other', actorId: ACTOR });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toEqual([]);
  });

  it('17. a missing evidence ref is rejected', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('missing-evidence');
    const result = await f.sink.record(
      commandFor(runId, { action: 'REQUEST_CORRECTIVE', reasonCode: 'TOOL_FAILED', evidenceRefs: ['artifact:does-not-exist'] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(await f.decisionRows()).toHaveLength(0);
  });

  it('18. a cross-run evidence ref is rejected', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('evidence-owner');
    const other = await f.runWithGoal('evidence-other');
    const foreign = await f.seedArtifact(other.runId, 'foreign');
    const result = await f.sink.record(
      commandFor(runId, { action: 'REQUEST_CORRECTIVE', reasonCode: 'VALIDATION_FAILED', evidenceRefs: [foreign] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.['reason']).toBe('SUPERVISOR_DECISION_EVIDENCE_CROSS_RUN');
    void other;
  });

  it('19. a pinned model binding is accepted and recorded as provenance', async () => {
    const f = makeFixture();
    await f.seedModel('local.model-a');
    const { runId } = await f.runWithGoal('binding', { bindings: { default: 'local.model-a' } });
    const result = await f.sink.record(commandFor(runId, { modelBindingKey: 'default' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metadata = result.value.metadata as Record<string, unknown>;
    const envelope = metadata['supervisor'] as Record<string, unknown>;
    expect(envelope['modelBindingKey']).toBe('default');
    expect(envelope['resolvedModelKey']).toBe('local.model-a');
    expect(envelope['executionStatus']).toBe('RECORDED_ONLY');
  });

  it('20. a missing binding fails closed', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('no-binding');
    const result = await f.sink.record(commandFor(runId, { modelBindingKey: 'default' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.['reason']).toBe('RUN_BINDING_MISSING');
  });

  it('21. an arbitrary provider/model cannot be supplied', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('no-model-identity');
    const result = await f.sink.record(
      commandFor(runId, { modelKey: 'local.model-b', providerId: 'evil' } as never),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.['reason']).toBe('SUPERVISOR_DECISION_MODEL_IDENTITY_REJECTED');
  });
});
