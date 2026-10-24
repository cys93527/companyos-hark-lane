/**
 * Workspace execution lease (Sprint 17 — Task-17-07).
 *
 * V1 semantics (frozen by T17-01): ONE active workspace and SERIAL repository-capable Agent
 * execution. The lease is how that is enforced without touching the workflow scheduler:
 *
 *   - at most ONE repository-capable execution holds the lease at a time — for ANY run, task
 *     or workspace, because they all share the same process-local workspace;
 *   - a second execution is REFUSED (`REPOSITORY_AGENT_BUSY`), never queued: V1 has no
 *     repository scheduler, and silent queues would hide the overlap;
 *   - the lease binds the workspaceId, the run, the task and the execution, so a tool call
 *     from a DIFFERENT execution can be recognised and refused;
 *   - the lease is PROCESS-LOCAL and never durable: after a crash it is naturally absent and
 *     the recovery path re-acquires it.
 *
 * The workspace manager refuses `closeWorkspace()` while a lease is held, so a leased
 * execution cannot have the workspace closed out from under it (and therefore cannot be
 * bypassed by close→open either, because the close itself fails).
 */
import { domainError, err, ok, type DomainError, type Result } from '@companyos/core';

export interface WorkspaceExecutionLease {
  /** Stable, process-local lease identity (never durable). */
  readonly leaseId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  /** The agent execution this lease was granted to. */
  readonly executionId: string;
  readonly acquiredAt: string;
}

export interface AcquireLeaseInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly now: string;
}

export interface WorkspaceExecutionLeaseService {
  /** The current lease, or null when the workspace is free. */
  current(): WorkspaceExecutionLease | null;
  /**
   * Acquire the lease for one repository-capable execution. Refused while another execution
   * holds it (whatever run/task it belongs to).
   */
  acquire(input: AcquireLeaseInput): Result<WorkspaceExecutionLease, DomainError>;
  /** Release a lease by identity. Idempotent: releasing an unknown lease is a no-op. */
  release(leaseId: string): Result<true, DomainError>;
  /** True when a lease is held by an execution OTHER than the given one. */
  heldByOther(executionId: string): boolean;
}

let leaseSequence = 0;

export const createWorkspaceExecutionLease = (): WorkspaceExecutionLeaseService => {
  let held: WorkspaceExecutionLease | null = null;
  return {
    current(): WorkspaceExecutionLease | null {
      return held;
    },
    acquire(input: AcquireLeaseInput): Result<WorkspaceExecutionLease, DomainError> {
      if (held !== null) {
        return err(
          domainError('POLICY_DENIED', 'Another repository execution holds the workspace lease.', {
            reason: 'REPOSITORY_AGENT_BUSY',
            workspaceId: held.workspaceId,
            heldByExecutionId: held.executionId,
            requestedExecutionId: input.executionId,
          }),
        );
      }
      leaseSequence += 1;
      const lease: WorkspaceExecutionLease = {
        leaseId: `wsel_${String(leaseSequence)}`,
        workspaceId: input.workspaceId,
        runId: input.runId,
        taskId: input.taskId,
        executionId: input.executionId,
        acquiredAt: input.now,
      };
      held = lease;
      return ok(lease);
    },
    release(leaseId: string): Result<true, DomainError> {
      if (held !== null && held.leaseId === leaseId) held = null;
      return ok(true);
    },
    heldByOther(executionId: string): boolean {
      return held !== null && held.executionId !== executionId;
    },
  };
};

/** The stable refusal the workspace manager uses while a lease is held. */
export const workspaceInUseError = (lease: WorkspaceExecutionLease): DomainError =>
  domainError('POLICY_DENIED', 'The workspace is in use by a repository execution.', {
    reason: 'WORKSPACE_IN_USE',
    workspaceId: lease.workspaceId,
    leaseId: lease.leaseId,
  });
