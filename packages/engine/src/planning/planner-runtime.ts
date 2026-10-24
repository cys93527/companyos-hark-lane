/**
 * Generic planner runtime + durable plan artifact (Sprint 20 / Task-20-04).
 *
 * The FIRST real Goal → Plan runtime, industry-neutral by construction: Planning is a
 * CompanyOS Core capability, and every industry meaning comes from the canonical Goal and
 * the trusted workflow configuration — this module contains no software-development,
 * role or repository vocabulary.
 *
 * One bounded turn per authorized planning command:
 *
 *   canonical run-goal (same Planning Run) + legitimate materialized Planning Task
 *     → pre-provider token budget (trusted window, reserved output, safety margin)
 *     → up to PLAN_PROPOSAL_MAX_ATTEMPTS pinned model proposals (run's OWN pinned
 *       binding; AgentExecution provenance per attempt) inside ONE logical planning
 *       operation — a structurally invalid proposal is retried with TYPED validator
 *       feedback (PLAN_PROPOSAL_REPAIR_V1); CompanyOS never edits model semantics
 *     → strict T20-02 PlanningProposal validation on EVERY attempt (no relaxed
 *       validator, no prose scraping, no silent local repair)
 *     → trusted sourceGoal injection → durable Plan Artifact (kind companyos:plan)
 *     → execution settlement AFTER the artifact (Shape B: artifact-first, the ordering the
 *       T19-03 durability corrective froze) → replay-safe durable result.
 *
 * NO Planner Session, NO conversation, NO tools, NO workflow compilation, NO execution
 * Run, NO approval state: a re-plan is a NEW permanent planning command (a NEW planId and
 * a NEW immutable artifact); there is deliberately NO currentPlan/latestPlan truth.
 */
import {
  FAULT_CHECKPOINTS,
  applyTaskEvent,
  canonicalJson,
  type ExecutionError,
  PLAN_ARTIFACT_KIND,
  PLAN_LIMITS,
  PLAN_LOCAL_ID_SOURCE,
  PLAN_PROPOSAL_SCHEMA,
  planFingerprintOf,
  planIdOf,
  validatePlanningProposal,
  type ValidatedPlanContent,
  type DomainError,
  type Result,
  type Task,
} from '@companyos/core';
import { domainError, err, ok } from '@companyos/core';

import { decideBoundedContextBudget } from '../supervisor/bounded-agent-context.js';
import type {AgentRunOutcome, AgentRuntimeService} from '../runtime/agent-runtime.js';
import type {RunModelBindingReader} from '../lifecycle/run-model-bindings.js';

/** The trusted semantic task kind a planning stage's pinned taskProfile names. */
export const PLANNER_TASK_KIND = 'companyos:planning';

/** The permanent plan-artifact creation command id (the artifact replay identity). */
export const planArtifactCommandId = (planId: string): string => `plan:${String(planId)}`;

export interface PlannerRuntimeDeps {
  readonly runs: {
    get(runId: string): Promise<{
      readonly id: string;
      readonly companyId: string;
      readonly templateId: string;
      readonly versionId: string;
      readonly snapshotId: string;
      /** The run's live state (proposal-attempt cancellation check). */
      readonly state: string;
    } | null>;
  };
  readonly tasks: {
    get(taskId: string): Promise<Task | null>;
    put(task: Task): Promise<void>;
  };
  /** The canonical run-goal reader (same seam every role runtime uses). */
  readonly goal: {
    get(input: {
      readonly runId: string;
      readonly companyId: string;
    }): Promise<Result<{ readonly objective: string }, DomainError>>;
  };
  /** The pinned snapshot verifier (T18-02): the run's pin must verify before anything runs. */
  readonly runSnapshot: {
    verify(input: {
      readonly runId: string;
      readonly snapshotId: string;
    }): Promise<Result<unknown, DomainError>>;
  };
  /** The run's OWN pinned model binding (trusted name; never a current default). */
  readonly modelBindings: RunModelBindingReader;
  readonly modelRegistry: Parameters<RunModelBindingReader['resolve']>[1];
  /** Trusted model catalog: the pinned model's context window, or null when unknowable. */
  readonly modelCatalog: {
    contextWindowOf(modelKey: string): Promise<number | null>;
  };
  /**
   * The deployment's DECLARED native operation kinds (closed set) — advertised verbatim
   * in the planner contract so a plan item MAY declare `taskKind` for exactly these; the
   * control plane still validates every declared kind against this same set. Industry-
   * neutral: the engine never assigns meanings to the names.
   */
  readonly declaredOperationKinds?: readonly string[];
  readonly agentRuntime: AgentRuntimeService;
  /** Plan artifact persistence (the ONE planning store: existing artifacts). */
  readonly artifacts: {
    getByCreationCommand(
      creationCommandId: string,
    ): Promise<{
      readonly artifact: {
        readonly id: string;
        readonly runId: string;
        readonly kind: string;
        readonly contentHash: string;
      };
      readonly creationCommandFingerprint: string;
    } | null>;
    create(command: {
      readonly commandId: string;
      readonly runId: string;
      readonly taskId?: string | null;
      readonly kind: string;
      readonly content: Uint8Array;
      readonly producedBy: string;
      readonly authorizedBy?: string;
      readonly traceId: string;
    }): Promise<Result<{ readonly artifactId: string }, DomainError>>;
  };
  /** Every plan artifact of the run (recovery reconciliation; canonical rows only). */
  readonly plansOfRun: (
    runId: string,
  ) => Promise<
    readonly {
      readonly id: string;
      readonly taskId: string | null;
      readonly contentHash: string;
    }[]
  >;
  /** The run's own goal artifact id (trusted sourceGoal injection, §21). */
  readonly goalArtifactId: (runId: string) => Promise<string | null>;
  readonly faultCheckpoints?: {
    checkpoint(name: string): Promise<void>;
  };
  /** Trusted configuration: which pinned binding name the planner resolves. */
  readonly bindingKey: string;
  readonly clock: { nowIso(): string };
  readonly ids: { id(prefix?: string): string };
}

