/**
 * Sprint 18 / Task-18-07 corrective — carrier, pinned binding, evidence lifecycle.
 *
 * The four blockers the Boss named, proven on the REAL durable layer and the REAL services:
 *   1. HANDLER_OUTPUT_CARRIER_CONTRACT_GAP — structured StageHandler outcome → Task.outputs
 *      → canonical ReviewFindingsSink / ValidationService (no prose parsing);
 *   2. GENERIC_AGENT_PINNED_MODEL_CONSUMER — the autonomous model path resolves the binding
 *      from RunSnapshot and exposes no model identity to override;
 *   3. EVIDENCE_TO_RUN_LIFECYCLE_GAP — canonical evidence implies one legal Run event,
 *      dispatched through the engine;
 *   4. DECISION_APPLICATION_CRASH_WINDOW — per-action idempotency with an injected checkpoint
 *      (in autonomous-supervisor.test.ts, items 36–40).
 *
 * Group map (the approved matrix): carrier 1–16, binding 17–25, lifecycle 26–35.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  STAGE_OUTPUT_SCHEMA,
  STAGE_OUTPUT_TASK_KEY,
  TOOL_CAPABILITY_VALIDATOR,
  createExecution,
  createTask,
  createToolRecord,
  createValidation,
  domainError,
  ok,
  type DomainError,
  type Result,
  type StageHandlerResult,
} from '@companyos/core';
import {
  REVIEW_CANDIDATE_KIND,
  VALIDATION_CANDIDATE_KIND,
  createAgentRuntime,
  createArtifactService,
  createCorrectiveProvisioner,
  createEvidenceLifecycleApplicator,
  createModelRegistry,
  createMockProvider,
  createPinnedAgentExecution,
  createProviderRegistry,
  createReviewFindingsSink,
  createRunGoalService,
  createRunModelBindingReader,
  createRunSnapshotVerifier,
  createSelectionPolicyService,
  createStageOutputCarrier,
  createSupervisorDecisionSink,
  createToolRegistry,
  createValidationService,
  createValidatorResolver,
  createWorkflowEngine,
  createWorkflowLifecycle,
  createMockTool,
  MOCK_TOOL_SPECS,
  type MockProvider,
} from '@companyos/engine';
import type { StageHandler, StageHandlerRegistry } from '@companyos/engine';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';

/* ------------------------------------------------------------------ harness */

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18carrier-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18C${String(++seq).padStart(12, '0')}`,
  ulid: () => `18C${String(++seq).padStart(23, '0')}`,
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
const BINDING_KEY = 'supervisor';
const PROVIDER_ID = 'prov_carrier';
const MODEL_KEY = 'carrier.model';
const PROVIDER_MODEL_ID = 'carrier-model-1';
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

let scriptedExecutionId = 'exc_seeded';

const reviewOutcome = (over: Readonly<Record<string, unknown>> = {}): StageHandlerResult => ({
  status: 'succeeded',
  output: {
    schemaVersion: STAGE_OUTPUT_SCHEMA,
    kind: REVIEW_CANDIDATE_KIND,
    executionId: scriptedExecutionId,
    artifactRefs: [],
    validationRefs: [],
    payload: {
      verdict: 'PASS',
      subjectTaskId: 'tsk_work',
      findings: [],
      ...over,
    },
  },
});

const qaOutcome = (over: Readonly<Record<string, unknown>> = {}): StageHandlerResult => ({
  status: 'succeeded',
  output: {
    schemaVersion: STAGE_OUTPUT_SCHEMA,
    kind: VALIDATION_CANDIDATE_KIND,
    executionId: scriptedExecutionId,
    artifactRefs: [],
    validationRefs: [],
    payload: {
      targetRef: 'artifact:art_seeded',
      validators: [{ validatorId: 'mock.unit_validator', blocking: true }],
      ...over,
    },
  },
});

interface Fixture {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly model: MockProvider;
  readonly carrier: ReturnType<typeof createStageOutputCarrier>;
  readonly evidence: ReturnType<typeof createEvidenceLifecycleApplicator>;
  /**
   * The run decision history the evidence applicator reads, so a test can show a verdict that
   * corrective work already consumed. Absent by default: the applicator then stays conservative
   * and re-applies what the durable evidence implies.
   */
  readonly decisions: {
    set(rows: readonly { readonly action: string; readonly evidenceRefs: readonly string[] }[]): void;
  };
  readonly pinned: ReturnType<typeof createPinnedAgentExecution>;
  readonly reviewSink: ReturnType<typeof createReviewFindingsSink>;
  readonly decisionSink: ReturnType<typeof createSupervisorDecisionSink>;
  readonly provisioner: ReturnType<typeof createCorrectiveProvisioner>;
  readonly engine: ReturnType<typeof createWorkflowEngine>;
  /** The execution the scripted review/QA handler claims (set after seeding it). */
  setScriptedExecution(executionId: string): void;
  readonly lifecycle: ReturnType<typeof createWorkflowLifecycle>;
  readonly models: ReturnType<typeof createModelRegistry>;
  templateWithStages(
    label: string,
    stageIds: readonly string[],
    options?: { readonly validators?: readonly string[] },
  ): Promise<string>;
  runAt(
    label: string,
    stageIds: readonly string[],
    options?: { readonly validators?: readonly string[] },
  ): Promise<{ readonly runId: string; readonly templateId: string }>;
  seedTask(
    input: {
      readonly stageId: string;
      readonly state?: string;
      readonly outputs?: Readonly<Record<string, unknown>>;
      readonly kind?: string;
    },
    runIdOverride?: string,
  ): Promise<string>;
  /** Seed a COMPLETED execution for a task, so a carrier write can verify its provenance. */
  seedExecution(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly executionId?: string;
  }): Promise<string>;
  seedArtifact(runId: string, label: string): Promise<string>;
  restart(): void;
}

const makeFixture = (): Fixture => {
  const dataDir = tempDir();
  const casRoot = tempDir();
  let db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  const authorize = async (): Promise<Result<true, DomainError>> => ok(true as const);
  const model = createMockProvider({
    providerId: PROVIDER_ID,
    kind: 'fake',
    displayName: 'Carrier model',
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
    const policies = createSelectionPolicyService({
      ids,
      clock,
      policies: database.selectionPolicies,
      results: database.benchmarkResults,
      readRecords: async () => models.list({ includeDisabled: true }),
      events: database.events,
    });
    const toolAdapters = new Map<string, never>();
    for (const spec of MOCK_TOOL_SPECS)
      toolAdapters.set(spec.toolId, createMockTool(spec, clock) as never);
    const tools = createToolRegistry({
      ids,
      clock,
      records: database.toolRecords,
      invocations: database.toolInvocations,
      invocationArtifacts: database.toolInvocationArtifacts,
      adapters: toolAdapters as never,
      authorize: authorize as never,
      events: database.events,
    });
    // A real validator tool record, so the canonical ValidationService can run a QA plan.
    // Built through the Core `createToolRecord` factory (no mock-only helper), exactly like
    // the T17 validator record is built.
    const validatorRecord = createToolRecord({
      toolId: 'mock.unit_validator',
      name: 'unit',
      description: 'unit validator',
      version: '1.0.0',
      capabilities: [TOOL_CAPABILITY_VALIDATOR],
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      outputSchema: { type: 'object', properties: {}, additionalProperties: true },
      riskLevel: 'LOW',
      requiredAuthorities: ['tool.invoke'],
      idempotencyMode: 'IDEMPOTENT_KEY',
      adapterRef: 'mock.unit_validator',
      now: clock.nowIso(),
    });
    if (!validatorRecord.ok) throw new Error(validatorRecord.error.message);
    // The adapter answers with a durable PASS verdict (deterministic, no network).
    toolAdapters.set('mock.unit_validator', {
      describe: () => ({ toolId: 'mock.unit_validator', version: '1.0.0' }),
      async invoke() {
        return ok({ status: 'COMPLETED', output: { verdict: 'pass' } });
      },
    } as never);
    deferredValidator = { tools, record: validatorRecord.value };
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
      authorize: authorize as never,
      unitOfWork: database.unitOfWork,
      clock,
      ids,
    });
    const reviewSink = createReviewFindingsSink({
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
          if (ref.startsWith('val_')) {
            const row = await database.validationStore!.get(ref as never);
            if (row === null)
              return { ok: false as const, error: domainError('NOT_FOUND', `missing ${ref}`) };
            anchored.push({ kind: 'validation', id: row.id, ref, runId: row.runId });
            continue;
          }
          const id = ref.startsWith('artifact:') ? ref.slice('artifact:'.length) : ref;
          const row = await database.artifactStore!.get(id as never);
          if (row === null)
            return { ok: false as const, error: domainError('NOT_FOUND', `missing ${ref}`) };
          anchored.push({ kind: 'artifact', id: row.id, ref, runId: row.runId });
        }
        return { ok: true as const, value: anchored };
      },
      unitOfWork: database.unitOfWork,
      clock,
      ids,
    });
    const validationService = createValidationService({
      resolver: createValidatorResolver({ registry: tools }),
      registry: tools,
      validationStore: database.validationStore!,
      artifactService: artifacts,
      artifactStore: database.artifactStore!,
      events: database.events,
      ledger: database.ledger,
      clock,
      ids,
      unitOfWork: database.unitOfWork,
      authorize: authorize as never,
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
    const carrier = createStageOutputCarrier({
      tasks: database.tasks,
      executions: database.agentExecutions,
      reviewSink: {
        record: (command) =>
          reviewSink
            .record({
              ...command,
              reviewStageId: command.reviewStageId as never,
              reviewTaskId: command.reviewTaskId as never,
              subjectTaskId: command.subjectTaskId as never,
            })
            .then((result) =>
              result.ok
                ? { ok: true as const, value: { artifactId: result.value.artifactId } }
                : { ok: false as const, error: result.error },
            ),
      },
      validationService,
      clock,
      ids,
    });
    const handlers: StageHandlerRegistry = {
      resolve: (kind: string): StageHandler | null => {
        if (kind === 'pack-a:review') {
          return {
            id: 'scripted:review',
            execute: (): StageHandlerResult => reviewOutcome(),
          };
        }
        if (kind === 'pack-a:qa') {
          return { id: 'scripted:qa', execute: (): StageHandlerResult => qaOutcome() };
        }
        return { id: `scripted:${kind}`, execute: (): 'succeeded' => 'succeeded' };
      },
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
    let runDecisions: readonly {
      readonly action: string;
      readonly evidenceRefs: readonly string[];
    }[] = [];
    const evidence = createEvidenceLifecycleApplicator({
      runs: database.runs,
      engine,
      readers: {
        getLatestReviewReport: ({ companyId, runId, reviewTaskId, actorId }) =>
          reviewSink
            .getLatestReviewReport({ companyId, runId, reviewTaskId, actorId })
            .then((result) =>
              result.ok
                ? {
                    ok: true as const,
                    value:
                      result.value === null
                        ? null
                        : {
                            verdict: result.value.payload.verdict,
                            artifactId: result.value.artifactId,
                            createdAt: result.value.createdAt,
                          },
                  }
                : { ok: false as const, error: result.error },
            ),        listValidations: (runId: string) =>
          database.validationStore!.listByRun(runId as never).then((rows) =>
            rows.map((row) => ({
              id: row.id,
              validatorId: row.validatorId,
              status: row.status,
              stageId: row.stageId as string | null,
              targetRef: (row.targetRef ?? null) as string | null,
            })),
          ),
        requiredValidators: async ({ runId, stageId }) => {
          const run = await database.runs.get(runId as never);
          if (run === null)
            return { ok: false as const, error: domainError('NOT_FOUND', 'run missing') };
          const template = await database.templates.get(String(run.templateId) as never);
          const version = template?.versions.find((entry) => entry.id === run.versionId);
          if (version === undefined)
            return { ok: false as const, error: domainError('NOT_FOUND', 'version missing') };
          const node = version.graph.nodes.find((entry) => entry.id === stageId);
          if (node === undefined) return { ok: true as const, value: [] as readonly string[] };
          return {
            ok: true as const,
            value: [...((node.config['validatorIds'] as string[]) ?? [])],
          };
        },
        // Empty until a test installs a history: the applicator's own "no decision cites this
        // report" default is what the other lifecycle tests exercise.
        listRunDecisions: () => Promise.resolve({ ok: true as const, value: runDecisions }),
      },
      clock,
      ids,
    });
    const pinned = createPinnedAgentExecution({
      runs: database.runs,
      modelBindings: bindingReader,
      modelRegistry: models,
      agentRuntime,
      bindingKey: BINDING_KEY,
      clock,
    });
    const provisioner = createCorrectiveProvisioner({
      runs: database.runs,
      tasks: database.tasks,
      templates: database.templates,
      decisions: database.decisions!,
      artifacts: database.artifactStore!,
      content: { get: (contentRef: string) => contentStore.get(contentRef) },
      runSnapshot: snapshotVerifier,
      reviewReports: {
        latestReviewReport: ({ companyId, runId, reviewTaskId, actorId }) =>
          reviewSink
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
      maxCorrectiveRounds: 3,
    });
    registries = { providers, models };
    return {
      artifacts,
      lifecycle,
      models,
      decisionSink,
      reviewSink,
      validationService,
      carrier,
      evidence,
      decisions: {
        set: (
          rows: readonly { readonly action: string; readonly evidenceRefs: readonly string[] }[],
        ) => {
          runDecisions = rows;
        },
      },
      pinned,
      provisioner,
      engine,
      agentRuntime,
    };
  };

  let registries: {
    providers: ReturnType<typeof createProviderRegistry>;
    models: ReturnType<typeof createModelRegistry>;
  };
  /** The validator record is registered on the first async step (the build itself is sync). */
  let deferredValidator: {
    tools: ReturnType<typeof createToolRegistry>;
    record: Parameters<ReturnType<typeof createToolRegistry>['register']>[0];
  } | null = null;
  let built = build(db);
  const registerProvider = async (): Promise<void> => {
    // The canonical validator tool, so the QA carrier can run a real validation plan.
    const pending = deferredValidator;
    deferredValidator = null;
    if (pending !== null) {
      const done = await pending.tools.register(pending.record, { actorId: ACTOR });
      if (!done.ok && done.error.code !== 'CONFLICT') throw new Error(done.error.message);
    }
    const providers = providerRegistry();
    const done = await providers.register(model, { actorId: ACTOR });
    if (!done.ok && done.error.code !== 'CONFLICT') throw new Error(done.error.message);
    const models = modelRegistry();
    const made = await models.registerFromProvider({
      providerId: PROVIDER_ID,
      providerModelId: PROVIDER_MODEL_ID,
      modelKey: MODEL_KEY,
      actorId: ACTOR,
    });
    if (!made.ok && made.error.code !== 'CONFLICT') throw new Error(made.error.message);
  };
  const providerRegistry = () => registries.providers;
  const modelRegistry = () => registries.models;

  let lastRunId: string | null = null;
  return {
    get db() {
      return db;
    },
    dataDir,
    casRoot,
    model,
    get carrier() {
      return built.carrier;
    },
    get evidence() {
      return built.evidence;
    },
    get decisions() {
      return built.decisions;
    },
    get pinned() {
      return built.pinned;
    },
    get reviewSink() {
      return built.reviewSink;
    },
    get decisionSink() {
      return built.decisionSink;
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
    get models() {
      return built.models;
    },
    setScriptedExecution(executionId: string): void {
      scriptedExecutionId = executionId;
    },
    async templateWithStages(label, stageIds, options = {}) {
      await registerProvider();
      const template = await built.lifecycle.createTemplate({
        orgId: COMPANY,
        name: `Carrier ${label}`,
        actorId: ACTOR,
        traceId: `t18c_tpl_${label}`,
      });
      if (!template.ok) throw new Error(template.error.message);
      const graph = {
        nodes: stageIds.map((id) => ({
          id,
          kind: 'work' as const,
          title: id,
          config: options.validators === undefined ? {} : { validatorIds: [...options.validators] },
        })),
        edges: stageIds.slice(1).map((id, index) => ({ from: stageIds[index]!, to: id })),
      };
      const saved = await built.lifecycle.saveDraftGraph({
        templateId: template.value.id,
        graph,
        actorId: ACTOR,
        traceId: `t18c_graph_${label}`,
      });
      if (!saved.ok) throw new Error(saved.error.message);
      const published = await built.lifecycle.publish({
        templateId: template.value.id,
        actorId: ACTOR,
        traceId: `t18c_pub_${label}`,
      });
      if (!published.ok) throw new Error(published.error.message);
      return template.value.id;
    },
    async runAt(label, stageIds, options = {}) {
      const templateId = await this.templateWithStages(label, stageIds, options);
      const run = await built.lifecycle.createRun({
        templateId,
        companyId: COMPANY,
        workflowId: `wf_${label}`,
        actorId: ACTOR,
        modelBindings: { [BINDING_KEY]: MODEL_KEY },
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
      });
      if (!task.ok) throw new Error(task.error.message);
      const seeded =
        input.state === undefined && input.outputs === undefined
          ? task.value
          : {
              ...task.value,
              ...(input.state === undefined ? {} : { state: input.state as never }),
              ...(input.outputs === undefined ? {} : { outputs: input.outputs }),
            };
      await db.tasks.put(seeded);
      return task.value.id;
    },
    async seedExecution(input) {
      const executionId = input.executionId ?? ids.id('exc');
      const made = await createExecution({
        executionId,
        agentId: 'agent_reviewer',
        roleId: 'rol_reviewer' as never,
        taskId: input.taskId as never,
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
      return made.value.executionId;
    },
    async seedArtifact(runId, label) {
      const artifacts = (
        built as unknown as {
          artifacts: { create(command: unknown): Promise<Result<{ id: string }, DomainError>> };
        }
      ).artifacts;
      const made = await artifacts.create({
        commandId: `t18c-artifact:${label}`,
        runId: runId as never,
        taskId: null,
        kind: 'companyos:evidence',
        content: new TextEncoder().encode(JSON.stringify({ label })),
        producedBy: ACTOR,
        traceId: ids.id('trace'),
      });
      if (!made.ok) throw new Error(made.error.message);
      return made.value.id;
    },
    restart() {
      db.close();
      const tracked = openDatabases.indexOf(db);
      if (tracked >= 0) openDatabases.splice(tracked, 1);
      db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
      openDatabases.push(db);
      built = build(db);
    },
  };
};

const reviewArtifacts = (f: Fixture): number =>
  Number(
    (
      f.db.db
        .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:review-findings'")
        .get() as { c: number | bigint }
    ).c,
  );

/* ================================================================================ */

describe('T18-07 corrective — reviewer/QA carrier (1–16)', () => {
  it('1. a legacy bare-status handler still normalizes and runs', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('legacy', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const advanced = await f.engine.advance({
      runId: runId as never,
      stageId: 'build' as never,
      taskIds: [work] as never,
      snapshot: {
        snapshotId: (await f.db.snapshots.get(
          (await f.db.runs.get(runId as never))!.snapshotId as never,
        ))!.snapshotId as never,
        snapshotHash: '0'.repeat(64) as never,
      },
    });
    expect(advanced.outcome).toBe('completed');
    const stored = await f.db.tasks.get(work as never);
    expect(stored?.state).toBe('DONE');
  });

  it('2–3. a structured handler outcome persists on Task.outputs and survives restart', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('persist', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build', kind: 'pack-a:review' });
    const executionId = await f.seedExecution({ runId, taskId: work });
    f.setScriptedExecution(executionId);
    const advanced = await f.engine.advance({
      runId: runId as never,
      stageId: 'build' as never,
      taskIds: [work] as never,
      snapshot: {
        snapshotId: (await f.db.snapshots.get(
          (await f.db.runs.get(runId as never))!.snapshotId as never,
        ))!.snapshotId as never,
        snapshotHash: '0'.repeat(64) as never,
      },
    });
    expect(advanced.outcome).toBe('completed');
    const stored = await f.db.tasks.get(work as never);
    const envelope = stored?.outputs[STAGE_OUTPUT_TASK_KEY] as Record<string, unknown> | undefined;
    expect(envelope).toBeDefined();
    expect(envelope?.['schemaVersion']).toBe(STAGE_OUTPUT_SCHEMA);
    expect(envelope?.['executionId']).toBe(executionId);
    f.restart();
    const after = await f.db.tasks.get(work as never);
    expect(
      (after?.outputs[STAGE_OUTPUT_TASK_KEY] as Record<string, unknown>)?.['executionId'],
    ).toBe(executionId);
  });

  it('4. Reviewer output routes into ReviewFindingsSink and creates the canonical artifact', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('route', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review', kind: 'pack-a:review' });
    const executionId = await f.seedExecution({ runId, taskId: review });
    await f.db.tasks.put({
      ...(await f.db.tasks.get(review as never))!,
      outputs: {
        [STAGE_OUTPUT_TASK_KEY]: {
          schemaVersion: STAGE_OUTPUT_SCHEMA,
          kind: REVIEW_CANDIDATE_KIND,
          executionId,
          artifactRefs: [],
          validationRefs: [],
          payload: {
            verdict: 'CHANGES_REQUESTED',
            subjectTaskId: work,
            findings: [
              {
                code: 'semantic.boundary',
                summary: 'Crosses a frozen boundary.',
                detail: 'detail',
                blocking: true,
              },
            ],
          },
        },
      },
    });
    const routed = await f.carrier.routeTask({
      companyId: COMPANY,
      runId,
      taskId: review,
      actorId: ACTOR,
    });
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value?.kind).toBe(REVIEW_CANDIDATE_KIND);
    expect(routed.value?.refs[0]?.startsWith('artifact:art_')).toBe(true);
    expect(reviewArtifacts(f)).toBe(1);
    const report = await f.reviewSink.getLatestReviewReport({
      companyId: COMPANY,
      runId,
      reviewTaskId: review,
      actorId: ACTOR,
    });
    expect(report.ok).toBe(true);
    if (!report.ok || report.value === null) return;
    expect(report.value.payload.verdict).toBe('CHANGES_REQUESTED');
    expect(report.value.payload.subjectTaskId).toBe(work);
  });

  it('5. the reviewer executionId cannot be spoofed', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('spoof', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review', kind: 'pack-a:review' });
    await f.db.tasks.put({
      ...(await f.db.tasks.get(review as never))!,
      outputs: {
        [STAGE_OUTPUT_TASK_KEY]: {
          schemaVersion: STAGE_OUTPUT_SCHEMA,
          kind: REVIEW_CANDIDATE_KIND,
          executionId: 'exc_does_not_exist',
          artifactRefs: [],
          validationRefs: [],
          payload: { verdict: 'PASS', subjectTaskId: work, findings: [] },
        },
      },
    });
    const routed = await f.carrier.routeTask({
      companyId: COMPANY,
      runId,
      taskId: review,
      actorId: ACTOR,
    });
    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.error.details['reason']).toBe('STAGE_OUTPUT_EXECUTION_MISSING');
    expect(reviewArtifacts(f)).toBe(0);
  });

  it('6. an execution from another task cannot carry the review', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('mismatch', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review', kind: 'pack-a:review' });
    const other = await f.seedExecution({ runId, taskId: work });
    await f.db.tasks.put({
      ...(await f.db.tasks.get(review as never))!,
      outputs: {
        [STAGE_OUTPUT_TASK_KEY]: {
          schemaVersion: STAGE_OUTPUT_SCHEMA,
          kind: REVIEW_CANDIDATE_KIND,
          executionId: other,
          artifactRefs: [],
          validationRefs: [],
          payload: { verdict: 'PASS', subjectTaskId: work, findings: [] },
        },
      },
    });
    const routed = await f.carrier.routeTask({
      companyId: COMPANY,
      runId,
      taskId: review,
      actorId: ACTOR,
    });
    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.error.details['reason']).toBe('STAGE_OUTPUT_EXECUTION_TASK_MISMATCH');
    expect(reviewArtifacts(f)).toBe(0);
  });

  it('7–9. PASS, CHANGES_REQUESTED and BLOCKED keep their exact semantics', async () => {
    for (const verdict of ['PASS', 'CHANGES_REQUESTED', 'BLOCKED'] as const) {
      const f = makeFixture();
      const { runId } = await f.runAt(verdict.toLowerCase(), ['build', 'review']);
      const work = await f.seedTask({ stageId: 'build' });
      const review = await f.seedTask({ stageId: 'review', kind: 'pack-a:review' });
      const executionId = await f.seedExecution({ runId, taskId: review });
      await f.db.tasks.put({
        ...(await f.db.tasks.get(review as never))!,
        outputs: {
          [STAGE_OUTPUT_TASK_KEY]: {
            schemaVersion: STAGE_OUTPUT_SCHEMA,
            kind: REVIEW_CANDIDATE_KIND,
            executionId,
            artifactRefs: [],
            validationRefs: [],
            payload: {
              verdict,
              subjectTaskId: work,
              findings:
                verdict === 'CHANGES_REQUESTED'
                  ? [{ code: 'a.b', summary: 'A finding.', detail: 'detail', blocking: true }]
                  : [],
            },
          },
        },
      });
      const routed = await f.carrier.routeTask({
        companyId: COMPANY,
        runId,
        taskId: review,
        actorId: ACTOR,
      });
      // BLOCKED without a blocker finding is refused by the sink's own rules (unchanged).
      const expected = verdict === 'BLOCKED' ? false : true;
      expect(routed.ok).toBe(expected);
      if (!expected) continue;
      const report = await f.reviewSink.getLatestReviewReport({
        companyId: COMPANY,
        runId,
        reviewTaskId: review,
        actorId: ACTOR,
      });
      if (!report.ok || report.value === null) throw new Error('no report');
      expect(report.value.payload.verdict).toBe(verdict);
    }
  });

  it('10. no prose parsing: an unstructured payload is refused', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('prose', ['build', 'review']);

    const review = await f.seedTask({ stageId: 'review', kind: 'pack-a:review' });
    const executionId = await f.seedExecution({ runId, taskId: review });
    await f.db.tasks.put({
      ...(await f.db.tasks.get(review as never))!,
      outputs: {
        [STAGE_OUTPUT_TASK_KEY]: {
          schemaVersion: STAGE_OUTPUT_SCHEMA,
          kind: REVIEW_CANDIDATE_KIND,
          executionId,
          artifactRefs: [],
          validationRefs: [],
          // The handler answered in prose instead of the structured contract.
          payload: { note: 'I think this looks like a PASS to me.' },
        },
      },
    });
    const routed = await f.carrier.routeTask({
      companyId: COMPANY,
      runId,
      taskId: review,
      actorId: ACTOR,
    });
    expect(routed.ok).toBe(false);
    expect(reviewArtifacts(f)).toBe(0);
  });

  it('11–13. QA output routes into the canonical ValidationService', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('qa', ['build', 'review'], {
      validators: ['mock.unit_validator'],
    });

    const targetId = await f.seedArtifact(runId, 'qa-target');
    const qa = await f.seedTask({ stageId: 'review', kind: 'pack-a:qa' });
    const executionId = await f.seedExecution({ runId, taskId: qa });
    f.setScriptedExecution(executionId);
    await f.db.tasks.put({
      ...(await f.db.tasks.get(qa as never))!,
      outputs: {
        [STAGE_OUTPUT_TASK_KEY]: {
          schemaVersion: STAGE_OUTPUT_SCHEMA,
          kind: VALIDATION_CANDIDATE_KIND,
          executionId,
          artifactRefs: [],
          validationRefs: [],
          payload: {
            targetRef: `artifact:${targetId}`,
            validators: [{ validatorId: 'mock.unit_validator', blocking: true }],
          },
        },
      },
    });
    const routed = await f.carrier.routeTask({
      companyId: COMPANY,
      runId,
      taskId: qa,
      actorId: ACTOR,
    });

    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.value?.kind).toBe(VALIDATION_CANDIDATE_KIND);
    expect(routed.value?.refs.length).toBeGreaterThanOrEqual(1);
    // The rows live in the ONE canonical validation store, anchored to the durable artifact.
    const rows = await f.db.validationStore!.listByRun(runId as never);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.targetRef).toBe(`artifact:${targetId}`);
    expect(rows[0]?.validatorId).toBe('mock.unit_validator');
  });

  it('14–15. a duplicate carrier replay creates no second Review artifact or Validation row', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('dup', ['build', 'review'], {
      validators: ['mock.unit_validator'],
    });
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review', kind: 'pack-a:review' });
    const executionId = await f.seedExecution({ runId, taskId: review });
    const envelope = {
      schemaVersion: STAGE_OUTPUT_SCHEMA,
      kind: REVIEW_CANDIDATE_KIND,
      executionId,
      artifactRefs: [],
      validationRefs: [],
      payload: {
        verdict: 'CHANGES_REQUESTED',
        subjectTaskId: work,
        findings: [{ code: 'a.b', summary: 'A finding.', detail: 'detail', blocking: true }],
      },
    };
    await f.db.tasks.put({
      ...(await f.db.tasks.get(review as never))!,
      outputs: { [STAGE_OUTPUT_TASK_KEY]: envelope },
    });
    const first = await f.carrier.routeTask({
      companyId: COMPANY,
      runId,
      taskId: review,
      actorId: ACTOR,
    });
    expect(first.ok).toBe(true);
    const afterFirst = reviewArtifacts(f);
    const second = await f.carrier.routeTask({
      companyId: COMPANY,
      runId,
      taskId: review,
      actorId: ACTOR,
    });
    expect(second.ok).toBe(true);
    // The sink's own permanent identity means the replay lands on the SAME artifact.
    expect(reviewArtifacts(f)).toBe(afterFirst);
  });

  it('16. after restart the task still names the exact canonical output', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('restart-carrier', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review', kind: 'pack-a:review' });
    const executionId = await f.seedExecution({ runId, taskId: review });
    await f.db.tasks.put({
      ...(await f.db.tasks.get(review as never))!,
      outputs: {
        [STAGE_OUTPUT_TASK_KEY]: {
          schemaVersion: STAGE_OUTPUT_SCHEMA,
          kind: REVIEW_CANDIDATE_KIND,
          executionId,
          artifactRefs: [],
          validationRefs: [],
          payload: { verdict: 'PASS', subjectTaskId: work, findings: [] },
        },
      },
    });
    const first = await f.carrier.routeTask({
      companyId: COMPANY,
      runId,
      taskId: review,
      actorId: ACTOR,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const artifactId = first.value?.refs[0]?.replace('artifact:', '') ?? '';
    f.restart();
    const after = await f.db.tasks.get(review as never);
    expect(
      (after?.outputs[STAGE_OUTPUT_TASK_KEY] as Record<string, unknown> | undefined)?.[
        'executionId'
      ],
    ).toBe(executionId);
    // The canonical artifact is still exactly the one produced before the restart.
    const still = await f.db.artifactStore!.get(artifactId as never);
    expect(still?.id).toBe(artifactId);
    expect(reviewArtifacts(f)).toBe(1);
  });
});

describe('T18-07 corrective — pinned model binding (17–25)', () => {
  it('17. an autonomous execution resolves the run-pinned binding', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('binding', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const bound = await f.pinned.resolveBinding({ companyId: COMPANY, runId });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.value.modelKey).toBe(MODEL_KEY);
    expect(bound.value.providerId).toBe(PROVIDER_ID);
    const round = await f.pinned.runRound({
      companyId: COMPANY,
      runId,
      taskId: work,
      agentId: 'agent_worker',
      roleId: 'rol_1' as never,
      actorId: ACTOR,
      context: {
        company: { id: COMPANY, label: COMPANY },
        workflow: { id: 'wf_binding', label: 'wf' },
        workflowVersion: 'wf_binding@1',
        workflowRun: { id: runId, label: 'run' },
        stage: { id: 'build', label: 'stage' },
        task: { id: work, label: 'task' },
        role: { id: 'rol_1', label: 'role' },
        objective: 'Do the work.',
      },
    });
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(f.model.calls[0]?.modelId).toBe(PROVIDER_MODEL_ID);
  });

  it('18–19. the wrapper exposes no model identity to override', async () => {
    const f = makeFixture();
    await f.runAt('noidentity', ['build', 'review']);
    // The method surface names no model parameter at all — there is nothing to override.
    // (The T19-03 closeout added the residue-first round; it is model-blind the same way:
    // every method's parameters are (input[, persistResidue]) — never a model identity.)
    expect(Object.keys(f.pinned).sort()).toEqual([
      'resolveBinding',
      'runRound',
      'runRoundResidueFirst',
    ]);
    expect((f.pinned.runRound as (...args: unknown[]) => unknown).length).toBe(1);
    expect((f.pinned.runRoundResidueFirst as (...args: unknown[]) => unknown).length).toBe(2);
  });

  it('20–22. a caller-supplied modelKey cannot reach the autonomous path', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('override', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    // Even a caller that TRIES to smuggle a model identity in cannot: the input type has no
    // such field, and the object is resolved through the run's pin.
    const smuggled = {
      companyId: COMPANY,
      runId,
      taskId: work,
      agentId: 'agent_worker',
      roleId: 'rol_1' as never,
      actorId: ACTOR,
      modelKey: 'some.other.model',
      providerId: 'prov_evil',
      context: {
        company: { id: COMPANY, label: COMPANY },
        workflow: { id: 'wf_override', label: 'wf' },
        workflowVersion: 'wf_override@1',
        workflowRun: { id: runId, label: 'run' },
        stage: { id: 'build', label: 'stage' },
        task: { id: work, label: 'task' },
        role: { id: 'rol_1', label: 'role' },
        objective: 'Do the work.',
      },
    };
    const round = await f.pinned.runRound(smuggled as never);
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(f.model.calls[0]?.modelId).toBe(PROVIDER_MODEL_ID);
  });

  it('23. a missing pinned binding fails closed with zero provider calls', async () => {
    const f = makeFixture();
    const templateId = await f.templateWithStages('unpinned', ['build', 'review']);
    const created = await createRunWithOtherBinding(f, templateId);
    const work = await f.seedTask({ stageId: 'build' }, created);
    const bound = await f.pinned.resolveBinding({ companyId: COMPANY, runId: created });
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.error.details['reason']).toBe('RUN_BINDING_MISSING');
    const round = await f.pinned.runRound({
      companyId: COMPANY,
      runId: created,
      taskId: work,
      agentId: 'agent_worker',
      roleId: 'rol_1' as never,
      actorId: ACTOR,
      context: {
        company: { id: COMPANY, label: COMPANY },
        workflow: { id: 'wf_unpinned', label: 'wf' },
        workflowVersion: 'wf_unpinned@1',
        workflowRun: { id: created, label: 'run' },
        stage: { id: 'build', label: 'stage' },
        task: { id: work, label: 'task' },
        role: { id: 'rol_1', label: 'role' },
        objective: 'Do the work.',
      },
    });
    expect(round.ok).toBe(false);
    expect(f.model.calls.length).toBe(0);
  });

  it('24. a disabled pinned binding fails closed with zero provider calls', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('disabled', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    // Disable the pinned model through the real registry.
    const models = f.models;
    const changed = await models.setEnabled(MODEL_KEY, false, ACTOR);
    if (!changed.ok) throw new Error(changed.error.message);
    const bound = await f.pinned.resolveBinding({ companyId: COMPANY, runId });
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.error.details['reason']).toBe('RUN_BINDING_UNUSABLE');
    const round = await f.pinned.runRound({
      companyId: COMPANY,
      runId,
      taskId: work,
      agentId: 'agent_worker',
      roleId: 'rol_1' as never,
      actorId: ACTOR,
      context: {
        company: { id: COMPANY, label: COMPANY },
        workflow: { id: 'wf_disabled', label: 'wf' },
        workflowVersion: 'wf_disabled@1',
        workflowRun: { id: runId, label: 'run' },
        stage: { id: 'build', label: 'stage' },
        task: { id: work, label: 'task' },
        role: { id: 'rol_1', label: 'role' },
        objective: 'Do the work.',
      },
    });
    expect(round.ok).toBe(false);
    expect(f.model.calls.length).toBe(0);
  });

  it('25. no dynamic fallback: a failing provider keeps the same model', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('nofallback', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
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
    const round = await f.pinned.runRound({
      companyId: COMPANY,
      runId,
      taskId: work,
      agentId: 'agent_worker',
      roleId: 'rol_1' as never,
      actorId: ACTOR,
      context: {
        company: { id: COMPANY, label: COMPANY },
        workflow: { id: 'wf_nofallback', label: 'wf' },
        workflowVersion: 'wf_nofallback@1',
        workflowRun: { id: runId, label: 'run' },
        stage: { id: 'build', label: 'stage' },
        task: { id: work, label: 'task' },
        role: { id: 'rol_1', label: 'role' },
        objective: 'Do the work.',
      },
    });
    expect(round.ok).toBe(false);
    for (const call of f.model.calls) expect(call.modelId).toBe(PROVIDER_MODEL_ID);
  });
});

describe('T18-07 corrective — evidence to run lifecycle (26–35)', () => {
  const seedReviewVerdict = async (
    f: Fixture,
    input: {
      readonly runId: string;
      readonly reviewTaskId: string;
      readonly subjectTaskId: string;
      readonly verdict: 'PASS' | 'CHANGES_REQUESTED';
    },
  ): Promise<string> => {
    const executionId = await f.seedExecution({ runId: input.runId, taskId: input.reviewTaskId });

    const recorded = await f.reviewSink.record({
      companyId: COMPANY,
      runId: input.runId,
      reviewStageId: 'review',
      reviewTaskId: input.reviewTaskId,
      subjectTaskId: input.subjectTaskId,
      executionId,
      verdict: input.verdict,
      findings:
        input.verdict === 'PASS'
          ? []
          : [{ code: 'a.b', summary: 'A finding.', detail: 'detail', blocking: true }],
      decidedBy: ACTOR,
    });
    if (!recorded.ok) throw new Error(recorded.error.message);
    return recorded.value.artifactId;
  };

  it('26–27–28. canonical Review implies the legal Run event; CHANGES never enters validation', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('review-events', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    await seedReviewVerdict(f, {
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    // REVIEWING is entered by the engine's own EXECUTION.COMPLETE (work finished); the event
    // under test is the one the evidence implies, not this one.
    await driveExecutingToReviewing(f, runId);
    const applied = await f.evidence.applyEvidence({
      companyId: COMPANY,
      runId,
      reviewTaskId: review,
      actorId: ACTOR,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value?.event).toBe('REVIEW.REJECT');
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('REWORK');

    // A later PASS advances legally.
    const review2 = await f.seedTask({ stageId: 'review' });
    await seedReviewVerdict(f, {
      runId,
      reviewTaskId: review2,
      subjectTaskId: work,
      verdict: 'PASS',
    });
    const after = await f.evidence.applyEvidence({
      companyId: COMPANY,
      runId,
      reviewTaskId: review2,
      actorId: ACTOR,
    });
    // REVIEWING is required for the event; from REWORK nothing is invented.
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value).toBeNull();
  });

  it('30. canonical Validation PASS implies the legal Run event', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('val-pass', ['build', 'review'], {
      validators: ['mock.unit_validator'],
    });

    const targetId = await f.seedArtifact(runId, 'val-target');
    const made = await createValidation({
      runId: runId as never,
      validatorId: 'mock.unit_validator',
      validatorVersion: '1.0.0',
      status: 'pass',
      blocking: true,
      exitCode: 0,
      startedAt: nowIso(),
      finishedAt: nowIso(),
      stageId: 'build' as never,
      targetRef: `artifact:${targetId}` as never,
      ids,
    });
    if (!made.ok) throw new Error(made.error.message);
    await f.db.validationStore!.record(made.value, {
      creationCommandId: `cmd_v_${ids.id('v')}`,
      creationCommandFingerprint: 'fp:seed',
    });
    // Move the run to VALIDATING through its own legal commands.
    await driveExecutingToReviewing(f, runId);
    await driveReviewingToValidating(f, runId);
    const applied = await f.evidence.applyEvidence({ companyId: COMPANY, runId, actorId: ACTOR });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value?.event).toBe('VALIDATION.PASS');
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('FINALIZING');
  });

  it('31–33. a failed latest validation never finalizes and beats an older PASS', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('val-fail', ['build', 'review'], {
      validators: ['mock.unit_validator'],
    });
    const targetId = await f.seedArtifact(runId, 'val-fail-target');
    const seed = async (status: 'pass' | 'fail'): Promise<void> => {
      const made = await createValidation({
        runId: runId as never,
        validatorId: 'mock.unit_validator',
        validatorVersion: '1.0.0',
        status,
        blocking: true,
        exitCode: status === 'pass' ? 0 : 1,
        startedAt: nowIso(),
        finishedAt: nowIso(),
        stageId: 'build' as never,
        targetRef: `artifact:${targetId}` as never,
        ids,
      });
      if (!made.ok) throw new Error(made.error.message);
      await f.db.validationStore!.record(made.value, {
        creationCommandId: `cmd_v_${ids.id('v')}`,
        creationCommandFingerprint: 'fp:seed',
      });
    };
    await seed('pass');
    await seed('fail');
    await driveExecutingToReviewing(f, runId);
    await driveReviewingToValidating(f, runId);
    const applied = await f.evidence.applyEvidence({ companyId: COMPANY, runId, actorId: ACTOR });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // The NEWEST failure wins: the run goes to REWORK, never FINALIZING.
    expect(applied.value?.event).toBe('VALIDATION.FAIL');
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('REWORK');
  });

  it('34–35. no direct Run state write and no model-driven lifecycle event', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('nodirect', ['build', 'review']);
    const before = await f.db.runs.get(runId as never);
    // The applicator with no canonical evidence at all applies nothing.
    const applied = await f.evidence.applyEvidence({ companyId: COMPANY, runId, actorId: ACTOR });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value).toBeNull();
    const after = await f.db.runs.get(runId as never);
    expect(after?.state).toBe(before?.state);
    expect(after?.revision).toBe(before?.revision);
    // And the engine is the only writer: no SQL UPDATE against runs exists in the applicator.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('packages/engine/src/supervisor/evidence-lifecycle.ts', 'utf8'),
    );
    expect(source).not.toMatch(/UPDATE\s+runs/i);
    expect(source).not.toContain('INSERT INTO runs');
  });

  it('36. a verdict a REQUEST_CORRECTIVE already consumed is not re-applied', async () => {
    const f = makeFixture();
    const { runId } = await f.runAt('consumed', ['build', 'review']);
    const work = await f.seedTask({ stageId: 'build' });
    const review = await f.seedTask({ stageId: 'review' });
    const reportId = await seedReviewVerdict(f, {
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    await driveExecutingToReviewing(f, runId);
    // First application: the canonical verdict implies the rework event.
    const first = await f.evidence.applyEvidence({
      companyId: COMPANY,
      runId,
      reviewTaskId: review,
      actorId: ACTOR,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value?.event).toBe('REVIEW.REJECT');
    /*
     * The run returns to REVIEWING through the frozen machine's own EXECUTION.COMPLETE after the
     * corrective round, and the SAME report is still the latest one. Without the decision history
     * the applicator would re-apply the verdict and discard the finished corrective work.
     */
    const back = await f.engine.dispatch({
      commandId: `t18c-back:${runId}:REWORK.READY`,
      runId,
      type: 'REWORK.READY',
      expectedRevision: (await f.db.runs.get(runId as never))?.revision ?? 0,
      actorId: ACTOR,
      traceId: ids.id('trace'),
      issuedAt: nowIso(),
    });
    expect(back.ok).toBe(true);
    // The corrective work finished and the run is back in REVIEWING — through the engine's own
    // transitions, never through the applicator.
    await driveExecutingToReviewing(f, runId);
    const again = await f.evidence.applyEvidence({
      companyId: COMPANY,
      runId,
      reviewTaskId: review,
      actorId: ACTOR,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    // Without a decision consuming it, the verdict is re-applied (the conservative default).
    expect(again.value?.event).toBe('REVIEW.REJECT');

    // The Decision that cites this report is the durable proof it was acted on.
    f.decisions.set([
      { action: 'REQUEST_CORRECTIVE', evidenceRefs: [`artifact:${reportId}`] },
    ]);
    const consumed = await f.evidence.applyEvidence({
      companyId: COMPANY,
      runId,
      reviewTaskId: review,
      actorId: ACTOR,
    });
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) return;
    expect(consumed.value).toBeNull();
    const run = await f.db.runs.get(runId as never);
    expect(run?.state).toBe('REWORK');
    // A PASS verdict is never consumed by a corrective: it still advances legally. The run is
    // back in REVIEWING through the machine's own transitions again.
    const rework2 = await f.engine.dispatch({
      commandId: `t18c-back2:${runId}:REWORK.READY`,
      runId,
      type: 'REWORK.READY',
      expectedRevision: (await f.db.runs.get(runId as never))?.revision ?? 0,
      actorId: ACTOR,
      traceId: ids.id('trace'),
      issuedAt: nowIso(),
    });
    expect(rework2.ok).toBe(true);
    await driveExecutingToReviewing(f, runId);
    const passReview = await f.seedTask({ stageId: 'review' });
    await seedReviewVerdict(f, {
      runId,
      reviewTaskId: passReview,
      subjectTaskId: work,
      verdict: 'PASS',
    });
    f.decisions.set([
      { action: 'REQUEST_CORRECTIVE', evidenceRefs: [`artifact:${reportId}`] },
    ]);
    const passed = await f.evidence.applyEvidence({
      companyId: COMPANY,
      runId,
      reviewTaskId: passReview,
      actorId: ACTOR,
    });
    expect(passed.ok).toBe(true);
    if (!passed.ok) return;
    expect(passed.value?.event).toBe('REVIEW.PASS');
  });
});

/** The engine's own legal commands that bring a run to REVIEWING / VALIDATING. */
const driveExecutingToReviewing = async (f: Fixture, runId: string): Promise<void> => {
  const current = await f.db.runs.get(runId as never);
  const dispatched = await f.engine.dispatch({
    commandId: `t18c-drive:${runId}:EXECUTION.COMPLETE:${String(current?.revision ?? 0)}`,
    runId,
    type: 'EXECUTION.COMPLETE',
    expectedRevision: current?.revision ?? 0,
    actorId: ACTOR,
    traceId: ids.id('trace'),
    issuedAt: nowIso(),
  });
  if (!dispatched.ok)
    throw new Error(`EXECUTION.COMPLETE refused: ${dispatched.error?.message ?? ''}`);
};

const driveReviewingToValidating = async (f: Fixture, runId: string): Promise<void> => {
  const review = await f.seedTask({ stageId: 'review' });
  const work = await f.seedTask({ stageId: 'build' });
  const executionId = await f.seedExecution({ runId, taskId: review });
  const recorded = await f.reviewSink.record({
    companyId: COMPANY,
    runId,
    reviewStageId: 'review',
    reviewTaskId: review,
    subjectTaskId: work,
    executionId,
    verdict: 'PASS',
    findings: [],
    decidedBy: ACTOR,
  });
  if (!recorded.ok) throw new Error(recorded.error.message);
  const applied = await f.evidence.applyEvidence({
    companyId: COMPANY,
    runId,
    reviewTaskId: review,
    actorId: ACTOR,
  });
  if (!applied.ok) throw new Error(`review evidence refused: ${applied.error.message}`);
};

/* ---------------------------------------------------------------- helpers */

const createRunWithOtherBinding = async (f: Fixture, templateId: string): Promise<string> => {
  const created = await f.lifecycle.createRun({
    templateId,
    companyId: COMPANY,
    workflowId: `wf_other_${ids.id('wf')}`,
    actorId: ACTOR,
    modelBindings: { reviewer: MODEL_KEY },
    goal: { objective: 'A run with no supervisor pin.', source: { type: 'human' } },
  });
  if (!created.ok) throw new Error(created.error.message);
  const driven = await f.engine.drive(created.value.run.id, { maxSteps: 8 });
  if (!driven.ok) throw new Error(driven.error.message);
  return created.value.run.id;
};
