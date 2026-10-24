/**
 * Scenarios E and F — approval granted and approval rejected, plus the authority
 * rules the approval gate enforces (规划书 §十一原则 11 / §三十六 / §三十九).
 */
import { describe, expect, it } from 'vitest';

import { makeFixture, must, STAGE_ID } from './support.js';

/** Drive a run to ROUTING with a HIGH-risk decision pending. */
async function driveToRouting(fixture: ReturnType<typeof makeFixture>) {
  const run = await fixture.seedRun();
  must(await fixture.engine.drive(run.id, { maxSteps: 2 })); // IDLE → … → PLANNING
  const planning = await fixture.engine.readRun(run.id);
  must(await fixture.engine.dispatch(fixture.command(planning!, 'PLAN.COMPLETE'))); // → ROUTING
  const routing = await fixture.engine.readRun(run.id);
  expect(routing?.state).toBe('ROUTING');
  return routing!;
}

describe('E. approval granted', () => {
  it('holds the run at WAITING_APPROVAL until a decision arrives', async () => {
    const fixture = makeFixture();
    const routing = await driveToRouting(fixture);

    must(
      await fixture.engine.dispatch(
        fixture.command(routing, 'APPROVAL.REQUEST', { reason: 'risk HIGH', payload: { riskLevel: 'HIGH' } }),
      ),
    );
    const waiting = await fixture.engine.readRun(routing.id);
    expect(waiting?.state).toBe('WAITING_APPROVAL');

    // An approval record exists and is pending.
    const pending = fixture.approvals.snapshot();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('pending');
    expect(pending[0]?.riskLevel).toBe('HIGH');

    // The driver refuses to invent a decision.
    const stalled = must(await fixture.engine.drive(routing.id));
    expect(stalled.stopReason).toBe('waiting_approval');
    expect(stalled.run.state).toBe('WAITING_APPROVAL');

    must(
      await fixture.engine.dispatch(
        fixture.command(waiting!, 'APPROVAL.GRANT', {
          actorId: 'user_owner',
          payload: { authorities: ['run.approve'] },
        }),
      ),
    );
    const granted = await fixture.engine.readRun(routing.id);
    expect(granted?.state).toBe('EXECUTING');
    expect(fixture.approvals.snapshot()[0]?.status).toBe('approved');
  });

  it('completes the whole run when approval is granted', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    const result = must(
      await fixture.engine.drive(run.id, {
        risk: 'HIGH',
        approvalDecision: 'grant',
        authorities: ['run.approve'],
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
      }),
    );

    expect(result.run.state).toBe('COMPLETED');
    const types = (await fixture.engine.runEvents(run.id)).map((entry) => entry.event.type);
    expect(types).toContain('run.approval_required');
    expect(types).toContain('run.approval_granted');
  });
});