export interface PlanningTurnInput {
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  /** The permanent planning command — the plan's logical identity input. */
  readonly planningCommandId: string;
  readonly actorId: string;
}

export interface PlanningTurnResult {
  readonly planId: string;
  readonly artifactId: string;
  readonly fingerprint: string;
  readonly replayed: boolean;
}

/**
 * The trusted Planner output reservation (§15): bounded, provider-neutral at the contract
 * level, derived from trusted runtime configuration (never chosen by the model). It is
 * deliberately the same reservation the bounded role contexts use, so the planner never
 * assumes every model can fit a maximal contract.
 */
export const PLANNER_RESERVED_OUTPUT_TOKENS = 4_096;

/**
 * The Planner's structured-output contract — the CONSTRAINED GENERATION mirror of the
 * frozen canonical plan-proposal contract (BB-WATCH-001 closeout). Every rule derives
 * from the SAME exported single-source constants the canonical validator enforces
 * (`PLAN_LOCAL_ID_SOURCE`, `PLAN_LIMITS`, the T20-02 field set): identifier patterns,
 * non-empty bounded text, required fields, minItems on criterion refs, closed
 * additionalProperties. The canonical `validatePlanningProposal` REMAINS the authority —
 * this schema only constrains generation so a faithful backend produces validatable
 * output; a rule that cannot honestly be expressed here stays validator-only.
 */
export const PLAN_PROPOSAL_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: ['schema', 'planItems', 'acceptanceCriteria'],
  additionalProperties: false,
  properties: {
    schema: { type: 'string', const: PLAN_PROPOSAL_SCHEMA },
    planItems: {
      type: 'array',
      minItems: PLAN_LIMITS.planItemMinCount,
      maxItems: PLAN_LIMITS.planItemMaxCount,
      items: {
        type: 'object',
        required: ['planItemId', 'objective', 'dependencyPlanItemIds', 'acceptanceCriterionRefs'],
        additionalProperties: false,
        properties: {
          planItemId: { type: 'string', pattern: PLAN_LOCAL_ID_SOURCE, minLength: 1, maxLength: PLAN_LIMITS.planItemIdMaxLength },
          objective: { type: 'string', minLength: 1, maxLength: PLAN_LIMITS.objectiveMaxChars },
          taskKind: {
            type: 'string',
            description: 'OPTIONAL: the deployment-declared native operation kind this item executes as. Only request kinds the context declares as available; omit otherwise.',
          },
          professionalResponsibility: {
            type: 'object',
            description: 'OPTIONAL (Stage 8C): the professional responsibility this item needs. A REQUEST — the platform resolves the professional seat deterministically.',
            required: ['responsibilityIntent'],
            additionalProperties: false,
            properties: {
              responsibilityIntent: { type: 'string', minLength: 1, maxLength: 300 },
              requiredCapabilities: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 40 } },
              independenceRequired: { type: 'boolean' },
              riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
          },
          dependencyPlanItemIds: {
            type: 'array',
            maxItems: PLAN_LIMITS.dependencyRefsPerItemMax,
            items: { type: 'string', pattern: PLAN_LOCAL_ID_SOURCE },
          },
          acceptanceCriterionRefs: {
            type: 'array',
            minItems: 1,
            maxItems: PLAN_LIMITS.criterionRefsPerItemMax,
            items: { type: 'string', pattern: PLAN_LOCAL_ID_SOURCE },
          },
        },
      },
    },
    acceptanceCriteria: {
      type: 'array',
      minItems: PLAN_LIMITS.criteriaMinCount,
      maxItems: PLAN_LIMITS.criteriaMaxCount,
      items: {
        type: 'object',
        required: ['criterionId', 'requirement'],
        additionalProperties: false,
        properties: {
          criterionId: { type: 'string', pattern: PLAN_LOCAL_ID_SOURCE, minLength: 1, maxLength: PLAN_LIMITS.criterionIdMaxLength },
          requirement: { type: 'string', minLength: 1, maxLength: PLAN_LIMITS.criterionTextMaxChars },
        },
      },
    },
  },
};

