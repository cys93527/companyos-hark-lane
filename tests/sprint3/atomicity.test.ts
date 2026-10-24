/**
 * Sprint 3 requirements 6–7 + tests A, B, C, J:
 * Run state write + Event append + command ledger are ONE transaction, and any failure
 * rolls the whole command back — no half success.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Approval, Task, WorkflowRun } from '@companyos/core';
import { createWorkflowEngine, createScriptedRegistry } from '@companyos/engine';
import type { DurableDatabase } from '@companyos/persistence';

import {
  STAGE_ID,
  failingEventStore,
  failingLedger,
  failingRunStore,
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

describe('A. atomic commit succeeds', () => {
  it('persists run state, events and the ledger entry together', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();

    const result = must(
      await fixture.engine().drive(run.id, {
        stage: { stageId: STAGE_ID, taskIds: [task.id] },
      }),
    );

    expect(result.run.state).toBe('COMPLETED');
    const database = fixture.database();

    // 1) run row
    const stored = (await database.runs.get(run.id)) as WorkflowRun;
    expect(stored.state).toBe('COMPLETED');
    expect(stored.revision).toBe(result.run.revision);
    expect(stored.history).toHaveLength(result.run.history.length);

    // 2) event rows with a dense position sequence
    const events = await database.events.all();
    expect(events.map((entry) => entry.globalPosition)).toEqual(
      events.map((_entry, index) => index + 1),
    );

    // 3) ledger rows (one per applied command)
    expect(await database.ledger.count()).toBe(result.steps);

    // 4) the transaction machinery was actually used
    expect(database.unitOfWork.committed()).toBeGreaterThan(0);
    expect(database.unitOfWork.rolledBack()).toBe(0);
  });

  it('commits nothing when the transition is refused (validity before writes)', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const before = fixture.database().unitOfWork.committed();

    const refused = await fixture.engine().dispatch(fixture.command(run, 'DELIVERY.COMPLETE'));
    expect(refused.ok).toBe(false);
    expect(await fixture.database().events.all()).toHaveLength(0);
    expect(await fixture.database().ledger.count()).toBe(0);
    expect(fixture.database().unitOfWork.committed()).toBe(before);
  });
});

describe('B. event write failure rolls the whole command back', () => {
  it('leaves run state, events and ledger untouched', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const database = fixture.database();
    const engine = createWorkflowEngine({
      ids: fixture.ids,
      clock: fixture.clock,
      runs: database.runs,
      tasks: database.tasks,
      approvals: database.approvals,
      events: failingEventStore(database.events, 1),
      ledger: database.ledger,
      unitOfWork: database.unitOfWork,
      handlers: createScriptedRegistry({}),
    });

    const refused = await engine.dispatch(fixture.command(run, 'RUN.START'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('PERSISTENCE_FAILED');

    // Nothing committed: the run is still IDLE at revision 0 and there is no event.
    const stored = (await database.runs.get(run.id)) as WorkflowRun;
    expect(stored.state).toBe('IDLE');
    expect(stored.revision).toBe(0);
    expect(await database.events.all()).toHaveLength(0);
    expect(await database.ledger.count()).toBe(0);
    expect(database.unitOfWork.rolledBack()).toBe(1);
  });
});

describe('C. ledger write failure rolls the whole command back', () => {
  it('leaves no state change and no event behind', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const database = fixture.database();
    const engine = createWorkflowEngine({
      ids: fixture.ids,
      clock: fixture.clock,
      runs: database.runs,
      tasks: database.tasks,
      approvals: database.approvals,
      events: database.events,
      ledger: failingLedger(database.ledger, 1),
      unitOfWork: database.unitOfWork,
      handlers: createScriptedRegistry({}),
    });

    const refused = await engine.dispatch(fixture.command(run, 'RUN.START'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('PERSISTENCE_FAILED');

    const stored = (await database.runs.get(run.id)) as WorkflowRun;
    expect(stored.state).toBe('IDLE');
    expect(stored.revision).toBe(0);
    // The event append happened inside the transaction and was rolled back with it.
    expect(await database.events.all()).toHaveLength(0);
    expect(await database.ledger.count()).toBe(0);
    expect(database.unitOfWork.rolledBack()).toBe(1);
  });
});

describe('J. mid-transaction exception leaves no half success', () => {
  it('rolls back the run write and the event append together', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const database = fixture.database();
    const engine = createWorkflowEngine({
      ids: fixture.ids,
      clock: fixture.clock,
      runs: failingRunStore(database.runs, 1),
      tasks: database.tasks,
      approvals: database.approvals,
      events: database.events,
      ledger: database.ledger,
      unitOfWork: database.unitOfWork,
      handlers: createScriptedRegistry({}),
    });

    const refused = await engine.dispatch(fixture.command(run, 'RUN.START'));
    expect(refused.ok).toBe(false);

    // The first write failed, so neither the event nor the ledger row may exist.
    expect(await database.events.all()).toHaveLength(0);
    expect(await database.ledger.count()).toBe(0);
    expect(database.unitOfWork.rolledBack()).toBe(1);
    expect(((await database.runs.get(run.id)) as WorkflowRun).state).toBe('IDLE');
  });

  it('rolls back an approval side effect too', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    // Legal state for an approval request.
    const planned = must(await fixture.engine().drive(run.id, { maxSteps: 3 }));
    expect(planned.run.state).toBe('ROUTING');

    const database = fixture.database();
    const engine = createWorkflowEngine({
      ids: fixture.ids,
      clock: fixture.clock,
      runs: database.runs,
      tasks: database.tasks,
      approvals: database.approvals,
      events: failingEventStore(database.events, 1),
      ledger: database.ledger,
      unitOfWork: database.unitOfWork,
      handlers: createScriptedRegistry({}),
    });

    const routing = (await database.runs.get(run.id)) as WorkflowRun;
    const refused = await engine.dispatch(
      fixture.command(routing, 'APPROVAL.REQUEST', {
        reason: 'risk HIGH',
        payload: { riskLevel: 'HIGH' },
      }),
    );
    expect(refused.ok).toBe(false);

    // The approval row was created inside the transaction and rolled back with it.
    const approvals = (await database.approvals.list()).items as readonly Approval[];
    expect(approvals).toHaveLength(0);
    expect(((await database.runs.get(run.id)) as WorkflowRun).state).toBe('ROUTING');
  });

  it('keeps a successful stage fully committed (task + events + run)', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();
    must(
      await fixture.engine().drive(run.id, { stage: { stageId: STAGE_ID, taskIds: [task.id] } }),
    );
    const stored = (await fixture.database().tasks.get(task.id)) as Task;
    expect(stored.state).toBe('DONE');
    expect(stored.attempts).toBe(1);
  });

  it('rolls the whole stage back — including task writes — when an event write fails', async () => {
    const fixture = make();
    const run = await fixture.seedRun();
    const task = await fixture.seedTask();
    must(await fixture.engine().drive(run.id, { maxSteps: 4 })); // → EXECUTING

    const database = fixture.database();
    const engine = createWorkflowEngine({
      ids: fixture.ids,
      clock: fixture.clock,
      runs: database.runs,
      tasks: database.tasks,
      approvals: database.approvals,
      // Fail on the FOURTH append — the run-level `run.execution_done`, which happens
      // AFTER the task reached DONE and its three task events were appended. A failure
      // there can only be undone by a real transaction, so the assertions below
      // discriminate "rolled back" from "never written" (review condition).
      events: failingEventStore(database.events, 4),
      ledger: database.ledger,
      unitOfWork: database.unitOfWork,
      handlers: createScriptedRegistry({}),
    });

    const executing = (await database.runs.get(run.id)) as WorkflowRun;
    await expect(
      engine.advance({
        runId: executing.id,
        stageId: STAGE_ID,
        taskIds: [task.id],
        snapshot: { snapshotId: executing.snapshotId } as never,
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });

    // Task state, task events and the run transition all rolled back together
    // (Sprint 3 review HIGH-1: stage execution is one transaction).
    const stored = (await database.tasks.get(task.id)) as Task;
    expect(stored.state).toBe('PENDING');
    expect(stored.attempts).toBe(0);
    expect(((await database.runs.get(run.id)) as WorkflowRun).state).toBe('EXECUTING');
    const taskEvents = (await database.events.all()).filter(
      (entry) => entry.event.aggregateType === 'Task',
    );
    expect(taskEvents).toHaveLength(0);
    expect(database.unitOfWork.rolledBack()).toBe(1);
  });
});

/** Compile-time proof that the durable stores satisfy the Core ports. */
const _portCheck = (database: DurableDatabase): void => {
  const runs: { get(id: string): Promise<WorkflowRun | null> } = database.runs;
  const approvals: { list(): Promise<unknown> } = database.approvals;
  void runs;
  void approvals;
};
void _portCheck;