describe('F. approval rejected', () => {
  it('fails the run with an attributable reason', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();

    const result = must(
      await fixture.engine.drive(run.id, { risk: 'CRITICAL', approvalDecision: 'deny' }),
    );

    expect(result.run.state).toBe('FAILED');
    expect(result.run.failureReason).toBe('approval_denied');
    expect(fixture.approvals.snapshot()[0]?.status).toBe('rejected');
    expect((await fixture.engine.runEvents(run.id)).map((e) => e.event.type)).toContain(
      'run.approval_denied',
    );
  });

  it('refuses a decision without the approval authority and changes nothing', async () => {
    const fixture = makeFixture();
    const routing = await driveToRouting(fixture);
    must(
      await fixture.engine.dispatch(
        fixture.command(routing, 'APPROVAL.REQUEST', { reason: 'risk HIGH', payload: { riskLevel: 'HIGH' } }),
      ),
    );
    const waiting = await fixture.engine.readRun(routing.id);
    const before = JSON.stringify(waiting);
    const eventsBefore = await fixture.events.lastPosition();

    const refused = await fixture.engine.dispatch(
      fixture.command(waiting!, 'APPROVAL.GRANT', { payload: { authorities: ['run.review'] } }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('POLICY_DENIED');

    expect(JSON.stringify(await fixture.engine.readRun(routing.id))).toBe(before);
    expect(await fixture.events.lastPosition()).toBe(eventsBefore);
  });

  it('refuses self-approval (separation of duties)', async () => {
    const fixture = makeFixture();
    const routing = await driveToRouting(fixture);
    const request = fixture.command(routing, 'APPROVAL.REQUEST', {
      reason: 'risk HIGH',
      payload: { riskLevel: 'HIGH' },
    });
    must(await fixture.engine.dispatch(request));
    const waiting = await fixture.engine.readRun(routing.id);

    const selfApproval = fixture.command(waiting!, 'APPROVAL.GRANT', {
      actorId: 'tester', // same actor that requested it
      payload: { authorities: ['run.approve'] },
    });
    const refused = await fixture.engine.dispatch(selfApproval);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('POLICY_DENIED');
    expect((await fixture.engine.readRun(routing.id))?.state).toBe('WAITING_APPROVAL');
  });

  it('refuses to request approval for LOW/MEDIUM risk (policy, not a step)', async () => {
    const fixture = makeFixture();
    const routing = await driveToRouting(fixture);
    const before = JSON.stringify(await fixture.engine.readRun(routing.id));

    const refused = await fixture.engine.dispatch(
      fixture.command(routing, 'APPROVAL.REQUEST', { reason: 'risk LOW', payload: { riskLevel: 'LOW' } }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('POLICY_DENIED');
    expect(JSON.stringify(await fixture.engine.readRun(routing.id))).toBe(before);
    expect(fixture.approvals.snapshot()).toHaveLength(0);
  });

  it('writes NO approval record when the transition itself is illegal (HIGH finding)', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun(); // IDLE: APPROVAL.REQUEST has no legal edge
    const eventsBefore = await fixture.events.lastPosition();

    const refused = await fixture.engine.dispatch(
      fixture.command(run, 'APPROVAL.REQUEST', { reason: 'risk HIGH', payload: { riskLevel: 'HIGH' } }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('ILLEGAL_TRANSITION');

    // No orphan pending approval, no state change, no event.
    expect(fixture.approvals.snapshot()).toEqual([]);
    expect((await fixture.engine.readRun(run.id))?.state).toBe('IDLE');
    expect(await fixture.events.lastPosition()).toBe(eventsBefore);

    // …and the same command id can be retried once the run reaches ROUTING.
    must(await fixture.engine.drive(run.id, { maxSteps: 3 }));
    const routing = await fixture.engine.readRun(run.id);
    expect(routing?.state).toBe('ROUTING');
    must(
      await fixture.engine.dispatch(
        fixture.command(routing!, 'APPROVAL.REQUEST', { reason: 'risk HIGH', payload: { riskLevel: 'HIGH' } }),
      ),
    );
    expect((await fixture.engine.readRun(run.id))?.state).toBe('WAITING_APPROVAL');
  });

  it('does not decide an approval when the grant command is illegal', async () => {
    const fixture = makeFixture();
    const routing = await driveToRouting(fixture);
    must(
      await fixture.engine.dispatch(
        fixture.command(routing, 'APPROVAL.REQUEST', { reason: 'risk HIGH', payload: { riskLevel: 'HIGH' } }),
      ),
    );
    const waiting = await fixture.engine.readRun(routing.id);
    expect(waiting?.state).toBe('WAITING_APPROVAL');

    // A stale grant must not decide anything either.
    const stale = fixture.command(waiting!, 'APPROVAL.GRANT', {
      actorId: 'user_owner',
      expectedRevision: 0,
      payload: { authorities: ['run.approve'] },
    });
    const refusedStale = await fixture.engine.dispatch(stale);
    expect(refusedStale.ok).toBe(false);
    if (!refusedStale.ok) expect(refusedStale.error.code).toBe('CONFLICT');
    expect(fixture.approvals.snapshot()[0]?.status).toBe('pending');

    must(
      await fixture.engine.dispatch(
        fixture.command(waiting!, 'APPROVAL.GRANT', {
          actorId: 'user_owner',
          payload: { authorities: ['run.approve'] },
        }),
      ),
    );
    expect(fixture.approvals.snapshot()[0]?.status).toBe('approved');
  });
});
