/**
 * The deterministic Workflow Engine (Sprint 2).
 *
 * Responsibilities (and ONLY these):
 *   - accept a validated `RunCommand` (Core vocabulary) and route it to exactly one
 *     L1 event (`command-router.ts`);
 *   - guard it with optimistic concurrency (`expectedRevision`) and idempotency
 *     (`commandId`);
 *   - advance the run through the L1 machine, appending the transition's events to
 *     the event store;
 *   - execute stages through injectable handlers, with task-level retry;
 *   - serialize commands per run, so two concurrent commands can never interleave.
 *
 * It knows NOTHING about models, providers, roles, git or repositories: its only
 * imports are `@companyos/core` contracts/ports (AGENTS.md §1.3). A real Agent
 * Runtime is plugged in behind `StageHandlerRegistry` in a later sprint.
 */
import {
  DomainError,
  applyRunEvent,
  applyTaskEvent,
  commandFingerprint,
  createCoreDomainEvent,
  decideApproval,
  defineEvent,
  domainError,
  err,
  findRunTransition,
  isCoreDomainEventType,
  isRunTerminal,
  ok,
  requestApproval,
  selectBranch,
  normalizeStageHandlerResult,
  validateRunCommand,
  FAULT_CHECKPOINTS,
  STAGE_OUTPUT_TASK_KEY,

  isTaskTerminal,
  createExecutionAttempt,
  executionAttemptIdOf,
  type ExecutionAttempt,
  type ExecutionAttemptState,
} from '@companyos/core';
import type {
  Approval,
  BranchContext,
  BranchSet,
  Clock,
  CommandLedgerPort,
  CommandLedgerRecord,
  DomainEvent,
  EntityStore,
  EventStorePort,
  IdFactory,
  Logger,
  Result,
  RiskLevel,
  RunCommand,
  RunCommandType,
  RunState,
  StageExecutionOutcome,
  StageExecutionRequest,
  StageExecutionResult,
  StageId,
  StoredEvent,
  Task,
  TaskEvent,
  TaskId,
  UnitOfWork,
  WorkflowEnginePort,
  WorkflowRun,
} from '@companyos/core';

import { createInMemoryCommandLedger } from './memory-store.js';

import { AsyncLocalStorage } from 'node:async_hooks';

import { assertReasonConsistency, routeCommand } from './command-router.js';
import type { StageHandlerRegistry } from './handlers.js';

/* ------------------------------------------------------------------ types */

export interface WorkflowEngineDeps {
  readonly cancellation?: { request(runId: string): Promise<void>; requested(runId: string): Promise<boolean> };
  readonly ids: IdFactory;
  readonly clock: Clock;
  readonly runs: EntityStore<WorkflowRun>;
  readonly events: EventStorePort;
  readonly approvals: EntityStore<Approval>;
  readonly tasks: EntityStore<Task>;
  readonly handlers: StageHandlerRegistry;
  readonly logger?: Logger;
  /**
   * Durable idempotency ledger (Sprint 3). When omitted the engine uses an in-memory
   * ledger, so Sprint 2 behaviour is unchanged; injecting the SQLite implementation
   * makes `duplicate command` survive a process restart.
   */
  readonly ledger?: CommandLedgerPort;
  /**
   * Transaction scope (Sprint 3 requirement 5–7). When provided, every write for one
   * command — approval side effect, run state, events, ledger — commits atomically or
   * not at all. The engine never sees SQLite; only this Core contract.
   */
  readonly unitOfWork?: UnitOfWork;
  /** Idempotency ledger bound (oldest entries are evicted first). */
  readonly maxLedgerEntries?: number;
  /**
   * Sprint 13 evidence gate (ADR-0020, Task-13-07): when present, a `VALIDATION.PASS`
   * command may only transition after the gate proves it from DURABLE evidence
   * (latest RunValidation batch for the target artifact). The caller supplies intent
   * anchors in the command payload (`artifactId`, `stageId`, optional `taskId`) —
   * never a verdict. Absent, Sprint 2/3 engine behaviour is unchanged.
   */
  readonly validationGate?: {
    evaluateGate(input: {
      readonly runId: string;
      readonly stageId: string;
      readonly artifactId: string;
      readonly taskId?: string | null;
    }): Promise<Result<readonly { readonly validatorId: string }[], DomainError>>;
  };
  /**
   * Sprint 18 (Task-18-02) run-pin verification: when present, EVERY stage execution first
   * proves the run's pin — `Run.snapshotId` → the durable RunSnapshot → its pinned template
   * version → Core's canonical `verifyRunSnapshot`. A missing or tampered snapshot is
   * fail-closed BEFORE any task write, and nothing regenerates or repairs a snapshot here.
   * Absent, Sprint 2/3 engine behaviour is unchanged (a legacy composition without a
   * template/snapshot store); the production composition supplies it.
   */
  readonly runSnapshotVerifier?: {
    verify(input: {
      readonly runId: string;
      readonly snapshotId: string;
    }): Promise<Result<true, DomainError>>;
  };
  /** Sprint21: run-scoped task read for the execution-domain completion check. */
  readonly tasksOfRun?: (runId: string) => Promise<readonly Task[]>;
  /**
   * Sprint21 final: the GENERIC execution-claim owner. When wired (production always
   * wires it), stage execution follows the frozen three-transaction timeline: claim
   * commits (Task START + ExecutionAttempt ACTIVE) BEFORE the executor runs, the
   * executor runs OUTSIDE any write transaction, and settlement commits atomically
   * afterwards. Absent (unit-only compositions) the legacy single-transaction stage
   * semantics apply unchanged.
   */
  readonly executionAttempts?: {
    claim(attempt: ExecutionAttempt): Promise<Result<{ readonly attemptId: string; readonly replayed: boolean }, DomainError>>;
    reconcileLegacyInterrupted?(attempt: ExecutionAttempt): Promise<Result<{ readonly attemptId: string; readonly replayed: boolean }, DomainError>>;
    get(attemptId: string): Promise<ExecutionAttempt | null>;
    byTaskAndAttempt(taskId: string, attemptNumber: number): Promise<ExecutionAttempt | null>;
    activeOfTask(taskId: string): Promise<ExecutionAttempt | null>;
    transition(input: {
      readonly attemptId: string;
      readonly to: ExecutionAttemptState;
      readonly now: string;
      readonly runtimeInstanceId?: string | null;
    }): Promise<Result<ExecutionAttempt, DomainError>>;
  };
  /** Sprint21 final: the generic runtime owner token stamped on claims (V1 single-runtime). */
  readonly runtimeInstanceId?: string;
  /**
   * Sprint21 final migration: NON-SEMANTIC fault-injection hooks on the execution-claim
   * timeline (claim-committed / result-returned / settled-before-carrier). Absent in
   * production (zero overhead); they can never alter Task/Attempt semantics.
   */
  readonly faultCheckpoints?: { checkpoint(name: string): Promise<void> };
  /** Sprint21: the run's pinned graph read for the execution-domain completion check. */
  readonly pinnedGraphOf?: (
    runId: string,
  ) => Promise<
    Result<
      { readonly nodes: readonly { readonly id: string; readonly kind?: string }[]; readonly edges: readonly { readonly from: string; readonly to: string }[] },
      DomainError
    >
  >;
}

export interface DispatchOutcome {
  readonly commandId: string;
  readonly runId: string;
  readonly from: RunState;
  readonly to: RunState;
  /** Revision after the transition (unchanged when `duplicate` is true). */
  readonly revision: number;
  readonly eventTypes: readonly string[];
  /** True when the command was already applied — no new effect, no new event. */
  readonly duplicate: boolean;
}

export type DriveStopReason =
  'terminal' | 'waiting_approval' | 'paused' | 'recovering' | 'needs_decision' | 'max_steps';

export interface DriveOptions {
  readonly maxSteps?: number;
  readonly templateAvailable?: boolean;
  /** Played in order for successive REVIEWING states. */
  readonly reviewOutcomes?: readonly ('pass' | 'reject')[];
  /** Played in order for successive VALIDATING states. */
  readonly validationOutcomes?: readonly ('pass' | 'fail')[];
  /** When set, ROUTING requests approval first (HIGH/CRITICAL only). */
  readonly risk?: RiskLevel;
  /** How to answer a pending approval while driving. */
  readonly approvalDecision?: 'grant' | 'deny';
  readonly authorities?: readonly string[];
  /**
   * Who answers the approval. Must differ from the requester, otherwise the
   * separation-of-duties guard refuses it (规划设计 §十一原则 11).
   */
  readonly approverId?: string;
  /** Branch rules evaluated deterministically at PLAN.COMPLETE. */
  readonly plan?: { readonly branchSet: BranchSet; readonly context: BranchContext };
  /** The stage the caller wants executed while in EXECUTING. */
  readonly stage?: { readonly stageId: StageId; readonly taskIds: readonly TaskId[] };
}

