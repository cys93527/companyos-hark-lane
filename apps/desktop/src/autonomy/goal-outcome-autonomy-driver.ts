/**
 * STAGE 9 — GOAL-TO-OUTCOME AUTONOMY DRIVER (Boss §1-§66).
 *
 * A CompanyOS-native BOUNDED autonomy application service. It owns NO truth of
 * its own: every loop step reloads the canonical durable state (runs, tasks,
 * attempts, dispatches, handoffs, validations, approvals), determines the next
 * DETERMINISTIC action, invokes the EXISTING control-plane command
 * (`goal.advance` — which itself drives the existing engine, planner,
 * supervisor, corrective provisioner and provider dispatch), and reloads.
 *
 * It is NOT a second scheduler (Boss §1): no independent Task/Workflow/Role/
 * Attempt/Validation state; the engine's own state machine stays the only
 * execution authority. It cannot bypass approvals (the run's WAITING_APPROVAL
 * state + pending Approval row stop autonomy with a STRUCTURED user decision
 * request), never retries a model inside an attempt (Stage 7B/8), and stops on
 * bounded typed terminal states only:
 *
 *   COMPLETED · USER_DECISION_REQUIRED · EXTERNAL_PRECONDITION_BLOCKED ·
 *   NON_RECOVERABLE_FAILURE · AUTONOMY_BUDGET_EXHAUSTED · AUTONOMY_STALLED.
 */
import {err, ok, type DomainError, type Result} from '@companyos/core';
import {runDurableRead, storageBoundaryErrorOf} from '@companyos/persistence';

// ---------------------------------------------------------------------------
// Terminal states + budgets (Boss §2, §20-§23)
// ---------------------------------------------------------------------------

export const AUTONOMY_TERMINAL_STATES = [
  'COMPLETED',
  'USER_DECISION_REQUIRED',
  'EXTERNAL_PRECONDITION_BLOCKED',
  'NON_RECOVERABLE_FAILURE',
  'AUTONOMY_BUDGET_EXHAUSTED',
  'AUTONOMY_STALLED',
] as const;

export type AutonomyTerminalState = (typeof AUTONOMY_TERMINAL_STATES)[number];

/** Goal-level autonomy limits (Boss §22) — additive to, never a replacement of, attempt-level budgets. */
export interface AutonomyBudget {
  readonly maxAutonomySteps: number;
  readonly maxAttemptsPerTask: number;
  readonly maxCorrectiveCycles: number;
  /** Consecutive steps with an UNCHANGED canonical state fingerprint (Boss §23). */
  readonly maxStallSteps: number;
}

export const DEFAULT_AUTONOMY_BUDGET: AutonomyBudget = {
  maxAutonomySteps: 40,
  maxAttemptsPerTask: 6,
  maxCorrectiveCycles: 3,
  maxStallSteps: 3,
};

// ---------------------------------------------------------------------------
// Decision classification (Boss §6-§11)
// ---------------------------------------------------------------------------

export const DECISION_CLASSES = [
  'AUTO_RESOLVABLE',
  'INTERNAL_PROFESSIONAL_REVIEW_REQUIRED',
  'USER_DECISION_REQUIRED',
  'EXTERNAL_PRECONDITION_BLOCKED',
  'SYSTEM_FAILURE',
] as const;

export type DecisionClass = (typeof DECISION_CLASSES)[number];

/**
 * Classify one blocking condition (Boss §6): ordinary technical decisions are
 * CompanyOS-internal (auto-resolvable or internal professional review); only
 * genuinely user-owned decisions escalate; missing external preconditions and
 * system failures are their OWN classes — uncertainty never collapses into
 * USER_DECISION_REQUIRED.
 */
