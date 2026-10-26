/**
 * The trusted application core composition (Sprint 17 — Task-17-08 extraction).
 *
 * Extracted from `main.ts` so the PRODUCTION entry point is importable without Electron: the
 * application bootstrap and the production E2E compose the SAME graph through this module —
 * the same tool registry, the same repository runtime, the same engine, ValidationService and
 * EvidenceGuard.
 *
 * The repository runtime is configured through ONE trusted, application-facing seam
 * (`options.repositoryRuntime`), whose default is the fail-closed shape: no task kind is
 * repository-capable and no workspace is open. A model, an agent payload, a workflow payload
 * and a pack manifest cannot reach this seam.
 */
import type { IsolationLaunchConfig } from './executor/isolation/isolated-launch-seam.js';
import {
  executionAttemptIdOf,
DomainError, SystemClock, UlidFactory, validatorIdsOf, domainError, type FaultCheckpointPort } from '@companyos/core';
import type { Logger } from '@companyos/observability';
import { createExecutionSafetyCoordinator, type GoalSafetyConfiguration } from './execution-safety-coordinator.js';
import { applyOperatorUsageReconciliations } from './usage-reconciliation.js';
import { createFileDeliveryPort, createVerifiedFileCarrier, fileDeliveriesOf, fileDeliveryToolRecord, FILE_DELIVERY_TOOL_ID, type FileDeliveryContext } from './verified-file-delivery.js';
import type { DurableDatabase } from '@companyos/persistence';
import {
  EVIDENCE_GROUNDING_SPEC,
  EVIDENCE_GROUNDING_TOOL_ID,
  REPO_TEST_CHECK_SPEC,
  REPO_TEST_CHECK_TOOL_ID,
  createEvidenceGroundingPort,
  createEvidenceGroundingRecord,
  createRepoTestCheckPort,
  createRepoTestCheckRecord,
} from '@companyos/engine';
import { runRepoTestContract } from './repo-test-process.js';
import type { KernelHealthReport } from './executor/kernel-health.js';
import {
  REPOSITORY_GIT_TOOL_SPEC,
  REPOSITORY_VALIDATION_EVIDENCE_SPEC,
  createPackAvailabilityPolicy,
  createRepositoryGitToolRecord,
  createRepositoryValidationEvidenceRecord,
  createRunPackProvenanceResolver,
  ensureBootstrapOwner,
  createAgentRuntime,
  createAuthorizationService,
  createEnvSecretVault,
  createModelRegistry,
  createProviderRegistry,
  createSelectionPolicyService,
  createToolRegistry,
  createMockTool,
  createMockToolRecord,
  createWorkflowLifecycle,
  createRunGoalService,
  createSupervisorDecisionRuntime,
  createSupervisorDecisionSink,
  createReviewFindingsSink,
  createCorrectiveProvisioner,
  createRunModelBindingReader,
  createAutonomousSupervisorRuntime,
  createStageOutputCarrier,
  REVIEW_CANDIDATE_KIND,
  REVIEW_VERDICTS,
  VALIDATION_CANDIDATE_KIND,
  createEvidenceLifecycleApplicator,
  latestCanonicalReportOf,
  correctiveCauseIdsOf,
  type CanonicalReportOrder,
  createPinnedAgentExecution,
  supervisorDecisionEvidenceOf,
  createWorkSessionRuntime,
  createSessionKernel,
  createBoundedAgentContext,
  createNormalTaskMaterializer,
  type PlanCompilationSpec,
    WORK_ROLE_OUTPUT_KIND,
  createRunObservationService,
  createExecutorProviderRegistry,
  resolveExecutorConfig,
  type ExecutorProvider,
  type ExecutorProviderRegistry,
  type TypedExecutorConfig,
  createRunObservationNotifier,
  createWorkPackageProjector,
  stageSubjectTaskOf,
  type WorkPackage,
  createPlanCompiler,
  createPlannerRuntime,
  decideBoundedContextBudget,
  MOCK_TOOL_SPECS,
  createHandoffService,
  executionRunIdOf,
  goalEnvelopeExhausted,
} from '@companyos/engine';
import { createGoalUsageService } from './efficiency/goal-usage-projection.js';
import { createDurableUsageReader } from './efficiency/durable-usage-reader.js';
import { createControlPlaneService, GOAL_WORK_KIND } from './control-plane.js';
import {deriveRetryContinuationEnvelope} from './executor/attempt-supervision.js';
import { resolveExecutionAttemptTimeoutMs } from './production-composition.js';
import { abortableSleep } from './runtime/model-call-sleep.js';
import {
  TOOL_CAPABILITY_VALIDATOR,
  applyTaskEvent,
  createCoreDomainEvent,
  createToolRecord,
  err,
  ok,
  runGoalCommandId,
  STAGE_OUTPUT_TASK_KEY,
  type Approval,
  type EntityStore,
  type Result,
  type StageHandlerOutput,
  type Task,
  type TaskEvent,
  type ToolPort,
} from '@companyos/core';
import type { StageHandler, StageHandlerReturn } from '@companyos/engine';

import {
  composeSprint13Application,
  createDurableReferenceResolver,
  type ArtifactFoundation,
} from './artifact-stack.js';
import { composeRepositoryRuntime, type RepositoryRuntime } from './repository-runtime.js';
import type { ModelPool } from './executor/model-pool.js';
import { RoleCatalog } from './executor/role-orchestration.js';
import type { ModelRoutingPolicyV1 } from './executor/smart-model-router.js';
import {
  resolveCanonicalRole,
  resolveProfessionalSeat,
  routeRuntimeAttempt,
  seedRoleCatalogFromCanonical,
} from './executor/runtime-routing.js';
import {
  consumerContextOfWorkPackage,
  recordRuntimeHandoff,
  type RuntimeHandoffMapping,
} from './executor/runtime-collaboration.js';
import {
  autonomyFingerprintOf,
  createGoalOutcomeAutonomyDriver,
  STANDING_ADMISSION_REFUSALS,
  userDecisionRequestFromApproval,
  type AutonomyDriverDeps,
  type DoctorCheck,
  type FinalOutcomeProjection,
  type GoalAutonomyState,
} from './autonomy/goal-outcome-autonomy-driver.js';

const SESSION_ACTOR = 'user_owner';

/**
 * The default pinned binding name the Supervisor runs under. It is TRUSTED APPLICATION
 * CONFIGURATION, not a model identity: a run that pins no binding under this name simply has
 * no supervisor turn (fail closed), and nothing in a model, agent, workflow or pack payload can
 * change it.
 */
const SUPERVISOR_BINDING_KEY = 'supervisor';

/**
 * STAGE 8B — parse the canonical `roles.required_capabilities` JSON column into
 * the catalog's capability list. A malformed column yields NO capabilities
 * (fail-closed) — a role never invents capabilities from unreadable data.
 */
const parseCapabilityList = (raw: unknown): readonly string[] => {
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string');
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * STAGE 8B §3 — resolve the CONSUMER seat of a producer task from the SAME
 * pinned WorkflowVersion DAG the Work Package projection reads (never a second
 * DAG): the successor stages of the producer's stage, their canonical subject
 * task, and that task's pinned execution seat. Null when the producer's stage
 * has no successor (terminal work) — a handoff is then simply not recorded.
 */
const successorSeatOf = async (
  database: {
    readonly runs: { get(runId: string): Promise<unknown> };
    readonly snapshots: { get(snapshotId: string): Promise<unknown> };
    readonly templates: { get(templateId: string): Promise<unknown> };
    readonly tasks: { listByRun(runId: string): Promise<readonly Task[]> };
  },
  runId: string,
  taskId: string,
): Promise<{ readonly stageId: string; readonly taskId: string; readonly roleId: string } | null> => {
  const run = (await database.runs.get(runId as never)) as { id: string; snapshotId: string } | null;
  if (run === null) return null;
  const snapshot = (await database.snapshots.get(String(run.snapshotId) as never)) as
    | { runId: string; templateId: string; workflowVersionId: string }
    | null;
  if (snapshot === null || String(snapshot.runId) !== String(run.id)) return null;
  const template = (await database.templates.get(String(snapshot.templateId) as never)) as
    | { versions: readonly { id: string; graph: unknown }[] }
    | null;
  if (template === null) return null;
  const version = template.versions.find((entry) => String(entry.id) === String(snapshot.workflowVersionId));
  if (version === undefined) return null;
  const runTasks = await database.tasks.listByRun(String(run.id));
  const producer = runTasks.find((row) => String(row.id) === taskId);
  if (producer === undefined) return null;
  const producerStageId = String(producer.stageId);
  const edges = (version.graph as { edges?: readonly { from: string; to: string }[] }).edges ?? [];
  const successorStageIds = [
    ...new Set(
      edges
        .filter((edge) => String(edge.from) === producerStageId)
        .map((edge) => String(edge.to)),
    ),
  ].sort();
  for (const stageId of successorStageIds) {
    const stageTasks = runTasks.filter((row) => String(row.stageId) === stageId);
    if (stageTasks.length === 0) continue;
    const subject = stageTasks.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))[0]!;
    return {
      stageId,
      taskId: String(subject.id),
      roleId: String(subject.roleId),
    };
  }
  return null;
};

/**
 * Sprint25 — the EXISTING run approval mechanism, reused as the authorization
 * source for a dispatch that would otherwise have no authority (a boundary
 * relaxing execution): the id of an APPROVED approval recorded for the run, or
 * null. There is deliberately no ad-hoc authorization boolean anywhere in this
 * composition — a capability that needs human permission must present a real
 * approval record from `approvals`, exactly the store `APPROVAL.GRANT` writes.
 */
const approvedApprovalReferenceOf = async (
  approvals: EntityStore<Approval>,
  runId: string,
): Promise<string | null> => {
  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const page = await approvals.list({ limit: pageSize, offset });
    const found = page.items.find((approval) => approval.runId === runId && approval.status === 'approved');
    if (found !== undefined) return found.id;
    if (offset + pageSize >= page.total) return null;
  }
};

/*
 * Agentic Work Package Contract — the WorkPackage → Work Envelope mapping. This is the
 * ONE place canonical work semantics cross onto the executor request: every field is a
 * byte-exact or clearly-labeled derivation of the projection, and NOTHING outside the
 * projection (renderer input, model rewrites, provider guesses) can enter here.
 *
 * Minimal-context law: the render carries the goal, the pinned acceptance criteria and
 * the read-only input references THIS task needs — never run history, sibling tasks,
 * sessions or cross-company state. The bounds below are hard stops, not suggestions.
 */
const WORK_ENVELOPE_LIMITS = {
  /** Bounded context lines in the memoryView render. */
  maxMemoryViewLines: 64,
  /** Total rendered characters across the memoryView lines. */
  maxMemoryViewChars: 16 * 1024,
  /** Read-only input artifact references carried on the envelope. */
  maxArtifactRefs: 64,
} as const;

const projectWorkEnvelope = (
  pkg: WorkPackage,
): {
  readonly objective: string;
  readonly memoryView: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly taskInputs: Readonly<Record<string, unknown>>;
  readonly acceptanceCriteria: readonly { readonly criterionId: string; readonly requirement: string }[];
} => {
  // Objective precedence: the byte-exact compiled plan-item objective; when a pinned
  // node somehow carries none, the run-owned canonical goal stands in — both are
  // canonical business semantics. A taskKind label is NEVER the objective.
  const objective = pkg.work.objective ?? pkg.goal.objective;

  const lines: string[] = [`Goal: ${pkg.goal.objective}`];
  if (pkg.acceptance.criteria.length > 0) {
    lines.push('Acceptance criteria (CompanyOS Validation owns the verdict, not the executor):');
    for (const criterion of pkg.acceptance.criteria) {
      lines.push(`- [${criterion.criterionId}] ${criterion.requirement}`);
    }
  }
  const artifactRefs = [
    ...new Set([
      ...pkg.dependencies.flatMap((dependency) => dependency.artifactRefs),
      ...(pkg.causal === null ? [] : pkg.causal.artifactRefs),
    ]),
  ].slice(0, WORK_ENVELOPE_LIMITS.maxArtifactRefs);
  if (artifactRefs.length > 0) {
    lines.push('Input artifact references (read-only):');
    for (const ref of artifactRefs) lines.push(`- ${ref}`);
  }
  const memoryView: string[] = [];
  let rendered = 0;
  for (const line of lines.slice(0, WORK_ENVELOPE_LIMITS.maxMemoryViewLines)) {
    if (rendered + line.length > WORK_ENVELOPE_LIMITS.maxMemoryViewChars) break;
    memoryView.push(line);
    rendered += line.length;
  }

  return {
    objective,
    memoryView,
    artifactRefs,
    taskInputs: pkg.work.taskInputs,
    acceptanceCriteria: pkg.acceptance.criteria,
    // The run-owned goal's structured constraints ride the envelope UNTOUCHED —
    // byte-exact from the run-goal artifact, never rendered, never model-authored.
    ...(pkg.goal.structured === null ? {} : { goalStructured: pkg.goal.structured }),
  };
};

/**
 * The trusted core of the application (Task-14-02 extraction): authorization (with
 * the bootstrap owner), secret vault, providers, model registry, selection policies,
 * the tool registry (registered + durable-reference-enforced) and the agent runtime,
 * plus the Sprint 13 composition that owns the production WorkflowEngine.
 *
 * Composed ONCE per process during quiescent startup — BEFORE startup recovery runs
 * and before any IPC/window exposure — and then reused by `buildWorkflowApi`, so
 * recovery and the normal runtime share the SAME instances (no second registry, no
 * second event store; ADR-0021 D10 / Task-14-02 §30/§31).
 */
export interface CoreServices {
  /** H15: the packaged agent kernel's first-start health report (null when no packaged kernel was checked). */
  readonly kernelHealth?: () => KernelHealthReport | null;
  readonly database: DurableDatabase;
  readonly clock: SystemClock;
  readonly ids: UlidFactory;
  readonly authz: ReturnType<typeof createAuthorizationService>;
  readonly sessionAuthorize: (input: {
    readonly actorId: string;
    readonly authority: string;
    readonly scopeId?: string;
  }) => Promise<
    | { readonly ok: true; readonly value: true }
    | { readonly ok: false; readonly error: DomainError }
  >;
  readonly vault: ReturnType<typeof createEnvSecretVault>;
  readonly providers: ReturnType<typeof createProviderRegistry>;
  readonly models: ReturnType<typeof createModelRegistry>;
  readonly policies: ReturnType<typeof createSelectionPolicyService>;
  readonly tools: ReturnType<typeof createToolRegistry>;
  readonly runtime: ReturnType<typeof createAgentRuntime>;
  readonly sprint13: ReturnType<typeof composeSprint13Application>;
  /**
   * Sprint 18 (T18-02): the workflow lifecycle service, composed here so the desktop
   * bootstrap and the tests share ONE production wiring — including the run-creation
   * replay ledger, the run-goal writer and the model-binding registry seam.
   */
  readonly lifecycle: ReturnType<typeof createWorkflowLifecycle>;
  /**
   * Sprint 18 (T18-03): the ONE supervisor decision sink — a trusted application service, not
   * an IPC channel and not a Tool. Null only when the durable decision or artifact chain is
   * absent, in which case no supervisor decision can be recorded at all.
   */
  readonly supervisorDecisionSink: ReturnType<typeof createSupervisorDecisionSink> | null;
  /**
   * Sprint 18 (T18-04): the ONE review findings sink. Null only when the artifact, agent or
   * goal chain is absent, in which case no review report can be recorded at all.
   */
  readonly reviewFindingsSink: ReturnType<typeof createReviewFindingsSink> | null;
  /**
   * Sprint 18 (T18-05): the controlled corrective provisioner. Null only when a required durable
   * chain is absent, in which case no corrective work item can be provisioned at all.
   */
  readonly correctiveProvisioner: ReturnType<typeof createCorrectiveProvisioner> | null;
  /**
   * Sprint 18 (T18-06): the ONE supervisor decision runtime — one bounded decision turn that
   * loads the run, verifies the pin, builds the bounded context, invokes the pinned model ONCE
   * with a structured contract and records the Decision through the T18-03 sink. It executes
   * NOTHING. Null only when a required durable chain is absent, in which case no supervisor
   * turn can run at all (never a degraded, binding-less turn).
   */
  readonly supervisorDecisionRuntime: ReturnType<typeof createSupervisorDecisionRuntime> | null;
  /**
   * Sprint 18 (T18-07): the ONE bounded autonomous supervisor runtime — the orchestration cycle
   * that turns a Decision into ONE canonical action (work unit / corrective / stop) and loops
   * under trusted bounds. It owns orchestration only and replaces none of the services below.
   * Null only when a required durable chain is absent, in which case no autonomous run exists.
   */
  readonly autonomousSupervisor: ReturnType<typeof createAutonomousSupervisorRuntime> | null;
  /** Task-18-07 corrective: `Task.outputs` → canonical sink carrier (one writer per domain). */
  readonly stageOutputCarrier: ReturnType<typeof createStageOutputCarrier> | null;
  /** Task-18-07 corrective: canonical evidence → legal Run lifecycle event. */
  readonly evidenceApplicator: ReturnType<typeof createEvidenceLifecycleApplicator> | null;
  /** Task-18-07 corrective: the ONLY autonomous model execution path (pinned, no override). */
  readonly pinnedAgentExecution: ReturnType<typeof createPinnedAgentExecution> | null;
  /** Sprint 20 (T20-03B): the trusted normal-task materializer (main-process only). */
  readonly normalTaskMaterializer: ReturnType<typeof createNormalTaskMaterializer> | null;
  /** Sprint 20 (T20-04): the generic planner runtime (main-process only). */
  readonly plannerRuntime: ReturnType<typeof createPlannerRuntime> | null;
  /** Sprint 20 (T20-05): the deterministic plan compiler (main-process only). */
  readonly planCompiler: ReturnType<typeof createPlanCompiler> | null;
  /**
   * Sprint 20 (T20-06): the Work Package projector — the DERIVED, bounded, deterministic
   * execution projection of one task (trusted main-process service; read-only, zero
   * provider calls, never IPC-exposed in T20-06). HandoffPacket remains owned by the
   * Sprint-11 HandoffService (main.ts); this projector only READS accepted packets.
   */
  readonly workPackageProjector: ReturnType<typeof createWorkPackageProjector> | null;
  /**
   * Sprint 23: the READ-ONLY run observation service (typed projections over canonical
   * truth — overview / task observation / blockers / timeline). Null only when a required
   * durable chain is absent, in which case no observation is served (fail closed). The
   * notifier is the non-authoritative "state changed; re-read" signal (never truth).
   */
  readonly runObservation: ReturnType<typeof createRunObservationService> | null;
  /** Sprint24: implementation-only provider registry (what exists / capabilities). */
  readonly executorProviders: ExecutorProviderRegistry | null;
  /** H15b: null when no native job operations were declared; otherwise registration status. */
  readonly nativeJobStatus: { readonly registered: boolean; readonly reasonCode: string | null; readonly detail: string | null } | null;
  readonly runObservationNotifier: ReturnType<typeof createRunObservationNotifier>;
  /**
   * Sprint26 — the Product Control Plane: the trusted application service behind the
   * Goal-to-Outcome desktop runtime. Composed from the SAME canonical services this
   * composition owns (lifecycle, engine, planner/compiler/supervisor, observation,
   * run-goal, artifacts); it holds no durable truth of its own. Null only when a
   * required durable chain is absent.
   */
  readonly controlPlane: ReturnType<typeof createControlPlaneService> | null;
  /**
   * STAGE 9 — the Goal-to-Outcome autonomy driver (a bounded application
   * service over the existing commands; never a second scheduler).
   */
  readonly autonomyDriver: ReturnType<typeof createGoalOutcomeAutonomyDriver> | null;
  /**
   * Sprint 19 (T19-02): the durable Session CONTEXT KERNEL — trusted process-internal
   * infrastructure, NOT integrated with any role (Developer/Reviewer/QA/Supervisor keep
   * their Sprint-18 behavior until T19-03+). Null when the `session` chain is absent.
   */
  readonly sessionKernel: ReturnType<typeof createSessionKernel> | null;
  /**
   * Sprint 19 (T19-03): the session-backed Developer runtime (null without the `session`
   * chain or the pinned execution path). Trusted process-internal; not a Tool, no IPC.
   */
  readonly developerSession: ReturnType<typeof createWorkSessionRuntime> | null;
  readonly durableReferenceResolver: ReturnType<typeof createDurableReferenceResolver>;
  /** Sprint 17 (T17-08): the production repository runtime this composition owns. */
  readonly repositoryRuntime: RepositoryRuntime;
  /** The last composition error (null when the core composed cleanly). */
  readonly compositionError: string | null;
  /**
   * Industry-pack live availability (T15-04 corrective). Constructed ONCE here and shared
   * by the authorization service (new role assignments) and the workflow lifecycle service
   * (new drafts / publishes / forks / runs); undefined only when the pack chain is absent.
   */
  readonly packAvailability: ReturnType<typeof createPackAvailabilityPolicy> | undefined;
  /**
   * Run pack provenance (T15-05). Derived once from the SAME pack stores and injected into
   * the workflow lifecycle service, so every desktop Run pins its contributing packs.
   * Undefined only when the pack chain is absent.
   */
  readonly packProvenance: ReturnType<typeof createRunPackProvenanceResolver> | undefined;
}

/**
 * The trusted repository configuration a deployment may supply. EMPTY by default: no task
 * kind is repository-capable and no workspace is opened, so the repository tools stay
 * registered-but-fail-closed exactly as before (T17-08 corrective §3/§8).
 */
export interface RepositoryRuntimeOptions {
  /** The generic task kinds whose stage handler is the repository-capable one (T17-07). */
  readonly repositoryCapableKinds?: readonly string[];
}

export interface ComposeCoreServicesOptions {
  readonly executionSafety?: GoalSafetyConfiguration;
  /**
   * H12c — the operator deployment directory (userData/budget) holding
   * reconciliations.json + evidence/. Applied once at composition start, after crash
   * recovery, through the canonical budget transaction (see usage-reconciliation.ts).
   */
  readonly usageReconciliationDir?: string;
  /**
   * H10b — deployment opt-in: a Goal may PLAN while the work-kind executor is missing; the
   * control plane then stops after the plan (typed EXECUTOR_PROVIDER_UNKNOWN) and never
   * compiles or dispatches. Absent/false => the executor preflight blocks before planning.
   */
  readonly planPreviewWithoutExecutor?: boolean;
  readonly artifactFoundation: Extract<ArtifactFoundation, { readonly ok: true }> | null;
  readonly repositoryRuntime?: RepositoryRuntimeOptions;
  /**
   * Task-18-07 corrective: which task kinds the agent-backed review/QA handlers serve. Pack
   * semantics stay DATA — a kind is a review kind because this deployment declares it, never
   * because of a role or pack test. Empty by default: no agent-backed handler is registered.
   */
  readonly stageHandlers?: {
    readonly reviewKinds?: readonly string[];
    readonly qaKinds?: readonly string[];
    /**
     * Sprint 19 (T19-03): the task kinds served by the session-backed Developer handler.
     * Same trusted-capability semantics as reviewKinds/qaKinds — a kind is a Developer kind
     * because this deployment declares it; no role-name or display-string test exists anywhere.
     */
    readonly developerKinds?: readonly string[];
    /**
     * Sprint21 (generic orchestration): kinds executed by the GENERIC executor — one
     * pinned model round whose context is the deterministic Work Package projection
     * (T20-06), optionally materializing the durable artifact the structured output
     * declares. A kind is an executor kind because this deployment says so; Core never
     * branches on the kind's meaning.
     */
    readonly executorKinds?: readonly string[];
  };
  /**
   * Sprint24: kinds executed through the PROVIDER seam (a real external
   * ExecutorProvider) instead of a pinned model round — trusted routing data.
   */
  readonly providerKinds?: readonly string[];
  /**
   * Sprint26 — injectable ExecutorProvider implementations for the GENERIC seam:
   * trusted application/test seam so the Goal runtime can be driven by ANY conforming
   * provider implementation (a deterministic one for E2E, another adapter in another
   * deployment). Provider selection stays implementation-level authority; Goal/Run/Task/
   * Attempt semantics never see the providerKey.
   */
  readonly executorProviderImplementations?: readonly {
    readonly provider: ExecutorProvider;
    /** The typed, validated configuration the preflight proves before any dispatch. */
    readonly config: TypedExecutorConfig;
  }[];

