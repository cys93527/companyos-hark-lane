/**
 * Autonomous Supervisor runtime (Sprint 18 / Task-18-07) — the bounded orchestration cycle.
 *
 * This is the FIRST place CompanyOS may take more than one logical step on its own, and it is
 * bounded by construction:
 *
 *   Goal → Supervisor turn (T18-06, reused as-is) → Decision → trusted Decision application →
 *   work / corrective / stop → new durable evidence → Supervisor turn → … → COMPLETE or ESCALATE
 *
 * What it is and is NOT:
 *   - it OWNS ORCHESTRATION ONLY. It does not replace the Engine, the Decision Sink, the
 *     Corrective Provisioner, the ValidationService, the ReviewFindingsSink, the ToolRegistry or
 *     RiskPolicy — every effect goes through those canonical services (§3/§4);
 *   - it introduces NO authoritative state of its own: no second task/run/decision state, no
 *     retry ledger, no workflow graph. The only durable thing it writes is an APPLICATION
 *     RECEIPT artifact, whose identity is derived from the Decision version it applied, so one
 *     Decision has exactly one effect, permanently, without relying on the bounded ledger
 *     (§40/§41);
 *   - it is ITERATIVE, never recursive, and never `while (true)` without a hard counter checked
 *     before each turn (§46/§48);
 *   - it is SERIAL: one active workspace, one active execution path, no parallel agents (§5).
 *
 * Bounds come from trusted application configuration (§6):
 *   `maxSupervisorTurns = 20`, `maxCorrectiveRounds = 3` (the latter enforced at the T18-05
 *   provisioning boundary itself, so a direct provisioner call cannot bypass it).
 *
 * Non-negotiables carried over from the frozen rulings:
 *   - a model Decision is a non-authoritative PROPOSAL; the applicator is the trusted,
 *     deterministic seam that turns it into an allowed action (§13);
 *   - only the CURRENT ACTIVE Decision version may be applied (§39);
 *   - an ESCALATE stops autonomous execution immediately and durably (§31/§32);
 *   - a CANCELLED execution is a terminal non-success and NEVER re-enters automatic retry (§28).
 */
import {
  FAULT_CHECKPOINTS,
  RUN_TERMINAL_STATES,
  canRunTransition,
  DomainError,
  domainError,
  err,
  normalizeExecutionError,
  normalizeStageHandlerResult,
  ok,
  sha256Hex,
  type AgentExecution,
  type ArtifactStorePort,
  type DecisionRecord,
  type Result,
  type RunSnapshot,
  type StageExecutionRequest,
  type StageHandlerOutput,
  type StageId,
  type Task,
  type TaskId,
  type WorkflowRunId,
  type TaskState,
  type WorkflowRun,
  type FaultCheckpointPort,
  FaultCrashError,
} from '@companyos/core';

import type { ArtifactService } from '../artifact/artifact-service.js';
import type { StageHandlerReturn } from '../handlers.js';
import type { CorrectiveProvisioner } from './corrective-provisioner.js';
import { supervisorDecisionPayloadOf } from './decision-sink.js';
import { stageOutputOf, VALIDATION_CANDIDATE_KIND } from './stage-output-carrier.js';
import { stageSubjectTaskOf } from '../projection/work-package-projector.js';
import type { AgentRuntimeService } from '../runtime/agent-runtime.js';
import type {
  SupervisorDecisionRuntime,
  SupervisorDecisionTurnResult,
} from './supervisor-runtime.js';

/* ------------------------------------------------------------------- bounds */

/** Boss ruling (T18-07 §45): V1 allows 20 supervisor turns per autonomous run. */
export const MAX_SUPERVISOR_TURNS = 20;

/** Boss ruling (T18-07 §7): V1 allows 3 corrective rounds (T0 → T1 → T2 → T3). */
export const MAX_CORRECTIVE_ROUNDS = 3;

/** Consecutive turns that produce no durable progress before a fail-closed stop (§47). */
export const DEFAULT_MAX_IDLE_TURNS = 3;

/**
 * Consecutive evidence-driven lifecycle events without a reasoning turn before a fail-closed
 * stop. A bounded chain is a trusted invariant failure, never an unbounded state walk.
 */
export const MAX_CONSECUTIVE_EVIDENCE_EVENTS = 4;
/**
 * F1 closure - the bound on CONSECUTIVE illegal supervisor proposals (semantic rejections
 * by validateProposal). Repeated illegal proposals must become an explicit typed
 * terminal, never an unbounded budget drain; the application keeps rejecting every one.
 * The budget is DERIVED FROM DURABLE ROWS (see `consecutiveIllegalProposals`), so it
 * cannot reset between autonomy calls.
 */
export const MAX_CONSECUTIVE_INVALID_TURNS = 3;

/** The artifact kind carrying an application receipt (exactly one per applied Decision). */
export const SUPERVISOR_APPLICATION_KIND = 'companyos:supervisor-application';

/** The versioned payload seam of that receipt. */
export const SUPERVISOR_APPLICATION_SCHEMA = 'companyos/supervisor-application/1';

/** Command-identity prefix for receipts: one receipt per Decision version, forever. */
export const SUPERVISOR_APPLICATION_COMMAND_PREFIX = 'supervisor-application';

/* -------------------------------------------------------------------- types */

/** Why the autonomous run stopped. Closed vocabulary, machine-readable. */
export const AUTONOMOUS_STOP_REASONS = [
  'completed',
  'escalated',
  'human_required',
  'round_limit',
  'turn_limit',
  'no_legal_action',
  'non_retryable_failure',
  'cancelled',
  'timeout',
  'invariant_failure',
  'idle_progress',
  'validation_requirements_missing',
  /** F5 — this call ended while another (foreign) supervisor round was still in flight. */
  'supervisor_inflight',
  'error',
] as const;
export type AutonomousStopReason = (typeof AUTONOMOUS_STOP_REASONS)[number];

export interface AutonomousSupervisorConfig {
  /** Hard ceiling on supervisor turns (default 20). Trusted configuration only. */
  readonly maxSupervisorTurns?: number;
  /** Hard ceiling on corrective rounds (default 3). Enforced at the provisioner too. */
  readonly maxCorrectiveRounds?: number;
  /** Consecutive no-progress turns before a fail-closed stop (default 3). */
  readonly maxIdleTurns?: number;
  /** Whole-run deadline ceiling. One AbortSignal + one deadline cover every turn (§49). */
  readonly timeoutMs?: number;
  /** Risk level recorded on the Approval an ESCALATE creates (trusted, never model output). */
  readonly escalationRiskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Trusted identity that may decide a resumed approval (must differ from the requester). */
  readonly resumeDeciderId?: string;
}

export interface RunAutonomousSupervisionCommand {
  readonly companyId: string;
  readonly runId: string;
  /** The subject task the first turn is about (durable, in the run's pinned graph). */
  readonly taskId: string;
  /** Optional review-task anchor for the first turn (same meaning as in T18-06). */
  readonly reviewTaskId?: string | null;
  /** Trusted orchestration identity. */
  readonly actorId: string;
  /** Stable identity of this autonomous RUN (not of one turn). */
  readonly runIdentity: string;
  readonly traceId?: string;
  /** Caller-supplied cancellation for the whole run. */
  readonly signal?: AbortSignal;
  /** Caller-supplied whole-run deadline (never widened beyond the config ceiling). */
  readonly timeoutMs?: number;
}

export interface AppliedDecision {
  readonly decisionId: string;
  readonly version: number;
  readonly action: string;
  readonly reasonCode: string;
  /** True when a receipt proved this Decision had already been applied. */
  readonly replayed: boolean;
  /** What the application did, for the caller and the audit trail. */
  readonly effect: string;
  /**
   * The corrective task a REQUEST_CORRECTIVE application provisioned. The loop follows it, so
   * the NEXT round's Decision concerns the task that is now under work — the same task the next
   * review report will report on.
   */
  readonly correctiveTaskId?: string | null;
}

export interface AutonomousSupervisionOutcome {
  readonly runId: string;
  readonly stopReason: AutonomousStopReason;
  readonly turns: number;
  readonly applied: readonly AppliedDecision[];
  /** The last Decision the Supervisor made (null when the run stopped before one). */
  readonly lastDecision: SupervisorDecisionTurnResult | null;
  readonly progressFingerprint: string;
  /** True when every applied Decision in this run was a replay (no new effect). */
  readonly replayed: boolean;
}

/** The engine seam the applicator uses. Exactly the existing `WorkflowEngine` port. */
export interface AutonomousEnginePort {
  advance(
    request: StageExecutionRequest,
  ): Promise<{ runId: string; stageId: string; outcome: string }>;
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
  }): Promise<{ ok: boolean; error?: DomainError }>;
}

/** A paged read of the existing stores (the same shape the other Sprint-18 services use). */
export interface PagedStore<T> {
  list(filter: {
    readonly limit: number;
    readonly offset?: number;
  }): Promise<{ readonly items: readonly T[]; readonly total: number }>;
}

/**
 * The orchestrator's dependencies. Named apart from the T18-06 turn runtime's
 * `SupervisorDecisionRuntimeDeps`: one is the loop's seam set, the other is one turn's.
 */