export interface DriveResult {
  readonly run: WorkflowRun;
  readonly steps: number;
  readonly stopReason: DriveStopReason;
}

export interface WorkflowEngine extends WorkflowEnginePort {
  dispatch(command: unknown): Promise<Result<DispatchOutcome, DomainError>>;
  readRun(runId: string): Promise<WorkflowRun | null>;
  runEvents(runId: string): Promise<readonly StoredEvent[]>;
  /** Deterministic driver used by tests and by the desktop shell's "continue" action. */
  drive(runId: string, options?: DriveOptions): Promise<Result<DriveResult, DomainError>>;
  /** Pure branch decision (Core semantics) exposed for callers/tests. */
  planBranch(
    branchSet: BranchSet,
    context: BranchContext,
  ): { branch: string; ruleId: string | null };
}

const APPROVAL_RISK_LEVELS: readonly RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
/**
 * Run states a process death can strand mid-flight. Exported (Sprint 14, Task-14-02
 * §53 additive export) so the startup recovery orchestrator consumes the ONE
 * authoritative set instead of copying the list (no drift).
 */
export const CRASHABLE_STATES: readonly RunState[] = [
  'PLANNING',
  'ROUTING',
  'EXECUTING',
  'REVIEWING',
  'VALIDATING',
  'FINALIZING',
];

/* ----------------------------------------------------------------- engine */