export const classifyDecision = (condition: {
  readonly kind:
    | 'technical-choice'
    | 'role-assignment'
    | 'model-selection'
    | 'scheduling-order'
    | 'test-failure-remediation'
    | 'professional-uncertainty'
    | 'payment'
    | 'publishing'
    | 'destructive-production-action'
    | 'permission-escalation'
    | 'legal-contract-commitment'
    | 'irreversible-action'
    | 'business-direction-ambiguity'
    | 'user-mandated-confirmation'
    | 'missing-credential'
    | 'provider-unavailable'
    | 'required-tool-missing'
    | 'workspace-missing'
    | 'runtime-failure';
}): DecisionClass => {
  switch (condition.kind) {
    case 'technical-choice':
    case 'role-assignment':
    case 'model-selection':
    case 'scheduling-order':
    case 'test-failure-remediation':
      return 'AUTO_RESOLVABLE';
    case 'professional-uncertainty':
      return 'INTERNAL_PROFESSIONAL_REVIEW_REQUIRED';
    case 'payment':
    case 'publishing':
    case 'destructive-production-action':
    case 'permission-escalation':
    case 'legal-contract-commitment':
    case 'irreversible-action':
    case 'business-direction-ambiguity':
    case 'user-mandated-confirmation':
      return 'USER_DECISION_REQUIRED';
    case 'missing-credential':
    case 'provider-unavailable':
    case 'required-tool-missing':
    case 'workspace-missing':
      return 'EXTERNAL_PRECONDITION_BLOCKED';
    case 'runtime-failure':
      return 'SYSTEM_FAILURE';
  }
};

// ---------------------------------------------------------------------------
// Runtime doctor / preflight (Boss §14-§16, §51)
// ---------------------------------------------------------------------------

export interface DoctorCheck {
  readonly checkId: string;
  readonly status: 'pass' | 'fail';
  readonly requiredForGoal: boolean;
  readonly failureCode: string | null;
  readonly remediationKind:
    | 'configure-model'
    | 'register-provider'
    | 'register-routable-model'
    | 'configure-credential'
    | 'open-workspace'
    | 'none';
  /** Safe for user display — never a secret, never a raw path. */
  readonly detailsSafeForUser: string;
}

/**
 * The typed `details.reason` strings that mean "an external precondition the
 * operator must supply is missing" (Boss §13/§27) — never a user DECISION and
 * never a reason to keep looping.
 */
export const EXTERNAL_PRECONDITION_REASONS: readonly string[] = [
  'CONTROL_PLANE_MODEL_UNSELECTED',
  'CONTROL_PLANE_ROLE_RESOLVER_UNAVAILABLE',
  'CONTROL_PLANE_PIPELINE_UNAVAILABLE',
  'CONTROL_PLANE_APPROVAL_UNAVAILABLE',
  'MODEL_SELECTION_REQUIRED',
  'MODEL_POOL_EMPTY',
  'MODEL_PROFILE_UNAVAILABLE',
  'MODEL_CAPABILITY_MISMATCH',
  'ROUTING_SEAM_UNAVAILABLE',
  'COMPANYOS_SELECTED_MODEL_REQUIRED',
  'RUN_BINDING_MISSING',
  'EXECUTOR_PROVIDER_UNKNOWN',
];

// ---------------------------------------------------------------------------
// Structured user decision request (Boss §12)
// ---------------------------------------------------------------------------

export interface UserDecisionRequest {
  readonly decisionId: string;
  readonly whyUserIsRequired: string;
  readonly decisionCategory:
    | 'payment'
    | 'publishing'
    | 'destructive-production-action'
    | 'permission-escalation'
    | 'legal-contract-commitment'
    | 'irreversible-action'
    | 'business-direction-ambiguity'
    | 'user-mandated-confirmation'
    | 'run-approval';
  readonly availableOptions: readonly {readonly id: string; readonly label: string; readonly consequences: string}[];
  readonly consequences: string;
  readonly recommendedFacts: readonly string[];
  readonly affectedGoalRunId: string;
  readonly affectedTaskId: string | null;
  readonly authorityReason: string;
}

/**
 * Build the STRUCTURED decision request from the canonical pending Approval
 * row (Boss §12): facts and consequences, never "what next?" and never a
 *伪装 incapacity — the system states exactly why ONLY the user may decide.
 */
