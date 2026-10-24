/**
 * Regression test for the deadlock the Sprint 2 review demanded be guarded:
 * a `StageHandler` that calls back into `engine.dispatch()` for its own run would
 * await the promise chain it is already inside. The engine refuses it with
 * `CONFLICT` (`reentrant_dispatch`) instead of hanging — and genuine concurrent
 * callers must NOT be misclassified (that is why detection is async-context based).
 */
import { describe, expect, it } from 'vitest';

import {
  createWorkflowEngine,
  type StageHandlerOutcome,
  type StageHandlerRegistry,
  type WorkflowEngine,
} from '@companyos/engine';

import { makeFixture, must, STAGE_ID } from './support.js';

describe('re-entrant dispatch is refused, not deadlocked', () => {
  it('returns CONFLICT when a handler dispatches a command for its own run', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    let engine: WorkflowEngine | null = null;
    let observedCode: string | null = null;
    let observedReason: unknown = null;

    const reentrant: StageHandlerRegistry = {
      resolve: () => ({
        id: 'stub.reentrant',
        execute: async (context): Promise<StageHandlerOutcome> => {
          const outcome = await engine!.dispatch({
            commandId: 'cmd_from_handler',
            runId: context.runId as never,
            type: 'RUN.PAUSE',
            expectedRevision: 0,
            actorId: 'handler',
            traceId: 'trace_handler',
            issuedAt: '2026-04-01T00:00:00.000Z',
            reason: 'handler tried to pause its own run',
          });
          if (!outcome.ok) {
            observedCode = outcome.error.code;
            observedReason = outcome.error.details['reason'];
          }
          return 'succeeded';
        },
      }),
    };

    engine = createWorkflowEngine({
      ids: fixture.ids,
      clock: fixture.clock,
      runs: fixture.runs,
      tasks: fixture.tasks,
      approvals: fixture.approvals,
      events: fixture.events,
      handlers: reentrant,
    });

    const result = must(
      await engine.drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );

    // The guard turned a deadlock into an ordinary, observable refusal.
    expect(observedCode).toBe('CONFLICT');
    expect(observedReason).toBe('reentrant_dispatch');
    // …and the run still completes normally.
    expect(result.run.state).toBe('COMPLETED');
    expect((await fixture.tasks.get(task.id))?.state).toBe('DONE');
  });

  it('does not misclassify two genuine concurrent callers as re-entrant', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 2 })); // → PLANNING
    const planning = await fixture.engine.readRun(run.id);

    const [first, second] = await Promise.all([
      fixture.engine.dispatch(fixture.command(planning!, 'PLAN.COMPLETE')),
      fixture.engine.dispatch(fixture.command(planning!, 'PLAN.COMPLETE')),
    ]);

    const codes = [first, second].map((result) =>
      result.ok ? 'ok' : (result.error.details['reason'] as string | undefined) ?? result.error.code,
    );
    // Exactly one wins; the loser is a stale-revision conflict, never 'reentrant_dispatch'.
    expect(codes.filter((code) => code === 'ok')).toHaveLength(1);
    expect(codes).not.toContain('reentrant_dispatch');
  });

  it('still allows a legitimate command after the in-flight section ends', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 2 })); // → PLANNING
    const planning = await fixture.engine.readRun(run.id);

    const applied = must(await fixture.engine.dispatch(fixture.command(planning!, 'PLAN.COMPLETE')));
    expect(applied.to).toBe('ROUTING');
  });
});
