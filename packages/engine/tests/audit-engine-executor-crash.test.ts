/**
 * AUDIT-E1 regression (engine area).
 * E-crash: a stage handler that THROWS on the task's last attempt leaves the task FAILED but
 * never dispatches EXECUTION.FAIL — the run stays EXECUTING (contrast: a handler that RETURNS
 * 'failed' fails the run, see retry.test.ts "C. retry exhausted").
 */
import { describe, expect, it } from 'vitest';
import { ok, type Approval, type ExecutionAttempt, type Task, type WorkflowRun } from '@companyos/core';
import {
  createInMemoryEntityStore,
  createInMemoryEventStore,
  createWorkflowEngine,
} from '@companyos/engine';
import { FixedClock, SequenceIdFactory, createTask, createWorkflowRun } from '@companyos/core';

const attemptsStore = () => {
  const rows = new Map<string, ExecutionAttempt>();
  return {
    async claim(a: ExecutionAttempt) { rows.set(a.seed.id, a); return ok({ attemptId: a.seed.id, replayed: false }); },
    async get(id: string) { return rows.get(id) ?? null; },
    async byTaskAndAttempt(taskId: string, n: number) { return [...rows.values()].find((r) => r.seed.taskId === taskId && r.seed.attemptNumber === n) ?? null; },
    async activeOfTask(taskId: string) { return [...rows.values()].find((r) => r.seed.taskId === taskId && r.state === 'ACTIVE') ?? null; },
    async transition(input: { attemptId: string; to: ExecutionAttempt['state']; now: string }) {
      const cur = rows.get(input.attemptId)!; const next = { ...cur, state: input.to, settledAt: input.now };
      rows.set(input.attemptId, next); return ok(next);
    },
  };
};

const build = (mode: 'throw' | 'return-failed') => {
  const clock = new FixedClock(Date.parse('2026-04-01T00:00:00.000Z'));
  const ids = new SequenceIdFactory();
  const runs = createInMemoryEntityStore<WorkflowRun>();
  const tasks = createInMemoryEntityStore<Task>();
  const approvals = createInMemoryEntityStore<Approval>();
  const events = createInMemoryEventStore();
  const handlers = { resolve: () => ({ id: 'h', execute: async () => { if (mode === 'throw') throw new Error('executor crashed'); return 'failed' as const; } }) };
  const engine = createWorkflowEngine({ ids, clock, runs, tasks, approvals, events, handlers: handlers as never, executionAttempts: attemptsStore() as never });
  return { clock, ids, runs, tasks, engine };
};

describe('AUDIT E-crash', () => {
  for (const mode of ['return-failed', 'throw'] as const) {
    it(`last-attempt executor ${mode}: run must leave EXECUTING`, async () => {
      const f = build(mode);
      const run = createWorkflowRun({ companyId: 'cmp_1' as never, workflowId: 'w' as never, templateId: 't' as never, versionId: 'v' as never, snapshotId: 's' as never, startedBy: 'user_owner', now: f.clock.nowIso(), ids: f.ids });
      if (!run.ok) throw new Error(run.error.message);
      await f.runs.put(run.value);
      const task = createTask({ runId: run.value.id as never, stageId: 'stg_1' as never, roleId: 'rol_1' as never, kind: 'k', now: f.clock.nowIso(), ids: f.ids, maxAttempts: 1 });
      if (!task.ok) throw new Error(task.error.message);
      await f.tasks.put(task.value);
      const driven = await f.engine.drive(run.value.id, { stage: { stageId: 'stg_1' as never, taskIds: [task.value.id] } } as never);
      expect(driven.ok).toBe(true);
      const storedRun = await f.engine.readRun(run.value.id);
      const storedTask = await f.tasks.get(task.value.id);
      expect(storedTask?.state).toBe('FAILED');
      expect(storedRun?.state).toBe('FAILED');
    });
  }
});
