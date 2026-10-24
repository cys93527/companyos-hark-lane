/**
 * Work-role session runtime integration (T19-03: the Work-role integration lives in the desktop composition) (Sprint 19 / Task-19-03).
 *
 * The ONE role integrated with the durable Session kernel (T19-02): the Work-role production
 * agent path. Reviewer and QA keep their Sprint-18 isolated bounded contexts; the Supervisor
 * stays state-reconstructed per turn — no session exists for any of them, and nothing in this
 * module is reachable from those paths.
 *
 * The chain (Boss §0): Task → trusted Work-role role resolution → Work-role Session →
 * authoritative context projection + bounded Session residue → token budget gate →
 * AgentExecution → Provider invocation → bounded output residue (durable BEFORE the terminal
 * settlement — the residue-first closeout order) → terminal settlement → the EXISTING
 * StageHandlerOutcome / Task output path. Session remains context infrastructure only: an
 * output residue entry never means Task DONE / code accepted / Review PASS (§17), and a
 * session failure fails closed without marking anything successful (§42).
 */
import {
  FAULT_CHECKPOINTS,
  domainError,
  err,
  ok,
  sessionIdOf,
  type DomainError,
  type Result,
  type SessionCanonicalRef,
  type StageHandlerResult,
} from '@companyos/core';

import { decideTokenBudget } from './token-budget.js';
import type { SessionKernel } from './session-kernel-types.js';

/** The trusted registration that IS the role-binding seam (§3): one object, one source. */
export interface WorkRoleRegistration {
  /** The task kinds this trusted handler serves (capability semantics, no display strings). */
  readonly kinds: readonly string[];
  /** The ONE trusted role identity: Session roleKey AND AgentExecution roleId (§3/§21). */
  readonly roleKey: string;
  readonly agentId: string;
  /** The pinned binding name the Work-role model resolves from the run's snapshot. */
  readonly bindingKey: string;
}

export interface WorkSessionDeps {
  readonly kernel: SessionKernel;
  readonly runs: {
    get(runId: string): Promise<{
      readonly id: string;
      readonly companyId: string;
      readonly workflowId: string;
      readonly versionId: string;
    } | null>;
  };
  readonly tasks: {
    get(taskId: string): Promise<{
      readonly id: string;
      /** T20-03A: canonical run ownership — checked before any session work. */
      readonly runId: string;
      readonly stageId: string;
      readonly kind: string;
      readonly state: string;
      readonly inputs: Readonly<Record<string, unknown>>;
    } | null>;
  };
  /** The canonical Goal reader (the run-owned immutable artifact). */
  readonly goal: {
    get(input: {
      readonly runId: string;
      readonly companyId: string;
    }): Promise<Result<{ readonly objective: string }, DomainError>>;
  };
  /** The latest canonical review report across the run's review tasks (T18-04 reader). */
  latestReview(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly actorId: string;
  }): Promise<Result<{ readonly verdict: string } | null, DomainError>>;
  /** The pinned model binding → {modelKey, contextWindow} (window from the trusted catalog). */
  readonly binding: {
    resolve(input: {
      readonly runId: string;
      readonly companyId: string;
    }): Promise<
      Result<{ readonly modelKey: string; readonly contextWindow: number | null }, DomainError>
    >;
  };
  /** The workspace anchor identity, when a workspace is open (reference only, §32). */
  anchorIdentity?(input: {
    readonly runId: string;
  }): Promise<{ readonly workspaceId: string } | null>;
  /**
   * The single pinned agent round, RESIDUE FIRST (closeout Shape B): prepare → ONE provider
   * invoke → the caller's trusted callback makes the session residue durable → ONLY THEN the
   * terminal settlement. A residue-callback failure cancels the execution (never a fabricated
   * success); a crash inside the window leaves residue durable with a NON-terminal execution.
   */
  readonly runRoundResidueFirst: (
    input: {
      readonly companyId: string;
      readonly runId: string;
      readonly taskId: string;
      readonly agentId: string;
      readonly roleId: string;
      readonly actorId: string;
      readonly objective: string;
      readonly memoryView: readonly string[];
      readonly artifactRefs: readonly { readonly ref: string; readonly label: string }[];
      readonly structuredKeys: readonly string[];
      readonly context: Record<string, unknown>;
    },
    persistResidue: (payload: {
      readonly executionId: string;
      readonly structured: unknown;
      readonly outputText: string;
      readonly usage: unknown;
    }) => Promise<Result<unknown, DomainError>>,
  ) => Promise<
    Result<
      { readonly executionId: string; readonly structured: unknown; readonly outputText: string },
      DomainError
    >
  >;
  /**
   * The durable execution status reader for residue eligibility (closeout §9): an entry that
   * records an execution enters the active context ONLY when that execution is durably
   * COMPLETED. Unknown/missing/non-terminal ⇒ excluded (kept durable, never loaded).
   */
  readonly executionStatus: (input: {
    readonly executionId: string;
    readonly actorId: string;
  }) => Promise<string | null>;
  readonly faultCheckpoints?: {
    checkpoint(name: string): Promise<void>;
  };
  readonly clock: { nowIso(): string };
}