  /**
   * STAGE 4 — the CompanyOS-MANAGED EMBEDDED DSH kernel (the default agentic
   * provider). The managed root holds the materialization manifest (official
   * pinned upstream, exact SHA, checksums); the model route is the CompanyOS
   * EXPLICIT selection (operator/test configuration — no smart routing). The raw
   * credential resolves lazily (SecretVault resolver) and exists only in the
   * short-lived child environment; the typed provider config carries non-secret
   * identity facts only.
   *
   * DRA-04 — this root is trusted deployment data: an ABSOLUTE, launch-independent
   * resource location supplied by the composition root (development: the desktop
   * composition resolves it from its own module location; packaged: the build's
   * resources directory — same manifest contract). Composition never derives it
   * from the working directory; when the option is absent the embedded runtime is
   * explicitly unavailable (never a cwd-inferred substitute).
   */
  readonly embeddedDshRuntimeRoot?: string;
  /**
   * H15: the WRITABLE per-user location for the kernel's verified stages and
   * disposable homes (userData). The packaged kernel itself is an immutable install
   * resource. Absent = the managed root (dev materialization layout).
   */
  readonly embeddedDshStateRoot?: string;
  /**
   * H16b-3: Windows file/network isolation for the embedded kernel (executor/isolation/*). Absent = the
   * kernel launches as the signed-in user (tests, dev). Production passes productionIsolationLaunchConfig.
   */
  readonly embeddedDshIsolation?: IsolationLaunchConfig;
  readonly embeddedDshModelRoute?: {
    readonly providerId: string;
    readonly modelId: string;
    readonly baseURL: string;
    readonly apiKeyEnv: string;
    /** Lazy credential resolution (SecretVault); preferred over the literal value. */
    readonly apiKeyResolver?: () => string;
    readonly apiKeyValue?: string;
    readonly contextWindow?: number;
    readonly maxTokens?: number;
  };

  /**
   * Sprint26 — the trusted default work profile every compiled plan item executes as
   * (deployment configuration; the Pack seam refines it later, the model never does).
   */
  readonly goalWorkProfile?: {
    readonly stageKind: string;
    readonly taskKind: string;
    readonly maxAttempts: number;
    /** The deployment's closed set of native operation kinds plan items may request. */
    readonly operationKinds?: readonly string[];
    /**
     * STAGE 9 — the deployment's closed validator set pinned on every work item:
     * the frozen evidence gate requires durable validation before COMPLETION.
     */
    readonly validatorIds?: readonly string[];
    /**
     * BB2 final forensic closure — the deployment's PER-KIND validator policy over the
     * SAME closed operation-kind set: a plan item that declares one of these kinds carries
     * THAT kind's validator set (deterministic, deployment-declared — never model-chosen,
     * never derived from filenames, goal text or role names). An undeclared kind keeps
     * `validatorIds` unchanged.
     */
    readonly validatorIdsByTaskKind?: Readonly<Record<string, readonly string[]>>;
  };
  /** taskKind to providerKey (implementation routing data). */
  readonly providerRoutes?: Readonly<Record<string, string>>;
  /**
   * STAGE 8B §9 — the MODEL ROUTING mode for provider-backed attempts.
   *
   * `DETERMINISTIC_V1` (default) keeps the Stage 6 deterministic selector as the
   * attempt's single selection authority — zero behavior change. `SMART_ROUTER_V1`
   * routes every provider-backed attempt through the Stage 8 Smart Router BEFORE
   * the kernel is invoked; the provider then consumes the CompanyOS-selected
   * route verbatim and the kernel never re-routes. An attempt never has two
   * selection authorities.
   *
   * The pool is a CompanyOS-owned Stage 6 registry (trusted deployment data).
   * The role catalog defaults to the canonical `roles` table seed; a deployment
   * that adds Pack roles registers them on the same catalog.
   */
  readonly modelRouting?: {
    readonly mode?: 'DETERMINISTIC_V1' | 'SMART_ROUTER_V1';
    readonly pool?: ModelPool;
    readonly roleCatalog?: RoleCatalog;
    readonly policy?: ModelRoutingPolicyV1;
    readonly pinnedProfileId?: string;
    /** Deployment-declared high/medium-risk task kinds (trusted data). */
    readonly highRiskKinds?: readonly string[];
    readonly mediumRiskKinds?: readonly string[];
  };
  /**
   * Native Execution Foundation (V1 gate §5/§8): the authorized native PROCESS
   * operations — taskKind → {executable, LITERAL argv, bounds} — as TRUSTED
   * DEPLOYMENT DATA (the same authority class as the dsh adapter's typed
   * configuration). The native provider registers behind the SAME
   * ExecutorProviderRegistry and safety pipeline; a task kind absent here fails
   * loud (NATIVE_OPERATION_UNKNOWN). Natural-language task content never becomes
   * argv (ARCH-039).
   */
  readonly nativeOperations?: Readonly<
    Record<
      string,
      {
        readonly operationId: string;
        readonly executable: string;
        readonly args: readonly string[];
        readonly inputArgs?: readonly string[];
        readonly timeoutMs?: number;
      }
    >
  >;
  /**
   * H15b (Hark lane): the authorized native JOB operations — taskKind → a sha256-pinned
   * executable + inputs + literal argv + bound — as TRUSTED DEPLOYMENT DATA, executed by
   * the Job-backed provider (kill-on-close Job Object, atomic assignment, handle-pinned
   * launch, bounded pipe capture). win32/x64 only; on any other host, or when the shipped
   * binding fails its manifest, the provider is NOT registered and the composition records
   * the typed reason in `nativeJobStatus` — a routed task then fails loud at dispatch; it is
   * never re-routed to an unbounded spawn.
   */
  readonly nativeJob?: {
    readonly bindingDir: string;
    readonly operations: Readonly<
      Record<
        string,
        {
          readonly operationId: string;
          readonly executable: { readonly path: string; readonly sha256: string };
          readonly inputs: readonly { readonly path: string; readonly sha256: string }[];
          readonly args: readonly string[];
          readonly inputArgs?: readonly string[];
          readonly timeoutMs: number;
          readonly environment: Readonly<Record<string, string>>;
        }
      >
    >;
  };
  /**
   * Task-18-07 authority corrective: additional TOOL PORTS bound at composition — the SAME
   * trusted application seam the repository runtime's own tool ports enter through. A
   * deployment (or an E2E that must exercise a real validator) declares the adapter bindings
   * here and registers the tool RECORDS through the production tool registry; nothing a model,
   * agent payload, workflow payload or pack manifest reaches can add one. Default empty: the
   * registry answers exactly what it answered before.
   */
  readonly toolPorts?: ReadonlyMap<string, ToolPort>;
  /**
   * STAGE 9 (Boss §38 harness): deployment/test-declared VALIDATOR tools — the
   * record registers through the SAME production tool registry and the port
   * binds through the SAME trusted toolPorts seam. This exists so deterministic
   * autonomy harnesses can exercise the REAL validation path (the frozen
   * evidence gate) without a live repository; a port without a registered
   * record can never be invoked, so the seam widens nothing.
   */
  readonly validatorTools?: readonly {
    readonly toolId: string;
    readonly port: ToolPort;
  }[];
  /**
   * Task-18-08: the deterministic fault-injection seam. TRUSTED TEST-HARNESS INJECTION ONLY —
   * the production desktop composition never supplies it, so every checkpoint is the absent
   * dependency (zero overhead, zero behavior). Nothing a model, user or payload names can
   * reach this parameter, and no single environment variable activates it.
   */
  /**
   * Sprint21 final: the runtime owner token stamped on execution claims. Generated per
   * composition when omitted. Under the supported V1 single-runtime boundary (one live
   * desktop/runtime owner per workspace/database) composition startup transitions the
   * PREVIOUS runtime's ACTIVE attempts to INTERRUPTED — the canonical orphan recovery.
   */
  readonly runtimeInstanceId?: string;
  readonly faultCheckpoints?: FaultCheckpointPort;
  /**
   * Sprint 18 (T18-06): the trusted application configuration of the supervisor turn — WHICH
   * pinned binding of a run the Supervisor runs under. Defaults to `supervisor`. A model, an
   * agent payload, a workflow payload and a pack manifest cannot reach this seam, and a run
   * that pins no binding under this name simply has no supervisor turn (fail closed).
   */
  readonly supervisorBindingKey?: string;
  /**
   * Sprint 20 (T20-04): the trusted pinned binding NAME the planner resolves from a run's
   * own snapshot. Defaults to `planner`. Configuration only — the value is always pinned.
   */
  readonly plannerBindingKey?: string;
  /**
   * Sprint 20 (T20-05 hardening): the trusted PER-ITEM compilation spec Pack/workflow
   * configuration supplies — one explicit profile per plan item (heterogeneous kinds,
   * roles, attempt bounds and validators are first-class). Immutable INPUT to each
   * compilation command; exact coverage required (missing/unknown/malformed profiles
   * FAIL CLOSED); never a live default, never registration-order-derived.
   */
  readonly planCompilationSpec?: PlanCompilationSpec;
  /** Trusted bindings the compiled Execution Run pins (configuration, not model choice). */
  readonly planExecutionBindings?: Readonly<Record<string, string>>;
  /**
   * Sprint 18 (T18-07): trusted orchestration bounds. Boss rulings for V1:
   * `maxSupervisorTurns = 20` and `maxCorrectiveRounds = 3`. A model, an agent payload, a
   * workflow payload and a pack manifest cannot reach these values.
   */
  readonly supervisorBounds?: {
    readonly maxSupervisorTurns?: number;
    readonly maxCorrectiveRounds?: number;
    readonly timeoutMs?: number;
  };
}

/**
 * STAGE 9B-FIX — the corrective GENERATION of a task (the lineage round it carries, 0 when
 * it has none). Read from the durable task row's canonical corrective lineage, never from a
 * timestamp, so a later round always outranks an earlier one — the semantic key the
 * cross-anchor "latest review report" order starts from.
 */
const taskLineageRoundOf = async (database: DurableDatabase, taskId: string): Promise<number> => {
  const task = await database.tasks.get(taskId as never);
  const corrective = (task as {readonly inputs?: Record<string, unknown>} | null)?.inputs?.['corrective'];
  if (typeof corrective !== 'object' || corrective === null) return 0;
  const round = (corrective as Record<string, unknown>)['round'];
  return typeof round === 'number' ? round : 0;
};

/**
 * The run's review-kind tasks, derived from the run's OWN pinned graph and task rows — the same
 * derivation the autonomous orchestrator uses. Absent/broken inputs yield an empty list (the
 * single requested anchor still applies); nothing is guessed.
 */
const reviewTaskAnchorsOf = async (
  database: DurableDatabase,
  runId: string,
  classes: { reviewKinds: ReadonlySet<string> } = { reviewKinds: new Set<string>(['review']) },
): Promise<readonly string[]> => {
  const run = await database.runs.get(runId as never);
  if (run === null) return [];
  const template = await database.templates.get(String(run.templateId) as never);
  const version = template?.versions.find((entry) => entry.id === run.versionId);
  if (version === undefined) return [];
  const nodes = version.graph.nodes as readonly { id: string; kind?: string }[];
  const pinned = new Set(nodes.map((node) => node.id));
  // Sprint21: review-class membership comes from the deployment-declared class set
  // (keyed by the pinned execution semantic taskProfile.taskKind).
  const kindByStage = new Map(
    nodes.map((node) => {
      const profile = (node as { readonly config?: Record<string, unknown> }).config?.['taskProfile'] as
        | { readonly taskKind?: unknown }
        | undefined;
      const taskKind =
        profile !== undefined && typeof profile.taskKind === 'string' ? profile.taskKind : node.kind ?? '';
      return [node.id, taskKind];
    }),
  );
  // T20-03A: run ownership first (only this run's rows are loaded); pinned-stage membership
  // below is graph legality only.
  const tasks = await database.tasks.listByRun(runId);
  return tasks
    .filter(
      (task) =>
        pinned.has(String(task.stageId)) &&
        classes.reviewKinds.has(String(kindByStage.get(String(task.stageId)) ?? '')),
    )
    .map((task) => task.id);
};

/**
 * Sprint 19 (T19-04): the run's CURRENT delivering WORK task — the business subject the
 * review/validation roles evaluate, derived from the run's OWN pinned graph exactly the way
 * the orchestrator derives its phases. A corrective child (lineage parent inside the run's
 * work tasks) always wins over its ancestor; deterministically by round, then recency, then
 * id. Never the instrumental review/qa task itself (T18-07 subject-anchor rule).
 */
const workSubjectTaskOf = async (
  database: DurableDatabase,
  runId: string,
  classes: { reviewKinds: ReadonlySet<string>; validationKinds: ReadonlySet<string> } = {
    reviewKinds: new Set<string>(['review']),
    validationKinds: new Set<string>(['qa']),
  },
): Promise<string | null> => {
  const run = await database.runs.get(runId as never);
  if (run === null) return null;
  const template = await database.templates.get(String(run.templateId) as never);
  const version = template?.versions.find((entry) => entry.id === run.versionId);
  if (version === undefined) return null;
  const nodes = version.graph.nodes as readonly { id: string; kind?: string }[];
  const pinned = new Set(nodes.map((node) => node.id));
  // Sprint21: the WORK subject is a BUSINESS-domain stage — not in either deployment-
  // declared gate class (keyed by the pinned execution semantic taskProfile.taskKind).
  const reviewKinds = classes.reviewKinds;
  const validationKinds = classes.validationKinds;
  const kindByStage = new Map(
    nodes.map((node) => {
      const profile = (node as { readonly config?: Record<string, unknown> }).config?.['taskProfile'] as
        | { readonly taskKind?: unknown }
        | undefined;
      const taskKind =
        profile !== undefined && typeof profile.taskKind === 'string' ? profile.taskKind : node.kind ?? '';
      return [node.id, taskKind];
    }),
  );
  const isBusinessStage = (stageId: string): boolean => {
    const kind = String(kindByStage.get(stageId) ?? '');
    return !reviewKinds.has(kind) && !validationKinds.has(kind);
  };
  // T20-03A: run ownership first (only this run's rows are loaded); the pinned-graph check
  // is graph legality only.
  const tasks = (await database.tasks.listByRun(runId)).filter(
    (task) => pinned.has(String(task.stageId)) && isBusinessStage(String(task.stageId)),
  );
  if (tasks.length === 0) return null;
  /*
   * STAGE 9B-FIX: the business subject is the SHARED frozen stage-subject rule
   * (corrective generation → earliest createdAt → id), called through the ONE authority
   * instead of a private copy of it — so no composition can drift from the engine's rule.
   */
  const subject = stageSubjectTaskOf(tasks as never);
  return subject === null ? null : String(subject.id);
};