/**
 * The DEPLOYMENT-SCOPED proposal contract (BB2 closure): when the deployment declares
 * native operation kinds, constrained generation REQUIRES the planner's classification —
 * `taskKind` becomes a REQUIRED field with a CLOSED enum over exactly the declared kinds.
 * Structured output (not prose guidance) is what makes the classification deterministic;
 * the control plane still validates every declared kind against the same closed set, and
 * an undeclared deployment keeps the base schema (taskKind optional) unchanged.
 */
const proposalSchemaFor = (declaredKinds?: readonly string[]): Readonly<Record<string, unknown>> => {
  if (declaredKinds === undefined || declaredKinds.length === 0) return PLAN_PROPOSAL_JSON_SCHEMA;
  const scoped: Record<string, unknown> = JSON.parse(JSON.stringify(PLAN_PROPOSAL_JSON_SCHEMA));
  const items = (scoped['properties'] as Record<string, unknown>)['planItems'] as Record<string, unknown>;
  const itemSchema = items['items'] as {
    required: string[];
    properties: Record<string, unknown>;
  };
  itemSchema.required = [...itemSchema.required, 'taskKind'];
  itemSchema.properties['taskKind'] = { type: 'string', enum: [...declaredKinds] };
  return scoped;
};

/** The generic, industry-neutral planner system contract (§45/§46). */
const plannerSystemPrompt = (declaredOperationKinds?: readonly string[]): string =>
  [
    'You are the Planner of a CompanyOS workflow run.',
    'You produce exactly ONE planning proposal for the stated objective and nothing else:',
    'a single JSON object with this schema:',
    JSON.stringify({
      schema: PLAN_PROPOSAL_SCHEMA,
      planItems: [
        {
          planItemId: 'stable lowercase-hyphen id, unique in this plan',
          objective: 'one bounded actionable work item',
          dependencyPlanItemIds: ['ids of items that must complete before this one'],
          acceptanceCriterionRefs: ['ids of criteria defining verifiable completion'],
        },
      ],
      acceptanceCriteria: [
        { criterionId: 'stable lowercase-hyphen id', requirement: 'what verifiably counts as done' },
      ],
    }),
    `Rules: every work item references at least one acceptance criterion; every criterion is`,
    `referenced by at least one item; dependency ids must exist, never self-reference, never`,
    `repeat and never form a cycle; at most ${String(PLAN_LIMITS.planItemMaxCount)} items and`,
    `${String(PLAN_LIMITS.criteriaMaxCount)} criteria; no fields beyond this schema; no`,
    `execution authority, no approval state — the validator is the only authority and it`,
    `fails closed. Answer with the JSON object and nothing else.`,
    /* The deployment's DECLARED operation-kind vocabulary (BB2 closure): a CLOSED set,
     * advertised verbatim from trusted configuration. When the deployment declares kinds,
     * taskKind is REQUIRED on every plan item — the planner's classification duty — and
     * the control plane validates every declared kind against this same closed set. */
    declaredOperationKinds !== undefined && declaredOperationKinds.length > 0
      ? `The deployment declares this closed set of native operation kinds: ${declaredOperationKinds.map((kind) => `"${kind}"`).join(', ')}. taskKind is REQUIRED on every plan item: set it to exactly one of these kinds — the one that matches the item's work. Do not invent kinds and do not omit taskKind.`
      : '',
    /* PHASE E2 — MINIMUM-SUFFICIENT DECOMPOSITION (guidance only: the canonical validator
     * above and the bounded proposal repair stay exactly as they were — no plan-size retry
     * loops, no hard item-count heuristics, no new authority anywhere). */
    `Decomposition: propose the FEWEST work items that are actually justified. Plan`,
    `outcomes, not procedural steps. A separate work item exists only for a concrete`,
    `reason, such as: a true dependency boundary; a materially different professional`,
    `responsibility; an independent review/validation authority; a materially different`,
    `capability, tool, or context requirement; a high-risk or approval boundary; meaningful`,
    `failure isolation; genuinely useful concurrent execution; or a separately deliverable`,
    `artifact with independent lifecycle value. Otherwise keep tightly coupled sequential`,
    `work together: sequential steps that share one working set, one responsibility, and one`,
    `deliverable (for example read -> compute -> compare within one analysis, or scaffold to`,
    `implement closely related parts of one component) belong in ONE item. Never split one`,
    `professional responsibility into serial items merely because a step can be named, and`,
    `never chain items A to B to C to D for steps that are one cohesive operation. One item`,
    `may carry several acceptance criteria; the number of criteria never implies more items.`,
    `Do not optimize implementation together with its independent validation - a`,
    `self-certifying item is never acceptable. Split when the split adds correctness,`,
    `recoverability, authority isolation, specialization, or lifecycle value.`,
  ].join('\n');

