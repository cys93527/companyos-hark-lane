/**
 * Task-start repository baseline (Sprint 17 — Task-17-07).
 *
 * The baseline answers ONE question durably: "which repository state did THIS task start
 * from?" It is captured exactly once per (company, run, task) by invoking the REAL
 * `repo.git op=baseline` through the REAL ToolRegistry, so the record carries the full
 * provenance chain (authority, risk, schemas, toolVersion, runId, taskId, outputDigest and a
 * durable ToolInvocation) instead of a hand-made anchor.
 *
 * Exactly-once is a property of the registry's own idempotency, not of a process-local flag:
 * the deterministic key `task-baseline:<runId>:<taskId>` makes every later attempt for the
 * same task REPLAY the original invocation (Sprint 9 idempotency), so a retry, a re-entry or a
 * recovery can never create a second authoritative baseline and can never overwrite the first.
 *
 * The baseline is the ORIGINAL start fact: it is never refreshed when the repository changes
 * afterwards, and a later manual `repo.git baseline` (different key) never replaces it.
 */
import { domainError, err, ok, type DomainError, type Result, type ToolRegistryPort } from '@companyos/core';

/** The deterministic identity of a task's authoritative start baseline. */
export const taskBaselineIdempotencyKey = (input: {
  readonly runId: string;
  readonly taskId: string;
}): string => `task-baseline:${input.runId}:${input.taskId}`;

export interface CaptureTaskBaselineInput {
  readonly runId: string;
  readonly taskId: string;
  readonly actorId: string;
  readonly traceId?: string;
}

export interface TaskRepositoryBaseline {
  readonly invocationId: string;
  readonly toolId: string;
  readonly toolVersion: string | null;
  readonly workspaceId: string | null;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly dirtyFiles: readonly string[];
  readonly workingTreeFingerprint: string | null;
}

export interface TaskBaselineService {
  /**
   * Capture (or replay) the authoritative baseline for one task. Re-entry replays the ORIGINAL
   * successful invocation through the registry's idempotency — never a second baseline.
   */
  capture(input: CaptureTaskBaselineInput): Promise<Result<TaskRepositoryBaseline, DomainError>>;
  /** Read the authoritative baseline for one task (read-only, durable). */
  get(input: { readonly runId: string; readonly taskId: string; readonly actorId: string }): Promise<
    Result<TaskRepositoryBaseline | null, DomainError>
  >;
}

export interface TaskBaselineServiceDeps {
  /** The REAL tool registry: `repo.git op=baseline` runs through it, never around it. */
  readonly registry: ToolRegistryPort;
  readonly executionIds: { next: () => string };
  readonly clock: { nowIso(): string };
  /** Optional: the base key prefix, so a deployment can namespace its baselines. */
  readonly keyPrefix?: string;
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** Project the durable baseline output into the readonly provenance shape. */
const projectBaseline = (input: {
  readonly invocationId: string;
  readonly toolId: string;
  readonly toolVersion: string | null;
  readonly output: unknown;
}): TaskRepositoryBaseline => {
  const output = (input.output ?? {}) as Record<string, unknown>;
  const anchor = (output['anchor'] ?? {}) as Record<string, unknown>;
  const dirty = anchor['dirtyFiles'];
  return {
    invocationId: input.invocationId,
    toolId: input.toolId,
    toolVersion: input.toolVersion,
    workspaceId: stringOrNull(output['workspaceId']) ?? stringOrNull(anchor['workspaceId']),
    branch: stringOrNull(anchor['branch']),
    headSha: stringOrNull(anchor['headSha']),
    dirtyFiles: Array.isArray(dirty) ? (dirty as readonly string[]) : [],
    workingTreeFingerprint: stringOrNull(anchor['workingTreeFingerprint']),
  };
};

export const createTaskBaselineService = (deps: TaskBaselineServiceDeps): TaskBaselineService => {
  const prefix = deps.keyPrefix ?? 'task-baseline';
  const keyOf = (input: { readonly runId: string; readonly taskId: string }): string =>
    `${prefix}:${input.runId}:${input.taskId}`;

  return {
    async capture(input) {
      // The trusted application layer triggers the baseline; the model cannot request it, and
      // no input field can name a baseline invocation.
      const invoked = await deps.registry.invoke({
        toolId: 'repo.git',
        executionId: deps.executionIds.next(),
        agentId: 'system:task-baseline',
        taskId: input.taskId,
        runId: input.runId,
        actorId: input.actorId,
        traceId: input.traceId,
        input: { op: 'baseline' },
        // Exactly-once: the same key REPLAYS the original invocation instead of re-running git.
        idempotencyKey: keyOf(input),
      });
      if (!invoked.ok) return err(invoked.error);
      if (invoked.value.status !== 'COMPLETED') {
        // A baseline that did not complete is NOT a baseline: the task must not start.
        return err(
          domainError('AGENT_UNAVAILABLE', 'The task-start repository baseline did not complete.', {
            reason: 'TASK_BASELINE_NOT_COMPLETED',
            invocationId: invoked.value.invocationId,
            status: invoked.value.status,
          }),
        );
      }
      return ok(
        projectBaseline({
          invocationId: invoked.value.invocationId,
          toolId: 'repo.git',
          toolVersion: invoked.value.toolVersion,
          output: invoked.value.output,
        }),
      );
    },

    async get(input) {
      const found = await deps.registry.findInvocationByIdempotencyKey(keyOf(input), input.actorId);
      if (!found.ok) return err(found.error);
      const invocation = found.value;
      if (invocation === null) return ok(null);
      // Only a COMPLETED authoritative invocation is a baseline.
      if (invocation.status !== 'COMPLETED') {
        return err(
          domainError('AGENT_UNAVAILABLE', 'The task-start repository baseline did not complete.', {
            reason: 'TASK_BASELINE_NOT_COMPLETED',
            invocationId: invocation.id,
            status: invocation.status,
          }),
        );
      }
      return ok(
        projectBaseline({
          invocationId: invocation.id,
          toolId: invocation.toolId,
          toolVersion: invocation.toolVersion,
          output: invocation.replayOutput,
        }),
      );
    },
  };
};