export const userDecisionRequestFromApproval = (input: {
  readonly approval: {readonly id: string; readonly riskLevel: string; readonly reason: string; readonly taskId: string | null};
  readonly goalRunId: string;
}): UserDecisionRequest => ({
  decisionId: input.approval.id,
  whyUserIsRequired: input.approval.reason,
  decisionCategory: 'run-approval',
  availableOptions: [
    {id: 'approve', label: 'Approve and resume', consequences: 'The run resumes from the escalated point under the granted authority.'},
    {id: 'deny', label: 'Deny', consequences: 'The run is denied and settles as cancelled-for-cause; the decision is auditable.'},
  ],
  consequences: `Risk level ${input.approval.riskLevel}: the escalated action is outside the autonomy boundary and requires the run.approve authority only the user holds.`,
  recommendedFacts: [input.approval.reason],
  affectedGoalRunId: input.goalRunId,
  affectedTaskId: input.approval.taskId,
  authorityReason: 'run.approve',
});

// ---------------------------------------------------------------------------
// Canonical state snapshot (Boss §3 — no in-memory master state)
// ---------------------------------------------------------------------------

export interface GoalAutonomyState {
  readonly goalRunId: string;
  readonly goalRunState: string;
  readonly executionRuns: readonly {readonly runId: string; readonly state: string}[];
  readonly tasks: readonly {
    readonly id: string;
    readonly state: string;
    readonly roleId: string;
    readonly attemptCount: number;
    readonly correctiveRound: number;
  }[];
  readonly totalAttempts: number;
  readonly failedAttempts: number;
  readonly correctiveCycles: number;
  readonly pendingApproval: {readonly id: string; readonly riskLevel: string; readonly reason: string; readonly taskId: string | null} | null;
  /** Durable growth signals (stall detection must see supervisor/event progress). */
  readonly decisionCount: number;
  readonly eventCount: number;
  readonly fingerprint: string;
}