/** The deterministic Task-output provenance key (execution provenance, NEVER plan truth). */
const PLANNER_TASK_OUTPUT_KEY = 'plan';

const planOutputOf = (plan: {
  readonly planId: string;
  readonly artifactId: string;
  readonly fingerprint: string;
}): Readonly<Record<string, unknown>> => ({
  [PLANNER_TASK_OUTPUT_KEY]: {
    planId: String(plan.planId),
    artifactId: String(plan.artifactId),
    fingerprint: String(plan.fingerprint),
  },
});

/**
 * Settle the planner task to canonical DONE through the EXISTING task state machine —
 * never a second lifecycle. Crashes are converged idempotently: a task already DONE (with
 * this plan's output) is left untouched (§17); an unsettled task runs PLAN→START→COMPLETE
 * with attempt accounting by the machine itself. The durable causal proof is the plan
 * artifact's OWN taskId anchor.
 */
const settlePlannerTask = async (
  actorId: string,
  taskId: string,
  plan: { readonly planId: string; readonly artifactId: string; readonly fingerprint: string },
  deps: PlannerRuntimeDeps,
): Promise<void> => {
  const task = await deps.tasks.get(taskId);
  if (task === null) return;
  if (task.state === 'DONE') {
    // §17: a settled task is never reset, never rewritten — replay returns only.
    return;
  }
  const output = planOutputOf(plan);
  let current = task;
  for (const event of ['PLAN', 'START', 'COMPLETE'] as const) {
    const next = applyTaskEvent(current, event, deps.clock.nowIso(), output);
    if (!next.ok) {
      if (next.error.code === 'ILLEGAL_TRANSITION') continue; // already past this state
      return;
    }
    current = next.value;
  }
  await deps.tasks.put(current);
  void actorId;
};

/** Fail the planner task truthfully (invalid proposal / provider failure mid-attempt). */
const failPlannerTask = async (
  taskId: string,
  deps: PlannerRuntimeDeps,
): Promise<void> => {
  const task = await deps.tasks.get(taskId);
  if (task === null) return;
  if (task.state !== 'RUNNING') return; // pre-flight rejections never mutated the task
  const failed = applyTaskEvent(task, 'FAIL', deps.clock.nowIso());
  if (!failed.ok) return;
  await deps.tasks.put(failed.value);
};

const plannerExecutionError = (
  kind: 'MODEL_UNAVAILABLE' | 'INVALID_OUTPUT' | 'POLICY_REFUSED',
  message: string,
): ExecutionError => ({
  kind,
  code: `PLANNER_${String(kind)}`,
  message,
  retryable: false,
  details: { reason: `PLANNER_${String(kind)}` },
});

/**
 * PLAN_PROPOSAL_REPAIR_V1 (LIVE-SMOKE-FIX-06): the bounded, CompanyOS-owned proposal
 * repair budget — 3 TOTAL proposal attempts (1 initial + up to 2 repairs) inside ONE
 * logical planning operation (same run, same planning task, same planning command,
 * same planId). Each attempt is a REAL model invocation with its own AgentExecution
 * row (the `attempt` column records the proposal attempt number); the control-plane
 * NETWORK retry policy stays untouched INSIDE each invocation. Repair feeds the
 * canonical validator's TYPED issues back to the planner — CompanyOS NEVER mutates a
 * semantic reference itself (no local id guessing, no silent dependency deletion).
 * The canonical validator runs UNCHANGED on every attempt; until one passes, no
 * canonical Plan exists.
 */