export interface AutonomousSupervisorRuntimeDeps {
  /**
   * T20-03A: the claim seam is RUN-SCOPED — `listByRun` returns only this run's canonical
   * task rows (ownership), so stage/pinned-graph checks stay what they always were:
   * graph legality, never ownership.
   */
  readonly tasks: PagedStore<Task> & {
    listByRun(runId: string): Promise<readonly Task[]>;
  };
  /** One task row by id (the corrective branch reads the provisioned task). */
  readonly taskById: (taskId: string) => Promise<Task | null>;
  readonly templates: {
    get(templateId: string): Promise<{
      readonly versions: readonly { readonly id: string; readonly graph: WorkflowGraphShape }[];
    } | null>;
  };
  /** The run's durable snapshot rows, so `advance` carries the real pin. */
  readonly snapshots: { get(snapshotId: string): Promise<RunSnapshot | null> };
  readonly runs: { get(runId: string): Promise<WorkflowRun | null> };
  /** AgentExecution rows, so a CANCELLED attempt can be recognized before any re-entry (§28). */
  readonly executions: PagedStore<AgentExecution>;
  /**
   * F1 closure (release-blocker re-audit): the agent identity the supervisor's own decision
   * turns run under. It is what makes the ILLEGAL-PROPOSAL BUDGET durable: an illegal turn
   * left a FAILED AgentExecution (INVALID_OUTPUT) of THIS identity whose traceId matches no
   * recorded Decision, so the budget survives a restart instead of resetting per call.
   * Defaults to the turn runtime's own default identity.
   */
  readonly supervisorAgentId?: string;
  /**
   * Sprint21: orchestrator-driven validation — the ONE existing ValidationService. When
   * a pinned business stage declares validatorIds but the pack defines NO validation-
   * gate stage, the orchestrator runs the validators itself through this trusted owner
   * (never a bespoke path); durable batches then drive the evidence applicator.
   */
  readonly validationRunner?: {
    run(command: {
      readonly commandId: string;
      readonly runId: string;
      readonly stageId?: string;
      readonly taskId?: string;
      readonly targetRef: string;
      readonly validators: readonly { readonly validatorId: string; readonly blocking: boolean }[];
      readonly actorId: string;
      readonly traceId: string;
    }): Promise<Result<readonly unknown[], DomainError>>;
  };
  /** The T18-03 sink IS the decision reader: its own `getDecision` returns the current row. */
  readonly decisionReader: {
    getDecision(input: {
      readonly decisionId: string;
      readonly companyId: string;
      readonly actorId: string;
    }): Promise<Result<DecisionRecord, DomainError>>;
  };
  /**
   * Task-18-07 corrective (§39): the run's decision history, so a terminal run can finalize
   * the application bookkeeping of a Decision whose receipt was never committed.
   */
  readonly decisionHistory?: {
    listRunDecisionHistory(input: {
      readonly runId: string;
      readonly companyId: string;
      readonly actorId: string;
    }): Promise<Result<readonly DecisionRecord[], DomainError>>;
  };
  readonly supervisorRuntime: SupervisorDecisionRuntime;
  /**
   * 9dc9943 — the canonical AgentRuntime arbiter, used by LIVE RECONCILIATION to settle
   * expired / committed supervisor rows inside the existing driver. Optional: without it
   * reconciliation degrades to classification-only (rows still block as in-flight).
   */
  readonly agentRuntime?: Pick<AgentRuntimeService, 'completeExecution' | 'failExecution'>;
  readonly provisioner: CorrectiveProvisioner;
  readonly engine: AutonomousEnginePort;
  /**
   * The receipt rides the EXISTING durable primitives: `ArtifactService.create` for the write
   * and `ArtifactStorePort.getByCreationCommand` for the exact permanent lookup — no new table,
   * no schema change, the same pairing the run goal and the review report already use.
   */
  readonly artifactService: Pick<ArtifactService, 'create'>;
  readonly artifactStore: Pick<ArtifactStorePort, 'getByCreationCommand'>;
  /**
   * Task-18-07 corrective: the trusted carrier that routes a handler's structured output into
   * the canonical Review/Validation sinks. When omitted, no structured output can be routed and
   * the evidence applicator has nothing new to apply — the loop still runs, it just cannot make
   * lifecycle progress on evidence.
   */
  readonly outputCarrier?: {
    routeTask(input: {
      readonly companyId: string;
      readonly runId: string;
      readonly taskId: string;
      readonly actorId: string;
      readonly traceId?: string;
    }): Promise<
      Result<{ readonly kind: string; readonly refs: readonly string[] } | null, DomainError>
    >;
    /**
     * Task-18-07 corrective: route the output a handler JUST produced, while its task is still
     * not DONE. This is the live path — the canonical sink is durable FIRST and the task becomes
     * DONE only afterwards, so a crash in between can never leave a DONE task whose canonical
     * output is missing.
     */
    routeOutput(input: {
      readonly companyId: string;
      readonly runId: string;
      readonly taskId: string;
      readonly output: StageHandlerOutput;
      readonly actorId: string;
      readonly traceId?: string;
    }): Promise<
      Result<{ readonly kind: string; readonly refs: readonly string[] } | null, DomainError>
    >;
  };
  /**
   * Task-18-07 corrective: the deterministic evidence → Run lifecycle applicator. It is NOT
   * model reasoning: canonical durable evidence implies exactly one legal Run event.
   */
  readonly evidenceApplicator?: {
    applyEvidence(input: {
      readonly companyId: string;
      readonly runId: string;
      readonly reviewTaskId?: string | null;
      readonly reviewTaskIds?: readonly string[] | null;
      readonly actorId: string;
      readonly traceId?: string;
    }): Promise<
      Result<
        { readonly event: string; readonly from: string; readonly to: string } | null,
        DomainError
      >
    >;
  };
  /** Trusted configuration: the review task whose latest report drives the lifecycle events. */
  readonly reviewTaskId?: string | null;
  /**
   * Task-18-07 corrective (PRODUCTION_TURN_TWO_DEFECT): the agent-backed unit of a REVIEWING or
   * VALIDATING task. The engine's stage execution is defined ONLY for the run's EXECUTING phase
   * (it always ends with `EXECUTION.COMPLETE`, which is illegal from REVIEWING/VALIDATING), so
   * those phases run their tasks through the trusted pinned-agent path instead of the engine.
   * Absent ⇒ those tasks cannot be executed and the loop stops fail-closed.
   */
  readonly runAgentUnit?: (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly taskKind: string;
    readonly stageId: string;
    readonly signal?: AbortSignal;
    /**
     * The handler's OWN return value: a bare status or a structured result. The orchestrator
     * normalizes it at the single boundary it owns, exactly like the engine does.
     */
  }) => Promise<Result<StageHandlerReturn, DomainError>>;
  /**
   * Task-18-07 corrective: complete a task with its bounded structured output, through the
   * canonical Task state machine (the same one the engine uses). Called AFTER the canonical sink
   * is durable, so a crash can never leave a DONE task whose canonical output is missing.
   */
  readonly completeTaskWithOutput?: (input: {
    readonly taskId: string;
    readonly output: StageHandlerOutput;
  }) => Promise<Result<Task, DomainError>>;
  /** Injected timer: the engine and this runtime never install timers themselves. */
  readonly timer: (ms: number, onTimeout: () => void) => () => void;
  readonly clock: { now: () => number; nowIso: () => string };
  readonly ids: { id: (prefix?: string) => string };
  readonly config?: AutonomousSupervisorConfig;
  /** Trusted binding name the Supervisor runs under (forwarded to T18-06). */
  readonly supervisorBindingKey: string;
  /**
   * Task-18-08 deterministic fault-injection seam: absent in production (zero overhead),
   * armed by a test harness to prove the application/receipt and sink/lifecycle windows.
   */
  readonly faultCheckpoints?: FaultCheckpointPort;
}

export interface WorkflowGraphShape {
  readonly nodes: readonly { readonly id: string; readonly kind?: string }[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
}

export interface AutonomousSupervisorRuntime {
  run(
    command: RunAutonomousSupervisionCommand,
  ): Promise<Result<AutonomousSupervisionOutcome, DomainError>>;
  /** Read-only: the next legal work unit for a run, derived from frozen state only. */
  nextWorkUnit(input: {
    readonly companyId: string;
    readonly runId: string;
  }): Promise<
    Result<
      | {
          readonly phase: 'executing' | 'reviewing' | 'validating';
          readonly stageId: StageId;
          readonly taskIds: readonly TaskId[];
        }
      | null,
      DomainError
    >
  >;
  /**
   * The trusted resume seam for an escalated run: one APPROVAL.GRANT through the engine, with
   * the decider identity taken from trusted configuration. No UI, no IPC, no new authority
   * token — the authority is supplied by the trusted caller exactly as `drive` already does.
   */
  resumeEscalatedRun(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly actorId: string;
    readonly traceId?: string;
    readonly note?: string;
  }): Promise<Result<{ readonly runId: string; readonly resumed: boolean }, DomainError>>;
}

/* ----------------------------------------------------------------- utilities */

/** Terminal task states — the set that makes a stage satisfied. */
const TERMINAL_TASK_STATES: readonly TaskState[] = ['DONE', 'SKIPPED', 'CANCELLED', 'FAILED'];

/** True when every task of a unit is already terminal — the action is a replay, not new work. */
const unitAlreadySatisfied = async (
  taskIds: readonly string[],
  read: (taskId: string) => Promise<Task | null>,
): Promise<boolean> => {
  for (const taskId of taskIds) {
    const task = await read(taskId);
    if (task === null || !TERMINAL_TASK_STATES.includes(task.state)) return false;
  }
  return true;
};

/**
 * Deterministic topological order of the pinned graph's stages: entry first, then edges, with
 * the node array order as the deterministic tie-break. Derived from the FROZEN WorkflowVersion —
 * never from stage names, pack data or conversation state.
 */
const stageOrder = (graph: WorkflowGraphShape): readonly string[] => {
  const incoming = new Set(graph.edges.map((edge) => edge.to));
  const position = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const ordered: string[] = [];
  const emitted = new Set<string>();
  let frontier = graph.nodes
    .filter((node: { readonly id: string }) => !incoming.has(node.id))
    .map((node: { readonly id: string }) => node.id);
  while (frontier.length > 0) {
    frontier.sort((left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0));
    const next: string[] = [];
    for (const stageId of frontier) {
      if (emitted.has(stageId)) continue;
      emitted.add(stageId);
      ordered.push(stageId);
      for (const edge of graph.edges) {
        if (edge.from === stageId && !emitted.has(edge.to) && !next.includes(edge.to))
          next.push(edge.to);
      }
    }
    frontier = next;
  }
  // A stage unreachable from the entry (a malformed graph) still gets a deterministic place.
  for (const node of graph.nodes) if (!emitted.has(node.id)) ordered.push(node.id);
  return ordered;
};

/** The permanent application identity: one Decision version ⇒ one receipt, forever. */
export const supervisorApplicationCommandId = (input: {
  readonly runId: string;
  readonly decisionId: string;
  readonly decisionVersion: number;
}): string =>
  `${SUPERVISOR_APPLICATION_COMMAND_PREFIX}:${input.runId}:${input.decisionId}@${String(input.decisionVersion)}`;

/**
 * A fingerprint over the durable state that decides whether the autonomous run is making
 * progress. It uses IDENTITIES only (revision, task states, decision ids) — never semantic
 * similarity (§47).
 */
const progressFingerprintOf = (input: {
  readonly run: WorkflowRun;
  readonly tasks: readonly Task[];
  readonly decisionIds: readonly string[];
}): string =>
  sha256Hex(
    JSON.stringify({
      purpose: 'autonomous.progress',
      runId: input.run.id,
      revision: input.run.revision,
      state: input.run.state,
      tasks: input.tasks.map((task) => `${task.id}:${task.state}:${String(task.attempts)}`).sort(),
      decisions: [...input.decisionIds].sort(),
    }),
  );

/** Read every row of a paged store (the stores page; the orchestrator needs the whole set). */
const readAll = async <T>(store: PagedStore<T>): Promise<T[]> => {
  const pageSize = 500;
  const collected: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await store.list({ limit: pageSize, offset });
    for (const item of page.items) collected.push(item);
    if (offset + pageSize >= page.total) break;
  }
  return collected;
};

/**
 * THE ONE canonical stage-dependency rule (Sprint21 final + S9B-A): a stage may execute
 * only when EVERY direct predecessor stage has terminal-successful work — all tasks
 * terminal, at least one DONE — read from the pinned DAG and current durable task rows.
 * Shared by the work-unit selection (`nextWorkUnit`) and by the corrective application
 * (which executes a provisioned root directly and must not dispatch it into a stage whose
 * predecessors the provisioning unit itself may have re-opened), so the two seams can
 * never disagree about readiness.
 */
const stageReadyCheckerOf = (
  edges: readonly { readonly from: string; readonly to: string }[],
  runTasks: readonly { readonly stageId: string; readonly state: TaskState }[],
): ((stageId: string) => boolean) => {
  const predecessorsOf = new Map<string, string[]>();
  for (const edge of edges) {
    const list = predecessorsOf.get(String(edge.to)) ?? [];
    list.push(String(edge.from));
    predecessorsOf.set(String(edge.to), list);
  }
  return (stageId: string): boolean => {
    for (const predecessor of predecessorsOf.get(stageId) ?? []) {
      const predTasks = runTasks.filter((task) => String(task.stageId) === predecessor);
      if (predTasks.length === 0) return false;
      if (predTasks.some((task) => !TERMINAL_TASK_STATES.includes(task.state))) return false;
      if (!predTasks.some((task) => task.state === 'DONE')) return false;
    }
    return true;
  };
};

/**
 * F1 closure (release-blocker re-audit) — the DURABLE illegal-proposal budget (pure form).
 *
 * A supervisor turn that ended in an ILLEGAL PROPOSAL (a semantic rejection by
 * validateProposal) left a FAILED AgentExecution of the supervisor identity with errorKind
 * INVALID_OUTPUT; a LEGAL turn's execution either COMPLETED or is proven DECISION-BEARING
 * BY EXACT IDENTITY (the Decision payload carries its own executionId — the frozen Task-18-08
 * crash window). The budget is the TRAILING run of such failures, walking newest-first and
 * stopping at the first legal turn — so it survives restarts and CANNOT reset between
 * autonomy calls, while a legal turn durably resets it.
 *
 * F5-A — exact identity, NEVER the traceId: one autonomy call shares ONE traceId across ALL
 * of its turns, so a trace match proves nothing. A Decision from a DIFFERENT turn must never
 * reset the budget of a refused one, and a FAILED execution must never become "legal" because
 * another turn sharing its traceId had a Decision.
 */
