/**
 * Scenario H + requirement 12 — an illegal transition is refused **and the run is
 * not modified in any way** (no state write, no revision bump, no event).
 */
import { describe, expect, it } from 'vitest';

import { makeFixture, must, STAGE_ID } from './support.js';

describe('H. illegal transition', () => {
  it('refuses a command that has no edge in the L1 machine', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 4 })); // → EXECUTING

    const executing = await fixture.engine.readRun(run.id);
    expect(executing?.state).toBe('EXECUTING');
    const before = JSON.stringify(executing);
    const eventsBefore = await fixture.events.lastPosition();

    const refused = await fixture.engine.dispatch(fixture.command(executing!, 'DELIVERY.COMPLETE'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('ILLEGAL_TRANSITION');
      expect(refused.error.details['from']).toBe('EXECUTING');
      expect(refused.error.details['event']).toBe('DELIVERED');
    }

    // Requirement 12: byte-identical run, no new event.
    const after = await fixture.engine.readRun(run.id);
    expect(JSON.stringify(after)).toBe(before);
    expect(await fixture.events.lastPosition()).toBe(eventsBefore);
  });

  it('refuses every command once the run is terminal', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();
    must(
      await fixture.engine.drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );
    const completed = await fixture.engine.readRun(run.id);
    expect(completed?.state).toBe('COMPLETED');

    for (const type of ['RUN.START', 'RUN.RESUME', 'RUN.CANCEL'] as const) {
      const refused = await fixture.engine.dispatch(
        fixture.command(completed!, type, type === 'RUN.CANCEL' ? { reason: 'too late' } : {}),
      );
      expect(refused.ok, `${type} must be refused`).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe('ILLEGAL_TRANSITION');
    }
    expect((await fixture.engine.readRun(run.id))?.revision).toBe(completed?.revision);
  });

  it('rejects malformed commands before touching any state', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const eventsBefore = await fixture.events.lastPosition();

    const cases: readonly unknown[] = [
      null,
      'RUN.START',
      { ...fixture.command(run, 'RUN.START'), commandId: '' },
      { ...fixture.command(run, 'RUN.START'), type: 'RUN.NOT_A_COMMAND' },
      { ...fixture.command(run, 'RUN.START'), expectedRevision: -1 },
      { ...fixture.command(run, 'RUN.START'), actorId: '' },
      { ...fixture.command(run, 'RUN.START'), traceId: '' },
      { ...fixture.command(run, 'RUN.PAUSE') }, // reason required
    ];
    for (const malformed of cases) {
      const refused = await fixture.engine.dispatch(malformed);
      expect(refused.ok, `${JSON.stringify(malformed)} must be refused`).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe('INVALID_ARGUMENT');
    }

    expect((await fixture.engine.readRun(run.id))?.state).toBe('IDLE');
    expect(await fixture.events.lastPosition()).toBe(eventsBefore);
  });

  it('reports NOT_FOUND for an unknown run without creating anything', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const refused = await fixture.engine.dispatch({
      ...fixture.command(run, 'RUN.START'),
      runId: 'run_missing',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('NOT_FOUND');
    expect(await fixture.events.lastPosition()).toBe(0);
  });

  it('verifies the boundary invariant: every refusal leaves revision untouched', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const attempts = ['RUN.RESUME', 'DELIVERY.COMPLETE', 'REVIEW.PASS', 'VALIDATION.PASS'] as const;

    for (const type of attempts) {
      const current = await fixture.engine.readRun(run.id);
      const revisionBefore = current?.revision ?? -1;
      const refused = await fixture.engine.dispatch(fixture.command(current!, type));
      expect(refused.ok, `${type} must be refused from IDLE`).toBe(false);
      expect((await fixture.engine.readRun(run.id))?.revision).toBe(revisionBefore);
    }
  });
});
