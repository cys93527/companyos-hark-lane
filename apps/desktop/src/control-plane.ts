/**
 * Sprint26 — the PRODUCT CONTROL PLANE: the trusted application service behind the
 * Goal-to-Outcome desktop runtime.
 *
 * What this module is: the ONE typed boundary between the (untrusted) renderer and
 * the canonical Goal→Plan→Run pipeline that already exists (Sprint 18–25). It
 * validates every request, proves company scope and run ownership, applies the
 * frozen idempotency/revision rules, and then forwards to EXISTING canonical
 * services only: lifecycle (run + run-owned goal), engine, NormalTaskMaterializer,
 * PlannerRuntime, PlanCompiler, AutonomousSupervisor, RunObservationService, the
 * run-goal reader, the artifact/CAS path and the command ledger.
 *
 * What this module is NOT: a truth owner. It holds no durable state, creates no
 * tables, and every projection it returns is derived and fully rebuildable
 * (contract §32/§33). UI failure can never mutate workflow state: nothing here
 * writes except through the canonical services, and every command below names its
 * canonical owner in docs/sprint26/S26_PRODUCT_CONTROL_PLANE.md (action matrix).
 *
 * Product shape (V1): the user expresses a Goal ("你想把什么事情变成现实？");
 * `goal.create` mints the canonical planning run WITH the goal in one lifecycle
 * transaction; `goal.advance` performs bounded canonical pipeline steps (planning
 * turn → trusted per-item spec derivation → deterministic compile → one supervisor
 * turn); reads project the Sprint23 observation. ADR-B adds durable cancellation
 * acceptance; it does not claim remote work has stopped or introduce a pause UI.
 */
import { DomainError, domainError, err, ok, type GoalExecutionBudget, type Result } from '@companyos/core';
import { projectGoalBudget, type BudgetCurrency } from './efficiency/goal-budget-projection.js';
import { executionRunIdOf } from '@companyos/engine';
import { fileDeliveriesOf } from './verified-file-delivery.js';

/* ------------------------------------------------------------ vocabulary --- */

/** The generic work kind compiled plan items execute as (deployment-declared). */
export const GOAL_WORK_KIND = 'companyos:work';
/** The planning stage node of the trusted default planning workflow. */
export const GOAL_PLANNING_STAGE = 'plan';
/** The workflow lineage name of the trusted default planning workflow. */
export const GOAL_PLANNING_WORKFLOW_ID = 'wf-companyos-goal';

/**
 * BB2 final forensic closure — the deployment's SOFTWARE operation kind: the closed
 * vocabulary a plan item declares when the item IS software work (fix/build/test a
 * code project in the workspace). Declared deployment data over the same closed set the
 * control plane validates plan items against; carrying this kind routes the item to the
 * deployment's SPECIALIZED software validation authority.
 */
export const SOFTWARE_WORK_KIND = 'companyos:software-work';

/**
 * The deterministic validator-selection policy (BB2 closure) — the ONE selection owner
 * over the deployment's declared work profile: a plan item's declared task kind resolves
 * through the profile's PER-KIND policy when the deployment declared one, else the
 * profile's baseline validator set. Pure, total and static: the inputs are exactly the
 * deployment profile and the closed-set kind — never a filename, never goal text, never
 * a role name — so the same inputs always select the same validators (SV-07/SV-08).
 */
export const validatorIdsForTaskKind = (
  workProfile: {
    readonly validatorIds?: readonly string[];
    readonly validatorIdsByTaskKind?: Readonly<Record<string, readonly string[]>>;
  },
  taskKind: string,
): readonly string[] =>
  workProfile.validatorIdsByTaskKind?.[taskKind] ?? workProfile.validatorIds ?? [];
/** The deterministic template NAME of the trusted default planning workflow (display only). */
export const GOAL_PLANNING_TEMPLATE_NAME = 'companyos.goal-planning/1';

/**
 * STAGE 4 — the closed access-policy vocabulary a user may select for a Goal. The
 * canonical owner is the Goal itself (bound into the run-goal artifact's structured
 * payload). Enforcement is below the renderer: READ_ONLY maps onto the DSH kernel's own
 * fs-sandbox read-only mode; ASK_PERMISSION keeps the canonical approval boundary;
 * WORKSPACE_OPERATIONS adds nothing beyond the trusted workspace containment that
 * already exists. No second authority truth is introduced anywhere.
 */
export const ACCESS_POLICIES = ['ASK_PERMISSION', 'READ_ONLY', 'WORKSPACE_OPERATIONS'] as const;
export type AccessPolicy = (typeof ACCESS_POLICIES)[number];

export const CONTROL_PLANE_OPERATIONS = [
  'goal.create',
  'goal.advance',
  'goal.cancel',
  'approval.respond',
  'home.summary',
  'goal.workspace',
  'run.overview',
  'run.blockers',
  'run.timeline',
  'run.task',
  'run.artifacts',
  'decisions.pending',
  // STAGE 3: read-only E1 usage projection for one Goal (startup/observability surface).
  'run.usage',
  // H11: read-only budget/spend projection + the previewed plan (boss view; never admission).
  'run.budget',
] as const;

export type ControlPlaneOperation = (typeof CONTROL_PLANE_OPERATIONS)[number];

/** Every command response carries the typed error when it fails — never a collapse. */
export interface ControlPlaneEnvelope<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code: string; readonly message: string; readonly details?: unknown };
}

/* ------------------------------------------------------------------- deps --- */

export interface ControlPlaneDeps {
  readonly cancelGoal?: (goalRunId: string) => Promise<{ readonly accepted: true; readonly stopped: false; readonly stopEvidence: 'NOT_CONFIRMED' }>;
  readonly initializeGoalBudget?: (goalRunId: string) => Promise<void>;
  readonly isGoalCancelled?: (runId: string) => Promise<boolean>;
  /**
   * H10b PLAN-PREVIEW GATE: whether the deployment can EXECUTE work items (the work-kind
   * executor is registered). When it returns false the planning turn still runs (bounded by
   * the trusted budget admission) and the plan artifact is kept for the boss to read, but
   * compilation/dispatch is refused with the typed EXECUTOR_PROVIDER_UNKNOWN precondition.
   * Absent => unchanged behaviour.
   */
  readonly executionAvailable?: () => boolean;
  /** The single active company (V1): every request is scoped and PROVEN against it. */
  readonly companyId: string;
  /** The trusted session actor stamped on every canonical command. */
  readonly actorId: string;
  readonly clock: { nowIso(): string };
  readonly ids: { id(prefix?: string): string };

  /** Read-only task inventory (the supervisor's first-turn subject selection). */
  readonly tasks: {
    listByRun(runId: string): Promise<readonly { readonly id: string; readonly state: string }[]>;
  };

  /**
   * F4 closure — the MAIN-process canonical active workspace identity (never a renderer
   * value): the binding source for goal.create. The renderer cannot supply a workspace;
   * a Goal binds to the workspace that is canonically open AT CREATION and never silently
   * re-targets to whatever is open later. The identity is the OPAQUE canonical
   * workspaceId (derived from the canonical root) — not a local path, so the durable
   * goal payload never smuggles host filesystem data.
   */
  readonly currentWorkspace: () => { readonly root: string; readonly workspaceId: string } | null;

  readonly runs: {
    get(runId: string): Promise<{
      readonly id: string;
      readonly companyId: string;
      readonly workflowId: string;
      readonly state: string;
      readonly revision: number;
      readonly snapshotId: string;
      readonly versionId: string;
      readonly templateId: string;
    } | null>;
    list(page?: { readonly limit?: number; readonly offset?: number }): Promise<{
      readonly items: readonly {
        readonly id: string;
        readonly companyId: string;
        readonly workflowId: string;
        readonly state: string;
        readonly createdAt?: string;
      }[];
      readonly total: number;
    }>;
  };

  /** Template inventory for the idempotent planning-workflow provisioning. */
  readonly templates: {
    list(page?: { readonly limit?: number; readonly offset?: number }): Promise<{
      readonly items: readonly {
        readonly id: string;
        readonly orgId: string;
        readonly name: string;
        readonly state: string;
        readonly currentVersionId: string | null;
      }[];
      readonly total: number;
    }>;
  };

  readonly lifecycle: {
    createTemplate(input: {
      readonly orgId: string;
      readonly name: string;
      readonly actorId: string;
    }): Promise<Result<{ readonly id: string }, DomainError>>;
    saveDraftGraph(input: {
      readonly templateId: string;
      readonly graph: unknown;
      readonly actorId: string;
    }): Promise<Result<unknown, DomainError>>;
    publish(input: { readonly templateId: string; readonly actorId: string }): Promise<
      Result<{ readonly id: string; readonly versions?: readonly { readonly id: string }[] }, DomainError>
    >;
    createRun(input: {
      readonly templateId: string;
      readonly companyId: string;
      readonly workflowId: string;
      readonly actorId: string;
      readonly commandId?: string;
      readonly modelBindings?: Readonly<Record<string, string>>;
      readonly goal?: {
        readonly objective: string;
        readonly source: { readonly type: string };
        /** STAGE 4: carries the Goal's canonical access policy (bound into the run-goal artifact). */
        readonly structured?: Readonly<Record<string, unknown>>;
      };
    }): Promise<Result<{ readonly run: { readonly id: string } }, DomainError>>;
  };

