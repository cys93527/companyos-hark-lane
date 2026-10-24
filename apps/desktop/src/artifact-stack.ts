/**
 * Sprint 13 (Task-13-11) — the production artifact/CAS composition for the desktop
 * shell, kept ELECTRON-FREE on purpose: the object graph the shell actually runs is
 * the object graph these tests exercise (composition-root wiring assertions).
 *
 * Two frozen phases (startup ordering, Task-13-11 §11):
 *
 *   Phase 1 — `openArtifactFoundation` runs at QUIESCENT STARTUP, before the window,
 *     the IPC handlers and the workflow API exist, so there are no concurrent artifact
 *     writes. It builds the CAS content store + read-only diagnostics + reconciler over
 *     the durable artifact rows and runs ONE reconciliation. A fatal integrity finding
 *     returns `ok:false` — the shell must FAIL STARTUP CLOSED (never a "partially
 *     healthy" runtime, never a warn-and-continue).
 *
 *   Phase 2 — `composeSprint13Application` runs during workflow composition, before the
 *     API answers its first command: ArtifactService, ValidatorResolver,
 *     ValidationService, the run-fixed evidence gate and the durable reference resolver,
 *     all wired to the REAL authorization service (an allow-all stub is forbidden here).
 *
 * Policy lives in the services; this module only wires. No cleanup capability is
 * assembled anywhere (ADR-0015 as revised: reconciliation is DETECT/REPORT ONLY —
 * no unlink/remove/delete/repair exists in this object graph).
 */
import {
  type Task,
  domainError,
  err,
  ok,
  validatorIdsOf,
  type ArtifactContentDiagnosticsPort,
  type ArtifactContentStore,
  type ArtifactStorePort,
  type CasDiagnosticsSnapshot,
  type Clock,
  type CommandLedgerPort,
  type DomainError,
  type EventStorePort,
  type IdFactory,
  type Result,
  type UnitOfWork,
  type ValidationStorePort,
} from '@companyos/core';
import {
  createArtifactCasReconciler,
  createArtifactService,
  createScriptedRegistry,
  createValidationEvidenceGuard,
  createValidationService,
  createValidatorResolver,
  createWorkflowEngine,
  createRunSnapshotVerifier,
  resolveDurableReferences,
  type ArtifactCasReconciler,
  type ArtifactService,
  type GateStagePolicy,
  type ReconciliationReport,
  type StageHandler,
  type StageHandlerRegistry,
  type ToolRegistry,
  type ValidationEvidenceGuard,
  type ValidationService,
  type ValidatorResolver,
  type WorkflowEngine,
  type WorkflowEngineDeps,
} from '@companyos/engine';
import {
  createFilesystemArtifactContentDiagnostics,
  createFilesystemArtifactContentStore,
  type DurableDatabase,
} from '@companyos/persistence';
import type { Logger } from '@companyos/observability';

/* ------------------------------------------------------------------ phase 1 */

export type DurableReferenceResolver = (
  refs: readonly string[],
) => Promise<
  Result<
    readonly {
      readonly kind: string;
      readonly id: string;
      readonly ref: string;
      /** The row's durable run anchor — the Agent/Tool seams verify run ownership. */
      readonly runId: string;
    }[],
    DomainError
  >
>;

/**
 * The ONE durable-reference resolver shared by the Agent / Tool / Handoff / Decision
 * seams (Task-13-09) and by the Sprint 13 composition. Identity-only resolution over
 * the durable artifact/validation rows: no CAS reads, no gate evaluation. Each result
 * carries the row's run anchor, so the execution seams can fail closed on cross-run
 * references; a row that vanishes mid-resolution is a DENIAL, never a skip.
 */
export function createDurableReferenceResolver(database: DurableDatabase): DurableReferenceResolver {
  if (database.artifactStore === null || database.validationStore === null) {
    throw new Error('The "artifact" migration chain is not enabled: durable reference resolution is unavailable.');
  }
  const artifactStore: ArtifactStorePort = database.artifactStore;
  const validationStore: ValidationStorePort = database.validationStore;
  return async (refs) => {
    const resolved = await resolveDurableReferences(refs, { artifactStore, validationStore });
    if (!resolved.ok) return err(resolved.error);
    const anchored: { kind: string; id: string; ref: string; runId: string }[] = [];
    for (const reference of resolved.references) {
      if (reference.kind === 'artifact') {
        const row = await artifactStore.get(reference.id as never);
        if (row === null) {
          return err(
            domainError('NOT_FOUND', `Referenced artifact "${reference.ref}" vanished during resolution.`, {
              reason: 'ARTIFACT_REFERENCE_MISSING',
              reference: reference.ref,
            }),
          );
        }
        anchored.push({ kind: reference.kind, id: reference.id, ref: reference.ref, runId: row.runId });
        continue;
      }
      const row = await validationStore.get(reference.id as never);
      if (row === null) {
        return err(
          domainError('NOT_FOUND', `Referenced validation "${reference.ref}" vanished during resolution.`, {
            reason: 'VALIDATION_REFERENCE_MISSING',
            reference: reference.ref,
          }),
        );
      }
      anchored.push({ kind: reference.kind, id: reference.id, ref: reference.ref, runId: row.runId });
    }
    return ok(anchored);
  };
}

