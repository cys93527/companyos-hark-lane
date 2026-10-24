/**
 * Sprint 1 Task 4: Stage and Task — the L3 local state machines (ADR-0003).
 * These must never reuse L1 execution state names.
 */
import { describe, expect, it } from 'vitest';

import {
  RUN_STATES,
  STAGE_EVENTS,
  STAGE_STATES,
  TASK_EVENTS,
  TASK_STATES,
  addTaskToStage,
  applyStageEvent,
  applyTaskEvent,
  canRetry,
  createStage,
  createTask,
  isStageTerminal,
  isTaskTerminal,
  nextStageState,
  nextTaskState,
  type RoleId,
  type WorkflowVersionId,
} from '@companyos/core';

import { expectErr, expectOk, makeIds, nowIso } from './support.js';

const roleId = 'rol_1' as RoleId;
const versionId = 'ver_1' as WorkflowVersionId;

const newStage = (ordinal = 0) =>
  expectOk(
    createStage({
      workflowVersionId: versionId,
      ordinal,
      name: 'Implementation',
      roleId,
      now: nowIso(),
      ids: makeIds(),
    }),
  );

const newTask = (maxAttempts = 3) =>
  expectOk(
    createTask({ runId: 'run_unit' as never, 
      stageId: 'stg_1' as never,
      roleId,
      kind: 'pack-a:code',
      now: nowIso(),
      ids: makeIds(),
      maxAttempts,
    }),
  );