  readonly engine: {
    drive(runId: string, options?: { readonly maxSteps?: number }): Promise<
      Result<{ readonly run: { readonly state: string; readonly revision: number } }, DomainError>
    >;
    dispatch(command: {
      readonly commandId: string;
      readonly runId: string;
      readonly type: string;
      readonly expectedRevision: number;
      readonly actorId: string;
      readonly traceId: string;
      readonly issuedAt: string;
      readonly reason?: string;
      readonly payload?: Readonly<Record<string, unknown>>;
    }): Promise<Result<{ readonly duplicate: boolean; readonly to: string }, DomainError>>;
  };

  readonly materializer: {
    materialize(input: {
      readonly companyId: string;
      readonly runId: string;
      readonly stageId: string;
    }): Promise<Result<{ readonly taskId: string }, DomainError>>;
  } | null;

  readonly planner: {
    runPlanningTurn(input: {
      readonly companyId: string;
      readonly runId: string;
      readonly taskId: string;
      readonly planningCommandId: string;
      readonly actorId: string;
    }): Promise<Result<{ readonly planId: string; readonly artifactId: string; readonly replayed: boolean }, DomainError>>;
  } | null;

  readonly compiler: {
    compile(
      input: {
        readonly companyId: string;
        readonly planningRunId: string;
        readonly planArtifactId: string;
        readonly compilationCommandId: string;
        readonly actorId: string;
        readonly executionBindings: Readonly<Record<string, string>>;
      },
      spec: { readonly planItemProfiles: Readonly<Record<string, unknown>> },
    ): Promise<
      Result<
        { readonly planId: string; readonly executionRunId: string; readonly versionId: string; readonly templateId: string },
        DomainError
      >
    >;
  } | null;

  readonly supervisor: {
    run(command: {
      readonly companyId: string;
      readonly runId: string;
      readonly taskId: string;
      readonly actorId: string;
      readonly runIdentity: string;
      readonly traceId?: string;
    }): Promise<Result<{ readonly outcome: string }, DomainError>>;
    resumeEscalatedRun(input: {
      readonly companyId: string;
      readonly runId: string;
      readonly actorId: string;
      readonly note?: string;
    }): Promise<Result<{ readonly resumed: boolean }, DomainError>>;
  } | null;

  readonly observation: {
    getRunOverview(input: { readonly companyId: string; readonly runId: string }): Promise<Result<unknown, DomainError>>;
    getRunBlockers(input: { readonly companyId: string; readonly runId: string }): Promise<Result<unknown, DomainError>>;
    getRunTimeline(input: {
      readonly companyId: string;
      readonly runId: string;
      readonly cursor?: unknown;
      readonly limit?: number;
    }): Promise<Result<unknown, DomainError>>;
    getTaskObservation(input: { readonly companyId: string; readonly taskId: string }): Promise<Result<unknown, DomainError>>;
  } | null;

  readonly runGoal: {
    get(input: { readonly runId: string; readonly companyId: string }): Promise<
      Result<{ readonly objective: string; readonly structured?: Readonly<Record<string, unknown>> | null }, DomainError>
    >;
  } | null;

  /**
   * STAGE 3 — read-only projection of the canonical `approvals` rows (durable truth).
   * Used to give an approval card its reason / risk / requester; it never writes.
   */
  readonly approvals?: {
    listByRun(runId: string): Promise<
      readonly {
        readonly id: string;
        readonly runId: string;
        readonly taskId: string | null;
        readonly riskLevel: string;
        readonly status: string;
        readonly reason: string;
        readonly requestedBy: string;
        readonly requestedAt: string;
        readonly decidedBy: string | null;
        readonly decidedAt: string | null;
        readonly decisionNote: string | null;
      }[]
    >;
  };

  /**
   * STAGE 3 — read-only E1 usage projection for one Goal (main-process truth; the
   * renderer never sees a database). Answers UNKNOWN honestly where no source exists.
   */
  /** H11 — read-only durable budget facts for the boss view (the admission store itself). */
  readonly goalBudget?: {
    read(goalRunId: string): Promise<GoalExecutionBudget | null>;
    readonly currency: BudgetCurrency | null;
    now(): number;
  };
  readonly goalUsage?: {
    usageOf(input: { readonly companyId: string; readonly runId: string }): Promise<Result<unknown, DomainError>>;
  };

  readonly artifacts: {
    listByRun(runId: string): Promise<readonly { readonly id: string; readonly kind: string; readonly createdAt?: string }[]>;
    getByCreationCommand(commandId: string): Promise<{ readonly artifact: { readonly id: string; readonly contentRef: string } } | null>;
    commandIdOf(artifactId: string): Promise<string | null>;
    readContent(contentRef: string): Promise<Uint8Array | null>;
  };

  /**
   * The canonical model-selection seam: resolves the company's current selection
   * (manual pin or first preferred model) so created runs carry real model bindings.
   * Null when no model is selected — goal creation then fails CLOSED with a typed
   * error (the product needs a model; nothing is guessed).
   */
  readonly selection?: {
    resolveCompanyModel(companyId: string): Promise<string | null>;
  };

  /**
   * The trusted default work profile every plan item compiles to (V1 derivation rule).
   * Deployment configuration — the Pack seam refines this later; the MODEL never
   * influences it.
   */
  readonly workProfile: {
    readonly stageKind: string;
    readonly taskKind: string;
    readonly maxAttempts: number;
    /**
     * V1 Native Production Readiness: the deployment's CLOSED set of native
     * operation kinds a plan item may REQUEST. A proposed taskKind outside this
     * set (and outside the default work kind) fails closed — the model proposes,
     * the deployment disposes.
     */
    readonly operationKinds?: readonly string[];
    /**
     * STAGE 9 — the deployment's CLOSED validator set every work item pins
     * (trusted data, the same authority class as operationKinds): the frozen
     * evidence gate requires durable validation before a goal may COMPLETE.
     */
    readonly validatorIds?: readonly string[];
  };
  /**
   * STAGE 8C — the trusted professional-seat resolver (the deterministic Stage 7
   * RoleResolver over the composition's RoleCatalog): one plan item's derived
   * ProfessionalResponsibilityRequirement resolves to the seat pinned into the
   * task profile. Absent = the composition predates Stage 8C (fail loud on the
   * first goal: the normal path may never flatten to a generic worker seat).
   */
  readonly professionalSeatOf?: (
    requirement: {
      readonly responsibilityIntent: string;
      readonly requiredCapabilities?: readonly string[];
      readonly independenceRequired?: boolean;
      readonly riskLevel?: 'low' | 'medium' | 'high';
    },
  ) => { readonly seatId: string };
  /**
   * STAGE 9B-FIX — the run's BUSINESS subject (the task the run is delivering), derived from
   * canonical lineage semantics (the frozen rule: corrective generation, then earliest
   * createdAt, then id) — the SAME rule every review/validation/supervisor seat uses. The
   * supervisor turn's Decision concerns this task, never an instrumental gate task and never
   * whichever row happens to sort first.
   */
  readonly businessSubjectOf?: (runId: string) => Promise<string | null>;
}

/* ------------------------------------------------------------- validation --- */

const invalid = (message: string, reason: string): DomainError =>
  domainError('INVALID_ARGUMENT', message, { reason });

const readObject = (payload: unknown): Result<Readonly<Record<string, unknown>>, DomainError> => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return err(invalid('The request payload must be an object.', 'CONTROL_PLANE_PAYLOAD_INVALID'));
  }
  return ok(payload as Readonly<Record<string, unknown>>);
};

const readString = (payload: Readonly<Record<string, unknown>>, key: string, maxLength: number): Result<string, DomainError> => {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim() === '') {
    return err(invalid(`The field "${key}" must be a non-empty string.`, 'CONTROL_PLANE_FIELD_INVALID'));
  }
  if (value.length > maxLength) {
    return err(invalid(`The field "${key}" exceeds its bound of ${String(maxLength)} characters.`, 'CONTROL_PLANE_FIELD_TOO_LONG'));
  }
  return ok(value);
};

/** Cross-scope protection (§36): a named company that is not the active company fails closed. */
const proveCompany = (deps: ControlPlaneDeps, stated: string): Result<true, DomainError> => {
  if (stated !== deps.companyId) {
    return err(
      domainError('PERMISSION_DENIED', 'The named company is not accessible from this session.', {
        reason: 'CONTROL_PLANE_CROSS_COMPANY_REFUSED',
      }),
    );
  }
  return ok(true);
};