export const PLAN_PROPOSAL_MAX_ATTEMPTS = 3;

export interface PlannerProposalAttemptFailure {
  readonly attempt: number;
  readonly code: string;
  readonly message: string;
}

/** Safe typed validator feedback rendered into a repair attempt's context (no CoT, no secrets). */
const plannerRepairFeedbackOf = (
  attemptNumber: number,
  failures: readonly PlannerProposalAttemptFailure[],
): string =>
  JSON.stringify({
    schema: 'companyos/planner-repair-feedback/1',
    proposalAttempt: attemptNumber,
    maxProposalAttempts: PLAN_PROPOSAL_MAX_ATTEMPTS,
    instruction:
      'The previous planning proposal failed canonical validation. Return ONE complete corrected proposal object with the same schema — fix the reported references/structure, change nothing else, and do not explain.',
    validationErrors: failures.map((failure) => ({code: failure.code, message: failure.message})),
  });

export function createPlannerRuntime(deps: PlannerRuntimeDeps) {
  const runPlanningTurn = async (
    input: PlanningTurnInput,
  ): Promise<Result<PlanningTurnResult, DomainError>> => {
    /* ---- 1. the canonical Run (tenant scope proven here; no leak) ---- */
    const run = await deps.runs.get(input.runId);
    if (run === null || run.companyId !== input.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: input.runId,
        }),
      );
    }

    /* ---- 2. plan identity: deterministic from the trusted scope alone ---- */
    const planId = planIdOf({
      companyId: run.companyId,
      planningRunId: run.id,
      planningCommandId: input.planningCommandId,
    });

    /*
     * ---- 3. TASK-SETTLEMENT CONVERGENCE + PERMANENT REPLAY (corrective §7-§8/§17-§19) ----
     * One baseline planner Task per run/stage is frozen (T20-03); its business output is
     * durable the moment its plan artifact commits. The durable causal link is the
     * artifact's OWN taskId anchor (the artifact row names this exact task), so:
     *  - a replay of the SAME command returns the existing plan with ZERO provider calls;
     *  - a task left unsettled by a crash is reconciled to the canonical DONE state
     *    through the EXISTING task state machine (PLAN-START-COMPLETE — never a second
     *    lifecycle), with the plan reference as its output provenance;
     *  - an ALREADY-settled task is never mutated again (§17: replay resets nothing);
     *  - a DIFFERENT planning command against a settled task is refused: one Planning Run
     *    authorizes one planning result (the T20-01 lifecycle — Planning Run, Plan,
     *    compiler, Execution Run); a re-plan is a NEW Planning Run, never a second plan
     *    hidden behind one DONE task (no latest-plan ambiguity, ever).
     */
    const existing = await deps.artifacts.getByCreationCommand(planArtifactCommandId(planId));
    const anchoredOthers = (await deps.plansOfRun(run.id))
      .filter((plan) => String(plan.taskId ?? '') === String(input.taskId));
    if (existing !== null || anchoredOthers.length > 0) {
      const settled =
        existing !== null
          ? {
              planId,
              artifactId: existing.artifact.id,
              fingerprint: existing.artifact.contentHash,
            }
          : anchoredOthers.length > 0
            ? {
                // The artifact's own permanent command identity is the plan identity; the
                // refusal reports the ANCHOR (artifact id) — the durable causal fact.
                planId: String(anchoredOthers[0]!.id),
                artifactId: String(anchoredOthers[0]!.id),
                fingerprint: String(anchoredOthers[0]!.contentHash),
              }
            : null;
      if (settled === null) {
        return err(
          domainError('PERSISTENCE_FAILED', 'The durable plan could not be resolved.', {
            reason: 'PLANNER_PLAN_RESOLUTION_FAILED',
            planId,
          }),
        );
      }
      await settlePlannerTask(input.actorId, input.taskId, settled, deps);
      if (existing === null) {
        // A DIFFERENT command's plan owns this task: converge the task, then refuse.
        return err(
          domainError(
            'VALIDATION_FAILED',
            `The planning task is already settled by plan "${String(settled.planId)}"; a new planning command needs a new planning run.`,
            {
              reason: 'PLANNER_TASK_ALREADY_SETTLED',
              planId: String(settled.planId),
              artifactId: String(settled.artifactId),
            },
          ),
        );
      }
      return ok({ ...settled, replayed: true });
    }

    /* ---- 4. the legitimate Planning Task (§5/§39): ownership + pinned semantics ---- */
    const task = await deps.tasks.get(input.taskId);
    if (task === null) {
      return err(
        domainError('NOT_FOUND', `Task "${input.taskId}" does not exist.`, {
          reason: 'PLANNER_TASK_MISSING',
          taskId: input.taskId,
        }),
      );
    }
    if (String(task.runId) !== String(run.id)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Task "${input.taskId}" belongs to another run; the planner refuses it.`,
          { reason: 'PLANNER_TASK_RUN_MISMATCH', taskId: input.taskId, runId: run.id },
        ),
      );
    }
    if (task.kind !== PLANNER_TASK_KIND) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Task "${input.taskId}" has kind "${String(task.kind)}"; only the pinned planning task kind may plan.`,
          { reason: 'PLANNER_TASK_KIND_MISMATCH', taskId: input.taskId, kind: String(task.kind) },
        ),
      );
    }
    const verified = await deps.runSnapshot.verify({ runId: run.id, snapshotId: run.snapshotId });
    if (!verified.ok) return verified;

    /* ---- 5. the canonical Goal (§12): same-Run run-goal, never caller text ---- */
    const goal = await deps.goal.get({ runId: run.id, companyId: run.companyId });
    if (!goal.ok) return goal;
    const goalArtifactId = await deps.goalArtifactId(run.id);
    if (goalArtifactId === null) {
      return err(
        domainError('NOT_FOUND', `The planning run "${run.id}" has no canonical goal artifact.`, {
          reason: 'PLAN_SOURCE_GOAL_MISSING',
          runId: run.id,
        }),
      );
    }

    /* ---- 6. the pinned model binding (§9): the run's OWN, never a current default ---- */
    const bound = await deps.modelBindings.resolve(
      { runId: run.id, companyId: run.companyId, bindingName: deps.bindingKey },
      deps.modelRegistry as never,
    );
    if (!bound.ok) return bound;

    /* ---- 6.5 start the canonical task attempt (§10/§11): the REAL task machine ---- */
    const startTask = await deps.tasks.get(input.taskId);
    if (startTask === null) {
      return err(
        domainError('NOT_FOUND', `Task "${input.taskId}" does not exist.`, {
          reason: 'PLANNER_TASK_MISSING',
          taskId: input.taskId,
        }),
      );
    }
    if (startTask.state === 'DONE' || startTask.state === 'FAILED' || startTask.state === 'CANCELLED' || startTask.state === 'SKIPPED') {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `The planning task is already terminal ("${String(startTask.state)}"); a new planning command needs a new planning run.`,
          { reason: 'PLANNER_TASK_ALREADY_SETTLED', taskId: input.taskId, state: startTask.state },
        ),
      );
    }
    {
      let current = startTask;
      for (const event of ['PLAN', 'START'] as const) {
        const next = applyTaskEvent(current, event, deps.clock.nowIso());
        if (next.ok) current = next.value;
      }
      if (current !== startTask) await deps.tasks.put(current);
    }

    /* ---- 7. the bounded, industry-neutral context (§11) ---- */
    const contextObject = {
      schema: 'companyos/planner-context/1',
      company: { id: run.companyId },
      run: { id: run.id, workflowVersionId: run.versionId },
      task: { id: task.id, stageId: String(task.stageId), kind: task.kind },
      goal: { objective: goal.value.objective },
      planContract: {
        schema: PLAN_PROPOSAL_SCHEMA,
        limits: PLAN_LIMITS,
      },
    };
    const renderedContext = JSON.stringify(contextObject);

    /* ---- 8. the pre-provider token budget (§14): complete request accounting ---- */
    const contextWindow = await deps.modelCatalog.contextWindowOf(bound.value.modelKey);
    const budget = decideBoundedContextBudget({
      contextWindowTokens: contextWindow,
      // The planner reserves MORE output room than the role contexts (plans are the payload).
      renderedContext: `${renderedContext}\n${plannerSystemPrompt(deps.declaredOperationKinds)}`,
      structuredKeys: [PLAN_PROPOSAL_SCHEMA],
    });
    if (!budget.ok) return budget;

    await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.planContextBeforePlanProvider);

    /* ---- 9-10. ONE logical planning operation, up to PLAN_PROPOSAL_MAX_ATTEMPTS proposals ----
     * Each proposal attempt: prepare (its OWN AgentExecution, `attempt` = proposal number)
     * → ONE pinned model turn (structured-only, zero tools; the control-plane network
     * retry runs INSIDE that invocation) → the SAME canonical validator (no relaxed
     * validator for repairs). A structurally invalid proposal is REPAIRABLE model output:
     * the attempt's execution settles FAILED with the typed cause, and the next attempt
     * receives the validator's typed feedback. A provider/network failure is NOT
     * repairable output — it fails the turn immediately (fail-loud, no repair burn).
     */
    const attemptFailures: PlannerProposalAttemptFailure[] = [];
    let adopted: {
      readonly content: ValidatedPlanContent;
      readonly executionId: string;
      readonly usage: AgentRunOutcome['usage'];
    } | null = null;
    for (let proposalAttempt = 1; proposalAttempt <= PLAN_PROPOSAL_MAX_ATTEMPTS; proposalAttempt += 1) {
      if (proposalAttempt > 1) {
        /* Cancellation between proposal attempts stops immediately — no further model
         * call after the planning task reached a terminal state or the run was cancelled. */
        const currentTask = await deps.tasks.get(input.taskId);
        const currentRun = await deps.runs.get(input.runId);
        const cancelled =
          currentTask === null ||
          currentTask.state === 'DONE' ||
          currentTask.state === 'FAILED' ||
          currentTask.state === 'CANCELLED' ||
          currentTask.state === 'SKIPPED' ||
          currentRun === null ||
          currentRun.state === 'CANCELLED';
        if (cancelled) {
          return err(
            domainError('CANCELLED', 'Planning was cancelled between proposal attempts.', {
              reason: 'PLANNER_CANCELLED_BETWEEN_PROPOSALS',
              taskId: input.taskId,
              proposalAttempt,
            }),
          );
        }
      }
      const prepared = await deps.agentRuntime.prepare({
        modelKey: bound.value.modelKey,
        explicit: true,
        scopes: [],
        agentId: 'agent.planner',
        roleId: 'rol.planner' as never,
        taskId: task.id as never,
        runId: run.id as never,
        actorId: input.actorId,
        traceId: deps.ids.id('trace'),
        attempt: proposalAttempt,
      });
      if (!prepared.ok) return prepared;
      const outcome = await deps.agentRuntime.runWithOutput({
        executionId: prepared.value.executionId,
        actorId: input.actorId,
        context: {
          company: {id: run.companyId, label: 'company'},
          workflow: {id: run.templateId, label: 'workflow'},
          workflowVersion: run.versionId,
          workflowRun: {id: run.id, label: 'run'},
          stage: {id: String(task.stageId), label: 'stage'},
          task: {id: task.id, label: 'task'},
          role: {id: 'rol.planner', label: 'planner'},
          objective: goal.value.objective,
          memoryView: proposalAttempt === 1
            ? [renderedContext]
            : [renderedContext, plannerRepairFeedbackOf(proposalAttempt, attemptFailures)],
          artifactRefs: [{id: goalArtifactId, label: 'goal'}],
        },
        prompt: {
          planner: true,
          /*
           * PHASE E2 — the planner system contract MUST reach the model. The assembled
           * system prompt defaults to DEFAULT_PREAMBLE when no rolePreamble is supplied,
           * so the planning guidance travels here (the same single-source constant the
           * budget probe accounts for). Without this the guidance is inert.
           */
          rolePreamble: plannerSystemPrompt(deps.declaredOperationKinds),
          responseFormat: {
            mode: 'json_schema',
            schemaName: 'companyos_plan_proposal',
            schema: proposalSchemaFor(deps.declaredOperationKinds),
          },
        } as never,
      });
      if (!outcome.ok) {
        // A failed invocation settles truthfully as a failed execution — never a plan,
        // and never a proposal-repair loop (the bounded network retry already ran inside).
        await deps.agentRuntime.failExecution({
          executionId: prepared.value.executionId,
          actorId: input.actorId,
          error: plannerExecutionError('MODEL_UNAVAILABLE', outcome.error.message),
        });
        await failPlannerTask(input.taskId, deps);
        return outcome;
      }
      /* Strict T20-02 validation (§18/§19/§20) — the SAME canonical validator, every attempt. */
      const validated = validatePlanningProposal(outcome.value.structured);
      if (validated.ok) {
        adopted = {
          content: validated.value,
          executionId: prepared.value.executionId,
          usage: outcome.value.usage,
        };
        break;
      }
      const reasonCode = String(validated.error.details['reason'] ?? 'PLAN_PROPOSAL_INVALID');
      attemptFailures.push({attempt: proposalAttempt, code: reasonCode, message: validated.error.message});
      await deps.agentRuntime.failExecution({
        executionId: prepared.value.executionId,
        actorId: input.actorId,
        error: plannerExecutionError(
          'INVALID_OUTPUT',
          `Proposal attempt ${String(proposalAttempt)}: ${validated.error.message}`,
        ),
        usage: outcome.value.usage,
      });
    }
    if (adopted === null) {
      /* Repair budget exhausted (§12): typed terminal planning failure with the safe
       * per-attempt validation codes — never a user repair request, never a partial plan. */
      await failPlannerTask(input.taskId, deps);
      return err(
        domainError(
          'VALIDATION_FAILED',
          `The planning proposal remained invalid after ${String(PLAN_PROPOSAL_MAX_ATTEMPTS)} attempts: ${attemptFailures
            .map((failure) => `${failure.code} (attempt ${String(failure.attempt)})`)
            .join('; ')}.`,
          {
            reason: 'PLANNER_INVALID_OUTPUT',
            proposalAttempts: PLAN_PROPOSAL_MAX_ATTEMPTS,
            maxProposalAttempts: PLAN_PROPOSAL_MAX_ATTEMPTS,
            attemptFailures: attemptFailures.map((failure) => ({
              attempt: failure.attempt,
              code: failure.code,
              message: failure.message,
            })),
          },
        ),
      );
    }

    /* ---- 11. trusted sourceGoal injection (§21) + the trusted payload ---- */
    const payload = {
      schema: 'companyos/plan/1' as const,
      sourceGoal: { goalArtifactId },
      planItems: adopted.content.planItems,
      acceptanceCriteria: adopted.content.acceptanceCriteria,
    };
    const fingerprint = planFingerprintOf(payload);

    await deps.faultCheckpoints?.checkpoint(
      FAULT_CHECKPOINTS.planProposalValidatedBeforePlanArtifact,
    );

    /* ---- 12. the durable Plan Artifact (§24/§26/§28): artifact FIRST (Shape B) ---- */
    // Content bytes are the CANONICAL serialization: sha256(content) is then exactly the
    // plan fingerprint (durable, recomputable from the artifact alone).
    const created = await deps.artifacts.create({
      commandId: planArtifactCommandId(planId),
      runId: run.id as never,
      taskId: task.id as never,
      kind: PLAN_ARTIFACT_KIND,
      content: new TextEncoder().encode(canonicalJson(payload)),
      producedBy: input.actorId,
      authorizedBy: input.actorId,
      traceId: deps.ids.id('trace'),
    });
    if (!created.ok) {
      // Same planId + different fingerprint ⇒ the artifact service CONFLICTS (fail closed);
      // a create failure settles the execution truthfully FAILED, never a fabricated plan.
      await deps.agentRuntime.failExecution({
        executionId: adopted.executionId,
        actorId: input.actorId,
        error: plannerExecutionError('POLICY_REFUSED', created.error.message),
      });
      await failPlannerTask(input.taskId, deps);
      return created;
    }

    /* ---- 13. crash window (§34): artifact durable, settlement not yet happened ---- */
    await deps.faultCheckpoints?.checkpoint(
      FAULT_CHECKPOINTS.planArtifactBeforeExecutionSettlement,
    );

    /* ---- 14. execution settlement AFTER the plan is durable (Shape B ordering) ---- */
    const settled = await deps.agentRuntime.completeExecution({
      executionId: adopted.executionId,
      actorId: input.actorId,
      usage: adopted.usage,
    });
    if (!settled.ok) {
      // The durable plan stands (artifact-first); the provenance row truthfully reflects
      // the interrupted settlement — never faked COMPLETED, never an invalidated plan.
      return settled;
    }

    /* ---- 14.5 checkpoint D: plan + execution durable, task settlement pending ---- */
    await deps.faultCheckpoints?.checkpoint(
      FAULT_CHECKPOINTS.planExecutionSettledBeforeTaskSettlement,
    );

    /* ---- 15. the task reaches canonical DONE with the plan as output provenance ---- */
    await settlePlannerTask(input.actorId, input.taskId, {
      planId,
      artifactId: created.value.artifactId,
      fingerprint,
    }, deps);

    /* ---- 16. checkpoint E: everything durable, before the caller return ---- */
    await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.plannerTaskSettledBeforeReturn);
    return ok({
      planId,
      artifactId: created.value.artifactId,
      fingerprint,
      replayed: false,
    });
  };

  return { runPlanningTurn, plannerSystemPrompt };
}
