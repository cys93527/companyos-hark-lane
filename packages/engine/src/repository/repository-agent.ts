/**
 * Repository-capable stage execution (Sprint 17 — Task-17-07).
 *
 * The composition root registers ONE handler per repository-capable task kind through the
 * engine's EXISTING `StageHandlerRegistry` extension point. The engine calls it immediately
 * after the authoritative `step(task, 'START')` transition — so the ordering below is the real
 * lifecycle order, not a guess:
 *
 *   1. an active WorkspaceContext must exist (fail closed; no auto-open, no hardcoded path);
 *   2. the task-start baseline is captured through the REAL `repo.git` op=baseline (exactly
 *      once per run/task via the registry's idempotency);
 *   3. only THEN may the repository Agent execution begin;
 *   4. the workspace lease is held for the whole execution and released on EVERY terminal
 *      outcome (succeeded / failed / cancelled / thrown), so a failed or crashed agent never
 *      leaks a permanently busy workspace.
 *
 * A baseline failure returns 'failed' and the agent never runs (no partial start). While the
 * lease is held, a second repository execution — same run, other run, other task — is refused
 * (`REPOSITORY_AGENT_BUSY`) and never touches the workspace.
 *
 * No DevCompany special case exists here: a kind is repository-capable because the composition
 * registered a repository handler for it, which is the generic capability marker.
 */
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
  type ToolRegistryPort,
  type FaultCheckpointPort,
} from '@companyos/core';

import type { StageExecutionContext, StageHandler, StageHandlerOutcome } from '../handlers.js';
import {
  createWorkspaceExecutionLease,
  workspaceInUseError,
  type WorkspaceExecutionLease,
  type WorkspaceExecutionLeaseService,
} from './workspace-lease.js';
import { createTaskBaselineService, type TaskBaselineService, type TaskRepositoryBaseline } from './task-baseline.js';
import type { WorkspaceContext } from './workspace.js';

export interface RepositoryStageHandlerDeps {
  readonly id: string;
  /** The repository work this handler performs (e.g. the agent runtime round). */
  readonly execute: (context: StageExecutionContext) => Promise<StageHandlerOutcome> | StageHandlerOutcome;
  /** The process-local workspace holder (T17-02). */
  readonly workspace: () => WorkspaceContext | null;
  /** The REAL tool registry (the baseline runs through it). */
  readonly registry: ToolRegistryPort;
  readonly actorId: string;
  readonly clock: { nowIso(): string };
  readonly executionIds: { next: () => string };
  /** Optional shared lease (tests inject their own; production creates one per handler set). */
  readonly lease?: WorkspaceExecutionLeaseService;
  readonly baseline?: TaskBaselineService;
  /** Injectable outcome for tests that need a specific delegate result. */
  readonly onBaseline?: (baseline: TaskRepositoryBaseline) => void;
  /**
   * Task-18-08 deterministic fault-injection seam: absent in production (zero overhead),
   * armed by a test harness to prove the baseline→execution window.
   */
  readonly faultCheckpoints?: FaultCheckpointPort;
}

/**
 * Build the repository-capable handler. The returned handler is what the composition
 * registers for a repository-capable kind.
 */
