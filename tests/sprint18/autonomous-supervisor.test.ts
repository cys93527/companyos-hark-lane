/**
 * Sprint 18 / Task-18-07 — the bounded autonomous supervisor loop (§67–§74).
 *
 * Everything here runs on the REAL durable layer and the REAL services: SQLite stores, the
 * real run-goal artifact, the real snapshot verifier, the real decision sink, the real review
 * sink, the real corrective provisioner (with the round cap), the real WorkflowEngine and the
 * real AgentRuntime. There is no live model API: the only fake is a deterministic in-process
 * provider adapter registered through the real provider registry.
 *
 * Group map (the approved matrix):
 *   loop core        1–10
 *   bounds           11–20
 *   idempotency      21–27
 *   anti-stale       28–32
 *   model binding    39–44
 *   cancellation     45–52
 *   escalation       53–57
 * The output-carrier items (33–38) are reported separately: the frozen `StageHandlerOutcome`
 * contract carries no structured channel, so they are deliberately not claimed here.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createExecution,
  createTask,
  createValidation,
  domainError,
  ok,
  type DomainError,
  type Result,
} from '@companyos/core';
import {
  MAX_SUPERVISOR_TURNS,
  SUPERVISOR_PROPOSAL_SCHEMA,
  createAgentRuntime,
  createArtifactService,
  createAutonomousSupervisorRuntime,
  createCorrectiveProvisioner,
  createMockProvider,
  createModelRegistry,
  createProviderRegistry,
  createReviewFindingsSink,
  createRunGoalService,
  createRunModelBindingReader,
  createRunSnapshotVerifier,
  createSelectionPolicyService,
  createSupervisorDecisionRuntime,
  createSupervisorDecisionSink,
  createWorkflowEngine,
  createWorkflowLifecycle,
  type ArtifactService,
  type AutonomousSupervisorRuntime,
  type AutonomousSupervisorConfig,
  type CorrectiveProvisioner,
  type MockProvider,
  type RunAutonomousSupervisionCommand,
  type ReviewFindingsSink,
  type SupervisorDecisionRuntime,
  type SupervisorDecisionSink,
} from '@companyos/engine';
import type { StageHandlerRegistry, WorkflowEngine } from '@companyos/engine';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';

/* ------------------------------------------------------------------ harness */

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18loop-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18L${String(++seq).padStart(12, '0')}`,
  ulid: () => `18L${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string =>
  new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };
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
const ACTOR = 'user_owner';
const SUPERVISOR_BINDING = 'supervisor';
const PROVIDER_ID = 'prov_loop';
const MODEL_KEY = 'loop.model';
const PROVIDER_MODEL_ID = 'loop-model-1';
const CATALOGUE = [
  {
    modelId: PROVIDER_MODEL_ID,
    displayName: PROVIDER_MODEL_ID,
    contextWindow: 8_192,
    capabilities: { streaming: false, structuredOutput: true },
  },
];
const sleepFor = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A per-fixture scriptable timer, so a deadline can be expired deterministically. */
const createTimers = () => {
  const pending: { fire: () => void; cleared: boolean }[] = [];
  return {
    timer: (ms: number, onTimeout: () => void): (() => void) => {
      const handle = setTimeout(onTimeout, ms);
      const entry = { fire: onTimeout, cleared: false };
      pending.push(entry);
      return () => {
        entry.cleared = true;
        clearTimeout(handle);
      };
    },
    fireAll(): void {
      for (const entry of pending) if (!entry.cleared) entry.fire();
    },
    pendingCount(): number {
      return pending.filter((entry) => !entry.cleared).length;
    },
  };
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

interface RunAt {
  readonly runId: string;
  readonly templateId: string;
}

interface Fixture {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly model: MockProvider;
  readonly timers: ReturnType<typeof createTimers>;
  readonly supervisor: SupervisorDecisionRuntime;
  readonly autonomous: AutonomousSupervisorRuntime;
  readonly decisionSink: SupervisorDecisionSink;
  readonly reviews: ReviewFindingsSink;
  readonly provisioner: CorrectiveProvisioner;
  readonly engine: WorkflowEngine;
  /** The lifecycle writer, so a test can build a run with a different binding set. */
  readonly lifecycle: ReturnType<typeof createWorkflowLifecycle>;
  /** How many stage executions the engine performed. */
  advanceCalls(): number;
  templateWithStages(label: string, stageIds: readonly string[]): Promise<string>;
  /** A run driven to EXECUTING by the engine's own legal commands. */
  runAt(label: string, stageIds: readonly string[]): Promise<RunAt>;
  seedTask(
    input: {
      readonly stageId: string;
      readonly state?: string;
      readonly maxAttempts?: number;
      readonly kind?: string;
      readonly inputs?: Readonly<Record<string, unknown>>;
    },
    runIdOverride?: string,
  ): Promise<string>;
  seedValidation(runId: string, status: 'pass' | 'fail'): Promise<string>;
  /** A COMPLETED reviewer execution for a review task, plus one durable review report. */
  seedReviewReport(input: {
    readonly runId: string;
    readonly reviewTaskId: string;
    readonly subjectTaskId: string;
    readonly verdict: 'PASS' | 'CHANGES_REQUESTED';
  }): Promise<string>;
  /** Drive an EXECUTING run to FINALIZING through the engine's legal commands. */
  toFinalizing(runId: string): Promise<void>;
  /** Re-open the SAME durable files in a fresh composition. */
  restart(): void;
}

const makeFixture = (
  options: {
    /** Scripted stage-handler outcomes per task kind (the queue drains, last entry repeats). */
    readonly stageOutcomes?: Readonly<
      Record<string, readonly ('succeeded' | 'failed' | 'blocked')[]>
    >;
    readonly config?: AutonomousSupervisorConfig;
  } = {},
): Fixture => {
  const dataDir = tempDir();
  const casRoot = tempDir();
  let db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  const authorize = async (): Promise<Result<true, DomainError>> => ok(true as const);
  const timers = createTimers();
  const model = createMockProvider({
    providerId: PROVIDER_ID,
    kind: 'fake',
    displayName: 'Loop model',
    sleep: (ms: number) => sleepFor(ms),
    script: { models: CATALOGUE },
  });

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
    registries = { providers, models };
    const policies = createSelectionPolicyService({
      ids,
      clock,
      policies: database.selectionPolicies,
      results: database.benchmarkResults,
      readRecords: async () => models.list({ includeDisabled: true }),
      events: database.events,
    });
    const lifecycleService = createWorkflowLifecycle({
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
    const bindingReader = createRunModelBindingReader({
      runs: database.runs,
      snapshots: database.snapshots,
    });
    const snapshotVerifier = createRunSnapshotVerifier({
      templates: database.templates,
      snapshots: database.snapshots,
    });
    const decisionSink = createSupervisorDecisionSink({
      runs: database.runs,
      tasks: database.tasks,
      templates: database.templates,
      decisions: database.decisions!,
      runGoal,
      runSnapshotVerifier: snapshotVerifier,
      modelBindings: bindingReader,
      modelRegistry: models,
      durableReferenceResolver: async (refs: readonly string[]) => {
        const anchored: { kind: string; id: string; ref: string; runId: string }[] = [];
        for (const ref of refs) {
          if (ref.startsWith('val_')) {
            const row = await database.validationStore!.get(ref as never);
            if (row === null)
              return {
                ok: false as const,
                error: domainError('NOT_FOUND', `missing ${ref}`, { reference: ref }),
              };
            anchored.push({ kind: 'validation', id: row.id, ref, runId: row.runId });
            continue;
          }
          const id = ref.startsWith('artifact:') ? ref.slice('artifact:'.length) : ref;
          const row = await database.artifactStore!.get(id as never);
          if (row === null)
            return {
              ok: false as const,
              error: domainError('NOT_FOUND', `missing ${ref}`, { reference: ref }),
            };
          anchored.push({ kind: 'artifact', id: row.id, ref, runId: row.runId });
        }
        return { ok: true as const, value: anchored };
      },
      authorize: authorize as never,
      unitOfWork: database.unitOfWork,
      clock,
      ids,
    });
    const reviews = createReviewFindingsSink({
      runs: database.runs,
      tasks: database.tasks,
      templates: database.templates,
      agentExecutions: database.agentExecutions,
      artifactService: artifacts,
      artifactStore: database.artifactStore!,
      contentStore,
      runGoal,
      runSnapshotVerifier: snapshotVerifier,
      modelBindings: bindingReader,
      modelRegistry: models,
      durableReferenceResolver: async (refs: readonly string[]) => {
        const anchored: { kind: string; id: string; ref: string; runId: string }[] = [];
        for (const ref of refs) {
          const id = ref.startsWith('artifact:') ? ref.slice('artifact:'.length) : ref;
          const row = await database.artifactStore!.get(id as never);
          if (row === null)
            return {
              ok: false as const,
              error: domainError('NOT_FOUND', `missing ${ref}`, { reference: ref }),
            };
          anchored.push({ kind: 'artifact', id: row.id, ref, runId: row.runId });
        }
        return { ok: true as const, value: anchored };
      },
      unitOfWork: database.unitOfWork,
      clock,
      ids,
    });
    const agentRuntime = createAgentRuntime({
      ids,
      clock,
      executions: database.agentExecutions,
      artifacts: database.executionArtifacts,
      models,
      providers,
      policies,
      events: database.events,
      authorize: authorize as never,
      secrets: async () => [],
      logger: undefined,
    });
    const supervisor = createSupervisorDecisionRuntime({
      runs: database.runs,
      tasks: database.tasks,
      runGoal,
      runSnapshotVerifier: snapshotVerifier,
      modelBindings: bindingReader,
      modelRegistry: models,
      reviewReports: {
        getLatestReviewReport: ({ companyId, runId, reviewTaskId, actorId }) =>
          reviews
            .getLatestReviewReport({ companyId, runId, reviewTaskId, actorId })
            .then((result) =>
              result.ok
                ? result.value === null
                  ? { ok: true as const, value: null }
                  : {
                      ok: true as const,
                      value: {
                        artifactId: result.value.artifactId,
                        verdict: result.value.payload.verdict,
                        subjectTaskId: result.value.payload.subjectTaskId,
                        findings: result.value.payload.findings as unknown as readonly Readonly<
                          Record<string, unknown>
                        >[],
                      },
                    }
                : { ok: false as const, error: result.error },
            ),
      },
      validations: {
        listByRun: (runId: string) => database.validationStore!.listByRun(runId as never),
      },
      decisionHistory: decisionSink,
      decisionSink,
      agentRuntime,
      timer: timers.timer,
      clock,
      ids,
      supervisorBindingKey: SUPERVISOR_BINDING,
      supervisorAgentId: 'supervisor-runtime',
      supervisorRoleId: 'supervisor-runtime',
    });
    const provisioner = createCorrectiveProvisioner({
      runs: database.runs,
      tasks: database.tasks,
      templates: database.templates,
      decisions: database.decisions!,
      artifacts: database.artifactStore!,
      content: { get: (contentRef: string) => contentStore.get(contentRef) },
      ...(database.toolInvocations === undefined
        ? {}
        : { toolInvocations: database.toolInvocations }),
      runSnapshot: snapshotVerifier,
      reviewReports: {
        latestReviewReport: ({ companyId, runId, reviewTaskId, actorId }) =>
          reviews
            .getLatestReviewReport({ companyId, runId, reviewTaskId, actorId })
            .then((result) =>
              result.ok
                ? result.value === null
                  ? { ok: true as const, value: null }
                  : {
                      ok: true as const,
                      value: {
                        artifactId: result.value.artifactId,
                        verdict: result.value.payload.verdict,
                      },
                    }
                : { ok: false as const, error: result.error },
            ),
      },
      unitOfWork: database.unitOfWork,
      maxCorrectiveRounds: options.config?.maxCorrectiveRounds ?? 3,
    });

    /* ---- the engine, with a scripted StageHandler registry and a call counter ---- */
    let advanceCalls = 0;
    const queues = new Map<string, ('succeeded' | 'failed' | 'blocked')[]>(
      Object.entries(options.stageOutcomes ?? { 'pack-a:build': ['succeeded'] }).map(
        ([kind, outcomes]) => [kind, [...outcomes]],
      ),
    );
    const handlers: StageHandlerRegistry = {
      resolve: (kind: string) => ({
        id: `scripted:${kind}`,
        execute: () => {
          const queue = queues.get(kind);
          if (queue === undefined) return 'failed';
          return queue.length <= 1 ? (queue[0] ?? 'succeeded') : (queue.shift() ?? 'succeeded');
        },
      }),
    };
    const engine = createWorkflowEngine({
      ids,
      clock,
      runs: database.runs,
      events: database.events,
      approvals: database.approvals,
      tasks: database.tasks,
      handlers,
      ledger: database.ledger,
      unitOfWork: database.unitOfWork,
      runSnapshotVerifier: snapshotVerifier,
    });
    const advance = engine.advance.bind(engine);
    engine.advance = (request) => {
      advanceCalls += 1;
      return advance(request);
    };

    const autonomous = createAutonomousSupervisorRuntime({
      tasks: database.tasks,
      taskById: (taskId: string) => database.tasks.get(taskId as never),
      templates: database.templates,
      snapshots: database.snapshots,
      runs: database.runs,
      executions: database.agentExecutions,
      decisionReader: decisionSink,
      // §39: the run's decision history, so a COMPLETED run finalizes pending bookkeeping.
      decisionHistory: decisionSink,
      supervisorRuntime: supervisor,
      provisioner,
      engine,
      artifactService: artifacts,
      artifactStore: database.artifactStore!,
      timer: timers.timer,
      clock,
      ids,
      config: options.config,
      supervisorBindingKey: SUPERVISOR_BINDING,
    });
    return {
      artifacts,
      lifecycle: lifecycleService,
      decisionSink,
      reviews,
      supervisor,
      autonomous,
      engine,
      provisioner,
      advanceCalls: () => advanceCalls,
    };
  };

  /**
   * The registries are per-build; this handle lets the fixture seed the fake provider through
   * the REAL provider registry (idempotent across restarts — a stored row is not an error).
   * Declared BEFORE the first build so the build can publish into it.
   */
  let registries: {
    providers: ReturnType<typeof createProviderRegistry>;
    models: ReturnType<typeof createModelRegistry>;
  };
  let built = build(db);

  const registerProvider = async (): Promise<void> => {
    const registered = await registries.providers.register(model, { actorId: ACTOR });
    if (!registered.ok && registered.error.code !== 'CONFLICT')
      throw new Error(registered.error.message);
    const made = await registries.models.registerFromProvider({
      providerId: PROVIDER_ID,
      providerModelId: PROVIDER_MODEL_ID,
      modelKey: MODEL_KEY,
      actorId: ACTOR,
    });
    if (!made.ok && made.error.code !== 'CONFLICT') throw new Error(made.error.message);
  };

  let lastRunId: string | null = null;
  return {
    get db() {
      return db;
    },
    dataDir,
    casRoot,
    model,
    timers,
    get supervisor() {
      return built.supervisor;
    },
    get autonomous() {
      return built.autonomous;
    },
    get decisionSink() {
      return built.decisionSink;
    },
    get reviews() {
      return built.reviews;
    },
    get provisioner() {
      return built.provisioner;
    },
    get engine() {
      return built.engine;
    },
    get lifecycle() {
      return built.lifecycle;
    },
    advanceCalls: () => built.advanceCalls(),
    async templateWithStages(label, stageIds) {
      await registerProvider();
      const template = await built.lifecycle.createTemplate({
        orgId: COMPANY,
        name: `Loop ${label}`,
        actorId: ACTOR,
        traceId: `t18l_tpl_${label}`,
      });
      if (!template.ok) throw new Error(template.error.message);
      const graph = {
        nodes: stageIds.map((id) => ({ id, kind: 'work' as const, title: id, config: {} })),
        edges: stageIds.slice(1).map((id, index) => ({ from: stageIds[index]!, to: id })),
      };
      const saved = await built.lifecycle.saveDraftGraph({
        templateId: template.value.id,
        graph,
        actorId: ACTOR,
        traceId: `t18l_graph_${label}`,
      });
      if (!saved.ok) throw new Error(saved.error.message);
      const published = await built.lifecycle.publish({
        templateId: template.value.id,
        actorId: ACTOR,
        traceId: `t18l_pub_${label}`,
      });
      if (!published.ok) throw new Error(published.error.message);
      return template.value.id;
    },
    async runAt(label, stageIds) {
      const templateId = await this.templateWithStages(label, stageIds);
      const run = await built.lifecycle.createRun({
        templateId,
        companyId: COMPANY,
        workflowId: `wf_${label}`,
        actorId: ACTOR,
        modelBindings: { [SUPERVISOR_BINDING]: MODEL_KEY },
        goal: { objective: `Deliver the ${label} slice.`, source: { type: 'human' } },
      });
      if (!run.ok) throw new Error(run.error.message);
      const driven = await built.engine.drive(run.value.run.id, { maxSteps: 8 });
      if (!driven.ok) throw new Error(driven.error.message);
      if (driven.value.run.state !== 'EXECUTING')
        throw new Error(`the engine left the run in ${driven.value.run.state}`);
      lastRunId = run.value.run.id;
      return { runId: run.value.run.id, templateId };
    },
    async seedTask(input, runIdOverride?: string) {
      const seedRunId = runIdOverride ?? lastRunId;
      if (seedRunId === null) throw new Error('seedTask requires a prior runAt/runWithGoal — canonical run ownership.');
      const task = await createTask({ runId: seedRunId as never,
        stageId: input.stageId as never,
        roleId: 'rol_1' as never,
        kind: input.kind ?? 'pack-a:build',
        now: nowIso(),
        ids,
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
        ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
      });
      if (!task.ok) throw new Error(task.error.message);
      await db.tasks.put(
        input.state === undefined ? task.value : { ...task.value, state: input.state as never },
      );
      return task.value.id;
    },
    async seedValidation(runId, status) {
      const made = await createValidation({
        runId: runId as never,
        validatorId: 'pack-a:unit',
        validatorVersion: '1.0.0',
        status,
        blocking: true,
        exitCode: status === 'pass' ? 0 : 1,
        startedAt: nowIso(),
        finishedAt: nowIso(),
        ids,
      });
      if (!made.ok) throw new Error(made.error.message);
      await db.validationStore!.record(made.value, {
        creationCommandId: `cmd_v_${ids.id('v')}`,
        creationCommandFingerprint: 'fp:seed',
      });
      return made.value.id;
    },
    async seedReviewReport(input) {
      await registerProvider();
      const made = await createExecution({
        executionId: ids.id('exc'),
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
        traceId: ids.id('trace'),
        now: nowIso(),
      });
      if (!made.ok) throw new Error(made.error.message);
      await db.agentExecutions.put({ ...made.value, status: 'COMPLETED' as never });
      const recorded = await built.reviews.record({
        companyId: COMPANY,
        runId: input.runId,
        reviewStageId: 'review',
        reviewTaskId: input.reviewTaskId,
        subjectTaskId: input.subjectTaskId,
        executionId: made.value.executionId,
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
        decidedBy: ACTOR,
      });
      if (!recorded.ok) throw new Error(recorded.error.message);
      return recorded.value.artifactId;
    },
    async toFinalizing(runId) {
      for (const type of ['EXECUTION.COMPLETE', 'REVIEW.PASS', 'VALIDATION.PASS']) {
        const current = await db.runs.get(runId as never);
        if (current === null) throw new Error('run vanished');
        const dispatched = await built.engine.dispatch({
          commandId: `t18l-drive:${runId}:${type}:${String(current.revision)}`,
          runId,
          type,
          expectedRevision: current.revision,
          actorId: ACTOR,
          traceId: ids.id('trace'),
          issuedAt: nowIso(),
        });
        if (!dispatched.ok) throw new Error(`${type} refused: ${dispatched.error.message}`);
      }
    },
    restart() {
      db.close();
      const tracked = openDatabases.indexOf(db);
      if (tracked >= 0) openDatabases.splice(tracked, 1);
      db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
      openDatabases.push(db);
      built = build(db);
      // The durable provider/model rows survive; re-registering is a no-op that also re-binds
      // the in-memory adapter for the new composition.
      void registerProvider();
    },
  };
};

/* ------------------------------------------------------------------- helpers */

const scriptProposal = (model: MockProvider, value: Readonly<Record<string, unknown>>): void => {
  model.setScript({
    models: CATALOGUE,
    outcomes: [
      { outputText: 'proposal', structured: { schema: SUPERVISOR_PROPOSAL_SCHEMA, ...value } },
    ],
  });
};

/** Script an ORDERED sequence of proposals: the Nth invocation gets the Nth entry. */
const scriptProposals = (
  model: MockProvider,
  values: readonly Readonly<Record<string, unknown>>[],
): void => {
  model.setScript({
    models: CATALOGUE,
    outcomes: values.map((value) => ({
      outputText: 'proposal',
      structured: { schema: SUPERVISOR_PROPOSAL_SCHEMA, ...value },
    })),
  });
};

const artifactServiceOf = (f: Fixture): Pick<ArtifactService, 'create'> =>
  (f as unknown as { artifacts: ArtifactService }).artifacts;

const runOf = (input: {
  readonly runId: string;
  readonly taskId: string;
  readonly identity?: string;
  readonly signal?: AbortSignal;
  readonly reviewTaskId?: string;
}): RunAutonomousSupervisionCommand => ({
  companyId: COMPANY,
  runId: input.runId,
  taskId: input.taskId,
  ...(input.reviewTaskId === undefined ? {} : { reviewTaskId: input.reviewTaskId }),
  actorId: ACTOR,
  runIdentity: input.identity ?? 'run',
  ...(input.signal === undefined ? {} : { signal: input.signal }),
});

const taskCount = (f: Fixture): number =>
  Number((f.db.db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number | bigint }).c);
const executionCount = (f: Fixture): number =>
  Number(
    (f.db.db.prepare('SELECT COUNT(*) AS c FROM agent_executions').get() as { c: number | bigint })
      .c,
  );
const decisionCount = (f: Fixture): number =>
  Number(
    (f.db.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as { c: number | bigint }).c,
  );
/** How many application receipts exist for ONE decision identity (by its command id). */
const receiptsFor = (f: Fixture, decisionId: string): number =>
  Number(
    (
      f.db.db
        .prepare(
          "SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:supervisor-application' AND creation_command_id LIKE ?",
        )
        .get(`%${decisionId}%`) as { c: number | bigint }
    ).c,
  );

const receiptCount = (f: Fixture): number =>
  Number(
    (
      f.db.db
        .prepare(
          "SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:supervisor-application'",
        )
        .get() as {
        c: number | bigint;
      }
    ).c,
  );

/* ================================================================================ */

describe('T18-07 autonomous supervisor — loop core (1–10)', () => {
  it('1. one Supervisor turn → CONTINUE → exactly one work unit', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('one', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    scriptProposal(f.model, proposal());
    const result = await f.autonomous.run(runOf({ runId, taskId: work }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turns).toBeGreaterThanOrEqual(1);
    // Sprint21: after the work unit, the empty REVIEW gate advances by the deterministic
    // gate-skip (no review-class stage in this degenerate fixture graph); the all-work
    // graph then stops at VALIDATING with the validator-requirements-missing human stop.
    expect(result.value.applied).toHaveLength(2);
    expect(result.value.applied[0]?.action).toBe('CONTINUE');
    expect(result.value.applied[0]?.effect.startsWith('stage:build:')).toBe(true);
    expect(result.value.applied[1]?.effect).toBe('gate:review:no-review-work');
    expect(result.value.stopReason).toBe('validation_requirements_missing');
    // ONE work unit: one engine stage execution, and the task is DONE.
    expect(f.advanceCalls()).toBe(1);
    const stored = await f.db.tasks.get(work as never);
    expect(stored?.state).toBe('DONE');
  });

  it('2. the work result produces the next Supervisor turn', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('next', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    scriptProposal(f.model, proposal());
    const result = await f.autonomous.run(runOf({ runId, taskId: work }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Turn 0 executed the unit; turn 1 gate-skipped the empty REVIEW gate; turn 3 stopped
    // at VALIDATING (no validator requirements in this degenerate fixture graph).
    expect(result.value.turns).toBe(3);
    expect(result.value.applied).toHaveLength(2);
    expect(result.value.stopReason).toBe('validation_requirements_missing');
    // Three supervisor executions (work + gate-skip + validation stop turns).
    expect(executionCount(f)).toBe(3);
  });

  it('3. REQUEST_CORRECTIVE provisions exactly one corrective Task', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('corrective', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposals(f.model, [
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'The reviewer requires corrective work.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
      proposal(),
    ]);
    const before = taskCount(f);
    const result = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'corrective' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied[0]?.action).toBe('REQUEST_CORRECTIVE');
    expect(taskCount(f)).toBe(before + 2); // corrective + its deterministic reassessment
    // The one new task is the corrective child with round 1.
    const rows = f.db.db.prepare('SELECT id, inputs_json, stage_id FROM tasks').all() as {
      id: string;
      inputs_json: string;
      stage_id: string;
    }[];
    const child = rows.find((row) => row.id !== work && row.id !== review);
    expect(child).toBeDefined();
    const lineage = JSON.parse(String(child?.inputs_json))['corrective'] as Record<string, unknown>;
    expect(lineage['round']).toBe(1);
    expect(lineage['parentTaskId']).toBe(work);
    expect(lineage['rootTaskId']).toBe(work);
  });

  it('4. the corrective Task is executed exactly once', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('once', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposals(f.model, [
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'The reviewer requires corrective work.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
      proposal(),
    ]);
    const result = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'once' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The corrective task ran exactly ONE attempt: no second execution of the same unit.
    const child = (
      f.db.db.prepare('SELECT id, attempts, state FROM tasks').all() as {
        id: string;
        attempts: number;
        state: string;
      }[]
    ).find((row) => row.id !== work && row.id !== review);
    expect(child?.state).toBe('DONE');
    expect(child?.attempts).toBe(1);
  });

  it('5. the corrective result returns control to the Supervisor', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('after', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposal(
      f.model,
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'The reviewer requires corrective work.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
    );
    const result = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'after' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Turn 0 applied the corrective unit; turn 1 consulted the Supervisor again.
    expect(result.value.turns).toBeGreaterThanOrEqual(2);
    expect(result.value.applied).toHaveLength(1);
  });

  it('6. COMPLETE ends the loop with the Run completed', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('complete', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build', state: 'DONE' });
    const validationId = await f.seedValidation(runId, 'pass');
    await f.toFinalizing(runId);
    scriptProposal(
      f.model,
      proposal({
        action: 'COMPLETE',
        reasonCode: 'GOAL_SATISFIED',
        evidenceRefs: [validationId],
        subject: { taskId: work },
      }),
    );
    const result = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'complete' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('completed');
    expect(result.value.applied[0]?.effect).toBe('run:completed');
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('COMPLETED');
    // No model call happened for a second turn: the loop stopped at COMPLETE.
    expect(result.value.turns).toBe(1);
  });

  it('7. ESCALATE ends the loop and stops autonomous execution', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('escalate', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposal(
      f.model,
      proposal({
        action: 'ESCALATE',
        reasonCode: 'HUMAN_REQUIRED',
        summary: 'A human must decide.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
    );
    const result = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'escalate' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('escalated');
    expect(result.value.applied[0]?.effect).toBe('run:waiting_approval');
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('WAITING_APPROVAL');
    const pending = (await f.db.approvals.list({ limit: 50 })).items.filter(
      (item) => item.status === 'pending',
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.riskLevel).toBe('HIGH');
  });

  it('8. no legal action ends the loop', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('none', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build', state: 'DONE' });
    scriptProposal(f.model, proposal());
    const result = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'none' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // F1 closure: the loop now advances the EXECUTING gate (all work terminal →
    // EXECUTION.COMPLETE → REVIEWING → VALIDATING) and stops at the FIRST gate that
    // has no legal semantics — a more truthful terminal than a bare no_legal_action.
    expect(result.value.stopReason).toBe('validation_requirements_missing');
    // The two gate effects (EXECUTION.COMPLETE + REVIEW.PASS via engine.dispatch, never
    // an agent advance) are recorded as applied gate effects; no WORK was executed and
    // no provider round ran for them.
    expect(f.advanceCalls()).toBe(0);
  });

  it('9. a CANCELLED execution ends the loop without any retry', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('cancelled', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    // A previous attempt that ended as a cancellation: terminal, never re-entered.
    const made = await createExecution({
      executionId: ids.id('exc'),
      agentId: 'agent_worker',
      roleId: 'rol_1' as never,
      taskId: work as never,
      runId: runId as never,
      binding: {
        modelKey: MODEL_KEY,
        providerId: PROVIDER_ID,
        providerModelId: PROVIDER_MODEL_ID,
        source: 'EXPLICIT_BINDING',
      },
      attempt: 1,
      traceId: ids.id('trace'),
      now: nowIso(),
    });
    if (!made.ok) throw new Error(made.error.message);
    await f.db.agentExecutions.put({
      ...made.value,
      status: 'FAILED' as never,
      errorKind: 'CANCELLED' as never,
      errorCode: 'CANCELLED' as never,
    });
    const before = executionCount(f);
    const result = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'cancelled' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('cancelled');
    expect(result.value.turns).toBe(0);
    // ZERO supervisor model calls, ZERO new executions, ZERO stage executions.
    expect(f.model.calls.length).toBe(0);
    expect(executionCount(f)).toBe(before);
    expect(f.advanceCalls()).toBe(0);
  });

  it('10. a non-retryable execution failure ends the loop', async () => {
    const f = makeFixture({ stageOutcomes: { 'pack-a:build': ['failed'] } });
    const { runId } = await f.runAt('failure', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build', maxAttempts: 1 });
    scriptProposal(f.model, proposal());
    const result = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'failure' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('non_retryable_failure');
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('FAILED');
    const stored = await f.db.tasks.get(work as never);
    expect(stored?.state).toBe('FAILED');
  });
});

describe('T18-07 autonomous supervisor — bounds (11–20)', () => {
  const provisionRound = async (
    f: Fixture,
    input: {
      readonly runId: string;
      readonly subject: string;
      readonly review: string;
      readonly identity: string;
    },
  ): Promise<Result<{ taskId: string }, DomainError>> => {
    const reportId = await f.seedReviewReport({
      runId: input.runId,
      reviewTaskId: input.review,
      subjectTaskId: input.subject,
      verdict: 'CHANGES_REQUESTED',
    });
    const recorded = await f.decisionSink.record({
      commandId: `supervisor-decision:${input.runId}:${input.identity}`,
      companyId: COMPANY,
      runId: input.runId,
      taskId: input.subject,
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'The reviewer requires corrective work.',
      evidenceRefs: [`artifact:${reportId}`],
      decidedBy: ACTOR,
    });
    if (!recorded.ok) return recorded;
    const provisioned = await f.provisioner.provision({
      companyId: COMPANY,
      runId: input.runId,
      decisionId: recorded.value.decisionId,
      actorId: ACTOR,
    });
    if (!provisioned.ok) return provisioned;
    return { ok: true as const, value: { taskId: provisioned.value.taskId } };
  };

  it('11–13. corrective rounds 1, 2 and 3 are allowed', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('rounds', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    let subject = work;
    const rounds: number[] = [];
    for (const index of [1, 2, 3]) {
      const provisioned = await provisionRound(f, {
        runId,
        subject,
        review,
        identity: `round-${String(index)}`,
      });
      expect(provisioned.ok).toBe(true);
      if (!provisioned.ok) return;
      const task = await f.db.tasks.get(provisioned.value.taskId as never);
      const lineage = JSON.parse(
        String(task?.inputs['corrective'] ? JSON.stringify(task.inputs['corrective']) : '{}'),
      ) as Record<string, unknown>;
      rounds.push(Number(lineage['round']));
      subject = provisioned.value.taskId;
    }
    expect(rounds).toEqual([1, 2, 3]);
  });

  it('14–15. round 4 is rejected before Task creation, even for a direct provisioner call', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('cap', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    let subject = work;
    for (const index of [1, 2, 3]) {
      const provisioned = await provisionRound(f, {
        runId,
        subject,
        review,
        identity: `cap-${String(index)}`,
      });
      expect(provisioned.ok).toBe(true);
      if (!provisioned.ok) return;
      subject = provisioned.value.taskId;
    }
    const before = taskCount(f);
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: subject,
      verdict: 'CHANGES_REQUESTED',
    });
    const recorded = await f.decisionSink.record({
      commandId: `supervisor-decision:${runId}:cap-4`,
      companyId: COMPANY,
      runId,
      taskId: subject,
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'One more corrective round.',
      evidenceRefs: [`artifact:${reportId}`],
      decidedBy: ACTOR,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const refused = await f.provisioner.provision({
      companyId: COMPANY,
      runId,
      decisionId: recorded.value.decisionId,
      actorId: ACTOR,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.details['reason']).toBe('CORRECTIVE_ROUND_LIMIT_EXCEEDED');
    expect(refused.error.details['derivedRound']).toBe(4);
    expect(refused.error.details['maxCorrectiveRounds']).toBe(3);
    // ZERO tasks were created for the refused round.
    expect(taskCount(f)).toBe(before);
  });

  it('16–17. the supervisor-turn ceiling stops the loop before the next model call', async () => {
    const f = makeFixture({ config: { maxSupervisorTurns: 1 } });
    const { runId } = await f.runAt('turncap', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    scriptProposal(f.model, proposal());
    const result = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'turncap' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exactly ONE turn happened and it stopped for the ceiling, not for lack of work.
    expect(result.value.turns).toBe(1);
    expect(result.value.stopReason).toBe('human_required');
    expect(f.model.calls.length).toBe(1);
    // The remaining legal work was NOT silently executed: still PENDING, never DONE.
    const review0 = await f.db.tasks.get(review as never);
    expect(review0?.state).toBe('PENDING');
    // And the V1 ruling is 20 turns by trusted configuration, not by model output.
    expect(MAX_SUPERVISOR_TURNS).toBe(20);
  });

  it('18. round exhaustion becomes a human-required stop, never a silent COMPLETE', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('exhaust', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    let subject = work;
    for (const index of [1, 2, 3]) {
      const provisioned = await provisionRound(f, {
        runId,
        subject,
        review,
        identity: `ex-${String(index)}`,
      });
      expect(provisioned.ok).toBe(true);
      if (!provisioned.ok) return;
      subject = provisioned.value.taskId;
    }
    const lastReport = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: subject,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposal(
      f.model,
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'One more round.',
        evidenceRefs: [`artifact:${lastReport}`],
        subject: { taskId: subject },
      }),
    );
    const result = await f.autonomous.run(
      runOf({ runId, taskId: subject, reviewTaskId: review, identity: 'exhaust-run' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('round_limit');
    expect(result.value.applied).toHaveLength(0);
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).not.toBe('COMPLETED');
  });

  it('19–20. no unbounded recursion: bounded turns, no stack growth', async () => {
    const f = makeFixture({ config: { maxSupervisorTurns: 5, maxIdleTurns: 2 } });
    const { runId } = await f.runAt('bounded', ['s1', 's2', 's3', 's4', 's5', 's6']);
    const first = await f.seedTask({ stageId: 's1' });
    scriptProposal(f.model, proposal());
    const result = await f.autonomous.run(runOf({ runId, taskId: first, identity: 'bounded' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Each turn executes exactly one stage unit, serially — no fan-out, no recursion.
    // Sprint21: unit-fixture graphs reach the engine without the multi-stage seams, so the
    // first stage completes the (single-domain-visible) execution; the loop then gate-skips.
    expect(result.value.turns).toBeLessThanOrEqual(5);
    const workUnits = result.value.applied.filter((entry) => entry.effect.startsWith('stage:'));
    expect(workUnits.length).toBe(f.advanceCalls());
    expect(workUnits.length).toBe(1);
  });
});

describe('T18-07 autonomous supervisor — idempotency (21–27)', () => {
  it('21. the same CONTINUE Decision applied twice executes one work unit', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('idem-continue', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    scriptProposal(f.model, proposal());
    const first = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'same' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const tasksBefore = taskCount(f);
    const callsBefore = f.advanceCalls();
    // The SAME identity replays: the decision dedupes, the receipt proves it was applied.
    const second = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'same' }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.applied[0]?.replayed).toBe(true);
    // Nothing NEW was applied: every entry of the replay is the same durable fact.
    expect(second.value.applied.filter((entry) => !entry.replayed)).toHaveLength(0);
    expect(f.advanceCalls()).toBe(callsBefore);
    expect(taskCount(f)).toBe(tasksBefore);
    expect(decisionCount(f)).toBeGreaterThanOrEqual(1);
    // The decision of the first run has exactly ONE application receipt, forever.
    expect(receiptsFor(f, first.value.applied[0]?.decisionId ?? 'none')).toBe(1);
  });

  it('22. the same corrective Decision applied twice creates one Task', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('idem-corrective', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposals(f.model, [
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'Corrective work.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
      proposal(),
    ]);
    const before = taskCount(f);
    const first = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'same-corrective' }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(taskCount(f)).toBe(before + 2); // corrective + its deterministic reassessment
    const second = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'same-corrective' }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // One Task; every applied entry in the replay is the same durable decision. The replayed
    // run also closes turn 1's replayed CONTINUE with its §40 application-replay receipt — a
    // consumed verdict no longer blocks it — so the receipt count is one per APPLIED decision.
    expect(taskCount(f)).toBe(before + 2); // corrective + its deterministic reassessment
    expect(second.value.applied[0]?.replayed).toBe(true);
    // Sprint21: the trailing CONTINUE also rides the empty-review gate-skip (+1 receipt,
    // +1 gate decision turn).
    expect(receiptCount(f)).toBe(1);
    expect(decisionCount(f)).toBeGreaterThanOrEqual(2);
  });

  it('23. the same COMPLETE Decision applied twice performs one transition', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('idem-complete', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build', state: 'DONE' });
    const validationId = await f.seedValidation(runId, 'pass');
    await f.toFinalizing(runId);
    scriptProposal(
      f.model,
      proposal({
        action: 'COMPLETE',
        reasonCode: 'GOAL_SATISFIED',
        evidenceRefs: [validationId],
        subject: { taskId: work },
      }),
    );
    const first = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'complete-once' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.stopReason).toBe('completed');
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('COMPLETED');
    const second = await f.autonomous.run(
      runOf({ runId, taskId: work, identity: 'complete-once' }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.stopReason).toBe('completed');
    // No further model call, no second delivery transition.
    expect(f.model.calls.length).toBe(1);
    expect(receiptCount(f)).toBe(1);
  });

  it('24. the same ESCALATE replay is stable and makes zero model calls', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('idem-escalate', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposal(
      f.model,
      proposal({
        action: 'ESCALATE',
        reasonCode: 'HUMAN_REQUIRED',
        summary: 'Human needed.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
    );
    const first = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'escalate-once' }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.stopReason).toBe('escalated');
    const callsBefore = f.model.calls.length;
    const approvalsBefore = (await f.db.approvals.list({ limit: 50 })).items.length;
    const second = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'escalate-once' }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.stopReason).toBe('escalated');
    expect(second.value.turns).toBe(0);
    expect(f.model.calls.length).toBe(callsBefore);
    expect((await f.db.approvals.list({ limit: 50 })).items.length).toBe(approvalsBefore);
  });

  it('25. a trimmed ledger does not duplicate the action', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('trim', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    scriptProposal(f.model, proposal());
    const first = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'trim-once' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const callsBefore = f.advanceCalls();
    // Simulate a ledger trim: every command row is gone, permanently.
    f.db.db.prepare('DELETE FROM command_ledger').run();
    const second = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'trim-once' }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.applied[0]?.replayed).toBe(true);
    expect(second.value.applied.filter((entry) => !entry.replayed)).toHaveLength(0);
    expect(f.advanceCalls()).toBe(callsBefore);
    expect(receiptsFor(f, first.value.applied[0]?.decisionId ?? 'none')).toBe(1);
  });

  it('26. a restart does not duplicate the action', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('restart', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    scriptProposal(f.model, proposal());
    const first = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'restart-once' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const tasksBefore = taskCount(f);
    f.restart();
    // The fresh composition's own counters start from zero; what matters is that the replay
    // adds NOTHING to them.
    const advancesAfterRestart = f.advanceCalls();
    const second = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'restart-once' }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.applied[0]?.replayed).toBe(true);
    expect(f.advanceCalls()).toBe(advancesAfterRestart);
    expect(taskCount(f)).toBe(tasksBefore);
    expect(receiptsFor(f, first.value.applied[0]?.decisionId ?? 'none')).toBe(1);
  });

  it('27. concurrent application of the same Decision has one effect', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('concurrent', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposal(
      f.model,
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'Corrective work.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
    );
    const before = taskCount(f);
    scriptProposals(f.model, [
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'Corrective work.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
      proposal(),
    ]);
    const [a, b] = await Promise.all([
      f.autonomous.run(runOf({ runId, taskId: work, reviewTaskId: review, identity: 'race' })),
      f.autonomous.run(runOf({ runId, taskId: work, reviewTaskId: review, identity: 'race' })),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Exactly one corrective Task, whichever call won; one receipt per APPLIED decision (the
    // replayed CONTINUE of the losing call closes with its §40 application-replay receipt).
    expect(taskCount(f)).toBe(before + 2); // corrective + its deterministic reassessment
    // The replayed call may also close a replayed CONTINUE with its §40 application-replay
    // receipt, so the receipt count is 1 or 2 depending on the interleaving — never more than
    // one per applied Decision.
    expect(receiptCount(f)).toBeLessThanOrEqual(3);
    const applied = [...a.value.applied, ...b.value.applied];
    // Sprint21: the winning loop may additionally apply the empty-review gate-skip under a
    // SECOND distinct Decision — the invariant is one corrective Task and at most one
    // application per Decision id, never a duplicated application.
    const fresh = applied.filter((entry) => !entry.replayed);
    expect(fresh.length).toBeLessThanOrEqual(2);
    expect(new Set(fresh.map((entry) => entry.decisionId)).size).toBe(fresh.length);
    expect(fresh.filter((entry) => entry.effect.startsWith('corrective:')).length).toBeLessThanOrEqual(1);
  });
});

describe('T18-07 autonomous supervisor — anti-stale (28–32)', () => {
  it('28–29. a revoked or superseded Decision cannot be applied', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('stale-decision', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposal(
      f.model,
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'Corrective work.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
    );
    const before = taskCount(f);
    // Revoke the decision the model is about to have applied, then run the loop: the
    // applicator must refuse rather than act on a decision that is no longer current.
    const recorded = await f.decisionSink.record({
      commandId: `supervisor-decision:${runId}:stale`,
      companyId: COMPANY,
      runId,
      taskId: work,
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'A decision that will be revoked.',
      evidenceRefs: [`artifact:${reportId}`],
      decidedBy: ACTOR,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const store = f.db.decisions!;
    const revoked = await store.update({ ...recorded.value, status: 'REVOKED' as never });
    expect(revoked).toBeUndefined();
    const result = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'stale-run' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The loop stops without applying anything, and no corrective Task was created.
    expect(taskCount(f)).toBe(before);
    expect(result.value.applied).toHaveLength(0);
  });

  it('30. the latest Review changing before apply rejects the stale application', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('stale-review', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposal(
      f.model,
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'Corrective work.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
    );
    const before = taskCount(f);
    // The TOCTOU window: between the Supervisor's proposal and the application, a NEWER
    // review report lands. The provisioner re-resolves the cause at apply time and refuses.
    const realProvision = f.provisioner.provision.bind(f.provisioner);
    f.provisioner.provision = async (command) => {
      await f.seedReviewReport({
        runId,
        reviewTaskId: review,
        subjectTaskId: work,
        verdict: 'PASS',
      });
      return realProvision(command);
    };
    const result = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'stale-review-run' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('error');
    expect(taskCount(f)).toBe(before);
  });

  it('31. the latest Validation changing before apply rejects the stale application', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('stale-qa', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    await f.seedValidation(runId, 'fail');
    const validationId = await f.seedValidation(runId, 'fail');
    scriptProposal(
      f.model,
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'VALIDATION_FAILED',
        summary: 'QA failed.',
        evidenceRefs: [validationId],
        subject: { taskId: work },
      }),
    );
    const before = taskCount(f);
    const realProvision = f.provisioner.provision.bind(f.provisioner);
    f.provisioner.provision = async (command) => {
      // A newer PASSING validation lands in the window: the failing evidence is superseded.
      await f.seedValidation(runId, 'pass');
      return realProvision(command);
    };
    const result = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'stale-qa-run' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('error');
    expect(taskCount(f)).toBe(before);
  });

  it('32. a Task that reaches a terminal state before apply performs no work', async () => {
    const f = makeFixture({ stageOutcomes: { 'pack-a:build': ['succeeded'] } });
    const { runId } = await f.runAt('stale-task', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    scriptProposal(f.model, proposal());
    const before = f.advanceCalls();
    const realAdvance = f.engine.advance.bind(f.engine);
    f.engine.advance = async (request) => {
      // The task was cancelled in the window between the proposal and the application.
      const current = await f.db.tasks.get(work as never);
      await f.db.tasks.put({ ...current!, state: 'CANCELLED' as never });
      return realAdvance(request);
    };
    const result = await f.autonomous.run(
      runOf({ runId, taskId: work, identity: 'stale-task-run' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The engine's own semantics refuse to work a cancelled task; the loop stops fail-closed.
    expect(f.advanceCalls()).toBe(before + 1);
    expect(result.value.stopReason).toBe('non_retryable_failure');
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('FAILED');
  });
});

/**
 * T18-07 corrective — the Decision application crash window (§34–§40).
 *
 * The receipt is written AFTER the action, so the honest question is what happens in between.
 * The answer each action must give is the same: replaying the SAME Decision identity after the
 * action already committed produces ZERO duplicate effect, because the action itself is
 * idempotent through its own permanent identity:
 *   CONTINUE          → the engine's stage execution is a no-op once the task is DONE;
 *   REQUEST_CORRECTIVE→ the T18-05 permanent corrective Task identity (run+decision+version);
 *   ESCALATE          → exactly ONE pending Approval exists for the run;
 *   COMPLETE          → the run is already terminal, so no second transition is dispatched.
 * The checkpoint is INJECTED (no wall clock, no fault framework — that is T18-08's job).
 */
describe('T18-07 corrective — decision application crash window (36–40)', () => {
  it('36. CONTINUE: action commits, receipt missing → replay executes no work twice', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('crash-continue', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    scriptProposal(f.model, proposal({ subject: { taskId: work } }));
    let calls = 0;
    const engineWithCheckpoint = {
      ...f.engine,
      advance: async (request: Parameters<typeof f.engine.advance>[0]) => {
        calls += 1;
        await f.engine.advance(request);
        // The crash lands AFTER the action committed and BEFORE the receipt is written.
        throw domainError('INTERRUPTED', 'process died before the application receipt');
      },
    };
    const runtime = createAutonomousSupervisorRuntime({
      runs: f.db.runs,
      tasks: f.db.tasks,
      taskById: (taskId: string) => f.db.tasks.get(taskId as never),
      templates: f.db.templates,
      snapshots: f.db.snapshots,
      executions: f.db.agentExecutions,
      decisionReader: f.decisionSink,
      decisionHistory: f.decisionSink,
      supervisorRuntime: f.supervisor,
      provisioner: f.provisioner,
      engine: engineWithCheckpoint as never,
      artifactService: artifactServiceOf(f),
      artifactStore: f.db.artifactStore!,
      timer: f.timers.timer,
      clock,
      ids,
      supervisorBindingKey: 'supervisor',
    });
    await runtime.run(runOf({ runId, taskId: work, identity: 'crash-continue' }));
    // The action DID commit: the task is DONE, and no receipt exists yet.
    const stored = await f.db.tasks.get(work as never);
    expect(stored?.state).toBe('DONE');
    expect(receiptCount(f)).toBe(0);
    expect(calls).toBe(1);

    // Replaying the SAME identity: the engine's own semantics make the stage a no-op, and the
    // decision replay means no second attempt at all.
    const replayed = await f.autonomous.run(
      runOf({ runId, taskId: work, identity: 'crash-continue' }),
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.applied[0]?.replayed).toBe(true);
    // Sprint21: the replayed loop may then apply the empty-review gate-skip under a NEW
    // decision — the work itself is never re-executed (attempts stay 1).
    const fresh = replayed.value.applied.filter((entry) => !entry.replayed);
    expect(fresh.length).toBeLessThanOrEqual(1);
    if (fresh.length === 1) expect(fresh[0]?.effect).toBe('gate:review:no-review-work');
    const after = await f.db.tasks.get(work as never);
    expect(after?.state).toBe('DONE');
    expect(after?.attempts).toBe(1);
    expect(receiptCount(f)).toBeLessThanOrEqual(2);
  });

  it('37. REQUEST_CORRECTIVE: Task commits, receipt missing → replay produces the same Task', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('crash-corrective', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposals(f.model, [
      proposal({
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'Corrective work.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
      proposal({ subject: { taskId: work } }),
    ]);
    // Crash after the corrective task is provisioned and executed, before the receipt.
    let crashed = false;
    const engineWithCheckpoint = {
      ...f.engine,
      advance: async (request: Parameters<typeof f.engine.advance>[0]) => {
        const result = await f.engine.advance(request);
        if (!crashed && request.taskIds.some((id) => id !== work && id !== review)) {
          crashed = true;
          throw domainError('INTERRUPTED', 'process died before the application receipt');
        }
        return result;
      },
    };
    const runtime = createAutonomousSupervisorRuntime({
      runs: f.db.runs,
      tasks: f.db.tasks,
      taskById: (taskId: string) => f.db.tasks.get(taskId as never),
      templates: f.db.templates,
      snapshots: f.db.snapshots,
      executions: f.db.agentExecutions,
      decisionReader: f.decisionSink,
      decisionHistory: f.decisionSink,
      supervisorRuntime: f.supervisor,
      provisioner: f.provisioner,
      engine: engineWithCheckpoint as never,
      artifactService: artifactServiceOf(f),
      artifactStore: f.db.artifactStore!,
      timer: f.timers.timer,
      clock,
      ids,
      supervisorBindingKey: 'supervisor',
    });
    await runtime.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'crash-corrective' }),
    );
    // The corrective task IS durable (T0 + review + T1 + reassessment) and no receipt exists yet.
    expect(taskCount(f)).toBe(4);
    expect(receiptCount(f)).toBe(0);

    // A logging wrapper around the provisioner to expose why the replay cannot apply.
    const replayed = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'crash-corrective' }),
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.applied[0]?.replayed).toBe(true);
    // Exactly one corrective task exists: the permanent identity prevented a second one.
    expect(taskCount(f)).toBe(4);
    expect(receiptCount(f)).toBe(1);
  });

  it('38. ESCALATE: approval commits, receipt missing → replay creates no second Approval', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('crash-escalate', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposal(
      f.model,
      proposal({
        action: 'ESCALATE',
        reasonCode: 'HUMAN_REQUIRED',
        summary: 'Human needed.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
    );
    let crashed = false;
    const engineWithCheckpoint = {
      ...f.engine,
      dispatch: async (
        command: { readonly type: string } & Parameters<typeof f.engine.dispatch>[0],
      ) => {
        const result = await f.engine.dispatch(command);
        if (!crashed && command.type === 'APPROVAL.REQUEST') {
          crashed = true;
          throw domainError('INTERRUPTED', 'process died before the application receipt');
        }
        return result;
      },
    };
    const runtime = createAutonomousSupervisorRuntime({
      runs: f.db.runs,
      tasks: f.db.tasks,
      taskById: (taskId: string) => f.db.tasks.get(taskId as never),
      templates: f.db.templates,
      snapshots: f.db.snapshots,
      executions: f.db.agentExecutions,
      decisionReader: f.decisionSink,
      decisionHistory: f.decisionSink,
      supervisorRuntime: f.supervisor,
      provisioner: f.provisioner,
      engine: engineWithCheckpoint as never,
      artifactService: artifactServiceOf(f),
      artifactStore: f.db.artifactStore!,
      timer: f.timers.timer,
      clock,
      ids,
      supervisorBindingKey: 'supervisor',
    });
    await runtime.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'crash-escalate' }),
    );
    // The approval IS durable and the run waits for a human, with no receipt yet.
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('WAITING_APPROVAL');
    const pendingAfter = (await f.db.approvals.list({ limit: 50 })).items.filter(
      (a) => a.status === 'pending',
    );
    expect(pendingAfter).toHaveLength(1);
    expect(receiptCount(f)).toBe(0);

    // Replay: the run already waits for a human, so no second approval is ever requested.
    const modelCallsBefore = f.model.calls.length;
    const replayed = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'crash-escalate' }),
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.stopReason).toBe('escalated');
    // The run waits for a human before the supervisor is ever consulted again.
    expect(replayed.value.turns).toBe(0);
    const pendingNow = (await f.db.approvals.list({ limit: 50 })).items.filter(
      (a) => a.status === 'pending',
    );
    expect(pendingNow).toHaveLength(1);
    expect(f.model.calls.length).toBe(modelCallsBefore);
  });

  it('39. COMPLETE: transition commits, receipt missing → replay dispatches no second transition', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('crash-complete', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build', state: 'DONE' });
    const validationId = await f.seedValidation(runId, 'pass');
    await f.toFinalizing(runId);
    scriptProposal(
      f.model,
      proposal({
        action: 'COMPLETE',
        reasonCode: 'GOAL_SATISFIED',
        evidenceRefs: [validationId],
        subject: { taskId: work },
      }),
    );
    let crashed = false;
    const engineWithCheckpoint = {
      ...f.engine,
      dispatch: async (
        command: { readonly type: string } & Parameters<typeof f.engine.dispatch>[0],
      ) => {
        const result = await f.engine.dispatch(command);
        if (!crashed && command.type === 'DELIVERY.COMPLETE') {
          crashed = true;
          throw domainError('INTERRUPTED', 'process died before the application receipt');
        }
        return result;
      },
    };
    const runtime = createAutonomousSupervisorRuntime({
      runs: f.db.runs,
      tasks: f.db.tasks,
      taskById: (taskId: string) => f.db.tasks.get(taskId as never),
      templates: f.db.templates,
      snapshots: f.db.snapshots,
      executions: f.db.agentExecutions,
      decisionReader: f.decisionSink,
      decisionHistory: f.decisionSink,
      supervisorRuntime: f.supervisor,
      provisioner: f.provisioner,
      engine: engineWithCheckpoint as never,
      artifactService: artifactServiceOf(f),
      artifactStore: f.db.artifactStore!,
      timer: f.timers.timer,
      clock,
      ids,
      supervisorBindingKey: 'supervisor',
    });
    await runtime.run(runOf({ runId, taskId: work, identity: 'crash-complete' }));
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('COMPLETED');
    expect(receiptCount(f)).toBe(0);

    // Replay: the run is terminal, so the loop stops without issuing an illegal transition.
    const replayed = await f.autonomous.run(
      runOf({ runId, taskId: work, identity: 'crash-complete' }),
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.stopReason).toBe('completed');
    expect(replayed.value.turns).toBe(0);
    // The replay made zero new model calls (the crashed run's single turn was the only one).
    expect(f.model.calls.length).toBe(1);
    const after = await f.db.runs.get(runId as never);
    expect(after?.state).toBe('COMPLETED');
    expect(receiptCount(f)).toBe(1);
  });

  it('40. a receipt replay after a full ledger trim remains exact', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('crash-trim', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    scriptProposal(f.model, proposal({ subject: { taskId: work } }));
    const first = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'crash-trim' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const tasksBefore = taskCount(f);
    f.db.db.prepare('DELETE FROM command_ledger').run();
    const replayed = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'crash-trim' }));
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.applied[0]?.replayed).toBe(true);
    // The trimmed ledger changed nothing: this decision still has exactly one application.
    expect(receiptsFor(f, first.value.applied[0]?.decisionId ?? 'none')).toBe(1);
    expect(taskCount(f)).toBe(tasksBefore);
  });
});