const loadOwnedRun = async (
  deps: ControlPlaneDeps,
  companyId: string,
  runId: string,
): Promise<Result<NonNullable<Awaited<ReturnType<ControlPlaneDeps['runs']['get']>>>, DomainError>> => {
  const run = await deps.runs.get(runId);
  if (run === null) {
    return err(domainError('NOT_FOUND', `Run "${runId}" does not exist.`, { reason: 'CONTROL_PLANE_RUN_NOT_FOUND', runId }));
  }
  if (run.companyId !== companyId) {
    return err(
      domainError('PERMISSION_DENIED', 'The named run does not belong to this company.', {
        reason: 'CONTROL_PLANE_CROSS_RUN_REFUSED',
        runId,
      }),
    );
  }
  return ok(run);
};

/* -------------------------------------------- the trusted planning workflow --- */

/**
 * The ONE-TIME trusted provisioning of the default planning workflow (a 'planning'
 * node with the planner task profile). Idempotent by deterministic NAME lookup; a
 * second process finds the published template and reuses it. This is the same
 * create/publish lifecycle authority every workflow goes through — no shortcut, no
 * seed file, no second truth.
 */
const ensurePlanningWorkflow = async (deps: ControlPlaneDeps): Promise<Result<string, DomainError>> => {
  const templates = await deps.templates.list({ limit: 500, offset: 0 });
  const existing = templates.items.find(
    (template) => template.name === GOAL_PLANNING_TEMPLATE_NAME && template.orgId === deps.companyId,
  );
  // PUBLISHED = a current version exists; a never-published draft of the same name is
  // finished publishing rather than duplicated (the lifecycle arbitrates replays).
  if (existing !== undefined && existing.currentVersionId !== null) {
    return ok(existing.id);
  }
  let templateId: string;
  if (existing !== undefined) {
    templateId = existing.id; // provisioned earlier but never published: finish it
  } else {
    const created = await deps.lifecycle.createTemplate({
      orgId: deps.companyId,
      name: GOAL_PLANNING_TEMPLATE_NAME,
      actorId: deps.actorId,
    });
    if (!created.ok) return created;
    templateId = created.value.id;
  }
  const graph = {
    nodes: [
      {
        id: GOAL_PLANNING_STAGE,
        kind: 'planning',
        title: 'Plan',
        config: {
          taskProfile: { roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 2 },
        },
      },
    ],
    edges: [],
  };
  const saved = await deps.lifecycle.saveDraftGraph({ templateId, graph, actorId: deps.actorId });
  if (!saved.ok) return saved;
  const published = await deps.lifecycle.publish({ templateId, actorId: deps.actorId });
  if (!published.ok) return published;
  return ok(templateId);
};

/* --------------------------------------------------------- command handlers --- */