describe('Stage (L3)', () => {
  it('declares its own state vocabulary (not a copy of L1)', () => {
    expect([...STAGE_STATES]).toEqual(['PENDING', 'READY', 'ACTIVE', 'DONE', 'FAILED', 'SKIPPED']);
    expect([...STAGE_EVENTS]).toEqual(['PLAN', 'ACTIVATE', 'COMPLETE', 'FAIL', 'SKIP', 'RESET']);
    expect([...STAGE_STATES]).not.toEqual([...RUN_STATES]);
    // L1-only states must never leak into the stage vocabulary.
    for (const l1Only of ['EXECUTING', 'REWORK', 'ROUTING', 'WAITING_APPROVAL', 'RECOVERING', 'PAUSED']) {
      expect(STAGE_STATES as readonly string[], `stage must not use L1 state ${l1Only}`).not.toContain(l1Only);
    }
    for (const l3Only of ['ACTIVE', 'BLOCKED', 'SKIPPED']) {
      expect(RUN_STATES as readonly string[], `L1 must not use L3 state ${l3Only}`).not.toContain(l3Only);
    }
  });

  it('creates a stage and validates its inputs', () => {
    const stage = newStage(2);
    expect(stage.ordinal).toBe(2);
    expect(stage.state).toBe('PENDING');
    expect(stage.roleId).toBe(roleId);
    expect(stage.taskIds).toEqual([]);

    expect(expectErr(createStage({ workflowVersionId: versionId, ordinal: -1, name: 'x', now: nowIso(), ids: makeIds() })).code).toBe(
      'INVALID_ARGUMENT',
    );
    expect(expectErr(createStage({ workflowVersionId: versionId, ordinal: 0, name: '  ', now: nowIso(), ids: makeIds() })).code).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('advances and refuses illegal edges', () => {
    for (const [from, event, to] of [
      ['PENDING', 'PLAN', 'READY'],
      ['READY', 'ACTIVATE', 'ACTIVE'],
      ['ACTIVE', 'COMPLETE', 'DONE'],
      ['ACTIVE', 'FAIL', 'FAILED'],
      ['FAILED', 'RESET', 'PENDING'],
      ['PENDING', 'SKIP', 'SKIPPED'],
    ] as const) {
      expect(nextStageState(event, from)).toMatchObject({ ok: true, value: to });
    }
    expect(expectErr(nextStageState('COMPLETE', 'PENDING')).code).toBe('ILLEGAL_TRANSITION');
    expect(isStageTerminal('DONE')).toBe(true);
    expect(isStageTerminal('SKIPPED')).toBe(true);
    expect(isStageTerminal('FAILED')).toBe(false); // RESET is still possible
  });

  it('accepts tasks only while it is mutable, and only once', () => {
    const stage = newStage();
    const withTask = expectOk(addTaskToStage(stage, 'tsk_1' as never, nowIso(1)));
    expect(withTask.taskIds).toEqual(['tsk_1']);
    expect(expectErr(addTaskToStage(withTask, 'tsk_1' as never, nowIso(2))).code).toBe('ALREADY_EXISTS');

    const done = expectOk(
      applyStageEvent(expectOk(applyStageEvent(expectOk(applyStageEvent(stage, 'PLAN', nowIso(1))), 'ACTIVATE', nowIso(2))), 'COMPLETE', nowIso(3)),
    );
    expect(done.state).toBe('DONE');
    expect(expectErr(addTaskToStage(done, 'tsk_2' as never, nowIso(4))).code).toBe('IMMUTABLE_ENTITY');
  });
});

describe('Task (L3)', () => {
  it('declares eight task states and their events', () => {
    expect([...TASK_STATES]).toEqual([
      'PENDING',
      'READY',
      'RUNNING',
      'BLOCKED',
      'DONE',
      'FAILED',
      'CANCELLED',
      'SKIPPED',
    ]);
    expect([...TASK_EVENTS]).toHaveLength(9);
  });

  it('creates a task with attempts accounting', () => {
    const task = newTask();
    expect(task.state).toBe('PENDING');
    expect(task.attempts).toBe(0);
    expect(task.maxAttempts).toBe(3);
    expect(task.id.startsWith('tsk_')).toBe(true);

    expect(expectErr(createTask({ runId: 'run_unit' as never,  stageId: 'stg_1' as never, roleId, kind: '  ', now: nowIso(), ids: makeIds() })).code).toBe(
      'INVALID_ARGUMENT',
    );
    expect(
      expectErr(createTask({ runId: 'run_unit' as never,  stageId: 'stg_1' as never, roleId, kind: 'k', now: nowIso(), ids: makeIds(), maxAttempts: 0 })).code,
    ).toBe('INVALID_ARGUMENT');
  });

  it('walks plan → run → done and merges outputs', () => {
    let task = newTask();
    task = expectOk(applyTaskEvent(task, 'PLAN', nowIso(1)));
    expect(task.state).toBe('READY');

    task = expectOk(applyTaskEvent(task, 'START', nowIso(2)));
    expect(task.state).toBe('RUNNING');
    expect(task.attempts).toBe(1);

    task = expectOk(applyTaskEvent(task, 'COMPLETE', nowIso(3), { artifactId: 'art_1' }));
    expect(task.state).toBe('DONE');
    expect(task.outputs).toEqual({ artifactId: 'art_1' });
    expect(task.attempts).toBe(1);
    expect(isTaskTerminal(task.state)).toBe(true);
  });

  it('models blocking, retry and the attempt ceiling', () => {
    let task = newTask(2);
    task = expectOk(applyTaskEvent(task, 'PLAN', nowIso(1)));
    task = expectOk(applyTaskEvent(task, 'START', nowIso(2)));
    expect(task.attempts).toBe(1);
    task = expectOk(applyTaskEvent(task, 'BLOCK', nowIso(3)));
    expect(task.state).toBe('BLOCKED');
    task = expectOk(applyTaskEvent(task, 'UNBLOCK', nowIso(4)));
    expect(task.state).toBe('READY');

    task = expectOk(applyTaskEvent(task, 'START', nowIso(5)));
    expect(task.attempts).toBe(2);
    expect(canRetry(task)).toBe(false); // 2 of 2 attempts used — a third start would exceed the ceiling
    task = expectOk(applyTaskEvent(task, 'FAIL', nowIso(6)));
    expect(task.state).toBe('FAILED');
    expect(canRetry(task)).toBe(false);

    task = expectOk(applyTaskEvent(task, 'RETRY', nowIso(7)));
    expect(task.state).toBe('READY');
    expect(expectErr(applyTaskEvent(task, 'START', nowIso(8))).code).toBe('LIMIT_EXCEEDED');
  });

  it('cancels and skips, and refuses illegal edges', () => {
    const pending = newTask();
    expect(expectOk(applyTaskEvent(pending, 'CANCEL', nowIso(1))).state).toBe('CANCELLED');
    expect(expectOk(applyTaskEvent(pending, 'SKIP', nowIso(1))).state).toBe('SKIPPED');
    expect(expectErr(applyTaskEvent(pending, 'COMPLETE', nowIso(1))).code).toBe('ILLEGAL_TRANSITION');
    expect(expectErr(nextTaskState('CANCEL', 'DONE')).code).toBe('ILLEGAL_TRANSITION');
  });
});
