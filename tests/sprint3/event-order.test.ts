/**
 * Sprint 3 requirement 8 + test I: a stable ordering field and consistent replay.
 *
 * `global_position` (assigned at append, inside the command's transaction) is the only
 * ordering authority. Replay must be identical before and after a restart.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { makeDurableFixture, must, STAGE_ID, type DurableFixture } from '../support/durable-fixture.js';

const fixtures: DurableFixture[] = [];
const make = (): DurableFixture => {
  const fixture = makeDurableFixture();
  fixtures.push(fixture);
  return fixture;
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

describe('I. event ordering and replay', () => {
  it('assigns a dense, strictly increasing position to every event', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();
    must(
      await fixture.engine().drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );

    const all = await fixture.database().events.all();
    expect(all.length).toBeGreaterThan(9);
    expect(all.map((entry) => entry.globalPosition)).toEqual(
      all.map((_entry, index) => index + 1),
    );
    expect(await fixture.database().events.lastPosition()).toBe(all.length);
  });

  it('replays one run in the exact order of its transitions', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();
    must(
      await fixture.engine().drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );

    const before = await fixture.engine().runEvents(run.id);
    expect(before.map((entry) => entry.event.type)).toEqual([
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
    expect(before.map((entry) => entry.globalPosition)).toEqual(
      [...before.map((entry) => entry.globalPosition)].sort((left, right) => left - right),
    );

    // Replay from a cursor must continue exactly after it.
    const cursor = before[3]?.globalPosition ?? 0;
    const tail = await fixture.database().events.readFrom(cursor, 100);
    expect(tail[0]?.globalPosition).toBe(cursor + 1);

    fixture.restart();
    const after = await fixture.engine().runEvents(run.id);
    expect(after).toEqual(before);
  });

  it('keeps the position sequence intact across a restart', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    must(await fixture.engine().drive(run.id, { maxSteps: 2 })); // 2 events
    const stopAfter = (await fixture.database().events.all()).length;

    fixture.restart();

    const planning = await fixture.engine().readRun(run.id);
    if (planning === null) throw new Error('run disappeared');
    must(await fixture.engine().dispatch(fixture.command(planning, 'PLAN.COMPLETE')));

    const all = await fixture.database().events.all();
    expect(all).toHaveLength(stopAfter + 1);
    expect(all.map((entry) => entry.globalPosition)).toEqual(
      all.map((_entry, index) => index + 1),
    );
    expect(all[stopAfter]?.event.type).toBe('run.plan_ready');
  });

  it('keeps task-level events in the same ordered log', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();
    must(
      await fixture.engine().drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );

    const all = await fixture.database().events.all();
    const taskEvents = all.filter((entry) => entry.event.aggregateType === 'Task');
    expect(taskEvents.map((entry) => entry.event.type)).toEqual([
      'task.state_changed',
      'task.state_changed',
      'task.state_changed',
    ]);
    // Interleaved with run events, but still monotonic overall.
    const positions = all.map((entry) => entry.globalPosition);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('exposes an auditable payload for every transition', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    must(await fixture.engine().dispatch(fixture.command(run, 'RUN.START')));

    const [first] = await fixture.engine().runEvents(run.id);
    expect(first?.event.payload).toMatchObject({
      from: 'IDLE',
      to: 'INITIALIZING',
      revision: 1,
      commandType: 'RUN.START',
    });
    expect(first?.event.traceId.length).toBeGreaterThan(0);
  });

  it('replays a whole execution (run + task events) for one run', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();
    must(
      await fixture.engine().drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );

    const wholeRun = await fixture.database().events.readByRun(run.id);
    const runLevel = await fixture.engine().runEvents(run.id);
    const taskLevel = wholeRun.filter((entry) => entry.event.aggregateType === 'Task');

    // Whole-execution audit = run events + the task events of the same run, in order.
    expect(taskLevel.length).toBeGreaterThan(0);
    expect(wholeRun).toHaveLength(runLevel.length + taskLevel.length);
    expect(wholeRun.map((entry) => entry.globalPosition)).toEqual(
      wholeRun.map((entry) => entry.globalPosition).sort((left, right) => left - right),
    );
    // Other runs' events never leak into this run's replay (second run proves it).
    const other = await fixture.seedRun();
    must(await fixture.engine().dispatch(fixture.command(other, 'RUN.START')));
    const afterOtherRunStarted = await fixture.database().events.readByRun(run.id);
    expect(afterOtherRunStarted).toEqual(wholeRun);
    expect(wholeRun.every((entry) => entry.event.aggregateId === run.id || entry.event.type.startsWith('task.'))).toBe(
      true,
    );
  });
});