export const consecutiveIllegalProposalCount = (input: {
  readonly executions: readonly AgentExecution[];
  /** F5-A: the exact execution ids a durable Decision proves decision-bearing. */
  readonly decisionExecutionIds: readonly string[];
  readonly runId: string;
  readonly supervisorAgentId: string;
}): number => {
  const decided = new Set(input.decisionExecutionIds);
  const rows = input.executions
    .filter(
      (execution) =>
        execution.runId === input.runId && execution.agentId === input.supervisorAgentId,
    )
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  let count = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) continue;
    // A legal turn resets the budget:
    //   - its execution COMPLETED (the turn's own completion proves the proposal was legal), or
    //   - THIS EXACT execution carries the durable Decision (the frozen Task-18-08 crash
    //     window: the Decision is durable, the execution not yet settled), proven by the
    //     Decision payload's own executionId.
    if (row.status === 'COMPLETED') break;
    if (decided.has(row.executionId)) break;
    // An illegal proposal (the authority refused the MODEL's proposal) increments; anything
    // else (CANCELLED, INTERRUPTED, a non-INVALID_OUTPUT failure, an unsettled round) is
    // transparent to the budget, exactly as before.
    if (row.status === 'FAILED' && row.errorKind === 'INVALID_OUTPUT') count += 1;
  }
  return count;
};

/* -------------------------------------------------------------------- factory */