export interface WorkSessionTurnResult extends StageHandlerResult {
  /** The session the turn ran in (already durable). */
  readonly sessionId: string;
  /** The execution this turn used (already settled by the pinned round). */
  readonly executionId: string;
}

/** One authorized Work-role turn (a separate caller decision each time — no inner loop, §23). */
export interface RunWorkTurnInput {
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly actorId: string;
  readonly structuredKeys: readonly string[];
}

const SEED_COMMAND_ID = 'seed';
const TURN_RESIDUE_COMMAND = (executionId: string): string => `turn:${executionId}`;
const RESIDUE_TEXT_LIMIT = 8_192;

/**
 * The frozen output kind of one Work-role stage turn. This envelope kind is EXPLICITLY
 * classified as having NO canonical sink: a work turn's canonical evidence arrives through
 * the review/validation roles, so recovery routing may skip it and only it
 * (T19-04 closeout §19 — any other unknown kind fails closed).
 */
export const WORK_ROLE_OUTPUT_KIND = 'companyos:work-role-work';

/** Corrective lineage projection from Task.inputs (the T18-05 canonical shape). */
const lineageOf = (
  inputs: Readonly<Record<string, unknown>>,
): { readonly parentTaskId: string; readonly round: number } | null => {
  const raw = inputs['corrective'];
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const parent = typeof record['parentTaskId'] === 'string' ? record['parentTaskId'] : null;
  const round = typeof record['round'] === 'number' ? record['round'] : null;
  if (parent === null || round === null) return null;
  return { parentTaskId: parent, round };
};

