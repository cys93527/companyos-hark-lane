/**
 * Sprint 3 requirement 13 + test L: after a restart the engine can continue an
 * unfinished run — including crash recovery from the persisted `resumePoint` and a
 * task that died mid-flight.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { applyTaskEvent } from '@companyos/core';
import type { Task, WorkflowRun } from '@companyos/core';

import { STAGE_ID, makeDurableFixture, must, type DurableFixture } from '../support/durable-fixture.js';

const fixtures: DurableFixture[] = [];
const make = (options: Parameters<typeof makeDurableFixture>[0] = {}): DurableFixture => {
  const fixture = makeDurableFixture(options);
  fixtures.push(fixture);
  return fixture;
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

describe('L. a rebuilt engine continues an unfinished run', () => {
  it('finishes a run that was left in REVIEWING, without re-running the stage', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    must(
      await fixture.engine().drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] }, maxSteps: 5 }),
    );
    const before = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(before.state).toBe('REVIEWING');
    const attemptsBefore = ((await fixture.database().tasks.get(task.id)) as Task).attempts;

    fixture.restart();

    const finished = must(
      await fixture.engine().drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );
    expect(finished.run.state).toBe('COMPLETED');
    // The persisted task was DONE, so the rebuilt engine did not redo the work.
    const after = (await fixture.database().tasks.get(task.id)) as Task;
    expect(after.attempts).toBe(attemptsBefore);
    expect(after.state).toBe('DONE');
  });

  it('stops in EXECUTING until the caller supplies the stage, then continues', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();
    must(await fixture.engine().drive(run.id, { maxSteps: 4 })); // → EXECUTING

    fixture.restart();

    const stalled = must(await fixture.engine().drive(run.id));
    expect(stalled.stopReason).toBe('needs_decision');
    expect(stalled.run.state).toBe('EXECUTING');

    const finished = must(
      await fixture.engine().drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );
    expect(finished.run.state).toBe('COMPLETED');
  });

  it('recovers a crash that happened before the restart', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    must(await fixture.engine().drive(run.id, { maxSteps: 4 })); // → EXECUTING

    fixture.restart();

    // The engine finds the run still EXECUTING with no live worker and recovers it.
    expect(await fixture.engine().recover(run.id)).toBe('resumed');
    const recovered = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(recovered.state).toBe('EXECUTING');
    expect(recovered.resumePoint).toBeNull();
    const types = (await fixture.engine().runEvents(run.id)).map((entry) => entry.event.type);
    expect(types).toContain('run.crash_detected');
    expect(types).toContain('run.recovered');
  });

  it('re-runs a task that was mid-flight when the process died', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    const planned = applyTaskEvent(task, 'PLAN', fixture.clock.nowIso());
    if (!planned.ok) throw new Error('plan failed');
    const started = applyTaskEvent(planned.value, 'START', fixture.clock.nowIso());
    if (!started.ok) throw new Error('start failed');
    await fixture.database().tasks.put(started.value);

    fixture.restart();

    const stored = (await fixture.database().tasks.get(task.id)) as Task;
    expect(stored.state).toBe('RUNNING');

    const finished = must(
      await fixture.engine().drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );
    expect(finished.run.state).toBe('COMPLETED');
    const after = (await fixture.database().tasks.get(task.id)) as Task;
    expect(after.state).toBe('DONE');
    expect(after.attempts).toBe(2);
  });

  it('honours the persisted rework budget on the rebuilt engine', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();
    const seeded = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    await fixture.database().runs.put({ ...seeded, maxRework: 1 });

    must(
      await fixture.engine().drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
        reviewOutcomes: ['reject', 'reject', 'pass'],
      }),
    );
    const paused = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(paused.state).toBe('PAUSED');

    fixture.restart();

    const after = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(after.state).toBe('PAUSED');
    expect(after.maxRework).toBe(1);
    expect(after.reworkCount).toBeGreaterThan(1);
    // A paused run never auto-resumes.
    expect(await fixture.engine().recover(run.id)).toBe('unrecoverable');
    expect(((await fixture.database().runs.get(run.id)) as WorkflowRun).state).toBe('PAUSED');
  });

  it('keeps the idempotency window bounded across restarts', async () => {
    const fixture = make({ maxLedgerEntries: 2 });
    const first = await fixture.seedRun();
    const second = await fixture.seedRun();

    must(await fixture.engine().dispatch(fixture.command(first, 'RUN.START')));
    must(await fixture.engine().dispatch(fixture.command(second, 'RUN.START')));
    must(await fixture.engine().dispatch(fixture.command(first, 'TEMPLATE.RESOLVE', { expectedRevision: 1 })));

    expect(await fixture.database().ledger.count()).toBeLessThanOrEqual(2);

    fixture.restart();
    expect(await fixture.database().ledger.count()).toBeLessThanOrEqual(2);
    // The evicted (oldest) command is no longer recognised as a duplicate: it is
    // refused on revision instead, which is the documented bounded-window semantics.
    const replay = await fixture.engine().dispatch({
      ...fixture.command(first, 'RUN.START'),
      commandId: 'cmd_0001',
      expectedRevision: 0,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe('CONFLICT');
  });
});
