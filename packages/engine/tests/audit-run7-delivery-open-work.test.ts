/**
 * AUDIT-RUN7-3 (v0.1.1 acceptance run 7, hark-live-goal 41641255275): the execution run was delivered
 * (FINALIZING -> DELIVERY.COMPLETE -> COMPLETED, actor engine.driver) while its descendant reassessment task
 * tsk_de8dd... was still PENDING with 0 attempts. The Goal's success contract requires every task terminal,
 * so the Goal run stayed EXECUTING and the autonomy driver stopped with AUTONOMY_STALLED. Invariant: a run is
 * never delivered over open work; FINALIZING with open work (no legal way back to EXECUTING) terminates
 * with a typed reason instead of stalling.
 */
import { describe, expect, it } from 'vitest';

import {
  FixedClock,
  SequenceIdFactory,
  createTask,
  createWorkflowRun,
  type Approval,
  type RoleId,
  type RunSnapshotId,
  type StageId,
  type Task,
  type WorkflowId,
  type WorkflowRun,
  type WorkflowTemplateId,
  type WorkflowVersionId,
} from '@companyos/core';
import {
  createInMemoryEntityStore,
  createInMemoryEventStore,
  createScriptedRegistry,
  createWorkflowEngine,
} from '@companyos/engine';

const STAGE = 'stg_1' as StageId;

const fixture = () => {
  const clock = new FixedClock(Date.parse('2026-11-03T13:00:00.000Z'));
  const ids = new SequenceIdFactory();
  const runs = createInMemoryEntityStore<WorkflowRun>();
  const tasks = createInMemoryEntityStore<Task>();
  const approvals = createInMemoryEntityStore<Approval>();
  const events = createInMemoryEventStore();
  const taskIds: string[] = [];
  const tasksOfRun = async (runId: string): Promise<readonly Task[]> => {
    const rows: Task[] = [];
    for (const id of taskIds) {
      const row = await tasks.get(id as never);
      if (row !== null && String(row.runId) === runId) rows.push(row);
    }
    return rows;
  };
  const engine = createWorkflowEngine({
    ids, clock, runs, tasks, approvals, events, handlers: createScriptedRegistry({}), tasksOfRun,
  });
  const seedRun = async (): Promise<WorkflowRun> => {
    const created = createWorkflowRun({
      companyId: 'cmp_1' as never, workflowId: 'wfl_1' as WorkflowId, templateId: 'tpl_1' as WorkflowTemplateId,
      versionId: 'ver_1' as WorkflowVersionId, snapshotId: 'snp_1' as RunSnapshotId, startedBy: 'user_owner',
      now: clock.nowIso(), ids,
    });
    if (!created.ok) throw new Error(created.error.message);
    await runs.put(created.value);
    return created.value;
  };
  const seedTask = async (runId: string): Promise<Task> => {
    const created = createTask({
      runId: runId as never, stageId: STAGE, roleId: 'rol_1' as RoleId, kind: 'pack-a:build', now: clock.nowIso(), ids,
    });
    if (!created.ok) throw new Error(created.error.message);
    await tasks.put(created.value);
    taskIds.push(String(created.value.id));
    return created.value;
  };
  return { engine, runs, seedRun, seedTask, clock };
};

/** Drive to FINALIZING (7 steps: start, resolve, plan, route, execute, review, validate). */
const toFinalizing = async (f: ReturnType<typeof fixture>): Promise<WorkflowRun> => {
  const run = await f.seedRun();
  const work = await f.seedTask(String(run.id));
  const driven = await f.engine.drive(run.id, { stage: { stageId: STAGE, taskIds: [work.id] }, maxSteps: 7 });
  if (!driven.ok) throw new Error(driven.error.message);
  expect(driven.value.run.state).toBe('FINALIZING');
  return driven.value.run;
};

describe('AUDIT-RUN7-3 a run is never delivered over open work', () => {
  it('DELIVERY.COMPLETE is refused while a (corrective/reassessment) task is still PENDING', async () => {
    const f = fixture();
    const run = await toFinalizing(f);
    const pending = await f.seedTask(String(run.id));
    const delivered = await f.engine.dispatch({
      commandId: 'deliver-1', runId: run.id, type: 'DELIVERY.COMPLETE', expectedRevision: run.revision,
      actorId: 'tester', traceId: 'trace_t', issuedAt: f.clock.nowIso(),
    });
    expect(delivered.ok).toBe(false);
    if (delivered.ok) return;
    expect(delivered.error.details['reason']).toBe('RUN_DELIVERY_OPEN_WORK');
    expect(delivered.error.details['openTaskIds']).toEqual([String(pending.id)]);
    expect((await f.runs.get(run.id))?.state).toBe('FINALIZING');
  });

  it('the driver terminates FINALIZING-with-open-work as FAILED (delivery_failed), never COMPLETED or a stall', async () => {
    const f = fixture();
    const run = await toFinalizing(f);
    await f.seedTask(String(run.id));
    const driven = await f.engine.drive(run.id, {});
    expect(driven.ok).toBe(true);
    if (!driven.ok) return;
    expect(driven.value.stopReason).toBe('terminal');
    expect(driven.value.run.state).toBe('FAILED');
    expect(driven.value.run.failureReason).toBe('delivery_failed');
  });

  it('with every task terminal the run is delivered as before', async () => {
    const f = fixture();
    const run = await toFinalizing(f);
    const driven = await f.engine.drive(run.id, {});
    expect(driven.ok && driven.value.run.state).toBe('COMPLETED');
  });
});
