/**
 * Scenario J + requirement 15 — revision-based optimistic concurrency: a command
 * built against an old revision can never be applied.
 */
import { describe, expect, it } from 'vitest';

import { makeFixture, must } from './support.js';

describe('J. stale revision', () => {
  it('refuses a stale command and leaves the run untouched', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 2 })); // → PLANNING

    const planning = await fixture.engine.readRun(run.id);
    expect(planning?.revision).toBe(2);
    const eventsBefore = await fixture.events.lastPosition();
    const before = JSON.stringify(planning);

    const stale = fixture.command(planning!, 'PLAN.COMPLETE', { expectedRevision: planning!.revision - 1 });
    const refused = await fixture.engine.dispatch(stale);

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('CONFLICT');
      expect(refused.error.details['reason']).toBe('stale_revision');
      expect(refused.error.details['expectedRevision']).toBe(1);
      expect(refused.error.details['actualRevision']).toBe(2);
    }
    expect(JSON.stringify(await fixture.engine.readRun(run.id))).toBe(before);
    expect(await fixture.events.lastPosition()).toBe(eventsBefore);
  });

  it('refuses a command built for a revision that does not exist yet', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const ahead = fixture.command(run, 'RUN.START', { expectedRevision: run.revision + 1 });

    const refused = await fixture.engine.dispatch(ahead);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('CONFLICT');
    expect((await fixture.engine.readRun(run.id))?.state).toBe('IDLE');
  });

  it('bumps the revision by exactly one per applied command', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();

    let revision = 0;
    for (const type of ['RUN.START', 'TEMPLATE.RESOLVE', 'PLAN.COMPLETE', 'ROUTE.RESOLVE'] as const) {
      const current = await fixture.engine.readRun(run.id);
      expect(current?.revision).toBe(revision);
      const applied = must(await fixture.engine.dispatch(fixture.command(current!, type)));
      revision += 1;
      expect(applied.revision).toBe(revision);
    }

    const final = await fixture.engine.readRun(run.id);
    expect(final?.state).toBe('EXECUTING');
    expect(final?.revision).toBe(4);
    expect(final?.history).toHaveLength(4);
  });

  it('lets the caller recover from a stale command by re-reading the revision', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 2 }));

    const planning = await fixture.engine.readRun(run.id);
    const stale = fixture.command(planning!, 'PLAN.COMPLETE', { expectedRevision: 0 });
    expect((await fixture.engine.dispatch(stale)).ok).toBe(false);

    const fresh = await fixture.engine.readRun(run.id);
    const applied = must(await fixture.engine.dispatch(fixture.command(fresh!, 'PLAN.COMPLETE')));
    expect(applied.to).toBe('ROUTING');
    expect((await fixture.engine.readRun(run.id))?.revision).toBe((fresh?.revision ?? 0) + 1);
  });
});