export function createWorkSessionRuntime(
  registration: WorkRoleRegistration,
  deps: WorkSessionDeps,
) {
  /**
   * Run ONE authorized work-role turn. Fails closed on any session/binding/budget problem —
   * the higher runtime sees a failed handler result and NO task state changes (§42).
   */
  const runTurn = async (
    input: RunWorkTurnInput,
  ): Promise<Result<WorkSessionTurnResult, DomainError>> => {
    if (registration.kinds.length === 0 || registration.roleKey.trim() === '') {
      return err(
        domainError('PERSISTENCE_FAILED', 'The Work-role role registration is empty.', {
          reason: 'DEVELOPER_REGISTRATION_EMPTY',
        }),
      );
    }
    const run = await deps.runs.get(input.runId);
    if (run === null || run.companyId !== input.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
        }),
      );
    }
    const task = await deps.tasks.get(input.taskId);
    if (task === null) {
      return err(
        domainError('NOT_FOUND', `Task "${input.taskId}" does not exist.`, {
          reason: 'TASK_MISSING',
        }),
      );
    }
    // T20-03A (§24): a Developer session may only ever exist for THIS run's task — proven
    // BEFORE any session/kernel work, so a foreign-run task can never create session state
    // under the wrong run.
    if (String(task.runId) !== String(input.runId)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Task "${input.taskId}" belongs to another run; no session may exist for it here.`,
          {
            reason: 'SESSION_TASK_RUN_MISMATCH',
            runId: input.runId,
            taskId: input.taskId,
            taskRunId: String(task.runId),
          },
        ),
      );
    }
    if (!registration.kinds.includes(task.kind)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Task kind "${task.kind}" is not served by the trusted Work-role registration.`,
          { reason: 'DEVELOPER_KIND_NOT_REGISTERED', kind: task.kind },
        ),
      );
    }

    /* ---- the session: parent = the T0 work-role session for a corrective task (§7) ---- */
    const lineage = lineageOf(task.inputs);
    let parentSessionId: string | null = null;
    if (lineage !== null) {
      const t0 = sessionIdOf({
        companyId: input.companyId,
        runId: input.runId,
        taskId: lineage.parentTaskId,
        roleKey: registration.roleKey,
      });
      const t0Session = await deps.kernel.readActiveContext({
        companyId: input.companyId,
        sessionId: t0,
      });
      parentSessionId = t0Session.ok ? t0 : null;
    }
    const session = await deps.kernel.ensureSession({
      companyId: input.companyId,
      runId: input.runId,
      taskId: input.taskId,
      roleKey: registration.roleKey,
      ...(parentSessionId === null ? {} : { parentSessionId }),
    });
    if (!session.ok) return session;

    /* ---- the idempotent CONTEXT_SEED (§13): deterministic, replay-safe ---- */
    const seed = await deps.kernel.appendEntry({
      companyId: input.companyId,
      sessionId: session.value.sessionId,
      commandId: SEED_COMMAND_ID,
      entryKind: 'context_seed',
      text: JSON.stringify({
        schema: 'companyos/session-context-seed/1',
        runId: input.runId,
        taskId: input.taskId,
        roleKey: registration.roleKey,
        agentId: registration.agentId,
        bindingKey: registration.bindingKey,
      }),
      refs: [
        { kind: 'goal', id: input.runId },
        { kind: 'task', id: input.taskId },
      ],
      executionId: null,
      inputTokenEstimate: 0,
    });
    if (!seed.ok) return seed;

    /* ---- the authoritative projection (§11) — read FRESH every turn (§12) ---- */
    const goal = await deps.goal.get({ runId: input.runId, companyId: input.companyId });
    if (!goal.ok) return goal;
    const refs: SessionCanonicalRef[] = [
      { kind: 'goal', id: input.runId },
      { kind: 'task', id: input.taskId },
    ];
    if (lineage !== null) refs.push({ kind: 'task', id: lineage.parentTaskId });
    const review = await deps.latestReview({
      companyId: input.companyId,
      runId: input.runId,
      actorId: input.actorId,
    });
    if (!review.ok) return review;
    const anchor =
      deps.anchorIdentity === undefined
        ? null
        : await deps.anchorIdentity({ runId: input.runId });
    if (anchor !== null) refs.push({ kind: 'workspace-anchor', id: anchor.workspaceId });
    const authoritative = {
      schema: 'companyos/work-role-context/1',
      // The two provenance categories stay DISTINGUISHABLE (§10): this object is rebuilt from
      // canonical truth every turn and is never stored as a whole (§12/§15). T19-04 §23/§37:
      // the run's REAL identities — company, workflow, pinned version — never placeholders.
      company: { id: run.companyId },
      run: { id: run.id, workflowId: run.workflowId, versionId: run.versionId },
      goal: { objective: goal.value.objective },
      task: {
        id: task.id,
        kind: task.kind,
        stageId: String(task.stageId),
        state: task.state,
        correctiveLineage:
          lineage === null
            ? null
            : { parentTaskId: lineage.parentTaskId, round: lineage.round },
      },
      binding: { bindingKey: registration.bindingKey },
      anchorIdentity: anchor === null ? null : { workspaceId: anchor.workspaceId },
      latestReviewVerdict: review.value === null ? null : review.value.verdict,
    };

    /* ---- the active session residue (§14): bounded, and EXECUTION-ELIGIBLE (closeout §9) ---- */
    const active = await deps.kernel.readActiveContext({
      companyId: input.companyId,
      sessionId: session.value.sessionId,
    });
    if (!active.ok) return active;
    const recorded = active.value.entries.filter(
      (entry) => entry.entryKind !== 'compaction_checkpoint',
    );
    // Closeout §9: an entry that records an execution is context-eligible ONLY when that
    // execution is durably COMPLETED. The residue-first crash window leaves the residue
    // durable with a NON-terminal execution: it stays as history, but is never trusted as a
    // completed turn. RUNNING/FAILED/CANCELLED/INTERRUPTED/unknown are all excluded.
    const recordedExecutionIds = [
      ...new Set(
        recorded.map((entry) => entry.executionId).filter((id): id is string => id !== null),
      ),
    ];
    const settledExecutions = new Set<string>();
    for (const executionId of recordedExecutionIds) {
      const status = await deps.executionStatus({ executionId, actorId: input.actorId });
      if (status === 'COMPLETED') settledExecutions.add(executionId);
    }
    const residue = recorded
      .filter((entry) => entry.executionId === null || settledExecutions.has(entry.executionId))
      .map((entry) => entry.text)
      .filter((text) => text.trim().length > 0)
      .slice(-16);

    /* ---- the token budget gate (§26): BEFORE the provider, on the full request ---- */
    const binding = await deps.binding.resolve({
      runId: input.runId,
      companyId: input.companyId,
    });
    if (!binding.ok) return binding;
    if (binding.value.contextWindow === null) {
      // §27: the pinned model's context window comes from the trusted catalog or nowhere.
      return err(
        domainError(
          'NOT_FOUND',
          `The pinned model "${binding.value.modelKey}" has no trusted context window; refusing.`,
          { reason: 'SESSION_TOKEN_WINDOW_UNKNOWN', modelKey: binding.value.modelKey },
        ),
      );
    }
    const rendered =
      JSON.stringify(authoritative) + '\n' + residue.join('\n') + '\n' + input.structuredKeys.join(',');
    const budget = decideTokenBudget({
      contextWindowTokens: binding.value.contextWindow,
      reservedOutputTokens: 1_024,
      renderedText: rendered,
    });
    if (!budget.ok) return budget;
    await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.sessionBeforeProvider);

    /* ---- the pinned agent round, RESIDUE FIRST (closeout Shape B): the session residue
     * becomes durable BETWEEN the provider result and the terminal settlement, so a durably
     * COMPLETED execution can never lack its residue ---- */
    const round = await deps.runRoundResidueFirst(
      {
        companyId: input.companyId,
        runId: input.runId,
        taskId: input.taskId,
        agentId: registration.agentId,
        roleId: registration.roleKey, // §3 invariant: the SAME trusted role identity
        actorId: input.actorId,
        objective: goal.value.objective,
        memoryView: [
          JSON.stringify(authoritative),
          ...(residue.length === 0 ? [] : ['# Session residue', ...residue]),
        ],
        artifactRefs: refs.map((ref) => ({
          ref: `${ref.kind}:${ref.id}`,
          label: ref.kind,
        })),
        structuredKeys: input.structuredKeys,
        // The same reference-skeleton seats the composed handlers already send, corrected per
        // the T19-01 recon and the T19-04 placeholder audit: company, workflow id and workflow
        // version are the run row's REAL identities — never placeholders.
        context: {
          company: { id: run.companyId, label: 'company' },
          workflow: { id: run.workflowId, label: 'workflow' },
          workflowVersion: run.versionId,
          workflowRun: { id: run.id, label: 'run' },
          stage: { id: String(task.stageId), label: 'stage' },
          task: { id: task.id, label: 'task' },
          role: { id: registration.roleKey, label: 'work-role' },
          objective: goal.value.objective,
          memoryView: [
            JSON.stringify(authoritative),
            ...(residue.length === 0 ? [] : ['# Session residue', ...residue]),
          ],
          artifactRefs: refs.map((ref) => ({ id: `${ref.kind}:${ref.id}`, label: ref.kind })),
        },
      },
      async (payload) => {
        // Provider result in hand; the execution is STILL RUNNING. Make the residue durable
        // NOW — BEFORE the settlement (the closeout ordering proof).
        await deps.faultCheckpoints?.checkpoint(
          FAULT_CHECKPOINTS.providerResultBeforeSessionResidue,
        );
        const outputText =
          typeof payload.outputText === 'string'
            ? payload.outputText.slice(0, RESIDUE_TEXT_LIMIT)
            : '';
        const residueEntry = await deps.kernel.appendEntry({
          companyId: input.companyId,
          sessionId: session.value.sessionId,
          commandId: TURN_RESIDUE_COMMAND(payload.executionId),
          entryKind: 'model_output_residue',
          text: outputText,
          refs: [{ kind: 'agent-execution', id: payload.executionId }],
          executionId: payload.executionId,
          inputTokenEstimate: budget.value.estimatedInputTokens,
        });
        if (!residueEntry.ok) return residueEntry;
        // Residue durable, execution STILL RUNNING: the recovered intermediate state of the
        // closeout window. A crash here leaves history that §9 refuses to trust as a
        // completed turn — the settlement below has NOT happened yet.
        await deps.faultCheckpoints?.checkpoint(
          FAULT_CHECKPOINTS.sessionResidueBeforeExecutionSettlement,
        );
        return ok(true);
      },
    );
    if (!round.ok) return round;

    const structured =
      typeof round.value.structured === 'object' && round.value.structured !== null
        ? round.value.structured
        : {};
    return ok({
      status: 'succeeded',
      output: {
        schemaVersion: 'companyos/stage-output/1',
        kind: WORK_ROLE_OUTPUT_KIND,
        executionId: round.value.executionId,
        artifactRefs: [],
        validationRefs: [],
        payload: structured as Record<string, unknown>,
      },
      sessionId: session.value.sessionId,
      executionId: round.value.executionId,
    });
  };

  return { runTurn, registration };
}
