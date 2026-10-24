/**
 * Stage — an ordered phase inside one Workflow Version (规划书 §四 Core 概念 7).
 *
 * Stage holds the L3 local state (ADR-0003). It knows which Role is accountable
 * and which Tasks it contains, but never a model, a provider or a tool binding.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { IdFactory } from '../ports/id-factory.js';
import {
  makeId,
  type RoleId,
  type StageId,
  type TaskId,
  type WorkflowVersionId,
} from '../kernel/identifiers.js';

export const STAGE_STATES = ['PENDING', 'READY', 'ACTIVE', 'DONE', 'FAILED', 'SKIPPED'] as const;
export type StageState = (typeof STAGE_STATES)[number];

export const STAGE_EVENTS = ['PLAN', 'ACTIVATE', 'COMPLETE', 'FAIL', 'SKIP', 'RESET'] as const;
export type StageEvent = (typeof STAGE_EVENTS)[number];

interface StageRule {
  readonly event: StageEvent;
  readonly from: readonly StageState[];
  readonly to: StageState;
}

/** L3 machine — deliberately small, no cross-layer state names (ADR-0003). */
export const STAGE_TRANSITIONS: readonly StageRule[] = [
  { event: 'PLAN', from: ['PENDING'], to: 'READY' },
  { event: 'ACTIVATE', from: ['READY'], to: 'ACTIVE' },
  { event: 'COMPLETE', from: ['ACTIVE'], to: 'DONE' },
  { event: 'FAIL', from: ['ACTIVE', 'READY'], to: 'FAILED' },
  { event: 'SKIP', from: ['PENDING', 'READY'], to: 'SKIPPED' },
  { event: 'RESET', from: ['FAILED'], to: 'PENDING' },
];

export const findStageTransition = (event: StageEvent, from: StageState): StageRule | null =>
  STAGE_TRANSITIONS.find((rule) => rule.event === event && rule.from.includes(from)) ?? null;

export function nextStageState(
  event: StageEvent,
  from: StageState,
): Result<StageState, DomainError> {
  const rule = findStageTransition(event, from);
  if (rule === null) {
    return err(
      domainError('ILLEGAL_TRANSITION', `Stage event "${event}" is not legal in state "${from}".`, {
        from,
        event,
      }),
    );
  }
  return ok(rule.to);
}

export const isStageTerminal = (state: StageState): boolean =>
  !STAGE_TRANSITIONS.some((rule) => rule.from.includes(state));

export interface Stage {
  readonly id: StageId;
  readonly workflowVersionId: WorkflowVersionId;
  readonly ordinal: number;
  readonly name: string;
  readonly roleId: RoleId | null;
  readonly taskIds: readonly TaskId[];
  readonly entryCriteria: readonly string[];
  readonly exitCriteria: readonly string[];
  readonly state: StageState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateStageInput {
  readonly workflowVersionId: WorkflowVersionId;
  readonly ordinal: number;
  readonly name: string;
  readonly roleId?: RoleId;
  readonly entryCriteria?: readonly string[];
  readonly exitCriteria?: readonly string[];
  readonly now: string;
  readonly ids: IdFactory;
}

export function createStage(input: CreateStageInput): Result<Stage, DomainError> {
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
    return err(
      domainError('INVALID_ARGUMENT', 'Stage ordinal must be a non-negative integer.', {
        ordinal: input.ordinal,
      }),
    );
  }
  if (input.name.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'Stage name must not be empty.', {}));
  }
  return ok({
    id: makeId<'StageId'>('stage', input.ids),
    workflowVersionId: input.workflowVersionId,
    ordinal: input.ordinal,
    name: input.name.trim(),
    roleId: input.roleId ?? null,
    taskIds: [],
    entryCriteria: input.entryCriteria ?? [],
    exitCriteria: input.exitCriteria ?? [],
    state: 'PENDING',
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function addTaskToStage(
  stage: Stage,
  taskId: TaskId,
  now: string,
): Result<Stage, DomainError> {
  if (stage.taskIds.includes(taskId)) {
    return err(
      domainError('ALREADY_EXISTS', `Task ${taskId} is already in stage ${stage.id}.`, {
        stageId: stage.id,
        taskId,
      }),
    );
  }
  if (isStageTerminal(stage.state)) {
    return err(
      domainError('IMMUTABLE_ENTITY', `Stage ${stage.id} is ${stage.state} and cannot accept tasks.`, {
        stageId: stage.id,
        state: stage.state,
      }),
    );
  }
  return ok({ ...stage, taskIds: [...stage.taskIds, taskId], updatedAt: now });
}

export function applyStageEvent(
  stage: Stage,
  event: StageEvent,
  now: string,
): Result<Stage, DomainError> {
  const next = nextStageState(event, stage.state);
  if (!next.ok) return next;
  return ok({ ...stage, state: next.value, updatedAt: now });
}