const goalCreate = async (
  deps: ControlPlaneDeps,
  payload: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, DomainError>> => {
  const companyId = readString(payload, 'companyId', 64);
  if (!companyId.ok) return companyId;
  const scoped = proveCompany(deps, companyId.value);
  if (!scoped.ok) return scoped;
  const objective = readString(payload, 'objective', 2_000);
  if (!objective.ok) return objective;
  // The renderer's retry identity — a double click replays the SAME run (frozen
  // command-ledger rules), never a second goal.
  const commandId = readString(payload, 'commandId', 128);
  if (!commandId.ok) return commandId;
  /*
   * Final Readiness Gate — the goal's optional STRUCTURED constraints (scope,
   * parameters, resource lists, output requirements): the human requester's
   * machine-readable input for the whole run. Pass-through ONLY: the canonical
   * run-goal validation (bounded canonical bytes, unsafe text) remains the single
   * authority at attach time — this surface never validates or completes it, and a
   * model never authors it.
   */
  const rawStructured = payload['structured'];
  if (rawStructured !== undefined && (typeof rawStructured !== 'object' || rawStructured === null || Array.isArray(rawStructured))) {
    return err(
      domainError('VALIDATION_FAILED', 'The goal structured constraints must be a JSON object.', {
        reason: 'CONTROL_PLANE_GOAL_STRUCTURED_INVALID',
      }),
    );
  }
  const goalStructured = (rawStructured ?? undefined) as Readonly<Record<string, unknown>> | undefined;
  try { fileDeliveriesOf(goalStructured); }
  catch (error) { return err(error instanceof DomainError ? error : domainError('INVALID_ARGUMENT', 'The file delivery requirements are invalid.')); }

  /*
   * STAGE 4 — the user-selected ACCESS POLICY. The canonical owner is the GOAL itself:
   * the policy is bound into the run-goal artifact's structured payload (durable truth,
   * read back through goal.workspace) and the executor's kernel enforces it via its own
   * fs-sandbox (READ_ONLY => kernel read-only mode — below the renderer). The closed set
   * fails closed on anything else; an absent policy means the canonical default
   * ASK_PERMISSION (ordinary work proceeds, high-risk stops at the approval boundary).
   */
  const rawAccessPolicy = payload['accessPolicy'];
  if (rawAccessPolicy !== undefined && !(ACCESS_POLICIES as readonly string[]).includes(String(rawAccessPolicy))) {
    return err(
      domainError('VALIDATION_FAILED', `Unknown access policy "${String(rawAccessPolicy)}".`, {
        reason: 'CONTROL_PLANE_ACCESS_POLICY_INVALID',
        allowed: ACCESS_POLICIES,
      }),
    );
  }
  const accessPolicy = (rawAccessPolicy ?? 'ASK_PERMISSION') as AccessPolicy;
  /*
   * F4 closure — the DURABLE GOAL WORKSPACE BINDING. The binding source is the MAIN
   * process's canonical active workspace at creation time (never a renderer value — the
   * payload carries no workspace field and any such field is ignored). The binding rides
   * the run-goal structured payload (the SAME durable truth as the access policy), so
   * every later execution/validation of this Goal resolves Goal → binding, never
   * "whatever is open right now": a workspace switch never re-targets an existing Goal.
   */
  const boundWorkspace = deps.currentWorkspace();
  if (boundWorkspace === null) {
    return err(
      domainError('VALIDATION_FAILED', 'No workspace is open; a Goal cannot be created without a durable workspace binding.', {
        reason: 'GOAL_WORKSPACE_NOT_OPEN',
      }),
    );
  }
  // Pass-through purity: bind the policy into the structured payload ONLY when the user
  // selected one. An absent selection behaves as the canonical ASK_PERMISSION default at
  // both read-back (goal.workspace normalizes) and the kernel (absent ⇒ workspace-write),
  // so the run-goal structured payload stays byte-exact otherwise.
  const goalStructuredWithPolicy: Readonly<Record<string, unknown>> = {
    ...(goalStructured ?? {}),
    ...(rawAccessPolicy === undefined ? {} : { accessPolicy }),
    workspaceId: boundWorkspace.workspaceId,
  };

  const template = await ensurePlanningWorkflow(deps);
  if (!template.ok) return template;

  // The company's CURRENT canonical model selection becomes the run's bindings (the
  // supervisor and the planner both resolve their binding from the run snapshot).
  // No selection => fail closed: the product needs a model, and guessing one would
  // be an invisible authority decision.
  const modelKey = deps.selection === undefined ? null : await deps.selection.resolveCompanyModel(deps.companyId);
  if (modelKey === null) {
    return err(
      domainError(
        'MODEL_SELECTION_REQUIRED',
        'No model is selected for this company; register a model and set the selection policy before creating a goal.',
        { reason: 'CONTROL_PLANE_MODEL_UNSELECTED', companyId: deps.companyId },
      ),
    );
  }

  const created = await deps.lifecycle.createRun({
    templateId: template.value,
    companyId: deps.companyId,
    workflowId: GOAL_PLANNING_WORKFLOW_ID,
    actorId: deps.actorId,
    commandId: `goal-create:${commandId.value}`,
    modelBindings: { planner: modelKey, supervisor: modelKey },
    goal: { objective: objective.value, source: { type: 'human' }, structured: goalStructuredWithPolicy },
  });
  if (!created.ok) return created;
  try { await deps.initializeGoalBudget?.(String(created.value.run.id)); }
  catch (error) { return err(error instanceof DomainError ? error : domainError('PERSISTENCE_FAILED', 'Goal budget initialization failed.')); }
  return ok({
    runId: created.value.run.id,
    goal: { objective: objective.value, source: { type: 'human' } },
    workflowId: GOAL_PLANNING_WORKFLOW_ID,
  });
};

/**
 * Settle the Goal Run FAILED through the EXISTING engine seam (LIVE-SMOKE-FIX-06
 * P1-2 / LIVE-SMOKE-FIX-07 P1-2). Shared by the planning-terminality and the
 * execution-terminality paths so "driver says terminal failure while the durable
 * Goal Run says EXECUTING" can never persist:
 *  - a deterministic command id makes the settlement idempotent — a crash between
 *    the terminal fact and this dispatch converges on the next goal.advance replay;
 *  - a run already terminal (FAILED/COMPLETED/CANCELLED) is a no-op (success loops,
 *    never double-settles);
 *  - only NON-RECOVERABLE terminal failure reaches here; recoverable states (task
 *    retry, corrective, reassessment, recovery — the run stays non-terminal while
 *    any of them is pending) never call this helper;
 *  - the exclusive owner of the failure FACT remains the engine; this is only the
 *    parent-run projection of that fact through the existing run state machine.
 */
const settleGoalRunFailed = async (
  deps: ControlPlaneDeps,
  goalRunId: string,
  commandId: string,
  cause: string,
): Promise<Result<true, DomainError>> => {
  const goalRun = await deps.runs.get(goalRunId);
  if (goalRun === null) return ok(true);
  if (goalRun.state === 'FAILED' || goalRun.state === 'COMPLETED' || goalRun.state === 'CANCELLED') return ok(true);
  const settledRun = await deps.engine.dispatch({
    commandId,
    runId: goalRunId,
    type: 'EXECUTION.FAIL',
    expectedRevision: Number(goalRun.revision),
    actorId: deps.actorId,
    traceId: deps.ids.id('trace'),
    issuedAt: deps.clock.nowIso(),
    reason: cause.slice(0, 300),
  });
  if (!settledRun.ok) {
    return err(
      domainError(
        'PERSISTENCE_FAILED',
        `The terminal failure could not settle the goal run: ${settledRun.error.message}`,
        {
          reason: 'CONTROL_PLANE_GOAL_RUN_SETTLEMENT_FAILED',
          runId: goalRunId,
          settlementError: {code: settledRun.error.code, message: settledRun.error.message.slice(0, 300)},
        },
      ),
    );
  }
  return ok(true);
};

/**
 * FIX-07: settle (if needed) the parent Goal Run FAILED when the EXECUTION run is
 * observed in the engine terminal FAILED state — checked at every seam the goal
 * pipeline can observe it (engine drive, supervisor turn, replayed advance).
 * Returns null when no settlement applies (the run is not terminal FAILED yet, or
 * the goal run is already terminal), else the settlement result.
 */
const settleGoalRunFailedIfExecutionFailed = async (
  deps: ControlPlaneDeps,
  goalRunId: string,
  executionRunId: string,
): Promise<Result<true, DomainError> | null> => {
  const executionRun = await deps.runs.get(executionRunId);
  if (executionRun === null || executionRun.state !== 'FAILED') return null;
  return settleGoalRunFailed(
    deps,
    goalRunId,
    `goal-execution-failed:${goalRunId}`,
    'terminal execution failure: the execution run reached the engine terminal FAILED state',
  );
};

/**
 * LIVE-SMOKE-FIX-09 — SUCCESSFUL_GOAL_RUN_TERMINALITY: settle the parent Goal Run to
 * engine-terminal COMPLETED when the canonical success contract is satisfied, through
 * the SAME engine seam the failure settlements use. The contract (repository
 * semantics, no invented conditions):
 *   1. the child Execution Run is engine-terminal COMPLETED — the L1 machine can only
 *      reach COMPLETED through its own evidence-gated chain (REVIEW → evidence-proven
 *      VALIDATION.PASS → DELIVERY.COMPLETE), so this ONE fact canonically proves the
 *      goal's validation and delivery semantics;
 *   2. every work task of the execution run is terminal-successful (DONE/SKIPPED/
 *      CANCELLED — the same predicate the autonomy driver's isGoalCompleted uses);
 *   3. the goal's own planning task is terminal (DONE — the plan compiled and the
 *      execution run exists, so this holds by construction; checked, never assumed).
 * Anything less (validation pending, corrective/reassessment work open, tasks open)
 * keeps the run non-terminal — the child cannot be COMPLETED in those states through
 * the engine, and conditions 2/3 re-verify it from durable truth anyway. Idempotent:
 * a deterministic command id replays through the ledger; an already-terminal goal run
 * is a no-op (no resurrection, ever).
 */
const TERMINAL_SUCCESSFUL_TASK_STATES = ['DONE', 'SKIPPED', 'CANCELLED'] as const;

const settleGoalRunSucceededIfExecutionCompleted = async (
  deps: ControlPlaneDeps,
  goalRunId: string,
  executionRunId: string,
): Promise<Result<true, DomainError> | null> => {
  if (executionRunId === '') return null;
  const goalRun = await deps.runs.get(goalRunId);
  if (goalRun === null) return null;
  if (goalRun.state === 'COMPLETED' || goalRun.state === 'FAILED' || goalRun.state === 'CANCELLED') return null;
  const executionRun = await deps.runs.get(executionRunId);
  if (executionRun === null || executionRun.state !== 'COMPLETED') return null;
  const workTasks = await deps.tasks.listByRun(executionRunId);
  const businessTasks = workTasks.filter((task) => String(task.id) !== '');
  if (businessTasks.length > 0 && !businessTasks.every((task) => (TERMINAL_SUCCESSFUL_TASK_STATES as readonly string[]).includes(String(task.state)))) {
    return null;
  }
  const planningTasks = await deps.tasks.listByRun(goalRunId);
  if (!planningTasks.every((task) => (TERMINAL_SUCCESSFUL_TASK_STATES as readonly string[]).includes(String(task.state)))) {
    return null;
  }
  const settledRun = await deps.engine.dispatch({
    commandId: `goal-execution-completed:${goalRunId}`,
    runId: goalRunId,
    type: 'GOAL.OUTCOME.DELIVER',
    expectedRevision: Number(goalRun.revision),
    actorId: deps.actorId,
    traceId: deps.ids.id('trace'),
    issuedAt: deps.clock.nowIso(),
    reason: `goal outcome delivered: execution run ${executionRunId} reached engine-terminal COMPLETED (evidence-gated validation and delivery proven on the child)`,
    payload: {childExecutionRunId: executionRunId},
  });
  if (!settledRun.ok) {
    return err(
      domainError(
        'PERSISTENCE_FAILED',
        `The successful goal outcome could not settle the goal run: ${settledRun.error.message}`,
        {
          reason: 'CONTROL_PLANE_GOAL_RUN_SUCCESS_SETTLEMENT_FAILED',
          runId: goalRunId,
          settlementError: {code: settledRun.error.code, message: settledRun.error.message.slice(0, 300)},
        },
      ),
    );
  }
  return ok(true);
};

const goalAdvance = async (
  deps: ControlPlaneDeps,
  payload: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, DomainError>> => {
  const companyId = readString(payload, 'companyId', 64);
  if (!companyId.ok) return companyId;
  const scoped = proveCompany(deps, companyId.value);
  if (!scoped.ok) return scoped;
  const runId = readString(payload, 'runId', 128);
  if (!runId.ok) return runId;
  const owned = await loadOwnedRun(deps, deps.companyId, runId.value);
  if (!owned.ok) return owned;
  if (await deps.isGoalCancelled?.(runId.value)) {
    return err(domainError('CANCELLED', 'The Goal has a durable cancellation intent; no new work may start.'));
  }

  const steps: string[] = [];

  /* ---- step 1: the planning turn (idempotent by deterministic planning command id) --- */
  const planningTaskId = `goal-plan:${runId.value}`;
  if (deps.planner === null || deps.materializer === null) {
    return err(
      domainError('PERSISTENCE_FAILED', 'The planning pipeline is not wired in this composition.', {
        reason: 'CONTROL_PLANE_PIPELINE_UNAVAILABLE',
      }),
    );
  }
  const driven = await deps.engine.drive(runId.value, { maxSteps: 4 });
  if (!driven.ok) return driven;

  const materialized = await deps.materializer.materialize({
    companyId: deps.companyId,
    runId: runId.value,
    stageId: GOAL_PLANNING_STAGE,
  });
  if (!materialized.ok) return materialized;
  const planned = await deps.planner.runPlanningTurn({
    companyId: deps.companyId,
    runId: runId.value,
    taskId: materialized.value.taskId,
    planningCommandId: planningTaskId,
    actorId: deps.actorId,
  });
  if (!planned.ok) {
    /*
     * PLANNING_FAILURE_RUN_TERMINALITY (LIVE-SMOKE-FIX-06 P1-2): a TERMINAL planning
     * failure (the planning task itself FAILED and no canonical plan exists) must
     * settle the Goal Run through the EXISTING engine seam — the run may never be
     * left durably EXECUTING while the goal is dead. The settlement is idempotent:
     * a deterministic command id replays or no-ops (the engine refuses terminal-run
     * transitions), so a crash between the task FAIL and this dispatch converges on
     * the next goal.advance replay. Non-terminal planning errors (the task still
     * open — e.g. a cancelled-between-attempts turn) return unchanged: the run
     * stays owned by its live lifecycle, never force-failed.
     */
    const planningTasks = await deps.tasks.listByRun(runId.value);
    const planningTask = planningTasks.find((task) => String(task.id) === String(materialized.value.taskId));
    if (planningTask !== undefined && planningTask.state === 'FAILED') {
      const settled = await settleGoalRunFailed(
        deps,
        runId.value,
        `goal-plan-failed:${String(runId.value)}`,
        planned.error.message,
      );
      if (!settled.ok) return settled;
    }
    return planned;
  }
  steps.push(planned.value.replayed ? 'planned(replay)' : 'planned');
  if (deps.executionAvailable !== undefined && !deps.executionAvailable()) {
    return err(domainError('POLICY_DENIED', 'The plan is ready; no executor is available for its work, so nothing is compiled or dispatched.', {
      reason: 'EXECUTOR_PROVIDER_UNKNOWN', planId: planned.value.planId, planReady: true, retryable: false,
    }));
  }

  /* ---- step 2: derive the COMPLETE explicit per-item spec (trusted, deterministic) --- */
  const planArtifact = await deps.artifacts.getByCreationCommand(`plan:${planned.value.planId}`);
  if (planArtifact === null) {
    return err(
      domainError('NOT_FOUND', `The plan artifact of run "${runId.value}" is not readable.`, {
        reason: 'CONTROL_PLANE_PLAN_ARTIFACT_NOT_FOUND',
      }),
    );
  }
  const content = await deps.artifacts.readContent(planArtifact.artifact.contentRef);
  if (content === null) {
    return err(
      domainError('PERSISTENCE_FAILED', 'The plan artifact content could not be read from the content store.', {
        reason: 'CONTROL_PLANE_PLAN_CONTENT_UNAVAILABLE',
      }),
    );
  }
  let planPayload: {
    readonly acceptanceCriteria?: readonly { readonly criterionId?: unknown }[];
    readonly planItems?: readonly {
      readonly planItemId?: unknown;
      readonly taskKind?: unknown;
      readonly objective?: unknown;
      readonly professionalResponsibility?: unknown;
      readonly acceptanceCriterionRefs?: readonly string[];
    }[];
  };
  try {
    planPayload = JSON.parse(new TextDecoder().decode(content)) as typeof planPayload;
  } catch {
    return err(
      domainError('VALIDATION_FAILED', 'The plan artifact payload is not valid JSON.', {
        reason: 'CONTROL_PLANE_PLAN_PAYLOAD_INVALID',
      }),
    );
  }
  const itemIds: string[] = [];
  const canonicalGoal = deps.runGoal === null ? null : await deps.runGoal.get({ runId: runId.value, companyId: deps.companyId });
  if (canonicalGoal === null || !canonicalGoal.ok) return err(domainError('PERSISTENCE_FAILED', 'The canonical Goal contract is unavailable.'));
  for (const requirement of fileDeliveriesOf(canonicalGoal.value.structured)) {
    const present = planPayload.acceptanceCriteria?.some((item) => item.criterionId === requirement.criterionId);
    const assigned = planPayload.planItems?.some((item) => item.acceptanceCriterionRefs?.includes(requirement.criterionId));
    if (!present || !assigned) return err(domainError('VALIDATION_FAILED', 'The plan omitted a required file delivery criterion.', { reason: 'FILE_DELIVERY_PLAN_COVERAGE_MISSING', criterionId: requirement.criterionId }));
  }
  for (const item of planPayload.planItems ?? []) {
    if (typeof item?.planItemId !== 'string') {
      return err(
        domainError('VALIDATION_FAILED', 'The plan artifact contains an item without a planItemId.', {
          reason: 'CONTROL_PLANE_PLAN_PAYLOAD_INVALID',
        }),
      );
    }
    itemIds.push(item.planItemId);
  }
  // The V1 trusted derivation: EVERY item gets the deployment's generic work profile.
  // Explicit and complete by construction; never derived from model text.
  const planItemProfiles: Record<string, unknown> = {};
  const allowedKinds = new Set<string>([
    deps.workProfile.taskKind,
    ...(deps.workProfile.operationKinds ?? []),
  ]);
  for (const item of planPayload.planItems ?? []) {
    const requested = typeof item.taskKind === 'string' ? item.taskKind : undefined;
    if (requested !== undefined && !allowedKinds.has(requested)) {
      return err(
        domainError('VALIDATION_FAILED', `The plan item "${String(item.planItemId)}" requests task kind "${String(requested)}" which the deployment does not declare.`, {
          reason: 'CONTROL_PLANE_TASK_KIND_UNKNOWN',
          taskKind: String(requested),
        }),
      );
    }
  }
  const itemKindOf = (itemId: string): string => {
    const found = (planPayload.planItems ?? []).find((entry) => entry.planItemId === itemId);
    return typeof found?.taskKind === 'string' ? found.taskKind : deps.workProfile.taskKind;
  };
  /*
   * STAGE 8C — the professional-seat derivation (Boss §1-§6): every plan item's
   * responsibility (declared by the plan when present, else derived from the
   * item's own semantics) resolves through the deterministic Stage 7 RoleResolver
   * into the seat pinned into the task profile. The user never chooses roles;
   * there is NO unconditional generic worker seat; the team is exactly as large
   * as the plan's responsibilities.
   */
  const itemObjectiveOf = (itemId: string): string => {
    const found = (planPayload.planItems ?? []).find((entry) => entry.planItemId === itemId);
    return typeof found?.objective === 'string' && found.objective.trim() !== '' ? found.objective : `Execute work item ${itemId}.`;
  };
  const declaredResponsibilityOf = (itemId: string): {
    readonly responsibilityIntent: string;
    readonly requiredCapabilities?: readonly string[];
    readonly independenceRequired?: boolean;
    readonly riskLevel?: 'low' | 'medium' | 'high';
  } | undefined => {
    const found = (planPayload.planItems ?? []).find((entry) => entry.planItemId === itemId);
    const declared = found?.professionalResponsibility;
    if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) return undefined;
    const record = declared as Record<string, unknown>;
    const intent = record['responsibilityIntent'];
    if (typeof intent !== 'string' || intent.trim() === '') return undefined;
    const capabilities = record['requiredCapabilities'];
    const independence = record['independenceRequired'];
    const risk = record['riskLevel'];
    return {
      responsibilityIntent: intent,
      ...(Array.isArray(capabilities) && capabilities.every((entry): entry is string => typeof entry === 'string')
        ? { requiredCapabilities: [...new Set(capabilities.map((entry) => entry.trim()))].sort() }
        : {}),
      ...(typeof independence === 'boolean' ? { independenceRequired: independence } : {}),
      ...(risk === 'low' || risk === 'medium' || risk === 'high' ? { riskLevel: risk } : {}),
    };
  };
  for (const itemId of itemIds) {
    const taskKind = itemKindOf(itemId);
    const declared = declaredResponsibilityOf(itemId);
    /*
     * Independence is a DECLARED property (Stage 8C): the plan states it, or the
     * deployment's review/validation classification applies. A non-baseline operation
     * kind (e.g. the BB2 software kind — an IMPLEMENTATION kind) must not silently
     * presume independence; that presumption would mis-seat implementation work as
     * independent review.
     */
    const independenceRequired = declared?.independenceRequired ?? false;
    const requirement = {
      responsibilityIntent: declared?.responsibilityIntent ?? itemObjectiveOf(itemId),
      ...(declared?.requiredCapabilities === undefined ? {} : { requiredCapabilities: declared.requiredCapabilities }),
      independenceRequired,
      riskLevel: declared?.riskLevel ?? 'low',
    } as const;
    if (deps.professionalSeatOf === undefined) {
      return err(
        domainError('PERSISTENCE_FAILED', 'The professional-seat resolver is not wired; the goal pipeline refuses to flatten work onto a generic seat.', {
          reason: 'CONTROL_PLANE_ROLE_RESOLVER_UNAVAILABLE',
        }),
      );
    }
    const seat = deps.professionalSeatOf(requirement);
    planItemProfiles[itemId] = {
      stageKind: deps.workProfile.stageKind,
      taskProfile: {
        roleId: seat.seatId,
        taskKind,
        maxAttempts: deps.workProfile.maxAttempts,
      },
      /*
       * BB2 final forensic closure — validator selection through the ONE deterministic
       * owner (WorkProfile → validatorIds): a plan item that declares a kind the
       * deployment bound a per-kind policy for carries THAT validator set (the
       * specialized software authority with grounding kept additive); every other item
       * keeps the deployment's baseline set unchanged.
       */
      validatorIds: validatorIdsForTaskKind(deps.workProfile, taskKind),
      professionalResponsibility: requirement,
    };
  }

  /* ---- step 3: the deterministic compile (idempotent by compilation command id) --- */
  if (deps.compiler === null) {
    return err(
      domainError('PERSISTENCE_FAILED', 'The plan compiler is not wired in this composition.', {
        reason: 'CONTROL_PLANE_PIPELINE_UNAVAILABLE',
      }),
    );
  }
  // The execution run pins the company's CURRENT canonical selection (the same
  // resolution goal.create used). A replay under a different selection CONFLICTS at
  // the compile anchor — honest fail-closed, never a silent re-pin.
  const modelKey = deps.selection === undefined ? null : await deps.selection.resolveCompanyModel(deps.companyId);
  if (modelKey === null) {
    return err(
      domainError('MODEL_SELECTION_REQUIRED', 'No model is selected for this company; the execution run cannot be compiled.', {
        reason: 'CONTROL_PLANE_MODEL_UNSELECTED',
        runId: runId.value,
      }),
    );
  }
  const executionBindings: Readonly<Record<string, string>> = { planner: modelKey, supervisor: modelKey };
  const compilationCommandId = `goal-compile:${planned.value.planId}`;
  if (await deps.isGoalCancelled?.(runId.value)) return err(domainError('CANCELLED', 'Goal cancellation refuses plan compilation.'));
  const compiled = await deps.compiler.compile(
    {
      companyId: deps.companyId,
      planningRunId: runId.value,
      planArtifactId: planned.value.artifactId,
      compilationCommandId,
      actorId: deps.actorId,
      executionBindings,
    },
    { planItemProfiles },
  );
  if (!compiled.ok) return compiled;
  steps.push('compiled');

  /* ---- step 4: ONE bounded supervisor turn on the execution run (canonical authority) --- */
  if (deps.supervisor === null) {
    return err(
      domainError('PERSISTENCE_FAILED', 'The autonomous supervisor is not wired in this composition.', {
        reason: 'CONTROL_PLANE_PIPELINE_UNAVAILABLE',
      }),
    );
  }
  const executionRunId = compiled.value.executionRunId;
  const executionRun = await loadOwnedRun(deps, deps.companyId, executionRunId);
  if (!executionRun.ok) return executionRun;
  // The compiled run starts through the ENGINE's own driver (IDLE → … → EXECUTING);
  // the supervisor supervises a running run, it never starts one.
  const executionDriven = await deps.engine.drive(executionRunId, { maxSteps: 4 });
  if (!executionDriven.ok) {
    // The drive itself refused on a TERMINAL FAILED run: project the parent Goal Run
    // to its canonical terminal failure before returning (never leave it EXECUTING).
    const failedRun = await deps.runs.get(executionRunId);
    if (failedRun !== null && failedRun.state === 'FAILED') {
      const settled = await settleGoalRunFailed(
        deps,
        runId.value,
        `goal-execution-failed:${String(runId.value)}`,
        `terminal execution failure: ${executionDriven.error.message}`,
      );
      if (!settled.ok) return settled;
    }
    return executionDriven;
  }
  /*
   * LIVE-SMOKE-FIX-09 seam A: an already-COMPLETED execution run (a replayed advance
   * after full success) converges the goal run BEFORE the supervisor turn — the
   * driver/canonical agreement holds even when no further turns fire.
   */
  const succeededEarly = await settleGoalRunSucceededIfExecutionCompleted(deps, runId.value, executionRunId);
  if (succeededEarly !== null && !succeededEarly.ok) return succeededEarly;
  if (executionDriven.value.run.state === 'FAILED') {
    /*
     * EXECUTION_FAILURE_GOAL_RUN_TERMINALITY (LIVE-SMOKE-FIX-07 P1-2): the engine
     * settled the execution run FAILED (documented: Smoke-06's 'tests' attempt —
     * a genuine STRONG-floor rejection pre-fix) while the parent Goal Run stayed
     * durably EXECUTING under a NON_RECOVERABLE driver verdict. Reaching run
     * terminal FAILED is by definition non-recoverable in the existing lifecycle
     * (corrective/reassessment/retry/recovery keep a run non-terminal while
     * pending), so the parent Goal Run settles FAILED through the SAME idempotent
     * seam used for planning failure (settled in the SAME advance the failure
     * happened — a crash converges on the next replay). This is failure projection
     * ONLY: a COMPLETED execution run does NOT settle the goal run successful here
     * — Goal success still waits for its own downstream validation/handoff/outcome.
     */
    const settled = await settleGoalRunFailed(
      deps,
      runId.value,
      `goal-execution-failed:${String(runId.value)}`,
      'terminal execution failure: the execution run reached the engine terminal FAILED state',
    );
    if (!settled.ok) return settled;
    steps.push('goal-settled-execution-failed');
    const terminalTasks = await deps.tasks.listByRun(executionRunId);
    return ok({
      runId: runId.value,
      executionRunId,
      planId: planned.value.planId,
      versionId: compiled.value.versionId,
      steps,
      supervisorOutcome: 'execution-run-terminal-failed',
      tasks: terminalTasks.map((task) => ({id: task.id, state: task.state})),
    });
  }
  // The supervisor's first-turn subject: the FIRST non-terminal task of the execution
  // run in the compiled graph's deterministic materialization order.
  const executionTasks = await deps.tasks.listByRun(executionRunId);
  // The supervisor's first-turn subject: the run's BUSINESS subject — the task the run is
  // delivering — under the frozen canonical rule (corrective generation, then earliest
  // createdAt, then id), the same derivation every review/validation seat uses. Reading it
  // from row order instead arbitrated two same-millisecond tasks by ULID, so the turn could
  // name the instrumental gate task while the report it must cite concerned the business
  // task (STAGE 9B-FIX root cause). A composition without the seam keeps the row-order
  // fallback; a graph with no business task has no subject to name.
  const semanticSubjectId =
    deps.businessSubjectOf === undefined ? null : await deps.businessSubjectOf(executionRunId);
  const named =
    semanticSubjectId === null
      ? undefined
      : executionTasks.find((task) => String(task.id) === semanticSubjectId);
  const subject =
    named ??
    executionTasks.find(
      (task) => task.state !== 'DONE' && task.state !== 'SKIPPED' && task.state !== 'CANCELLED' && task.state !== 'FAILED',
    );
  if (subject === undefined) {
    return ok({
      runId: runId.value,
      executionRunId,
      planId: compiled.value.planId,
      versionId: compiled.value.versionId,
      steps,
      supervisorOutcome: 'already-terminal',
    });
  }
  if (await deps.isGoalCancelled?.(runId.value)) return err(domainError('CANCELLED', 'Goal cancellation refuses supervision.'));
  const turn = await deps.supervisor.run({
    companyId: deps.companyId,
    runId: executionRunId,
    taskId: subject.id,
    actorId: deps.actorId,
    runIdentity: `goal-run:${executionRunId}`,
    traceId: deps.ids.id('trace'),
  });
  /*
   * EXECUTION_FAILURE_GOAL_RUN_TERMINALITY (FIX-07 P1-2), turn seam: the supervisor
   * drives stages itself, so the execution run may reach terminal FAILED INSIDE the
   * turn (the Smoke-06 path). The parent Goal Run must settle FAILED in the SAME
   * advance — regardless of whether the turn returned ok or an error.
   */
  const executionFailedAfterTurn = await settleGoalRunFailedIfExecutionFailed(deps, runId.value, executionRunId);
  if (executionFailedAfterTurn !== null) {
    if (!executionFailedAfterTurn.ok) return executionFailedAfterTurn;
    steps.push('goal-settled-execution-failed');
    const terminalTasks = await deps.tasks.listByRun(executionRunId);
    return ok({
      runId: runId.value,
      executionRunId,
      planId: planned.value.planId,
      versionId: compiled.value.versionId,
      steps,
      supervisorOutcome: turn.ok ? turn.value.outcome : 'execution-run-terminal-failed',
      tasks: terminalTasks.map((task) => ({id: task.id, state: task.state})),
    });
  }
  /*
   * LIVE-SMOKE-FIX-09 seam B: the supervisor turn just ran on a live execution run;
   * if THIS turn or an earlier one drove it to engine-terminal COMPLETED, the goal
   * run converges in the SAME advance (success symmetry of the FIX-07 turn seam).
   */
  const succeededAfterTurn = await settleGoalRunSucceededIfExecutionCompleted(deps, runId.value, executionRunId);
  if (succeededAfterTurn !== null && !succeededAfterTurn.ok) return succeededAfterTurn;
  if (!turn.ok) return turn;
  steps.push('supervised');

  return ok({
    runId: runId.value,
    executionRunId,
    planId: compiled.value.planId,
    versionId: compiled.value.versionId,
    steps,
    supervisorOutcome: turn.value.outcome,
  });
};

const approvalRespond = async (
  deps: ControlPlaneDeps,
  payload: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, DomainError>> => {
  const companyId = readString(payload, 'companyId', 64);
  if (!companyId.ok) return companyId;
  const scoped = proveCompany(deps, companyId.value);
  if (!scoped.ok) return scoped;
  const runId = readString(payload, 'runId', 128);
  if (!runId.ok) return runId;
  const decision = readString(payload, 'decision', 16);
  if (!decision.ok) return decision;
  if (decision.value !== 'approve' && decision.value !== 'deny') {
    return err(invalid('The decision must be "approve" or "deny".', 'CONTROL_PLANE_DECISION_INVALID'));
  }
  const note = typeof payload['note'] === 'string' ? payload['note'].slice(0, 2_000) : undefined;
  const owned = await loadOwnedRun(deps, deps.companyId, runId.value);
  if (!owned.ok) return owned;

  if (deps.supervisor === null) {
    return err(
      domainError('PERSISTENCE_FAILED', 'The approval mechanism is not wired in this composition.', {
        reason: 'CONTROL_PLANE_APPROVAL_UNAVAILABLE',
      }),
    );
  }
  if (decision.value === 'approve') {
    // The canonical resume seam: ONE APPROVAL.GRANT through the engine, with the
    // decider identity supplied by the trusted caller.
    const resumed = await deps.supervisor.resumeEscalatedRun({
      companyId: deps.companyId,
      runId: runId.value,
      actorId: deps.actorId,
      ...(note === undefined ? {} : { note }),
    });
    if (!resumed.ok) return resumed;
    return ok({ runId: runId.value, decision: 'approve', resumed: resumed.value.resumed });
  }
  /*
   * Deny: the engine's own APPROVAL.DENY command. Revision-preconditioned so a
   * stale UI can never overwrite newer truth; the command id is deterministic per
   * (run, revision) so a double click REPLAYS instead of double-denying; and the
   * authority is supplied by the trusted caller exactly as the supervisor's own
   * resume seam and the engine's driver do — no new token is added to the catalog.
   */
  const denied = await deps.engine.dispatch({
    commandId: `control-plane-deny:${runId.value}:${String(owned.value.revision)}`,
    runId: runId.value,
    type: 'APPROVAL.DENY',
    expectedRevision: owned.value.revision,
    actorId: deps.actorId,
    traceId: deps.ids.id('trace'),
    issuedAt: deps.clock.nowIso(),
    reason: note ?? 'denied from the control plane',
    payload: { authorities: ['run.approve'] },
  });
  if (!denied.ok) return denied;
  return ok({ runId: runId.value, decision: 'deny', duplicate: denied.value.duplicate });
};

/* ------------------------------------------------------------ read handlers --- */

const homeSummary = async (
  deps: ControlPlaneDeps,
  payload: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, DomainError>> => {
  const companyId = readString(payload, 'companyId', 64);
  if (!companyId.ok) return companyId;
  const scoped = proveCompany(deps, companyId.value);
  if (!scoped.ok) return scoped;
  const page = await deps.runs.list({ limit: 100, offset: 0 });
  const goals = [];
  for (const run of page.items) {
    if (run.companyId !== deps.companyId || run.workflowId !== GOAL_PLANNING_WORKFLOW_ID) continue;
    const goal =
      deps.runGoal === null
        ? null
        : await deps.runGoal.get({ runId: run.id, companyId: deps.companyId });
    goals.push({
      runId: run.id,
      state: run.state,
      objective: goal !== null && goal.ok && goal.value !== null ? goal.value.objective : null,
      ...(run.createdAt === undefined ? {} : { createdAt: run.createdAt }),
    });
  }
  return ok({ companyId: deps.companyId, goals });
};

const goalWorkspace = async (
  deps: ControlPlaneDeps,
  payload: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, DomainError>> => {
  const companyId = readString(payload, 'companyId', 64);
  if (!companyId.ok) return companyId;
  const scoped = proveCompany(deps, companyId.value);
  if (!scoped.ok) return scoped;
  const runId = readString(payload, 'runId', 128);
  if (!runId.ok) return runId;
  const owned = await loadOwnedRun(deps, deps.companyId, runId.value);
  if (!owned.ok) return owned;
  if (deps.observation === null) {
    return err(
      domainError('PERSISTENCE_FAILED', 'The observation service is not wired in this composition.', {
        reason: 'CONTROL_PLANE_OBSERVATION_UNAVAILABLE',
      }),
    );
  }
  const goal = deps.runGoal === null ? null : await deps.runGoal.get({ runId: runId.value, companyId: deps.companyId });
  const overview = await deps.observation.getRunOverview({ companyId: deps.companyId, runId: runId.value });
  if (!overview.ok) return overview;
  const blockers = await deps.observation.getRunBlockers({ companyId: deps.companyId, runId: runId.value });
  if (!blockers.ok) return blockers;

  /*
   * Derived execution runs — derived, never stored: each durable plan-compilation
   * anchor's creation command embeds the planId, and the execution run's identity is
   * the frozen deterministic derivation from (company, planningRun, plan, compile
   * command), confirmed against the durable run row. No second truth exists.
   */
  const executionRuns: { runId: string; state: string }[] = [];
  const anchors = (await deps.artifacts.listByRun(runId.value)).filter(
    (artifact) => artifact.kind === 'companyos:plan-compilation',
  );
  for (const anchor of anchors) {
    const commandId = await deps.artifacts.commandIdOf(anchor.id);
    if (commandId === null) continue;
    const prefix = `plan-compile:${deps.companyId}:goal-compile:`;
    if (!commandId.startsWith(prefix)) continue;
    const planId = commandId.slice(prefix.length);
    const executionRunId = executionRunIdOf(deps.companyId, runId.value, planId, `goal-compile:${planId}`);
    const executionRun = await deps.runs.get(executionRunId);
    if (executionRun === null || executionRun.companyId !== deps.companyId) continue;
    executionRuns.push({ runId: executionRunId, state: executionRun.state });
  }
  const goalValue = goal !== null && goal.ok ? goal.value : null;
  const goalStructured = goalValue?.structured ?? null;
  const accessPolicyRaw = typeof goalStructured?.accessPolicy === 'string' ? String(goalStructured['accessPolicy']) : null;
  const accessPolicy =
    accessPolicyRaw !== null && (ACCESS_POLICIES as readonly string[]).includes(accessPolicyRaw)
      ? accessPolicyRaw
      : 'ASK_PERMISSION'; // canonical default for goals created before Stage 4
  return ok({
    runId: runId.value,
    accessPolicy,
    goal: goalValue,
    planningRun: { state: owned.value.state, revision: owned.value.revision },
    overview: overview.value,
    blockers: blockers.value,
    executionRuns,
  });
};

const runRead = async (
  deps: ControlPlaneDeps,
  payload: Readonly<Record<string, unknown>>,
  view: 'overview' | 'blockers' | 'timeline',
): Promise<Result<unknown, DomainError>> => {
  const companyId = readString(payload, 'companyId', 64);
  if (!companyId.ok) return companyId;
  const scoped = proveCompany(deps, companyId.value);
  if (!scoped.ok) return scoped;
  const runId = readString(payload, 'runId', 128);
  if (!runId.ok) return runId;
  const owned = await loadOwnedRun(deps, deps.companyId, runId.value);
  if (!owned.ok) return owned;
  if (deps.observation === null) {
    return err(
      domainError('PERSISTENCE_FAILED', 'The observation service is not wired in this composition.', {
        reason: 'CONTROL_PLANE_OBSERVATION_UNAVAILABLE',
      }),
    );
  }
  if (view === 'overview') {
    return deps.observation.getRunOverview({ companyId: deps.companyId, runId: runId.value });
  }
  if (view === 'blockers') {
    return deps.observation.getRunBlockers({ companyId: deps.companyId, runId: runId.value });
  }
  const cursor = payload['cursor'];
  const limit = typeof payload['limit'] === 'number' ? payload['limit'] : undefined;
  return deps.observation.getRunTimeline({
    companyId: deps.companyId,
    runId: runId.value,
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  });
};

const taskRead = async (
  deps: ControlPlaneDeps,
  payload: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, DomainError>> => {
  const companyId = readString(payload, 'companyId', 64);
  if (!companyId.ok) return companyId;
  const scoped = proveCompany(deps, companyId.value);
  if (!scoped.ok) return scoped;
  const taskId = readString(payload, 'taskId', 128);
  if (!taskId.ok) return taskId;
  if (deps.observation === null) {
    return err(
      domainError('PERSISTENCE_FAILED', 'The observation service is not wired in this composition.', {
        reason: 'CONTROL_PLANE_OBSERVATION_UNAVAILABLE',
      }),
    );
  }
  // Task ownership is proven INSIDE the observation read (company-scoped NOT_FOUND).
  return deps.observation.getTaskObservation({ companyId: deps.companyId, taskId: taskId.value });
};

const runArtifacts = async (
  deps: ControlPlaneDeps,
  payload: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, DomainError>> => {
  const companyId = readString(payload, 'companyId', 64);
  if (!companyId.ok) return companyId;
  const scoped = proveCompany(deps, companyId.value);
  if (!scoped.ok) return scoped;
  const runId = readString(payload, 'runId', 128);
  if (!runId.ok) return runId;
  const owned = await loadOwnedRun(deps, deps.companyId, runId.value);
  if (!owned.ok) return owned;
  const artifacts = await deps.artifacts.listByRun(runId.value);
  // Canonical REFERENCES + safe metadata only — never a copy of artifact truth.
  return ok({
    runId: runId.value,
    artifacts: artifacts.map((artifact) => ({
      artifactId: artifact.id,
      kind: artifact.kind,
      ...(artifact.createdAt === undefined ? {} : { createdAt: artifact.createdAt }),
    })),
  });
};

const decisionsPending = async (
  deps: ControlPlaneDeps,
  payload: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, DomainError>> => {
  const companyId = readString(payload, 'companyId', 64);
  if (!companyId.ok) return companyId;
  const scoped = proveCompany(deps, companyId.value);
  if (!scoped.ok) return scoped;
  if (deps.observation === null) {
    return err(
      domainError('PERSISTENCE_FAILED', 'The observation service is not wired in this composition.', {
        reason: 'CONTROL_PLANE_OBSERVATION_UNAVAILABLE',
      }),
    );
  }
  // Aggregate the CANONICAL blockers of every non-terminal run of the active
  // company. There is deliberately no ui_pending_decisions truth (§14).
  const page = await deps.runs.list({ limit: 100, offset: 0 });
  const pending: unknown[] = [];
  for (const run of page.items) {
    if (run.companyId !== deps.companyId) continue;
    if (run.state === 'COMPLETED' || run.state === 'FAILED' || run.state === 'CANCELLED') continue;
    const blockers = await deps.observation.getRunBlockers({ companyId: deps.companyId, runId: run.id });
    if (!blockers.ok) continue; // a run whose blockers cannot be read is not a decision
    // STAGE 3: the canonical approval rows behind an APPROVAL_REQUIRED blocker, so the
    // approval card can show the real reason and risk without inventing anything. Absent
    // (unwired store) simply yields `approvals: []` — the blocker is still canonical.
    const approvals =
      deps.approvals === undefined ? [] : await deps.approvals.listByRun(run.id).catch(() => []);
    pending.push({ runId: run.id, runState: run.state, blockers: blockers.value, approvals });
  }
  return ok({ companyId: deps.companyId, pending });
};

/**
 * STAGE 3 — the Goal usage projection (E1 semantics: KNOWN / ESTIMATED / UNKNOWN,
 * missing ≠ zero). Read-only: it reads durable usage truth through the composition and
 * reports coverage honestly instead of a false total.
 */
const runUsage = async (
  deps: ControlPlaneDeps,
  payload: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, DomainError>> => {
  const companyId = readString(payload, 'companyId', 64);
  if (!companyId.ok) return companyId;
  const scoped = proveCompany(deps, companyId.value);
  if (!scoped.ok) return scoped;
  const runId = readString(payload, 'runId', 128);
  if (!runId.ok) return runId;
  const owned = await loadOwnedRun(deps, deps.companyId, runId.value);
  if (!owned.ok) return owned;
  if (deps.goalUsage === undefined) {
    return err(
      domainError('PERSISTENCE_FAILED', 'The usage projection is not wired in this composition.', {
        reason: 'CONTROL_PLANE_USAGE_UNAVAILABLE',
      }),
    );
  }
  return deps.goalUsage.usageOf({ companyId: deps.companyId, runId: runId.value });
};

/**
 * H11 — `run.budget`: the boss's read-only view of one Goal's spend (KNOWN settled,
 * UNKNOWN at its bound, held in-flight, worst-case remaining) plus the plan the planner
 * produced, when one exists (plan-only preview shows it while execution is refused).
 * Pure read: no admission, no dispatch, no repair.
 */
const runBudget = async (
  deps: ControlPlaneDeps,
  payload: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, DomainError>> => {
  const companyId = readString(payload, 'companyId', 64);
  if (!companyId.ok) return companyId;
  const scoped = proveCompany(deps, companyId.value);
  if (!scoped.ok) return scoped;
  const runId = readString(payload, 'runId', 128);
  if (!runId.ok) return runId;
  const owned = await loadOwnedRun(deps, deps.companyId, runId.value);
  if (!owned.ok) return owned;
  if (deps.goalBudget === undefined) {
    return err(domainError('PERSISTENCE_FAILED', 'The budget projection is not wired in this composition.', { reason: 'CONTROL_PLANE_BUDGET_UNAVAILABLE' }));
  }
  let budget: GoalExecutionBudget | null;
  try { budget = await deps.goalBudget.read(runId.value); }
  catch (error) {
    if (error instanceof DomainError) return err(error);
    return err(domainError('PERSISTENCE_FAILED', 'The budget facts could not be read.', { reason: 'GOAL_BUDGET_READ_FAILED' }));
  }
  const projection = projectGoalBudget(runId.value, budget, { nowMs: deps.goalBudget.now(), currency: deps.goalBudget.currency });
  let plan: { readonly artifactId: string; readonly items: readonly { readonly planItemId: string; readonly objective: string; readonly taskKind: string | null }[]; readonly criteria: readonly { readonly criterionId: string; readonly requirement: string }[] } | null = null;
  const planRow = (await deps.artifacts.listByRun(runId.value)).filter((row) => row.kind === 'companyos:plan').at(-1);
  if (planRow !== undefined) {
    const command = await deps.artifacts.commandIdOf(planRow.id);
    const located = command === null ? null : await deps.artifacts.getByCreationCommand(command);
    const bytes = located === null ? null : await deps.artifacts.readContent(located.artifact.contentRef);
    if (bytes !== null) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        const items = Array.isArray(parsed['planItems']) ? (parsed['planItems'] as Record<string, unknown>[]) : [];
        const criteria = Array.isArray(parsed['acceptanceCriteria']) ? (parsed['acceptanceCriteria'] as Record<string, unknown>[]) : [];
        plan = {
          artifactId: planRow.id,
          items: items.map((item) => ({ planItemId: String(item['planItemId'] ?? ''), objective: String(item['objective'] ?? '').slice(0, 2000), taskKind: typeof item['taskKind'] === 'string' ? item['taskKind'] : null })),
          criteria: criteria.map((c) => ({ criterionId: String(c['criterionId'] ?? ''), requirement: String(c['requirement'] ?? '').slice(0, 2000) })),
        };
      } catch { plan = null; }
    }
  }
  return ok({ budget: projection, plan });
};

/* ------------------------------------------------------------- the service --- */

export function createControlPlaneService(deps: ControlPlaneDeps): {
  handle(request: unknown): Promise<ControlPlaneEnvelope<unknown>>;
} {
  return {
    async handle(request: unknown): Promise<ControlPlaneEnvelope<unknown>> {
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'The control-plane request must be an object.' } };
      }
      const record = request as { readonly operation?: unknown; readonly payload?: unknown };
      if (typeof record.operation !== 'string') {
        return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'The control-plane request must name an operation.' } };
      }
      if (!(CONTROL_PLANE_OPERATIONS as readonly string[]).includes(record.operation)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_ARGUMENT',
            message: `Unknown control-plane operation "${record.operation}".`,
            details: { reason: 'CONTROL_PLANE_OPERATION_UNKNOWN' },
          },
        };
      }
      const payloadResult = readObject(record.payload ?? {});
      if (!payloadResult.ok) {
        return { ok: false, error: { code: payloadResult.error.code, message: payloadResult.error.message } };
      }
      const operation = record.operation as ControlPlaneOperation;
      let outcome: Result<unknown, DomainError>;
      switch (operation) {
        case 'goal.create':
          outcome = await goalCreate(deps, payloadResult.value);
          break;
        case 'goal.advance':
          outcome = await goalAdvance(deps, payloadResult.value);
          break;
        case 'goal.cancel': {
          const claimedCompany = payloadResult.value['companyId'];
          if (claimedCompany !== undefined && claimedCompany !== deps.companyId) { outcome = err(domainError('POLICY_DENIED', 'Goal cancellation must remain within the current Company.')); break; }
          const runId = readString(payloadResult.value, 'runId', 200);
          if (!runId.ok) { outcome = runId; break; }
          const owned = await loadOwnedRun(deps, deps.companyId, runId.value);
          if (!owned.ok) { outcome = owned; break; }
          try { outcome = deps.cancelGoal === undefined ? err(domainError('NOT_IMPLEMENTED', 'Durable Goal cancellation is unavailable.')) : ok(await deps.cancelGoal(runId.value)); }
          catch (error) { outcome = err(error instanceof DomainError ? error : domainError('PERSISTENCE_FAILED', 'The cancellation intent could not be committed.')); }
          break;
        }
        case 'approval.respond':
          outcome = await approvalRespond(deps, payloadResult.value);
          break;
        case 'home.summary':
          outcome = await homeSummary(deps, payloadResult.value);
          break;
        case 'goal.workspace':
          outcome = await goalWorkspace(deps, payloadResult.value);
          break;
        case 'run.overview':
          outcome = await runRead(deps, payloadResult.value, 'overview');
          break;
        case 'run.blockers':
          outcome = await runRead(deps, payloadResult.value, 'blockers');
          break;
        case 'run.timeline':
          outcome = await runRead(deps, payloadResult.value, 'timeline');
          break;
        case 'run.task':
          outcome = await taskRead(deps, payloadResult.value);
          break;
        case 'run.artifacts':
          outcome = await runArtifacts(deps, payloadResult.value);
          break;
        case 'decisions.pending':
          outcome = await decisionsPending(deps, payloadResult.value);
          break;
        case 'run.usage':
          outcome = await runUsage(deps, payloadResult.value);
          break;
        case 'run.budget':
          outcome = await runBudget(deps, payloadResult.value);
          break;
      }
      if (outcome.ok) return { ok: true, value: outcome.value };
      return {
        ok: false,
        error: {
          code: outcome.error.code,
          message: outcome.error.message,
          ...(outcome.error.details === undefined ? {} : { details: outcome.error.details }),
        },
      };
    },
  };
}

export type ControlPlaneService = ReturnType<typeof createControlPlaneService>;
