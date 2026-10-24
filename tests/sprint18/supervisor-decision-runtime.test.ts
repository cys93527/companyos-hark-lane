/**
 * Sprint 18 / Task-18-06 — the supervisor decision runtime (§64 test matrix).
 *
 * Proven over the REAL durable layer: SQLite runs/tasks/snapshots/decisions/validations/
 * agent_executions, the real run-goal artifact, the real snapshot verifier, the real binding
 * reader, the real model registry, the real T18-03 decision sink, the real T18-04 review sink
 * and the real AgentRuntime. NOTHING here calls a live model API: the only fake is a
 * deterministic in-process provider adapter registered through the REAL provider registry —
 * the same seam every Sprint-8 test uses — so the model call is scripted, never networked.
 *
 * Groups (the approved matrix):
 *   binding + execution      1–10
 *   context                 11–22
 *   proposal                23–34
 *   no side effects         35–42
 *   cancellation + timeout  43–52
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { REVIEW_VERDICTS } from '@companyos/core';
import {
  createExecution,
  createTask,
  createValidation,
  domainError,
  err,
  ok,
  type DomainError,
  type InvocationRequest,
  type InvocationResult,
  type ModelProviderPort,
  type RawModelInfo,
  type Result,
  type TokenUsage,
} from '@companyos/core';
import {
  createAgentRuntime,
  createArtifactService,
  createModelRegistry,
  createProviderRegistry,
  createReviewFindingsSink,
  createRunGoalService,
  createRunModelBindingReader,
  createRunSnapshotVerifier,
  createSelectionPolicyService,
  createSupervisorDecisionRuntime,
  renderSupervisorContext,
  createSupervisorDecisionSink,
  createWorkflowLifecycle,
  supervisorDecisionCommandId,
  type AgentRuntimeService,
  type ReviewFindingsSink,
  type SupervisorDecisionRuntime,
  type SupervisorDecisionRuntimeDeps,
  type SupervisorDecisionSink,
} from '@companyos/engine';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';

/* ------------------------------------------------------------------ harness */

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18sup-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18S${String(++seq).padStart(12, '0')}`,
  ulid: () => `18S${String(++seq).padStart(23, '0')}`,
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
const OBJECTIVE = 'Ship the autonomous supervisor decision layer without executing it.';
const PROVIDER_ID = 'prov_fake';
const MODEL_KEY = 'fake.supervisor';
const PROVIDER_MODEL_ID = 'fake-supervisor-1';

/** The deterministic fake model seam: no live API, no network, no wall clock. */
interface FakeModel {
  readonly port: ModelProviderPort;
  readonly requests: InvocationRequest[];
  /** The structured proposal the model returns. */
  structured: unknown;
  outputText: string;
  /** When set, the invocation fails with this domain error instead of returning. */
  failWith: DomainError | null;
  /** Fires once, synchronously, at the start of the next invocation (expires a deadline). */
  onInvoke: (() => void) | null;
  /** How long the invocation stays pending, so a cancellation can land mid-flight. */
  pendingMs: number;
  /** How many invocations were handed a signal (proof the runtime forwarded one). */
  readonly signalObservations: number;
  /** How many invocations observed their signal firing (proof it was honored). */
  readonly abortObservations: number;
  /** How many invocations ended as cancellations. */
  readonly cancellations: number;
}

/** The injected sleeper for the fake model: the engine may not install timers itself. */
const sleepFor = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const createFakeModel = (): FakeModel => {
  const requests: InvocationRequest[] = [];
  const state = {
    structured: null as unknown,
    outputText: 'proposal',
    failWith: null as DomainError | null,
    onInvoke: null as (() => void) | null,
    pendingMs: 0,
    signalObservations: 0,
    abortObservations: 0,
    cancellations: 0,
  };
  /** The canonical cancelled invocation: not retryable, never a provider failure. */
  const cancelled = (): DomainError =>
    domainError('CANCELLED', 'The invocation was cancelled.', {
      kind: 'CANCELLED',
      retryable: false,
    });
  const usage = (): TokenUsage => ({ inputTokens: 3, outputTokens: 7, totalCost: null });
  const models: readonly RawModelInfo[] = [
    {
      modelId: PROVIDER_MODEL_ID,
      displayName: PROVIDER_MODEL_ID,
      contextWindow: 8_192,
      capabilities: { streaming: false, structuredOutput: true },
    },
  ];
  const port: ModelProviderPort = {
    describe: () => ({
      providerId: PROVIDER_ID,
      kind: 'fake',
      displayName: 'Fake supervisor model',
      version: '1.0.0',
    }),
    listModels: (): Promise<Result<readonly RawModelInfo[], DomainError>> =>
      Promise.resolve(ok(models)),
    health: (): Promise<Result<never, DomainError>> => Promise.resolve(ok(undefined as never)),
    invoke(request: InvocationRequest): Promise<Result<InvocationResult, DomainError>> {
      requests.push(request);
      if (request.signal !== undefined) state.signalObservations += 1;
      if (request.signal?.aborted === true) {
        state.abortObservations += 1;
        state.cancellations += 1;
        return Promise.resolve(err(cancelled()));
      }
      if (state.failWith !== null)
        return Promise.resolve({ ok: false as const, error: state.failWith });
      if (state.onInvoke !== null) {
        const hook = state.onInvoke;
        state.onInvoke = null;
        hook();
      }
      const answer = (): Result<InvocationResult, DomainError> => {
        const result: InvocationResult = {
          modelId: request.modelId,
          providerId: PROVIDER_ID,
          outputText: state.outputText,
          structured: state.structured,
          toolCalls: [],
          usage: usage(),
          finishReason: 'stop',
        };
        return ok(result);
      };
      // A genuinely pending invocation that OBSERVES the caller's signal: the cancellation is
      // real, so this promise settles as cancelled instead of answering after the abort.
      const pendingMs = state.pendingMs;
      if (pendingMs <= 0) return Promise.resolve(answer());
      const signal = request.signal;
      if (signal === undefined) {
        return sleepFor(pendingMs).then(answer);
      }
      return new Promise<Result<InvocationResult, DomainError>>((resolve) => {
        const stop = (): Result<InvocationResult, DomainError> => {
          state.abortObservations += 1;
          state.cancellations += 1;
          return err(cancelled());
        };
        if (signal.aborted) {
          resolve(stop());
          return;
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve(answer());
        }, pendingMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve(stop());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    stream(): AsyncIterable<Result<never, DomainError>> {
      return {
        [Symbol.asyncIterator]: () => ({
          next: (): Promise<IteratorResult<Result<never, DomainError>>> =>
            Promise.resolve({ done: true, value: undefined }),
        }),
      };
    },
  };
  return {
    port,
    requests,
    get structured(): unknown {
      return state.structured;
    },
    set structured(value: unknown) {
      state.structured = value;
    },
    get outputText(): string {
      return state.outputText;
    },
    set outputText(value: string) {
      state.outputText = value;
    },
    get failWith(): DomainError | null {
      return state.failWith;
    },
    set failWith(value: DomainError | null) {
      state.failWith = value;
    },
    get onInvoke(): (() => void) | null {
      return state.onInvoke;
    },
    set onInvoke(value: (() => void) | null) {
      state.onInvoke = value;
    },
    get pendingMs(): number {
      return state.pendingMs;
    },
    set pendingMs(value: number) {
      state.pendingMs = value;
    },
    get signalObservations(): number {
      return state.signalObservations;
    },
    get abortObservations(): number {
      return state.abortObservations;
    },
    get cancellations(): number {
      return state.cancellations;
    },
  };
};

/** A scriptable timer so a deadline can be expired deterministically, even mid-flight. */
const createTimers = () => {
  const pending: { fire: () => void; cleared: boolean }[] = [];
  /** Every deadline the runtime asked for, in installation order (proves clamping). */
  const installed: number[] = [];
  return {
    timer: (ms: number, onTimeout: () => void): (() => void) => {
      const handle = setTimeout(onTimeout, ms);
      const entry = { fire: onTimeout, cleared: false };
      pending.push(entry);
      installed.push(ms);
      return () => {
        entry.cleared = true;
        clearTimeout(handle);
      };
    },
    /** Expire every pending deadline exactly the way a real timeout would. */
    fireAll(): void {
      for (const entry of pending) if (!entry.cleared) entry.fire();
    },
    pendingCount(): number {
      return pending.filter((entry) => !entry.cleared).length;
    },
    installedMs(): readonly number[] {
      return [...installed];
    },
  };
};

interface Fixture {
  readonly db: DurableDatabase;
  readonly model: FakeModel;
  readonly timers: ReturnType<typeof createTimers>;
  readonly runtime: SupervisorDecisionRuntime;
  readonly agentRuntime: AgentRuntimeService;
  readonly sink: SupervisorDecisionSink;
  readonly reviews: ReviewFindingsSink;
  /** A fresh runtime over the SAME durable graph, with selected dependencies decorated. */
  withDeps(over: {
    readonly decisionSink?: SupervisorDecisionSink;
    readonly decisionHistory?: SupervisorDecisionRuntimeDeps['decisionHistory'];
    readonly agentRuntime?: AgentRuntimeService;
  }): SupervisorDecisionRuntime;
  templateWithStages(label: string, stageIds: readonly string[]): Promise<string>;
  runWithGoal(
    label: string,
    options?: {
      readonly stages?: readonly string[];
      readonly bindings?: Readonly<Record<string, string>>;
      readonly objective?: string;
      /** false creates a run with NO canonical goal (the legacy shape). */
      readonly goal?: boolean;
    },
  ): Promise<{ readonly runId: string; readonly templateId: string }>;
  seedTask(
    stageId: string,
    over?: { readonly inputs?: Readonly<Record<string, unknown>>; readonly state?: string },
    runIdOverride?: string,
  ): Promise<string>;
  seedValidation(input: {
    readonly runId: string;
    readonly status: 'pass' | 'fail' | 'error';
    readonly evidenceRefs?: readonly string[];
  }): Promise<string>;
  seedReviewReport(input: {
    readonly runId: string;
    readonly reviewTaskId: string;
    readonly subjectTaskId: string;
    readonly verdict: (typeof REVIEW_VERDICTS)[number];
    readonly findings?: readonly {
      readonly code: string;
      readonly summary: string;
      readonly detail: string;
      readonly blocking: boolean;
    }[];
  }): Promise<string>;
  disableModel(): Promise<void>;
  executionRows(): Promise<readonly Record<string, unknown>[]>;
  decisionRows(): Promise<readonly Record<string, unknown>[]>;
  toolInvocationCount(): number;
  validationCount(): number;
  taskCount(): number;
  tamperSnapshot(snapshotId: string): void;
  /** Re-open the SAME durable files in a fresh composition (the crash/restart window). */
  restart(): {
    readonly runtime: SupervisorDecisionRuntime;
    readonly sink: SupervisorDecisionSink;
    readonly agentRuntime: AgentRuntimeService;
  };
}

const makeFixture = (options: { readonly maxTimeoutMs?: number } = {}): Fixture => {
  const dataDir = tempDir();
  const casRoot = tempDir();
  let db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  const model = createFakeModel();
  const timers = createTimers();
  const authorize = async (): Promise<Result<true, DomainError>> => ok(true as const);
  let modelSeeded = false;

  const artifactResolver = async (refs: readonly string[]) => {
    const anchored: { kind: string; id: string; ref: string; runId: string }[] = [];
    for (const ref of refs) {
      const id = ref.startsWith('artifact:') ? ref.slice('artifact:'.length) : ref;
      const row = await db.artifactStore!.get(id as never);
      if (row === null)
        return {
          ok: false as const,
          error: domainError('NOT_FOUND', `missing ${ref}`, { reference: ref }),
        };
      anchored.push({ kind: 'artifact', id: row.id, ref, runId: row.runId });
    }
    return { ok: true as const, value: anchored };
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
    const policies = createSelectionPolicyService({
      ids,
      clock,
      policies: database.selectionPolicies,
      results: database.benchmarkResults,
      readRecords: async () => models.list({ includeDisabled: true }),
      events: database.events,
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
    const bindingReader = createRunModelBindingReader({
      runs: database.runs,
      snapshots: database.snapshots,
    });
    const snapshotVerifier = createRunSnapshotVerifier({
      templates: database.templates,
      snapshots: database.snapshots,
    });
    const durableReferenceResolver = async (refs: readonly string[]) => {
      const anchored: { kind: string; id: string; ref: string; runId: string }[] = [];
      for (const ref of refs) {
        // The frozen grammar: a validation ref IS the branded ValidationId; an artifact ref is
        // `artifact:art_<id>` or the bare ArtifactId.
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
    };
    const sink = createSupervisorDecisionSink({
      runs: database.runs,
      tasks: database.tasks,
      templates: database.templates,
      decisions: database.decisions!,
      runGoal,
      runSnapshotVerifier: snapshotVerifier,
      modelBindings: bindingReader,
      modelRegistry: models,
      durableReferenceResolver,
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
      durableReferenceResolver: artifactResolver,
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
    const runtimeDeps = {
      runs: database.runs,
      tasks: database.tasks,
      runGoal,
      runSnapshotVerifier: snapshotVerifier,
      modelBindings: bindingReader,
      modelRegistry: models,
      reviewReports: {
        getLatestReviewReport: ({
          companyId,
          runId,
          reviewTaskId,
          actorId,
        }: {
          readonly companyId: string;
          readonly runId: string;
          readonly reviewTaskId: string;
          readonly actorId: string;
        }) =>
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
      decisionHistory: sink,
      decisionSink: sink,
      agentRuntime,
      timer: timers.timer,
      clock,
      ids,
      supervisorBindingKey: SUPERVISOR_BINDING,
      supervisorAgentId: 'supervisor-runtime',
      supervisorRoleId: 'supervisor-runtime',
      ...(options.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: options.maxTimeoutMs }),
    };
    const runtime = createSupervisorDecisionRuntime(runtimeDeps);
    return {
      artifacts,
      models,
      lifecycle,
      sink,
      reviews,
      agentRuntime,
      runtime,
      runtimeDeps,
      providers,
    };
  };

  let built = build(db);

  /** Register the deterministic fake provider + model once per fixture. */
  const seedModel = async (): Promise<void> => {
    if (modelSeeded) return;
    modelSeeded = true;
    const registered = await built.providers.register(model.port, { actorId: ACTOR });
    if (!registered.ok && registered.error.code !== 'CONFLICT')
      throw new Error(registered.error.message);
    const made = await built.models.registerFromProvider({
      providerId: PROVIDER_ID,
      providerModelId: PROVIDER_MODEL_ID,
      modelKey: MODEL_KEY,
      actorId: ACTOR,
    });
    if (!made.ok && made.error.code !== 'CONFLICT') throw new Error(made.error.message);
  };

  let lastRunId: string | null = null;
  return {
    db,
    model,
    timers,
    get runtime() {
      return built.runtime;
    },
    get agentRuntime() {
      return built.agentRuntime;
    },
    get sink() {
      return built.sink;
    },
    get reviews() {
      return built.reviews;
    },
    withDeps(over) {
      const base = built;
      return createSupervisorDecisionRuntime({
        runs: db.runs,
        tasks: db.tasks,
        runGoal: base.runtimeDeps.runGoal,
        runSnapshotVerifier: base.runtimeDeps.runSnapshotVerifier,
        modelBindings: base.runtimeDeps.modelBindings,
        modelRegistry: base.runtimeDeps.modelRegistry,
        reviewReports: base.runtimeDeps.reviewReports,
        validations: base.runtimeDeps.validations,
        decisionHistory:
          over.decisionHistory ?? over.decisionSink ?? base.runtimeDeps.decisionHistory,
        decisionSink: over.decisionSink ?? base.runtimeDeps.decisionSink,
        agentRuntime: over.agentRuntime ?? base.runtimeDeps.agentRuntime,
        timer: timers.timer,
        clock,
        ids,
        supervisorBindingKey: SUPERVISOR_BINDING,
        supervisorAgentId: 'supervisor-runtime',
        supervisorRoleId: 'supervisor-runtime',
        ...(options.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: options.maxTimeoutMs }),
      });
    },
    async templateWithStages(label, stageIds) {
      const template = await built.lifecycle.createTemplate({
        orgId: COMPANY,
        name: `Supervisor flow ${label}`,
        actorId: ACTOR,
        traceId: `t18s_tpl_${label}`,
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
        traceId: `t18s_graph_${label}`,
      });
      if (!saved.ok) throw new Error(saved.error.message);
      const published = await built.lifecycle.publish({
        templateId: template.value.id,
        actorId: ACTOR,
        traceId: `t18s_pub_${label}`,
      });
      if (!published.ok) throw new Error(published.error.message);
      return template.value.id;
    },
    async runWithGoal(label, runOptions = {}) {
      await seedModel();
      const templateId = await this.templateWithStages(
        label,
        runOptions.stages ?? ['build', 'review'],
      );
      const goal =
        runOptions.goal === false
          ? undefined
          : {
              objective: runOptions.objective ?? OBJECTIVE,
              source: { type: 'human' as const, ref: label },
            };
      const run = await built.lifecycle.createRun({
        templateId,
        companyId: COMPANY,
        workflowId: `wf_${label}`,
        actorId: ACTOR,
        // The run pins its supervisor binding — the ONLY place a supervisor model may come from.
        modelBindings: runOptions.bindings ?? { [SUPERVISOR_BINDING]: MODEL_KEY },
        ...(goal === undefined ? {} : { goal }),
      });
      if (!run.ok) throw new Error(run.error.message);
      lastRunId = run.value.run.id;
      return { runId: run.value.run.id, templateId };
    },
    async seedTask(stageId, over = {}, runIdOverride?: string) {
      const seedRunId = runIdOverride ?? lastRunId;
      if (seedRunId === null) throw new Error('seedTask requires a prior runAt/runWithGoal — canonical run ownership.');
      const task = await createTask({ runId: seedRunId as never,
        stageId: stageId as never,
        roleId: 'rol_1' as never,
        kind: 'pack-a:build',
        now: nowIso(),
        ids,
        ...(over.inputs === undefined ? {} : { inputs: over.inputs }),
      });
      if (!task.ok) throw new Error(task.error.message);
      await db.tasks.put(
        over.state === undefined ? task.value : { ...task.value, state: over.state as never },
      );
      return task.value.id;
    },
    async seedValidation({ runId, status, evidenceRefs }) {
      const made = await createValidation({
        runId: runId as never,
        validatorId: 'pack-a:unit',
        validatorVersion: '1.0.0',
        status,
        blocking: true,
        exitCode: status === 'pass' ? 0 : 1,
        startedAt: nowIso(),
        finishedAt: nowIso(),
        ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
        ids,
      });
      if (!made.ok) throw new Error(made.error.message);
      await db.validationStore!.record(made.value, {
        creationCommandId: `cmd_v_${ids.id('v')}`,
        creationCommandFingerprint: 'fp:seed',
      });
      return made.value.id;
    },
    async seedReviewReport({ runId, reviewTaskId, subjectTaskId, verdict, findings }) {
      const made = await createExecution({
        executionId: ids.id('exc'),
        agentId: 'agent_reviewer',
        roleId: 'rol_reviewer' as never,
        taskId: reviewTaskId as never,
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
      await db.agentExecutions.put({ ...made.value, status: 'COMPLETED' as never });
      const recorded = await built.reviews.record({
        companyId: COMPANY,
        runId,
        reviewStageId: 'review',
        reviewTaskId,
        subjectTaskId,
        executionId: made.value.executionId,
        verdict,
        findings: findings ?? [
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
    async disableModel() {
      const changed = await built.models.setEnabled(MODEL_KEY, false, ACTOR);
      if (!changed.ok) throw new Error(changed.error.message);
    },
    async executionRows() {
      return db.db.prepare('SELECT * FROM agent_executions').all() as Record<string, unknown>[];
    },
    async decisionRows() {
      return db.db.prepare('SELECT * FROM decisions').all() as Record<string, unknown>[];
    },
    toolInvocationCount(): number {
      return Number(
        (
          db.db.prepare('SELECT COUNT(*) AS c FROM tool_invocations').get() as {
            c: number | bigint;
          }
        ).c,
      );
    },
    validationCount(): number {
      return Number(
        (db.db.prepare('SELECT COUNT(*) AS c FROM validations').get() as { c: number | bigint }).c,
      );
    },
    taskCount(): number {
      return Number(
        (db.db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number | bigint }).c,
      );
    },
    tamperSnapshot(snapshotId) {
      db.db
        .prepare('UPDATE run_snapshots SET memory_view_ref = ? WHERE id = ?')
        .run('memory:attacker', snapshotId);
    },
    restart() {
      db.close();
      const tracked = openDatabases.indexOf(db);
      if (tracked >= 0) openDatabases.splice(tracked, 1);
      db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
      openDatabases.push(db);
      modelSeeded = false;
      built = build(db);
      return { runtime: built.runtime, sink: built.sink, agentRuntime: built.agentRuntime };
    },
  };
};

/* ------------------------------------------------------------------ helpers */

/** A structurally valid proposal envelope, ready to be overridden per test. */
const proposal = (over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  schema: 'companyos/supervisor-proposal/1',
  action: 'CONTINUE',
  reasonCode: 'GOAL_SATISFIED',
  summary: 'The objective is on track.',
  evidenceRefs: [],
  subject: null,
  ...over,
});

const turnOf = (input: {
  readonly runId: string;
  readonly taskId: string;
  readonly identity?: string;
  readonly reviewTaskId?: string;
}): Parameters<SupervisorDecisionRuntime['runOneSupervisorDecisionTurn']>[0] => ({
  companyId: COMPANY,
  runId: input.runId,
  taskId: input.taskId,
  ...(input.reviewTaskId === undefined ? {} : { reviewTaskId: input.reviewTaskId }),
  actorId: ACTOR,
  commandId: supervisorDecisionCommandId(input.runId, input.identity ?? 'first'),
});

/* ================================================================================ */

describe('T18-06 supervisor decision runtime — binding + execution (1–10)', () => {
  it('1. the invocation uses the model the run pinned, and only that one', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('pinned');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(f.model.requests.length).toBe(1);
    expect(f.model.requests[0]?.modelId).toBe(PROVIDER_MODEL_ID);
    // The execution records the SAME model the run pinned — never a caller's or a default.
    const row = (await f.executionRows())[0];
    expect(row?.['model_key']).toBe(MODEL_KEY);
    expect(row?.['provider_id']).toBe(PROVIDER_ID);
    expect(row?.['provider_model_id']).toBe(PROVIDER_MODEL_ID);
  });

  it('2. a run that pins no supervisor binding fails closed: zero model calls, zero decisions', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('nobinding', { bindings: { reviewer: MODEL_KEY } });
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.details['reason']).toBe('RUN_BINDING_MISSING');
    expect(f.model.requests.length).toBe(0);
    expect((await f.decisionRows()).length).toBe(0);
    expect((await f.executionRows()).length).toBe(0);
  });

  it('3. a pinned model that no longer resolves fails closed', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('unresolved');
    const taskId = await f.seedTask('build');
    // Drop the durable model row the pin resolves through, without touching the snapshot.
    f.db.db.prepare('DELETE FROM model_records WHERE model_key = ?').run(MODEL_KEY);
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('RUN_BINDING_UNKNOWN');
    expect(f.model.requests.length).toBe(0);
    expect((await f.decisionRows()).length).toBe(0);
  });

  it('4. a disabled pinned model is refused before anything is written', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('disabled');
    await f.disableModel();
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('RUN_BINDING_UNUSABLE');
    expect(f.model.requests.length).toBe(0);
    expect((await f.executionRows()).length).toBe(0);
  });

  it('5. caller-supplied model identity never reaches the decision', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('identity');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const command = {
      ...turnOf({ runId, taskId, identity: 'identity' }),
      providerId: PROVIDER_ID,
      modelKey: MODEL_KEY,
      providerModelId: PROVIDER_MODEL_ID,
      modelVersion: '9',
    } as unknown as Parameters<SupervisorDecisionRuntime['runOneSupervisorDecisionTurn']>[0];
    const result = await f.runtime.runOneSupervisorDecisionTurn(command);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decisions = await f.decisionRows();
    expect(decisions.length).toBe(1);
    // The durable envelope records the pinned binding NAME and the resolved key — never the
    // caller's provider or model ids.
    const envelope = JSON.parse(String(decisions[0]?.['metadata_json'])).supervisor;
    expect(envelope.modelBindingKey).toBe(SUPERVISOR_BINDING);
    expect(envelope.resolvedModelKey).toBe(MODEL_KEY);
    expect(envelope.providerId).toBeUndefined();
    expect(envelope.providerModelId).toBeUndefined(); // And the SINK itself refuses the fields when they are handed to it directly.
    const direct = await f.sink.record({
      commandId: supervisorDecisionCommandId(runId, 'direct'),
      companyId: COMPANY,
      runId,
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'A decision that claims its own model identity.',
      decidedBy: ACTOR,
      modelKey: MODEL_KEY,
    } as unknown as Parameters<SupervisorDecisionSink['record']>[0]);
    expect(direct.ok).toBe(false);
    if (direct.ok) return;
    expect(direct.error.details['reason']).toBe('SUPERVISOR_DECISION_MODEL_IDENTITY_REJECTED');
  });

  it('6. exactly ONE durable AgentExecution exists after one turn', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('oneexec');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(true);
    const rows = await f.executionRows();
    expect(rows.length).toBe(1);
  });

  it('7. the execution carries the generic supervisor identity and the subject anchors', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('identity2');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = (await f.executionRows())[0];
    expect(row?.['execution_id']).toBe(result.value.executionId);
    expect(row?.['agent_id']).toBe('supervisor-runtime');
    expect(row?.['role_id']).toBe('supervisor-runtime');
    expect(row?.['task_id']).toBe(taskId);
    expect(row?.['run_id']).toBe(runId);
    expect(row?.['model_key']).toBe(MODEL_KEY);
  });

  it('8. the execution is COMPLETED only after the Decision is durable', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('completed');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = (await f.executionRows())[0];
    expect(row?.['status']).toBe('COMPLETED');
    // `resultRef` is an OPAQUE string with no canonical Decision grammar (Sprint-13 concept
    // map), so T18-06 does NOT invent `decision:<id>@<version>` for it: it stays null and the
    // link between the two durable rows is the traceId both already carry.
    expect(row?.['result_ref']).toBeNull();
    const decisions = await f.decisionRows();
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.['decision_id']).toBe(result.value.decisionId);
    expect(decisions[0]?.['trace_id']).toBe(row?.['trace_id']);
    // The usage recorded is the usage the provider REPORTED (3 in / 7 out) — the deferred
    // settlement must not zero what it was told.
    const usage = JSON.parse(String(row?.['output_usage'])) as {
      inputTokens: number;
      outputTokens: number;
    };
    expect(usage.inputTokens).toBe(3);
    expect(usage.outputTokens).toBe(7);
  });

  it('9. a strict-parse failure fails the execution and records no decision', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('parsefail');
    const taskId = await f.seedTask('build');
    // The model answers with prose and no structured payload: nothing may be extracted from it.
    f.model.structured = null;
    f.model.outputText = 'I think we should continue, but here is some prose around it.';
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
    const row = (await f.executionRows())[0];
    expect(row?.['status']).toBe('FAILED');
    expect(row?.['error_kind']).toBe('INVALID_OUTPUT');
    expect(String(row?.['error_message'])).toContain('structured payload');
    expect((await f.decisionRows()).length).toBe(0);
  });

  it('10. a semantic failure fails the execution and records no decision', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('semanticfail');
    const taskId = await f.seedTask('build');
    // COMPLETE without completion provenance: well-formed envelope, illegal precondition.
    f.model.structured = proposal({ action: 'COMPLETE', evidenceRefs: [] });
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_COMPLETION_MISSING');
    const row = (await f.executionRows())[0];
    expect(row?.['status']).toBe('FAILED');
    expect((await f.decisionRows()).length).toBe(0);
  });
});

describe('T18-06 supervisor decision runtime — context (11–22)', () => {
  it('11. the context carries the canonical goal objective', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('goaltext', { objective: OBJECTIVE });
    const taskId = await f.seedTask('build');
    const built = await f.runtime.buildContext({
      companyId: COMPANY,
      runId,
      taskId,
      actorId: ACTOR,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.goal.objective).toBe(OBJECTIVE);
    expect(built.value.runId).toBe(runId);
    expect(built.value.binding.modelKey).toBe(MODEL_KEY);
  });

  it('12. a run without a canonical goal fails closed: zero model calls', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('nogoal', { goal: false });
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('RUN_GOAL_MISSING');
    expect(f.model.requests.length).toBe(0);
    expect((await f.executionRows()).length).toBe(0);
  });

  it('13. a tampered snapshot is refused: zero model calls, zero decisions', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('tampered');
    const taskId = await f.seedTask('build');
    const run = await f.db.runs.get(runId as never);
    expect(run).not.toBeNull();
    f.tamperSnapshot(String(run?.snapshotId));
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SNAPSHOT_MISMATCH');
    expect(f.model.requests.length).toBe(0);
    expect((await f.decisionRows()).length).toBe(0);
    expect((await f.executionRows()).length).toBe(0);
  });

  it('14. the context projects the LATEST review report, never an older one', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('latestreview');
    const work = await f.seedTask('build');
    const review = await f.seedTask('review');
    const first = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    const second = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'PASS',
      findings: [],
    });
    const built = await f.runtime.buildContext({
      companyId: COMPANY,
      runId,
      taskId: work,
      reviewTaskId: review,
      actorId: ACTOR,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.review?.['artifactId']).toBe(second);
    expect(built.value.review?.['verdict']).toBe('PASS');
    expect(built.value.blockingConditions).not.toContain('LATEST_REVIEW_CHANGES_REQUESTED');
    expect(first).not.toBe(second);
  });

  it('15. the context projects the latest validation row (newest wins)', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('latestvalidation');
    const taskId = await f.seedTask('build');
    const older = await f.seedValidation({ runId, status: 'fail' });
    const newer = await f.seedValidation({ runId, status: 'pass' });
    const built = await f.runtime.buildContext({
      companyId: COMPANY,
      runId,
      taskId,
      actorId: ACTOR,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.validation?.['validationId']).toBe(newer);
    expect(built.value.validation?.['status']).toBe('pass');
    expect(older).not.toBe(newer);
    expect(built.value.blockingConditions).not.toContain('LATEST_VALIDATION_FAILED');
  });

  it('16. the decision history is bounded and names its truncation', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('history');
    const taskId = await f.seedTask('build');
    // 25 durable supervisor decisions through the real sink.
    for (let index = 0; index < 25; index += 1) {
      const recorded = await f.sink.record({
        commandId: supervisorDecisionCommandId(runId, `slot-${String(index)}`),
        companyId: COMPANY,
        runId,
        taskId,
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: `Decision ${String(index)} of the run.`,
        decidedBy: ACTOR,
      });
      if (!recorded.ok) throw new Error(recorded.error.message);
    }
    const built = await f.runtime.buildContext({
      companyId: COMPANY,
      runId,
      taskId,
      actorId: ACTOR,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.decisions.length).toBe(20);
    expect(built.value.truncated).toContain('decisions');
  });

  it('17. the corrective lineage of a corrective subject task is projected', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('lineage');
    const parent = await f.seedTask('build');
    const child = await f.seedTask('build', {
      inputs: {
        corrective: {
          schema: 'companyos/corrective-task/1',
          parentTaskId: parent,
          rootTaskId: parent,
          round: 1,
          originDecisionId: 'dec_origin',
          originDecisionVersion: 1,
          reasonCode: 'REVIEW_FINDING',
          causeEvidenceRefs: ['artifact:art_origin'],
        },
      },
    });
    const built = await f.runtime.buildContext({
      companyId: COMPANY,
      runId,
      taskId: child,
      actorId: ACTOR,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.lineage).not.toBeNull();
    expect(built.value.lineage?.['parentTaskId']).toBe(parent);
    expect(built.value.lineage?.['round']).toBe(1);
    expect(built.value.refs.some((ref) => ref.kind === 'lineage')).toBe(true);
  });

  it('18. blocking conditions are computed from the latest durable state', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('blocking');
    const work = await f.seedTask('build');
    const review = await f.seedTask('review');
    await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    await f.seedValidation({ runId, status: 'fail' });
    const built = await f.runtime.buildContext({
      companyId: COMPANY,
      runId,
      taskId: work,
      reviewTaskId: review,
      actorId: ACTOR,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.blockingConditions).toContain('LATEST_REVIEW_CHANGES_REQUESTED');
    expect(built.value.blockingConditions).toContain('LATEST_VALIDATION_FAILED');
  });

  it('19. the context carries a durable ref for every projection', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('refs');
    const work = await f.seedTask('build');
    const review = await f.seedTask('review');
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    const validationId = await f.seedValidation({ runId, status: 'fail' });
    const recorded = await f.sink.record({
      commandId: supervisorDecisionCommandId(runId, 'refs'),
      companyId: COMPANY,
      runId,
      taskId: work,
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'An earlier decision of this run.',
      decidedBy: ACTOR,
    });
    if (!recorded.ok) throw new Error(recorded.error.message);
    const built = await f.runtime.buildContext({
      companyId: COMPANY,
      runId,
      taskId: work,
      reviewTaskId: review,
      actorId: ACTOR,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const kinds = built.value.refs.map((ref) => ref.kind);
    for (const kind of [
      'run',
      'goal',
      'snapshot',
      'binding',
      'task',
      'review',
      'validation',
      'decision',
    ]) {
      expect(kinds).toContain(kind);
    }
    expect(built.value.refs.some((ref) => ref.kind === 'review' && ref.id === reportId)).toBe(true);
    expect(
      built.value.refs.some((ref) => ref.kind === 'validation' && ref.id === validationId),
    ).toBe(true);
  });

  it('20. an over-bound context is refused instead of silently truncated', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('toolarge', { objective: 'O'.repeat(8_000) });
    const work = await f.seedTask('build');
    const review = await f.seedTask('review');
    // Each projection is individually bounded (the objective at 8 000 characters, twenty
    // decision summaries at 400), but together they exceed the 16 KiB context bound.
    for (let index = 0; index < 25; index += 1) {
      const recorded = await f.sink.record({
        commandId: supervisorDecisionCommandId(runId, `big-${String(index)}`),
        companyId: COMPANY,
        runId,
        taskId: work,
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'D'.repeat(3_500),
        decidedBy: ACTOR,
      });
      if (!recorded.ok) throw new Error(recorded.error.message);
    }
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(
      turnOf({ runId, taskId: work, reviewTaskId: review }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('SUPERVISOR_CONTEXT_TOO_LARGE');
    expect(f.model.requests.length).toBe(0);
    expect((await f.executionRows()).length).toBe(0);
  });

  it('21. the context is deterministic: same durable state, same bytes', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('deterministic');
    const work = await f.seedTask('build');
    const review = await f.seedTask('review');
    await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    await f.seedValidation({ runId, status: 'fail' });
    const first = await f.runtime.buildContext({
      companyId: COMPANY,
      runId,
      taskId: work,
      reviewTaskId: review,
      actorId: ACTOR,
    });
    const second = await f.runtime.buildContext({
      companyId: COMPANY,
      runId,
      taskId: work,
      reviewTaskId: review,
      actorId: ACTOR,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(renderSupervisorContext(first.value)).toBe(renderSupervisorContext(second.value));
  });

  it('22. the context projects bounded summaries and refs, never content', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('bounded');
    const work = await f.seedTask('build');
    const review = await f.seedTask('review');
    await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    const built = await f.runtime.buildContext({
      companyId: COMPANY,
      runId,
      taskId: work,
      reviewTaskId: review,
      actorId: ACTOR,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const findings = built.value.review?.['findings'];
    expect(Array.isArray(findings)).toBe(true);
    for (const finding of findings as readonly Record<string, unknown>[]) {
      expect(String(finding['summary']).length).toBeLessThanOrEqual(400);
      // A finding's full detail never enters the context: the finding id is the address.
      expect(finding['detail']).toBeUndefined();
    }
    const serialized = JSON.stringify(built.value);
    expect(serialized).not.toContain('The reviewed diff edits a frozen interface.');
  });
});

describe('T18-06 supervisor decision runtime — proposal (23–34)', () => {
  const seedTurn = async (
    f: Fixture,
    structured: unknown,
  ): Promise<Result<unknown, DomainError>> => {
    const { runId } = await f.runWithGoal(`proposal${String(++seq)}`);
    const taskId = await f.seedTask('build');
    f.model.structured = structured;
    return (await f.runtime.runOneSupervisorDecisionTurn(
      turnOf({ runId, taskId }),
    )) as unknown as Result<unknown, DomainError>;
  };

  it('23. a non-object proposal is refused', async () => {
    const f = makeFixture();
    await f.runWithGoal('seed23');
    const result = await seedTurn(f, 'CONTINUE');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_INVALID');
  });

  it('24. a wrong proposal schema is refused', async () => {
    const f = makeFixture();
    const result = await seedTurn(f, proposal({ schema: 'companyos/other/1' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_SCHEMA_UNSUPPORTED');
  });

  it('25. a missing proposal key is refused', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('missingkey');
    const taskId = await f.seedTask('build');
    const partial: Record<string, unknown> = proposal();
    delete partial['summary'];
    f.model.structured = partial;
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_FIELD_MISSING');
    expect(result.error.details['key']).toBe('summary');
  });

  it('26. an unknown proposal action is refused', async () => {
    const f = makeFixture();
    const result = await seedTurn(f, proposal({ action: 'REBOOT_EVERYTHING' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_ACTION_INVALID');
  });

  it('27. an unknown proposal reason is refused', async () => {
    const f = makeFixture();
    const result = await seedTurn(f, proposal({ reasonCode: 'VIBES' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_REASON_INVALID');
  });

  it('28. an empty summary is refused', async () => {
    const f = makeFixture();
    const result = await seedTurn(f, proposal({ summary: '   ' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_SUMMARY_INVALID');
  });

  it('29. evidenceRefs must be an array within the bound', async () => {
    const f = makeFixture();
    const result = await seedTurn(f, proposal({ evidenceRefs: 'artifact:art_1' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_EVIDENCE_INVALID');
    const second = await seedTurn(
      f,
      proposal({
        evidenceRefs: Array.from({ length: 33 }, (_u, index) => `artifact:art_${String(index)}`),
      }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_EVIDENCE_INVALID');
  });

  it('30. a proposal may only concern the subject task of its context', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('foreignsubject');
    const subject = await f.seedTask('build');
    const other = await f.seedTask('review');
    f.model.structured = proposal({ subject: { taskId: other } });
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId: subject }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_SUBJECT_FOREIGN');
    expect((await f.decisionRows()).length).toBe(0);
  });

  it('31. no substring extraction: prose around a payload is not repaired', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('prose');
    const taskId = await f.seedTask('build');
    // A model that answers in prose while the contract asked for structured JSON.
    f.model.structured = null;
    f.model.outputText = `Sure! Here is my proposal: ${JSON.stringify(proposal())} — hope that helps.`;
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_FAILED');
    // No decision was manufactured out of prose: the durable decision count stays zero.
    expect((await f.decisionRows()).length).toBe(0);
    const row = (await f.executionRows())[0];
    expect(row?.['status']).toBe('FAILED');
  });

  it('32. CONTINUE is illegal while a blocking condition stands', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('continueblocked');
    const work = await f.seedTask('build');
    const review = await f.seedTask('review');
    await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(
      turnOf({ runId, taskId: work, reviewTaskId: review }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_CONTINUE_BLOCKED');
  });

  it('33. ESCALATE is illegal without a blocking condition', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('escalateplain');
    const work = await f.seedTask('build');
    f.model.structured = proposal({
      action: 'ESCALATE',
      reasonCode: 'HUMAN_REQUIRED',
      evidenceRefs: ['val_missing'],
    });
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId: work }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_ESCALATE_UNJUSTIFIED');
  });

  it('34. COMPLETE requires completion provenance AND passing validation', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('completeunproven');
    const work = await f.seedTask('build', { state: 'DONE' });
    // A completed task with a FAILING latest validation still proves nothing: the blocking
    // condition is refused first, exactly as the rules order it.
    await f.seedValidation({ runId, status: 'fail' });
    f.model.structured = proposal({ action: 'COMPLETE', evidenceRefs: ['val_missing'] });
    const blocked = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId: work }));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_COMPLETE_BLOCKED');
    // Without completion provenance at all, the task state is refused (a run with no
    // validation, so nothing else blocks first).
    const { runId: clean } = await f.runWithGoal('completenotdone');
    const pending = await f.seedTask('build');
    f.model.structured = proposal({ action: 'COMPLETE', evidenceRefs: ['val_missing'] });
    const unproven = await f.runtime.runOneSupervisorDecisionTurn(
      turnOf({ runId: clean, taskId: pending }),
    );
    expect(unproven.ok).toBe(false);
    if (unproven.ok) return;
    expect(unproven.error.details['reason']).toBe('SUPERVISOR_PROPOSAL_COMPLETION_MISSING');

    const { runId: second } = await f.runWithGoal('completeproven');
    // T20-03A: the proving task must belong to THIS run (ownership is runId equality — the
    // first run's task may no longer serve as the second run's COMPLETE subject).
    const provenWork = await f.seedTask('build', { state: 'DONE' });
    const passing = await f.seedValidation({ runId: second, status: 'pass' });
    f.model.structured = proposal({ action: 'COMPLETE', evidenceRefs: [passing] });
    const good = await f.runtime.runOneSupervisorDecisionTurn(
      turnOf({ runId: second, taskId: provenWork }),
    );
    expect(good.ok).toBe(true);
  });
});

describe('T18-06 supervisor decision runtime — no side effects (35–42)', () => {
  it('35. a successful turn produces ZERO tool invocations', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('notools');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(true);
    expect(f.toolInvocationCount()).toBe(0);
    expect(f.validationCount()).toBe(0);
  });

  it('36. the provider request declares NO tools', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('notoolsdeclared');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(true);
    expect(f.model.requests.length).toBe(1);
    const request = f.model.requests[0];
    expect(request?.tools === undefined || request.tools.length === 0).toBe(true);
    // The structured contract WAS requested: the proposal is a schema, not prose.
    expect(request?.responseFormat?.mode).toBe('json_schema');
  });

  it('37. the provider is invoked exactly once per turn', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('once');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(f.model.requests.length).toBe(1);
    // A rejected proposal does not trigger a second invocation either.
    f.model.structured = proposal({ action: 'COMPLETE' });
    const second = await f.runtime.runOneSupervisorDecisionTurn(
      turnOf({ runId, taskId, identity: 'second' }),
    );
    expect(second.ok).toBe(false);
    expect(f.model.requests.length).toBe(2);
  });

  it('38. no run, stage or task transition happened', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('notransition');
    const taskId = await f.seedTask('build');
    const runBefore = await f.db.runs.get(runId as never);
    const taskBefore = await f.db.tasks.get(taskId as never);
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(true);
    const runAfter = await f.db.runs.get(runId as never);
    const taskAfter = await f.db.tasks.get(taskId as never);
    expect(runAfter?.state).toBe(runBefore?.state);
    expect(runAfter?.revision).toBe(runBefore?.revision);
    expect(taskAfter?.state).toBe(taskBefore?.state);
    // The ONE task row of the run is still the only one: nothing was provisioned.
    expect(f.taskCount()).toBe(1);
  });

  it('39. REQUEST_CORRECTIVE provisions NO corrective work — it only records', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('requestonly');
    const work = await f.seedTask('build');
    const review = await f.seedTask('review');
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    f.model.structured = proposal({
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'The reviewer requires corrective work.',
      evidenceRefs: [`artifact:${reportId}`],
      subject: { taskId: work },
    });
    const result = await f.runtime.runOneSupervisorDecisionTurn(
      turnOf({ runId, taskId: work, reviewTaskId: review }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.action).toBe('REQUEST_CORRECTIVE');
    // One decision recorded, zero new tasks. The two executions are the DUrable reviewer
    // execution the report came from and this turn's own supervisor execution — nothing else.
    expect(f.taskCount()).toBe(2);
    expect((await f.executionRows()).length).toBe(2);
    expect((await f.decisionRows()).length).toBe(1);
  });

  it('40. a replay of the same turn identity performs ZERO extra model calls', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('replay');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const first = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.decisionId).toBe(first.value.decisionId);
    expect(second.value.executionId).toBe(first.value.executionId);
    expect(f.model.requests.length).toBe(1);
    expect((await f.executionRows()).length).toBe(1);
    expect((await f.decisionRows()).length).toBe(1);
  });

  it('41. another company is indistinguishable from a missing run', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('tenant');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn({
      ...turnOf({ runId, taskId }),
      companyId: 'company_other',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(f.model.requests.length).toBe(0);
  });

  it('42. a DIFFERENT turn identity records a second decision (no accidental dedupe)', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('twoslots');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const first = await f.runtime.runOneSupervisorDecisionTurn(
      turnOf({ runId, taskId, identity: 'slot-a' }),
    );
    const second = await f.runtime.runOneSupervisorDecisionTurn(
      turnOf({ runId, taskId, identity: 'slot-b' }),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.decisionId).not.toBe(second.value.decisionId);
    expect((await f.decisionRows()).length).toBe(2);
    expect((await f.executionRows()).length).toBe(2);
  });
});

describe('T18-06 supervisor decision runtime — cancellation + timeout (43–52)', () => {
  it('43. an already-aborted signal: zero model calls, zero decisions, zero executions', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('preaborted');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const controller = new AbortController();
    controller.abort();
    const result = await f.runtime.runOneSupervisorDecisionTurn({
      ...turnOf({ runId, taskId }),
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED');
    expect(f.model.requests.length).toBe(0);
    expect((await f.decisionRows()).length).toBe(0);
    expect((await f.executionRows()).length).toBe(0);
  });

  it('44. an abort before the model call cancels the durable execution', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('abortbefore');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const controller = new AbortController();
    // The execution exists (READY) and the turn is about to call the model: the deadline(?) —
    // here the caller — expires exactly there. The model is never reached.
    const runtime = f.withDeps({
      agentRuntime: {
        ...f.agentRuntime,
        runWithOutput: (): Promise<Result<never, DomainError>> => {
          controller.abort();
          return Promise.resolve(err(domainError('CANCELLED', 'cancelled before the model call.')));
        },
      },
    });
    const result = await runtime.runOneSupervisorDecisionTurn({
      ...turnOf({ runId, taskId }),
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED');
    expect(result.error.details['reason']).toBe('SUPERVISOR_TURN_CANCELLED');
    expect(f.model.requests.length).toBe(0);
    expect((await f.decisionRows()).length).toBe(0);
    // The durable execution says CANCELLED — it never dangles READY.
    const row = (await f.executionRows())[0];
    expect(row?.['status']).toBe('CANCELLED');
  });

  it('45. an abort DURING the model call abandons the turn: zero decisions', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('midflight');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    // The deadline expires while the model call is in flight — through the injected timer,
    // never through wall clock, so the outcome cannot race any other await in the turn.
    f.model.onInvoke = () => f.timers.fireAll();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TIMEOUT');
    expect(result.error.details['reason']).toBe('SUPERVISOR_TURN_TIMEOUT');
    // The model WAS reached, but nothing was decided and the execution says CANCELLED.
    expect(f.model.requests.length).toBe(1);
    expect((await f.decisionRows()).length).toBe(0);
    const row = (await f.executionRows())[0];
    expect(row?.['status']).toBe('CANCELLED');
  });

  it('46. an abort BEFORE the commit leaves zero decisions', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('beforecommit');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const controller = new AbortController();
    // The crash window between "the proposal is valid" and "the Decision is durable": the
    // sink aborts instead of writing, exactly as a cancellation landing there would.
    const decorated: SupervisorDecisionSink = {
      ...f.sink,
      record: (): Promise<Result<never, DomainError>> => {
        controller.abort();
        return Promise.resolve(
          err(domainError('PERSISTENCE_FAILED', 'the turn was cancelled before the commit.')),
        );
      },
    };
    const runtime = f.withDeps({ decisionSink: decorated, decisionHistory: decorated });
    const result = await runtime.runOneSupervisorDecisionTurn({
      ...turnOf({ runId, taskId }),
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED');
    // Nothing durable: no decision, and the execution is not completed.
    expect((await f.decisionRows()).length).toBe(0);
    const row = (await f.executionRows())[0];
    expect(row?.['status']).not.toBe('COMPLETED');
  });

  it('47. an abort AFTER the commit keeps the Decision durable and replays idempotently', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('aftercommit');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const controller = new AbortController();
    const realRecord = f.sink.record.bind(f.sink);
    // A sink that performs the REAL durable write and only then lets the turn be cancelled:
    // the late-cancellation window. The Decision must stand; the turn must not claim success.
    const decorated: SupervisorDecisionSink = {
      ...f.sink,
      record: async (command: Parameters<SupervisorDecisionSink['record']>[0]) => {
        const written = await realRecord(command);
        controller.abort();
        return written;
      },
    };
    const runtime = f.withDeps({ decisionSink: decorated, decisionHistory: decorated });
    const result = await runtime.runOneSupervisorDecisionTurn({
      ...turnOf({ runId, taskId }),
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED');
    // The Decision IS durable. F5 (release-blocker closure): a LIVE cancellation that won
    // after the commit settles the execution with the real provider result — a stale
    // RUNNING row may never wait for a restart when the truth is already known. (The
    // CRASH window itself — a process death at the commit checkpoint — remains the
    // existing recovery model's; see the T18-08 suites.)
    const decisions = await f.decisionRows();
    expect(decisions.length).toBe(1);
    const row = (await f.executionRows())[0];
    expect(row?.['status']).toBe('COMPLETED');
    // A retry with the SAME identity replays it: zero extra model calls, same decision.
    const replay = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.decisionId).toBe(decisions[0]?.['decision_id']);
    expect(f.model.requests.length).toBe(1);
    expect((await f.decisionRows()).length).toBe(1);
  });

  it('48. the whole-turn timeout is enforced', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('timeout');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    f.model.onInvoke = () => f.timers.fireAll();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TIMEOUT');
    expect((await f.decisionRows()).length).toBe(0);
    // The injected timer was released: no deadline outlives the turn.
    expect(f.timers.pendingCount()).toBe(0);
  });

  it('49. a caller cannot widen the whole-turn bound', async () => {
    const f = makeFixture({ maxTimeoutMs: 10 });
    const { runId } = await f.runWithGoal('capped');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    // Firing the installed deadline mid-flight proves WHICH deadline was installed.
    f.model.onInvoke = () => f.timers.fireAll();
    const result = await f.runtime.runOneSupervisorDecisionTurn({
      ...turnOf({ runId, taskId }),
      timeoutMs: 60_000,
    });
    // The caller asked for 60s; the composition's ceiling is 10ms, and 10ms is what fires.
    expect(f.timers.installedMs()).toContain(10);
    expect(f.timers.installedMs()).not.toContain(60_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TIMEOUT');
    expect((await f.decisionRows()).length).toBe(0);
  });

  it('50. the deadline timer is released when the turn ends normally', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('released');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(true);
    expect(f.timers.pendingCount()).toBe(0);
  });

  it('51. a provider failure fails the execution and records no decision', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('providerfail');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    f.model.failWith = domainError('AGENT_UNAVAILABLE', 'The fake provider is down.', {
      details: { kind: 'PROVIDER_UNAVAILABLE' },
    });
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    const row = (await f.executionRows())[0];
    expect(row?.['status']).toBe('FAILED');
    expect(row?.['error_kind']).toBe('PROVIDER_UNAVAILABLE');
    expect((await f.decisionRows()).length).toBe(0);
  });

  it('52. recovery marks an abandoned execution INTERRUPTED and never re-invokes a provider', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('recovery');
    const taskId = await f.seedTask('build');
    // A turn that died between the model call and its settlement leaves a RUNNING execution.
    const made = await createExecution({
      executionId: ids.id('exc'),
      agentId: 'supervisor-runtime',
      roleId: 'supervisor-runtime' as never,
      taskId: taskId as never,
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
    await f.db.agentExecutions.put({ ...made.value, status: 'RUNNING' as never });
    const callsBefore = f.model.requests.length;
    expect(callsBefore).toBe(0);

    // A restart over the SAME durable files, then the real recovery: the row becomes
    // INTERRUPTED and the provider is never called again.
    const restarted = f.restart();
    expect(restarted.agentRuntime).toBeDefined();
    const recovered = await restarted.agentRuntime.recoverInterrupted(ACTOR);
    expect(recovered.ok).toBe(true);
    const rows = await f.executionRows();
    expect(rows[0]?.['status']).toBe('INTERRUPTED');
    expect(f.model.requests.length).toBe(0);
  });
});

/**
 * T18-06 corrective (§12–§14 of the review): the four supervisor-level items of the mandatory
 * cancellation matrix. The provider-level items (1,2,3,5,6,7,8,9,10,13,15) live in
 * `tests/sprint18/provider-abort-propagation.test.ts`.
 *
 * These prove the turn's signal reaches a GENUINELY PENDING model call and terminates it —
 * not that the Supervisor merely stopped waiting for it.
 */
describe('T18-06 corrective — the turn signal terminates the provider (4, 11, 12, 14)', () => {
  it('4. an abort during the model call reaches the provider, records no Decision', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('realmidflight');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    // The model call is genuinely in flight (30s of scripted pending) when the deadline fires.
    f.model.pendingMs = 30_000;
    f.model.onInvoke = () => f.timers.fireAll();
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TIMEOUT');
    expect(result.error.details['reason']).toBe('SUPERVISOR_TURN_TIMEOUT');
    // The provider was reached, SAW the signal, observed it fire and stopped the invocation.
    expect(f.model.requests.length).toBe(1);
    expect(f.model.signalObservations).toBe(1);
    expect(f.model.abortObservations).toBe(1);
    expect(f.model.cancellations).toBe(1);
    // Nothing was decided, and the execution is terminal non-success carrying the canonical
    // F5-D: a cancelled invocation settles through the ONE canonical CANCELLED
    // transition — deterministic whichever writer (runtime catch / caller cancel) arrives
    // first, with the structured error fields preserved.
    expect((await f.decisionRows()).length).toBe(0);
    const row = (await f.executionRows())[0];
    expect(String(row?.['status'])).toBe('CANCELLED');
    expect(String(row?.['error_kind'])).toBe('CANCELLED');
    expect(String(row?.['error_code'])).toBe('CANCELLED');
  });

  it('11. a late abort after the Decision commit leaves the Decision authoritative', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('latereal');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const controller = new AbortController();
    // A sink that performs the REAL durable write and only then lets the turn be cancelled:
    // the late-cancellation window, driven through the real commit path.
    const realRecord = f.sink.record.bind(f.sink);
    const decorated = {
      ...f.sink,
      record: async (command: Parameters<SupervisorDecisionSink['record']>[0]) => {
        const written = await realRecord(command);
        controller.abort();
        return written;
      },
    } as SupervisorDecisionSink;
    const runtime = f.withDeps({ decisionSink: decorated, decisionHistory: decorated });
    const result = await runtime.runOneSupervisorDecisionTurn({
      ...turnOf({ runId, taskId }),
      signal: controller.signal,
    });
    // The turn reports the cancellation; it never claims a completion that did not happen.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANCELLED');
    // The committed Decision stands and is never duplicated or rolled back.
    const decisions = await f.decisionRows();
    expect(decisions.length).toBe(1);
    // And the same identity replays it with zero model calls (item 12, through the same path).
    const calls = f.model.requests.length;
    const replay = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(f.model.requests.length).toBe(calls);
    expect((await f.decisionRows()).length).toBe(1);
  });

  it('12. replay after a committed Decision creates zero new model invocations', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('replayreal');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    const first = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const providerCalls = f.model.requests.length;
    const executionCount = (await f.executionRows()).length;
    const replay = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.decisionId).toBe(first.value.decisionId);
    expect(replay.value.executionId).toBe(first.value.executionId);
    expect(f.model.requests.length).toBe(providerCalls);
    expect((await f.executionRows()).length).toBe(executionCount);
    expect((await f.decisionRows()).length).toBe(1);
  });

  it('14. the whole turn releases its deadline timer even when it ends cancelled', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('timerreal');
    const taskId = await f.seedTask('build');
    f.model.structured = proposal();
    f.model.pendingMs = 30_000;
    f.model.onInvoke = () => f.timers.fireAll();
    await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId }));
    // No deadline outlives the turn, on either exit path.
    expect(f.timers.pendingCount()).toBe(0);
    const controller = new AbortController();
    controller.abort();
    await f.runtime.runOneSupervisorDecisionTurn({
      ...turnOf({ runId, taskId, identity: 'aborted' }),
      signal: controller.signal,
    });
    expect(f.timers.pendingCount()).toBe(0);
  });
});

/* ============================================================================
 * FINAL-P1 corrective-cause citation — the recorded Decision of a VALIDATION_FAILED
 * corrective must carry the failing validation LINE itself (branded `val_<ulid>`), so
 * the corrective provisioner resolves the cause from the validation row, never from an
 * executor-output artifact. The live Stage-4 P1 (CORRECTIVE_AUTONOMY_REDRIVE_EXHAUSTION)
 * turned on exactly this: the proposal legally cited one of the validation's evidence
 * ARTIFACTS, the Decision was recorded without the ValidationId, and the provisioner
 * refused the cause (KIND_MISMATCH) — leaving the run stalled in REWORK forever.
 * ========================================================================== */
describe('FINAL-P1 supervisor corrective-cause citation', () => {
  it('a VALIDATION_FAILED proposal citing only the validation evidence artifact still records the ValidationId in the durable envelope', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('correctivecitation');
    const work = await f.seedTask('build', { state: 'DONE' });
    const review = await f.seedTask('review');
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    // The failing validation cites the review-report artifact as its own evidence — the
    // only thing the model cites below.
    const validationId = await f.seedValidation({
      runId,
      status: 'fail',
      evidenceRefs: [`artifact:${reportId}`],
    });
    f.model.structured = proposal({
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'VALIDATION_FAILED',
      summary: 'The grounding validation failed; corrective work is required.',
      evidenceRefs: [`artifact:${reportId}`],
      subject: { taskId: work },
    });
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId: work }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decisions = await f.decisionRows();
    expect(decisions.length).toBe(1);
    const envelope = JSON.parse(String(decisions[0]?.['metadata_json'])).supervisor as {
      evidenceRefs: readonly { kind: string; ref: string; id: string }[];
    };
    const refs = envelope.evidenceRefs.map((entry) => entry.ref);
    expect(refs).toContain(`artifact:${reportId}`); // what the model cited — preserved
    expect(refs).toContain(validationId); // the canonical corrective cause — appended
    const validationRef = envelope.evidenceRefs.find((entry) => entry.ref === validationId);
    expect(validationRef?.kind).toBe('validation');
  });

  it('a VALIDATION_FAILED proposal that already cites the ValidationId records it exactly once', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('correctivecited');
    const work = await f.seedTask('build', { state: 'DONE' });
    const validationId = await f.seedValidation({ runId, status: 'fail' });
    f.model.structured = proposal({
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'VALIDATION_FAILED',
      summary: 'The validation failed.',
      evidenceRefs: [validationId],
      subject: { taskId: work },
    });
    const result = await f.runtime.runOneSupervisorDecisionTurn(turnOf({ runId, taskId: work }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const envelope = JSON.parse(
      String((await f.decisionRows())[0]?.['metadata_json']),
    ).supervisor as { evidenceRefs: readonly { kind: string; ref: string }[] };
    expect(envelope.evidenceRefs.filter((entry) => entry.ref === validationId).length).toBe(1);
  });

  it('a non-validation corrective (REVIEW_FINDING) is untouched by the citation augmentation', async () => {
    const f = makeFixture();
    const { runId } = await f.runWithGoal('reviewonly');
    const work = await f.seedTask('build');
    const review = await f.seedTask('review');
    const reportId = await f.seedReviewReport({
      runId,
      reviewTaskId: review,
      subjectTaskId: work,
      verdict: 'CHANGES_REQUESTED',
    });
    await f.seedValidation({ runId, status: 'fail' });
    f.model.structured = proposal({
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'The reviewer requires changes.',
      evidenceRefs: [`artifact:${reportId}`],
      subject: { taskId: work },
    });
    const result = await f.runtime.runOneSupervisorDecisionTurn(
      turnOf({ runId, taskId: work, reviewTaskId: review }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const envelope = JSON.parse(
      String((await f.decisionRows())[0]?.['metadata_json']),
    ).supervisor as { evidenceRefs: readonly { ref: string }[] };
    // Exactly the cited report — no validation ref is invented for a review cause.
    expect(envelope.evidenceRefs.map((entry) => entry.ref)).toEqual([`artifact:${reportId}`]);
  });
});