const ZERO_REPORT: ReconciliationReport = {
  artifactsChecked: 0,
  uniqueReferencedContent: 0,
  managedCasObjectsSeen: 0,
  orphanCasObserved: 0,
  stagingResidueObserved: 0,
  unknownEntriesObserved: 0,
  sizeChecksPerformed: 0,
  orphans: [],
  staging: [],
  unknown: [],
  fatal: [],
};

export type ArtifactFoundation =
  | {
      readonly ok: true;
      readonly casRoot: string;
      readonly contentStore: ArtifactContentStore;
      readonly diagnostics: ArtifactContentDiagnosticsPort;
      readonly reconciler: ArtifactCasReconciler;
      readonly report: ReconciliationReport;
      readonly diagnosticsSnapshot: CasDiagnosticsSnapshot;
    }
  | { readonly ok: false; readonly report: ReconciliationReport; readonly error: DomainError };

/**
 * Phase 1 — quiescent-startup reconciliation gate. READ-ONLY over the durable rows and
 * the CAS namespace: no orphan is deleted, no staging entry is touched (detect/report
 * only). Non-fatal observations are logged and reported; the shell stays healthy.
 */
export async function openArtifactFoundation(input: {
  readonly casRoot: string;
  readonly database: DurableDatabase;
  readonly logger: Logger;
}): Promise<ArtifactFoundation> {
  const { casRoot, database, logger } = input;
  if (database.artifactStore === null || database.validationStore === null) {
    // Fail closed for the artifact capability set (precedent: the handoff chain guard).
    return {
      ok: false,
      report: ZERO_REPORT,
      error: domainError(
        'PERSISTENCE_FAILED',
        'The "artifact" migration chain is not enabled: artifact/CAS health cannot be guaranteed.',
        { reason: 'ARTIFACT_CHAIN_NOT_ENABLED' },
      ),
    };
  }

  // The SAME physical CAS root backs the content store and the diagnostics port.
  const contentStore = createFilesystemArtifactContentStore({ casRoot });
  const diagnostics = createFilesystemArtifactContentDiagnostics({ casRoot });
  const reconciler = createArtifactCasReconciler({
    artifactStore: database.artifactStore,
    contentDiagnostics: diagnostics,
    contentVerifier: contentStore,
  });

  const outcome = await reconciler.reconcile();
  if (!outcome.ok) {
    logger.error('artifact CAS reconciliation FATAL — failing startup closed', {
      casRoot,
      reason: outcome.error.code,
      message: outcome.error.message,
      artifactsChecked: outcome.report.artifactsChecked,
      fatal: outcome.report.fatal,
    });
    return { ok: false, report: outcome.report, error: outcome.error };
  }

  const diagnosticsSnapshot = diagnostics.snapshot();
  logger.info('artifact CAS reconciled', {
    casRoot,
    artifactsChecked: outcome.report.artifactsChecked,
    managedCasObjectsSeen: outcome.report.managedCasObjectsSeen,
    orphanCasObserved: outcome.report.orphanCasObserved,
    stagingResidueObserved: outcome.report.stagingResidueObserved,
    unknownEntriesObserved: outcome.report.unknownEntriesObserved,
    // Detect/report only: observations are surfaced, never auto-removed.
    diagnosticsUnknownEntries: diagnosticsSnapshot.unknownEntries.length,
    diagnosticsReparseViolations: diagnosticsSnapshot.reparseViolations.length,
  });
  return { ok: true, casRoot, contentStore, diagnostics, reconciler, report: outcome.report, diagnosticsSnapshot };
}

/* ------------------------------------------------------------------ phase 2 */