/** Deterministic fingerprint over the canonical state (Boss §23 stall detection). */
export const autonomyFingerprintOf = (state: Omit<GoalAutonomyState, 'fingerprint' | 'decisionCount' | 'eventCount'> & Partial<Pick<GoalAutonomyState, 'decisionCount' | 'eventCount'>>): string => {
  const canonical = JSON.stringify({
    goal: [state.goalRunId, state.goalRunState],
    runs: state.executionRuns.map((run) => [run.runId, run.state]).sort(),
    tasks: state.tasks.map((task) => [task.id, task.state, task.attemptCount, task.correctiveRound]).sort(),
    totalAttempts: state.totalAttempts,
    failedAttempts: state.failedAttempts,
    approval: state.pendingApproval === null ? null : state.pendingApproval.id,
    // Supervisor turns and lifecycle events ARE progress even when task rows
    // are unchanged between two reads — omitting them made the stall detector
    // fire on legitimately-working loops (Stage 9B root cause).
    decisionCount: state.decisionCount,
    eventCount: state.eventCount,
  });
  let hash = 5381;
  for (let i = 0; i < canonical.length; i += 1) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) | 0;
  }
  return `afp_${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

// ---------------------------------------------------------------------------
// Derived projections (Boss §29-§31, §50 — read models only)
// ---------------------------------------------------------------------------

export interface FinalOutcomeProjection {
  readonly goalRunId: string;
  readonly executionRunId: string | null;
  readonly completionStatus: AutonomyTerminalState;
  readonly deliverableArtifactRefs: readonly string[];
  readonly validationRefs: readonly string[];
  readonly decisionRefs: readonly string[];
  readonly knownRisks: readonly string[];
  readonly remainingExternalBlocks: readonly string[];
  readonly rolesInvolved: readonly string[];
  readonly attemptSummary: {
    readonly totalAttempts: number;
    readonly failedAttempts: number;
    readonly tasksDone: number;
    readonly tasksTotal: number;
  };
  readonly usageSummary: {readonly classification: 'ESTIMATED'; readonly inputTokens: number; readonly outputTokens: number} | null;
  readonly requiresUserAction: UserDecisionRequest | null;
}

/** Goal completion is DERIVED from canonical truth (Boss §29-§30) — never agent text. */
export const isGoalCompleted = (state: GoalAutonomyState): boolean =>
  state.executionRuns.some((run) => run.state === 'COMPLETED') &&
  state.tasks.length > 0 &&
  state.tasks.every((task) => task.state === 'DONE' || task.state === 'SKIPPED' || task.state === 'CANCELLED');

export type GoalProgressPhase = 'planning' | 'executing' | 'validating' | 'correcting' | 'awaiting-user' | 'completed' | 'blocked' | 'failed';

/** The derived progress view (Boss §50) — from canonical state only. */
export const projectGoalProgress = (state: GoalAutonomyState): GoalProgressPhase => {
  if (state.executionRuns.some((run) => run.state === 'COMPLETED')) return 'completed';
  if (state.executionRuns.some((run) => run.state === 'WAITING_APPROVAL')) return 'awaiting-user';
  if (state.executionRuns.some((run) => run.state === 'FAILED')) return 'failed';
  if (state.executionRuns.some((run) => run.state === 'REWORK' || run.state === 'RECOVERING')) return 'correcting';
  if (state.executionRuns.some((run) => run.state === 'VALIDATING' || run.state === 'REVIEWING')) return 'validating';
  if (state.executionRuns.length > 0) return 'executing';
  return 'planning';
};

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export interface AutonomyRunResult {
  readonly terminal: AutonomyTerminalState;
  readonly terminalReason: string;
  readonly stepsExecuted: number;
  readonly attempts: number;
  readonly correctiveCycles: number;
  readonly userDecisionCount: number;
  readonly externalBlockCount: number;
  readonly durationMs: number;
  readonly doctor: readonly DoctorCheck[];
  readonly outcome: FinalOutcomeProjection;
  readonly progress: GoalProgressPhase;
}

export interface AutonomyDriverDeps {
  /** The EXISTING control-plane advance command (compile + engine.drive + supervisor turn). */
  readonly advanceGoal: (input: {readonly companyId: string; readonly runId: string}) => Promise<Result<unknown, DomainError>>;
  /** Canonical durable-state snapshot (composition-owned read; no caching across steps). */
  readonly loadGoalState: (input: {readonly companyId: string; readonly runId: string}) => Promise<Result<GoalAutonomyState, DomainError>>;
  /** Goal-scoped preflight checks (Boss §14 — only what THIS goal needs). */
  readonly preflightChecks: (input: {readonly companyId: string; readonly runId: string}) => Promise<readonly DoctorCheck[]>;
  /** The derived outcome projection from canonical truth. */
  readonly projectOutcome: (input: {readonly companyId: string; readonly runId: string; readonly state: GoalAutonomyState; readonly status: AutonomyTerminalState; readonly externalBlocks: readonly string[]}) => Promise<FinalOutcomeProjection>;
  readonly budgets?: Partial<AutonomyBudget>;
}

export const createGoalOutcomeAutonomyDriver = (deps: AutonomyDriverDeps) => {
  const defaultBudgets: AutonomyBudget = {...DEFAULT_AUTONOMY_BUDGET, ...(deps.budgets ?? {})};

  /**
   * 4a6e362 re-audit (N4-M1) — EVERY durable access of the real Goal Driver crosses the
   * ONE structured storage boundary: a storage-origin throw (SQLite driver codes, or —
   * only at a PURE persistence read — OS I/O codes) becomes typed PERSISTENCE_FAILED with
   * its raw code and cause retained; a Result.err from the dependency passes through
   * untouched; ANY non-storage failure (validation, domain invariant, programmer error,
   * provider failure) must stay a throw and can never be classified as recoverable.
   */
  const durableResult = async <T>(
    operation: string,
    pure: boolean,
    call: () => Promise<Result<T, DomainError>>,
  ): Promise<Result<T, DomainError>> => {
    try {
      return await call();
    } catch (error) {
      const typed = storageBoundaryErrorOf(error, {operation, pure});
      if (typed === null) throw error;
      return err(typed);
    }
  };
  const durableValue = async <T>(operation: string, read: () => Promise<T>): Promise<Result<T, DomainError>> => {
    const outcome = await runDurableRead({operation, pure: true}, read);
    return outcome.ok ? ok(outcome.value) : err(outcome.error);
  };

  const run = async (input: {
    readonly companyId: string;
    readonly runId: string;
    /** Optional per-run overrides (deployment/test policy; never runtime truth). */
    readonly budgets?: Partial<AutonomyBudget>;
  }): Promise<Result<AutonomyRunResult, DomainError>> => {
    const budgets: AutonomyBudget = {...defaultBudgets, ...(input.budgets ?? {})};
    const startedAt = Date.now();
    let steps = 0;
    let userDecisionCount = 0;
    let externalBlockCount = 0;
    let stallSteps = 0;
    let lastFingerprint = '';
    let doctor: readonly DoctorCheck[] = [];

    const finish = async (
      terminal: AutonomyTerminalState,
      terminalReason: string,
      state: GoalAutonomyState,
      externalBlocks: readonly string[] = [],
    ): Promise<Result<AutonomyRunResult, DomainError>> => {
      const projected = await durableValue('goal.outcome.project', () =>
        deps.projectOutcome({
          companyId: input.companyId,
          runId: input.runId,
          state,
          status: terminal,
          externalBlocks,
        }),
      );
      if (!projected.ok) return projected;
      const outcome = projected.value;
      return ok({
        terminal,
        terminalReason,
        stepsExecuted: steps,
        attempts: state.totalAttempts,
        correctiveCycles: state.correctiveCycles,
        userDecisionCount,
        externalBlockCount,
        durationMs: Date.now() - startedAt,
        doctor,
        outcome,
        progress: projectGoalProgress(state),
      });
    };

    /* ---- Preflight (Boss §14-§16): fail EARLY, before plan/role/attempt churn. ---- */
    const preflight = await durableValue('goal.preflight.read', () =>
      deps.preflightChecks({companyId: input.companyId, runId: input.runId}),
    );
    if (!preflight.ok) return preflight;
    doctor = preflight.value;
    const blocking = doctor.filter((check) => check.requiredForGoal && check.status === 'fail');
    if (blocking.length > 0) {
      externalBlockCount = 1;
      const initial = await durableResult('goal.state.read', true, () =>
        deps.loadGoalState({companyId: input.companyId, runId: input.runId}),
      );
      if (!initial.ok) return initial;
      return finish(
        'EXTERNAL_PRECONDITION_BLOCKED',
        blocking.map((check) => String(check.failureCode)).join(','),
        initial.value,
        blocking.map((check) => `${check.checkId}:${String(check.failureCode)}`),
      );
    }

    /* ---- The bounded loop (Boss §2/§17): reload truth every step. ---- */
    for (; steps < budgets.maxAutonomySteps; ) {
      const state = await durableResult('goal.state.read', true, () =>
        deps.loadGoalState({companyId: input.companyId, runId: input.runId}),
      );
      if (!state.ok) return state;

      // Terminal classification from CANONICAL truth (never from agent text).
      if (isGoalCompleted(state.value)) {
        return finish('COMPLETED', 'all required work terminal and the run COMPLETED through the engine', state.value);
      }
      const waitingRun = state.value.executionRuns.find((runRow) => runRow.state === 'WAITING_APPROVAL');
      if (waitingRun !== undefined && state.value.pendingApproval !== null) {
        userDecisionCount = 1;
        return finish('USER_DECISION_REQUIRED', `run ${waitingRun.runId} awaits the user-held run.approve authority`, state.value);
      }
      const failedRun = state.value.executionRuns.find((runRow) => runRow.state === 'FAILED');
      if (failedRun !== undefined) {
        return finish('NON_RECOVERABLE_FAILURE', `run ${failedRun.runId} reached the engine's terminal FAILED state`, state.value);
      }
      const pausedRun = state.value.executionRuns.find((runRow) => runRow.state === 'PAUSED');
      if (pausedRun !== undefined) {
        return finish('AUTONOMY_BUDGET_EXHAUSTED', `run ${pausedRun.runId} is PAUSED (engine round/pause semantics)`, state.value);
      }

      // Budgets (Boss §20-§22): goal-level, additive to attempt-level limits.
      if (state.value.correctiveCycles >= budgets.maxCorrectiveCycles) {
        return finish('AUTONOMY_BUDGET_EXHAUSTED', `corrective cycles ${String(state.value.correctiveCycles)} reached the goal-level cap`, state.value);
      }
      const hotTask = state.value.tasks.find((task) => task.attemptCount >= budgets.maxAttemptsPerTask && task.state !== 'DONE' && task.state !== 'SKIPPED' && task.state !== 'CANCELLED');
      if (hotTask !== undefined) {
        return finish('AUTONOMY_BUDGET_EXHAUSTED', `task ${hotTask.id} reached the goal-level attempt cap`, state.value);
      }

      // Stall / cycle detection (Boss §23-§24): deterministic fingerprints only.
      if (state.value.fingerprint === lastFingerprint) {
        stallSteps += 1;
        if (stallSteps >= budgets.maxStallSteps) {
          return finish('AUTONOMY_STALLED', `canonical state fingerprint unchanged for ${String(stallSteps)} consecutive steps`, state.value);
        }
      } else {
        stallSteps = 0;
        lastFingerprint = state.value.fingerprint;
      }

      // ONE deterministic action: the EXISTING advance command.
      steps += 1;
      /*
       * 6ec4d81 re-audit (N25-R1) — STORAGE-ORIGIN NORMALIZATION at the driver boundary:
       * a raw SQLite/IO failure thrown by the storage layer never reaches the launcher
       * untyped (where it would be unschedulable); it is normalized to the canonical
       * typed PERSISTENCE_FAILED (cause retained). A NON-storage programming/validation
       * failure is re-thrown untouched — it must never be classified as recoverable.
       */
      /*
       * 4a6e362 re-audit (N4-M1) — the advance crosses the SAME structured storage
       * boundary as every other durable access: ambient SQLite driver codes are
       * unambiguously storage-origin; OS I/O codes are NOT re-interpreted here (the
       * advance is a composite operation that may touch workspaces and providers too).
       */
      const advanced = await durableResult('goal.advance', false, () =>
        deps.advanceGoal({companyId: input.companyId, runId: input.runId}),
      );
      if (!advanced.ok) {
        const reason = String(advanced.error.details['reason'] ?? advanced.error.code);
        if (EXTERNAL_PRECONDITION_REASONS.includes(reason)) {
          externalBlockCount = 1;
          return finish('EXTERNAL_PRECONDITION_BLOCKED', reason, state.value, [reason]);
        }
        /*
         * 6ec4d81 (N25-R1) — a PERSISTENCE failure is NOT a canonical workflow terminal:
         * it must reach the launcher as a TYPED recoverable Result.err (structured code),
         * never as ok:true NON_RECOVERABLE_FAILURE metadata the launcher would have to
         * string-parse.
         */
        if (advanced.error.code === 'PERSISTENCE_FAILED') return err(advanced.error);
        return finish(
          'NON_RECOVERABLE_FAILURE',
          reason + ': ' + advanced.error.message,
          state.value,
        );
      }
    }
    const finalState = await durableResult('goal.state.read', true, () =>
      deps.loadGoalState({companyId: input.companyId, runId: input.runId}),
    );
    if (!finalState.ok) return finalState;
    return finish('AUTONOMY_BUDGET_EXHAUSTED', `autonomy step budget ${String(budgets.maxAutonomySteps)} exhausted`, finalState.value);
  };

  return {run};
};

export type GoalOutcomeAutonomyDriver = ReturnType<typeof createGoalOutcomeAutonomyDriver>;