export async function composeCoreServices(
  database: DurableDatabase,
  activeLogger: Logger,
  options: ComposeCoreServicesOptions,
): Promise<CoreServices | null> {
  const runtimeInstanceId =
    options.runtimeInstanceId ?? `rt_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`;
  /** The composition's own failure channel: the last error the bootstrap hit, if any. */
  let compositionError: string | null = null;
  try {
    /*
     * LIVE-SMOKE-FIX-02 — resolve the CompanyOS-owned production attempt time budget
     * at composition time (typed fail-loud on an invalid deployment override); every
     * provider dispatch this composition runs receives it explicitly, so the DSH
     * provider's internal 120s fallback is never the production path.
     */
    const executionAttemptTimeoutMs = resolveExecutionAttemptTimeoutMs(process.env);
    const artifactFoundation = options.artifactFoundation;
    const clock = new SystemClock();
    const ids = new UlidFactory(clock);
    const executionSafety = options.executionSafety === undefined ? null : createExecutionSafetyCoordinator(database, options.executionSafety, () => clock.now());
    await executionSafety?.recover();
    if (executionSafety !== null && options.usageReconciliationDir !== undefined) {
      const report = await applyOperatorUsageReconciliations(options.usageReconciliationDir, executionSafety.budget.reconcile);
      if (report.file !== 'ABSENT') activeLogger.info('operator usage reconciliation', { file: report.file, outcomes: report.outcomes });
    }

    /**
     * Industry-pack live availability (T15-04 corrective; ADR-0025 Decision 4).
     *
     * One policy derived from pack provenance (PackContentRef -> PackInstallation.status):
     * a disabled pack exposes nothing to NEW work while its durable rows, history and
     * existing Runs stay readable. Injected into the authorization service (new role
     * assignments) and the workflow lifecycle service (new drafts/publishes/forks/runs),
     * so the guard cannot be bypassed by calling those services directly. The `pack`
     * chain is registered for this database, so both pack stores are present.
     */
    const packAvailability =
      database.packInstallations !== null && database.packContentRefs !== null
        ? createPackAvailabilityPolicy({
            packInstallations: database.packInstallations,
            packContentRefs: database.packContentRefs,
          })
        : undefined;
    // T15-05: run provenance uses the SAME pack stores (no second persistence graph) and is
    // only consulted when a new Run is created.
    const packProvenance =
      database.packInstallations !== null &&
      database.packContentRefs !== null &&
      database.packVersions !== null
        ? createRunPackProvenanceResolver({
            packInstallations: database.packInstallations,
            packContentRefs: database.packContentRefs,
            packVersions: database.packVersions,
          })
        : undefined;

    // ---- authorization: explicit bootstrap, then pure Role -> Authority --------------
    const authz = createAuthorizationService({
      ids,
      clock,
      roles: database.roles,
      assignments: database.roleAssignments,
      ...(packAvailability === undefined ? {} : { packAvailability }),
    });

    /**
     * Sprint 7.1 MEDIUM-1: an EMPTY role table is NOT a permission model.
     *
     * On the very first run the composition root provisions ONE explicit owner role for the
     * session actor (all authorities) and records it in SQLite. After that the window is
     * closed: an actor without an assignment is denied, and the special bootstrap path is
     * never taken again (there is at least one role from then on).
     */
    const bootstrap = await ensureBootstrapOwner(authz, {
      actorId: SESSION_ACTOR,
      companyId: 'company_default',
    });
    if (!bootstrap.ok) {
      compositionError = `authorization bootstrap failed: ${bootstrap.error.message}`;
      activeLogger.error('authorization bootstrap failed', { code: bootstrap.error.code });
      return null;
    }
    if (bootstrap.value.provisioned) {
      activeLogger.warn('authorization bootstrap: owner role provisioned', {
        actorId: SESSION_ACTOR,
        roleId: bootstrap.value.roleId,
      });
    }

    const sessionAuthorize = async ({
      actorId,
      authority,
      scopeId,
    }: {
      readonly actorId: string;
      readonly authority: string;
      readonly scopeId?: string;
    }) => {
      if (actorId !== SESSION_ACTOR) {
        return {
          ok: false as const,
          error: new DomainError('POLICY_DENIED', `Actor "${actorId}" is not the session actor.`, {
            details: { actorId, sessionActor: SESSION_ACTOR },
          }),
        };
      }
      // No fail-open: the decision always comes from the Role -> Authority model.
      return authz.decide({ actorId, authority, ...(scopeId === undefined ? {} : { scopeId }) });
    };

    // ---- secrets: values stay in memory; every access is authority-checked -----------
    const vault = createEnvSecretVault({
      env: process.env,
      prefix: 'COMPANYOS_',
      authorize: sessionAuthorize,
    });

    // ---- Sprint 13 durable references (Task-13-11): ONE resolver for every seam ------
    // Resolve-ALL-before-write over the durable artifact/validation rows. The artifact
    // chain is frozen into the composition (openArtifactFoundation already fail-closed
    // on a missing chain), so a null store here cannot silently degrade the seams.
    if (artifactFoundation === null) {
      throw new Error(
        'The artifact/CAS foundation is not reconciled; artifact capabilities are unavailable.',
      );
    }
    if (database.artifactStore === null || database.validationStore === null) {
      throw new Error(
        'The "artifact" migration chain is not enabled: artifact persistence is unavailable.',
      );
    }
    const durableReferenceResolver = createDurableReferenceResolver(database);

    // ---- providers: explicit ids only, with audit events ----------------------------
    const providers = createProviderRegistry({
      faultCheckpoints: options.faultCheckpoints,
      ids,
      clock,
      registrations: database.providers,
      models: database.providerModels,
      secretResolver: vault,
      secrets: async () => vault.values(),
      authorize: sessionAuthorize,
      events: database.events,
      logger: activeLogger,
      systemActor: SESSION_ACTOR,
    });

    // ---- curated model registry (no routing logic anywhere) -------------------------
    const models = createModelRegistry({
      ids,
      clock,
      records: database.modelRecords,
      aliases: database.modelAliases,
      providers,
      authorize: sessionAuthorize,
      events: database.events,
      logger: activeLogger,
      scope: 'default',
    });

    // ---- selection RULES (Sprint 7.5): stored + explained, never executed ------------
    const policies = createSelectionPolicyService({
      ids,
      clock,
      policies: database.selectionPolicies,
      results: database.benchmarkResults,
      readRecords: async () => models.list({ includeDisabled: true }),
      authorize: sessionAuthorize,
      events: database.events,
      logger: activeLogger,
    });

    /*
     * The REAL model adapter (Boss V1 Product Reachability, BB-002): the
     * OpenAI-compatible HTTP adapter self-registers when its typed env config
     * resolves — mirroring the dsh executor self-registration seam. An absent
     * config is a legal "no model provider" state (goal.create then fails closed
     * with MODEL_SELECTION_REQUIRED); an INVALID config is a LOUD composition
     * failure. Never a silent mock: nothing test-shaped is registered here.
     */
    const { createOpenAiCompatibleProvider, resolveOpenAiCompatibleConfig } = await import(
      './models/openai-compatible-provider.js'
    );
    const modelAdapterConfig = resolveOpenAiCompatibleConfig();
    if (!modelAdapterConfig.ok) {
      throw new Error(`the model adapter configuration is invalid: ${modelAdapterConfig.error.message}`);
    }
    if (modelAdapterConfig.value !== null) {
      const modelAdapter = createOpenAiCompatibleProvider({
        config: modelAdapterConfig.value,
        resolveSecret: (ref) => vault.resolve(ref),
      });
      const modelAdapterRegistration = await providers.register(modelAdapter, { actorId: SESSION_ACTOR });
      if (!modelAdapterRegistration.ok) {
        throw new Error(`the model adapter could not be registered: ${modelAdapterRegistration.error.message}`);
      }
    }

    // ---- tool registry (Sprint 9): contracts + ONE bounded invocation per request ------
    const toolAdapters = new Map<string, ToolPort>();
    for (const spec of MOCK_TOOL_SPECS) {
      toolAdapters.set(spec.toolId, createMockTool(spec, clock));
    }
    // ---- repository runtime (Sprint 17, T17-03…T17-08): the ONE production composition for
    //      the ten repository tools, the process runner, the shared revision-anchor provider,
    //      the QA evidence source and the workspace lease. Generic and workspace-scoped: no
    //      Git mutation, no validator re-execution, no DevCompany special case. Everything
    //      fails closed until a trusted host opens a workspace (V1 has no openWorkspace
    //      caller, so no repository command may run yet).
    const repositoryRuntime = composeRepositoryRuntime({
      db: database,
      // Late-bound: the registry is built from this module's toolPorts just below.
      registry: () => tools,
      contentStore: artifactFoundation?.contentStore ?? null,
      clock,
      ids,
      actorId: SESSION_ACTOR,
      // The TRUSTED application configuration seam: a deployment declares which generic task
      // kinds are repository-capable. The default is empty (fail closed), and a model, agent
      // payload, workflow payload or pack manifest cannot reach this parameter.
      repositoryCapableKinds: options.repositoryRuntime?.repositoryCapableKinds ?? [],
      // Task-18-08: the repository baseline→execution window is provable the same way.
      faultCheckpoints: options.faultCheckpoints,
    });
    for (const [toolId, port] of repositoryRuntime.toolPorts) {
      toolAdapters.set(toolId, port);
    }
    // Task-18-07 authority corrective: deployment-declared tool ports enter through the same
    // trusted seam as the repository runtime's. A port without a registered record can never
    // be invoked (the registry resolves records first), so this widens nothing by itself.
    for (const [toolId, port] of options.toolPorts ?? []) {
      toolAdapters.set(toolId, port);
    }
    const validatorToolIds = new Set<string>();
    for (const validatorTool of options.validatorTools ?? []) {
      toolAdapters.set(validatorTool.toolId, validatorTool.port);
      validatorToolIds.add(validatorTool.toolId);
    }
    /*
     * STAGE 4 FINAL — GENERIC VALIDATOR SELECTION: the grounding validator is registered
     * and recorded in validatorToolIds, so a deployment that selects it by id gets it.
     * Specialized validators (repo.validation-evidence, smoke.node-test, packs) remain
     * independently selectable — nothing is replaced.
     */
    const tools = createToolRegistry({
      ids,
      clock,
      records: database.toolRecords,
      invocations: database.toolInvocations,
      invocationArtifacts: database.toolInvocationArtifacts,
      adapters: toolAdapters,
      authorize: sessionAuthorize,
      events: database.events,
      secrets: async () => vault.values(),
      logger: activeLogger,
      claims: database.toolInvocationClaims ?? undefined,
      invocationIndex: database.toolInvocationIndex ?? undefined,
      // Sprint 13 (Task-13-09/11): managed refs advertised by a tool are resolved
      // against the durable stores BEFORE the invocation may complete.
      durableReferenceResolver,
      // The engine may not use timers itself (boundary gate), so the shell supplies one.
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
    });
    // The ten repository ToolRecords (idempotent on restart: a stored tool is not an error).
    const repositoryToolsRegistered = await repositoryRuntime.registerTools(SESSION_ACTOR);
    if (!repositoryToolsRegistered.ok) {
      compositionError = `repository tool registration failed: ${repositoryToolsRegistered.error.message}`;
      return null;
    }

    for (const validatorTool of options.validatorTools ?? []) {
      const validatorRecord = createToolRecord({
        toolId: validatorTool.toolId,
        name: `Validator (${validatorTool.toolId})`,
        description: 'Deployment-declared deterministic validator (Stage 9 harness seam).',
        version: '1.0.0',
        capabilities: [TOOL_CAPABILITY_VALIDATOR],
        inputSchema: {type: 'object', additionalProperties: true},
        outputSchema: {
          type: 'object',
          required: ['verdict'],
          properties: {verdict: {type: 'string', enum: ['pass', 'fail', 'skipped']}},
        },
        riskLevel: 'LOW',
        requiredAuthorities: [],
        providerKind: 'deterministic',
        adapterRef: validatorTool.toolId,
        now: clock.nowIso(),
      });
      if (!validatorRecord.ok) {
        compositionError = `validator tool registration failed: ${validatorRecord.error.message}`;
        return null;
      }
      const validatorRegistered = await tools.register(validatorRecord.value, {actorId: SESSION_ACTOR});
      if (!validatorRegistered.ok && validatorRegistered.error.code !== 'CONFLICT') {
        compositionError = `validator tool registration failed: ${validatorRegistered.error.message}`;
        return null;
      }
    }
    for (const spec of MOCK_TOOL_SPECS) {
      const record = createMockToolRecord(spec, clock.nowIso());
      if (!record.ok) {
        compositionError = `tool registration failed: ${record.error.message}`;
        return null;
      }
      const registered = await tools.register(record.value, { actorId: SESSION_ACTOR });
      // Idempotent on restart: a tool that is already stored is not an error.
      if (!registered.ok && registered.error.code !== 'CONFLICT') {
        compositionError = `tool registration failed: ${registered.error.message}`;
        return null;
      }
    }
    const validatorRecord = createRepositoryValidationEvidenceRecord(
      REPOSITORY_VALIDATION_EVIDENCE_SPEC,
      clock.nowIso(),
    );
    if (!validatorRecord.ok) {
      compositionError = `tool registration failed: ${validatorRecord.error.message}`;
      return null;
    }
    const validatorRegistered = await tools.register(validatorRecord.value, {
      actorId: SESSION_ACTOR,
    });
    if (!validatorRegistered.ok && validatorRegistered.error.code !== 'CONFLICT') {
      compositionError = `tool registration failed: ${validatorRegistered.error.message}`;
      return null;
    }
    /*
     * STAGE 4 P1 (DYNAMIC_PLAN_VALIDATION_CLOSURE): the GENERIC production validator for
     * dynamically planned work. Verifier-only: it checks the target artifact's
     * machine-checkable factual claims (named workspace paths, quoted CSV-shaped data
     * rows) against the opened workspace. The binding into each compiled work node flows
     * from goalWorkProfile.validatorIds (productionCompositionOptions).
     */
    const groundingRecord = createEvidenceGroundingRecord(EVIDENCE_GROUNDING_SPEC, clock.nowIso());
    if (!groundingRecord.ok) {
      compositionError = `evidence grounding validator registration failed: ${groundingRecord.error.message}`;
      return null;
    }
    const groundingRegistered = await tools.register(groundingRecord.value, { actorId: SESSION_ACTOR });
    if (!groundingRegistered.ok && groundingRegistered.error.code !== 'CONFLICT') {
      compositionError = `evidence grounding validator registration failed: ${groundingRegistered.error.message}`;
      return null;
    }
    toolAdapters.set(EVIDENCE_GROUNDING_TOOL_ID, createEvidenceGroundingPort(EVIDENCE_GROUNDING_SPEC, {
      workspace: () => repositoryRuntime.currentWorkspace(),
      /*
       * F4 CLOSURE — the grounding validator is run-scoped in production: it reads
       * against the GOAL'S DURABLE BINDING (resolved and mismatch-checked at invocation
       * entry) and never against the global open-workspace holder, which a workspace
       * switch could have moved after the Goal was created.
       */
      resolveRunContext: (runId) => resolveRunWorkspaceContext(runId),
      artifactContent: async (contentRef: string) =>
        artifactFoundation === null ? null : ((artifactFoundation.contentStore.get(contentRef) as Promise<Uint8Array | null>) ?? null),
      clock,
    }));

    /*
     * BB2 FINAL FORENSIC closure — the SPECIALIZED software validation authority. The
     * validator executes the workspace's OWN declared test contract (`npm test`) fresh at
     * validation time through this composition-owned port, which carries the frozen
     * repository process discipline (repository-process-runner): CONSTANT command (the
     * fixed `npm test` contract — never an assembled shell line of any dynamic value),
     * allowlisted child environment (never the parent environment — ADR-0028 D12, so a
     * workspace script cannot observe credentials), bounded output capture, and the
     * deadline armed HERE (the engine boundary bans engine-held timers).
     */
    const testCheckRecord = createRepoTestCheckRecord(REPO_TEST_CHECK_SPEC, clock.nowIso());
    if (!testCheckRecord.ok) {
      compositionError = `repository test contract validator registration failed: ${testCheckRecord.error.message}`;
      return null;
    }
    const testCheckRegistered = await tools.register(testCheckRecord.value, { actorId: SESSION_ACTOR });
    if (!testCheckRegistered.ok && testCheckRegistered.error.code !== 'CONFLICT') {
      compositionError = `repository test contract validator registration failed: ${testCheckRegistered.error.message}`;
      return null;
    }
    toolAdapters.set(REPO_TEST_CHECK_TOOL_ID, createRepoTestCheckPort(REPO_TEST_CHECK_SPEC, {
      // F3/F4: the run-scoped canonical context — Goal binding + accessPolicy + mismatch
      // check. The validator never executes against the global current workspace.
      resolveRunContext: (runId) => resolveRunWorkspaceContext(runId),
      runTestContract: async (input) =>
        runRepoTestContract({ cwd: input.cwd, timeoutMs: REPO_TEST_CHECK_SPEC.timeoutMs }),
      clock,
    }));

    const gitRecord = createRepositoryGitToolRecord(REPOSITORY_GIT_TOOL_SPEC, clock.nowIso());
    if (!gitRecord.ok) {
      compositionError = `tool registration failed: ${gitRecord.error.message}`;
      return null;
    }
    const gitRegistered = await tools.register(gitRecord.value, { actorId: SESSION_ACTOR });
    if (!gitRegistered.ok && gitRegistered.error.code !== 'CONFLICT') {
      compositionError = `tool registration failed: ${gitRegistered.error.message}`;
      return null;
    }

    // ---- agent execution runtime (Sprint 8): executes, never chooses -----------------
    const runtime = createAgentRuntime({
      ...(executionSafety === null ? {} : { callAdmission: executionSafety.admit, isCancellationRequested: executionSafety.budget.isCancelled }),
      ids,
      clock,
      // LIVE-SMOKE-FIX-03: the real cancelable timer sleep for control-plane
      // model-call retry backoff (desktop-owned; the engine boundary bans timers).
      modelRetrySleep: abortableSleep,
      executions: database.agentExecutions,
      // 6ec4d81 — the claim/audit transaction seam (N6-A1 atomic admission).
      unitOfWork: database.unitOfWork,
      // 6ec4d81 re-audit — the execution WRITE-CLASS checkpoints (N25-C1/N6-A1/R1 proofs).
      ...(options.faultCheckpoints === undefined
        ? {}
        : { faultCheckpoints: options.faultCheckpoints }),
      artifacts: database.executionArtifacts,
      models,
      providers,
      policies,
      tools,
      events: database.events,
      authorize: sessionAuthorize,
      secrets: async () => vault.values(),
      logger: activeLogger,
      // Sprint 13 (Task-13-09/11): agent-advertised managed refs must resolve durably
      // before the execution may complete.
      durableReferenceResolver,
    });

    // ---- Sprint 13 production composition (Task-13-11) -------------------------------
    // ArtifactService / ValidatorResolver / ValidationService / run-fixed evidence gate /
    // durable references + the production WorkflowEngine with the gate REQUIRED — all on
    // the ONE durable database. Reconciliation already passed in quiescent startup, so
    // exposing these services now satisfies the frozen startup ordering.
    //
    // IPC BOUNDARY (Task-13-11 corrective): these are TRUSTED MAIN-PROCESS capabilities.
    // They are wired and alive here, but deliberately NOT reachable through the workflow
    // channel — no Sprint 13 operation exists in the frozen IPC contract, and gate
    // semantics (blocking, validation plans) must never come from a renderer.
    /**
     * Task-18-07 corrective: the agent-backed stage handlers. Each one runs ONE pinned model
     * round (the binding comes from the run's snapshot, so a caller cannot name a model) and
     * returns a bounded structured outcome. The trusted carrier — not the handler — decides
     * which canonical sink the outcome reaches, and the evidence applicator decides which Run
     * event it implies. Neither reads prose.
     */
    // Sprint 19 (T19-03): the session-backed Developer runtime, resolvable lazily from the
    // stage handlers (it is composed after them; see composedStageHandlers).
    let developerSessionRuntimeHolder: ReturnType<
      typeof createWorkSessionRuntime
    > | null = null;
    // Sprint21: the generic executor reads its context from the Work Package projector;
    // lazily resolvable for the same declaration-order reason as the session runtime.
    let workPackageProjectorHolder: ReturnType<typeof createWorkPackageProjector> | null = null;
    /** Sprint24: late-bound provider registry (implementation authority only). */
    let executorProvidersHolder: ExecutorProviderRegistry | null = null;
    // H15b: whether the Job-backed native executor was registered, and why not.
    let nativeJobStatus: CoreServices['nativeJobStatus'] = null;
    /**
     * Sprint25: the typed, source-annotated provider configurations (provenance +
     * fingerprint for the safety preflight). Registration data — never provider- or
     * model-controlled.
     */
    const executorConfigsHolder = new Map<string, TypedExecutorConfig>();
    // H15: the packaged kernel's first-start health report (null = not packaged / not checked).
    const kernelHealthHolder: { report: KernelHealthReport | null } = { report: null };
    const providerRouteTable: Readonly<Record<string, string>> = options.providerRoutes ?? {};
    let sprint13ArtifactServiceHolder: ReturnType<
      typeof composeSprint13Application
    >['artifactService'] | null = null;
    let fileDeliveryContextOf: ((runId: string, taskId: string) => Promise<FileDeliveryContext>) | null = null;
    let verifiedFileCarrier: ReturnType<typeof createVerifiedFileCarrier> | null = null;
    /**
     * STAGE 8B — the runtime role-collaboration holders. The HandoffService is
     * the ONE existing Sprint-11 service over the frozen handoff tables (never a
     * second handoff truth); the routing resolution is derived from the
     * deployment's `modelRouting` option. Both resolve lazily because they are
     * composed after this map; by execution time they always exist.
     */
    let handoffServiceHolder: ReturnType<typeof createHandoffService> | null = null;
    let roleCatalogHolder: RoleCatalog | null = null;
    const developerSessionRuntimeLazy = (): ReturnType<
      typeof createWorkSessionRuntime
    > | null => developerSessionRuntimeHolder;
    const composedStageHandlers = (
      base: ReadonlyMap<string, StageHandler>,
    ): ReadonlyMap<string, StageHandler> => {
      const merged = new Map(base);
      const executor = pinnedAgentExecution;
      if (executor === null) return merged;
      // Sprint 19 (T19-03): the session-backed Developer handler, registered for the kinds
      // the deployment declares. The runtime is resolved LAZILY because it is composed after
      // this map (it needs the session kernel); by execution time it always exists.
      for (const kind of options.stageHandlers?.developerKinds ?? []) {
        merged.set(kind, {
          id: `session.developer:${kind}`,
          execute: async (context) => {
            const runRow = await database.runs.get(String(context.runId) as never);
            if (runRow === null) return 'failed';
            const runtime = developerSessionRuntimeLazy();
            if (runtime === null) return 'failed';
            const turn = await runtime.runTurn({
              companyId: String(runRow.companyId),
              runId: String(context.runId),
              taskId: String(context.taskId),
              actorId: SESSION_ACTOR,
              structuredKeys: ['objective', 'summary'],
            });
            if (!turn.ok) return 'failed';
            return { status: 'succeeded', output: turn.value.output };
          },
        });
      }
      // Sprint 19 (T19-04): the bounded STATELESS role-context reader the review/qa handlers
      // share (binding + trusted context window for the pre-invocation budget gate).
      const roleBindingReader = createRunModelBindingReader({
        runs: database.runs,
        snapshots: database.snapshots,
      });
      const build = (
        kind: string,
        role: 'review' | 'qa',
        structuredKeys: readonly string[],
        responseFormat?: { readonly mode: 'json_schema'; readonly schemaName: string; readonly schema: Readonly<Record<string, unknown>> },
      ): StageHandler => ({
        id: `supervisor.${role}:${kind}`,
        execute: async (context) => {
          // The company is read from the durable run row — never from the handler context and
          // never from a caller.
          const runRow = await database.runs.get(String(context.runId) as never);
          if (runRow === null) return 'failed';
          /*
           * T19-04: the trusted bounded role-context projection replaces the bare reference
           * skeleton. Review/validation are STATE-RECONSTRUCTED: no session, no transcript,
           * fresh canonical facts every invocation (§4/§5), Developer residue structurally
           * unreachable (§6), and every projected field classified (§24).
           */
          const projected =
            role === 'review'
              ? await boundedAgentContext.projectReview({
                  companyId: String(runRow.companyId),
                  runId: String(context.runId),
                  reviewTaskId: String(context.taskId),
                  actorId: SESSION_ACTOR,
                })
              : await boundedAgentContext.projectValidation({
                  companyId: String(runRow.companyId),
                  runId: String(context.runId),
                  qaTaskId: String(context.taskId),
                  actorId: SESSION_ACTOR,
                });
          if (!projected.ok) return 'failed';
          // §14/§20: the provider-neutral budget gate runs on the COMPLETE rendered request
          // BEFORE the pinned round (stateless kernel mode — no Session is created for this).
          const bound = await roleBindingReader.resolve(
            {
              runId: String(context.runId),
              companyId: String(runRow.companyId),
              bindingName: options.supervisorBindingKey ?? SUPERVISOR_BINDING_KEY,
            },
            models,
          );
          if (!bound.ok) return 'failed';
          const catalogue = await database.modelRecords.list({ limit: 500 });
          const record = catalogue.items.find((row) => row.modelKey === bound.value.modelKey);
          const memoryView = [JSON.stringify(projected.value)];
          const budget = decideBoundedContextBudget({
            contextWindowTokens: record === undefined ? null : record.contextWindow,
            renderedContext: memoryView[0]!,
            structuredKeys,
          });
          if (!budget.ok) return 'failed'; // fail closed, provider call count stays 0
          const isReview = projected.value.schema === 'companyos/review-context/1';
          const subject = isReview ? projected.value.subject : projected.value.target;
          const deliveredRefs =
            subject === null || subject.delivered === null ? [] : subject.delivered.refs;
          const priorArtifact = isReview
            ? (projected.value.priorFinding?.artifactId ?? null)
            : (projected.value.latestReview?.artifactId ?? null);
          const objective =
            projected.value.goal === null
              ? role === 'review'
                ? 'Review the delivered work of the subject task.'
                : 'Validate the delivered work against the configured validators.'
              : projected.value.goal.objective;
          const round = await executor.runRound({
            companyId: String(runRow.companyId),
            runId: String(context.runId),
            taskId: String(context.taskId),
            agentId: `agent.${role}`,
            roleId: `rol.${role}` as never,
            actorId: SESSION_ACTOR,
            // T19-04 §23: REAL identities — company from the durable run row, the workflow's
            // own id and the run's pinned version id. No placeholder masquerading as a fact.
            context: {
              company: { id: String(runRow.companyId), label: 'company' },
              workflow: { id: String(runRow.workflowId), label: 'workflow' },
              workflowVersion: String(runRow.versionId),
              workflowRun: { id: String(context.runId), label: 'run' },
              stage: { id: String(context.stageId), label: 'stage' },
              task: { id: String(context.taskId), label: 'task' },
              role: { id: `rol.${role}`, label: role },
              objective,
              memoryView,
              artifactRefs: [
                ...deliveredRefs.slice(0, 16).map((ref) => ({ id: ref, label: 'delivered' })),
                ...(priorArtifact === null
                  ? []
                  : [{ id: `artifact:${priorArtifact}`, label: 'review' }]),
              ],
            },
            prompt: {
              structuredKeys,
              // BB-WATCH-001 closeout: when the role-correct generation contract is
              // supplied it overrides the generic string-keyed derivation; the strict
              // carrier validation above stays the authority.
              ...(responseFormat === undefined ? {} : { responseFormat }),
            },
          });
          if (!round.ok) return 'failed';
          const outcome = round.value;
          const structured = outcome.outcome.structured;
          if (structured === null || typeof structured !== 'object') return 'failed';
          return {
            status: 'succeeded',
            output: {
              schemaVersion: 'companyos/stage-output/1',
              kind: role === 'review' ? REVIEW_CANDIDATE_KIND : VALIDATION_CANDIDATE_KIND,
              executionId: outcome.executionId,
              artifactRefs: [],
              validationRefs: [],
              payload: structured as Record<string, unknown>,
            },
          };
        },
      });
      /*
       * Sprint21 (generic orchestration): the GENERIC executor handler — the same trusted
       * machinery (pinned binding, budget gate, ONE pinned model round) with the Work
       * Package projection as its context. Its structured output may declare an artifact;
       * the handler materializes it durably and references it in the carrier envelope so
       * validators have a canonical anchor. The envelope kind is the frozen generic
       * work-output classification (no canonical sink by design).
       */
      for (const kind of options.stageHandlers?.executorKinds ?? []) {
        merged.set(kind, {
          id: `executor.generic:${kind}`,
          execute: async (context) => {
            const runRow = await database.runs.get(String(context.runId) as never);
            if (runRow === null) return 'failed';
            const projector = workPackageProjectorHolder;
            if (projector === null) return 'failed';
            const workPackage = await projector.project({
              companyId: String(runRow.companyId),
              runId: String(context.runId),
              taskId: String(context.taskId),
            });
            if (!workPackage.ok) return 'failed';
            const pkg = workPackage.value;
            const bound = await roleBindingReader.resolve(
              {
                runId: String(context.runId),
                companyId: String(runRow.companyId),
                bindingName: options.supervisorBindingKey ?? SUPERVISOR_BINDING_KEY,
              },
              models,
            );
            if (!bound.ok) return 'failed';
            const memoryView = [JSON.stringify(pkg)];
            const catalogue = await database.modelRecords.list({ limit: 500 });
            const modelRecord = catalogue.items.find((row) => row.modelKey === bound.value.modelKey);
            const budget = decideBoundedContextBudget({
              contextWindowTokens: modelRecord === undefined ? null : modelRecord.contextWindow,
              renderedContext: memoryView[0]!,
              structuredKeys: ['status', 'artifactContent'],
            });
            if (!budget.ok) return 'failed';
            const round = await executor.runRound({
              companyId: String(runRow.companyId),
              runId: String(context.runId),
              taskId: String(context.taskId),
              agentId: `agent.executor.${String(pkg.execution.taskKind)}`,
              roleId: pkg.execution.roleId as never,
              actorId: SESSION_ACTOR,
              context: {
                company: { id: pkg.identity.companyId, label: 'company' },
                workflow: { id: pkg.identity.templateId, label: 'workflow' },
                workflowVersion: pkg.identity.workflowVersionId,
                workflowRun: { id: pkg.identity.runId, label: 'run' },
                stage: { id: pkg.identity.stageId, label: 'stage' },
                task: { id: pkg.identity.taskId, label: 'task' },
                role: { id: pkg.execution.roleId, label: 'work' },
                objective: pkg.work.objective ?? pkg.goal.objective,
                memoryView,
                artifactRefs: pkg.dependencies.flatMap((dep) =>
                  dep.artifactRefs.map((ref) => ({ id: ref, label: 'predecessor' })),
                ),
              },
              prompt: { structuredKeys: ['status', 'artifactContent'] },
            });
            if (!round.ok) return 'failed';
            const structured = round.value.outcome.structured;
            if (structured === null || typeof structured !== 'object') return 'failed';
            const record = structured as Record<string, unknown>;
            if (record['status'] !== 'succeeded') return 'failed';
            /*
             * Sprint21 final corrective §4/§5: ANY trusted executor may produce CANONICAL
             * FINDINGS through the frozen findings contract — when the structured output
             * declares a verdict, the envelope kind is the review-findings CANDIDATE and
             * the ONE carrier routes it to the canonical findings sink (the sink validates
             * subject/report semantics; this handler never infers finding authority from
             * any stage classification). A normal work output keeps the generic work kind.
             */
            const declaresFindings =
              typeof record['verdict'] === 'string' && typeof record['subjectTaskId'] === 'string';
            if (declaresFindings) {
              return {
                status: 'succeeded',
                output: {
                  schemaVersion: 'companyos/stage-output/1',
                  kind: REVIEW_CANDIDATE_KIND,
                  executionId: round.value.executionId,
                  artifactRefs: [],
                  validationRefs: [],
                  payload: {
                    verdict: record['verdict'],
                    subjectTaskId: record['subjectTaskId'],
                    ...(Array.isArray(record['findings']) ? { findings: record['findings'] } : {}),
                  },
                },
              };
            }
            let artifactRefs: string[] = [];
            if (typeof record['artifactContent'] === 'string' && record['artifactContent'].length > 0) {
              const artifact = await sprint13ArtifactServiceHolder!.create({
                commandId: `executor-output:${String(context.runId)}:${String(context.taskId)}`,
                runId: String(context.runId) as never,
                taskId: String(context.taskId) as never,
                kind: 'companyos:executor-output',
                content: new TextEncoder().encode(String(record['artifactContent'])),
                producedBy: SESSION_ACTOR,
                traceId: `executor:${String(context.taskId)}`,
              });
              if (!artifact.ok) return 'failed';
              artifactRefs = [String(artifact.value.id)];
            }
            return {
              status: 'succeeded',
              output: {
                schemaVersion: 'companyos/stage-output/1',
                kind: WORK_ROLE_OUTPUT_KIND,
                executionId: round.value.executionId,
                artifactRefs,
                validationRefs: [],
                payload: record,
              },
            };
          },
        });
      }
      /*
       * Sprint24: kinds executed through the PROVIDER seam. The dispatch runs in
       * the StageHandler window (after the canonical attempt claim, outside any write
       * transaction) and returns the envelope the ENGINE settles canonically.
       */
      for (const kind of options.providerKinds ?? []) {
        merged.set(kind, {
          id: `provider.dispatch:${kind}`,
          execute: async (context) => {
            // F4 CLOSURE - the execution workspace is the GOAL'S DURABLE BINDING, never
            // "whatever is open right now". A mismatch fails CLOSED with a typed
            // canonical blocker before any dispatch (no kernel session is ever started
            // against a workspace the Goal was not bound to).
            const runContext = await resolveRunWorkspaceContext(String(context.runId));
            if (runContext === null) {
              throw domainError('VALIDATION_FAILED', 'The run has no durable workspace binding; execution is refused.', {
                reason: 'GOAL_WORKSPACE_NOT_BOUND',
                runId: String(context.runId),
              });
            }
            if (runContext.mismatch) {
              throw domainError('VALIDATION_FAILED', 'The currently open workspace differs from the Goal workspace binding; execution is refused (open the bound workspace to proceed).', {
                reason: 'GOAL_WORKSPACE_MISMATCH',
                runId: String(context.runId),
                boundRoot: runContext.root,
              });
            }
            const registry = executorProvidersHolder;
            const providerKey = providerRouteTable[kind] ?? '';
            if (registry === null || providerKey === '') return 'failed';
            const runRow = await database.runs.get(String(context.runId) as never);
            if (runRow === null) return 'failed';
            const taskRow = (await database.tasks.get(String(context.taskId) as never)) as
              | { readonly roleId: string; readonly stageId: string }
              | null;
            if (taskRow === null) return 'failed';
            const { createProviderDispatchExecution } = await import('./executor/provider-dispatch.js');
            const dispatch = createProviderDispatchExecution({
              ...(executionSafety === null ? {} : { prepareExternalAdmission: (request, route) => executionSafety.prepareExecutor({ runId: request.runId, attemptId: request.attemptId, ...(route === undefined ? {} : { route }), ...(options.embeddedDshModelRoute === undefined ? {} : { fallback: options.embeddedDshModelRoute }) }) }),
              attemptTimeoutMs: executionAttemptTimeoutMs,
              registry,
              dispatches: database.providerDispatches,
              clock,
              /*
               * LIVE-SMOKE-FIX-08 P1-2 — durable dispatch AUDIT through the existing
               * event store: requested BEFORE the provider launch, settled after;
               * payloads redacted against the active vault values. Evidence only —
               * the ExecutionAttempt row stays the canonical execution truth.
               */
              dispatchAudit: {
                append: (events) => database.events.append(events as never).then(() => undefined),
                secrets: () => vault.values(),
                ids,
              },
              /*
               * Sprint25 — the trusted workspace root for this run. F4 CLOSURE: the
               * RESOLVED run-scoped context pinned at handler entry (Goal durable binding,
               * checked against the open workspace) flows into the dispatch itself — the
               * later dispatch NEVER re-reads global state, so a workspace switch inside
               * this window cannot redirect the executor (TOCTOU closed).
               */
              workspaceOf: () => runContext.root,
              requiredCapabilitiesOf: () => ['timeout', 'structured-output'],
              /*
               * STAGE E3 — the retry continuation derivation seam (DERIVED, non-canonical):
               * prior settled attempts of the SAME task from the durable attempt store +
               * the immediately previous attempt's bounded E1 activity events. Null for the
               * initial attempt of a task. Never persisted as its own truth; never consulted by
               * settlement, budget, routing, or the canonical attempt identity.
               */
              retryContextOf: ({taskId, attemptNumber}) => {
                const prior = database.db
                  .prepare('SELECT id, attempt_number, state, failure_code, failure_retryable, created_at, settled_at FROM execution_attempts WHERE task_id = ? AND attempt_number < ? ORDER BY attempt_number, id')
                  .all(taskId, attemptNumber) as {
                  id: string; attempt_number: number; state: string; failure_code: string | null;
                  failure_retryable: number | null; created_at: string; settled_at: string | null;
                }[];
                const previous = prior.length === 0 ? null : prior[prior.length - 1]!;
                const events = previous === null ? [] : (database.db
                  .prepare("SELECT type, occurred_at, payload FROM events WHERE aggregate_id = ? AND type IN ('executor.tool_invocation_requested', 'executor.attempt_activity') ORDER BY rowid LIMIT 200")
                  .all(previous.id) as {type: string; occurred_at: string; payload: string}[]);
                return deriveRetryContinuationEnvelope({
                  taskId,
                  attemptNumber,
                  priorAttempts: prior.map((row) => ({
                    id: row.id, attemptNumber: row.attempt_number, state: row.state,
                    failureCode: row.failure_code, failureRetryable: row.failure_retryable === null ? null : row.failure_retryable === 1,
                    createdAt: row.created_at, settledAt: row.settled_at,
                  })),
                  previousAttemptEvents: events.map((row) => {
                    let payload: unknown = null;
                    try { payload = JSON.parse(row.payload ?? 'null'); } catch { payload = null; }
                    return {type: row.type, occurredAt: row.occurred_at, payload};
                  }),
                });
              },
              /*
               * Agentic Work Package Contract — the canonical Work Envelope, projected
               * from the Work Package (the derived execution projection of ONE task):
               * the byte-exact plan-item objective (else the run-owned canonical goal),
               * the pinned acceptance criteria, the canonical Task.inputs, read-only
               * predecessor artifact references and a bounded context render. The
               * composition owns this mapping; the dispatch only transports it; a
               * projection failure fails the dispatch closed (never a synthetic
               * taskKind label standing in for business semantics).
               */
              workContextOf: async (runId, taskId) => {
                const projector = workPackageProjectorHolder;
                if (projector === null) {
                  return err(
                    new DomainError(
                      'PERSISTENCE_FAILED',
                      'The Work Package projector is not wired; canonical work context cannot be projected.',
                      { details: { reason: 'WORK_PACKAGE_PROJECTOR_UNAVAILABLE' } },
                    ),
                  );
                }
                const pkg = await projector.project({
                  companyId: String(runRow.companyId),
                  runId,
                  taskId,
                });
                if (!pkg.ok) return pkg;
                return ok(projectWorkEnvelope(pkg.value));
              },
              /*
               * Final Readiness Gate — canonical ARTIFACT materialization for declared
               * provider outputs: the ONE Sprint-13 artifact service (Option-B
               * idempotent command id scoped to this run+task+attempt), the SAME
               * `companyos:executor-output` kind the generic executor handler uses.
               * Only the canonical reference returns; content never rides the envelope.
               */
              materializeArtifactOf: async ({ runId, taskId, attemptId, content }) => {
                const artifactService = sprint13ArtifactServiceHolder;
                if (artifactService === null) {
                  return err(
                    new DomainError(
                      'PERSISTENCE_FAILED',
                      'The artifact service is not wired; a declared provider output cannot be canonicalized.',
                      { details: { reason: 'ARTIFACT_SERVICE_UNAVAILABLE' } },
                    ),
                  );
                }
                const created = await artifactService.create({
                  commandId: `provider-output:${runId}:${taskId}:${attemptId}`,
                  runId: runId as never,
                  taskId: taskId as never,
                  kind: 'companyos:executor-output',
                  content: new TextEncoder().encode(content),
                  producedBy: SESSION_ACTOR,
                  traceId: `provider-output:${taskId}`,
                });
                return created.ok
                  ? ok({ artifactId: String(created.value.id) })
                  : created;
              },
              verifyFileDeliveryOf: async ({ runId, taskId, attemptId, finalText }) => {
                if (fileDeliveryContextOf === null || verifiedFileCarrier === null) return err(new DomainError('PERSISTENCE_FAILED', 'The canonical file delivery verifier is unavailable.'));
                try { return await verifiedFileCarrier({ context: await fileDeliveryContextOf(runId, taskId), attemptId, finalText }); }
                catch (error) { return err(error instanceof DomainError ? error : new DomainError('VALIDATION_FAILED', 'File delivery context could not be verified.')); }
              },
              fileDeliveryGoalOf: (runId) => database.executionBudget.goalOf(runId),
              // The typed configuration this provider would run under (fail closed when absent).
              configOf: (key) => executorConfigsHolder.get(key) ?? null,
              /*
               * Authorization provenance — never an ad-hoc boolean. An ordinary,
               * workspace-anchored dispatch is authorized by the composition's own
               * provider registration (operator-supplied trusted data). Anything
               * that would relax a boundary needs a human approval from the
               * EXISTING run approval mechanism, which the run must present.
               */
              authorizationOf: async ({ runId }) => {
                const workspace = repositoryRuntime.currentWorkspace();
                if (workspace !== null) {
                  return {
                    present: true,
                    source: 'composition-policy' as const,
                    reference: `provider-registration:${providerKey}`,
                  };
                }
                const approved = await approvedApprovalReferenceOf(database.approvals, runId);
                return approved === null
                  ? null
                  : { present: true, source: 'decision-approval' as const, reference: approved };
              },
              /*
               * STAGE 8B §9 — the routing mode: one selection authority per
               * attempt. DETERMINISTIC_V1 (default) leaves the Stage 6 selector
               * as the owner; SMART_ROUTER_V1 routes through the Smart Router
               * before the kernel is invoked.
               */
              routingMode: options.modelRouting?.mode ?? 'DETERMINISTIC_V1',
              /*
               * STAGE 8B §5-§7 — the routing seam. Resolves the canonical role
               * seat, derives complexity/risk from the canonical Work Package,
               * runs the Smart Router, and projects the decision + route +
               * evidence for THIS attempt. Only consulted in SMART_ROUTER_V1.
               */
              routeModelOf:
                options.modelRouting?.mode === 'SMART_ROUTER_V1' && options.modelRouting.pool !== undefined
                  ? async ({ attemptId, runId, taskId, roleId }) => {
                      const pool = options.modelRouting!.pool!;
                      const catalog = roleCatalogHolder ?? new RoleCatalog();
                      const projector = workPackageProjectorHolder;
                      if (projector === null) {
                        return err(
                          new DomainError('PERSISTENCE_FAILED', 'The Work Package projector is not wired; canonical routing requirements cannot be derived.', {
                            details: { reason: 'WORK_PACKAGE_PROJECTOR_UNAVAILABLE' },
                          }),
                        );
                      }
                      const pkg = await projector.project({ companyId: String(runRow.companyId), runId, taskId });
                      if (!pkg.ok) return pkg;
                      const routed = await routeRuntimeAttempt({
                        pool,
                        catalog,
                        attemptId,
                        taskId,
                        roleId,
                        pinnedResponsibility: pkg.value.execution.professionalResponsibility,
                        runId,
                        companyId: String(runRow.companyId),
                        workPackage: pkg.value,
                        ...(options.modelRouting!.policy === undefined ? {} : { policy: options.modelRouting!.policy }),
                        ...(options.modelRouting!.pinnedProfileId === undefined ? {} : { pinnedProfileId: options.modelRouting!.pinnedProfileId }),
                        ...(options.modelRouting!.highRiskKinds === undefined ? {} : { highRiskKinds: options.modelRouting!.highRiskKinds }),
                        ...(options.modelRouting!.mediumRiskKinds === undefined ? {} : { mediumRiskKinds: options.modelRouting!.mediumRiskKinds }),
                      });
                      if (!routed.ok) return routed;
                      /*
                       * CREDENTIAL RESOLUTION CLOSURE (PROD-01B): a profile that DECLARES
                       * a credentialRef must resolve to a real value HERE — inside the
                       * CompanyOS process, BEFORE any provider invocation. A declared
                       * pointer that cannot be resolved (missing vault entry, empty
                       * value) fails the dispatch CLOSED with the existing typed code:
                       * the pointer string must never travel onward as a credential
                       * (never to the provider, never to the broker, never upstream).
                       * A profile with NO credentialRef is a legal no-auth contract and
                       * dispatches as-is — provider-neutrality preserved. The Doctor
                       * remains UX/preflight only; THIS is the security boundary.
                       */
                      if (routed.value.route.credentialRef !== '') {
                        const credentialEnvName = routed.value.route.credentialRef.replace(/^vault:\/\//u, '').split('/')[0] ?? '';
                        const credentialValue = await vault.resolve({
                          id: `${routed.value.route.providerId}:api-key`,
                          providerId: routed.value.route.providerId,
                          purpose: 'api-key',
                          source: 'env',
                          envName: credentialEnvName,
                        });
                        if (credentialValue === null || credentialValue === '') {
                          return err(
                            new DomainError('VALIDATION_FAILED', `The selected model profile's credential is not available in the secret vault (ref "${routed.value.route.credentialRef}").`, {
                              details: { reason: 'MODEL_CREDENTIAL_MISSING', credentialRef: routed.value.route.credentialRef },
                            }),
                          );
                        }
                        return ok({ ...routed.value, route: { ...routed.value.route, credentialValue } });
                      }
                      return routed;
                    }
                  : undefined,
              /*
               * STAGE 8B §11-§12 — the role context seam: the bounded envelope
               * built from canonical durable truth (goal, plan item, task, role
               * responsibility, durable handoff packets addressed to this seat,
               * decisions, artifact/evidence refs, criteria, risks) plus the
               * attempt's CompanyOS-selected model as a label.
               */
              roleContextOf: async ({ runId, taskId, roleId, attemptModelLabel }) => {
                const projector = workPackageProjectorHolder;
                if (projector === null) {
                  return err(
                    new DomainError('PERSISTENCE_FAILED', 'The Work Package projector is not wired; canonical role context cannot be built.', {
                      details: { reason: 'WORK_PACKAGE_PROJECTOR_UNAVAILABLE' },
                    }),
                  );
                }
                const pkg = await projector.project({ companyId: String(runRow.companyId), runId, taskId });
                if (!pkg.ok) return pkg;
                const packets =
                  database.handoffStore === null
                    ? []
                    : await database.handoffStore.listForScope({ companyId: String(runRow.companyId), workflowRunId: runId, taskId });
                const context = consumerContextOfWorkPackage({
                  pkg: pkg.value,
                  roleInstanceId: roleId,
                  handoffPackets: packets,
                });
                if (!context.ok) return context;
                // The SAME deterministic role resolution the routing phase uses
                // (catalog match → dynamic synthesis): the responsibility comes from
                // the role, never from the task objective. STAGE 8C: the DERIVED
                // requirement pinned beside the task profile is the durable truth.
                const resolvedRole =
                  roleCatalogHolder === null
                    ? null
                    : resolveCanonicalRole(roleCatalogHolder, {
                        roleId,
                        pinnedResponsibility: pkg.value.execution.professionalResponsibility,
                        runId,
                        companyId: String(runRow.companyId),
                        roleInstanceId: `ri_${taskId}`,
                      });
                return ok({
                  roleName: pkg.value.execution.roleId,
                  professionalResponsibility:
                    resolvedRole !== null && resolvedRole.ok
                      ? resolvedRole.value.professionalResponsibility
                      : `Professional responsibility of role ${roleId}`,
                  hardConstraints: context.value.hardConstraints,
                  relevantDecisionSummaries: context.value.relevantDecisionSummaries,
                  knownRisks: context.value.knownRisks,
                  remainingQuestions: context.value.remainingQuestions,
                  attemptModelLabel,
                  envelopeSizeBytes: JSON.stringify(context.value).length,
                });
              },
              /*
               * STAGE 8B §3 — the durable handoff write: the producer's
               * canonical artifacts/evidence become a READY canonical handoff
               * packet (existing Sprint-11 owner) addressed to the consumer
               * seat resolved from the SAME pinned DAG the projection reads.
               */
              recordHandoffOf:
                handoffServiceHolder !== null && database.handoffStore !== null
                  ? async ({ runId, taskId, attemptId, producerRoleId, objective, artifactRefs, validationRefs }) => {
                      await executionSafety?.budget.check(runId);
                      // STAGE 8B §3: the Professional Handoff Contract demands at
                      // least one durable Artifact — a producer with no durable
                      // output records nothing (no professional transfer exists).
                      if (artifactRefs.length === 0) return ok({ handoffId: '', recorded: false });
                      const successor = await successorSeatOf(database, runId, taskId);
                      // Stage 8B §3: a TERMINAL producer stage (no consumer seat in the
                      // pinned DAG) has nobody to hand off to — nothing is recorded.
                      if (successor === null) return ok({ handoffId: '', recorded: false });
                      const service = handoffServiceHolder;
                      if (service === null) {
                        return err(
                          new DomainError('PERSISTENCE_FAILED', 'The handoff service is not wired; a producer handoff cannot be recorded durably.', {
                            details: { reason: 'HANDOFF_SERVICE_UNAVAILABLE' },
                          }),
                        );
                      }
                      const mapping: RuntimeHandoffMapping & { readonly actorId: string } = {
                        handoffId: `ho_${attemptId}`,
                        companyId: String(runRow.companyId),
                        workflowId: String(runRow.templateId),
                        workflowVersionId: String(runRow.versionId),
                        workflowRunId: runId,
                        stageId: successor?.stageId ?? String(taskRow.stageId),
                        taskId: successor?.taskId ?? taskId,
                        fromAgentId: SESSION_ACTOR,
                        fromRoleId: producerRoleId,
                        toRoleId: successor?.roleId ?? '',
                        objective,
                        recommendedNextAction: objective,
                        traceId: `handoff:${attemptId}`,
                        createdAt: clock.nowIso(),
                        actorId: SESSION_ACTOR,
                      };
                      const recorded = await recordRuntimeHandoff(
                        {
                          createDraft: (input) => service.createDraft(input as never),
                          // READY and the final cancellation/admission read share the
                          // canonical transaction: cancel cannot commit between them.
                          ready: async (input) => database.unitOfWork.transaction(async () => {
                            await executionSafety?.budget.check(runId);
                            const result = await service.ready(input);
                            if (!result.ok) throw result.error;
                            return result.value;
                          }),
                        },
                        {
                          handoff: {
                            handoffId: mapping.handoffId,
                            producerRoleInstanceId: producerRoleId,
                            consumerRoleInstanceId: mapping.toRoleId,
                            sourceTaskId: taskId,
                            targetTaskId: mapping.taskId,
                            artifactRefs,
                            evidenceRefs: validationRefs ?? [],
                            decisionRefs: [],
                            acceptanceCriteria: [],
                            knownRisks: [],
                            remainingQuestions: [],
                            handoffReason: objective,
                          },
                          mapping,
                        },
                      );
                      if (!recorded.ok) return recorded;
                      return ok({ handoffId: recorded.value.handoffId, recorded: true });
                    }
                  : undefined,
            });
            const result = await dispatch.execute(
              {
                companyId: String(runRow.companyId),
                runId: String(context.runId),
                taskId: String(context.taskId),
                // Sprint26 V2: the provider receives the CANONICAL attempt identity —
                // the deterministic exa_ derivation, never a task-id stand-in.
                attemptId: executionAttemptIdOf({
                  companyId: String(runRow.companyId),
                  runId: String(context.runId),
                  taskId: String(context.taskId),
                  attemptNumber: Number(context.attempt),
                }),
                attemptNumber: Number(context.attempt),
                // The CANONICAL execution seat: the task's own pinned role — the SAME
                // role the ExecutionAttempt claim records (engine claims with
                // task.roleId). A pseudo "provider" role label here would conflate the
                // professional-responsibility vocabulary with the provider-routing
                // vocabulary; provider identity already travels as providerKey.
                roleId: String(taskRow.roleId),
                taskKind: String(context.kind),
              },
              providerKey,
            );
            /*
             * LIVE-SMOKE-FIX-04 — the dispatch's TYPED failure travels to the engine so
             * the attempt settlement can never lose its cause:
             *   - pre-dispatch failures (provider resolution, safety preflight, work
             *     projection, routing, credential) are DETERMINISTIC config/invariant
             *     classes: retryable false — the engine settles FAILED without the
             *     automatic RETRY (fail fast, one attempt; the Smoke-04 burn class);
             *   - a durable dispatch claim can also contain NOT_INVOKED admission
             *     refusal. Such safety refusals never authorize an automatic retry.
             *     Actual transport/provider failures retain the outer-attempt policy.
             * S9B-A exception: the NOT-READY projection refusal is a precondition-TIMING
             * state, not a config/invariant failure — see below.
             */
            if (result.output === 'failed') {
              const deterministicSafetyRefusal = result.failure?.code === 'POLICY_DENIED' || result.failure?.code === 'VALIDATION_FAILED' || result.failure?.reason.startsWith('GOAL_') === true || result.failure?.reason.startsWith('FILE_DELIVERY_') === true;
              const dispatchReachedProvider = result.dispatchId !== '' && !deterministicSafetyRefusal;
              // The failure envelope contract accepts UPPER_SNAKE codes only; provider
              // outcome kinds arrive kebab-case ('transport-failed') — normalize at the
              // boundary so the engine's envelope validation can never reject a real
              // failure as malformed (which would silently fail the whole run).
              const rawCode = result.failure?.reason ?? 'EXECUTION_FAILED';
              const code = rawCode.toUpperCase().replaceAll('-', '_');
              /*
               * S9B-A — WORK_PACKAGE_DEPENDENCY_NOT_READY is a precondition-TIMING state,
               * not a config/invariant failure: the canonical dependencies of the Work
               * Package are not durably satisfied YET (the work projection refused the
               * dispatch — e.g. a corrective round reached a stage whose predecessor
               * stage's work is still open). It stays RETRYABLE so the engine's existing
               * RETRY keeps the task in canonical waiting (READY) and a later step
               * re-claims it against FRESH durable truth — never a false permanent
               * failure, and never an unbounded retry (the existing attempt budget still
               * bounds it). Every other pre-dispatch class above stays fail-fast.
               */
              const notReady = code === 'WORK_PACKAGE_DEPENDENCY_NOT_READY';
              return {
                status: 'failed' as const,
                failure: {
                  code,
                  ...(result.failure?.stage === undefined || result.failure?.stage === null ? {} : {stage: result.failure.stage}),
                  retryable: dispatchReachedProvider || notReady,
                },
              };
            }
            return result.output;
          },
        });
      }
      /*
       * BB-WATCH-001 closeout: review/qa turns declare their TRUE shapes — the
       * verdict-bearing review envelope (verdict string, subjectTaskId string, findings
       * ARRAY) and the QA validation-request envelope (targetRef string, validators
       * ARRAY). The strict carrier checks (declaresFindings / the validation command
       * router) remain the authority.
       */
      for (const kind of options.stageHandlers?.reviewKinds ?? []) {
        merged.set(
          kind,
          build(kind, 'review', ['verdict', 'subjectTaskId', 'findings'], {
            mode: 'json_schema',
            schemaName: 'companyos_review_verdict',
            schema: {
              type: 'object',
              required: ['verdict', 'subjectTaskId'],
              additionalProperties: true,
              properties: {
                verdict: { type: 'string', enum: [...REVIEW_VERDICTS] },
                subjectTaskId: { type: 'string', minLength: 1 },
                findings: { type: 'array', items: { type: 'string' } },
              },
            },
          }),
        );
      }
      for (const kind of options.stageHandlers?.qaKinds ?? []) {
        merged.set(
          kind,
          build(kind, 'qa', ['targetRef', 'validators'], {
            mode: 'json_schema',
            schemaName: 'companyos_qa_validation_request',
            schema: {
              type: 'object',
              required: ['targetRef', 'validators'],
              additionalProperties: true,
              properties: {
                targetRef: { type: 'string', minLength: 1 },
                validators: { type: 'array', minItems: 1, items: { type: 'string' } },
              },
            },
          }),
        );
      }
      return merged;
    };

    /**
     * Task-18-07 corrective: the ONLY autonomous model execution path. The model comes from the
     * run's pinned snapshot; the method exposes no model identity to override with.
     */
    const pinnedAgentExecution =
      database.agentExecutions !== null
        ? createPinnedAgentExecution({
            runs: database.runs,
            modelBindings: createRunModelBindingReader({
              runs: database.runs,
              snapshots: database.snapshots,
            }),
            modelRegistry: models,
            agentRuntime: runtime,
            // Trusted configuration: the binding an autonomous Developer/Reviewer/QA execution
            // resolves. Pack semantics stay data — this name is configuration, not a role.
            bindingKey: options.supervisorBindingKey ?? SUPERVISOR_BINDING_KEY,
            clock,
          })
        : null;

    /**
     * Task-18-07 corrective (PRODUCTION_TURN_TWO_DEFECT): the agent unit the orchestrator runs
     * for REVIEWING/VALIDATING tasks. The engine's stage execution can only terminate with
     * `EXECUTION.COMPLETE`, which is legal from EXECUTING alone — so those phases run their
     * tasks as ONE pinned agent round through the deployment's agent-backed handler, the SAME
     * handler the engine would have used, invoked directly so that no run-level lifecycle event
     * is implied. Pack semantics stay data: which kind is a review/QA kind is configuration.
     */
    let agentHandlers: ReadonlyMap<string, StageHandler> | null = null;
    const agentUnitRunner = (input: {
      readonly companyId: string;
      readonly runId: string;
      readonly taskId: string;
      readonly taskKind: string;
      readonly stageId: string;
      readonly signal?: AbortSignal;
    }): Promise<Result<StageHandlerReturn, DomainError>> => {
      const handlers = agentHandlers ?? (agentHandlers = composedStageHandlers(new Map<string, StageHandler>()));
      const handler = handlers.get(input.taskKind);
      if (handler === undefined) {
        return Promise.resolve({
          ok: false as const,
          error: new DomainError(
            'PERSISTENCE_FAILED',
            `No agent-backed handler is registered for kind "${input.taskKind}".`,
            { details: { reason: 'AUTONOMOUS_AGENT_UNIT_UNAVAILABLE', kind: input.taskKind } },
          ),
        });
      }
      // The handler's OWN return rides the value seat: the orchestrator normalizes it at the one
      // boundary it owns, the same one the engine uses (never a second normalization here).
      return Promise.resolve(
        handler.execute({
          runId: input.runId as never,
          stageId: input.stageId as never,
          taskId: input.taskId as never,
          kind: input.taskKind,
          attempt: 1,
          branch: null,
          payload: {},
        }),
      ).then((value): Result<StageHandlerReturn, DomainError> => ({ ok: true as const, value }));
    };

    /**
     * The required validators of one stage, read from the run's PINNED version snapshot — the
     * same authority the Sprint 13 evidence gate uses (R1-B). Never a caller's claim.
     */
    const stagePolicyOf = async (
      runId: string,
      stageId: string,
    ): Promise<
      | { readonly ok: true; readonly value: readonly string[] }
      | { readonly ok: false; readonly error: DomainError }
    > => {
      const run = await database.runs.get(runId as never);
      if (run === null) {
        return {
          ok: false as const,
          error: new DomainError('NOT_FOUND', `Run "${runId}" not found.`, { details: { runId } }),
        };
      }
      const template = await database.templates.get(String(run.templateId) as never);
      const version = template?.versions.find((entry) => entry.id === run.versionId);
      if (version === undefined) {
        return {
          ok: false as const,
          error: new DomainError('NOT_FOUND', `The version pinned by run "${runId}" is missing.`, {
            details: { runId },
          }),
        };
      }
      const node = version.graph.nodes.find((entry) => entry.id === stageId);
      if (node === undefined) return { ok: true as const, value: [] as readonly string[] };
      return { ok: true as const, value: [...validatorIdsOf(node)] };
    };
    // Sprint21 (generic orchestration): the deployment-declared stage classes, the
    // run-scoped task read and the pinned-graph read — trusted data seams for the
    // engine's multi-stage DAG advance.
    /*
     * Sprint21 final corrective: stage classes are GONE as orchestration authority. The
     * reviewKinds/qaKinds/developerKinds/executorKinds options remain what they always
     * were at this boundary — EXECUTOR REGISTRATION data (which trusted implementation
     * answers which pinned task kind), never a workflow-phase classification.
     */
    const tasksOfRun = (runId: string): Promise<readonly Task[]> => database.tasks.listByRun(runId);
    const pinnedGraphOf = async (runId: string) => {
      const run = await database.runs.get(runId as never);
      if (run === null) {
        return {
          ok: false as const,
          error: new DomainError('NOT_FOUND', `Run "${runId}" not found.`, {
            details: { runId },
          }),
        };
      }
      const template = await database.templates.get(String(run.templateId) as never);
      const version = template?.versions.find((entry) => entry.id === run.versionId);
      if (version === undefined) {
        return {
          ok: false as const,
          error: new DomainError('NOT_FOUND', `The version pinned by run "${runId}" is missing.`, {
            details: { runId },
          }),
        };
      }
      const graph = version.graph as {
        nodes: readonly { id: string; kind?: string }[];
        edges: readonly { from: string; to: string }[];
      };
      return { ok: true as const, value: graph };
    };
    const sprint13 = composeSprint13Application({
      ...(executionSafety === null ? {} : { cancellation: { request: executionSafety.requestCancel, requested: executionSafety.budget.isCancelled } }),
      database,
      contentStore: artifactFoundation.contentStore,
      clock,
      ids,
      authorize: sessionAuthorize,
      tools,
      logger: activeLogger,
      runtimeInstanceId,
      ...(options.faultCheckpoints === undefined ? {} : { faultCheckpoints: options.faultCheckpoints }),
      engineExtras: { tasksOfRun, pinnedGraphOf },
      // T17-08: the repository-capable stage handlers, for the kinds this deployment
      // declares. The engine's own registry is unchanged — scripted handlers still answer
      // every other kind.
      stageHandlers: composedStageHandlers(repositoryRuntime.handlers()),
    });
    // Sprint21 final — canonical startup orphan recovery under the supported V1
    // single-runtime boundary: the PREVIOUS runtime instance's ACTIVE attempts are the
    // only ones that can exist at startup, so they transition to INTERRUPTED (same
    // durable attempt identity preserved — recovery reacquires, never re-numbers).
    await database.executionAttempts.interruptActiveOfRuntime(null, clock.nowIso());
    sprint13ArtifactServiceHolder = sprint13.artifactService;

    /*
     * H12b — Goal cancellation terminal convergence. `goal.cancel` commits the durable
     * intent first and settles every owned run to the typed terminal FAILED/cancelled
     * afterwards (never holding the caller on an in-flight turn). If the process ends
     * between the two — or a settlement attempt failed — the intent stays durable while a
     * run stays non-terminal, and the boss would see a cancelled Goal still "PLANNING".
     * Every composition therefore re-settles: a Goal with a durable cancellation intent
     * gets each owned non-terminal run cancelled through the engine's own RUN.CANCEL
     * (idempotent: a terminal run is left untouched, so a cancelled terminal is never
     * rewritten and a COMPLETED/FAILED run is never turned into cancelled).
     */
    const settleGoalCancellation = async (goalRunId: string): Promise<readonly string[]> => {
      const engine = sprint13.engine;
      if (engine === null) return [];
      const owned = await database.db.writeFence.serialize(async () => database.db.prepare(
        "SELECT id FROM runs WHERE (execution_goal_run_id = ? OR id = ?) AND state NOT IN ('COMPLETED', 'FAILED') ORDER BY id",
      ).all(goalRunId, goalRunId) as { id: string }[]);
      const unsettled: string[] = [];
      for (const { id } of owned) {
        try {
          await engine.cancel(id as never);
        } catch (error: unknown) {
          unsettled.push(id);
          activeLogger.error('Goal cancellation terminal settlement remains blocked', { runId: id, code: error instanceof DomainError ? error.code : 'INTERNAL' });
        }
      }
      return unsettled;
    };
    if (executionSafety !== null && sprint13.engine !== null) {
      const budgetedGoals = await database.db.writeFence.serialize(async () => database.db.prepare(
        'SELECT id FROM runs WHERE execution_goal_run_id = id AND execution_budget_json IS NOT NULL ORDER BY id',
      ).all() as { id: string }[]);
      for (const { id } of budgetedGoals) {
        if (!(await executionSafety.budget.isCancelled(id))) continue;
        const unsettled = await settleGoalCancellation(id);
        if (unsettled.length > 0) activeLogger.error('Goal cancellation convergence incomplete at startup', { goalRunId: id, unsettled: unsettled.length });
      }
    }

    // ---- workflow lifecycle (Sprint 4) + the T18-02 execution context -------------------
    // Composed HERE, not in the electron entry, so the desktop bootstrap and the tests share
    // ONE production wiring. The three Sprint 18 dependencies are the trusted application
    // configuration of this composition:
    //   ledger         — run-creation replay uses the same durable ledger as every command;
    //   runGoal        — the canonical run goal rides the run-owned immutable artifact
    //                    (no Goal table, no schema change); absent ⇒ a caller-supplied goal
    //                    fails closed instead of silently disappearing;
    //   modelRegistry  — `RunSnapshot.modelBindings` is proven against the real registry
    //                    before any write; absent ⇒ supplied bindings are refused.
    // The run-goal reader/writer over the run-owned immutable artifact (T18-02). Built
    // once and shared: the lifecycle writes the goal, the supervisor decision sink reads it.
    const runGoalWriter: ReturnType<typeof createRunGoalService> | null =
      database.artifactStore === null
        ? null
        : createRunGoalService({
            artifactService: sprint13.artifactService,
            artifactStore: database.artifactStore,
            contentStore: artifactFoundation.contentStore,
            runs: database.runs,
          });

    /*
     * F4 CLOSURE - the DURABLE GOAL WORKSPACE BINDING resolver. The binding is the
     * run-goal structured payload's opaque "workspaceId" (the canonical workspace
     * identity captured at goal.create from the MAIN-process active workspace - never
     * a renderer value, never a local path). Every later execution or validation of
     * the run resolves Goal -> binding and verifies it against the currently open
     * workspace: a workspace switch NEVER re-targets an existing Goal. Read-only over
     * the ONE run-goal truth - no second workspace table.
     */
    const resolveRunWorkspaceContext = async (
      runId: string,
    ): Promise<{ readonly root: string; readonly accessPolicy: string; readonly mismatch: boolean } | null> => {
      if (runGoalWriter === null) return null;
      const goal = await runGoalWriter.get({ runId, companyId: 'company_default' });
      if (!goal.ok) return null;
      const structured = goal.value.structured ?? {};
      const boundId = structured['workspaceId'];
      if (typeof boundId !== 'string' || boundId.trim() === '') return null;
      const policy = structured['accessPolicy'];
      const active = repositoryRuntime.currentWorkspace();
      return {
        // The root is only consumed when the ids MATCH - the same canonical workspace
        // (the id is derived from the canonical realpath), so this is the bound root.
        root: active?.canonicalRoot ?? '',
        accessPolicy: typeof policy === 'string' && policy !== '' ? policy : 'ASK_PERMISSION',
        mismatch: (active?.workspaceId ?? '') !== boundId,
      };
    };

    const lifecycle = createWorkflowLifecycle({
      faultCheckpoints: options.faultCheckpoints,
      ids,
      clock,
      templates: database.templates,
      locks: database.locks,
      proposals: database.proposals,
      snapshots: database.snapshots,
      runs: database.runs,
      events: database.events,
      ...(packAvailability === undefined ? {} : { packAvailability }),
      ...(packProvenance === undefined ? {} : { packProvenance }),
      unitOfWork: database.unitOfWork,
      ledger: database.ledger,
      // ONE shared run-goal service: the lifecycle writes the canonical goal through it
      // and the T18-03 decision sink reads it back through the same instance.
      ...(runGoalWriter === null ? {} : { runGoal: runGoalWriter }),
      modelRegistry: models,
      logger: activeLogger,
      // V1 policy: only the session actor may act; the Role store deepens this later.
      authorize: async ({ actorId }: { readonly actorId: string }) =>
        actorId === SESSION_ACTOR
          ? { ok: true as const, value: true as const }
          : {
              ok: false as const,
              error: new DomainError(
                'POLICY_DENIED',
                `Actor "${actorId}" is not the session actor.`,
                {
                  details: { actorId, sessionActor: SESSION_ACTOR },
                },
              ),
            },
    });
    void sprint13;

    /**
     * Sprint 18 (T18-03): the ONE supervisor decision sink — the first production writer of
     * the generic `DecisionStore`. It is a TRUSTED APPLICATION SERVICE, deliberately NOT an
     * IPC channel and NOT a Tool: a future Supervisor runtime calls it in-process. Every
     * context check reuses the Sprint 18 seams (goal, snapshot verifier, binding reader) and
     * the existing durable-reference resolver, so no second policy graph exists here.
     */
    const supervisorDecisionSink =
      database.decisions !== null && database.artifactStore !== null && runGoalWriter !== null
        ? createSupervisorDecisionSink({
            runs: database.runs,
            tasks: database.tasks,
            templates: database.templates,
            decisions: database.decisions,
            runGoal: runGoalWriter,
            runSnapshotVerifier: sprint13.runSnapshotVerifier,
            modelBindings: createRunModelBindingReader({
              runs: database.runs,
              snapshots: database.snapshots,
            }),
            modelRegistry: models,
            durableReferenceResolver,
            // F5-C-R1 — the durable POST-COMMIT stamp: the sink commits a Decision only
            // while the execution that owns the turn is durably RUNNING — the conditional
            // marker write IS the authority check, inside the same transaction as the insert.
            commitOutcomeOf: async (executionId: string, decisionId: string, at: string, nowIso: string) => {
              const owner = await database.agentExecutions?.get(executionId);
              if (owner != null && await executionSafety?.budget.isCancelled(String(owner.runId))) return false;
              return (await database.agentExecutions?.commitOutcome(executionId, decisionId, at, nowIso)) ?? false;
            },
            // V1 policy: only the session actor may act (the Role store deepens this later).
            authorize: sessionAuthorize,
            unitOfWork: database.unitOfWork,
            // 4a6e362 (N4-A1) — the inside-transaction diagnostic checkpoints (default absent).
            ...(options.faultCheckpoints === undefined
              ? {}
              : { faultCheckpoints: options.faultCheckpoints }),
            clock,
            ids,
          })
        : null;

    /**
     * Sprint 18 (T18-04): the ONE review findings sink — a trusted application service that
     * writes structured reviewer claims as immutable run-owned artifacts through the SAME
     * artifact path as everything else. Recording never mutates a task, stage, run, validation
     * or approval, and a PASS verdict is not a QA pass.
     */
    const reviewFindingsSink =
      database.artifactStore !== null && database.agentExecutions !== null && runGoalWriter !== null
        ? createReviewFindingsSink({
            runs: database.runs,
            tasks: database.tasks,
            templates: database.templates,
            agentExecutions: database.agentExecutions,
            artifactService: sprint13.artifactService,
            artifactStore: database.artifactStore,
            contentStore: artifactFoundation.contentStore,
            runGoal: runGoalWriter,
            runSnapshotVerifier: sprint13.runSnapshotVerifier,
            modelBindings: createRunModelBindingReader({
              runs: database.runs,
              snapshots: database.snapshots,
            }),
            modelRegistry: models,
            durableReferenceResolver,
            unitOfWork: database.unitOfWork,
            clock,
            ids,
          })
        : null;

    /**
     * Sprint 19 (T19-04): the bounded STATELESS role-context projectors for the review and
     * validation handlers. Every canonical fact is re-read fresh per invocation; there is NO
     * session kernel here (the roles own no durable conversational state), no Developer
     * transcript access, and no cached prompt. The projectors are the ONLY context builders on
     * those two production paths.
     */
    const boundedAgentContext = createBoundedAgentContext({
      runs: database.runs,
      tasks: database.tasks,
      goal: {
        get: ({ runId, companyId }) =>
          runGoalWriter === null
            ? Promise.resolve({
                ok: false as const,
                error: new DomainError(
                  'PERSISTENCE_FAILED',
                  'The run-goal reader is not wired for the bounded role contexts.',
                  { details: { reason: 'RUN_GOAL_WRITER_UNAVAILABLE' } },
                ),
              })
            : runGoalWriter.get({ runId, companyId }),
      },
      latestReviewReport: async (input) => {
        if (reviewFindingsSink === null) return { ok: true as const, value: null };
        /*
         * The newest canonical report ACROSS the run's review anchors — the same run-wide
         * anti-cherry-pick rule the supervisor turn and the evidence applicator use. The
         * STAGE 9B-FIX semantic order (corrective generation → createdAt → artifactId)
         * picks it: an id never arbitrates between non-equivalent reports.
         */
        const anchors = await reviewTaskAnchorsOf(database, input.runId);
        const candidates: ({
          readonly artifactId: string;
          readonly verdict: string;
          readonly subjectTaskId: string | null;
          readonly createdAt: string;
          readonly findings: readonly {
            readonly code: string;
            readonly summary: string;
            readonly blocking: boolean;
          }[];
        } & CanonicalReportOrder)[] = [];
        for (const anchor of [...new Set(anchors)].slice(0, 8)) {
          const report = await reviewFindingsSink.getLatestReviewReport({
            companyId: input.companyId,
            runId: input.runId,
            reviewTaskId: anchor,
            actorId: input.actorId,
          });
          if (!report.ok) return { ok: false as const, error: report.error };
          if (report.value === null) continue;
          const payload = report.value.payload as unknown as Record<string, unknown>;
          const projected = {
            artifactId: report.value.artifactId,
            verdict: String(payload['verdict'] ?? ''),
            subjectTaskId:
              typeof payload['subjectTaskId'] === 'string' ? payload['subjectTaskId'] : null,
            createdAt: report.value.createdAt,
            lineageRound: await taskLineageRoundOf(database, anchor),
            findings: (Array.isArray(payload['findings']) ? payload['findings'] : [])
              .map((entry) => {
                const finding =
                  typeof entry === 'object' && entry !== null
                    ? (entry as Record<string, unknown>)
                    : {};
                return {
                  code: String(finding['code'] ?? ''),
                  summary: String(finding['summary'] ?? ''),
                  blocking: finding['blocking'] === true,
                };
              })
              .filter((finding) => finding.summary !== '' || finding.code !== ''),
          };
          candidates.push(projected);
        }
        return { ok: true as const, value: latestCanonicalReportOf(candidates) };
      },
      latestValidation: {
        listByRun: (runId) =>
          database.validationStore === null
            ? Promise.resolve([])
            : database.validationStore
                .listByRun(runId as never)
                .then((rows) =>
                  rows.map((row) => ({
                    id: String(row.id),
                    status: String(row.status),
                    validatorId: String(row.validatorId),
                    targetRef: String(row.targetRef),
                  })),
                ),
      },
      requiredValidators: (runId, stageId) => stagePolicyOf(runId, stageId),
      anchorIdentity: () => {
        const workspace = repositoryRuntime.currentWorkspace();
        return Promise.resolve(
          workspace === null ? null : { workspaceId: workspace.workspaceId },
        );
      },
      /*
       * The run's delivering WORK subject must never be an instrumental gate task (the
       * T18-07 subject-anchor rule). A stage is a gate stage by EITHER signal, never by a
       * role name: the deployment's OWN registered review/qa kinds (a deployment whose review
       * kind is 'task.compliance-inspection' declares it so) AND the frozen workflow-graph
       * node-kind vocabulary ('review'/'qa' as node kinds) that legacy graphs pin.
       */
      subjectTaskOf: (runId) =>
        workSubjectTaskOf(database, runId, {
          reviewKinds: new Set(['review', ...options.stageHandlers?.reviewKinds ?? []]),
          validationKinds: new Set(['qa', ...options.stageHandlers?.qaKinds ?? []]),
        }),
      // The run's own immutable goal artifact — a citable canonical ref, never copied content.
      goalArtifactRef: async (runId) => {
        if (database.artifactStore === null) return null;
        const found = await database.artifactStore.getByCreationCommand(runGoalCommandId(runId));
        return found === null ? null : `artifact:${found.artifact.id}`;
      },
      clock,
    });
    /**
     * Sprint 20 (T20-03B + corrective): the trusted normal-task materializer — generic
     * pinned-work infrastructure. The creation profile (roleId/taskKind/maxAttempts) is
     * read from the PINNED WorkflowVersion node config (`taskProfile`) — Pack-owned
     * semantics frozen at publish; nothing comes from live composition state. This
     * composition supplies only the runtime AVAILABILITY probe: does a process-local
     * handler exist for the pinned semantic kind (the composed handler map)? Availability
     * is confirmed, never chosen — registration order has no semantic authority. Trusted
     * main-process service (like the session runtime) — NOT in the frozen IPC workflow
     * contract, not a Tool, not model-callable.
     */
    const composedHandlerKinds = (): ReadonlySet<string> => {
      const kinds = new Set<string>();
      for (const kind of options.stageHandlers?.developerKinds ?? []) kinds.add(kind);
      for (const kind of options.stageHandlers?.reviewKinds ?? []) kinds.add(kind);
      for (const kind of options.stageHandlers?.qaKinds ?? []) kinds.add(kind);
      for (const kind of options.stageHandlers?.executorKinds ?? []) kinds.add(kind);
      for (const kind of repositoryRuntime.handlers().keys()) kinds.add(kind);
      return kinds;
    };
    const normalTaskMaterializer = createNormalTaskMaterializer({
      runs: database.runs,
      templates: database.templates,
      runSnapshot: sprint13.runSnapshotVerifier,
      taskKindAvailable: (taskKind) => composedHandlerKinds().has(taskKind),
      tasks: database.tasks,
      clock,
    });

    /**
     * Sprint 20 (T20-04): the GENERIC planner runtime — one bounded pinned model turn per
     * authorized planning command, strict T20-02 validation, and the durable Plan artifact
     * (artifact-first Shape B). Industry-neutral by construction: meaning comes from the
     * canonical run-goal. Trusted main-process service — NOT in the frozen IPC workflow
     * contract, not a Tool, not model-callable. The binding name is trusted configuration
     * (defaults to `planner`); the binding VALUE always comes from the run's own snapshot.
     */
    const plannerRuntime = createPlannerRuntime({
      runs: database.runs,
      tasks: database.tasks,
      goal: {
        get: ({ runId, companyId }) =>
          runGoalWriter === null
            ? Promise.resolve({
                ok: false as const,
                error: new DomainError(
                  'PERSISTENCE_FAILED',
                  'The run-goal reader is not wired for the planner runtime.',
                  { details: { reason: 'RUN_GOAL_WRITER_UNAVAILABLE' } },
                ),
              })
            : runGoalWriter.get({ runId, companyId }),
      },
      runSnapshot: sprint13.runSnapshotVerifier,
      modelBindings: createRunModelBindingReader({
        runs: database.runs,
        snapshots: database.snapshots,
      }),
      modelRegistry: models,
      // BB2 closure: advertise the deployment's DECLARED operation-kind vocabulary (the
      // baseline kind first, then the declared kinds) — the planner MUST classify every
      // item into this closed set; the control plane validates against the same set and
      // the per-kind validator policy rides on it. Advertised ONLY when the deployment
      // actually declares extra kinds — a kind-less deployment keeps the base contract
      // (taskKind optional) so no constrained-classification burden appears.
      declaredOperationKinds: options.goalWorkProfile?.operationKinds?.length
        ? [options.goalWorkProfile.taskKind, ...options.goalWorkProfile.operationKinds]
        : undefined,
      modelCatalog: {
        contextWindowOf: async (modelKey) => {
          const page = await database.modelRecords.list({ limit: 500 });
          const record = page.items.find((row) => row.modelKey === modelKey);
          return record === undefined ? null : record.contextWindow;
        },
      },
      agentRuntime: runtime,
      plansOfRun: async (runId) => {
        if (database.artifactStore === null) return [];
        const rows = await database.artifactStore.listByRun(runId as never);
        return rows
          .filter((row) => row.kind === 'companyos:plan')
          .map((row) => ({
            id: String(row.id),
            taskId: row.taskId === null ? null : String(row.taskId),
            contentHash: row.contentHash,
          }));
      },
      artifacts: {
        getByCreationCommand: async (creationCommandId) => {
          if (database.artifactStore === null) return null;
          const found = await database.artifactStore.getByCreationCommand(creationCommandId);
          return found === null
            ? null
            : {
                artifact: {
                  id: String(found.artifact.id),
                  runId: String(found.artifact.runId),
                  kind: found.artifact.kind,
                  contentHash: found.artifact.contentHash,
                },
                creationCommandFingerprint: found.creationCommandFingerprint,
              };
        },
        create: async (command) => {
          const createdArtifact = await sprint13.artifactService.create({
            commandId: command.commandId,
            runId: command.runId as never,
            ...(command.taskId === undefined || command.taskId === null ? {} : { taskId: command.taskId as never }),
            kind: command.kind,
            content: command.content,
            producedBy: command.producedBy,
            ...(command.authorizedBy === undefined ? {} : { authorizedBy: command.authorizedBy }),
            traceId: command.traceId,
          });
          return createdArtifact.ok
            ? { ok: true as const, value: { artifactId: String(createdArtifact.value.id) } }
            : { ok: false as const, error: createdArtifact.error };
        },
      },
      goalArtifactId: async (runId) => {
        if (database.artifactStore === null) return null;
        const found = await database.artifactStore.getByCreationCommand(runGoalCommandId(runId));
        return found === null ? null : String(found.artifact.id);
      },
      faultCheckpoints: options.faultCheckpoints,
      bindingKey: options.plannerBindingKey ?? 'planner',
      clock,
      ids,
    });

    /**
     * Sprint 20 (T20-05): the DETERMINISTIC plan compiler — pure Plan→graph compilation
     * (zero model calls) plus the real publish lifecycle, ONE execution run pinned to the
     * compiled version (own canonical goal), and baseline tasks through the frozen generic
     * materializer. The compilation profile is TRUSTED COMPOSITION CONFIGURATION (a
     * Pack/workflow concern — Core stays industry-neutral); it is an explicit immutable
     * input to every compilation command, and a same-command different-semantics retry
     * CONFLICTS. Trusted main-process service; not IPC/Tool/MCP exposed.
     */
    const planCompiler = createPlanCompiler({
      ...(executionSafety === null ? {} : { bindExecutionGoal: executionSafety.budget.bind }),
      artifacts: {
        get: async (artifactId) => {
          if (database.artifactStore === null) return null;
          const row = await database.artifactStore.get(artifactId as never);
          return row === null
            ? null
            : {
                id: String(row.id),
                runId: String(row.runId),
                kind: row.kind,
                contentHash: row.contentHash,
                contentRef: row.contentRef,
              };
        },
        commandIdOf: async (artifactId) => {
          if (database.artifactStore === null) return null;
          // The plan artifact's permanent command id (`plan:<planId>`) is a durable column
          // of the artifact row (Option-B idempotency) — a direct read-only lookup.
          const row = database.db
            .prepare('SELECT creation_command_id FROM artifacts WHERE artifact_id = ?')
            .get(artifactId) as { creation_command_id: string | null } | undefined;
          return row === undefined || row.creation_command_id === null ? null : row.creation_command_id;
        },
        // The permanent compilation anchor (`plan-compile:<companyId>:<commandId>`): the
        // same Option-B durable create the planner uses, so anchor replay/conflict reads
        // the DB, never the bounded T18-02 ledger.
        create: async (command) => {
          const createdArtifact = await sprint13.artifactService.create({
            commandId: command.commandId,
            runId: command.runId as never,
            ...(command.taskId === undefined || command.taskId === null
              ? {}
              : { taskId: command.taskId as never }),
            kind: command.kind,
            content: command.content,
            producedBy: command.producedBy,
            ...(command.authorizedBy === undefined ? {} : { authorizedBy: command.authorizedBy }),
            traceId: command.traceId,
          });
          return createdArtifact.ok
            ? { ok: true as const, value: { artifactId: String(createdArtifact.value.id) } }
            : { ok: false as const, error: createdArtifact.error };
        },
        findByCommand: async (commandId) => {
          if (database.artifactStore === null) return null;
          const found = await database.artifactStore.getByCreationCommand(commandId);
          return found === null
            ? null
            : { artifactId: String(found.artifact.id), fingerprint: String(found.artifact.contentHash) };
        },
      },
      content: {
        get: async (contentRef) => {
          const bytes = await artifactFoundation.contentStore.get(contentRef);
          return bytes as unknown as Uint8Array | null;
        },
      },
      templates: database.templates,
      runs: {
        // The permanent execution-run identity lookup: the deterministic Run.id IS the
        // row PRIMARY KEY — exact, durable, and independent of the bounded ledger.
        get: async (runId) => {
          const row = (await database.runs.get(runId as never)) as
            | { id: string; companyId: string; workflowId: string; templateId: string; versionId: string }
            | null;
          return row === null
            ? null
            : {
                id: String(row.id),
                companyId: String(row.companyId),
                workflowId: String(row.workflowId),
                templateId: String(row.templateId),
                versionId: String(row.versionId),
              };
        },
      },
      goal: {
        get: ({ runId, companyId }) =>
          runGoalWriter === null
            ? Promise.resolve({
                ok: false as const,
                error: new DomainError(
                  'PERSISTENCE_FAILED',
                  'The run-goal reader is not wired for the plan compiler.',
                  { details: { reason: 'RUN_GOAL_WRITER_UNAVAILABLE' } },
                ),
              })
            : runGoalWriter.get({ runId, companyId }),
      },
      lifecycle,
      materialize: (materializeInput) =>
        normalTaskMaterializer!.materialize(materializeInput).then((result) =>
          result.ok
            ? { ok: true as const, value: { taskId: result.value.taskId, replayed: result.value.replayed } }
            : { ok: false as const, error: result.error },
        ),
      faultCheckpoints: options.faultCheckpoints,
    });

    /**
     * Sprint 20 (T20-06): the Work Package projector — the derived execution projection.
     * Every semantic comes from canonical durable truth (run-owned goal, pinned
     * WorkflowVersion node config, Task row, pinned-DAG predecessor results, accepted
     * Sprint-11 handoff packets). Zero persistence of its own; read-only seams only.
     */
    const workPackageProjector =
      database.snapshots !== null
        ? createWorkPackageProjector({
            runs: {
              get: async (runId) => {
                const row = (await database.runs.get(runId as never)) as
                  | { id: string; companyId: string; templateId: string; versionId: string; snapshotId: string }
                  | null;
                return row === null
                  ? null
                  : {
                      id: String(row.id),
                      companyId: String(row.companyId),
                      templateId: String(row.templateId),
                      versionId: String(row.versionId),
                      snapshotId: String(row.snapshotId),
                    };
              },
            },
            tasks: {
              get: (taskId) => database.tasks.get(taskId as never),
              listByRun: (runId) => database.tasks.listByRun(runId),
            },
            snapshots: {
              get: async (snapshotId) => {
                const row = (await database.snapshots.get(snapshotId as never)) as
                  | { runId: string; templateId: string; workflowVersionId: string }
                  | null;
                return row === null
                  ? null
                  : {
                      runId: String(row.runId),
                      templateId: String(row.templateId),
                      workflowVersionId: String(row.workflowVersionId),
                    };
              },
            },
            templates: { get: (templateId) => database.templates.get(templateId as never) },
            goal: {
              get: async ({ runId, companyId }) => {
                if (runGoalWriter === null) {
                  return {
                    ok: false as const,
                    error: new DomainError(
                      'PERSISTENCE_FAILED',
                      'The run-goal reader is not wired for the Work Package projector.',
                      { details: { reason: 'RUN_GOAL_WRITER_UNAVAILABLE' } },
                    ),
                  };
                }
                const goal = await runGoalWriter.get({ runId, companyId });
                return goal.ok
                  ? {
                      ok: true as const,
                      value: {
                        objective: goal.value.objective,
                        structured: goal.value.structured ?? null,
                        sourceType: String(goal.value.source?.type ?? ''),
                        sourceRef:
                          goal.value.source !== null && goal.value.source !== undefined && 'ref' in goal.value.source
                            ? String((goal.value.source as { ref?: unknown }).ref ?? '')
                            : null,
                      },
                    }
                  : { ok: false as const, error: goal.error };
              },
            },
            ...(database.handoffStore === null
              ? {}
              : {
                  // READ-ONLY seam into the ONE Sprint-11 store: latest-version packets of
                  // the exact scope; ACCEPTED-only filtering stays with the domain.
                  handoffs: {
                    listForScope: (scope: {
                      readonly companyId: string;
                      readonly workflowRunId: string;
                      readonly taskId: string;
                    }) => database.handoffStore!.listForScope(scope),
                  },
                }),
          })
        : null;
    workPackageProjectorHolder = workPackageProjector;
    fileDeliveryContextOf = async (runId, taskId) => {
      if (workPackageProjectorHolder === null) throw new DomainError('PERSISTENCE_FAILED', 'The canonical Work Package is unavailable.');
      const pkg = await workPackageProjectorHolder.project({ companyId: 'company_default', runId, taskId });
      if (!pkg.ok) throw pkg.error;
      const all = fileDeliveriesOf(pkg.value.goal.structured);
      const criteria = new Set(pkg.value.acceptance.criteria.map((item) => item.criterionId));
      const requirements = all.filter((item) => criteria.has(item.criterionId));
      const goalRunId = await database.executionBudget.goalOf(runId);
      const workspace = await resolveRunWorkspaceContext(runId);
      if (requirements.length > 0 && (goalRunId === null || workspace === null || workspace.mismatch || workspace.accessPolicy === 'READ_ONLY')) throw new DomainError('POLICY_DENIED', 'A file delivery requires the canonical Goal and writable bound Workspace.');
      return { goalRunId: goalRunId ?? runId, runId, taskId, workspace: workspace?.root ?? '', requirements, validatorIds: pkg.value.acceptance.validatorRefs };
    };
    verifiedFileCarrier = createVerifiedFileCarrier({ artifacts: sprint13.artifactService, validation: sprint13.validationService, actorId: SESSION_ACTOR, checkActive: async (runId) => { await executionSafety?.budget.check(runId); } });
    const deliveryRecord = fileDeliveryToolRecord(clock.nowIso());
    if (!deliveryRecord.ok) throw deliveryRecord.error;
    const deliveryRegistered = await tools.register(deliveryRecord.value, { actorId: SESSION_ACTOR });
    if (!deliveryRegistered.ok && deliveryRegistered.error.code !== 'CONFLICT') throw deliveryRegistered.error;
    toolAdapters.set(FILE_DELIVERY_TOOL_ID, createFileDeliveryPort({ contextOf: fileDeliveryContextOf, artifactOf: (id) => database.artifactStore!.get(id as never), contentOf: (ref) => artifactFoundation.contentStore.get(ref), nowIso: () => clock.nowIso() }));

    /**
     * STAGE 8B — the canonical RoleCatalog (Stage 7 pack-extensible registry),
     * seeded from the CANONICAL `roles` table. A deployment that adds Pack roles
     * registers them on the same catalog; an unknown seat falls back to Stage 7's
     * deterministic dynamic synthesis — never a hidden default employee.
     */
    roleCatalogHolder =
      options.modelRouting?.roleCatalog ??
      seedRoleCatalogFromCanonical(
        (
          await database.roles.list({ limit: 200 })
        ).items.map((row) => ({
          id: String(row.id),
          key: String(row.key),
          name: String(row.name),
          description: String(row.description),
          requiredCapabilities: parseCapabilityList(row.requiredCapabilities),
        })),
      );

    /**
     * STAGE 8B — the ONE existing Sprint-11 HandoffService over the frozen
     * handoff tables: the runtime collaboration write path reuses this service
     * (createDraft → ready, durable-reference resolution enforced) instead of
     * creating a second handoff truth. Null when the handoff chain is not
     * opened, in which case no durable handoff can be recorded at all.
     */
    handoffServiceHolder =
      database.handoffStore === null
        ? null
        : createHandoffService({
            store: database.handoffStore,
            clock,
            authorize: ({ actorId, authority }) => authz.decide({ actorId, authority }),
            actorRoleIds: async (actorId) => (await authz.assignmentsOf(actorId)).map((assignment) => assignment.roleId),
            durableReferenceResolver,
            audit: {
              created: async (payload) => {
                await database.events.append([
                  createCoreDomainEvent(
                    'handoff.created',
                    { type: 'Handoff', id: payload.handoffId },
                    { ...payload },
                    { traceId: payload.traceId, actorId: payload.actorId, now: clock.nowIso(), ids },
                  ),
                ]);
              },
              ready: async (payload) => {
                await database.events.append([
                  createCoreDomainEvent(
                    'handoff.ready',
                    { type: 'Handoff', id: payload.handoffId },
                    { ...payload },
                    { traceId: payload.traceId, actorId: payload.actorId, now: clock.nowIso(), ids },
                  ),
                ]);
              },
              accepted: async (payload) => {
                await database.events.append([
                  createCoreDomainEvent(
                    'handoff.accepted',
                    { type: 'Handoff', id: payload.handoffId },
                    { ...payload },
                    { traceId: payload.traceId, actorId: payload.actorId, now: clock.nowIso(), ids },
                  ),
                ]);
              },
              rejected: async (payload) => {
                await database.events.append([
                  createCoreDomainEvent(
                    'handoff.rejected',
                    { type: 'Handoff', id: payload.handoffId },
                    { ...payload },
                    { traceId: payload.traceId, actorId: payload.actorId, now: clock.nowIso(), ids },
                  ),
                ]);
              },
              superseded: async (payload) => {
                await database.events.append([
                  createCoreDomainEvent(
                    'handoff.superseded',
                    { type: 'Handoff', id: payload.handoffId },
                    { ...payload },
                    { traceId: payload.traceId, actorId: payload.actorId, now: clock.nowIso(), ids },
                  ),
                ]);
              },
              cancelled: async (payload) => {
                await database.events.append([
                  createCoreDomainEvent(
                    'handoff.cancelled',
                    { type: 'Handoff', id: payload.handoffId },
                    { ...payload },
                    { traceId: payload.traceId, actorId: payload.actorId, now: clock.nowIso(), ids },
                  ),
                ]);
              },
            },
          });

    /**
     * Sprint 18 (T18-05): the controlled corrective provisioner — a trusted application
     * service that turns an actionable REQUEST_CORRECTIVE Decision into ONE durable corrective
     * Task with parent/root/round/cause lineage. It creates the work item only; it never
     * executes it, never captures a baseline and never creates a Validation, Review Report,
     * Decision or AgentExecution.
     */
    const correctiveProvisioner =
      database.artifactStore !== null &&
      database.agentExecutions !== null &&
      database.toolInvocations !== undefined &&
      reviewFindingsSink !== null
        ? createCorrectiveProvisioner({
            runs: database.runs,
            tasks: database.tasks,
            templates: database.templates,
            decisions: database.decisions!,
            artifacts: database.artifactStore,
            content: {
              get: (contentRef: string) => artifactFoundation.contentStore.get(contentRef),
            },
            toolInvocations: database.toolInvocations,
            // STAGE 4 FINAL: the canonical ValidationService batch rows — the generic
            // validator path resolves the corrective cause from the cited failing row.
            validations: {
              get: async (validationId: string) => {
                const row = await database.validationStore?.get(validationId as never);
                return row ?? null;
              },
            },
            runSnapshot: sprint13.runSnapshotVerifier,
            // The T18-04 reader is the port the provisioner needs: only the current
            // actionable report of a review task (never a stale CHANGES_REQUESTED).
            reviewReports: {
              latestReviewReport: ({ companyId, runId, reviewTaskId, actorId }) =>
                reviewFindingsSink
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
          })
        : null;

    /**
     * Sprint 18 (T18-06): the ONE supervisor decision runtime — a trusted application service
     * that runs ONE bounded decision turn. It reuses the SAME seams as everything else (goal,
     * snapshot verifier, binding reader, durable resolver, the T18-03 decision sink, the T18-04
     * review reader, the agent runtime and the append-only validation store), so no second
     * policy graph exists here. It is deliberately NOT an IPC channel and NOT a Tool: a future
     * autonomous loop calls it in-process, one turn at a time (T18-07).
     */
    const supervisorDecisionRuntime =
      supervisorDecisionSink !== null &&
      reviewFindingsSink !== null &&
      database.validationStore !== null &&
      database.agentExecutions !== null
        ? createSupervisorDecisionRuntime({
      faultCheckpoints: options.faultCheckpoints,
            runs: database.runs,
            tasks: {
              get: (taskId) => database.tasks.get(taskId as never),
              put: (task) => database.tasks.put(task),
              delete: (taskId) => database.tasks.delete(taskId),
              list: (page) => database.tasks.list(page),
              listByRun: (runId) => database.tasks.listByRun(runId),
            },
            runGoal: runGoalWriter!,
            runSnapshotVerifier: sprint13.runSnapshotVerifier,
            modelBindings: createRunModelBindingReader({
              runs: database.runs,
              snapshots: database.snapshots,
            }),
            modelRegistry: models,
            /*
             * The T18-04 reader, projected to what one turn needs: verdict, subject, findings —
             * and resolved across the run's WHOLE review surface (the newest canonical report of
             * any of the run's review-kind tasks, exactly the rule the evidence applicator
             * uses). A corrective round's second review is a NEW task; anchoring one turn on a
             * stale round's report would misread the run's current verdict.
             */
            reviewReports: {
              getLatestReviewReport: async ({ companyId, runId, reviewTaskId, actorId }) => {
                const readOne = async (task: string) =>
                  reviewFindingsSink.getLatestReviewReport({
                    companyId,
                    runId,
                    reviewTaskId: task,
                    actorId,
                  });
                const anchors = await reviewTaskAnchorsOf(database, runId);
                const candidates = [reviewTaskId, ...anchors];
                const ordered: ({
                  readonly artifactId: string;
                  readonly createdAt: string;
                  readonly verdict: string;
                  readonly subjectTaskId: string;
                  readonly findings: readonly Readonly<Record<string, unknown>>[];
                } & CanonicalReportOrder)[] = [];
                for (const anchor of [...new Set(candidates)].slice(0, 8)) {
                  const report = await readOne(anchor);
                  if (!report.ok) return { ok: false as const, error: report.error };
                  if (report.value === null) continue;
                  ordered.push({
                    artifactId: report.value.artifactId,
                    createdAt: report.value.createdAt,
                    lineageRound: await taskLineageRoundOf(database, anchor),
                    verdict: report.value.payload.verdict,
                    subjectTaskId: report.value.payload.subjectTaskId,
                    findings: report.value.payload
                      .findings as unknown as readonly Readonly<Record<string, unknown>>[],
                  });
                }
                return { ok: true as const, value: latestCanonicalReportOf(ordered) };
              },
            },
            validations: {
              listByRun: (runId: string) => database.validationStore!.listByRun(runId as never),
            },
            // The T18-03 history reader is the ONE decision reader (never a second store).
            decisionHistory: supervisorDecisionSink,
            decisionSink: supervisorDecisionSink,
            agentRuntime: runtime,
            // The engine may not use timers itself (boundary gate), so the shell supplies one.
            timer: (ms: number, onTimeout: () => void) => {
              const handle = setTimeout(onTimeout, ms);
              return () => clearTimeout(handle);
            },
            clock,
            ids,
            // Trusted configuration only: which pinned binding the Supervisor runs under.
            supervisorBindingKey: options.supervisorBindingKey ?? SUPERVISOR_BINDING_KEY,
            // Generic runtime identity: a supervisor is a supervisor, not a role of a pack.
            supervisorAgentId: 'supervisor-runtime',
            supervisorRoleId: 'supervisor-runtime',
          })
        : null;

    /**
     * Sprint 18 (T18-07): the bounded autonomous supervisor runtime. It reuses the SAME
     * services as everything else — the T18-06 turn runtime, the T18-05 provisioner (which
     * carries the round ceiling), the engine, the T18-03 sink, the artifact primitives — so no
     * second policy graph exists here. The bounds are trusted application configuration.
     */
    const autonomousSupervisor =
      supervisorDecisionRuntime !== null &&
      correctiveProvisioner !== null &&
      database.validationStore !== null &&
      database.agentExecutions !== null &&
      sprint13.engine !== null
        ? createAutonomousSupervisorRuntime({
      faultCheckpoints: options.faultCheckpoints,

            tasks: database.tasks,
            taskById: (taskId: string) => database.tasks.get(taskId as never),
            templates: database.templates,
            snapshots: database.snapshots,
            runs: database.runs,
            executions: database.agentExecutions,
            // F1 closure: the supervisor's own agent identity — the illegal-proposal budget is
            // derived from THIS identity's durable FAILED (INVALID_OUTPUT) executions.
            supervisorAgentId: 'supervisor-runtime',
            decisionReader: supervisorDecisionSink!,
            // Task-18-07 corrective: the REVIEWING/VALIDATING agent unit and the canonical task
            // completion. The task is completed only AFTER its canonical sink is durable.
            runAgentUnit: agentUnitRunner,
            // Sprint21: the ONE ValidationService for orchestrator-driven validation of
            // pinned validator requirements (validator-Id-driven, class-free).
            validationRunner: {
              run: (command) =>
                sprint13.validationService.run({
                  commandId: command.commandId,
                  runId: command.runId as never,
                  ...(command.stageId === undefined ? {} : { stageId: command.stageId as never }),
                  ...(command.taskId === undefined ? {} : { taskId: command.taskId as never }),
                  targetRef: command.targetRef as never,
                  validators: command.validators.map((entry) => ({
                    validatorId: entry.validatorId,
                    blocking: entry.blocking,
                  })),
                  actorId: command.actorId,
                  traceId: command.traceId,
                }),
            },
            /*
             * The carrier is declared below; a lazy reference keeps the declaration order (and
             * the single carrier instance) while the orchestrator still routes every agent
             * output through it. It is dereferenced only when a run actually executes an agent
             * unit, long after this composition finished.
             */
            outputCarrier: {
              routeOutput: (input) => {
                const carrier = stageOutputCarrier;
                if (carrier === null) {
                  return Promise.resolve({
                    ok: false as const,
                    error: new DomainError(
                      'PERSISTENCE_FAILED',
                      'The stage output carrier is not wired; the canonical sink cannot be reached.',
                      {
                        details: {
                          reason: 'STAGE_OUTPUT_CARRIER_UNAVAILABLE',
                          taskId: input.taskId,
                        },
                      },
                    ),
                  });
                }
                return carrier.routeOutput(input);
              },
              routeTask: (input) => {
                const carrier = stageOutputCarrier;
                if (carrier === null) {
                  return Promise.resolve({
                    ok: false as const,
                    error: new DomainError(
                      'PERSISTENCE_FAILED',
                      'The stage output carrier is not wired; the canonical sink cannot be reached.',
                      {
                        details: {
                          reason: 'STAGE_OUTPUT_CARRIER_UNAVAILABLE',
                          taskId: input.taskId,
                        },
                      },
                    ),
                  });
                }
                return carrier.routeTask(input);
              },
            },
            completeTaskWithOutput: async (input: {
              readonly taskId: string;
              readonly output: StageHandlerOutput;
            }): Promise<Result<Task, DomainError>> => {
              const loaded = await database.tasks.get(input.taskId as never);
              if (loaded === null) {
                return {
                  ok: false as const,
                  error: new DomainError('NOT_FOUND', `Task "${input.taskId}" not found.`, {
                    details: { taskId: input.taskId },
                  }),
                };
              }
              /*
               * The task's own L3 machine decides every transition, and the orchestrator never
               * writes a state the machine would refuse. A review/QA task arrives PENDING (or
               * re-enters after a crash, a block or a rework round), so it is first normalised
               * into a runnable state the same way the engine's stage execution does — then it
               * is started and completed, carrying the bounded output it actually produced.
               */
              const step = (
                current: Task,
                event: TaskEvent,
                outputs: Readonly<Record<string, unknown>> = {},
              ): Result<Task, DomainError> =>
                applyTaskEvent(current, event, clock.nowIso(), outputs);
              let task = loaded;
              if (task.state === 'PENDING') {
                const planned = step(task, 'PLAN');
                if (!planned.ok) return planned;
                task = planned.value;
              } else if (task.state === 'FAILED' || task.state === 'RUNNING') {
                // RUNNING here means a previous attempt died mid-flight; RETRY is the only way
                // back to READY, so the machine's own recovery path is used.
                const reopened = task.state === 'RUNNING' ? step(task, 'FAIL') : ok(task);
                if (!reopened.ok) return reopened;
                const normalised = step(reopened.value, 'RETRY');
                if (!normalised.ok) return normalised;
                task = normalised.value;
              } else if (task.state === 'BLOCKED') {
                const unblocked = step(task, 'UNBLOCK');
                if (!unblocked.ok) return unblocked;
                task = unblocked.value;
              }
              if (task.state === 'DONE' || task.state === 'SKIPPED' || task.state === 'CANCELLED') {
                // Already satisfied by an earlier attempt: a replayed application is a no-op.
                return ok(task);
              }
              const started = step(task, 'START');
              if (!started.ok) return started;
              const completed = step(started.value, 'COMPLETE', {
                [STAGE_OUTPUT_TASK_KEY]: input.output,
              });
              if (!completed.ok) return completed;
              await database.tasks.put(completed.value);
              // The durable trail of the same transition, so the audit read shows who moved the
              // task (the trusted composition), not an anonymous row change.
              const now = clock.nowIso();
              await database.events.append([
                createCoreDomainEvent(
                  'task.state_changed',
                  { type: 'Task', id: completed.value.id },
                  { from: loaded.state, to: completed.value.state, scope: 'autonomous-agent-unit' },
                  { traceId: ids.id('trace'), actorId: SESSION_ACTOR, now, ids },
                ),
              ]);
              return completed;
            },
            /*
             * The evidence applicator is declared below (it needs the sinks this composition
             * just built); a lazy reference keeps the single instance and the declaration order.
             * It is dereferenced only while a run is actually supervised, long after this
             * composition finished — never during composition.
             */
            evidenceApplicator:
              reviewFindingsSink === null || database.validationStore === null
                ? undefined
                : {
                    applyEvidence: (input) => {
                      const applicator = evidenceApplicator;
                      if (applicator === null) {
                        return Promise.resolve({
                          ok: false as const,
                          error: new DomainError(
                            'PERSISTENCE_FAILED',
                            'The evidence lifecycle applicator is not wired; a run cannot advance on its canonical evidence.',
                            { details: { runId: input.runId, reason: 'EVIDENCE_APPLICATOR_UNAVAILABLE' } },
                          ),
                        });
                      }
                      return applicator.applyEvidence(input);
                    },
                  },
            supervisorRuntime: supervisorDecisionRuntime,
            // 9dc9943 — live reconciliation settles expired/committed supervisor rows
            // through the ONE canonical AgentRuntime arbiter (zero provider calls).
            agentRuntime: runtime,
            provisioner: correctiveProvisioner,
            engine: sprint13.engine,
            // F5 single-flight arbitration + the durable illegal-proposal budget both read
            // the run's Decision history through the ONE T18-03 reader (same sink).
            decisionHistory: supervisorDecisionSink!,
            artifactService: sprint13.artifactService,
            artifactStore: database.artifactStore!,
            // The engine may not use timers itself (boundary gate), so the shell supplies one.
            timer: (ms: number, onTimeout: () => void) => {
              const handle = setTimeout(onTimeout, ms);
              return () => clearTimeout(handle);
            },
            clock,
            ids,
            config: {
              maxSupervisorTurns: options.supervisorBounds?.maxSupervisorTurns ?? 20,
              maxCorrectiveRounds: options.supervisorBounds?.maxCorrectiveRounds ?? 3,
              ...(options.supervisorBounds?.timeoutMs === undefined
                ? {}
                : { timeoutMs: options.supervisorBounds.timeoutMs }),
            },
            supervisorBindingKey: options.supervisorBindingKey ?? SUPERVISOR_BINDING_KEY,
          })
        : null;

    /**
     * Task-18-07 corrective: the trusted carrier from `Task.outputs` to the canonical sinks.
     * There is exactly ONE writer per domain (the T18-04 review sink, the T17 Validation
     * Service), and the carrier verifies the execution identity against the durable row before
     * it writes anything.
     */
    const stageOutputCarrier =
      reviewFindingsSink !== null &&
      database.validationStore !== null &&
      sprint13.artifactService !== null
        ? createStageOutputCarrier({
            tasks: database.tasks,
            executions: database.agentExecutions,
            reviewSink: {
              record: (command) =>
                reviewFindingsSink
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
            validationService: sprint13.validationService,
            clock,
            ids,
          })
        : null;

    /**
     * Task-18-07 corrective: the deterministic evidence → Run lifecycle applicator. It reads
     * the SAME canonical evidence readers the Supervisor uses and dispatches the ONE legal Run
     * event that evidence implies — never a model judgement.
     */
    const evidenceApplicator =
      reviewFindingsSink !== null && database.validationStore !== null
        ? createEvidenceLifecycleApplicator({
      faultCheckpoints: options.faultCheckpoints,
            runs: database.runs,
            engine: sprint13.engine,
            readers: {
              getLatestReviewReport: ({ companyId, runId, reviewTaskId, actorId }) =>
                reviewFindingsSink
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
                  ),
              // STAGE 9B-FIX: the corrective generation of each review anchor, so the
              // applicator's cross-anchor "latest report" picks by generation first.
              lineageRoundOf: (taskId: string) => taskLineageRoundOf(database, taskId),
              listValidations: (runId: string) =>
                database.validationStore!.listByRun(runId as never).then((rows) =>
                  rows.map((row) => ({
                    id: row.id,
                    validatorId: row.validatorId,
                    status: row.status,
                    stageId: row.stageId as string | null,
                    targetRef: (row.targetRef ?? null) as string | null,
                  })),
                ),
              requiredValidators: ({ runId, stageId }) => stagePolicyOf(runId, stageId),
              /*
               * F1 closure (release-blocker re-audit): the corrective children's cited causes,
               * read from the SAME durable task inputs the Supervisor context uses — a failing
               * validation a corrective already cites is CONSUMED and must not be re-applied.
               */
              correctiveCauseIds: (runId: string) =>
                database.tasks.listByRun(runId as never).then((tasks) => correctiveCauseIdsOf(tasks)),
              // The run's own Decision history, so a review verdict that corrective work already
              // consumed is recognized as consumed instead of being re-applied (Task-18-07
              // corrective: the frozen machine re-enters REVIEWING after a corrective round).
              ...(supervisorDecisionSink === null
                ? {}
                : {
                    listRunDecisions: ({
                      companyId,
                      runId,
                      actorId,
                    }: {
                      readonly companyId: string;
                      readonly runId: string;
                      readonly actorId: string;
                    }) =>
                      supervisorDecisionSink
                        .listRunDecisionHistory({ companyId, runId, actorId })
                        .then((result) => {
                          if (!result.ok) return { ok: false as const, error: result.error };
                          const projected = result.value
                            .map((record) => supervisorDecisionEvidenceOf(record))
                            .filter(
                              (
                                entry,
                              ): entry is {
                                readonly action: string;
                                readonly evidenceRefs: readonly string[];
                              } => entry !== null,
                            );
                          return { ok: true as const, value: projected };
                        }),
                  }),
            },
            clock,
            ids,
          })
        : null;

    const sessionKernel =
      database.sessionStore !== null
        ? createSessionKernel({
            store: database.sessionStore,
            ownership: {
              runs: database.runs,
              tasks: database.tasks,
              // The task→run proof is the SAME rule the decision sink uses: a task row
              // carries no runId, so membership in the run's PINNED version graph is the
              // strongest proof available (never a caller's claim).
              taskBelongsToRun: async ({ runId, taskId }) => {
                const run = await database.runs.get(runId as never);
                if (run === null) return false;
                const task = await database.tasks.get(taskId as never);
                if (task === null) return false;
                const template = await database.templates.get(String(run.templateId) as never);
                const version = template?.versions.find((entry) => entry.id === run.versionId);
                if (version === undefined) return false;
                return (version.graph.nodes as readonly { id: string }[]).some(
                  (node) => node.id === String(task.stageId),
                );
              },
              // Corrective ruling C: the durable execution reader for reference validation.
              executions:
                database.agentExecutions === null
                  ? undefined
                  : {
                      get: (executionId: string) =>
                        database.agentExecutions!.get(executionId as never),
                    },
            },
            clock,
          })
        : null;
    /** Sprint 19 (T19-03): the pinned-binding reader the Developer session runtime uses. */
    const developerBindingReader = createRunModelBindingReader({
      runs: database.runs,
      snapshots: database.snapshots,
    });
    /**
     * Sprint 19 (T19-03): the session-backed DEVELOPER runtime — the one role integrated
     * with the durable Session kernel. The trusted registration below IS the role-binding
     * seam (§3): the SAME object supplies the Session roleKey and the AgentExecution roleId,
     * so the §21 invariant holds by construction — the model and the caller can select
     * neither. Reviewer/QA/Supervisor are deliberately NOT wired here.
     */
    const developerSession =
      sessionKernel !== null && pinnedAgentExecution !== null
        ? createWorkSessionRuntime(
            {
              kinds: options.stageHandlers?.developerKinds ?? [],
              roleKey: 'rol.developer',
              agentId: 'agent.developer',
              bindingKey: options.supervisorBindingKey ?? SUPERVISOR_BINDING_KEY,
            },
            {
              kernel: sessionKernel,
              runs: database.runs,
              tasks: database.tasks,
              goal: {
                get: ({ runId, companyId }) =>
                  runGoalWriter === null
                    ? Promise.resolve({
                        ok: false as const,
                        error: new DomainError(
                          'PERSISTENCE_FAILED',
                          'The run-goal reader is not wired for the developer session runtime.',
                          { details: { reason: 'RUN_GOAL_WRITER_UNAVAILABLE' } },
                        ),
                      })
                    : runGoalWriter.get({ runId, companyId }),
              },
              latestReview: async (input: {
                readonly companyId: string;
                readonly runId: string;
                readonly actorId: string;
              }) => {
                if (reviewFindingsSink === null)
                  return Promise.resolve({ ok: true as const, value: null });
                // The newest canonical report ACROSS the run's review tasks — the same
                // run-wide rule the evidence applicator uses.
                const anchors = await reviewTaskAnchorsOf(database, input.runId);
                let best: { readonly verdict: string; readonly createdAt: string } | null = null;
                for (const anchor of anchors.slice(0, 8)) {
                  const report = await reviewFindingsSink.getLatestReviewReport({
                    companyId: input.companyId,
                    runId: input.runId,
                    reviewTaskId: anchor,
                    actorId: input.actorId,
                  });
                  if (!report.ok)
                    return Promise.resolve({ ok: false as const, error: report.error });
                  if (report.value === null) continue;
                  const projected = {
                    verdict: report.value.payload.verdict,
                    createdAt: report.value.createdAt,
                  };
                  if (
                    best === null ||
                    projected.createdAt.localeCompare(best.createdAt) > 0 ||
                    (projected.createdAt === best.createdAt &&
                      String(report.value.artifactId).localeCompare('') > 0)
                  ) {
                    best = projected;
                  }
                }
                return Promise.resolve({ ok: true as const, value: best });
              },
              binding: {
                // The SAME reader seam the supervisor turn uses: the run's OWN pinned
                // snapshot, resolved through trusted configuration only.
                resolve: async (input: {
                  readonly runId: string;
                  readonly companyId: string;
                }) => {
                  const resolved = await developerBindingReader.resolve(
                    {
                      runId: input.runId,
                      companyId: input.companyId,
                      bindingName: options.supervisorBindingKey ?? SUPERVISOR_BINDING_KEY,
                    },
                    models,
                  );
                  if (!resolved.ok) {
                    return { ok: false as const, error: resolved.error };
                  }
                  // §27: the context window comes from the trusted durable catalog or nowhere.
                  const page = await database.modelRecords.list({ limit: 500 });
                  const record = page.items.find((row) => row.modelKey === resolved.value.modelKey);
                  return {
                    ok: true as const,
                    value: {
                      modelKey: resolved.value.modelKey,
                      contextWindow: record === undefined ? null : record.contextWindow,
                    },
                  };
                },
              },
              anchorIdentity: ({ runId }) => {
                void runId;
                const workspace = repositoryRuntime.currentWorkspace();
                return Promise.resolve(
                  workspace === null ? null : { workspaceId: workspace.workspaceId },
                );
              },
              // The pinned round returns its own AgentRunOutcome; the Developer runtime
              // consumes the provider payload (structured + text), mapped here once. The
              // round is RESIDUE FIRST (T19-03 closeout Shape B): the runtime's trusted
              // callback makes the session residue durable BETWEEN the provider result and
              // the terminal settlement — passed through verbatim below.
              runRoundResidueFirst: (round, persistResidue) =>
                pinnedAgentExecution
                  .runRoundResidueFirst(
                    {
                      ...round,
                      context: round.context as never,
                      prompt: { structuredKeys: round.structuredKeys },
                    },
                    persistResidue,
                  )
                  .then((result) =>
                  result.ok
                    ? {
                        ok: true as const,
                        value: {
                          executionId: result.value.executionId,
                          structured: result.value.outcome.structured,
                          outputText: result.value.outcome.outputText,
                        },
                      }
                    : { ok: false as const, error: result.error },
                ),
              // Closeout §9: the durable execution status reader that gates residue
              // eligibility. Read failures resolve to null (excluded) — fail closed.
              executionStatus: ({ executionId, actorId }) =>
                runtime.get(executionId, actorId).then((found) =>
                  found.ok && found.value !== null ? found.value.status : null,
                ),
              faultCheckpoints: options.faultCheckpoints,
              clock,
            },
          )
        : null;
    developerSessionRuntimeHolder = developerSession;
    /*
     * Sprint24 — the PROVIDER seam. The registry is implementation authority only
     * (§44): it answers which providers exist and their capabilities — never Task
     * readiness, stage meaning or Run completion. The dsh adapter is wired here (the
     * engine boundary is vendor-name-free); a provider-backed kind dispatches through
     * the trusted orchestration AFTER the canonical attempt claim, outside any write
     * transaction, and the ENGINE settles canonically.
     */
    const executorProviderList: ExecutorProvider[] = [];
    /*
     * Sprint25 — the provider configuration is TYPED, VALIDATED and SOURCE-ANNOTATED
     * before any provider exists (composition → named environment variable → declared
     * default). A missing required field is a typed load failure instead of a silent
     * `?? ''` that surfaces later as an ENOENT from spawn.
     */
    const {
      createDshProvider,
      createDshProviderFromConfig,
      resolveDshProviderConfig,
      DSH_PROVIDER_KEY,
    } = await import('./executor/dsh-executor-provider.js');
    /*
     * STAGE 4 — the DEFAULT dsh provider is the CompanyOS-MANAGED EMBEDDED runtime
     * (official pinned kernel, materialized under the gitignored managed root; the
     * packaged build points the composition at its resources directory with the SAME
     * manifest contract). The user's PATH dsh, ~/.dsh, or a desktop installation is
     * NEVER consulted implicitly: the historical env-based EXTERNAL configuration
     * loads only under the explicit operator opt-in sentinel. A missing embedded
     * runtime is fail-loud availability absence — never a silent fallback.
     *
     * DRA-04 — the managed root is TRUSTED DEPLOYMENT DATA supplied by the
     * composition root (an absolute, launch-independent resource location). It is
     * never inferred from the launch working directory: the CWD must not change
     * which runtime is found. Absent the option, the embedded runtime is
     * explicitly unavailable (the external opt-in sentinel below is the only
     * alternative) — never a cwd guess.
     */
    const { resolveEmbeddedDshRuntime, externalDshRuntimeOptedIn } = await import(
      './executor/embedded-dsh-runtime.js'
    );
    const embeddedManagedRoot = options.embeddedDshRuntimeRoot;
    const embeddedRuntime =
      embeddedManagedRoot === undefined ? null : resolveEmbeddedDshRuntime({ managedRoot: embeddedManagedRoot, ...(options.embeddedDshStateRoot === undefined ? {} : { stateRoot: options.embeddedDshStateRoot }) });
    /*
     * H15 — FIRST-START HEALTH CHECK for the PACKAGED kernel (layoutVersion 2,
     * Distribution spec §3): spawn the staged, closure-verified CLI on the staged
     * pinned Node and read the version back; a mismatch or failure REFUSES the
     * kernel (it is not registered) with a typed, logged diagnostic.
     */
    let embeddedKernelHealthy = embeddedRuntime !== null && embeddedRuntime.ok;
    if (embeddedRuntime !== null && embeddedRuntime.ok && embeddedRuntime.value.manifest.layoutVersion === 2) {
      const { checkEmbeddedKernelHealth } = await import('./executor/kernel-health.js');
      const health = await checkEmbeddedKernelHealth(embeddedRuntime.value);
      kernelHealthHolder.report = health;
      embeddedKernelHealthy = health.status === 'HEALTHY';
      if (embeddedKernelHealthy) activeLogger.info('embedded kernel health', { status: health.status, version: health.observedVersion, upstreamSha: health.upstreamSha, elapsedMs: health.elapsedMs, phases: health.phases });
      else activeLogger.warn('embedded kernel REFUSED by the first-start health check', { reasonCode: health.reasonCode, detail: health.detail, declared: health.declaredVersion, observed: health.observedVersion });
    } else if (embeddedRuntime !== null && !embeddedRuntime.ok) {
      activeLogger.warn('embedded kernel unavailable', { reason: embeddedRuntime.error.message });
    }
    if (embeddedRuntime !== null && embeddedRuntime.ok && embeddedKernelHealthy && options.embeddedDshModelRoute !== undefined) {
      const route = options.embeddedDshModelRoute;
      const routeValue = route.apiKeyResolver?.() ?? route.apiKeyValue ?? '';
      const embeddedTypedConfig = resolveExecutorConfig({
        providerKey: DSH_PROVIDER_KEY,
        // Only NON-SECRET identity facts ride the typed config (S25 no-secret law):
        // the raw credential exists solely in the short-lived child environment.
        schema: {
          kernelId: { name: 'kernelId', kind: 'string', required: true },
          upstreamSha: { name: 'upstreamSha', kind: 'string', required: true },
          profileName: { name: 'profileName', kind: 'string', required: true },
          routeProvider: { name: 'routeProvider', kind: 'string', required: true },
          routeModel: { name: 'routeModel', kind: 'string', required: true },
          routeBaseURL: { name: 'routeBaseURL', kind: 'string', required: true },
          routeApiKeyEnv: { name: 'routeApiKeyEnv', kind: 'string', required: true },
        },
        envNames: {},
        composition: {
          kernelId: embeddedRuntime.value.manifest.kernelId,
          upstreamSha: embeddedRuntime.value.manifest.upstreamSha,
          profileName: embeddedRuntime.value.manifest.profileName,
          routeProvider: route.providerId,
          routeModel: route.modelId,
          routeBaseURL: route.baseURL,
          routeApiKeyEnv: route.apiKeyEnv,
        },
      });
      if (embeddedTypedConfig.ok) {
        executorProviderList.push(
          createDshProvider({
            nodeExecutable: '',
            runtimeDir: '',
            profileName: embeddedRuntime.value.manifest.profileName,
            fallbackCwd: null,
            config: embeddedTypedConfig.value,
            embedded: {
              runtime: embeddedRuntime.value,
              ...(options.embeddedDshIsolation === undefined ? {} : { isolation: options.embeddedDshIsolation }),
              modelRoute: {
                providerId: route.providerId,
                modelId: route.modelId,
                baseURL: route.baseURL,
                apiKeyEnv: route.apiKeyEnv,
                apiKeyValue: routeValue,
                contextWindow: route.contextWindow ?? 128_000,
                maxTokens: route.maxTokens ?? 8_192,
              },
              /*
               * LIVE-SMOKE-FIX-08B — LEVEL B inner-tool attribution: every kernel
               * `tool_call` line on stdout becomes a durable, redacted
               * executor.tool_invocation_requested event AT ARRIVAL (evidence only;
               * the ExecutionAttempt row stays the canonical result owner).
               */
              toolInvocationAudit: {
                append: (events) => database.events.append(events as never).then(() => undefined),
                secrets: () => vault.values(),
                ids,
                // LIVE-SMOKE-FIX-08C: a LEVEL B evidence-append failure is LOUD (the
                // kernel controls the inner tool start; a full events-store failure
                // subsumes every durable surface — LEVEL A, settlement, receipts).
                onFailure: (error) => activeLogger.warn('executor tool invocation evidence append failed', {
                  reason: String((error as Error | undefined)?.message ?? error),
                }),
              },
            },
            // The composition arms the deadline (the engine boundary bans engine-held
            // timers) — the SAME seam the native provider uses, so the advertised
            // timeout capability is always enforced in production.
            timer: (ms: number, onTimeout: () => void) => {
              const handle = setTimeout(onTimeout, ms);
              return () => clearTimeout(handle);
            },
          }),
        );
        executorConfigsHolder.set(DSH_PROVIDER_KEY, embeddedTypedConfig.value);
      }
    } else if (externalDshRuntimeOptedIn()) {
      const dshConfig = resolveDshProviderConfig();
      if (dshConfig.ok) {
        const built = createDshProviderFromConfig(dshConfig.value);
        if (built.ok) {
          executorProviderList.push(createDshProvider(built.value));
          executorConfigsHolder.set(DSH_PROVIDER_KEY, dshConfig.value);
        }
      }
    }
    // Native Execution Foundation: the CompanyOS-owned deterministic PROCESS
    // capability, built from TRUSTED DEPLOYMENT DATA (taskKind → authorized
    // operation). It enters through the SAME registry and Sprint25 safety pipeline
    // as every other provider; absent operations fail loud, never a shell guess.
    const nativeTable = options.nativeOperations ?? {};
    if (Object.keys(nativeTable).length > 0) {
      const { createNativeProcessProvider, NATIVE_PROCESS_PROVIDER_KEY } = await import(
        './executor/native-process-provider.js'
      );
      const nativeConfig = resolveExecutorConfig({
        providerKey: NATIVE_PROCESS_PROVIDER_KEY,
        schema: {
          capability: { name: 'capability', kind: 'string', required: false, defaultValue: 'native.process' },
        },
        envNames: {},
      });
      if (nativeConfig.ok) {
        // The composition arms the deadline (the engine boundary bans engine-held
        // timers) — the SAME seam the supervisor dispatch uses, so the advertised
        // timeout capability is always enforced in production.
        executorProviderList.push(
          createNativeProcessProvider(nativeTable, (ms, onTimeout) => {
            const handle = setTimeout(onTimeout, ms);
            return () => clearTimeout(handle);
          }),
        );
        executorConfigsHolder.set(NATIVE_PROCESS_PROVIDER_KEY, nativeConfig.value);
      }
    }

    // H15b (Hark lane): the Job-backed native executor, composed ONLY from trusted
    // deployment data. A refusal is typed and visible (nativeJobStatus), never a fallback.
    if (options.nativeJob !== undefined && Object.keys(options.nativeJob.operations).length > 0) {
      const { composeNativeJobProvider, NATIVE_JOB_PROVIDER_KEY } = await import('./executor/native-lifetime/native-job-composition.js');
      const composed = composeNativeJobProvider({ bindingDir: options.nativeJob.bindingDir, operations: options.nativeJob.operations });
      if (composed.ok) {
        const jobConfig = resolveExecutorConfig({
          providerKey: NATIVE_JOB_PROVIDER_KEY,
          schema: { capability: { name: 'capability', kind: 'string', required: false, defaultValue: 'native.job' } },
          envNames: {},
        });
        if (jobConfig.ok) {
          executorProviderList.push(composed.provider);
          executorConfigsHolder.set(NATIVE_JOB_PROVIDER_KEY, jobConfig.value);
          nativeJobStatus = { registered: true, reasonCode: null, detail: null };
        } else {
          nativeJobStatus = { registered: false, reasonCode: 'NATIVE_JOB_CONFIG_INVALID', detail: jobConfig.error.message };
        }
      } else {
        nativeJobStatus = { registered: false, reasonCode: composed.reasonCode, detail: composed.detail };
        activeLogger.warn('native job executor not registered', { reasonCode: composed.reasonCode, detail: composed.detail });
      }
    }

    // Sprint26: trusted injected implementations — the provider-agnostic seam. The
    // registry is the ONLY resolution path for every implementation alike.
    for (const implementation of options.executorProviderImplementations ?? []) {
      executorProviderList.push(implementation.provider);
      executorConfigsHolder.set(implementation.provider.descriptor.providerKey, implementation.config);
    }
    const executorProviders = executorProviderList.length > 0
      ? createExecutorProviderRegistry(executorProviderList)
      : null;
    executorProvidersHolder = executorProviders;

    /*
     * Sprint 23 — the read-only run observation service. Every dependency is an
     * EXISTING canonical read seam; the review-report projection reuses the T18-04 sink
     * (all pinned tasks are finding anchors, Sprint21 final); decision evidence reuses
     * the supervisor decision sink; agent provenance is a direct read-only SQL view over
     * agent_executions (provenance ONLY — ARCH-013). Zero new tables, zero writes.
     */
    const runObservationNotifier = createRunObservationNotifier();
    const runObservation =
      database.artifactStore !== null && reviewFindingsSink !== null && supervisorDecisionSink !== null
        ? createRunObservationService({
            actorId: SESSION_ACTOR,
            runs: database.runs,
            tasks: database.tasks,
            executionAttempts: database.executionAttempts,
            templates: database.templates,
            validations: {
              listByRun: (runId) => database.validationStore!.listByRun(runId as never),
            },
            artifacts: {
              listByRun: (runId) => database.artifactStore!.listByRun(runId as never),
              getByCreationCommand: (commandId) =>
                database.artifactStore!.getByCreationCommand(commandId) as Promise<{ readonly artifact: { readonly id: string } } | null>,
            },
            events: database.events,
            providerDispatches: { byAttempt: (attemptId) => database.providerDispatches.byAttempt(attemptId) },
            decisionHistory: {
              listRunDecisionHistory: (input) =>
                supervisorDecisionSink.listRunDecisionHistory(input) as never,
            },
            reviewReports: {
              listRunReports: async (input) => {
                const anchors = await database.tasks.listByRun(input.runId);
                const reports: {
                  artifactId: string; reviewTaskId: string; subjectTaskId: string;
                  verdict: string; createdAt: string; blocking: boolean;
                }[] = [];
                for (const anchor of anchors) {
                  const history = await reviewFindingsSink.listReviewHistory({
                    companyId: input.companyId, runId: input.runId,
                    reviewTaskId: String(anchor.id), actorId: input.actorId,
                  });
                  if (!history.ok) return history;
                  for (const report of history.value) {
                    reports.push({
                      artifactId: String(report.artifactId),
                      reviewTaskId: String(anchor.id),
                      subjectTaskId: String(report.payload.subjectTaskId),
                      verdict: String(report.payload.verdict),
                      createdAt: String(report.createdAt),
                      blocking: report.payload.findings.some(
                        (finding) => finding.blocking !== false,
                      ),
                    });
                  }
                }
                return { ok: true as const, value: reports };
              },
            },
            agentExecutions: {
              listByTask: (taskId) =>
                Promise.resolve(
                  (database.db
                    .prepare(
                      'SELECT execution_id, status, model_key, provider_id, provider_model_id FROM agent_executions WHERE task_id = ? ORDER BY created_at, execution_id',
                    )
                    .all(String(taskId)) as {
                      execution_id: string; status: string; model_key: string; provider_id: string; provider_model_id: string;
                    }[]).map((row) => ({
                    executionId: String(row.execution_id),
                    status: String(row.status),
                    modelKey: String(row.model_key),
                    providerId: String(row.provider_id),
                    providerModelId: String(row.provider_model_id),
                  })),
                ),
            },
            handoffs:
              database.handoffStore === null
                ? undefined
                : {
                    // The Sprint11 read is task-scoped; observation counts whole-run
                    // packets via the store's own run column, not a second owner.
                    listForScope: async (scope) =>
                      (database.db
                        .prepare('SELECT handoff_id FROM handoffs WHERE company_id = ? AND workflow_run_id = ?')
                        .all(String(scope.companyId), String(scope.workflowRunId)) as {
                        handoff_id: string;
                      }[]).map((row) => ({ handoffId: String(row.handoff_id) })),
                  },
            clock,
          })
        : null;

    /*
     * Sprint26 — the Product Control Plane, composed from the canonical services this
     * composition already owns. Every dependency is an EXISTING trusted seam; the
     * service itself owns no durable truth.
     */
    // STAGE 3 — the read-only E1 usage projection over the ONE durable database.
    const goalUsageService = createGoalUsageService(
      createDurableUsageReader(database, 'company_default'),
    );

    const controlPlane =
      database.artifactStore !== null && runGoalWriter !== null && sprint13.engine !== null
        ? createControlPlaneService({
            // H12b: read-only operations wait for an open transaction instead of failing.
            readFence: (operation, work) => database.db.writeFence.immediate(operation, work),
            ...(executionSafety === null ? {} : { initializeGoalBudget: executionSafety.initialize }),
            ...(executionSafety === null ? {} : { isGoalCancelled: executionSafety.budget.isCancelled }),
            ...(options.planPreviewWithoutExecutor === true ? { executionAvailable: () => {
              const key = options.providerRoutes?.[GOAL_WORK_KIND] ?? '';
              return key !== '' && executorProvidersHolder !== null && executorProvidersHolder.resolve(key) !== null;
            } } : {}),
            ...(executionSafety === null ? {} : { cancelGoal: async (goalRunId: string) => {
              goalRunId = await database.executionBudget.goalOf(goalRunId) ?? goalRunId;
              await executionSafety.requestCancel(goalRunId);
              // Settlement is not awaited by the caller (an in-flight turn may hold the run's
              // queue); a failure is logged and the next composition re-settles (above).
              void settleGoalCancellation(goalRunId);
              return { accepted: true as const, stopped: false as const, stopEvidence: 'NOT_CONFIRMED' as const };
            } }),
            companyId: 'company_default',
            actorId: SESSION_ACTOR,
            clock,
            ids,
            // F4 closure: the binding source is the MAIN-process canonical active
            // workspace — the renderer can never supply one.
            currentWorkspace: () => {
              const active = repositoryRuntime.currentWorkspace();
              return active === null ? null : { root: active.canonicalRoot, workspaceId: active.workspaceId };
            },
            tasks: { listByRun: (runId: string) => database.tasks.listByRun(runId as never) as never },
            runs: database.runs as never,
            templates: database.templates as never,
            lifecycle: lifecycle as never,
            engine: sprint13.engine as never,
            materializer: normalTaskMaterializer as never,
            planner: plannerRuntime as never,
            compiler: planCompiler as never,
            supervisor: autonomousSupervisor as never,
            observation: runObservation as never,
            runGoal: runGoalWriter as never,
            artifacts: {
              listByRun: (runId: string) =>
                database.artifactStore!.listByRun(runId as never) as Promise<
                  readonly { readonly id: string; readonly kind: string; readonly createdAt?: string }[]
                >,
              getByCreationCommand: (commandId: string) =>
                database.artifactStore!.getByCreationCommand(commandId) as Promise<
                  { readonly artifact: { readonly id: string; readonly contentRef: string } } | null
                >,
              commandIdOf: async (artifactId: string) => {
                const row = database.db
                  .prepare('SELECT creation_command_id FROM artifacts WHERE artifact_id = ?')
                  .get(artifactId) as { creation_command_id: string | null } | undefined;
                return row === undefined || row.creation_command_id === null ? null : String(row.creation_command_id);
              },
              readContent: (contentRef: string) =>
                (artifactFoundation?.contentStore ?? null) === null
                  ? Promise.resolve(null)
                  : (artifactFoundation!.contentStore.get(contentRef) as Promise<Uint8Array | null>),
            },
            selection: {
              // The company's CURRENT canonical selection (manual pin first, then the
              // first preferred model) — resolved from the durable policy, never guessed.
              resolveCompanyModel: async (companyId: string): Promise<string | null> => {
                const policy = await policies.resolveFor([{ scopeType: 'COMPANY', scopeId: companyId }]);
                if (policy === null) return null;
                if (policy.manualModelKey !== null && policy.manualModelKey !== '') return policy.manualModelKey;
                return policy.preferredModels[0] ?? null;
              },
            },
            // STAGE 3 — the canonical approval rows behind an APPROVAL_REQUIRED blocker, so
            // the client's approval card shows the REAL reason and risk. Read-only.
            approvals: {
              listByRun: async (runId: string) => {
                const page = await database.approvals.list({ limit: 50 });
                return page.items
                  .filter((row) => row.runId === runId)
                  .map((row) => ({
                    id: row.id,
                    runId: row.runId,
                    taskId: row.taskId,
                    riskLevel: row.riskLevel,
                    status: row.status,
                    reason: row.reason,
                    requestedBy: row.requestedBy,
                    requestedAt: row.requestedAt,
                    decidedBy: row.decidedBy,
                    decidedAt: row.decidedAt,
                    decisionNote: row.decisionNote,
                  }));
              },
            },
            // STAGE 3 — the read-only E1 usage projection (KNOWN/ESTIMATED/UNKNOWN).
            goalUsage: goalUsageService as never,
            goalBudget: {
              read: async (goalRunId: string) => database.executionBudget.read(goalRunId),
              currency: (['USD', 'CNY', 'EUR', 'CREDIT'] as const).find((c) => c === options.executionSafety?.trustedProofs?.currency) ?? null,
              now: () => Date.now(),
            },
            workProfile: options.goalWorkProfile ?? {
              stageKind: 'work',
              taskKind: GOAL_WORK_KIND,
              maxAttempts: 3,
            },
            /*
             * STAGE 8C — the deterministic professional-seat resolver: the Stage 7
             * RoleResolver over the composition's RoleCatalog (canonical-roles
             * seeded + pack registrations). Lazy over the holder because the catalog
             * is composed earlier in this function; by goal time it always exists.
             */
            professionalSeatOf: (requirement) =>
              resolveProfessionalSeat(roleCatalogHolder ?? new RoleCatalog(), {
                responsibilityIntent: requirement.responsibilityIntent,
                requiredCapabilities: [...(requirement.requiredCapabilities ?? [])],
                expectedOutputKind: requirement.independenceRequired === true ? 'validation' : 'artifact',
                validationExpectation: requirement.independenceRequired === true ? 'independent review' : 'acceptance criteria met',
                independenceRequired: requirement.independenceRequired === true,
                riskLevel: requirement.riskLevel ?? 'low',
              }),
            /*
             * STAGE 9B-FIX — the supervisor turn's first-turn subject is the run's
             * BUSINESS task under the same semantic rule the review/validation seats
             * use, so a Decision can never name whatever row sorts first.
             */
            businessSubjectOf: async (runId) =>
              workSubjectTaskOf(database, runId, {
                reviewKinds: new Set(['review', ...options.stageHandlers?.reviewKinds ?? []]),
                validationKinds: new Set(['qa', ...options.stageHandlers?.qaKinds ?? []]),
              }),
          })
        : null;

    /*
     * STAGE 9 — the Goal-to-Outcome AUTONOMY DRIVER: a bounded application
     * service that loops the EXISTING control-plane advance command and
     * classifies typed terminal states from canonical durable truth. It owns
     * no Task/Workflow/Role/Attempt/Validation state (no second scheduler),
     * cannot bypass approvals (WAITING_APPROVAL stops autonomy with a
     * structured user decision request), and reloads truth every step so a
     * restarted process continues from durable state.
     */
    const autonomyDriverDeps: AutonomyDriverDeps = {
      // H15c: the durable budget envelope's standing refusal (null when no envelope is bound).
      ...(executionSafety === null ? {} : {
        standingAdmissionRefusal: async ({runId}: {readonly companyId: string; readonly runId: string}) => {
          try {
            await executionSafety.budget.check(runId);
            // H15c-fix10 (hark-live-goal 40300575683): every admitted call of the envelope is
            // spent — no autonomous step can be admitted again, so this is a standing refusal
            // (operator budget renewal), not 19 refused supervisor turns ending in a stall.
            // H15d-fix5 (hark-live-goal 40359081704): the money/token cap counts too — no bound
            // this Goal has reserved still fits — not only the call-slot count.
            const envelope = await executionSafety.budget.read(runId);
            return goalEnvelopeExhausted(envelope) ? 'GOAL_BUDGET_EXHAUSTED' : null;
          } catch (error) {
            const reason = error instanceof DomainError ? String(error.details['reason'] ?? '') : '';
            return STANDING_ADMISSION_REFUSALS.includes(reason) ? reason : null;
          }
        },
      }),
      advanceGoal: async ({companyId, runId}) => {
        if (controlPlane === null) {
          return err(new DomainError('PERSISTENCE_FAILED', 'The control plane is not wired.', {details: {reason: 'CONTROL_PLANE_PIPELINE_UNAVAILABLE'}}));
        }
        return (await controlPlane.handle({
          operation: 'goal.advance',
          payload: {companyId, runId},
        })) as Result<unknown, DomainError>;
      },
      // H12b: the whole snapshot is read in the connection's read fence — it waits for an
      // open transaction (e.g. another Goal's cancellation settling) instead of being
      // refused CROSS_CONTEXT_TRANSACTION_READ_REFUSED mid-run, and it is one consistent
      // committed view.
      loadGoalState: async (input) => database.db.writeFence.immediate('autonomy:loadGoalState', async () => {
        const {companyId, runId} = input;
        const goalRun = (await database.runs.get(runId as never)) as {id: string; state: string; companyId: string} | null;
        if (goalRun === null || String(goalRun.companyId) !== companyId) {
          return err(new DomainError('NOT_FOUND', `Goal run "${runId}" does not exist for this company.`, {details: {reason: 'CONTROL_PLANE_RUN_NOT_FOUND'}}));
        }
        // Derived execution runs — the SAME canonical anchor derivation goal.workspace uses.
        const executionRuns: {runId: string; state: string}[] = [];
        if (database.artifactStore !== null) {
          const anchors = (await database.artifactStore.listByRun(runId as never)).filter(
            (artifact) => String(artifact.kind) === 'companyos:plan-compilation',
          );
          for (const anchor of anchors) {
            const row = database.db
              .prepare('SELECT creation_command_id FROM artifacts WHERE artifact_id = ?')
              .get(String(anchor.id)) as {creation_command_id: string | null} | undefined;
            const commandId = row === undefined || row.creation_command_id === null ? null : String(row.creation_command_id);
            if (commandId === null) continue;
            const prefix = `plan-compile:${companyId}:goal-compile:`;
            if (!commandId.startsWith(prefix)) continue;
            const planId = commandId.slice(prefix.length);
            const executionRunId = executionRunIdOf(companyId, runId, planId, `goal-compile:${planId}`);
            const executionRun = (await database.runs.get(executionRunId as never)) as {id: string; state: string; companyId: string} | null;
            if (executionRun === null || String(executionRun.companyId) !== companyId) continue;
            executionRuns.push({runId: executionRunId, state: String(executionRun.state)});
          }
        }
        const execIds = executionRuns.map((entry) => entry.runId);
        const taskRows: {
          readonly id: string;
          readonly state: string;
          readonly roleId: string;
          readonly attemptCount: number;
          readonly correctiveRound: number;
        }[] = [];
        let totalAttempts = 0;
        let failedAttempts = 0;
        let correctiveCycles = 0;
        for (const execId of execIds) {
          const runTasks = await database.tasks.listByRun(execId as never);
          for (const task of runTasks) {
            const inputs = (task as {readonly inputs?: Record<string, unknown>}).inputs ?? {};
            const corrective = inputs['corrective'];
            const round =
              typeof corrective === 'object' && corrective !== null && typeof (corrective as Record<string, unknown>)['round'] === 'number'
                ? Number((corrective as Record<string, unknown>)['round'])
                : 0;
            correctiveCycles = Math.max(correctiveCycles, round);
            taskRows.push({
              id: String(task.id),
              state: String(task.state),
              roleId: String(task.roleId),
              attemptCount: Number(task.attempts ?? 0),
              correctiveRound: round,
            });
          }
          const attemptRows = database.db
            .prepare('SELECT state FROM execution_attempts WHERE run_id = ?')
            .all(execId) as {state: string}[];
          totalAttempts += attemptRows.length;
          failedAttempts += attemptRows.filter((row) => row.state === 'FAILED').length;
        }
        // The pending approval: the canonical "run awaits the user" read (the
        // engine's own pendingApprovalId semantics, paged scan over the store).
        let pendingApproval: GoalAutonomyState['pendingApproval'] = null;
        for (const execId of execIds) {
          const page = await database.approvals.list({limit: 200, offset: 0});
          const found = page.items.find((approval) => String(approval.runId) === execId && approval.status === 'pending');
          if (found !== undefined) {
            pendingApproval = {
              id: String(found.id),
              riskLevel: String(found.riskLevel),
              reason: String(found.reason),
              taskId: found.taskId === null || found.taskId === undefined ? null : String(found.taskId),
            };
            break;
          }
        }
        const snapshot = {
          goalRunId: runId,
          goalRunState: String(goalRun.state),
          executionRuns,
          tasks: taskRows,
          totalAttempts,
          failedAttempts,
          correctiveCycles,
          pendingApproval,
          decisionCount: Number((database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as {n: number}).n),
          eventCount: Number((database.db.prepare('SELECT COUNT(*) AS n FROM events').get() as {n: number}).n),
        };
        return ok({...snapshot, fingerprint: autonomyFingerprintOf(snapshot)});
      }),
      preflightChecks: async ({companyId}) => {
        const checks: DoctorCheck[] = [];
        // 1. Company model selection (the planner/supervisor binding source).
        const policy = await policies.resolveFor([{scopeType: 'COMPANY', scopeId: companyId}]);
        const modelKey = policy === null ? null : policy.manualModelKey !== null && policy.manualModelKey !== '' ? policy.manualModelKey : policy.preferredModels[0] ?? null;
        checks.push({
          checkId: 'model-selection',
          status: modelKey === null ? 'fail' : 'pass',
          requiredForGoal: true,
          failureCode: modelKey === null ? 'CONTROL_PLANE_MODEL_UNSELECTED' : null,
          remediationKind: modelKey === null ? 'configure-model' : 'none',
          detailsSafeForUser: modelKey === null ? 'No model is selected for this company; planning cannot run.' : 'A company model is selected.',
        });
        // 2. Executor provider for the deployment's work kind.
        const workProviderKey = options.providerRoutes?.[GOAL_WORK_KIND] ?? '';
        const providerResolved = executorProvidersHolder === null ? null : executorProvidersHolder.resolve(workProviderKey);
        checks.push({
          checkId: 'executor-provider',
          status: workProviderKey === '' || providerResolved === null ? 'fail' : 'pass',
          // H10b: with plan preview the gate moves to goal.advance (after the plan, before compile).
          requiredForGoal: options.planPreviewWithoutExecutor !== true,
          failureCode: workProviderKey === '' || providerResolved === null ? 'EXECUTOR_PROVIDER_UNKNOWN' : null,
          remediationKind: workProviderKey === '' || providerResolved === null ? 'register-provider' : 'none',
          detailsSafeForUser: 'The executor provider for the work kind must be registered.',
        });
        // 3-4. Smart-routing preconditions (goal-scoped, mode-aware).
        const routing = options.modelRouting;
        // SMART-ROUTER-PROD-01: the resolved product routing configuration is itself
        // reported — auditable mode + policy identity (names only, never secrets).
        checks.push({
          checkId: 'routing-mode',
          status: 'pass',
          requiredForGoal: false,
          failureCode: null,
          remediationKind: 'none',
          detailsSafeForUser:
            routing === undefined
              ? 'Routing mode DETERMINISTIC_V1 (product default).'
              : `Routing mode ${routing.mode}; policy ${routing.policy?.policyId ?? 'BALANCED'}@v${String(routing.policy?.policyVersion ?? 1)}.`,
        });
        if (routing?.mode === 'SMART_ROUTER_V1') {
          const pool = routing.pool;
          const routable = pool === undefined ? [] : pool.listEnabled().filter((profile) => profile.routingTraits !== undefined);
          checks.push({
            checkId: 'routable-model-profile',
            status: routable.length === 0 ? 'fail' : 'pass',
            requiredForGoal: true,
            failureCode: routable.length === 0 ? 'MODEL_POOL_EMPTY' : null,
            remediationKind: routable.length === 0 ? 'register-routable-model' : 'none',
            detailsSafeForUser: routable.length === 0 ? 'No enabled model profile carries routing traits; smart routing cannot select a model.' : 'Routable model profiles exist.',
          });
          const available = new Set(await vault.available());
          // PROD-01C: a profile whose EXPLICIT contract is no-auth needs no
          // credential; only authentication-required profiles must resolve.
          const requiringCredential = routable.filter((profile) => (profile.authentication ?? 'REQUIRED') !== 'NONE');
          const resolvable = requiringCredential.filter((profile) => {
            const name = profile.credentialRef.replace(/^vault:\/\//, '').split('/')[0] ?? '';
            return available.has(name);
          });
          checks.push({
            checkId: 'model-credential',
            status: resolvable.length === requiringCredential.length && routable.length > 0 ? 'pass' : 'fail',
            requiredForGoal: true,
            failureCode: resolvable.length !== requiringCredential.length && requiringCredential.length > 0 ? 'MODEL_CREDENTIAL_MISSING' : null,
            remediationKind: resolvable.length !== requiringCredential.length && requiringCredential.length > 0 ? 'configure-credential' : 'none',
            detailsSafeForUser:
              resolvable.length !== requiringCredential.length && requiringCredential.length > 0
                ? 'At least one routable model credential is missing from the secret vault; live model execution is blocked.'
                : 'Routable model credentials are configured (no-auth profiles need none).',
          });
        }
        // 5. Trusted workspace.
        checks.push({
          checkId: 'workspace-open',
          status: repositoryRuntime.currentWorkspace() === null ? 'fail' : 'pass',
          requiredForGoal: true,
          failureCode: repositoryRuntime.currentWorkspace() === null ? 'WORKSPACE_NOT_OPEN' : null,
          remediationKind: repositoryRuntime.currentWorkspace() === null ? 'open-workspace' : 'none',
          detailsSafeForUser: 'A trusted workspace must be open for executor dispatch.',
        });
        return checks;
      },
      projectOutcome: async ({runId, state, status, externalBlocks}) => {
        const execIds = state.executionRuns.map((entry) => entry.runId);
        const deliverableArtifactRefs: string[] = [];
        const validationRefs: string[] = [];
        const decisionRefs: string[] = [];
        const knownRisks: string[] = [];
        let inputTokens = 0;
        let outputTokens = 0;
        let usageSeen = false;
        for (const execId of execIds) {
          if (database.artifactStore !== null) {
            const arts = await database.artifactStore.listByRun(execId as never);
            for (const artifact of arts) {
              deliverableArtifactRefs.push(String(artifact.id));
            }
          }
          if (database.validationStore !== null) {
            const validations = await database.validationStore.listByRun(execId as never);
            for (const validation of validations) {
              validationRefs.push(String(validation.id));
            }
          }
          const handoffRows = database.db
            .prepare('SELECT known_risks_json FROM handoffs WHERE workflow_run_id = ?')
            .all(execId) as {known_risks_json: string}[];
          for (const row of handoffRows) {
            try {
              const risks = JSON.parse(row.known_risks_json) as unknown;
              if (Array.isArray(risks)) {
                for (const risk of risks) {
                  if (typeof risk === 'string') knownRisks.push(risk);
                }
              }
            } catch {
              /* malformed risk JSON is not outcome truth */
            }
          }
          const usageRows = database.db
            .prepare('SELECT input_usage, output_usage FROM agent_executions WHERE run_id = ?')
            .all(execId) as {input_usage: string | null; output_usage: string | null}[];
          for (const row of usageRows) {
            const read = (raw: string | null): {inputTokens?: number; outputTokens?: number} => {
              if (raw === null) return {};
              try {
                return JSON.parse(raw) as {inputTokens?: number; outputTokens?: number};
              } catch {
                return {};
              }
            };
            const inputUsage = read(row.input_usage);
            const outputUsage = read(row.output_usage);
            if (inputUsage.inputTokens !== undefined || outputUsage.outputTokens !== undefined) usageSeen = true;
            inputTokens += Number(inputUsage.inputTokens ?? 0);
            outputTokens += Number(outputUsage.outputTokens ?? 0);
          }
        }
        if (database.decisions !== null) {
          const decisions = await database.decisions.listAll();
          for (const decision of decisions) {
            const metadata = (decision as {readonly metadata?: Record<string, unknown>}).metadata;
            const supervisor = metadata?.['supervisor'] as {readonly runId?: unknown} | undefined;
            if (supervisor !== undefined && typeof supervisor.runId === 'string' && execIds.includes(supervisor.runId)) {
              decisionRefs.push(String(decision.decisionId));
            }
          }
        }
        const projection: FinalOutcomeProjection = {
          goalRunId: runId,
          executionRunId: execIds[0] ?? null,
          completionStatus: status,
          deliverableArtifactRefs: [...new Set(deliverableArtifactRefs)].sort(),
          validationRefs: [...new Set(validationRefs)].sort(),
          decisionRefs: [...new Set(decisionRefs)].sort(),
          knownRisks: [...new Set(knownRisks)],
          remainingExternalBlocks: [...externalBlocks],
          rolesInvolved: [...new Set(state.tasks.map((task) => task.roleId))].sort(),
          attemptSummary: {
            totalAttempts: state.totalAttempts,
            failedAttempts: state.failedAttempts,
            tasksDone: state.tasks.filter((task) => task.state === 'DONE').length,
            tasksTotal: state.tasks.length,
          },
          usageSummary: usageSeen ? {classification: 'ESTIMATED', inputTokens, outputTokens} : null,
          requiresUserAction:
            status === 'USER_DECISION_REQUIRED' && state.pendingApproval !== null
              ? userDecisionRequestFromApproval({approval: state.pendingApproval, goalRunId: runId})
              : null,
        };
        return projection;
      },
    };
    const autonomyDriver = createGoalOutcomeAutonomyDriver(autonomyDriverDeps);

    return {
      kernelHealth: () => kernelHealthHolder.report,
      database,
      compositionError,
      repositoryRuntime,
      clock,
      ids,
      authz,
      sessionAuthorize,
      vault,
      providers,
      models,
      policies,
      tools,
      runtime,
      sprint13,
      lifecycle,
      supervisorDecisionSink,
      reviewFindingsSink,
      correctiveProvisioner,
      supervisorDecisionRuntime,
      autonomousSupervisor,
      stageOutputCarrier,
      evidenceApplicator,
      sessionKernel,
      developerSession,
      pinnedAgentExecution,
      normalTaskMaterializer,
      plannerRuntime,
      planCompiler,
      workPackageProjector,
      runObservation,
      executorProviders,
      nativeJobStatus,
      runObservationNotifier,
      controlPlane,
      autonomyDriver,
      durableReferenceResolver,
      packAvailability,
      packProvenance,
    };
  } catch (error) {
    compositionError = error instanceof Error ? error.message : String(error);
    activeLogger.error('core services composition failed', { error: compositionError });
    lastCompositionError = compositionError;
    return null;
  }
}

/** The last composition failure (diagnostics only; never a success signal). */
let lastCompositionError: string | null = null;
export const lastCoreCompositionError = (): string | null => lastCompositionError;
