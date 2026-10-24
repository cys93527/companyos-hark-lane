/**
 * Scenario D + requirement 14 — pause, resume, and the definition of `resumePoint`.
 */
import { describe, expect, it } from 'vitest';

import { makeFixture, must, STAGE_ID } from './support.js';

describe('D. pause → resume', () => {
  it('pauses from an execution-phase state and resumes to the SAME state', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();

    // Drive to EXECUTING (no stage supplied → the driver stops there).
    must(await fixture.engine.drive(run.id, { maxSteps: 2 }));
    const atPlanning = await fixture.engine.readRun(run.id);
    expect(atPlanning?.state).toBe('PLANNING');

    must(await fixture.engine.dispatch(fixture.command(atPlanning!, 'PLAN.COMPLETE')));
    const atRouting = await fixture.engine.readRun(run.id);
    expect(atRouting?.state).toBe('ROUTING');
    must(await fixture.engine.dispatch(fixture.command(atRouting!, 'ROUTE.RESOLVE')));

    const executing = await fixture.engine.readRun(run.id);
    expect(executing?.state).toBe('EXECUTING');

    const paused = must(
      await fixture.engine.dispatch(fixture.command(executing!, 'RUN.PAUSE', { reason: 'user stepped away' })),
    );
    expect(paused.to).toBe('PAUSED');

    const afterPause = await fixture.engine.readRun(run.id);
    expect(afterPause?.state).toBe('PAUSED');
    expect(afterPause?.resumePoint).toBe('EXECUTING');

    const resumed = must(await fixture.engine.dispatch(fixture.command(afterPause!, 'RUN.RESUME')));
    expect(resumed.to).toBe('EXECUTING');

    const afterResume = await fixture.engine.readRun(run.id);
    expect(afterResume?.state).toBe('EXECUTING');
    expect(afterResume?.resumePoint).toBeNull(); // cleared after resume
  });

  it('refuses to pause before planning starts (no gate bypass)', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();

    const refused = await fixture.engine.dispatch(fixture.command(run, 'RUN.PAUSE', { reason: 'too early' }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('ILLEGAL_TRANSITION');

    // Nothing changed: same state, same revision, no event.
    const after = await fixture.engine.readRun(run.id);
    expect(after?.state).toBe('IDLE');
    expect(after?.revision).toBe(0);
    expect(await fixture.events.lastPosition()).toBe(0);
  });

  it('resumes a run paused during planning back into planning, not into execution', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 2 }));

    const planning = await fixture.engine.readRun(run.id);
    expect(planning?.state).toBe('PLANNING');

    must(await fixture.engine.dispatch(fixture.command(planning!, 'RUN.PAUSE', { reason: 'checkpoint' })));
    const paused = await fixture.engine.readRun(run.id);
    expect(paused?.resumePoint).toBe('PLANNING');

    must(await fixture.engine.dispatch(fixture.command(paused!, 'RUN.RESUME')));
    const resumed = await fixture.engine.readRun(run.id);
    expect(resumed?.state).toBe('PLANNING');
  });

  it('keeps the pause/resume cycle idempotent across repeated cycles', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 2, ...{} }));

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const current = await fixture.engine.readRun(run.id);
      must(await fixture.engine.dispatch(fixture.command(current!, 'RUN.PAUSE', { reason: `cycle ${cycle}` })));
      const paused = await fixture.engine.readRun(run.id);
      expect(paused?.state).toBe('PAUSED');
      must(await fixture.engine.dispatch(fixture.command(paused!, 'RUN.RESUME')));
      const resumed = await fixture.engine.readRun(run.id);
      expect(resumed?.state).toBe('PLANNING');
    }
  });

  it('finishes the run after resuming (execution continues where it stopped)', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    must(await fixture.engine.drive(run.id, { maxSteps: 2 }));
    const planning = await fixture.engine.readRun(run.id);
    must(await fixture.engine.dispatch(fixture.command(planning!, 'RUN.PAUSE', { reason: 'pause' })));
    const paused = await fixture.engine.readRun(run.id);
    must(await fixture.engine.dispatch(fixture.command(paused!, 'RUN.RESUME')));

    const finished = must(
      await fixture.engine.drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );
    expect(finished.run.state).toBe('COMPLETED');
  });
});
