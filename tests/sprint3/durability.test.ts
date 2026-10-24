/**
 * Sprint 3 requirements 9–13 + tests D, E, F, G, H:
 * durability across a process restart. "Restart" here means closing the SQLite
 * database and rebuilding the engine over the same file — the honest in-process
 * equivalent of relaunching the app.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Approval, WorkflowRun } from '@companyos/core';

import {
  STAGE_ID,
  makeDurableFixture,
  must,
  type DurableFixture,
} from '../support/durable-fixture.js';

const fixtures: DurableFixture[] = [];
const make = (options: Parameters<typeof makeDurableFixture>[0] = {}): DurableFixture => {
  const fixture = makeDurableFixture(options);
  fixtures.push(fixture);
  return fixture;
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

describe('D. duplicate command stays idempotent across a restart', () => {
  it('replays the recorded outcome instead of applying a second effect', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const command = fixture.command(run, 'RUN.START');

    const first = must(await fixture.engine().dispatch(command));
    expect(first.duplicate).toBe(false);
    const eventsAfterFirst = await fixture.database().events.all();

    fixture.restart();

    const replay = must(await fixture.engine().dispatch(command));
    expect(replay.duplicate).toBe(true);
    expect(replay.to).toBe(first.to);
    expect(replay.revision).toBe(first.revision);

    const after = await fixture.database().events.all();
    expect(after).toHaveLength(eventsAfterFirst.length);
    const stored = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(stored.revision).toBe(first.revision);
    expect(stored.history).toHaveLength(1);
  });

  it('still detects key reuse with different content after a restart', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const command = fixture.command(run, 'RUN.START');
    must(await fixture.engine().dispatch(command));

    fixture.restart();

    const refused = await fixture.engine().dispatch({
      ...command,
      type: 'RUN.CANCEL',
      reason: 'changed my mind',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('CONFLICT');
  });
});

describe('E. stale revision is still refused after a restart', () => {
  it('rejects a command built against a previous life’s revision', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    must(await fixture.engine().drive(run.id, { maxSteps: 2 })); // → PLANNING (revision 2)

    fixture.restart();

    const planning = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(planning.revision).toBe(2);

    const stale = fixture.command(planning, 'PLAN.COMPLETE', { expectedRevision: 1 });
    const refused = await fixture.engine().dispatch(stale);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('CONFLICT');
      expect(refused.error.details['reason']).toBe('stale_revision');
    }
    const unchanged = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(unchanged.state).toBe('PLANNING');
    expect(unchanged.revision).toBe(2);
  });
});

describe('F. resumePoint survives a restart', () => {
  it('pauses, restarts, and resumes to the persisted point', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    must(await fixture.engine().drive(run.id, { maxSteps: 4 })); // → EXECUTING

    const executing = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    must(
      await fixture.engine().dispatch(
        fixture.command(executing, 'RUN.PAUSE', { reason: 'laptop closed' }),
      ),
    );

    fixture.restart();

    const paused = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(paused.state).toBe('PAUSED');
    expect(paused.resumePoint).toBe('EXECUTING');

    must(await fixture.engine().dispatch(fixture.command(paused, 'RUN.RESUME')));
    const resumed = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(resumed.state).toBe('EXECUTING');
    expect(resumed.resumePoint).toBeNull();
  });
});

describe('G. approvals survive a restart', () => {
  it('keeps a pending approval decidable after the restart', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const result = must(await fixture.engine().drive(run.id, { risk: 'HIGH' }));
    expect(result.stopReason).toBe('waiting_approval');

    fixture.restart({ script: {} });

    const waiting = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(waiting.state).toBe('WAITING_APPROVAL');
    const approvals = (await fixture.database().approvals.list()).items as readonly Approval[];
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe('pending');
    expect(approvals[0]?.riskLevel).toBe('HIGH');

    // The decision must still be possible, and it must be persisted.
    must(
      await fixture.engine().dispatch(
        fixture.command(waiting, 'APPROVAL.GRANT', {
          actorId: 'user_owner',
          payload: { authorities: ['run.approve'] },
        }),
      ),
    );
    fixture.restart({ script: {} });
    const decided = (await fixture.database().approvals.list()).items as readonly Approval[];
    expect(decided[0]?.status).toBe('approved');
    expect(decided[0]?.decidedBy).toBe('user_owner');
    expect(((await fixture.database().runs.get(run.id)) as WorkflowRun).state).toBe('EXECUTING');
  });

  it('keeps a rejection and the resulting failure reason', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const result = must(
      await fixture.engine().drive(run.id, { risk: 'CRITICAL', approvalDecision: 'deny' }),
    );
    expect(result.run.state).toBe('FAILED');

    fixture.restart({ script: {} });

    const stored = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(stored.state).toBe('FAILED');
    expect(stored.failureReason).toBe('approval_denied');
    const approvals = (await fixture.database().approvals.list()).items as readonly Approval[];
    expect(approvals[0]?.status).toBe('rejected');
  });
});

describe('H. rework state survives a restart', () => {
  it('keeps state, reworkCount, maxRework and continues the same round', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    // Drive to REVIEWING and reject, leaving the run in REWORK.
    const toReviewing = must(
      await fixture.engine().drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] }, maxSteps: 5 }),
    );
    expect(toReviewing.run.state).toBe('REVIEWING');
    must(
      await fixture.engine().dispatch(
        fixture.command(toReviewing.run, 'REVIEW.REJECT', { reason: 'needs changes' }),
      ),
    );

    fixture.restart();

    const rework = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(rework.state).toBe('REWORK');
    expect(rework.reworkCount).toBe(1);
    expect(rework.maxRework).toBe(3);
    expect(rework.failureReason).toBeNull();

    // The round can be continued on the rebuilt engine.
    must(await fixture.engine().dispatch(fixture.command(rework, 'REWORK.READY')));
    const resumed = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(resumed.state).toBe('EXECUTING');
    expect(resumed.reworkCount).toBe(1);
  });

  it('persists a failure reason and a paused run caused by an exhausted budget', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();
    // maxRework = 0 → the first rejection exhausts the budget.
    const seeded = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    await fixture.database().runs.put({ ...seeded, maxRework: 0 });

    must(
      await fixture.engine().drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
        reviewOutcomes: ['reject', 'pass'],
      }),
    );

    fixture.restart();

    const stored = (await fixture.database().runs.get(run.id)) as WorkflowRun;
    expect(stored.state).toBe('PAUSED');
    expect(stored.maxRework).toBe(0);
    expect(stored.reworkCount).toBe(1);
  });
});
