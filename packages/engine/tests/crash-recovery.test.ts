/**
 * Scenario K + requirement 14 — crash recovery driven by `resumePoint`.
 */
import { describe, expect, it } from 'vitest';

import type { WorkflowRunId } from '@companyos/core';

import { makeFixture, must, STAGE_ID } from './support.js';

describe('K. crash recovery based on resumePoint', () => {
  it('recovers a crashed run back to where it was', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 4 })); // → EXECUTING

    const executing = await fixture.engine.readRun(run.id);
    expect(executing?.state).toBe('EXECUTING');

    must(await fixture.engine.dispatch(fixture.command(executing!, 'CRASH.DETECTED')));
    const recovering = await fixture.engine.readRun(run.id);
    expect(recovering?.state).toBe('RECOVERING');
    expect(recovering?.resumePoint).toBe('EXECUTING');

    expect(await fixture.engine.recover(run.id)).toBe('resumed');
    const recovered = await fixture.engine.readRun(run.id);
    expect(recovered?.state).toBe('EXECUTING');
    expect(recovered?.resumePoint).toBeNull();

    const types = (await fixture.engine.runEvents(run.id)).map((entry) => entry.event.type);
    expect(types).toContain('run.crash_detected');
    expect(types).toContain('run.recovered');
  });

  it('detects the crash itself when asked to recover a live run', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 2 })); // → PLANNING

    expect(await fixture.engine.recover(run.id)).toBe('resumed');
    const after = await fixture.engine.readRun(run.id);
    expect(after?.state).toBe('PLANNING');
    expect(after?.resumePoint).toBeNull();
  });

  it('refuses to auto-resume a paused run (that is a human decision)', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 2 }));
    const planning = await fixture.engine.readRun(run.id);
    must(await fixture.engine.dispatch(fixture.command(planning!, 'RUN.PAUSE', { reason: 'manual' })));

    expect(await fixture.engine.recover(run.id)).toBe('unrecoverable');
    expect((await fixture.engine.readRun(run.id))?.state).toBe('PAUSED');
  });

  it('reports an unrecoverable run for terminal and unknown runs', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    expect(await fixture.engine.recover('run_missing' as WorkflowRunId)).toBe('unrecoverable');

    must(await fixture.engine.dispatch(fixture.command(run, 'RUN.CANCEL', { reason: 'doomed' })));
    expect(await fixture.engine.recover(run.id)).toBe('unrecoverable');
  });

  it('finishes a run after recovering it', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();
    must(await fixture.engine.drive(run.id, { maxSteps: 4 }));

    const executing = await fixture.engine.readRun(run.id);
    must(await fixture.engine.dispatch(fixture.command(executing!, 'CRASH.DETECTED')));
    expect(await fixture.engine.recover(run.id)).toBe('resumed');

    const finished = must(
      await fixture.engine.drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );
    expect(finished.run.state).toBe('COMPLETED');
  });

  it('recovers a task that was mid-flight when the process died', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    // Simulate a task left in RUNNING by a crash.
    const core = await import('@companyos/core');
    const running = core.applyTaskEvent(task, 'PLAN', fixture.clock.nowIso());
    if (!running.ok) throw new Error('plan failed');
    const started = core.applyTaskEvent(running.value, 'START', fixture.clock.nowIso());
    if (!started.ok) throw new Error('start failed');
    await fixture.tasks.put(started.value);
    expect(started.value.state).toBe('RUNNING');

    const finished = must(
      await fixture.engine.drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );
    expect(finished.run.state).toBe('COMPLETED');
    const stored = await fixture.tasks.get(task.id);
    expect(stored?.state).toBe('DONE');
    // The interrupted attempt counted, and the work was re-run once.
    expect(stored?.attempts).toBe(2);
  });
});
