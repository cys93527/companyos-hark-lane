/**
 * Scenarios B and C — task-level retry that succeeds, and retry that exhausts.
 */
import { describe, expect, it } from 'vitest';

import { makeFixture, must, STAGE_ID } from './support.js';

describe('B. retry succeeds', () => {
  it('retries a failing task and completes the run', async () => {
    const fixture = makeFixture({ script: { 'pack-a:build': ['failed', 'failed', 'succeeded'] } });
    const run = await fixture.seedRun();
    const task = await fixture.seedTask({ maxAttempts: 3 });

    const result = must(
      await fixture.engine.drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
      }),
    );

    const stored = await fixture.tasks.get(task.id);
    expect(stored?.state).toBe('DONE');
    expect(stored?.attempts).toBe(3);
    expect(result.run.state).toBe('COMPLETED');
    expect(result.run.failureReason).toBeNull();

    // Rework is NOT involved: retry is a task concern, not an L1 concern.
    expect(result.run.reworkCount).toBe(0);
  });
});

describe('C. retry exhausted', () => {
  it('fails the run once the attempts are spent', async () => {
    const fixture = makeFixture({ script: { 'pack-a:build': ['failed', 'failed', 'failed', 'failed'] } });
    const run = await fixture.seedRun();
    const task = await fixture.seedTask({ maxAttempts: 3 });

    const result = must(
      await fixture.engine.drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
      }),
    );

    expect(result.run.state).toBe('FAILED');
    expect(result.run.failureReason).toBe('execution_failed');

    const stored = await fixture.tasks.get(task.id);
    expect(stored?.state).toBe('FAILED');
    expect(stored?.attempts).toBe(3); // exactly maxAttempts — never more

    const types = (await fixture.engine.runEvents(run.id)).map((entry) => entry.event.type);
    expect(types).toContain('run.execution_failed');
    expect(types).not.toContain('run.completed');
  });

  it('does not retry past maxAttempts even with an endless failure script', async () => {
    const fixture = makeFixture({ script: { 'pack-a:build': ['failed'] } });
    const run = await fixture.seedRun();
    const task = await fixture.seedTask({ maxAttempts: 1 });

    must(
      await fixture.engine.drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
      }),
    );
    expect((await fixture.tasks.get(task.id))?.attempts).toBe(1);
    expect((await fixture.engine.readRun(run.id))?.state).toBe('FAILED');
  });

  it('stops the stage without failing the run when a task reports blocked', async () => {
    const fixture = makeFixture({ script: { 'pack-a:build': ['blocked'] } });
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    const result = must(
      await fixture.engine.drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
      }),
    );
    expect(result.stopReason).toBe('needs_decision');
    expect(result.run.state).toBe('EXECUTING'); // the run is NOT failed
    expect((await fixture.tasks.get(task.id))?.state).toBe('BLOCKED');
  });
});