export interface Sprint13CompositionInput {
  readonly database: DurableDatabase;
  /** The reconciled CAS content store from phase 1 — the only bytes authority. */
  readonly contentStore: ArtifactContentStore;
  readonly clock: Clock;
  readonly ids: IdFactory;
  /**
   * The REAL session authorization decision point (Role -> Authority). The composition
   * root adds no policy of its own; it only forwards the authority decision.
   */
  readonly authorize: (input: {
    readonly actorId: string;
    readonly authority: string;
    readonly scopeId?: string;
  }) => Promise<Result<true, DomainError>>;
  readonly tools: ToolRegistry;
  readonly logger: Logger;
  /**
   * T17-08: repository-capable stage handlers the host composed (Sprint 17). They take
   * precedence for the kinds they declare; every other kind keeps the scripted handler.
   */
  readonly stageHandlers?: ReadonlyMap<string, StageHandler>;
  readonly cancellation?: WorkflowEngineDeps['cancellation'];
  /**
   * Sprint21 (generic orchestration): optional engine seams for multi-stage DAG advance —
   * run-scoped task read and pinned-graph read. Absent ⇒ legacy single-stage completion
   * semantics (unit-test compositions).
   */
  /** Sprint21 final: the runtime owner token stamped on execution claims. */
  readonly runtimeInstanceId?: string;
  /** Sprint21 final migration: non-semantic fault-injection hooks on the claim timeline. */
  readonly faultCheckpoints?: { checkpoint(name: string): Promise<void> };
  readonly engineExtras?: {
    readonly tasksOfRun: (runId: string) => Promise<readonly Task[]>;
    readonly pinnedGraphOf: (
      runId: string,
    ) => Promise<
      Result<
        { readonly nodes: readonly { readonly id: string; readonly kind?: string }[]; readonly edges: readonly { readonly from: string; readonly to: string }[] },
        DomainError
      >
    >;
  };
}

export interface Sprint13Composition {
  readonly artifactService: ArtifactService;
  readonly validatorResolver: ValidatorResolver;
  readonly validationService: ValidationService;
  /** Run-FIXED stage policy: reads the pinned version, never the current template. */
  readonly stagePolicy: GateStagePolicy;
  readonly evidenceGuard: ValidationEvidenceGuard;
  readonly durableReferenceResolver: ReturnType<typeof createDurableReferenceResolver>;
  /** Exactly the engine's `validationGate` seam — wired, never optional, in production. */
  readonly engineValidationGate: NonNullable<WorkflowEngineDeps['validationGate']>;
  /**
   * T18-02: exactly the engine's `runSnapshotVerifier` seam. Every production stage
   * execution proves the run's pin before a single task write.
   */
  readonly runSnapshotVerifier: NonNullable<WorkflowEngineDeps['runSnapshotVerifier']>;
  /**
   * The production engine with the evidence gate REQUIRED. Stage handlers stay the
   * Sprint-2 sanctioned stubs (the engine's only handler form); engine dispatch is not
   * IPC-exposed, so no fake execution is reachable from the renderer.
   */
  readonly engine: WorkflowEngine;
}

/**
 * Phase 2 — service composition. Every write consumer shares the ONE durable database
 * (same artifact/validation rows, same event store, same command ledger, same unit of
 * work), so one command = one transaction across artifact + validation + engine writes.
 */
/** Repository handlers win for the kinds they declare; everything else stays scripted. */
const createComposedHandlerRegistry = (
  repositoryHandlers: ReadonlyMap<string, StageHandler>,
): StageHandlerRegistry => {
  const scripted = createScriptedRegistry({});
  return {
    resolve: (kind: string, branch: string | null): StageHandler | null =>
      repositoryHandlers.get(kind) ?? scripted.resolve(kind, branch),
  };
};

