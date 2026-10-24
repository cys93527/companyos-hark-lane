/**
 * Task — the smallest unit of work assigned to a Role (规划书 §四 Core 概念 8).
 *
 * Task holds the L3 local state (ADR-0003) and never names a model or provider;
 * `kind` is an opaque pack-defined string (e.g. `pack-x:build`).
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { IdFactory } from '../ports/id-factory.js';
import { makeId, type RoleId, type StageId, type TaskId, type WorkflowRunId } from '../kernel/identifiers.js';

export const TASK_STATES = [
  'PENDING',
  'READY',
  'RUNNING',
  'BLOCKED',
  'DONE',
  'FAILED',
  'CANCELLED',
  'SKIPPED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_EVENTS = [
  'PLAN',
  'START',
  'BLOCK',
  'UNBLOCK',
  'COMPLETE',
  'FAIL',
  'RETRY',
  'CANCEL',
  'SKIP',
] as const;
export type TaskEvent = (typeof TASK_EVENTS)[number];

interface TaskRule {
  readonly event: TaskEvent;
  readonly from: readonly TaskState[];
  readonly to: TaskState;
}

/** L3 machine — Task-level only; execution-level states live in `run-state.ts` (L1). */
export const TASK_TRANSITIONS: readonly TaskRule[] = [
  { event: 'PLAN', from: ['PENDING'], to: 'READY' },
  { event: 'START', from: ['READY'], to: 'RUNNING' },
  { event: 'BLOCK', from: ['RUNNING'], to: 'BLOCKED' },
  { event: 'UNBLOCK', from: ['BLOCKED'], to: 'READY' },
  { event: 'COMPLETE', from: ['RUNNING'], to: 'DONE' },
  { event: 'FAIL', from: ['RUNNING'], to: 'FAILED' },
  { event: 'RETRY', from: ['FAILED'], to: 'READY' },
  { event: 'CANCEL', from: ['PENDING', 'READY', 'RUNNING', 'BLOCKED'], to: 'CANCELLED' },
  { event: 'SKIP', from: ['PENDING', 'READY'], to: 'SKIPPED' },
];

export const findTaskTransition = (event: TaskEvent, from: TaskState): TaskRule | null =>
  TASK_TRANSITIONS.find((rule) => rule.event === event && rule.from.includes(from)) ?? null;

export function nextTaskState(event: TaskEvent, from: TaskState): Result<TaskState, DomainError> {
  const rule = findTaskTransition(event, from);
  if (rule === null) {
    return err(
      domainError('ILLEGAL_TRANSITION', `Task event "${event}" is not legal in state "${from}".`, {
        from,
        event,
      }),
    );
  }
  return ok(rule.to);
}

export const isTaskTerminal = (state: TaskState): boolean =>
  state === 'DONE' || state === 'FAILED' || state === 'CANCELLED' || state === 'SKIPPED';

export interface Task {
  readonly id: TaskId;
  /**
   * Canonical run ownership (T20-03A): the ONE Run this task belongs to. Immutable for the
   * task's life — no move/reassign path exists; changing ownership means a different Task.
   * Tenant scope derives task.runId → Run → companyId (no company_id duplication on rows).
   */
  readonly runId: WorkflowRunId;
  readonly stageId: StageId;
  readonly roleId: RoleId;
  /** Opaque, pack-defined work kind — Core never interprets it. */
  readonly kind: string;
  readonly state: TaskState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTaskInput {
  /** REQUIRED canonical run ownership — no Task exists without its Run. */
  readonly runId: WorkflowRunId;
  readonly stageId: StageId;
  readonly roleId: RoleId;
  readonly kind: string;
  readonly now: string;
  readonly ids: IdFactory;
  readonly maxAttempts?: number;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

export function createTask(input: CreateTaskInput): Result<Task, DomainError> {
  if (String(input.runId).trim().length === 0) {
    return err(
      domainError('INVALID_ARGUMENT', 'Task runId must not be empty (canonical run ownership).', {}),
    );
  }
  if (input.kind.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'Task kind must not be empty.', {}));
  }
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    return err(
      domainError('INVALID_ARGUMENT', 'Task maxAttempts must be an integer >= 1.', { maxAttempts }),
    );
  }
  return ok({
    id: makeId<'TaskId'>('task', input.ids),
    runId: input.runId,
    stageId: input.stageId,
    roleId: input.roleId,
    kind: input.kind.trim(),
    state: 'PENDING',
    attempts: 0,
    maxAttempts,
    inputs: input.inputs ?? {},
    outputs: {},
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function applyTaskEvent(
  task: Task,
  event: TaskEvent,
  now: string,
  outputs: Readonly<Record<string, unknown>> = {},
): Result<Task, DomainError> {
  const next = nextTaskState(event, task.state);
  if (!next.ok) return next;

  if (event === 'START' && task.attempts + 1 > task.maxAttempts) {
    return err(
      domainError('LIMIT_EXCEEDED', `Task ${task.id} exhausted its ${task.maxAttempts} attempts.`, {
        taskId: task.id,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
      }),
    );
  }

  const attempts = event === 'START' ? task.attempts + 1 : task.attempts;
  const mergedOutputs = event === 'COMPLETE' ? { ...task.outputs, ...outputs } : task.outputs;
  return ok({ ...task, state: next.value, attempts, outputs: mergedOutputs, updatedAt: now });
}

export const canRetry = (task: Task): boolean => task.attempts < task.maxAttempts;
