/**
 * Scenario I + requirement 13 — idempotency: the same `commandId` has exactly one
 * effect, and reusing a key with different content is a conflict.
 */
import { describe, expect, it } from 'vitest';

import { FixedClock, SequenceIdFactory } from '@companyos/core';
import type { Approval, Task, WorkflowRun } from '@companyos/core';
import {
  createInMemoryEntityStore,
  createInMemoryEventStore,
  createScriptedRegistry,
  createWorkflowEngine,
} from '@companyos/engine';

import { makeFixture, must, STAGE_ID } from './support.js';

describe('I. duplicate command', () => {
  it('applies a command at most once and replays the recorded outcome', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const command = fixture.command(run, 'RUN.START');

    const first = must(await fixture.engine.dispatch(command));
    expect(first.duplicate).toBe(false);
    expect(first.to).toBe('INITIALIZING');

    const eventsAfterFirst = await fixture.events.lastPosition();
    const replay = must(await fixture.engine.dispatch(command));

    expect(replay.duplicate).toBe(true);
    expect(replay.from).toBe(first.from);
    expect(replay.to).toBe(first.to);
    expect(replay.revision).toBe(first.revision);
    expect(replay.eventTypes).toEqual(first.eventTypes);

    // No second effect: no extra event, no extra revision, no extra history entry.
    expect(await fixture.events.lastPosition()).toBe(eventsAfterFirst);
    const stored = await fixture.engine.readRun(run.id);
    expect(stored?.revision).toBe(1);
    expect(stored?.history).toHaveLength(1);
  });

  it('conflicts when the same key is reused with different content', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    const command = fixture.command(run, 'RUN.START');
    must(await fixture.engine.dispatch(command));

    const different = { ...command, type: 'RUN.CANCEL' as const, reason: 'changed my mind' };
    const refused = await fixture.engine.dispatch(different);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('CONFLICT');
      expect(refused.error.details['commandId']).toBe(command.commandId);
    }
    expect((await fixture.engine.readRun(run.id))?.state).toBe('INITIALIZING');
  });

  it('keeps the ledger bounded and evicts the oldest entries first', async () => {
    const runs = createInMemoryEntityStore<WorkflowRun>();
    const tasks = createInMemoryEntityStore<Task>();
    const approvals = createInMemoryEntityStore<Approval>();
    const events = createInMemoryEventStore();
    const engine = createWorkflowEngine({
      ids: new SequenceIdFactory(),
      clock: new FixedClock(Date.parse('2026-04-01T00:00:00.000Z')),
      runs,
      tasks,
      approvals,
      events,
      handlers: createScriptedRegistry({}),
      maxLedgerEntries: 1,
    });

    const fixture = makeFixture();
    const run = await fixture.seedRun();
    await runs.put(run);

    const first = { ...fixture.command(run, 'RUN.START'), commandId: 'cmd_a' };
    must(await engine.dispatch(first));
    const second = { ...fixture.command(run, 'TEMPLATE.RESOLVE'), commandId: 'cmd_b' };
    // cmd_b is dispatched with the revision observed after cmd_a.
    const afterFirst = await engine.readRun(run.id);
    if (afterFirst === null) throw new Error('run disappeared');
    must(await engine.dispatch({ ...second, expectedRevision: afterFirst.revision }));

    // `cmd_a` has been evicted, so replaying it is no longer recognised as duplicate:
    // it fails on the stale revision instead of silently succeeding.
    const replay = await engine.dispatch({ ...first, expectedRevision: first.expectedRevision });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe('CONFLICT');
  });

  it('treats two different command ids for the same intent as two effects', async () => {
    const fixture = makeFixture();
    const run = await fixture.seedRun();
    must(await fixture.engine.drive(run.id, { maxSteps: 2 }));
    const planning = await fixture.engine.readRun(run.id);

    must(await fixture.engine.dispatch(fixture.command(planning!, 'PLAN.COMPLETE')));
    const routing = await fixture.engine.readRun(run.id);
    expect(routing?.state).toBe('ROUTING');
    // A second, distinct command id is a genuinely new intent — and is refused
    // because PLAN.COMPLETE is not legal in ROUTING.
    const refused = await fixture.engine.dispatch(fixture.command(routing!, 'PLAN.COMPLETE'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('drives a full run deterministically when replayed with the same ids', async () => {
    const build = async () => {
      const fixture = makeFixture();
      const run = await fixture.seedRun();
      const task = await fixture.seedTask();
      must(
        await fixture.engine.drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
      );
      return (await fixture.engine.readRun(run.id))!;
    };
    const first = await build();
    const second = await build();
    expect(second.state).toBe(first.state);
    expect(second.revision).toBe(first.revision);
    expect(second.history).toEqual(first.history);
  });
});