export function composeSprint13Application(input: Sprint13CompositionInput): Sprint13Composition {
  const { database, contentStore, clock, ids, authorize, tools, logger } = input;
  if (database.artifactStore === null || database.validationStore === null) {
    throw new Error('The "artifact" migration chain is not enabled: artifact persistence is unavailable.');
  }
  const artifactStore: ArtifactStorePort = database.artifactStore;
  const validationStore: ValidationStorePort = database.validationStore;
  const events: EventStorePort = database.events;
  const ledger: CommandLedgerPort = database.ledger;
  const unitOfWork: UnitOfWork = database.unitOfWork;
  const durableReferenceResolver = createDurableReferenceResolver(database);

  const artifactService = createArtifactService({
    artifactStore,
    contentStore,
    runs: database.runs,
    events,
    ledger,
    clock,
    ids,
    unitOfWork,
    authorize: ({ actorId, authority, runId }) => authorize({ actorId, authority, scopeId: runId }),
  });

  const validatorResolver = createValidatorResolver({ registry: tools });

  const validationService = createValidationService({
    resolver: validatorResolver,
    registry: tools,
    validationStore,
    artifactService,
    artifactStore,
    events,
    ledger,
    clock,
    ids,
    unitOfWork,
    authorize: ({ actorId, authority, runId }) => authorize({ actorId, authority, scopeId: runId }),
  });

  // R1-B: the gate's required validators come from the run's PINNED template version
  // graph node config — a later template edit or publish can never move an old run's
  // gate (run-fixed immutable stage snapshot, never the current template latest).
  const stagePolicy: GateStagePolicy = {
    requiredValidators: async ({ runId, stageId }) => {
      const run = await database.runs.get(runId as never);
      if (run === null) {
        return err(
          domainError('NOT_FOUND', `Run "${runId}" does not exist; the stage policy cannot be pinned.`, {
            reason: 'GATE_RUN_MISSING',
            runId,
            stageId,
          }),
        );
      }
      const template = await database.templates.get(run.templateId as never);
      if (template === null) {
        return err(
          domainError('NOT_FOUND', `Template "${String(run.templateId)}" is missing for a live run.`, {
            reason: 'GATE_TEMPLATE_MISSING',
            runId,
            stageId,
          }),
        );
      }
      const version = template.versions.find((entry) => entry.id === run.versionId);
      if (version === undefined) {
        return err(
          domainError('NOT_FOUND', `The run's pinned version "${String(run.versionId)}" is missing.`, {
            reason: 'GATE_VERSION_MISSING',
            runId,
            stageId,
          }),
        );
      }
      const node = version.graph.nodes.find((candidate) => candidate.id === stageId);
      if (node === undefined) {
        return err(
          domainError('NOT_FOUND', `Stage "${stageId}" is not part of the run's pinned version.`, {
            reason: 'GATE_STAGE_MISSING',
            runId,
            stageId,
          }),
        );
      }
      return ok(validatorIdsOf(node));
    },
  };

  const evidenceGuard = createValidationEvidenceGuard({ artifactStore, validationStore, stagePolicy });

  // T18-02: the ONE production run-pin verifier. It reads the durable RunSnapshot and the
  // run's pinned template version and calls Core's canonical `verifyRunSnapshot` — a
  // tampered or missing snapshot now fails closed BEFORE any stage execution, instead of
  // being trusted because the `snapshotId` string still matched.
  const runSnapshotVerifier = createRunSnapshotVerifier({
    templates: database.templates,
    snapshots: database.snapshots,
  });

  // One shared resolver for Agent / Tool / Handoff / Decision seams (Task-13-09):
  // resolve-ALL-before-write over the SAME durable stores, identity only.
  const engineValidationGate: NonNullable<WorkflowEngineDeps['validationGate']> = {
    evaluateGate: async ({ runId, stageId, artifactId, taskId }) => {
      const verdict = await evidenceGuard.evaluateGate(
        taskId === undefined ? { runId, stageId, artifactId } : { runId, stageId, artifactId, taskId },
      );
      if (!verdict.ok) return verdict;
      return ok(verdict.value.requiredRows.map((row) => ({ validatorId: row.validatorId })));
    },
  };

  const engine = createWorkflowEngine({
    ...(input.cancellation === undefined ? {} : { cancellation: input.cancellation }),
    ids,
    clock,
    runs: database.runs,
    events,
    approvals: database.approvals,
    tasks: database.tasks,
    // T17-08: repository handlers first, the scripted registry for everything else.
    handlers: input.stageHandlers === undefined || input.stageHandlers.size === 0
      ? createScriptedRegistry({})
      : createComposedHandlerRegistry(input.stageHandlers),
    ledger,
    unitOfWork,
    validationGate: engineValidationGate,
    // T18-02: every stage execution proves the run's pin first.
    runSnapshotVerifier,
    ...(input.engineExtras === undefined
      ? {}
      : {
          tasksOfRun: input.engineExtras.tasksOfRun,
          pinnedGraphOf: input.engineExtras.pinnedGraphOf,
        }),
    // Sprint21 final: the generic execution-claim owner + the runtime instance token.
    executionAttempts: {
      claim: (attempt) => database.executionAttempts.claim(attempt),
      reconcileLegacyInterrupted: (attempt) => database.executionAttempts.reconcileLegacyInterrupted(attempt),
      get: (attemptId) => database.executionAttempts.get(attemptId),
      byTaskAndAttempt: (taskId, attemptNumber) =>
        database.executionAttempts.byTaskAndAttempt(taskId, attemptNumber),
      activeOfTask: (taskId) => database.executionAttempts.activeOfTask(taskId),
      transition: (input2) => database.executionAttempts.transition(input2),
    },
    runtimeInstanceId: input.runtimeInstanceId,
    ...(input.faultCheckpoints === undefined ? {} : { faultCheckpoints: input.faultCheckpoints }),
  });

  logger.info('sprint 13 artifact/validation composition ready', {
    durable: true,
    sharedDatabase: true,
    evidenceGate: 'required',
    durableReferences: 'agent/tool/handoff/decision',
  });
  return {
    artifactService,
    validatorResolver,
    validationService,
    stagePolicy,
    evidenceGuard,
    durableReferenceResolver,
    engineValidationGate,
    runSnapshotVerifier,
    engine,
  };
}