export function createWorkflowEngine(deps: WorkflowEngineDeps): WorkflowEngine {
  const ledger: CommandLedgerPort = deps.ledger ?? createInMemoryCommandLedger();
  const maxLedgerEntries = deps.maxLedgerEntries ?? 1_000;
  let warnedAboutMissingUnitOfWork = false;
  const chains = new Map<string, Promise<unknown>>();
  /**
   * The run whose critical section the CURRENT async context is inside.
   *
   * Used only to detect a handler calling back into `dispatch` for its own run (which
   * would await the chain it is already inside). It must not be a plain "in flight"
   * set: two independent callers dispatching concurrently in the same tick are
   * legitimate, and a set would misreport them as re-entrant.
   */
  const criticalSection = new AsyncLocalStorage<string>();
  const approvalByRun = new Map<string, string>();
  const branchByRun = new Map<string, string | null>();

  const nowIso = (): string => deps.clock.nowIso();

  /** Per-run FIFO serialization: command N+1 starts only after command N settled. */
  function serialize<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = chains.get(runId) ?? Promise.resolve();
    const guarded = (): Promise<T> => criticalSection.run(runId, work);
    const next = previous.then(guarded, guarded);
    chains.set(
      runId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * Run `work` inside the injected transaction, or directly when no `UnitOfWork` is
   * wired (Sprint 2 behaviour). Thrown failures become `DomainError`s so the caller
   * always sees the same shape.
   */
  async function inTransaction<T>(work: () => Promise<T>): Promise<Result<T, DomainError>> {
    if (deps.unitOfWork !== undefined) return deps.unitOfWork.transaction(work);
    if (!warnedAboutMissingUnitOfWork) {
      warnedAboutMissingUnitOfWork = true;
      // Never silent (Sprint 3 review MEDIUM-3): without a UnitOfWork the writes of one
      // command are NOT atomic. Sprint 2's in-memory wiring has nothing to roll back,
      // but a production composition root must inject one.
      deps.logger?.warn('no UnitOfWork injected: command writes are not transactional');
    }
    try {
      return ok(await work());
    } catch (error) {
      if (error instanceof DomainError) return err(error);
      return err(
        domainError(
          'PERSISTENCE_FAILED',
          error instanceof Error ? error.message : String(error),
          {},
        ),
      );
    }
  }

  /** Rebuild a `DispatchOutcome` from its ledger record (durable replay). */
  const outcomeFromRecord = (record: CommandLedgerRecord): DispatchOutcome | null => {
    const { from: fromState, to: toState, revision, eventTypes } = record.outcome;
    if (
      typeof fromState !== 'string' ||
      typeof toState !== 'string' ||
      typeof revision !== 'number'
    ) {
      return null;
    }
    return {
      commandId: record.commandId,
      runId: record.runId,
      from: fromState as RunState,
      to: toState as RunState,
      revision,
      eventTypes: Array.isArray(eventTypes)
        ? eventTypes.filter((item): item is string => typeof item === 'string')
        : [],
      duplicate: false,
    };
  };

  function buildEvent(
    type: string,
    run: WorkflowRun,
    command: RunCommand,
    payload: Readonly<Record<string, unknown>>,
  ): DomainEvent {
    const aggregate = { type: 'WorkflowRun', id: run.id };
    const ctx = {
      traceId: command.traceId,
      actorId: command.actorId,
      now: command.issuedAt,
      ids: deps.ids,
    };
    if (isCoreDomainEventType(type)) return createCoreDomainEvent(type, aggregate, payload, ctx);
    // L2-owned lifecycle facts (e.g. `workflow.template.published`) are declared by
    // the template machine; the engine forwards them without re-declaring them.
    return defineEvent(
      {
        type,
        aggregateId: run.id,
        aggregateType: 'WorkflowRun',
        traceId: command.traceId,
        actorId: command.actorId,
        payload,
      },
      deps.ids,
      command.issuedAt,
    );
  }

  const readRisk = (command: RunCommand): RiskLevel => {
    const value = command.payload?.['riskLevel'];
    return typeof value === 'string' && (APPROVAL_RISK_LEVELS as readonly string[]).includes(value)
      ? (value as RiskLevel)
      : 'HIGH';
  };

  const readAuthorities = (command: RunCommand): readonly string[] => {
    const value = command.payload?.['authorities'];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  };

  /**
   * Find the pending approval of a run.
   *
   * The in-memory index answers the hot path; the fallback **pages** through the
   * store (review finding LOW: a single `limit: 500` page silently missed later
   * records).
   */
  async function pendingApprovalId(runId: string): Promise<string | null> {
    const tracked = approvalByRun.get(runId);
    if (tracked !== undefined) {
      // Self-healing cache (Sprint 3 review MEDIUM-1): only trust it while the store
      // still agrees, otherwise fall back to the durable scan.
      const cached = await deps.approvals.get(tracked);
      if (cached !== null && cached.status === 'pending') return tracked;
      approvalByRun.delete(runId);
    }
    const pageSize = 200;
    for (let offset = 0; ; offset += pageSize) {
      const page = await deps.approvals.list({ limit: pageSize, offset });
      const found = page.items.find(
        (approval) => approval.runId === runId && approval.status === 'pending',
      );
      if (found !== undefined) return found.id;
      if (offset + pageSize >= page.total) return null;
    }
  }

  const readBranch = (command: RunCommand): string | null => {
    const explicit = command.payload?.['branch'];
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    const branchSet = command.payload?.['branchSet'];
    const context = command.payload?.['branchContext'];
    if (
      branchSet !== undefined &&
      context !== undefined &&
      typeof context === 'object' &&
      context !== null
    ) {
      return selectBranch(branchSet as BranchSet, context as BranchContext).branch;
    }
    return null;
  };

  /** What the caller must do to the in-process approval cache after a COMMIT. */
  type ApprovalCacheAction =
    | { readonly kind: 'none' }
    | { readonly kind: 'set'; readonly approvalId: string }
    | { readonly kind: 'clear' };

  /** Side effects that must happen inside the command's transaction. */
  async function approvalSideEffects(
    command: RunCommand,
    run: WorkflowRun,
  ): Promise<Result<ApprovalCacheAction, DomainError>> {
    if (command.type === 'APPROVAL.REQUEST') {
      const requested = requestApproval({
        runId: run.id,
        riskLevel: readRisk(command),
        reason: command.reason ?? 'approval requested',
        requestedBy: command.actorId,
        now: command.issuedAt,
        ids: deps.ids,
      });
      if (!requested.ok) return requested;
      await deps.approvals.put(requested.value);
      await deps.events.append([
        createCoreDomainEvent(
          'approval.requested',
          { type: 'Approval', id: requested.value.id },
          { runId: run.id, riskLevel: requested.value.riskLevel, status: requested.value.status },
          {
            traceId: command.traceId,
            actorId: command.actorId,
            now: command.issuedAt,
            ids: deps.ids,
          },
        ),
      ]);
      // The cache is updated by the caller AFTER the commit, so a rollback cannot
      // leave a cache entry pointing at an approval that does not exist
      // (Sprint 3 review MEDIUM-1).
      return ok({ kind: 'set', approvalId: requested.value.id });
    }

    if (command.type === 'APPROVAL.GRANT' || command.type === 'APPROVAL.DENY') {
      const approvalId = await pendingApprovalId(run.id);
      if (approvalId === null) {
        return err(
          domainError('NOT_FOUND', 'No pending approval for this run.', { runId: run.id }),
        );
      }
      const approval = await deps.approvals.get(approvalId);
      if (approval === null) {
        return err(
          domainError('NOT_FOUND', `Approval ${approvalId} not found.`, { runId: run.id }),
        );
      }
      const decided = decideApproval(approval, {
        decidedBy: command.actorId,
        decidedAt: command.issuedAt,
        approved: command.type === 'APPROVAL.GRANT',
        authorities: readAuthorities(command),
        ...(command.reason === undefined ? {} : { note: command.reason }),
      });
      if (!decided.ok) return decided;
      await deps.approvals.put(decided.value);
      await deps.events.append([
        createCoreDomainEvent(
          decided.value.status === 'approved' ? 'approval.granted' : 'approval.denied',
          { type: 'Approval', id: decided.value.id },
          { runId: run.id, riskLevel: decided.value.riskLevel, decidedBy: command.actorId },
          {
            traceId: command.traceId,
            actorId: command.actorId,
            now: command.issuedAt,
            ids: deps.ids,
          },
        ),
      ]);
      return ok({ kind: 'clear' });
    }

    return ok({ kind: 'none' });
  }

  async function execute(command: RunCommand): Promise<Result<DispatchOutcome, DomainError>> {
    const fingerprint = commandFingerprint(command);
    const cached = await ledger.get(command.commandId);
    if (cached !== null) {
      if (cached.fingerprint !== fingerprint) {
        return err(
          domainError('CONFLICT', 'Idempotency key reused with different content.', {
            commandId: command.commandId,
            runId: command.runId,
          }),
        );
      }
      const replayed = outcomeFromRecord(cached);
      if (replayed === null) {
        return err(
          domainError('PERSISTENCE_FAILED', 'Command ledger record is unreadable.', {
            commandId: command.commandId,
          }),
        );
      }
      return ok({ ...replayed, duplicate: true });
    }

    const run = await deps.runs.get(command.runId);
    if (run === null) {
      return err(
        domainError('NOT_FOUND', `Run ${command.runId} not found.`, { runId: command.runId }),
      );
    }

    const routed = routeCommand(command);
    if (!routed.ok) return routed;
    if (command.type !== 'RUN.CANCEL' && await deps.cancellation?.requested(String(command.runId))) {
      return err(domainError('CANCELLED', 'Durable cancellation intent prevents further run transitions.', { reason: 'GOAL_CANCEL_REQUESTED', retryable: false }));
    }

    /*
     * 0b. OUTCOME-DELEGATION GATE (LIVE-SMOKE-FIX-09): GOAL.OUTCOME.DELIVER settles a
     * container run to engine-terminal COMPLETED on the strength of a CHILD execution
     * run's own terminal state. A child run can only reach COMPLETED through the full
     * evidence-gated chain (REVIEW → evidence-proven VALIDATION.PASS → DELIVERY), so
     * the child's state IS the canonical proof of the container's validation and
     * delivery semantics. Fail-closed refusals (typed) for: missing payload anchor,
     * unknown child, cross-company child, child not engine-terminal COMPLETED. The
     * pure state machine below STILL enforces transition legality independently.
     */
    if (command.type === 'GOAL.OUTCOME.DELIVER') {
      const childRunId =
        typeof command.payload?.childExecutionRunId === 'string' ? command.payload.childExecutionRunId : '';
      if (childRunId === '') {
        return err(
          domainError(
            'INVALID_ARGUMENT',
            'GOAL.OUTCOME.DELIVER requires payload anchors { childExecutionRunId } naming the run that delivered the outcome.',
            { commandId: command.commandId, runId: command.runId },
          ),
        );
      }
      const child = await deps.runs.get(childRunId);
      if (child === null) {
        return err(
          domainError('NOT_FOUND', `Outcome child run "${childRunId}" not found.`, {
            commandId: command.commandId,
            runId: command.runId,
            childRunId,
          }),
        );
      }
      if (String(child.companyId) !== String(run.companyId)) {
        // A foreign company's run and a missing run are indistinguishable: no existence leak.
        return err(
          domainError('NOT_FOUND', `Outcome child run "${childRunId}" not found.`, {
            commandId: command.commandId,
            runId: command.runId,
            childRunId,
          }),
        );
      }
      if (child.state !== 'COMPLETED') {
        return err(
          domainError(
            'CONFLICT',
            `Outcome child run "${childRunId}" is "${String(child.state)}", not engine-terminal COMPLETED; the container cannot converge on an undelivered outcome.`,
            { commandId: command.commandId, runId: command.runId, childRunId, childState: String(child.state) },
          ),
        );
      }
    }

    // 0. EVIDENCE GATE (ADR-0020): VALIDATION.PASS must be proven from durable
    //    evidence BEFORE any guard side effect or write. The payload carries intent
    //    anchors only (artifactId/stageId/taskId); caller-declared verdict fields are
    //    structurally unread. The pure state machine below STILL enforces legality —
    //    both gates must pass (Task-13-07 §28).
    if (command.type === 'VALIDATION.PASS' && deps.validationGate !== undefined) {
      const artifactId =
        typeof command.payload?.artifactId === 'string' ? command.payload.artifactId : null;
      const stageId = typeof command.payload?.stageId === 'string' ? command.payload.stageId : null;
      if (artifactId === null || stageId === null) {
        return err(
          domainError(
            'INVALID_ARGUMENT',
            'VALIDATION.PASS requires payload anchors { artifactId, stageId } for the evidence gate.',
            {
              commandId: command.commandId,
              runId: command.runId,
            },
          ),
        );
      }
      const taskId = typeof command.payload?.taskId === 'string' ? command.payload.taskId : null;
      const gateResult = await deps.validationGate.evaluateGate({
        runId: command.runId,
        stageId,
        artifactId,
        taskId,
      });
      if (!gateResult.ok) return gateResult;
    }

    // 1. VALIDITY FIRST (review finding HIGH). Core owns every guard, so nothing —
    //    not even an approval record — may be written for a command that will be
    //    refused (illegal transition, stale revision, exhausted budget, terminal run).
    const applied = applyRunEvent(run, routed.value.event, {
      at: command.issuedAt,
      expectedRevision: command.expectedRevision,
      ...(routed.value.failureReason === null ? {} : { failureReason: routed.value.failureReason }),
    });
    if (!applied.ok) return applied;

    // The transition table is the single source of the emitted facts; a missing rule
    // would silently drop audit events (review finding NIT), so it is an invariant.
    const rule = findRunTransition(routed.value.event, run.state);
    if (rule === null) {
      return err(
        domainError('CONFLICT', 'Internal invariant: the applied event has no transition rule.', {
          runId: run.id,
          event: routed.value.event,
          from: run.state,
          reason: 'missing_transition_rule',
        }),
      );
    }

    // 2. ALL WRITES OF ONE COMMAND ARE ONE TRANSACTION (Sprint 3 requirements 5–7):
    //    approval side effect + run state + events + ledger commit together, or the
    //    whole command rolls back and leaves no half-applied state.
    const written = await inTransaction(
      async (): Promise<{ outcome: DispatchOutcome; cache: ApprovalCacheAction }> => {
        const sideEffects = await approvalSideEffects(command, run);
        if (!sideEffects.ok) throw sideEffects.error;

        await deps.runs.put(applied.value);

        const eventTypes = rule.emits;
        if (eventTypes.length > 0) {
          await deps.events.append(
            eventTypes.map((type) =>
              buildEvent(type, applied.value, command, {
                from: run.state,
                to: applied.value.state,
                revision: applied.value.revision,
                commandType: command.type,
              }),
            ),
          );
        }

        const outcome: DispatchOutcome = {
          commandId: command.commandId,
          runId: run.id,
          from: run.state,
          to: applied.value.state,
          revision: applied.value.revision,
          eventTypes,
          duplicate: false,
        };
        const record: CommandLedgerRecord = {
          commandId: command.commandId,
          fingerprint,
          runId: run.id,
          outcome: { ...outcome },
          recordedAt: command.issuedAt,
        };
        await ledger.put(record);
        await ledger.trim(maxLedgerEntries);
        return { outcome, cache: sideEffects.value };
      },
    );
    if (!written.ok) return written;

    const { outcome, cache } = written.value;
    // 3. Post-commit bookkeeping only: in-process caches must never be mutated inside a
    //    transaction that can still roll back (Sprint 3 review MEDIUM-1).
    if (cache.kind === 'set') approvalByRun.set(run.id, cache.approvalId);
    else if (cache.kind === 'clear') approvalByRun.delete(run.id);

    if (command.type === 'PLAN.COMPLETE') branchByRun.set(run.id, readBranch(command));

    deps.logger?.info('run transition applied', {
      runId: run.id,
      commandType: command.type,
      from: run.state,
      to: applied.value.state,
      revision: applied.value.revision,
      traceId: command.traceId,
    });
    return ok(outcome);
  }

  async function dispatch(raw: unknown): Promise<Result<DispatchOutcome, DomainError>> {
    const validated = validateRunCommand(raw);
    if (!validated.ok) return validated;
    const command = validated.value;

    const reasons = assertReasonConsistency(command);
    if (!reasons.ok) return reasons;

    // Re-entrancy guard (review finding MEDIUM): a `StageHandler` that calls back into
    // `dispatch` for its own run would await the promise chain it is already inside.
    // That is a deadlock; refuse it loudly instead. Detection is async-context based,
    // so genuine concurrent callers are never misclassified.
    if (criticalSection.getStore() === command.runId) {
      return err(
        domainError('CONFLICT', 'Reentrant dispatch for the same run is refused.', {
          runId: command.runId,
          reason: 'reentrant_dispatch',
        }),
      );
    }

    const settled = serialize(command.runId, () => execute(command));
    // Per-run bookkeeping is dropped only AFTER the critical section settles, so a
    // command arriving during the final transition still queues behind it
    // (review NIT: deleting inside the section reopened a serialization gap).
    return settled.then((outcome) => {
      if (outcome.ok && isRunTerminal(outcome.value.to)) {
        approvalByRun.delete(command.runId);
        branchByRun.delete(command.runId);
        chains.delete(command.runId);
      }
      return outcome;
    });
  }

  /** Build and dispatch an engine-internal command (used by drive/port methods). */
  async function dispatchInternal(
    runId: string,
    type: RunCommandType,
    options: {
      readonly actorId?: string;
      readonly reason?: string;
      readonly payload?: Readonly<Record<string, unknown>>;
      readonly traceId?: string;
    } = {},
    /**
     * `true` when the caller already holds the per-run critical section (e.g. stage
     * execution). Re-entering `serialize` would deadlock on our own chain.
     */
    alreadySerialized = false,
  ): Promise<Result<DispatchOutcome, DomainError>> {
    const run = await deps.runs.get(runId);
    if (run === null) {
      return err(domainError('NOT_FOUND', `Run ${runId} not found.`, { runId }));
    }
    const command: RunCommand = {
      commandId: deps.ids.id('cmd'),
      runId: runId as RunCommand['runId'],
      type,
      expectedRevision: run.revision,
      actorId: options.actorId ?? 'engine',
      traceId: options.traceId ?? deps.ids.id('trace'),
      issuedAt: nowIso(),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    };
    return alreadySerialized ? execute(command) : dispatch(command);
  }

  /* --------------------------------------------------------- stage execution */

  interface StageOutcome {
    readonly outcome: StageExecutionOutcome;
    readonly attempts: number;
    readonly taskStates: readonly string[];
  }

  /**
   * Internal stage descriptor.
   *
   * Deliberately narrower than `StageExecutionRequest`: the drive path does not have a
   * `RunSnapshotRef` to hand over, and fabricating one with a type assertion would
   * fake the frozen-pin semantics the port requires (review finding MEDIUM). The port
   * method `advance()` accepts the full request and narrows it here.
   */
  interface StageRequest {
    readonly runId: string;
    readonly stageId: StageId;
    readonly taskIds: readonly TaskId[];
  }

  /**
   * Execute the tasks of one stage with task-level retry, then move the run:
   * `succeeded` → EXECUTION.COMPLETE, `failed` after exhaustion → EXECUTION.FAIL,
   * `blocked` → the run stays in EXECUTING (a later command may retry).
   */
  /**
   * Sprint21 final — Transaction A: acquire the durable execution claim. Normalises the
   * task, applies START exactly once (attempts += 1), creates the guarded ExecutionAttempt
   * ACTIVE, and persists task + events together. An ACTIVE attempt of another owner fails
   * closed (`EXECUTION_ATTEMPT_CLAIM_ACTIVE` — the loser performs ZERO executor calls);
   * an INTERRUPTED attempt is REACQUIRED as the SAME attempt (same identity, attempts NOT
   * incremented — recovery is never a retry); a legacy RUNNING task without an attempt
   * row is claimed at its current attempt number (deterministically reconstructable, no
   * fabricated history).
   */
  async function claimExecutionAttempt(
    request: StageRequest,
    taskId: string,
  ): Promise<
    Result<
      | { readonly kind: 'claimed'; readonly task: Task; readonly attemptId: string }
      | { readonly kind: 'already-satisfied'; readonly state: string }
      | { readonly kind: 'cancelled' },
      DomainError
    >
  > {
    const attempts = deps.executionAttempts!;
    const run = await deps.runs.get(request.runId);
    if (run === null) {
      return err(domainError('NOT_FOUND', `Run ${request.runId} not found.`, { runId: request.runId }));
    }
    if (await deps.cancellation?.requested(request.runId)) return ok({ kind: 'cancelled' });
    let task = await deps.tasks.get(taskId);
    if (task === null) {
      return err(domainError('NOT_FOUND', `Task ${taskId} not found.`, { runId: request.runId, taskId }));
    }
    if (String(task.runId) !== String(request.runId)) {
      return err(
        domainError('VALIDATION_FAILED', `Task ${taskId} belongs to run "${String(task.runId)}", not "${request.runId}".`, {
          reason: 'TASK_RUN_MISMATCH',
          runId: request.runId,
          taskId,
        }),
      );
    }
    const applyQuiet = async (event: 'PLAN' | 'RETRY' | 'UNBLOCK'): Promise<Result<Task, DomainError>> => {
      const applied = applyTaskEvent(task!, event, nowIso());
      if (!applied.ok) return applied;
      await deps.tasks.put(applied.value);
      return applied;
    };
    if (task.state === 'PENDING') {
      const planned = await applyQuiet('PLAN');
      if (!planned.ok) return planned;
      task = planned.value;
    } else if (task.state === 'FAILED') {
      const retried = await applyQuiet('RETRY');
      if (!retried.ok) return retried;
      task = retried.value;
    } else if (task.state === 'BLOCKED') {
      const unblocked = await applyQuiet('UNBLOCK');
      if (!unblocked.ok) return unblocked;
      task = unblocked.value;
    }
    if (task.state === 'DONE' || task.state === 'SKIPPED') {
      return ok({ kind: 'already-satisfied', state: task.state });
    }
    if (task.state === 'CANCELLED') {
      return ok({ kind: 'cancelled' });
    }

    let attemptId: string;
    if (task.state === 'RUNNING') {
      const active = await attempts.activeOfTask(String(task.id));
      if (active !== null) {
        return err(
          domainError('CONFLICT', `Task ${taskId} has an ACTIVE execution claim by another owner.`, {
            reason: 'EXECUTION_ATTEMPT_CLAIM_ACTIVE',
            taskId,
            attemptId: active.seed.id,
          }),
        );
      }
      const interrupted = await attempts.byTaskAndAttempt(String(task.id), task.attempts);
      if (interrupted !== null && interrupted.state === 'INTERRUPTED') {
        // Same-attempt recovery: reacquire the SAME durable attempt identity.
        const reacquired = await attempts.transition({
          attemptId: interrupted.seed.id,
          to: 'ACTIVE',
          now: nowIso(),
          ...(deps.runtimeInstanceId === undefined ? {} : { runtimeInstanceId: deps.runtimeInstanceId }),
        });
        if (!reacquired.ok) return reacquired;
        return ok({ kind: 'claimed', task, attemptId: interrupted.seed.id });
      }
      /*
       * Legacy RUNNING without an attempt row (ruling §35): reconstruct the logical
       * attempt N deterministically from canonical Task facts as INTERRUPTED
       * (recovery-required) FIRST, then the guarded recovery decision (this claim
       * transaction) transitions the SAME attempt to ACTIVE. No Task START, no attempts
       * increment, no fabricated live provenance — the external outcome of attempt N
       * stays honestly unknown (at-least-once).
       */
      attemptId = executionAttemptIdOf({
        companyId: run.companyId,
        runId: String(run.id),
        taskId: String(task.id),
        attemptNumber: task.attempts,
      });
      const legacySeed = createExecutionAttempt({
        id: attemptId,
        companyId: run.companyId,
        runId: String(run.id),
        taskId: String(task.id),
        attemptNumber: task.attempts,
        roleId: task.roleId,
        taskKind: task.kind,
        now: nowIso(),
      });
      if (!legacySeed.ok) return legacySeed;
      if (attempts.reconcileLegacyInterrupted !== undefined) {
        const reconciled = await attempts.reconcileLegacyInterrupted(legacySeed.value);
        if (!reconciled.ok) return reconciled;
      } else {
        const claimedLegacy = await attempts.claim(legacySeed.value);
        if (!claimedLegacy.ok) return claimedLegacy;
      }
      const recovered = await attempts.transition({
        attemptId,
        to: 'ACTIVE',
        now: nowIso(),
        ...(deps.runtimeInstanceId === undefined ? {} : { runtimeInstanceId: deps.runtimeInstanceId }),
      });
      if (!recovered.ok) return recovered;
      return ok({ kind: 'claimed', task, attemptId });
    } else {
      // Fresh claim: START exactly once — the attempt number IS the new attempts value.
      const started = applyTaskEvent(task, 'START', nowIso());
      if (!started.ok) return started;
      task = started.value;
      await deps.tasks.put(task);
      attemptId = executionAttemptIdOf({
        companyId: run.companyId,
        runId: String(run.id),
        taskId: String(task.id),
        attemptNumber: task.attempts,
      });
    }
    const created = createExecutionAttempt({
      id: attemptId,
      companyId: run.companyId,
      runId: String(run.id),
      taskId: String(task.id),
      attemptNumber: task.attempts,
      roleId: task.roleId,
      taskKind: task.kind,
      ...(deps.runtimeInstanceId === undefined ? {} : { runtimeInstanceId: deps.runtimeInstanceId }),
      now: nowIso(),
    });
    if (!created.ok) return created;
    const claimed = await attempts.claim(created.value);
    if (!claimed.ok) return claimed;
    return ok({ kind: 'claimed', task, attemptId });
  }

  /**
   * Sprint21 final — Transaction B: settle the claimed attempt and its Task atomically.
   * The stageOutput rides the SAME Task transition as before (COMPLETE writes the carrier
   * envelope); the ExecutionAttempt settles COMPLETED/FAILED beside it. A genuine settled
   * failure consumes the attempt; a retry (new attempt number) happens only through a
   * subsequent START.
   */
  async function settleExecutionAttempt(
    claim: { readonly task: Task; readonly attemptId: string },
    outcome: 'succeeded' | 'failed' | 'blocked',
    stageOutput: Readonly<Record<string, unknown>>,
    failureMessage?: string,
    failure?: { readonly code: string; readonly stage?: string | null; readonly retryable?: boolean },
  ): Promise<Result<{ readonly task: Task }, DomainError>> {
    const attempts = deps.executionAttempts!;
    let task = await deps.tasks.get(claim.task.id);
    if (task === null) {
      return err(domainError('NOT_FOUND', `Task ${String(claim.task.id)} not found.`, { taskId: String(claim.task.id) }));
    }
    const attempt = await attempts.get(claim.attemptId);
    if (attempt === null || attempt.state !== 'ACTIVE') {
      return err(
        domainError('CONFLICT', `Execution attempt "${claim.attemptId}" is not the active claim.`, {
          reason: 'EXECUTION_ATTEMPT_OWNERSHIP_LOST',
          attemptId: claim.attemptId,
        }),
      );
    }
    const cancelled = await deps.cancellation?.requested(String(task.runId)) === true;
    if (cancelled) {
      const cancellation = applyTaskEvent(task, 'CANCEL', nowIso());
      if (!cancellation.ok) return cancellation;
      task = cancellation.value;
      outcome = 'blocked'; // INTERRUPTED attempt means remote/local stop is not proven.
    } else if (outcome === 'succeeded') {
      const done = applyTaskEvent(task, 'COMPLETE', nowIso(), stageOutput);
      if (!done.ok) return done;
      task = done.value;
    } else if (outcome === 'blocked') {
      const blockd = applyTaskEvent(task, 'BLOCK', nowIso());
      if (!blockd.ok) return blockd;
      task = blockd.value;
    } else {
      const failed = applyTaskEvent(task, 'FAIL', nowIso());
      if (!failed.ok) return failed;
      task = failed.value;
      /*
       * LIVE-SMOKE-FIX-04 — PRE-DISPATCH/POST-DISPATCH FAILURE TRUTH: the typed failure
       * envelope (code + lifecycle stage + retryability) is persisted on the task's
       * canonical outputs under a reserved key, so a terminal FAILED claim can never
       * lose its cause (restart-readable from the durable row alone). A deterministic
       * failure (retryable === false — config/invariant/routing/credential classes)
       * settles FAILED WITHOUT the automatic RETRY: one attempt, fail fast, never the
       * Smoke-04 three-silent-attempts burn.
       */
      if (failure !== undefined) {
        task = {
          ...task,
          outputs: {
            ...task.outputs,
            /*
             * LIVE-SMOKE-FIX-04B: DERIVED CONVENIENCE PROJECTION ONLY — the canonical
             * attempt failure truth lives on the ExecutionAttempt row (per-attempt,
             * append-only, restart-readable). This single-valued task key shows the
             * LAST settled attempt's failure and must NEVER be an authoritative source
             * for recovery, scheduling, retry or UI decisions.
             */
            'companyos:attempt-failure': {
              authority: 'NON_AUTHORITATIVE_DERIVED_PROJECTION',
              failureCode: failure.code,
              ...(failure.stage === undefined || failure.stage === null ? {} : { failureStage: failure.stage }),
              retryable: failure.retryable ?? true,
              attemptNumber: task.attempts,
              attemptId: claim.attemptId,
              ...(failureMessage === undefined ? {} : { summary: failureMessage.slice(0, 200) }),
              failedAt: nowIso(),
            },
          },
        };
      }
      const deterministic = failure !== undefined && failure.retryable === false;
      if (!deterministic && task.attempts < task.maxAttempts) {
        const retried = applyTaskEvent(task, 'RETRY', nowIso());
        if (!retried.ok) return retried;
        task = retried.value;
      }
    }
    await deps.tasks.put(task);
    /*
     * LIVE-SMOKE-FIX-04B - the attempt-scoped CANONICAL failure: the typed payload
     * commits on the ATTEMPT ROW in this same settlement transaction (one UPDATE:
     * state + settled_at + failure columns). A bare 'failed' handler result with no
     * envelope still settles honestly with the generic typed code (never a null cause);
     * 'blocked' is the designed crash/uncertain-adjacent state and carries no failure.
     */
    const settled = await attempts.transition({
      attemptId: claim.attemptId,
      to: outcome === 'succeeded' ? 'COMPLETED' : outcome === 'blocked' ? 'INTERRUPTED' : 'FAILED',
      now: nowIso(),
      ...(failureMessage === undefined ? {} : { runtimeInstanceId: null }),
      ...(outcome === 'failed'
        ? {
            failure: {
              code: failure === undefined ? 'EXECUTION_FAILED' : failure.code,
              ...(failure === undefined ? {} : {phase: failure.stage === undefined ? null : failure.stage}),
              summary: failureMessage === undefined ? (failure === undefined ? null : failure.code) : failureMessage.slice(0, 200),
              retryable: failure === undefined ? true : (failure.retryable ?? true),
            },
          }
        : {}),
    });
    if (!settled.ok) return settled;
    return ok({ task });
  }

  async function executeStageInternal(
    request: StageRequest,
  ): Promise<Result<StageOutcome, DomainError>> {
    const branch = branchByRun.get(request.runId) ?? null;
    let attempts = 0;
    const taskStates: string[] = [];
    let blocked = false;

    for (const taskId of request.taskIds) {
      const loaded = await deps.tasks.get(taskId);
      if (loaded === null) {
        return err(
          domainError('NOT_FOUND', `Task ${taskId} not found.`, { runId: request.runId, taskId }),
        );
      }
      // T20-03A defense in depth: a caller-supplied taskId is NEVER sufficient proof of
      // ownership — the task must belong to THIS run (runId equality) before the engine
      // touches it, regardless of stage/version/company overlap.
      if (String(loaded.runId) !== String(request.runId)) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            `Task ${taskId} belongs to run "${String(loaded.runId)}", not "${String(request.runId)}".`,
            {
              reason: 'TASK_RUN_MISMATCH',
              runId: request.runId,
              taskId,
              taskRunId: String(loaded.runId),
            },
          ),
        );
      }
      let task = loaded;

      /** Apply a task transition and record it as an event (requirement 11). */
      const step = async (
        current: Task,
        event: TaskEvent,
        outputs: Readonly<Record<string, unknown>> = {},
      ): Promise<Result<Task, DomainError>> => {
        const from = current.state;
        const appliedTask = applyTaskEvent(current, event, nowIso(), outputs);
        if (!appliedTask.ok) return appliedTask;
        const context = {
          traceId: deps.ids.id('trace'),
          actorId: 'engine',
          now: nowIso(),
          ids: deps.ids,
        };
        await deps.events.append([
          createCoreDomainEvent(
            'task.state_changed',
            { type: 'Task', id: appliedTask.value.id },
            {
              runId: request.runId,
              from,
              to: appliedTask.value.state,
              event,
              attempt: appliedTask.value.attempts,
            },
            context,
          ),
        ]);
        if (appliedTask.value.state === 'BLOCKED') {
          await deps.events.append([
            createCoreDomainEvent(
              'task.blocked',
              { type: 'Task', id: appliedTask.value.id },
              { runId: request.runId, attempt: appliedTask.value.attempts },
              context,
            ),
          ]);
        }
        return appliedTask;
      };

      /*
       * Sprint21 final — the GENERIC EXECUTION-CLAIM TIMELINE (wired when
       * `deps.executionAttempts` exists; the legacy single-transaction path below is
       * retained verbatim for unit-only compositions without the claim owner):
       *
       *   Transaction A  — normalise, Task START exactly once (attempts += 1), create the
       *                    guarded ExecutionAttempt ACTIVE, COMMIT.
       *   Executor call  — OUTSIDE any write transaction (model/CLI/HTTP handler).
       *   Transaction B  — persist the canonical stageOutput, settle Task + attempt,
       *                    events, COMMIT atomically.
       *
       * Task RUNNING + ExecutionAttempt ACTIVE = an active durable claim: a second
       * supervisor fails closed with ZERO executor calls. An INTERRUPTED attempt is
       * REACQUIRED as the SAME attempt (same identity, no new attempt number, attempts
       * NOT incremented) — crash recovery is never a new retry. A genuine settled failure
       * consumes its attempt and only then may START mint attempt N+1.
       */
      if (deps.executionAttempts !== undefined) {
        const claimedTx = await inTransaction(async () => {
          const inner = await claimExecutionAttempt(request, taskId);
          if (!inner.ok) throw inner.error;
          return inner.value;
        });
        if (!claimedTx.ok) return claimedTx;
        const claim = claimedTx.value;
        if (claim.kind === 'already-satisfied') {
          taskStates.push(claim.state);
          continue;
        }
        if (claim.kind === 'cancelled') {
          taskStates.push('CANCELLED');
          const hasIntent = await deps.cancellation?.requested(String(request.runId)) === true;
          const failedRun = await inTransaction(() => dispatchInternal(request.runId, hasIntent ? 'RUN.CANCEL' : 'EXECUTION.FAIL', { reason: `task ${taskId} was cancelled` }, true));
          if (!failedRun.ok) return failedRun;
          return ok({ outcome: 'failed', attempts, taskStates });
        }
        attempts += 1;

        // Checkpoint A (§2): the claim transaction has COMMITTED (Task RUNNING +
        // ExecutionAttempt ACTIVE durable); the executor has NOT been invoked.
        await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.executionClaimBeforeExecutor);
        const handler = deps.handlers.resolve(claim.task.kind, branch);
        let reported;
        try {
          reported =
            handler === null
              ? ({ status: 'failed' } as const)
              : await handler.execute({
                  runId: request.runId,
                  stageId: request.stageId,
                  taskId: claim.task.id,
                  kind: claim.task.kind,
                  attempt: claim.task.attempts,
                  branch,
                  payload: claim.task.inputs,
                });
        } catch (error) {
          // The executor itself crashed: settle the attempt + task honestly — never a
          // silent wedge and never a retry without a settled failure.
          const settledTx = await inTransaction(async () => {
            const inner = await settleExecutionAttempt(claim, 'failed', {}, String(error instanceof Error ? error.message : String(error)), {code: 'EXECUTOR_CRASH', stage: null, retryable: true});
            if (!inner.ok) throw inner.error;
            return inner.value;
          });
          if (!settledTx.ok) return settledTx;
          if (settledTx.value.task.state === 'CANCELLED') {
            const cancelledRun = await inTransaction(() => dispatchInternal(request.runId, 'RUN.CANCEL', { reason: 'durable cancellation intent' }, true));
            if (!cancelledRun.ok) return cancelledRun;
          }
          return ok({ outcome: 'failed', attempts, taskStates: [ ...taskStates, settledTx.value.task.state ] });
        }

        const normalized = normalizeStageHandlerResult(reported);
        if (!normalized.ok) {
          const settledTx = await inTransaction(async () => {
            const inner = await settleExecutionAttempt(claim, 'failed', {}, normalized.error.message, {code: 'STAGE_HANDLER_RESULT_INVALID', stage: null, retryable: true});
            if (!inner.ok) throw inner.error;
            return inner.value;
          });
          if (!settledTx.ok) return settledTx;
          task = settledTx.value.task;
          await deps.tasks.put(task);
          taskStates.push(task.state);
          const failedRun = await inTransaction(() => dispatchInternal(request.runId, task.state === 'CANCELLED' ? 'RUN.CANCEL' : 'EXECUTION.FAIL', { reason: task.state === 'CANCELLED' ? 'durable cancellation intent' : `task ${task.id} produced a malformed result` }, true));
          if (!failedRun.ok) return failedRun;
          return ok({ outcome: 'failed', attempts, taskStates });
        }
        const result = normalized.value;
        const stageOutput =
          result.status === 'succeeded' && result.output !== undefined
            ? { [STAGE_OUTPUT_TASK_KEY]: result.output }
            : {};
        // Checkpoint B (§3): the executor RETURNED but no canonical settlement exists yet —
        // the honest at-least-once external window.
        await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.executorResultBeforeSettlement);
        const settledTx = await inTransaction(async () => {
          const inner = await settleExecutionAttempt(
            claim,
            result.status === 'succeeded' ? 'succeeded' : result.status === 'blocked' ? 'blocked' : 'failed',
            stageOutput,
            result.failure === undefined
              ? undefined
              : `${result.failure.code}${result.failure.stage === undefined || result.failure.stage === null ? '' : ` (${result.failure.stage})`}`,
            result.failure,
          );
          if (!inner.ok) throw inner.error;
          return inner.value;
        });
        if (!settledTx.ok) return settledTx;
        task = settledTx.value.task;
        await deps.tasks.put(task);
        taskStates.push(task.state);
        if (task.state === 'CANCELLED') {
          const cancelledRun = await inTransaction(() => dispatchInternal(request.runId, 'RUN.CANCEL', { reason: 'durable cancellation intent' }, true));
          if (!cancelledRun.ok) return cancelledRun;
          return ok({ outcome: 'failed', attempts, taskStates });
        }
        if (settledTx.value.task.state === 'BLOCKED') {
          blocked = true;
          break;
        }
        if (settledTx.value.task.state === 'FAILED') {
          const failureCode = result.failure === undefined ? null : result.failure.code;
          const failedRun = await inTransaction(() => dispatchInternal(request.runId, 'EXECUTION.FAIL', { reason: failureCode === null ? `task ${task.id} exhausted ${claim.task.maxAttempts} attempts` : `task ${task.id} failed with ${failureCode}${(task.attempts < claim.task.maxAttempts) ? ' (non-retryable)' : ''}` }, true));
          if (!failedRun.ok) return failedRun;
          return ok({ outcome: 'failed', attempts, taskStates });
        }
        /*
         * LIVE-SMOKE-FIX-04 — the retryable failure kept the task's RETRY semantics
         * (state READY; the next supervisor turn retries it). The stage outcome stays
         * 'completed' so the supervisor loop CONTINUES exactly as before the fix —
         * the receipt-truth correction lives in the supervisor's effect derivation
         * (autonomous-supervisor), which reads the CANONICAL task states instead of
         * trusting this outcome string.
         */
        continue;
      }

      // ---- legacy single-transaction path (unit-only compositions, unchanged) ----
      if (task.state === 'PENDING') {
        const planned = await step(task, 'PLAN');
        if (!planned.ok) return planned;
        task = planned.value;
      } else if (task.state === 'FAILED' || task.state === 'RUNNING') {
        // RUNNING here means a previous execution died mid-flight (crash recovery).
        const reopened = task.state === 'RUNNING' ? await step(task, 'FAIL') : ok(task);
        if (!reopened.ok) return reopened;
        // `RETRY` is the only legal way back to READY.
        const normalised = await step(reopened.value, 'RETRY');
        if (!normalised.ok) return normalised;
        task = normalised.value;
        await deps.tasks.put(task);
      } else if (task.state === 'BLOCKED') {
        const unblocked = await step(task, 'UNBLOCK');
        if (!unblocked.ok) return unblocked;
        task = unblocked.value;
        await deps.tasks.put(task);
      }

      if (task.state === 'DONE' || task.state === 'SKIPPED') {
        // Already satisfied by an earlier round — nothing to execute.
        taskStates.push(task.state);
        continue;
      }
      if (task.state === 'CANCELLED') {
        taskStates.push(task.state);
        const failedRun = await dispatchInternal(
          request.runId,
          'EXECUTION.FAIL',
          { reason: `task ${task.id} was cancelled` },
          true,
        );
        if (!failedRun.ok) return failedRun;
        return ok({ outcome: 'failed', attempts, taskStates });
      }

      let taskOutcome: 'succeeded' | 'failed' | 'blocked' = 'failed';
      for (;;) {
        const started = await step(task, 'START');
        if (!started.ok) {
          if (started.error.code === 'LIMIT_EXCEEDED') {
            taskOutcome = 'failed';
            break;
          }
          return started;
        }
        task = started.value;
        attempts += 1;

        const handler = deps.handlers.resolve(task.kind, branch);
        const reported =
          handler === null
            ? ({ status: 'failed' } as const)
            : await handler.execute({
                runId: request.runId,
                stageId: request.stageId,
                taskId: task.id,
                kind: task.kind,
                attempt: task.attempts,
                branch,
                payload: task.inputs,
              });

        const normalized = normalizeStageHandlerResult(reported);
        if (!normalized.ok) {
          const invalid = await step(task, 'FAIL');
          if (!invalid.ok) return invalid;
          task = invalid.value;
          taskOutcome = 'failed';
          break;
        }
        const result = normalized.value;
        const stageOutput =
          result.status === 'succeeded' && result.output !== undefined
            ? { [STAGE_OUTPUT_TASK_KEY]: result.output }
            : {};

        if (result.status === 'succeeded') {
          const done = await step(task, 'COMPLETE', stageOutput);
          if (!done.ok) return done;
          task = done.value;
          taskOutcome = 'succeeded';
          break;
        }
        if (result.status === 'blocked') {
          const block = await step(task, 'BLOCK');
          if (!block.ok) return block;
          task = block.value;
          taskOutcome = 'blocked';
          break;
        }
        const failedTask = await step(task, 'FAIL');
        if (!failedTask.ok) return failedTask;
        task = failedTask.value;
        if (task.attempts >= task.maxAttempts) {
          // Budget spent: leave the task FAILED (a retry would be refused anyway).
          taskOutcome = 'failed';
          break;
        }
        const retry = await step(task, 'RETRY');
        if (!retry.ok) return retry;
        task = retry.value;
      }

      await deps.tasks.put(task);
      taskStates.push(task.state);

      if (taskOutcome === 'blocked') {
        blocked = true;
        break;
      }
      if (taskOutcome === 'failed') {
        const failedRun = await dispatchInternal(
          request.runId,
          'EXECUTION.FAIL',
          { reason: `task ${task.id} exhausted ${task.maxAttempts} attempts` },
          true,
        );
        if (!failedRun.ok) return failedRun;
        return ok({ outcome: 'failed', attempts, taskStates });
      }
    }

    if (blocked) return ok({ outcome: 'blocked', attempts, taskStates });

    /*
     * Sprint21 (generic orchestration): a multi-stage DAG stays in EXECUTING until the
     * whole EXECUTION DOMAIN is done — every pinned stage that is NOT a deployment-
     * declared review/validation gate stage has terminal-successful work. The single-
     * stage software graph keeps the exact legacy behaviour (its one work stage IS the
     * whole domain). When the optional seams are absent, legacy semantics are unchanged.
     */
    if (deps.tasksOfRun !== undefined && deps.pinnedGraphOf !== undefined) {
      const domainDone = await executionDomainComplete(request.runId);
      if (!domainDone.ok) return domainDone;
      if (!domainDone.value) {
        // This stage finished, but sibling business stages still have work: the run
        // legitimately remains EXECUTING and the orchestrator advances the next unit.
        return ok({ outcome: 'completed', attempts, taskStates });
      }
    }

    const completed = await dispatchInternal(request.runId, 'EXECUTION.COMPLETE', {}, true);
    if (!completed.ok) return completed;
    return ok({ outcome: 'completed', attempts, taskStates });
  }

  /**
   * Sprint21: is every EXECUTION-DOMAIN stage of the pinned graph terminal-successful?
   * The domain = stages whose kind is in NEITHER deployment-declared gate class. A
   * domain stage must have at least one task, all tasks terminal, and at least one DONE.
   */
  async function executionDomainComplete(runId: string): Promise<Result<boolean, DomainError>> {
    const graph = await deps.pinnedGraphOf!(runId);
    if (!graph.ok) return graph;
    // Sprint21 corrective: the EXECUTION DOMAIN is EVERY pinned stage — no stage-class
    // filter, no phase exception. The pinned DAG alone decides ordering; EXECUTION.COMPLETE
    // fires when the whole graph's work is terminal-successful.
    const domainStages = graph.value.nodes.map((node) => node.id);
    const tasks = await deps.tasksOfRun!(runId);
    for (const stageId of domainStages) {
      const stageTasks = tasks.filter((task) => String(task.stageId) === String(stageId));
      if (stageTasks.length === 0) return ok(false);
      if (stageTasks.some((task) => !isTaskTerminal(task.state))) return ok(false);
      if (!stageTasks.some((task) => task.state === 'DONE')) return ok(false);
    }
    return ok(true);
  }

  /**
   * Prove the run's pin before a single task is touched (Task-18-02, §15/§17/§18).
   *
   * This is the ONE authoritative seam both `drive` and `advance` funnel through, so a run
   * whose durable snapshot cannot be verified never executes — regardless of which entry the
   * caller used. It runs outside the stage transaction on purpose: the verification is
   * read-only, and a failed pin must leave no task write, no event and no command behind.
   */
  async function verifyRunPin(runId: string): Promise<Result<true, DomainError>> {
    if (deps.runSnapshotVerifier === undefined) return ok(true);
    const run = await deps.runs.get(runId);
    if (run === null) {
      return err(
        domainError('NOT_FOUND', `Run ${runId} not found; its execution pin cannot be verified.`, {
          runId,
        }),
      );
    }
    return deps.runSnapshotVerifier.verify({ runId, snapshotId: run.snapshotId });
  }

  /**
   * Stage execution is ONE transaction (Sprint 3 review HIGH-1): the task state writes,
   * the task events they emit and the run-level EXECUTION.COMPLETE/FAIL all commit
   * together — or none of them do. The nested run commands join this transaction via
   * the `UnitOfWork`'s async-context nesting rule.
   */
  async function executeStage(request: StageRequest): Promise<Result<StageOutcome, DomainError>> {
    if (await deps.cancellation?.requested(request.runId)) {
      const existing = await deps.runs.get(request.runId);
      if (existing !== null && isRunTerminal(existing.state)) return ok({ outcome: 'failed', attempts: 0, taskStates: [] });
      const cancelled = await inTransaction(() => dispatchInternal(request.runId, 'RUN.CANCEL', { reason: 'durable cancellation intent' }, true));
      if (!cancelled.ok) return cancelled;
      return ok({ outcome: 'failed', attempts: 0, taskStates: [] });
    }
    const verified = await verifyRunPin(request.runId);
    if (!verified.ok) return verified;
    if (deps.executionAttempts !== undefined) {
      // Sprint21 final: the claim-model timeline — claim commits, executor runs OUTSIDE
      // any write transaction, settlement commits atomically. executeStageInternal owns
      // its own per-phase transactions.
      return executeStageInternal(request);
    }
    const written = await inTransaction(async () => {
      const outcome = await executeStageInternal(request);
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    });
    return written;
  }

  /* ------------------------------------------------------------------- drive */

  const nextCommandFor = (
    run: WorkflowRun,
    options: DriveOptions,
    reviewOutcomes: ('pass' | 'reject')[],
    validationOutcomes: ('pass' | 'fail')[],
  ): {
    type: RunCommandType;
    reason?: string;
    payload?: Readonly<Record<string, unknown>>;
    actorId?: string;
  } | null => {
    switch (run.state) {
      case 'IDLE':
        return { type: 'RUN.START' };
      case 'INITIALIZING':
        return options.templateAvailable === false
          ? { type: 'TEMPLATE.MISSING' }
          : { type: 'TEMPLATE.RESOLVE' };
      case 'DESIGNING_WORKFLOW':
        return { type: 'DRAFT.SUBMIT' };
      case 'WORKFLOW_REVIEW':
        return { type: 'DRAFT.APPROVE' };
      case 'WORKFLOW_PUBLISHED':
        return { type: 'RUN.CREATE' };
      case 'PLANNING':
        return {
          type: 'PLAN.COMPLETE',
          ...(options.plan === undefined
            ? {}
            : {
                payload: { branchSet: options.plan.branchSet, branchContext: options.plan.context },
              }),
        };
      case 'ROUTING':
        return options.risk === 'HIGH' || options.risk === 'CRITICAL'
          ? {
              type: 'APPROVAL.REQUEST',
              reason: `risk ${options.risk}`,
              payload: { riskLevel: options.risk },
            }
          : { type: 'ROUTE.RESOLVE' };
      case 'WAITING_APPROVAL':
        if (options.approvalDecision === undefined) return null;
        return {
          type: options.approvalDecision === 'grant' ? 'APPROVAL.GRANT' : 'APPROVAL.DENY',
          reason: `approval ${options.approvalDecision}ed by driver`,
          payload: { authorities: options.authorities ?? ['run.approve'] },
          actorId: options.approverId ?? 'user_owner',
        };
      case 'REVIEWING': {
        const outcome = reviewOutcomes.shift() ?? 'pass';
        return outcome === 'pass'
          ? { type: 'REVIEW.PASS' }
          : { type: 'REVIEW.REJECT', reason: 'review requested changes' };
      }
      case 'REWORK':
        return run.reworkCount > run.maxRework
          ? { type: 'REWORK.EXHAUST', reason: 'rework budget exhausted' }
          : { type: 'REWORK.READY' };
      case 'VALIDATING': {
        const outcome = validationOutcomes.shift() ?? 'pass';
        if (outcome !== 'pass') {
          return { type: 'VALIDATION.FAIL', reason: 'quality gate failed' };
        }
        /*
         * STAGE 9 — with the frozen evidence gate present (ADR-0020), a BARE
         * VALIDATION.PASS can never pass: the gate requires payload anchors
         * proven from durable validation batches, which only the evidence
         * applicator supplies. The deterministic driver therefore yields this
         * transition to the applicator (null = no plain command) instead of
         * dispatching a command that is refused by construction.
         */
        if (deps.validationGate !== undefined) {
          return null;
        }
        return { type: 'VALIDATION.PASS' };
      }
      case 'FINALIZING':
        return { type: 'DELIVERY.COMPLETE' };
      case 'RECOVERING':
        return { type: 'RECOVERY.COMPLETE' };
      case 'EXECUTING':
        return null; // handled by executeStage, not by a plain command
      case 'PAUSED':
      case 'COMPLETED':
      case 'FAILED':
      default:
        return null;
    }
  };

  const stopReasonFor = (run: WorkflowRun): DriveStopReason => {
    if (isRunTerminal(run.state)) return 'terminal';
    if (run.state === 'WAITING_APPROVAL') return 'waiting_approval';
    if (run.state === 'PAUSED') return 'paused';
    if (run.state === 'RECOVERING') return 'recovering';
    return 'needs_decision';
  };

  async function drive(
    runId: string,
    options: DriveOptions = {},
  ): Promise<Result<DriveResult, DomainError>> {
    const maxSteps = options.maxSteps ?? 40;
    const reviewOutcomes = [...(options.reviewOutcomes ?? [])];
    const validationOutcomes = [...(options.validationOutcomes ?? [])];
    let steps = 0;

    for (;;) {
      const current = await deps.runs.get(runId);
      if (current === null) {
        return err(domainError('NOT_FOUND', `Run ${runId} not found.`, { runId }));
      }
      if (isRunTerminal(current.state)) {
        return ok({ run: current, steps, stopReason: 'terminal' });
      }
      if (steps >= maxSteps) {
        return ok({ run: current, steps, stopReason: 'max_steps' });
      }

      if (current.state === 'EXECUTING') {
        const stage = options.stage;
        if (stage === undefined) {
          return ok({ run: current, steps, stopReason: 'needs_decision' });
        }
        const executed = await serialize(runId, () =>
          executeStage({ runId: current.id, stageId: stage.stageId, taskIds: stage.taskIds }),
        );
        if (!executed.ok) return executed;
        steps += 1;
        if (executed.value.outcome === 'blocked') {
          const after = await deps.runs.get(runId);
          return ok({ run: after ?? current, steps, stopReason: 'needs_decision' });
        }
        continue;
      }

      const next = nextCommandFor(current, options, reviewOutcomes, validationOutcomes);
      if (next === null) {
        return ok({ run: current, steps, stopReason: stopReasonFor(current) });
      }
      const result = await dispatch({
        commandId: deps.ids.id('cmd'),
        runId,
        type: next.type,
        expectedRevision: current.revision,
        actorId: next.actorId ?? 'engine.driver',
        traceId: deps.ids.id('trace'),
        issuedAt: nowIso(),
        ...(next.reason === undefined ? {} : { reason: next.reason }),
        ...(next.payload === undefined ? {} : { payload: next.payload }),
      });
      if (!result.ok) return result;
      steps += 1;
    }
  }

  /* ------------------------------------------------------- port implementation */

  async function start(runId: string): Promise<void> {
    const result = await dispatchInternal(runId, 'RUN.START');
    if (!result.ok) throw result.error;
  }

  async function advance(request: StageExecutionRequest): Promise<StageExecutionResult> {
    // SM-R-02: a run reads only its own snapshot. The port carries the pin, so the
    // engine verifies it instead of ignoring it (review NIT).
    const pinned = request.snapshot?.snapshotId;
    if (typeof pinned === 'string' && pinned.length > 0) {
      const current = await deps.runs.get(request.runId);
      if (current !== null && pinned !== current.snapshotId) {
        throw domainError(
          'SNAPSHOT_MISMATCH',
          'The stage request pins a different snapshot than the run.',
          {
            runId: request.runId,
            pinned,
            expected: current.snapshotId,
          },
        );
      }
    }

    const executed = await serialize(request.runId, () =>
      executeStage({ runId: request.runId, stageId: request.stageId, taskIds: request.taskIds }),
    );
    if (!executed.ok) throw executed.error;
    return {
      runId: request.runId,
      stageId: request.stageId,
      outcome: executed.value.outcome,
      artifactIds: [],
      validationIds: [],
    };
  }

  async function cancel(runId: string): Promise<void> {
    // Intent commits OUTSIDE the per-run execution queue; no remote await holds it.
    await deps.cancellation?.request(runId);
    await serialize(runId, async () => {
      const current = await deps.runs.get(runId);
      if (current !== null && isRunTerminal(current.state)) return;
      const result = await inTransaction(() => dispatchInternal(runId, 'RUN.CANCEL', { reason: 'cancelled by caller' }, true));
      if (!result.ok) throw result.error;
    });
  }

  async function recover(runId: string): Promise<'resumed' | 'unrecoverable'> {
    if (await deps.cancellation?.requested(runId)) { await cancel(runId); return 'unrecoverable'; }
    const run = await deps.runs.get(runId);
    if (run === null || isRunTerminal(run.state)) return 'unrecoverable';

    if (run.state === 'RECOVERING') {
      const recovered = await dispatchInternal(runId, 'RECOVERY.COMPLETE');
      return recovered.ok ? 'resumed' : 'unrecoverable';
    }
    if (!CRASHABLE_STATES.includes(run.state)) return 'unrecoverable';

    const crashed = await dispatchInternal(runId, 'CRASH.DETECTED');
    if (!crashed.ok) return 'unrecoverable';
    const recovered = await dispatchInternal(runId, 'RECOVERY.COMPLETE');
    return recovered.ok ? 'resumed' : 'unrecoverable';
  }

  return {
    dispatch,
    drive,
    start,
    advance,
    cancel,
    recover,
    planBranch: (branchSet, context) => selectBranch(branchSet, context),
    async readRun(runId: string): Promise<WorkflowRun | null> {
      return deps.runs.get(runId);
    },
    async runEvents(runId: string): Promise<readonly StoredEvent[]> {
      return deps.events.readByAggregate('WorkflowRun', runId);
    },
  };
}
