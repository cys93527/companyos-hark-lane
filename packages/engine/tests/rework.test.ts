/**
 * Scenario G — review → rework → review, and the rework budget.
 */
import { describe, expect, it } from 'vitest';

import { makeFixture, must, STAGE_ID } from './support.js';

describe('G. review → rework → review', () => {
  it('re-enters execution after a rejection and then completes', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    const result = must(
      await fixture.engine.drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
        reviewOutcomes: ['reject', 'pass'],
      }),
    );

    expect(result.run.state).toBe('COMPLETED');
    expect(result.run.reworkCount).toBe(1);
    expect(result.run.history.map((change) => `${change.from}->${change.to}`)).toEqual([
      'IDLE->INITIALIZING',
      'INITIALIZING->PLANNING',
      'PLANNING->ROUTING',
      'ROUTING->EXECUTING',
      'EXECUTING->REVIEWING',
      'REVIEWING->REWORK',
      'REWORK->EXECUTING',
      'EXECUTING->REVIEWING',
      'REVIEWING->VALIDATING',
      'VALIDATING->FINALIZING',
      'FINALIZING->COMPLETED',
    ]);

    const types = (await fixture.engine.runEvents(run.id)).map((entry) => entry.event.type);
    expect(types.filter((type) => type === 'run.review_rejected')).toHaveLength(1);
    expect(types.filter((type) => type === 'run.rework_ready')).toHaveLength(1);
    expect(types.filter((type) => type === 'run.review_passed')).toHaveLength(1);
  });

  it('counts a validation failure as a rework round', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    const result = must(
      await fixture.engine.drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
        validationOutcomes: ['fail', 'pass'],
      }),
    );
    expect(result.run.state).toBe('COMPLETED');
    expect(result.run.reworkCount).toBe(1);
    const types = (await fixture.engine.runEvents(run.id)).map((entry) => entry.event.type);
    expect(types).toContain('run.validation_failed');
  });

  it('pauses the run once the rework budget is exhausted', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun({ maxRework: 0 });
    const task = await fixture.seedTask();

    const result = must(
      await fixture.engine.drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
        reviewOutcomes: ['reject', 'pass'],
      }),
    );

    expect(result.run.state).toBe('PAUSED');
    expect(result.stopReason).toBe('paused');
    expect(result.run.reworkCount).toBe(1);
    const types = (await fixture.engine.runEvents(run.id)).map((entry) => entry.event.type);
    expect(types).toContain('run.rework_exhausted');
  });

  it('refuses a rework round beyond the budget instead of silently proceeding', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun({ maxRework: 0 });
    must(await fixture.engine.drive(run.id, { maxSteps: 4 })); // → EXECUTING

    const executing = await fixture.engine.readRun(run.id);
    expect(executing?.state).toBe('EXECUTING');
    must(await fixture.engine.dispatch(fixture.command(executing!, 'EXECUTION.COMPLETE')));
    const reviewing = await fixture.engine.readRun(run.id);
    must(
      await fixture.engine.dispatch(
        fixture.command(reviewing!, 'REVIEW.REJECT', { reason: 'changes requested' }),
      ),
    );
    const rework = await fixture.engine.readRun(run.id);
    expect(rework?.state).toBe('REWORK');
    expect(rework?.reworkCount).toBe(1);

    const refused = await fixture.engine.dispatch(fixture.command(rework!, 'REWORK.READY'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('LIMIT_EXCEEDED');

    must(
      await fixture.engine.dispatch(
        fixture.command(rework!, 'REWORK.EXHAUST', { reason: 'budget exhausted' }),
      ),
    );
    expect((await fixture.engine.readRun(run.id))?.state).toBe('PAUSED');
  });
});