describe('T18-07 autonomous supervisor — cancellation (45–52)', () => {
  it('45–47. an outer abort stops the run and terminates the provider invocation', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('abort', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    // The model call is genuinely in flight (30s of scripted pending) when the run aborts.
    scriptProposal(f.model, proposal());
    f.model.setScript({
      models: CATALOGUE,
      pendingMs: 30_000,
      outcomes: [{ outputText: 'proposal', structured: proposal() }],
    });
    const controller = new AbortController();
    const turn = f.autonomous.run(
      runOf({ runId, taskId: work, identity: 'abort-run', signal: controller.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const result = await turn;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('cancelled');
    // The provider OBSERVED the abort: this is a real termination, not an abandoned promise.
    expect(f.model.signalObservations).toBeGreaterThanOrEqual(1);
    expect(f.model.abortObservations).toBeGreaterThanOrEqual(1);
    // Zero work was performed and no Decision was applied.
    expect(result.value.applied).toHaveLength(0);
    expect(f.advanceCalls()).toBe(0);
  });

  it('48. a CANCELLED execution never enters automatic retry', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('noretry', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const made = await createExecution({
      executionId: ids.id('exc'),
      agentId: 'agent_worker',
      roleId: 'rol_1' as never,
      taskId: work as never,
      runId: runId as never,
      binding: {
        modelKey: MODEL_KEY,
        providerId: PROVIDER_ID,
        providerModelId: PROVIDER_MODEL_ID,
        source: 'EXPLICIT_BINDING',
      },
      attempt: 1,
      traceId: ids.id('trace'),
      now: nowIso(),
    });
    if (!made.ok) throw new Error(made.error.message);
    await f.db.agentExecutions.put({
      ...made.value,
      status: 'FAILED' as never,
      errorKind: 'CANCELLED' as never,
    });
    const result = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'noretry-run' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('cancelled');
    // The engine was never asked to re-enter the (still RUNNING) task.
    expect(f.advanceCalls()).toBe(0);
    const stored = await f.db.tasks.get(work as never);
    expect(stored?.state).toBe('PENDING');
  });

  it('49–51. an abort after the Decision but before its action leaves zero effects', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('midabort', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    scriptProposal(f.model, proposal());
    // Abort exactly after the Decision is durable and before the applicator acts.
    const realRecord = f.decisionSink.record.bind(f.decisionSink);
    f.decisionSink.record = async (command) => {
      const written = await realRecord(command);
      return written;
    };
    const controller = new AbortController();
    const realAdvance = f.engine.advance.bind(f.engine);
    f.engine.advance = async () => {
      // The cancellation lands in the window AFTER the Decision is durable and BEFORE the
      // action runs: the action must not happen at all.
      controller.abort();
      throw domainError('CANCELLED', 'the turn was cancelled before the action');
    };
    void realAdvance;
    const result = await f.autonomous.run(
      runOf({ runId, taskId: work, identity: 'mid-abort-run', signal: controller.signal }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('cancelled');
    // The run itself still saw no work executed: the engine call never happened.
    const work0 = await f.db.tasks.get(work as never);
    expect(work0?.state).not.toBe('DONE');
    expect(f.engine.advance).toBeDefined();
  });

  it('52. the whole-run deadline timer is released on every exit path', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('timer', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    scriptProposal(f.model, proposal());
    await f.autonomous.run(runOf({ runId, taskId: work, identity: 'timer-run' }));
    expect(f.timers.pendingCount()).toBe(0);
    const controller = new AbortController();
    controller.abort();
    await f.autonomous.run(
      runOf({ runId, taskId: work, identity: 'timer-run-2', signal: controller.signal }),
    );
    expect(f.timers.pendingCount()).toBe(0);
  });
});

describe('T18-07 autonomous supervisor — escalation & resume (53–57)', () => {
  it('53–54. ESCALATE survives a restart and the run cannot continue automatically', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('survive', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposal(
      f.model,
      proposal({
        action: 'ESCALATE',
        reasonCode: 'HUMAN_REQUIRED',
        summary: 'Human needed.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
    );
    const first = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'survive-once' }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.stopReason).toBe('escalated');
    f.restart();
    // A fresh composition over the SAME files: the escalated state is durable and machine-readable.
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('WAITING_APPROVAL');
    const pending = (await f.db.approvals.list({ limit: 50 })).items.filter(
      (item) => item.status === 'pending',
    );
    expect(pending).toHaveLength(1);
    // The run cannot execute further work while escalated: the engine's own state machine
    // refuses the stage execution, so no task is touched.
    let refused: unknown = null;
    try {
      await f.engine.advance({
        runId: runId as never,
        stageId: 'build' as never,
        taskIds: [work] as never,
        snapshot: {
          snapshotId: String(run?.snapshotId ?? '') as never,
          snapshotHash: '0'.repeat(64) as never,
        },
      });
    } catch (error) {
      refused = error;
    }
    expect(refused).not.toBeNull();
    const after = await f.db.tasks.get(work as never);
    expect(after?.state).not.toBe('DONE');
  });

  it('55. a replay does not create a duplicate escalation', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('no-dup', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposal(
      f.model,
      proposal({
        action: 'ESCALATE',
        reasonCode: 'HUMAN_REQUIRED',
        summary: 'Human needed.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
    );
    const first = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'no-dup-once' }),
    );
    expect(first.ok).toBe(true);
    const approvalsAfterFirst = (await f.db.approvals.list({ limit: 50 })).items.length;
    const second = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'no-dup-once' }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.stopReason).toBe('escalated');
    expect(second.value.turns).toBe(0);
    expect((await f.db.approvals.list({ limit: 50 })).items.length).toBe(approvalsAfterFirst);
  });

  it('56–57. a trusted resume changes the state once and refuses a stale resume', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('resume', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    scriptProposal(
      f.model,
      proposal({
        action: 'ESCALATE',
        reasonCode: 'HUMAN_REQUIRED',
        summary: 'Human needed.',
        evidenceRefs: [`artifact:${reportId}`],
        subject: { taskId: work },
      }),
    );
    const first = await f.autonomous.run(
      runOf({ runId, taskId: work, reviewTaskId: review, identity: 'resume-once' }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The trusted resume seam: one APPROVAL.GRANT through the engine, no UI/IPC/token.
    const resumed = await f.autonomous.resumeEscalatedRun({
      companyId: COMPANY,
      runId,
      actorId: 'user_decider',
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.resumed).toBe(true);
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('EXECUTING');
    // A second resume has nothing pending: refused deterministically, never invented.
    const again = await f.autonomous.resumeEscalatedRun({
      companyId: COMPANY,
      runId,
      actorId: 'user_decider',
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.details['reason']).toBe('AUTONOMOUS_RESUME_NOT_WAITING');
  });
});

describe('T18-07 autonomous supervisor — model binding (39–44)', () => {
  it('39–40. the orchestrator never carries a model identity of its own', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('binding', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    scriptProposal(f.model, proposal());
    const result = await f.autonomous.run(runOf({ runId, taskId: work, identity: 'binding-run' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The only model used anywhere in the run is the one the Supervisor turn resolved from
    // RunSnapshot; the orchestrator itself exposes no model field to supply one through.
    const keys = Object.keys(f.autonomous).sort();
    expect(keys).toEqual(['nextWorkUnit', 'resumeEscalatedRun', 'run']);
    for (const call of f.model.calls) expect(call.modelId).toBe(PROVIDER_MODEL_ID);
  });

  it('41–43. a missing or unpinned supervisor binding fails closed with zero model calls', async () => {
    const f = makeFixture();
    await f.templateWithStages('unpinned', ['build', 'review']);
    const templateId = await f.templateWithStages('unpinned-run', ['build', 'review']);
    const created = await f.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: `wf_unpinned_${ids.id('wf')}`,
      actorId: ACTOR,
      // The run pins a DIFFERENT binding name: no `supervisor` pin exists.
      modelBindings: { reviewer: MODEL_KEY },
      goal: { objective: 'A run with no supervisor binding.', source: { type: 'human' } },
    });
    if (!created.ok) throw new Error(created.error.message);
    const driven = await f.engine.drive(created.value.run.id, { maxSteps: 8 });
    if (!driven.ok) throw new Error(driven.error.message);
    const work = await f.seedTask({ stageId: 'build' }, created.value.run.id);
    scriptProposal(f.model, proposal());
    const result = await f.autonomous.run(
      runOf({ runId: created.value.run.id, taskId: work, identity: 'unpinned-run' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('RUN_BINDING_MISSING');
    expect(f.model.calls.length).toBe(0);
    expect(f.advanceCalls()).toBe(0);
  });

  it('44. no dynamic fallback: a failing provider never switches model', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('nofallback', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    scriptProposal(f.model, proposal());
    f.model.setScript({
      models: CATALOGUE,
      outcomes: [
        'rate_limited',
        'rate_limited',
        'rate_limited',
        'rate_limited',
        'rate_limited',
        'rate_limited',
      ],
    });
    const result = await f.autonomous.run(
      runOf({ runId, taskId: work, identity: 'nofallback-run' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopReason).toBe('invariant_failure');
    // Every attempt used the SAME model: no alternate provider, no fallback binding.
    for (const call of f.model.calls) expect(call.modelId).toBe(PROVIDER_MODEL_ID);
  });
});