export const createRepositoryStageHandler = (deps: RepositoryStageHandlerDeps): StageHandler => {
  const lease = deps.lease ?? createWorkspaceExecutionLease();
  const baselineService =
    deps.baseline ??
    createTaskBaselineService({
      registry: deps.registry,
      executionIds: deps.executionIds,
      clock: deps.clock,
    });

  return {
    id: deps.id,
    async execute(context: StageExecutionContext): Promise<StageHandlerOutcome> {
      // 1. An active workspace is a precondition: never opened implicitly, never guessed.
      const active = deps.workspace();
      if (active === null) {
        return 'failed';
      }

      // 2. ACQUIRE the exclusive repository execution lease FIRST (T17-07 corrective §3/§4).
      //    Baseline sampling itself happens INSIDE the lease, so no second repository agent
      //    can enter the workspace between the sample and the work. A refusal here means NO
      //    baseline invocation, NO workspace touch and NO work (§6).
      const acquired = lease.acquire({
        workspaceId: active.workspaceId,
        runId: context.runId,
        taskId: context.taskId,
        executionId: contextExecutionId(context),
        now: deps.clock.nowIso(),
      });
      if (!acquired.ok) {
        // Another repository execution holds the workspace: refuse, never queue, never run.
        return 'failed';
      }
      try {
        // 3. Defense-in-depth recheck (§10): the acquired lease must still name the workspace
        //    that is actually active.
        const stillActive = deps.workspace();
        if (stillActive === null || stillActive.workspaceId !== acquired.value.workspaceId) {
          return 'failed';
        }

        // 4. Task-start baseline, exactly once. `capture` is capture-or-replay: the FIRST
        //    successful invocation for this deterministic key becomes the authoritative
        //    baseline, and every later call (retry, re-entry, recovery) REPLAYS that same
        //    invocation through the registry's idempotency — never a re-sample and never a
        //    second authoritative baseline (§11/§12/§13). The distinction comes from the
        //    DURABLE invocation, never from the attempt number.
        const captured = await baselineService.capture({
          runId: context.runId,
          taskId: context.taskId,
          actorId: deps.actorId,
        });
        if (!captured.ok) {
          // Baseline failure ⇒ the repository execution MUST NOT start (the lease is still
          // released by the finally below).
          return 'failed';
        }
        deps.onBaseline?.(captured.value);

        // 5. The authoritative baseline names the workspace it was captured in. A resumed
        //    execution that reopened a DIFFERENT workspace must not run: the baseline would
        //    no longer describe where the work happens (T17-07 §41/§74). Recovery requires
        //    the SAME workspaceId — never the same current anchor, because a task
        //    legitimately changes the code it works on.
        if (captured.value.workspaceId !== null && captured.value.workspaceId !== active.workspaceId) {
          return 'failed';
        }

        // 6. Only now, with the lease held and the baseline durable, may the repository
        //    Agent execution begin.
        // Task-18-08: the baseline is durable; the task execution has not begun. A crash here
        //    must replay the SAME baseline (capture-or-replay), never re-sample.
        // The name literal lives here (not in Core's frozen vocabulary): it names THIS
        // vertical seam, and Core stays industry-neutral.
        await deps.faultCheckpoints?.checkpoint(
          'after_repository_baseline_before_task_execution',
        );
        return await deps.execute(context);
      } finally {
        // 7. Exception safety: EVERY terminal path (success, failure, baseline failure,
        //    workspace mismatch, cancellation, thrown exception) releases the lease. The
        //    lease covers the whole window, not just the agent work (§21).
        lease.release(acquired.value.leaseId);
      }
    },
  };
};

/** The execution identity a lease binds to (the engine's attempt identity when present). */
const contextExecutionId = (context: StageExecutionContext): string =>
  typeof context.payload['executionId'] === 'string' && (context.payload['executionId'] as string).length > 0
    ? (context.payload['executionId'] as string)
    : `task:${context.taskId}:attempt:${String(context.attempt)}`;

/** A registry of repository-capable kinds (the generic capability marker, pack-agnostic). */
export interface RepositoryHandlerRegistry {
  /** Register the repository-capable handler for one task kind. */
  register(kind: string, handler: StageHandler): Result<true, DomainError>;
  /** The handler for a kind, or null when the kind is not repository-capable. */
  resolve(kind: string): StageHandler | null;
}

export const createRepositoryHandlerRegistry = (
  lease: WorkspaceExecutionLeaseService = createWorkspaceExecutionLease(),
): RepositoryHandlerRegistry & { readonly lease: WorkspaceExecutionLeaseService } => {
  const handlers = new Map<string, StageHandler>();
  return {
    lease,
    register(kind: string, handler: StageHandler): Result<true, DomainError> {
      const existing = handlers.get(kind);
      if (existing !== undefined && existing.id !== handler.id) {
        return err(
          domainError('CONFLICT', `A handler is already registered for kind "${kind}".`, {
            kind,
            existingHandlerId: existing.id,
          }),
        );
      }
      handlers.set(kind, handler);
      return ok(true);
    },
    resolve(kind: string): StageHandler | null {
      return handlers.get(kind) ?? null;
    },
  };
};

/** The refusal the tools surface when a lease is held by another execution. */
export const repositoryAgentBusyError = (lease: WorkspaceExecutionLease): DomainError =>
  domainError('POLICY_DENIED', 'Another repository execution holds the workspace lease.', {
    reason: 'REPOSITORY_AGENT_BUSY',
    workspaceId: lease.workspaceId,
  });

/** Re-export for composition: the workspace manager's busy guard uses this. */
export { workspaceInUseError };
