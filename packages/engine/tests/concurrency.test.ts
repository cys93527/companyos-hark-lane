/**
 * Scenario L + requirement 16 — concurrent commands against the same run.
 *
 * The engine serializes commands per run (FIFO) AND guards with `expectedRevision`,
 * so concurrency can produce exactly two outcomes: one winner + one stale refusal,
 * or two winners applied in arrival order. Never a lost update.
 */
import { describe, expect, it } from 'vitest';

import { makeFixture, must } from './support.js';

describe('L. concurrent commands on one run', () => {
  it('lets exactly one of two same-revision commands win', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 4 })); // → EXECUTING … REVIEWING
    must(
      await fixture.engine.dispatch(
        fixture.command((await fixture.engine.readRun(run.id))!, 'EXECUTION.COMPLETE'),
      ),
    );
    const reviewing = await fixture.engine.readRun(run.id);
    expect(reviewing?.state).toBe('REVIEWING');

    const eventsBefore = await fixture.events.lastPosition();
    const pass = fixture.command(reviewing!, 'REVIEW.PASS');
    const reject = fixture.command(reviewing!, 'REVIEW.REJECT', { reason: 'changes requested' });

    const [a, b] = await Promise.all([fixture.engine.dispatch(pass), fixture.engine.dispatch(reject)]);
    const outcomes = [a, b];
    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (!losers[0]!.ok) expect(losers[0]!.error.code).toBe('CONFLICT');
    if (!losers[0]!.ok) expect(losers[0]!.error.details['reason']).toBe('stale_revision');

    // Exactly one transition happened — no double write, no lost update.
    const after = await fixture.engine.readRun(run.id);
    expect(after?.revision).toBe(reviewing!.revision + 1);
    expect(after?.history).toHaveLength(reviewing!.history.length + 1);
    expect(await fixture.events.lastPosition()).toBe(eventsBefore + 1);
  });

  it('applies two commands in arrival order when the revisions are sequential', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 2 })); // → PLANNING

    const planning = await fixture.engine.readRun(run.id);
    const plan = fixture.command(planning!, 'PLAN.COMPLETE', { expectedRevision: planning!.revision });
    const route = fixture.command(planning!, 'ROUTE.RESOLVE', {
      expectedRevision: planning!.revision + 1,
    });

    const [first, second] = await Promise.all([
      fixture.engine.dispatch(plan),
      fixture.engine.dispatch(route),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const after = await fixture.engine.readRun(run.id);
    expect(after?.state).toBe('EXECUTING');
    expect(after?.revision).toBe(planning!.revision + 2);
    expect(after?.history.slice(-2).map((change) => change.to)).toEqual(['ROUTING', 'EXECUTING']);
  });

  it('keeps a burst of commands consistent (10 concurrent starts)', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();

    const attempts = Array.from({ length: 10 }, () =>
      fixture.engine.dispatch(fixture.command(run, 'RUN.START', { expectedRevision: 0 })),
    );
    const results = await Promise.all(attempts);
    const okCount = results.filter((result) => result.ok).length;
    const duplicateCount = results.filter((result) => result.ok && result.value.duplicate).length;
    const conflictCount = results.filter(
      (result) => !result.ok && result.error.code === 'CONFLICT',
    ).length;

    // Exactly one real effect; the rest are either stale-revision conflicts or
    // replays of the same command id (each call built a fresh id, so conflicts).
    expect(okCount).toBe(1);
    expect(duplicateCount).toBe(0);
    expect(conflictCount).toBe(9);

    const after = await fixture.engine.readRun(run.id);
    expect(after?.state).toBe('INITIALIZING');
    expect(after?.revision).toBe(1);
    expect(await fixture.events.lastPosition()).toBe(1);
  });

  it('serializes commands for the same run but not across runs', async () => {
    const fixture = makeFixture();
    const first = await fixture.seedRun();
    const second = await fixture.seedRun();

    const [a, b] = await Promise.all([
      fixture.engine.dispatch(fixture.command(first, 'RUN.START')),
      fixture.engine.dispatch(fixture.command(second, 'RUN.START')),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect((await fixture.engine.readRun(first.id))?.state).toBe('INITIALIZING');
    expect((await fixture.engine.readRun(second.id))?.state).toBe('INITIALIZING');
    expect(await fixture.events.lastPosition()).toBe(2);
  });
});
