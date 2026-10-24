/**
 * Scenario A — the complete happy path, plus requirement 11: every legal
 * transition produces an event.
 */
import { describe, expect, it } from 'vitest';

import { isRunTerminal } from '@companyos/core';

import { makeFixture, must, STAGE_ID } from './support.js';

describe('A. happy path (IDLE → COMPLETED)', () => {
  it('drives a run to COMPLETED through the engine only', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    const result = must(
      await fixture.engine.drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
      }),
    );

    expect(result.stopReason).toBe('terminal');
    expect(result.run.state).toBe('COMPLETED');
    expect(isRunTerminal(result.run.state)).toBe(true);
    expect(result.run.failureReason).toBeNull();

    // The L1 route is exactly the one documented in STATE_MACHINE.md §4.3.
    expect(result.run.history.map((change) => `${change.from}->${change.to}`)).toEqual([
      'IDLE->INITIALIZING',
      'INITIALIZING->PLANNING',
      'PLANNING->ROUTING',
      'ROUTING->EXECUTING',
      'EXECUTING->REVIEWING',
      'REVIEWING->VALIDATING',
      'VALIDATING->FINALIZING',
      'FINALIZING->COMPLETED',
    ]);
    // One revision bump per applied event.
    expect(result.run.revision).toBe(8);
    expect(result.run.history).toHaveLength(8);
  });

  it('emits declared events for every transition (requirement 11)', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    must(
      await fixture.engine.drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
      }),
    );

    const recorded = await fixture.engine.runEvents(run.id);
    const types = recorded.map((entry) => entry.event.type);

    expect(types).toEqual([
      'run.started',
      'run.snapshot_pinned',
      'run.plan_ready',
      'run.route_resolved',
      'run.execution_done',
      'run.review_passed',
      'run.validation_passed',
      'run.delivered',
      'run.completed',
    ]);
    // Every event is auditable: who/what/when/trace.
    for (const entry of recorded) {
      expect(entry.event.aggregateType).toBe('WorkflowRun');
      expect(entry.event.aggregateId).toBe(run.id);
      expect(entry.event.actorId.length).toBeGreaterThan(0);
      expect(entry.event.traceId.length).toBeGreaterThan(0);
      expect(entry.event.version).toBe(1);
    }
    // Positions are strictly increasing: run events interleave with the task-level
    // events the engine also records (requirement 11 covers both levels).
    const positions = recorded.map((entry) => entry.globalPosition);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(new Set(positions).size).toBe(positions.length);
    expect(await fixture.events.lastPosition()).toBe(fixture.events.all().length);
    const taskEvents = fixture.events
      .all()
      .filter((entry) => entry.event.aggregateType === 'Task')
      .map((entry) => entry.event.type);
    expect(taskEvents).toEqual(['task.state_changed', 'task.state_changed', 'task.state_changed']);
  });

  it('exposes the Core WorkflowEnginePort surface (start/advance/cancel/recover)', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    await fixture.engine.start(run.id);
    expect((await fixture.engine.readRun(run.id))?.state).toBe('INITIALIZING');

    // Move the run to EXECUTING the legal way, then execute the stage through the
    // port surface (not through a hand-rolled command).
    must(await fixture.engine.drive(run.id, { maxSteps: 3 }));
    expect((await fixture.engine.readRun(run.id))?.state).toBe('EXECUTING');

    const outcome = await fixture.engine.advance({
      runId: run.id,
      stageId: STAGE_ID,
      taskIds: [task.id],
      snapshot: { snapshotId: run.snapshotId } as never,
    });
    expect(outcome.outcome).toBe('completed');
    expect(outcome.artifactIds).toEqual([]);
    expect(outcome.validationIds).toEqual([]);
    expect((await fixture.engine.readRun(run.id))?.state).toBe('REVIEWING');

    // SM-R-02: a stage request pinned to a foreign snapshot is refused.
    await expect(
      fixture.engine.advance({
        runId: run.id,
        stageId: STAGE_ID,
        taskIds: [task.id],
        snapshot: { snapshotId: 'snp_foreign' } as never,
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' });

    await fixture.engine.cancel(run.id);
    const cancelled = await fixture.engine.readRun(run.id);
    expect(cancelled?.state).toBe('FAILED');
    expect(cancelled?.failureReason).toBe('cancelled');
    expect(await fixture.engine.recover(run.id)).toBe('unrecoverable');
  });

  it('keeps every task terminal after a successful stage', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    must(
      await fixture.engine.drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
      }),
    );
    const stored = await fixture.tasks.get(task.id);
    expect(stored?.state).toBe('DONE');
    expect(stored?.attempts).toBe(1);
  });
});