export function createAutonomousSupervisorRuntime(
  deps: AutonomousSupervisorRuntimeDeps,
): AutonomousSupervisorRuntime {
  const maxSupervisorTurns = deps.config?.maxSupervisorTurns ?? MAX_SUPERVISOR_TURNS;
  const maxIdleTurns = deps.config?.maxIdleTurns ?? DEFAULT_MAX_IDLE_TURNS;
  const timeoutCeiling = deps.config?.timeoutMs ?? 120_000;
  const escalationRisk = deps.config?.escalationRiskLevel ?? 'HIGH';
  const resumeDeciderId = deps.config?.resumeDeciderId ?? 'user_owner';

  /* ------------------------------------------------- next legal work unit (T) */

  const pinnedVersionOf = async (
    run: WorkflowRun,
  ): Promise<Result<WorkflowGraphShape, DomainError>> => {
    const template = await deps.templates.get(String(run.templateId));
    if (template === null) {
      return err(
        domainError('NOT_FOUND', `The template pinned by run "${run.id}" is missing.`, {
          reason: 'RUN_SNAPSHOT_TEMPLATE_MISSING',
          runId: run.id,
        }),
      );
    }
    const version = template.versions.find((entry) => entry.id === run.versionId);
    if (version === undefined) {
      return err(
        domainError('NOT_FOUND', `The version pinned by run "${run.id}" is missing.`, {
          reason: 'RUN_SNAPSHOT_VERSION_MISSING',
          runId: run.id,
        }),
      );
    }
    return ok(version.graph);
  };

  /**
   * The run's review-kind tasks (Task-18-07 authority corrective): the newest canonical review
   * verdict may come from ANY of them — a corrective round's second review is a new task.
   */
  const reviewTaskIdsOf = async (input: {
    readonly companyId: string;
    readonly runId: string;
  }): Promise<readonly string[]> => {
    const run = await deps.runs.get(input.runId);
    if (run === null) return [];
    const graph = await pinnedVersionOf(run);
    if (!graph.ok) return [];
    // Sprint21 corrective: finding ANCHORS are every task of the pinned graph — canonical
    // findings are produced through the frozen findings contract (the envelope kind a
    // trusted executor emits), never through a stage-class classification. A task with no
    // findings simply has no report; the newest-report-wins rule is unchanged.
    // T20-03A: run ownership FIRST (only this run's rows are even loaded); pinned-stage
    // membership below is graph legality, never ownership.
    const tasks = await deps.tasks.listByRun(input.runId);
    const pinned = new Set(graph.value.nodes.map((node) => node.id));
    return tasks
      .filter((task) => pinned.has(String(task.stageId)))
      .map((task) => task.id);
  };

  /**
   * The next legal work unit, PHASE-AWARE (Task-18-07 corrective, PRODUCTION_TURN_TWO_DEFECT).
   *
   * EXECUTING is the run's execution phase: its unit goes through the engine's atomic stage
   * execution. REVIEWING and VALIDATING are the phases whose tasks are agent units — the
   * engine's stage execution can only ever terminate with `EXECUTION.COMPLETE`, which is illegal
   * from either of them, so those tasks run through the trusted pinned-agent path instead.
   * Any other state (REWORK, FINALIZING, terminal) has no legal unit here.
   */
  /**
   * Sprint21 (generic orchestration): advance a gate PHASE that has no gate-class work.
   * Returns the applied effect string, or null when the phase is not an empty gate
   * (the caller then keeps its normal stop semantics). REVIEWING with no review-class
   * stage in the pinned graph dispatches an idempotent REVIEW.PASS (there is genuinely
   * no review work — a deterministic fact of the frozen graph). VALIDATING with no
   * validation-class stage runs the pinned business validators through the ONE
   * ValidationService (command id anchors stage+artifact; replay is the service's own
   * permanent idempotency) or stops with `validation_requirements_missing` when the
   * graph declares no validator requirements / lacks the ADR-0020 artifact anchors —
   * a safe human stop, never a faked PASS.
   */
  const advanceGatePhase = async (input: {
    readonly run: WorkflowRun;
    readonly actorId: string;
    readonly traceId: string | undefined;
  }): Promise<Result<{ readonly effect: string } | null, DomainError>> => {
    const graph = await pinnedVersionOf(input.run);
    if (!graph.ok) return graph;
    const nodes = graph.value.nodes as readonly {
      readonly id: string;
      readonly kind?: string;
      readonly config?: Record<string, unknown>;
    }[];
    const runTasks = await deps.tasks.listByRun(input.run.id);

    if (input.run.state === 'EXECUTING') {
      /*
       * F1 closure - the EXECUTING gate: when EVERY pinned stage's work is terminal-
       * successful (e.g. the corrective round completed), the execution phase must
       * advance to the gates - the engine's own EXECUTION.COMPLETE. Without this, a
       * run whose corrective round completed outside a fresh stage execution spins on
       * CONTINUE turns forever (no runnable unit, no gate advance, no re-validation).
       */
      const pinned = new Set(nodes.map((node) => String(node.id)));
      const inGraph = deps.tasks.listByRun
        ? (await deps.tasks.listByRun(input.run.id)).filter((task) => pinned.has(String(task.stageId)))
        : [];
      if (inGraph.length > 0) {
        const allTerminal = inGraph.every((task) => TERMINAL_TASK_STATES.includes(task.state));
        const anyDone = inGraph.some((task) => task.state === 'DONE');
        if (allTerminal && anyDone) {
          const completed = await deps.engine.dispatch({
            commandId: `generic-gate:${String(input.run.id)}:${String(input.run.revision)}:execution:complete`,
            runId: input.run.id,
            type: 'EXECUTION.COMPLETE',
            expectedRevision: input.run.revision,
            actorId: input.actorId,
            traceId: input.traceId ?? `generic-gate:${String(input.run.id)}`,
            issuedAt: deps.clock.nowIso(),
          });
          if (!completed.ok) {
            return err(completed.error ?? domainError('PERSISTENCE_FAILED', 'EXECUTION.COMPLETE was refused.'));
          }
          return ok({ effect: 'gate:execution:complete' });
        }
      }
      return ok(null);
    }

    if (input.run.state === 'REVIEWING') {
      /*
       * Sprint21 final corrective: the REVIEW gate advances by a deterministic gate-skip
       * whenever the evidence applicator has no actionable finding left to apply — it ran
       * at the loop head, so any durable CHANGES_REQUESTED/PASS report has already fired
       * REVIEW.REJECT/PASS. No stage class, no review-task requirement: findings are
       * canonical sink truth any trusted executor may produce.
       */
      const passed = await deps.engine.dispatch({
        commandId: `generic-gate:${String(input.run.id)}:${String(input.run.revision)}:review:no-review-work`,
        runId: input.run.id,
        type: 'REVIEW.PASS',
        expectedRevision: input.run.revision,
        actorId: input.actorId,
        traceId: input.traceId ?? `generic-gate:${String(input.run.id)}`,
        issuedAt: deps.clock.nowIso(),
        reason: 'no review-class stage is declared in the pinned graph',
      });
      if (!passed.ok) return err(passed.error ?? domainError('PERSISTENCE_FAILED', 'REVIEW.PASS was refused.'));
      return ok({ effect: 'gate:review:no-review-work' });
    }

    if (input.run.state === 'VALIDATING') {
      // The pinned validators (node config validatorIds) with a durable anchor —
      // validator-Id-driven, never stage-class-driven.
      const validatorStages = nodes.filter(
        (node) => Array.isArray(node.config?.['validatorIds']) && (node.config['validatorIds'] as unknown[]).length > 0,
      );
      if (validatorStages.length === 0) {
        return err(
          domainError('CONFLICT', 'The pinned graph declares no validator requirements; the frozen evidence gate cannot prove a PASS.', {
            reason: 'GENERIC_VALIDATION_REQUIREMENTS_MISSING',
            runId: input.run.id,
          }),
        );
      }
      if (deps.validationRunner === undefined) {
        return err(
          domainError('PERSISTENCE_FAILED', 'Orchestrator-driven validation is not wired; refusing to guess.', {
            reason: 'GENERIC_VALIDATION_RUNNER_UNAVAILABLE',
            runId: input.run.id,
          }),
        );
      }
      let ranAny = false;
      for (const node of validatorStages) {
        const stageTasks = runTasks.filter((task) => String(task.stageId) === String(node.id));
        if (stageTasks.length === 0 || !stageTasks.every((task) => TERMINAL_TASK_STATES.includes(task.state))) continue;
        const subject = stageSubjectTaskOf(stageTasks);
        if (subject === null) continue;
        const envelope = stageOutputOf(subject);
        if (!envelope.ok) return envelope;
        const artifactRef = (envelope.value?.artifactRefs ?? [])[0];
        if (artifactRef === undefined) continue; // no durable anchor for this stage yet
        const validatorIds = (node.config!['validatorIds'] as readonly unknown[]).map(String);
        const validated = await deps.validationRunner.run({
          commandId: `generic-validation:${String(input.run.id)}:${String(node.id)}:${String(artifactRef)}`,
          runId: input.run.id,
          stageId: String(node.id),
          taskId: String(subject.id),
          targetRef: `artifact:${String(artifactRef)}`,
          validators: validatorIds.map((validatorId) => ({ validatorId, blocking: true })),
          actorId: input.actorId,
          traceId: input.traceId ?? `generic-validation:${String(input.run.id)}`,
        });
        if (!validated.ok) return validated;
        ranAny = true;
      }
      // Durable batches (ours or earlier ones) now drive the evidence applicator next
      // turn; if nothing was runnable there is nothing to advance yet.
      return ok({ effect: ranAny ? 'gate:validation:orchestrator-run' : 'gate:validation:awaiting-evidence' });
    }

    return ok(null);
  };

  const nextWorkUnit = async (input: {
    readonly companyId: string;
    readonly runId: string;
  }): Promise<
    Result<
      | {
          readonly phase: 'executing' | 'reviewing' | 'validating';
          readonly stageId: StageId;
          readonly taskIds: readonly TaskId[];
        }
      | null,
      DomainError
    >
  > => {
    const run = await deps.runs.get(input.runId);
    if (run === null || run.companyId !== input.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: input.runId,
        }),
      );
    }
    const graph = await pinnedVersionOf(run);
    if (!graph.ok) return graph;
    const pinned = new Set(graph.value.nodes.map((node) => node.id));
    // T20-03A: the claim filter is RUN OWNERSHIP (only this run's rows are loaded) — the
    // pinned-set check below is graph legality only, never ownership. Same company and the
    // same pinned version do NOT make another run's task claimable.
    const tasks = await deps.tasks.listByRun(input.runId);
    const runTasks = tasks.filter((task) => pinned.has(String(task.stageId)));
    const phaseOf = (state: string): 'executing' | 'reviewing' | 'validating' | null =>
      state === 'EXECUTING'
        ? 'executing'
        : state === 'REVIEWING'
          ? 'reviewing'
          : state === 'VALIDATING'
            ? 'validating'
            : null;
    const phase = phaseOf(run.state);
    if (phase === null) return ok(null);
    /*
     * Sprint21 final corrective: THE PINNED DAG IS THE ONLY EXECUTION AUTHORITY. Every
     * Pack task — approval, inspection, compliance, verification, anything — is an
     * ordinary node of the same EXECUTING phase; there is no stage-class filter, no
     * phase pipeline and no business/gate ordering rule in this orchestrator. A candidate
     * stage may run when EVERY direct predecessor stage has terminal-successful work
     * (all tasks terminal, at least one DONE) — the DAG-true rule, no exceptions.
     * Deterministic order: the frozen topological stage order with node order as
     * tie-break. The gate phases (REVIEWING/VALIDATING) select open work with the SAME
     * DAG rule and run it through the registered agent-unit handler (found by task kind —
     * implementation registration data, never a stage class); when NO open work remains,
     * the evidence applicator's durable findings/validation rows drive the gate events
     * and the deterministic gate-skip advances an empty gate.
     */
    const predecessorsOf = new Map<string, string[]>();
    for (const edge of graph.value.edges) {
      const list = predecessorsOf.get(String(edge.to)) ?? [];
      list.push(String(edge.from));
      predecessorsOf.set(String(edge.to), list);
    }
    // The ONE canonical rule (shared with the corrective application — see
    // `stageReadyCheckerOf`): the pinned DAG verdict on a stage's predecessors.
    const stageReady = stageReadyCheckerOf(graph.value.edges, runTasks);
    for (const stageId of stageOrder(graph.value)) {
      if (!stageReady(stageId)) continue;
      const open = runTasks.filter(
        (task) => String(task.stageId) === stageId && !TERMINAL_TASK_STATES.includes(task.state),
      );
      if (open.length > 0)
        return ok({
          phase,
          stageId: stageId as StageId,
          taskIds: open.map((task) => task.id) as readonly TaskId[],
        });
    }
    return ok(null);
  };

  /* ------------------------------------------------------------- the applicator */

  const readReceipt = async (input: {
    readonly runId: string;
    readonly decisionId: string;
    readonly version: number;
  }): Promise<Result<{ readonly artifactId: string } | null, DomainError>> => {
    const row = await deps.artifactStore.getByCreationCommand(
      supervisorApplicationCommandId({
        runId: input.runId,
        decisionId: input.decisionId,
        decisionVersion: input.version,
      }),
    );
    if (row === null || row.artifact.runId !== input.runId) return ok(null);
    return ok({ artifactId: row.artifact.id });
  };

  /**
   * §39: for every Decision of a COMPLETED run that has no application receipt yet, write the
   * replay receipt. This is bookkeeping only — no transition is dispatched and no work runs.
   */
  const finalizeCompletionBookkeeping = async (
    command: RunAutonomousSupervisionCommand,
    run: { readonly id: string },
  ): Promise<void> => {
    const history = deps.decisionHistory;
    if (history === undefined) return;
    const listed = await history.listRunDecisionHistory({
      runId: run.id,
      companyId: command.companyId,
      actorId: command.actorId,
    });
    if (!listed.ok) return;
    for (const record of listed.value) {
      const receipt = await readReceipt({
        runId: run.id,
        decisionId: record.decisionId,
        version: record.version,
      });
      if (!receipt.ok || receipt.value !== null) continue;
      await writeReceipt({
        runId: run.id,
        taskId: null,
        decisionId: record.decisionId,
        version: record.version,
        action: String(record.decision),
        effect: `run:completed:replayed`,
        actorId: command.actorId,
        traceId: command.traceId ?? deps.ids.id('trace'),
      });
    }
  };

  const writeReceipt = async (input: {
    readonly runId: string;
    readonly taskId: string | null;
    readonly decisionId: string;
    readonly version: number;
    readonly action: string;
    readonly effect: string;
    readonly actorId: string;
    readonly traceId: string;
  }): Promise<Result<true, DomainError>> => {
    // Task-18-08: the action is committed and the receipt is about to be written — the crash
    // window every exactly-once application rule answers for.
    await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.decisionActionBeforeReceipt);
    const written = await deps.artifactService.create({
      commandId: supervisorApplicationCommandId({
        runId: input.runId,
        decisionId: input.decisionId,
        decisionVersion: input.version,
      }),
      runId: input.runId as WorkflowRunId,
      taskId: input.taskId as TaskId | null,
      kind: SUPERVISOR_APPLICATION_KIND,
      content: new TextEncoder().encode(
        JSON.stringify({
          schema: SUPERVISOR_APPLICATION_SCHEMA,
          runId: input.runId,
          decisionId: input.decisionId,
          decisionVersion: input.version,
          action: input.action,
          effect: input.effect,
          appliedBy: input.actorId,
          appliedAt: deps.clock.nowIso(),
        }),
      ),
      producedBy: input.actorId,
      traceId: input.traceId,
    });
    // A CONFLICT is the durable receipt already existing: that is a replay, not a failure.
    if (!written.ok && written.error.code !== 'CONFLICT') return written;
    return ok(true);
  };

  /** Execute ONE bounded work unit through the canonical engine port. */
  const executeUnit = async (input: {
    readonly run: WorkflowRun;
    readonly stageId: string;
    readonly taskIds: readonly string[];
  }): Promise<Result<string, DomainError>> => {
    const snapshot = await deps.snapshots.get(input.run.snapshotId);
    if (snapshot === null) {
      return err(
        domainError('NOT_FOUND', `Run "${input.run.id}" pins no retrievable snapshot.`, {
          reason: 'RUN_SNAPSHOT_MISSING',
          runId: input.run.id,
        }),
      );
    }
    let outcome: string;
    try {
      const executed = await deps.engine.advance({
        runId: input.run.id as never,
        stageId: input.stageId as StageId,
        taskIds: input.taskIds as readonly TaskId[],
        snapshot: { snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash },
      });
      outcome = executed.outcome;
    } catch (error) {
      // A simulated process crash (fault injection) is NOT an executor failure: it must
      // escape as a crash so the harness observes the true window boundary (§5/§6).
      if (error instanceof FaultCrashError) throw error;
      return err(
        error instanceof DomainError ? error : domainError('PERSISTENCE_FAILED', String(error)),
      );
    }
    return ok(outcome);
  };

  /**
   * REVIEWING / VALIDATING unit: each task runs ONE pinned agent round, its structured output
   * reaches the canonical sink FIRST (carrier), and only then is the task completed with that
   * output (§12 ordering: canonical sink durable → Task.outputs / Task DONE). A crash in
   * between leaves the sink without a DONE task — recoverable and idempotent — never the
   * inverse.
   */
  const runAgentUnits = async (
    input: {
      readonly companyId: string;
      readonly runId: string;
      readonly actorId: string;
      readonly traceId: string;
      readonly signal?: AbortSignal;
    },
    unit: { readonly stageId: string; readonly taskIds: readonly string[] },
  ): Promise<Result<string, DomainError>> => {
    if (deps.runAgentUnit === undefined || deps.completeTaskWithOutput === undefined) {
      return err(
        domainError(
          'PERSISTENCE_FAILED',
          'This run has REVIEWING/VALIDATING work but no trusted agent unit is wired.',
          {
            reason: 'AUTONOMOUS_AGENT_UNIT_UNAVAILABLE',
          },
        ),
      );
    }
    let completed = 0;
    for (const taskId of unit.taskIds) {
      const task = await deps.taskById(taskId);
      if (task === null || TERMINAL_TASK_STATES.includes(task.state)) continue;
      // T20-03A defense in depth: ownership is runId equality — a caller-named taskId from
      // another run (even the same stage/version/company) is refused before ANY work runs.
      if (String(task.runId) !== String(input.runId)) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            `Task "${taskId}" belongs to another run; refusing to execute it here.`,
            {
              reason: 'TASK_RUN_MISMATCH',
              taskId,
              taskRunId: String(task.runId),
              expectedRunId: String(input.runId),
            },
          ),
        );
      }
      const outcome = await deps.runAgentUnit({
        companyId: input.companyId,
        runId: input.runId,
        taskId,
        taskKind: String(task.kind),
        stageId: unit.stageId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!outcome.ok) return outcome;
      const normalized = normalizeStageHandlerResult(outcome.value);
      if (!normalized.ok) return normalized;
      if (normalized.value.status !== 'succeeded' || normalized.value.output === undefined) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            `The agent unit for task "${taskId}" produced no structured output.`,
            {
              reason: 'AUTONOMOUS_AGENT_UNIT_WITHOUT_OUTPUT',
              taskId,
            },
          ),
        );
      }
      const output = normalized.value.output;
      await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.agentExecutionBeforeHandlerOutput);
      // 1. the canonical sink is durable FIRST (its own permanent identity makes it idempotent),
      //    carrying the output the handler just produced — the task row does not have it yet
      if (deps.outputCarrier !== undefined) {
        const routed = await deps.outputCarrier.routeOutput({
          companyId: input.companyId,
          runId: input.runId,
          taskId,
          output,
          actorId: input.actorId,
          traceId: input.traceId,
        });
        if (!routed.ok) return routed;
        // Task-18-08: the canonical sink is durable but the task is NOT DONE yet — the
        // checkpoint is named by WHAT was routed, so each sink has its own provable window.
        await deps.faultCheckpoints?.checkpoint(
          routed.value !== null && routed.value.kind === VALIDATION_CANDIDATE_KIND
            ? FAULT_CHECKPOINTS.validationSinkBeforeTaskDone
            : FAULT_CHECKPOINTS.reviewSinkBeforeTaskDone,
        );
      }
      // 2. only then does the task become DONE, carrying the bounded output it produced
      const done = await deps.completeTaskWithOutput({ taskId, output });
      if (!done.ok) return done;
      completed += 1;
      /*
       * ONE agent task per Decision (the bounded serial unit, §14/§46): a phase with several
       * open tasks consumes them across turns, never in a fan-out. The denominator names the
       * unit's open tasks so the effect stays inspectable.
       */
      break;
    }
    return ok(`${String(completed)}/${String(unit.taskIds.length)}`);
  };

  /**
   * Apply ONE current, ACTIVE Decision. Every branch is a canonical service call; nothing here
   * writes a run, task or decision row directly.
   */
  const applyDecision = async (input: {
    readonly companyId: string;
    readonly run: WorkflowRun;
    readonly decision: SupervisorDecisionTurnResult;
    /** True when the turn replayed an existing Decision (no new proposal was made). */
    readonly replayedTurn: boolean;
    readonly actorId: string;
    readonly traceId: string;
    /** Sprint21 §46: the run's AbortSignal reaches the agent units too. */
    readonly signal?: AbortSignal;
  }): Promise<Result<AppliedDecision, DomainError>> => {
    const decision = input.decision;

    /* ---- the Decision must be the CURRENT ACTIVE version (§39) ---- */
    const stored = await deps.decisionReader.getDecision({
      decisionId: decision.decisionId,
      companyId: input.companyId,
      actorId: input.actorId,
    });
    if (!stored.ok) {
      // Absence is reported as NOT_FOUND by the reader; either way nothing may be applied.
      return stored;
    }
    const record = stored.value;
    if (record.status !== 'ACTIVE') {
      return err(
        domainError(
          'CONFLICT',
          `Decision "${record.decisionId}" is ${record.status}; only the current ACTIVE version may be applied.`,
          {
            reason: 'AUTONOMOUS_DECISION_NOT_CURRENT',
            decisionId: record.decisionId,
            version: record.version,
            status: record.status,
          },
        ),
      );
    }
    const version = record.version;
    const outcomeOf = (effect: string): AppliedDecision => ({
      decisionId: record.decisionId,
      version,
      action: decision.action,
      reasonCode: decision.reasonCode,
      replayed: false,
      effect,
    });

    /* ---- permanent idempotency: the receipt, not the bounded ledger (§40) ---- */
    const receipt = await readReceipt({
      runId: input.run.id,
      decisionId: record.decisionId,
      version,
    });
    if (!receipt.ok) return receipt;
    if (receipt.value !== null) {
      return ok({
        decisionId: record.decisionId,
        version,
        action: decision.action,
        reasonCode: decision.reasonCode,
        replayed: true,
        effect: `receipt:${receipt.value.artifactId}`,
      });
    }

    if (decision.action === 'CONTINUE') {
      const unit = await nextWorkUnit({ companyId: input.companyId, runId: input.run.id });
      if (!unit.ok) return unit;
      if (unit.value === null) {
        /*
         * §40: a replay of a CONTINUE decision whose work is already done is an APPLICATION
         * replay — the durable Task state is the authority. A FRESH decision with no legal
         * work remains a stop condition (§44).
         */
        if (input.replayedTurn) {
          const replayedReceipt = await writeReceipt({
            runId: input.run.id,
            taskId: null,
            decisionId: record.decisionId,
            version,
            action: decision.action,
            effect: 'stage:none:replayed',
            actorId: input.actorId,
            traceId: input.traceId,
          });
          if (!replayedReceipt.ok) return replayedReceipt;
          return ok({
            decisionId: record.decisionId,
            version,
            action: decision.action,
            reasonCode: decision.reasonCode,
            replayed: true,
            effect: 'stage:none:replayed',
          });
        }
        /*
         * Sprint21 (generic orchestration): a null unit is only a stop when the PHASE has
         * no legitimate gate semantics left. REVIEWING with NO deployment-declared
         * review-class stage in the pinned graph is a deterministic gate-skip (there is
         * no review work to do — a fact of the frozen graph, never a best effort); the
         * idempotent command carries that fact. VALIDATING with NO validation-class
         * stage either runs the pinned business validators through the ONE
         * ValidationService (orchestrator-driven validation) or — when the graph
         * declares no validator requirements at all or lacks the artifact anchors the
         * frozen ADR-0020 gate demands — stops for a human rather than faking a PASS.
         */
        const gate = await advanceGatePhase({
          run: input.run,
          actorId: input.actorId,
          traceId: input.traceId,
        });
        if (!gate.ok) return gate;
        if (gate.value !== null) {
          const written = await writeReceipt({
            runId: input.run.id,
            taskId: null,
            decisionId: record.decisionId,
            version,
            action: decision.action,
            effect: gate.value.effect,
            actorId: input.actorId,
            traceId: input.traceId,
          });
          if (!written.ok) return written;
          return ok(outcomeOf(gate.value.effect));
        }
        return err(
          domainError('CONFLICT', 'CONTINUE has no legal next work unit in this run.', {
            reason: 'AUTONOMOUS_NO_LEGAL_WORK',
            runId: input.run.id,
          }),
        );
      }
      /*
       * §40 — the crash window. The receipt is written AFTER the action, so a replay whose
       * receipt was never committed must NOT execute the work again: the durable Task state is
       * the authority for "this unit is already done". Recognizing that here is what makes the
       * application idempotent per action instead of trusting the receipt alone.
       */
      if (await unitAlreadySatisfied(unit.value.taskIds, (taskId) => deps.taskById(taskId))) {
        const replayedReceipt = await writeReceipt({
          runId: input.run.id,
          taskId: unit.value.taskIds[0] ?? null,
          decisionId: record.decisionId,
          version,
          action: decision.action,
          effect: `stage:${unit.value.stageId}:replayed`,
          actorId: input.actorId,
          traceId: input.traceId,
        });
        if (!replayedReceipt.ok) return replayedReceipt;
        return ok({
          decisionId: record.decisionId,
          version,
          action: decision.action,
          reasonCode: decision.reasonCode,
          replayed: true,
          effect: `stage:${unit.value.stageId}:replayed`,
        });
      }
      /*
       * Task-18-07 corrective (PRODUCTION_TURN_TWO_DEFECT): the execution mechanism follows the
       * run phase. EXECUTING goes through the engine's atomic stage unit; REVIEWING/VALIDATING
       * tasks run as agent units through the trusted pinned path, because the engine's stage
       * execution can only terminate with EXECUTION.COMPLETE (illegal outside EXECUTING).
       */
      if (unit.value.phase === 'executing') {
        const executed = await executeUnit({
          run: input.run,
          stageId: unit.value.stageId,
          taskIds: unit.value.taskIds,
        });
        if (!executed.ok) return executed;
        /*
         * A unit whose execution FAILED (its attempts are exhausted — the budget gate, the
         * provider or a refused handler) is NOT progress: the durable Task state says so
         * (§47 identities). The application refuses with the canonical execution reason so
         * the loop stops on an exact cause instead of reasoning on into a fabricated
         * COMPLETE. `blocked` (attempts remain) stays retryable across later invocations.
         */
        if (executed.value === 'failed') {
          return err(
            domainError(
              'CONFLICT',
              `Stage "${String(unit.value.stageId)}" exhausted its execution attempts.`,
              {
                reason: 'AUTONOMOUS_UNIT_EXECUTION_FAILED',
                runId: input.run.id,
                stageId: String(unit.value.stageId),
              },
            ),
          );
        }
        // Checkpoint C (final migration §4): Task + ExecutionAttempt canonically SETTLED;
        // the carrier has NOT routed yet — thrown raw (outside any transaction) so the
        // crash propagates exactly like the legacy agent-unit fault windows.
        await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.taskSettledBeforeCarrier);
        /*
         * Sprint21 final corrective: route EVERY executed task's durable envelope through
         * the ONE carrier. The carrier dispatches by the frozen envelope KIND contract
         * (findings-candidate / validation-candidate / work output) — so ANY trusted
         * executor's findings and validation candidates reach their canonical sinks with
         * zero stage-class knowledge here. Sinks are idempotent by permanent command id.
         */
        if (deps.outputCarrier !== undefined) {
          for (const taskId of unit.value.taskIds) {
            const routed = await deps.outputCarrier.routeTask({
              companyId: input.companyId,
              runId: input.run.id,
              taskId: String(taskId),
              actorId: input.actorId,
              traceId: input.traceId,
            });
            if (!routed.ok && routed.error.details['reason'] !== 'STAGE_OUTPUT_TASK_MISSING')
              return routed;
          }
        }
        /*
         * LIVE-SMOKE-FIX-04 — RECEIPT TRUTH: the effect suffix is derived from the
         * CANONICAL task states of the unit, never from the engine's stage outcome
         * alone. A stage whose task FAILED and was RETRYed (state READY — the next
         * supervisor turn retries it) must never earn a `stage:<id>:completed` receipt
         * for work that has not succeeded: the receipt reads `:retryable`, so no
         * scheduler/recovery/projection/UI consumer can mistake unsettled work for
         * business completion. Task/Attempt canonical state always outranks the
         * receipt; the receipt never overrides a FAILED task.
         */
        const runTasks = await deps.tasks.listByRun(input.run.id);
        const stateById = new Map(runTasks.map((row) => [String(row.id), String(row.state)]));
        const settledStates = unit.value.taskIds.map((taskId) => stateById.get(String(taskId)) ?? 'MISSING');
        const allSettledSuccessful = settledStates.length > 0 && settledStates.every((state) => state === 'DONE' || state === 'SKIPPED');
        const effectSuffix = allSettledSuccessful ? executed.value : 'retryable';
        const written = await writeReceipt({
          runId: input.run.id,
          taskId: unit.value.taskIds[0] ?? null,
          decisionId: record.decisionId,
          version,
          action: decision.action,
          effect: `stage:${unit.value.stageId}:${effectSuffix}`,
          actorId: input.actorId,
          traceId: input.traceId,
        });
        if (!written.ok) return written;
        return ok(outcomeOf(`stage:${unit.value.stageId}:${effectSuffix}`));
      }

      const agentOutcome = await runAgentUnits(
        {
          companyId: input.companyId,
          runId: input.run.id,
          actorId: input.actorId,
          traceId: input.traceId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        unit.value,
      );
      if (!agentOutcome.ok) return agentOutcome;
      const written = await writeReceipt({
        runId: input.run.id,
        taskId: unit.value.taskIds[0] ?? null,
        decisionId: record.decisionId,
        version,
        action: decision.action,
        effect: `agent:${unit.value.phase}:${unit.value.stageId}:${agentOutcome.value}`,
        actorId: input.actorId,
        traceId: input.traceId,
      });
      if (!written.ok) return written;
      return ok(outcomeOf(`agent:${unit.value.phase}:${unit.value.stageId}:${agentOutcome.value}`));
    }

    if (decision.action === 'REQUEST_CORRECTIVE') {
      // Round policy lives at the T18-05 provisioning boundary (§8/§9): the cap is enforced
      // there, so a direct provisioner call cannot bypass it either.
      const provisioned = await deps.provisioner.provision({
        companyId: input.companyId,
        runId: input.run.id,
        decisionId: record.decisionId,
        decisionVersion: version,
        actorId: input.actorId,
        traceId: input.traceId,
      });
      if (!provisioned.ok) return provisioned;
      const task = await deps.taskById(provisioned.value.taskId);
      const stageId = task === null ? null : String(task.stageId);
      if (stageId === null) {
        return err(
          domainError(
            'NOT_FOUND',
            `The provisioned corrective task "${provisioned.value.taskId}" is not readable.`,
            {
              reason: 'CORRECTIVE_TASK_MISSING',
              taskId: provisioned.value.taskId,
            },
          ),
        );
      }
      /*
       * §37: the corrective task already terminal means the work was done by the crashed
       * attempt. The provisioner's permanent identity already proved the SAME task; re-running
       * the stage would dispatch a second (illegal) lifecycle event for work that is finished.
       */
      if (
        await unitAlreadySatisfied([provisioned.value.taskId], (taskId) => deps.taskById(taskId))
      ) {
        const replayedReceipt = await writeReceipt({
          runId: input.run.id,
          taskId: provisioned.value.taskId,
          decisionId: record.decisionId,
          version,
          action: decision.action,
          effect: `corrective:${provisioned.value.taskId}:replayed`,
          actorId: input.actorId,
          traceId: input.traceId,
        });
        if (!replayedReceipt.ok) return replayedReceipt;
        return ok({
          decisionId: record.decisionId,
          version,
          action: decision.action,
          reasonCode: decision.reasonCode,
          replayed: true,
          effect: `corrective:${provisioned.value.taskId}:replayed`,
          correctiveTaskId: provisioned.value.taskId,
        });
      }
      /*
       * S9B-A — CANONICAL READINESS BEFORE DISPATCH. This application executes the
       * provisioned root DIRECTLY (not through `nextWorkUnit`'s selection), and the
       * provisioning unit it just committed may itself have re-opened a PREDECESSOR stage
       * of the root's stage — the finding's producer-stage reassessment lands in exactly
       * such a stage. Executing now would push a claim the pinned DAG already forbids:
       * the Work Package projection refuses it (WORK_PACKAGE_DEPENDENCY_NOT_READY) — a
       * not-ready precondition that must never be spent as a permanent failure.
       * Defer instead: the work stays canonical waiting (no attempt, the task stays open),
       * the receipt records the deferral, and the ordinary `nextWorkUnit`-driven steps
       * settle the predecessor first. The SAME canonical stage-dependency rule decides
       * here as in the selection (`stageReadyCheckerOf` — one implementation).
       */
      const readinessRun = await deps.runs.get(input.run.id);
      const readinessGraph = readinessRun === null ? null : await pinnedVersionOf(readinessRun);
      if (readinessGraph !== null && readinessGraph.ok) {
        const stageTasks = await deps.tasks.listByRun(input.run.id);
        if (!stageReadyCheckerOf(readinessGraph.value.edges, stageTasks)(stageId)) {
          const deferredReceipt = await writeReceipt({
            runId: input.run.id,
            taskId: provisioned.value.taskId,
            decisionId: record.decisionId,
            version,
            action: decision.action,
            effect: `corrective:${provisioned.value.taskId}:awaiting_dependencies`,
            actorId: input.actorId,
            traceId: input.traceId,
          });
          if (!deferredReceipt.ok) return deferredReceipt;
          return ok({
            ...outcomeOf(`corrective:${provisioned.value.taskId}:awaiting_dependencies`),
            correctiveTaskId: provisioned.value.taskId,
          });
        }
      }
      /*
       * Task-18-07 corrective: a corrective task is created while the run is in REWORK (the
       * review/validation failed). The engine's stage execution is only legal from EXECUTING, so
       * the run returns to execution through the canonical REWORK.READY event — the existing
       * rework semantics of the frozen state machine, applied by the trusted applicator from the
       * durable decision, never by the model and never by a test.
       */
      let runForExecution = input.run;
      if (input.run.state === 'REWORK') {
        const rework = await deps.engine.dispatch({
          commandId: `supervisor-rework:${input.run.id}:${record.decisionId}@${String(version)}`,
          runId: input.run.id,
          type: 'REWORK.READY',
          expectedRevision: input.run.revision,
          actorId: input.actorId,
          traceId: input.traceId,
          issuedAt: deps.clock.nowIso(),
          reason: `corrective work provisioned by ${record.decisionId}`,
        });
        if (!rework.ok) {
          return err(rework.error ?? domainError('PERSISTENCE_FAILED', 'REWORK.READY was refused.'));
        }
        const refreshed = await deps.runs.get(input.run.id);
        if (refreshed !== null) runForExecution = refreshed;
      }
      const executed = await executeUnit({
        run: runForExecution,
        stageId,
        taskIds: [provisioned.value.taskId],
      });
      // Task-18-08: the corrective Task is created (and executed) but its receipt is not yet
      // written — restart must reproduce the SAME task identity, parent, root and round.
      await deps.faultCheckpoints?.checkpoint(
        FAULT_CHECKPOINTS.correctiveTaskCommitBeforeReceipt,
      );
      if (!executed.ok) return executed;
      const written = await writeReceipt({
        runId: input.run.id,
        taskId: provisioned.value.taskId,
        decisionId: record.decisionId,
        version,
        action: decision.action,
        effect: `corrective:${provisioned.value.taskId}:${executed.value}`,
        actorId: input.actorId,
        traceId: input.traceId,
      });
      if (!written.ok) return written;
      return ok({
        ...outcomeOf(`corrective:${provisioned.value.taskId}:${executed.value}`),
        correctiveTaskId: provisioned.value.taskId,
      });
    }

    if (decision.action === 'COMPLETE') {
      // Re-read the completion evidence immediately before applying (§37): what was shown to
      // the model is not authority, the durable state is.
      const current = await deps.runs.get(input.run.id);
      if (current === null) {
        return err(
          domainError('NOT_FOUND', `Run "${input.run.id}" vanished before COMPLETE.`, {
            reason: 'RUN_MISSING',
          }),
        );
      }
      if (current.state !== 'FINALIZING' && current.state !== 'COMPLETED') {
        return err(
          domainError('CONFLICT', `COMPLETE is not applicable while the run is ${current.state}.`, {
            reason: 'AUTONOMOUS_COMPLETE_PRECONDITION_UNMET',
            runState: current.state,
          }),
        );
      }
      let delivered: { ok: boolean; error?: DomainError };
      try {
        delivered = await deps.engine.dispatch({
          commandId: `supervisor-deliver:${input.run.id}:${record.decisionId}@${String(version)}`,
          runId: input.run.id,
          type: 'DELIVERY.COMPLETE',
          expectedRevision: current.revision,
          actorId: input.actorId,
          traceId: input.traceId,
          issuedAt: deps.clock.nowIso(),
          reason: `${decision.action}:${decision.reasonCode}`,
        });
      } catch (error) {
        return err(
          error instanceof DomainError ? error : domainError('PERSISTENCE_FAILED', String(error)),
        );
      }
      if (!delivered.ok) {
        return err(
          delivered.error ?? domainError('PERSISTENCE_FAILED', 'DELIVERY.COMPLETE was refused.'),
        );
      }
      const written = await writeReceipt({
        runId: input.run.id,
        taskId: null,
        decisionId: record.decisionId,
        version,
        action: decision.action,
        effect: 'run:completed',
        actorId: input.actorId,
        traceId: input.traceId,
      });
      if (!written.ok) return written;
      return ok(outcomeOf('run:completed'));
    }

    // ESCALATE: the durable human wait is the EXISTING approval seam — a pending Approval row
    // plus Run.state = WAITING_APPROVAL, from which no legal run event continues work.
    const current = await deps.runs.get(input.run.id);
    if (current === null) {
      return err(
        domainError('NOT_FOUND', `Run "${input.run.id}" vanished before ESCALATE.`, {
          reason: 'RUN_MISSING',
        }),
      );
    }
    /*
     * §38: the durable canonical state is the authority. A run already waiting for a human has
     * exactly one pending Approval, so a replay whose receipt was never committed must not
     * request a second one — it finalizes the bookkeeping instead.
     */
    if (current.state === 'WAITING_APPROVAL') {
      const replayedReceipt = await writeReceipt({
        runId: input.run.id,
        taskId: null,
        decisionId: record.decisionId,
        version,
        action: decision.action,
        effect: 'run:waiting_approval:replayed',
        actorId: input.actorId,
        traceId: input.traceId,
      });
      if (!replayedReceipt.ok) return replayedReceipt;
      return ok({
        decisionId: record.decisionId,
        version,
        action: decision.action,
        reasonCode: decision.reasonCode,
        replayed: true,
        effect: 'run:waiting_approval:replayed',
      });
    }
    let requested: { ok: boolean; error?: DomainError };
    try {
      requested = await deps.engine.dispatch({
        commandId: `supervisor-escalate:${input.run.id}:${record.decisionId}@${String(version)}`,
        runId: input.run.id,
        type: 'APPROVAL.REQUEST',
        expectedRevision: current.revision,
        actorId: input.actorId,
        traceId: input.traceId,
        issuedAt: deps.clock.nowIso(),
        reason: `${decision.action}:${decision.reasonCode}`,
        payload: { riskLevel: escalationRisk },
      });
    } catch (error) {
      return err(
        error instanceof DomainError ? error : domainError('PERSISTENCE_FAILED', String(error)),
      );
    }
    if (!requested.ok) {
      return err(
        requested.error ?? domainError('PERSISTENCE_FAILED', 'APPROVAL.REQUEST was refused.'),
      );
    }
    const written = await writeReceipt({
      runId: input.run.id,
      taskId: null,
      decisionId: record.decisionId,
      version,
      action: decision.action,
      effect: 'run:waiting_approval',
      actorId: input.actorId,
      traceId: input.traceId,
    });
    if (!written.ok) return written;
    return ok(outcomeOf('run:waiting_approval'));
  };

  /* -------------------------------------------------------------- the loop */

  const run = async (
    command: RunAutonomousSupervisionCommand,
  ): Promise<Result<AutonomousSupervisionOutcome, DomainError>> => {
    if (typeof command.runIdentity !== 'string' || command.runIdentity.trim() === '') {
      return err(
        domainError('INVALID_ARGUMENT', 'An autonomous run needs a trusted identity.', {
          reason: 'AUTONOMOUS_IDENTITY_REQUIRED',
        }),
      );
    }
    const timeoutMs = Math.min(command.timeoutMs ?? timeoutCeiling, timeoutCeiling);
    const traceId = command.traceId ?? deps.ids.id('trace');

    /* One AbortSignal + one deadline cover the WHOLE run (§49). */
    const controller = new AbortController();
    const abortRun = (reason: DomainError): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const releaseTimer = deps.timer(timeoutMs, () =>
      abortRun(
        domainError('TIMEOUT', `The autonomous run exceeded its ${String(timeoutMs)}ms bound.`, {
          reason: 'AUTONOMOUS_RUN_TIMEOUT',
          timeoutMs,
        }),
      ),
    );
    const caller = command.signal;
    const onCallerAbort = (): void =>
      abortRun(
        domainError('CANCELLED', 'The autonomous run was cancelled.', {
          reason: 'AUTONOMOUS_RUN_CANCELLED',
          kind: 'CANCELLED',
        }),
      );
    if (caller !== undefined) {
      if (caller.aborted) onCallerAbort();
      else caller.addEventListener('abort', onCallerAbort, { once: true });
    }
    const abortReason = (): 'cancelled' | 'timeout' => {
      const reason = controller.signal.reason;
      return reason instanceof DomainError && reason.code === 'TIMEOUT' ? 'timeout' : 'cancelled';
    };

    const applied: AppliedDecision[] = [];
    const outcome = (input: {
      readonly stopReason: AutonomousStopReason;
      readonly turns: number;
      readonly lastDecision: SupervisorDecisionTurnResult | null;
      readonly progressFingerprint: string;
    }): AutonomousSupervisionOutcome => ({
      runId: command.runId,
      stopReason: input.stopReason,
      turns: input.turns,
      applied,
      lastDecision: input.lastDecision,
      progressFingerprint: input.progressFingerprint,
      replayed: applied.length > 0 && applied.every((entry) => entry.replayed),
    });

    try {
      let lastDecision: SupervisorDecisionTurnResult | null = null;
      let progressFingerprint = '';
      let idleTurns = 0;
      let turnIndex = 0;
      let consecutiveEvidence = 0;
      /*
       * F1 closure (release-blocker re-audit): the ILLEGAL-PROPOSAL BUDGET is CANONICAL —
       * derived from durable rows, so it cannot reset between autonomy calls (an in-call
       * counter could: a caller that retries would get a fresh budget each time). A
       * supervisor turn that ended in an illegal proposal left a FAILED AgentExecution
       * (INVALID_OUTPUT) of the supervisor identity whose traceId matches NO recorded
       * Decision; a legal turn's execution either completed or shares its traceId with its
       * Decision. Counting the TRAILING run of such failures under the supervisor identity
       * is the durable form of "consecutive illegal proposals".
       */
      const consecutiveIllegalProposals = async (runId: string): Promise<number> => {
        return consecutiveIllegalProposalCount({
          executions: await readAll(deps.executions),
          decisionExecutionIds: [...(await decisionBearingExecutionIds(runId))],
          runId,
          supervisorAgentId: deps.supervisorAgentId ?? 'supervisor-runtime',
        });
      };
      /**
       * F5-A single-flight/budget arbitration (EXACT IDENTITY): the set of AgentExecution ids a
       * durable Decision proves decision-bearing — read from the Decision payload's own
       * `executionId`, never from the run-level traceId (ONE autonomy call shares ONE trace
       * across ALL of its turns). A decision-bearing in-flight round replays by command
       * identity with zero model calls, so single-flight must not block it (the frozen
       * Task-18-08 crash-window restart contract); a DIFFERENT turn's Decision sharing the
       * trace proves nothing and blocks nothing.
       */
      const decisionBearingExecutionIds = async (runId: string): Promise<Set<string>> => {
        const ids = new Set<string>();
        if (deps.decisionHistory === undefined) return ids;
        const history = await deps.decisionHistory.listRunDecisionHistory({
          runId,
          companyId: command.companyId,
          actorId: command.actorId,
        });
        if (history.ok) {
          for (const record of history.value) {
            const payload = supervisorDecisionPayloadOf(record);
            if (payload?.executionId != null) ids.add(payload.executionId);
          }
        }
        return ids;
      };
      /*
       * The SUBJECT of each turn: the task the Decision concerns, which is the task the run is
       * delivering. It starts as the task the trusted caller named and advances only when a
       * REQUEST_CORRECTIVE application provisions a NEW corrective task — so a second round's
       * corrective decision concerns the task the latest review report reported on. It is never
       * an instrumental review/QA task: those tasks carry findings ABOUT other tasks, and a
       * Decision about them would be refused as concerning a foreign subject (T18-06).
       */
      let subjectTaskId = command.taskId;
      const reviewTaskId: string | null = command.reviewTaskId ?? null;

      for (; turnIndex < maxSupervisorTurns; turnIndex += 1) {
        // The counter is checked BEFORE every turn: there is no unbounded loop (§46).
        if (controller.signal.aborted) {
          return ok(
            outcome({
              stopReason: abortReason(),
              turns: turnIndex,
              lastDecision,
              progressFingerprint,
            }),
          );
        }

        const run0 = await deps.runs.get(command.runId);
        if (run0 === null) {
          return err(
            domainError('NOT_FOUND', `Run "${command.runId}" does not exist.`, {
              reason: 'RUN_MISSING',
            }),
          );
        }
        /* ---- a run waiting for a human never executes autonomously (§31/§54) ---- */
        if (run0.state === 'WAITING_APPROVAL') {
          return ok(
            outcome({
              stopReason: 'escalated',
              turns: turnIndex,
              lastDecision,
              progressFingerprint,
            }),
          );
        }
        /*
         * A PAUSED run never executes autonomously either — PAUSED is the machine's own
         * human-held state (its RESUME is "never automatic" by contract), including the
         * REWORK_EXHAUSTED stop below. Stopping HERE means a restart makes no model call at
         * all: the durable state alone is the stop.
         */
        if (run0.state === 'PAUSED') {
          return ok(
            outcome({
              stopReason: 'human_required',
              turns: turnIndex,
              lastDecision,
              progressFingerprint,
            }),
          );
        }
        /*
         * Task-18-07 corrective (PRODUCTION_TURN_TWO_DEFECT, restart resume): apply whatever the
         * canonical evidence already implies BEFORE the next turn reasons. This is what advances a
         * restarted run past a crash that landed after the canonical sink was durable but before
         * the lifecycle event (§29/§30), and what carries REVIEWING → VALIDATING → FINALIZING.
         * Each applied event re-enters the loop, so the next turn always sees fresh state.
         */
        /*
         * Sprint21 final — CARRIER-BEFORE-READINESS: every already-settled task's
         * durable envelope is reconciled through the ONE carrier (idempotent) BEFORE
         * evidence application and any next ready selection, closing the
         * producer-DONE → finding-not-yet-routed window.
         */
        if (deps.outputCarrier !== undefined) {
          for (const settled of await deps.tasks.listByRun(run0.id)) {
            if (settled.state !== 'DONE') continue;
            const routed = await deps.outputCarrier.routeTask({
              companyId: command.companyId,
              runId: run0.id,
              taskId: String(settled.id),
              actorId: command.actorId,
              traceId,
            });
            if (!routed.ok && routed.error.details['reason'] !== 'STAGE_OUTPUT_TASK_MISSING')
              return routed;
          }
        }
        if (deps.evidenceApplicator !== undefined) {
          // The review task the CALLER named is the anchor; the composition's own default is the
          // fallback. A stage-to-review-task mapping is never guessed. The run's review-kind
          // tasks ride along, so a round-two verdict cannot hide behind a consumed round-one one.
          const anchorReviewTaskId = reviewTaskId ?? deps.reviewTaskId ?? null;
          const reviewAnchors = await reviewTaskIdsOf({
            companyId: command.companyId,
            runId: run0.id,
          });
          const transition = await deps.evidenceApplicator.applyEvidence({
            companyId: command.companyId,
            runId: run0.id,
            ...(anchorReviewTaskId === null ? {} : { reviewTaskId: anchorReviewTaskId }),
            reviewTaskIds: reviewAnchors,
            actorId: command.actorId,
            traceId,
          });
          if (!transition.ok) return transition;
          if (transition.value !== null) {
            consecutiveEvidence += 1;
            // A bounded chain of evidence-driven events without a reasoning turn is a trusted
            // invariant failure, never an unbounded state walk.
            if (consecutiveEvidence > MAX_CONSECUTIVE_EVIDENCE_EVENTS) {
              return ok(
                outcome({
                  stopReason: 'invariant_failure',
                  turns: turnIndex,
                  lastDecision,
                  progressFingerprint,
                }),
              );
            }
            continue;
          }
        }
        consecutiveEvidence = 0;
        /* ---- the run ended without a COMPLETE decision (§44) ---- */
        if (RUN_TERMINAL_STATES.includes(run0.state)) {
          if (run0.state === 'COMPLETED' && deps.decisionHistory !== undefined) {
            // §39: a COMPLETE whose receipt was never committed still finalizes its
            // bookkeeping — read from durable history, never by re-dispatching a transition.
            await finalizeCompletionBookkeeping(command, run0);
          }
          return ok(
            outcome({
              stopReason: run0.state === 'COMPLETED' ? 'completed' : 'non_retryable_failure',
              turns: turnIndex,
              lastDecision,
              progressFingerprint,
            }),
          );
        }
        /* ---- a CANCELLED attempt is terminal: never re-enter it automatically (§28/§48) ---- */
        const executions = await readAll(deps.executions);
        const cancelled = executions.find(
          (execution) => execution.runId === command.runId && execution.errorKind === 'CANCELLED',
        );
        if (cancelled !== undefined) {
          return ok(
            outcome({
              stopReason: 'cancelled',
              turns: turnIndex,
              lastDecision,
              progressFingerprint,
            }),
          );
        }

        /*
         * F5 — SINGLE-FLIGHT: one in-flight supervisor round per run. A supervisor
         * execution that is durably RUNNING owns this run's reasoning window: this loop
         * (and any concurrent advance of the same run) must NOT start an overlapping
         * equivalent round.
         *
         * ARBITRATION EXCEPTION (the frozen Task-18-08 crash-window contract), F5-A EXACT
         * IDENTITY: an execution whose OWN Decision is durable has an authoritative replay
         * — `runOneSupervisorDecisionTurn` finds it by command identity and returns without
         * any model call — so a replay of a decision-bearing round is NOT a second external
         * round and must not be blocked. The proof is the Decision payload's `executionId`
         * matching THIS execution — NEVER the traceId: one autonomy call shares ONE trace
         * across ALL of its turns, so a trace match could authorize a NEWER RUNNING round
         * with an OLDER turn's Decision (the F5-A bypass). Only a genuinely decision-less
         * in-flight round (the F5 burst shape: no Decision can ever be found for it, so
         * every step would re-run the model) yields the typed supervisor_inflight stop.
         */
        const inflightSupervisorRows = executions.filter(
          (execution) =>
            execution.runId === command.runId &&
            execution.agentId === (deps.supervisorAgentId ?? 'supervisor-runtime') &&
            execution.status === 'RUNNING',
        );
        let inflightSupervisor: AgentExecution | undefined;
        if (inflightSupervisorRows.length > 0) {
          /*
           * 9dc9943 — LIVE RECONCILIATION (settlement only; ZERO provider calls). Before
           * blocking as supervisor_inflight, each RUNNING supervisor row is classified
           * against DURABLE truth:
           *   C. outcome-COMMITTED but not terminally converged → converge COMPLETED;
           *   B. past its DURABLE decision-authority expiry → canonical TIMEOUT settlement
           *      (the deadline won; its settlement storage may have been unavailable then);
           *   A. genuinely live and unexpired → in flight (blocks).
           * B/C settle through the EXISTING AgentRuntime arbiter — reconciliation inside
           * the existing driver/runtime progression, never a second scheduler.
           */
          const nowIso = deps.clock.nowIso();
          let settledAny = false;
          /*
           * 25b98d1/N25-R1 — reconciliation is SETTLEMENT ONLY and its failures are
           * TYPED: a transient persistence failure here leaves the run as a recoverable
           * PERSISTENCE_FAILED outcome (the launcher keeps the progression owner), never
           * an unhandled raw throw.
           */
          try {
          for (const row of inflightSupervisorRows) {
            const committed =
              row.outcomeCommittedAt !== null && row.outcomeCommittedAt !== undefined;
            const expired =
              typeof row.decisionAuthorityExpiresAt === 'string' &&
              row.decisionAuthorityExpiresAt !== '' &&
              row.decisionAuthorityExpiresAt <= nowIso;
            if (committed && deps.agentRuntime !== undefined) {
              await deps.agentRuntime.completeExecution({
                executionId: row.executionId,
                actorId: command.actorId,
                resultRef: null,
                artifacts: [],
              });
              settledAny = true;
              continue;
            }
            if (!committed && expired && deps.agentRuntime !== undefined) {
              await deps.agentRuntime.failExecution({
                executionId: row.executionId,
                actorId: command.actorId,
                error: normalizeExecutionError({
                  kind: 'TIMEOUT',
                  code: 'TIMEOUT',
                  message: `The supervisor execution exceeded its durable decision-authority expiry (${row.decisionAuthorityExpiresAt}).`,
                  details: {
                    reason: 'DECISION_AUTHORITY_EXPIRED',
                    executionId: row.executionId,
                    decisionAuthorityExpiresAt: row.decisionAuthorityExpiresAt,
                  },
                }),
              });
              settledAny = true;
              continue;
            }
            inflightSupervisor = inflightSupervisor ?? row;
          }
          } catch (error) {
            return err(
              domainError(
                'PERSISTENCE_FAILED',
                `Live reconciliation could not persist its settlement: ${error instanceof Error ? error.message : String(error)}`,
                { reason: 'RECONCILIATION_PERSISTENCE_FAILED', runId: command.runId },
              ),
            );
          }
          if (settledAny) {
            // Re-read durable truth: only a genuinely live, unexpired row may block.
            const refreshed = await readAll(deps.executions);
            inflightSupervisor = refreshed.find(
              (execution) =>
                execution.runId === command.runId &&
                execution.agentId === (deps.supervisorAgentId ?? 'supervisor-runtime') &&
                execution.status === 'RUNNING',
            );
          }
        }
        if (inflightSupervisor !== undefined) {
          return ok(
            outcome({
              stopReason: 'supervisor_inflight',
              turns: turnIndex,
              lastDecision,
              progressFingerprint,
            }),
          );
        }

        const turn = await deps.supervisorRuntime.runOneSupervisorDecisionTurn({
          companyId: command.companyId,
          runId: command.runId,
          taskId: subjectTaskId,
          ...(reviewTaskId === null ? {} : { reviewTaskId }),
          actorId: command.actorId,
          // The turn identity follows the T18-06 command grammar (`supervisor-decision:`),
          // so every turn of the run has its OWN permanent decision identity and a replay of
          // the same run+turn index reuses the same decision.
          commandId: `supervisor-decision:${command.runId}:${command.runIdentity}:${String(turnIndex)}`,
          traceId,
          signal: controller.signal,
          timeoutMs,
        });
        if (controller.signal.aborted) {
          // Already-committed durable state stays; nothing new is started (§50).
          return ok(
            outcome({
              stopReason: abortReason(),
              turns: turnIndex + 1,
              lastDecision,
              progressFingerprint,
            }),
          );
        }
        if (!turn.ok) {
          const reason = String(turn.error.details['reason'] ?? '');
          if (
            reason === 'RUN_GOAL_MISSING' ||
            reason === 'RUN_SNAPSHOT_MISSING' ||
            reason === 'RUN_BINDING_MISSING'
          ) {
            return err(turn.error);
          }
          /*
           * 25b98d1 — the ATOMIC ADMISSION CLAIM was lost to a concurrent owner:
           * this is the typed in-flight stop, never an illegal proposal (zero
           * provider calls happened — the claim precedes any invocation).
           */
          if (reason === 'SUPERVISOR_TURN_SETTLED_WITHOUT_DECISION') {
            /*
             * 6ec4d81 — the turn's owner already settled without a Decision: never reason
             * the same logical turn again. The loop advances (turnIndex + 1 = a NEW
             * logicalTurnId); the workflow progression decides whether another cycle is
             * needed at all.
             */
            continue;
          }
          if (reason === 'SUPERVISOR_TURN_ALREADY_OWNED') {
            return ok(
              outcome({
                stopReason: 'supervisor_inflight',
                turns: turnIndex,
                lastDecision,
                progressFingerprint,
              }),
            );
          }
          // F1 closure: an illegal proposal (semantic rejection by the authority) is counted
          // from DURABLE rows; a legal turn resets the budget (its own durable turn). Reaching
          // the bound is an EXPLICIT typed terminal - the corrective window is not actionable
          // by this model - never an unbounded budget drain and never a fake CONTINUE
          // reinterpretation. The just-failed turn is already durable when it is counted.
          const illegalProposal =
            turn.error.code === 'VALIDATION_FAILED' && reason.startsWith('SUPERVISOR_PROPOSAL_');
          if (illegalProposal) {
            const illegal = await consecutiveIllegalProposals(command.runId);
            if (illegal >= MAX_CONSECUTIVE_INVALID_TURNS) {
              return err(
                domainError(
                  'VALIDATION_FAILED',
                  `The supervisor produced ${String(illegal)} consecutive illegal proposals; the corrective window is not actionable by the model.`,
                  { reason: 'SUPERVISOR_INVALID_ACTIONS_EXHAUSTED' },
                ),
              );
            }
          }
          return ok(
            outcome({
              stopReason: 'invariant_failure',
              turns: turnIndex + 1,
              lastDecision,
              progressFingerprint,
            }),
          );
        }
        lastDecision = turn.value;

        const appliedNow = await applyDecision({
          companyId: command.companyId,
          run: run0,
          decision: turn.value,
          replayedTurn: turn.value.replayed === true,
          actorId: command.actorId,
          traceId,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return ok(
            outcome({
              stopReason: abortReason(),
              turns: turnIndex + 1,
              lastDecision,
              progressFingerprint,
            }),
          );
        }
        if (!appliedNow.ok) {
          const reason = String(appliedNow.error.details['reason'] ?? '');
          if (reason === 'CORRECTIVE_ROUND_LIMIT_EXCEEDED') {
            /*
             * Round exhaustion becomes a human-required outcome, never a silent COMPLETE (§10)
             * and never a generic `error`. The DURABLE state — read fresh, because what was
             * shown to the model is not authority (§37) — decides which frozen-machine event
             * legally records the same PAUSED human stop:
             *   REWORK — the gate flow the run re-entered through REVIEW.REJECT /
             *     VALIDATION.FAIL — lands its dedicated event: REWORK.EXHAUST (→ PAUSED).
             *   EXECUTING — Sprint21 generic orchestration: the immediate corrective cycle runs
             *     INSIDE the pinned DAG (legal units still exist ahead), so the machine is in
             *     its execution phase; the legal human stop there is PAUSE (PAUSABLE → PAUSED).
             * Either way the run reaches the SAME durable PAUSED: a later invocation makes ZERO
             * model turns on it, and the trusted RUN.RESUME is the one and only way on.
             */
            const live = (await deps.runs.get(run0.id)) ?? run0;
            if (live.state === 'REWORK') {
              const exhausted = await deps.engine.dispatch({
                commandId: `supervisor-exhausted:${live.id}:${turn.value.decisionId}`,
                runId: live.id,
                type: 'REWORK.EXHAUST',
                expectedRevision: live.revision,
                actorId: command.actorId,
                traceId,
                issuedAt: deps.clock.nowIso(),
                reason: `corrective rounds exhausted at ${turn.value.decisionId}`,
              });
              if (!exhausted.ok) {
                return err(
                  exhausted.error ??
                    domainError('PERSISTENCE_FAILED', 'REWORK_EXHAUSTED was refused.'),
                );
              }
            } else if (canRunTransition('PAUSE', live.state)) {
              const paused = await deps.engine.dispatch({
                commandId: `supervisor-round-limit:${live.id}:${turn.value.decisionId}`,
                runId: live.id,
                type: 'RUN.PAUSE',
                expectedRevision: live.revision,
                actorId: command.actorId,
                traceId,
                issuedAt: deps.clock.nowIso(),
                reason: `corrective rounds exhausted at ${turn.value.decisionId}`,
              });
              if (!paused.ok) {
                return err(
                  paused.error ?? domainError('PERSISTENCE_FAILED', 'RUN_PAUSE was refused.'),
                );
              }
            }
            // Task-18-08: the durable human stop is committed; the orchestrator has not yet
            // returned. A crash here must leave the run PAUSED with zero further work.
            await deps.faultCheckpoints?.checkpoint(
              FAULT_CHECKPOINTS.reworkExhaustBeforeReturn,
            );
            return ok(
              outcome({
                stopReason: 'round_limit',
                turns: turnIndex + 1,
                lastDecision,
                progressFingerprint,
              }),
            );
          }
          if (reason === 'AUTONOMOUS_NO_LEGAL_WORK') {
            return ok(
              outcome({
                stopReason: 'no_legal_action',
                turns: turnIndex + 1,
                lastDecision,
                progressFingerprint,
              }),
            );
          }
          if (reason === 'GENERIC_VALIDATION_REQUIREMENTS_MISSING') {
            // A safe human stop: the frozen ADR-0020 gate cannot prove a PASS for a graph
            // with no validator requirements — never a faked success.
            return ok(
              outcome({
                stopReason: 'validation_requirements_missing',
                turns: turnIndex + 1,
                lastDecision,
                progressFingerprint,
              }),
            );
          }
          if (reason === 'AUTONOMOUS_UNIT_EXECUTION_FAILED') {
            /*
             * The engine's own EXECUTION.FAIL already landed the run in its FAILED state: the
             * durable terminal state is the stop, and automation never retries a run the frozen
             * machine has finished — the same non-retryable verdict the loop head reports for
             * a terminal run.
             */
            return ok(
              outcome({
                stopReason: 'non_retryable_failure',
                turns: turnIndex + 1,
                lastDecision,
                progressFingerprint,
              }),
            );
          }
          return ok(
            outcome({
              stopReason: 'error',
              turns: turnIndex + 1,
              lastDecision,
              progressFingerprint,
            }),
          );
        }
        applied.push(appliedNow.value);

        /*
         * Task-18-07 corrective — the authority chain after a work unit:
         *   Task.outputs (durable carrier) → canonical sink → trusted evidence applicator →
         *   canonical Run lifecycle → next Supervisor turn.
         * Neither step parses prose or invents a transition; both read durable state.
         */
        const unitTaskId = appliedNow.value.effect.startsWith('corrective:')
          ? (appliedNow.value.effect.slice('corrective:'.length).split(':')[0] ?? '')
          : null;
        if (deps.outputCarrier !== undefined && unitTaskId !== null && unitTaskId !== '') {
          const routed = await deps.outputCarrier.routeTask({
            companyId: command.companyId,
            runId: command.runId,
            taskId: unitTaskId,
            actorId: command.actorId,
            traceId,
          });
          if (!routed.ok && routed.error.details['reason'] !== 'STAGE_OUTPUT_TASK_MISSING')
            return routed;
        }
        if (deps.evidenceApplicator !== undefined) {
          // Same anchors as the loop head: the caller's named review task, plus the run's
          // review-kind tasks so the newest verdict across rounds decides.
          const anchorReviewTaskId = reviewTaskId ?? deps.reviewTaskId ?? null;
          const reviewAnchors = await reviewTaskIdsOf({
            companyId: command.companyId,
            runId: command.runId,
          });
          const transition = await deps.evidenceApplicator.applyEvidence({
            companyId: command.companyId,
            runId: command.runId,
            ...(anchorReviewTaskId === null ? {} : { reviewTaskId: anchorReviewTaskId }),
            reviewTaskIds: reviewAnchors,
            actorId: command.actorId,
            traceId,
          });
          if (!transition.ok) return transition;
        }

        /* ---- terminal decisions end the loop ---- */
        if (turn.value.action === 'COMPLETE' || turn.value.action === 'ESCALATE') {
          /*
           * STAGE 9B root-cause fix: a REPLAYED escalation whose approval has
           * since been DECIDED (the run left WAITING_APPROVAL through the user's
           * APPROVAL.GRANT/DENY) is bookkeeping, not a fresh escalation. Stopping
           * here made every post-approval resume re-report 'escalated' forever,
           * so an approved run could never continue. The durable run state is
           * the authority: only a run that is WAITING_APPROVAL right now (or a
           * FRESH escalation that just put it there) ends the loop.
           */
          const live = (await deps.runs.get(command.runId)) ?? run0;
          const escalationStands = live.state === 'WAITING_APPROVAL';
          if (turn.value.action === 'COMPLETE' || escalationStands || turn.value.replayed !== true) {
            return ok(
              outcome({
                stopReason: turn.value.action === 'COMPLETE' ? 'completed' : 'escalated',
                turns: turnIndex + 1,
                lastDecision,
                progressFingerprint,
              }),
            );
          }
        }

        /* ---- progress detection on durable identities only (§47) ---- */
        const after = await deps.runs.get(command.runId);
        if (after === null) {
          return err(
            domainError('NOT_FOUND', `Run "${command.runId}" vanished mid-run.`, {
              reason: 'RUN_MISSING',
            }),
          );
        }
        const tasks = await readAll(deps.tasks);
        const next = progressFingerprintOf({
          run: after,
          tasks,
          decisionIds: applied.map((entry) => entry.decisionId),
        });
        if (next === progressFingerprint) {
          idleTurns += 1;
          if (idleTurns >= maxIdleTurns) {
            return ok(
              outcome({
                stopReason: 'idle_progress',
                turns: turnIndex + 1,
                lastDecision,
                progressFingerprint: next,
              }),
            );
          }
        } else {
          idleTurns = 0;
        }
        progressFingerprint = next;

        /*
         * The next turn's SUBJECT follows the durable work: a REQUEST_CORRECTIVE application
         * provisions a task, and that task is what the next round's Decision concerns. The loop
         * does NOT pre-empt the turn by deciding "no legal action" itself — that verdict belongs
         * to the applicator, which knows which Decision it is applying (§14/§44). The review-task
         * anchor stays the one the trusted caller named: guessing a stage-to-review-task mapping
         * would invent knowledge the pinned graph does not carry.
         */
        const provisionedTaskId = appliedNow.value.correctiveTaskId;
        if (typeof provisionedTaskId === 'string' && provisionedTaskId !== '') {
          subjectTaskId = provisionedTaskId;
        }
      }

      // The turn ceiling was reached without a terminal outcome: human-required (§45).
      return ok(
        outcome({
          stopReason: 'human_required',
          turns: turnIndex,
          lastDecision,
          progressFingerprint,
        }),
      );
    } finally {
      releaseTimer();
      if (caller !== undefined) caller.removeEventListener('abort', onCallerAbort);
    }
  };

  const resumeEscalatedRun = async (input: {
    readonly companyId: string;
    readonly runId: string;
    /** Defaults to the trusted `resumeDeciderId` configuration. */
    readonly actorId?: string;
    readonly traceId?: string;
    readonly note?: string;
  }): Promise<Result<{ readonly runId: string; readonly resumed: boolean }, DomainError>> => {
    const run = await deps.runs.get(input.runId);
    if (run === null || run.companyId !== input.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: input.runId,
        }),
      );
    }
    if (run.state !== 'WAITING_APPROVAL') {
      // A stale resume (nothing pending) is refused deterministically, never invented.
      return err(
        domainError(
          'CONFLICT',
          `Run "${run.id}" is ${run.state}; only a run waiting for approval can resume.`,
          {
            reason: 'AUTONOMOUS_RESUME_NOT_WAITING',
            runState: run.state,
          },
        ),
      );
    }
    const granted = await deps.engine.dispatch({
      commandId: `supervisor-resume:${run.id}:${String(run.revision)}`,
      runId: run.id,
      type: 'APPROVAL.GRANT',
      expectedRevision: run.revision,
      actorId: input.actorId ?? resumeDeciderId,
      traceId: input.traceId ?? deps.ids.id('trace'),
      issuedAt: deps.clock.nowIso(),
      reason: input.note ?? 'trusted resume',
      // The authority is supplied by the trusted caller exactly as the engine's own driver does;
      // no new token is added to the catalog.
      payload: { authorities: ['run.approve'] },
    });
    if (!granted.ok) {
      return err(granted.error ?? domainError('PERSISTENCE_FAILED', 'APPROVAL.GRANT was refused.'));
    }
    // Task-18-08: the resume transition is committed; the next supervisor turn has not begun.
    // A crash here must not resume twice nor lose the resumed state.
    await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.resumeTransitionBeforeNextTurn);
    return ok({ runId: run.id, resumed: true });
  };

  return { run, nextWorkUnit, resumeEscalatedRun };
}
