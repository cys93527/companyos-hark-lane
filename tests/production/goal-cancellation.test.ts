import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createGoalExecutionBudget, createWorkflowEngine } from '@companyos/engine';
import { COMPANY, composeF5, recomposeF5Over, createdDirs, openDatabases } from './helpers/f5-fixture.js';
import { createExecutionSafetyCoordinator, type GoalSafetyConfiguration } from '../../apps/desktop/src/execution-safety-coordinator.js';
import { productionCompositionOptions } from '../../apps/desktop/src/production-composition.js';

afterEach(() => { while (openDatabases.length) openDatabases.pop()?.close(); while (createdDirs.length) rmSync(createdDirs.pop()!, { recursive: true, force: true }); });
const config: GoalSafetyConfiguration = {
  policyId: 'OFFLINE_TEST', maxCalls: 20, maxTokens: 1000000, maxCostMicros: 1000000, durationMs: 120000,
  boundOf: ({ modelKey }) => ({ modelKey, inputTokens: 20000, outputTokens: 16000, costMicros: 1000, evidenceRef: 'OFFLINE_ONLY', validUntilMs: Date.now() + 120000 }),
  costOf: () => 1,
};
const goal = async (f: Awaited<ReturnType<typeof composeF5>>) => {
  const created = await f.core.controlPlane!.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: 'offline cancellation fixture', commandId: 'cancel-fixture' } });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return (created.value as { runId: string }).runId;
};

describe('ADR-B production cancellation wiring (deterministic provider, no live execution)', () => {
  it.each(['deadline', 'cancel'])('a late accounted response after %s cannot be published as success', async (stop) => {
    const f = await composeF5(); const runId = await goal(f);
    const run = await f.core.database.runs.get(runId); if (run === null) throw new Error('fixture Run missing');
    let now = Date.parse(run.createdAt);
    const safety = createExecutionSafetyCoordinator(f.core.database, config, () => now);
    await safety.initialize(runId);
    const admitted = await safety.admit({ runId, executionId: 'offline-late-accounting', modelKey: 'offline', networkAttempt: 1, maxOutputTokens: 10 });
    try {
      if (stop === 'deadline') now += config.durationMs;
      else await safety.requestCancel(runId);
      await expect(admitted.settle({ inputTokens: 2, outputTokens: 3, totalCost: 1 })).rejects.toMatchObject({ details: { reason: stop === 'deadline' ? 'GOAL_DEADLINE_EXCEEDED' : 'GOAL_CANCEL_REQUESTED' } });
      const state = await safety.budget.read(runId);
      expect(state.reservations[0]?.status).toBe('KNOWN');
      expect(state.reservations[0]?.usage).toEqual({ tokens: 5, costMicros: 1 });
      await expect(safety.admit({ runId, executionId: 'offline-no-new-call', modelKey: 'offline', networkAttempt: 1, maxOutputTokens: 10 })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect((await safety.budget.read(runId)).reservations).toHaveLength(1);
      expect(f.rawInvocations.n).toBe(0);
    } finally { admitted.release(); }
  });
  it('the actual production default denies external calls without deployment proof', async () => {
    const f = await composeF5({ executionSafety: productionCompositionOptions({}).executionSafety }); const runId = await goal(f);
    const result = await f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId } });
    expect(result.ok).toBe(false); expect(f.rawInvocations.n).toBe(0);
    expect((await createGoalExecutionBudget(f.core.database.executionBudget, Date.now).read(runId)).reservations).toHaveLength(0);
  });
  it.each(['success', 'throw', 'malformed'])('durable cancellation wins a late offline executor %s without output revival', async (completion) => {
    const f = await composeF5({ executionSafety: config }); const runId = await goal(f);
    const run = await f.core.database.runs.get(runId); if (run === null) throw new Error('fixture Run missing');
    // Explicit canonical fixture state: no GUI, live model or DSH is started.
    await f.core.database.runs.put({ ...run, state: 'EXECUTING' });
    const made = await f.core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId, stageId: 'plan' }); if (!made.ok) throw made.error;
    let entered!: () => void; let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const budget = createGoalExecutionBudget(f.core.database.executionBudget, Date.now);
    const engine = createWorkflowEngine({ ids: f.core.ids, clock: f.core.clock, runs: f.core.database.runs, tasks: f.core.database.tasks, events: f.core.database.events, approvals: f.core.database.approvals, ledger: f.core.database.ledger, unitOfWork: f.core.database.unitOfWork, executionAttempts: f.core.database.executionAttempts, runtimeInstanceId: 'offline-cancel-test', cancellation: { requested: budget.isCancelled, request: (id) => budget.requestCancel(id, 'offline') }, handlers: { resolve: () => ({ id: 'offline-late-handler', execute: async () => { entered(); await released; if (completion === 'throw') throw new Error('offline late crash'); if (completion === 'malformed') return { status: 'not-a-result' } as never; return { status: 'succeeded' }; } }) } });
    const pending = engine.advance({ runId, stageId: 'plan', taskIds: [made.value.taskId], snapshot: null } as never);
    await enteredPromise; await budget.requestCancel(runId, 'cancel-active-claim'); release(); await pending;
    expect((await f.core.database.tasks.get(made.value.taskId))?.state).toBe('CANCELLED');
    expect(f.core.database.db.prepare('SELECT state FROM execution_attempts WHERE task_id = ?').all(made.value.taskId)).toEqual([{ state: 'INTERRUPTED' }]);
    expect((await f.core.database.runs.get(runId))?.failureReason).toBe('cancelled');
    const second = await engine.advance({ runId, stageId: 'plan', taskIds: [made.value.taskId], snapshot: null } as never);
    expect(second.outcome).toBe('failed');
    expect(f.core.database.db.prepare('SELECT state FROM execution_attempts WHERE task_id = ?').all(made.value.taskId)).toHaveLength(1);
  });
  it('a fresh composition preserves cancellation and refuses recovery dispatch', async () => {
    const f = await composeF5({ executionSafety: config }); const runId = await goal(f);
    await f.core.controlPlane!.handle({ operation: 'goal.cancel', payload: { runId } });
    await expect.poll(async () => (await f.core.database.runs.get(runId))?.failureReason).toBe('cancelled');
    const reopened = await recomposeF5Over(f, config);
    expect(await createGoalExecutionBudget(reopened.database.executionBudget, Date.now).isCancelled(runId)).toBe(true);
    const advanced = await reopened.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId } });
    expect(advanced.ok).toBe(false);
    expect(f.rawInvocations.n).toBe(0);
    expect((await reopened.database.runs.get(runId))?.failureReason).toBe('cancelled');
  });
  it('accepts durable intent separately from unconfirmed stop and prevents later model invocation', async () => {
    const f = await composeF5({ executionSafety: config }); const runId = await goal(f);
    const result = await f.core.controlPlane!.handle({ operation: 'goal.cancel', payload: { runId } });
    expect(result).toEqual({ ok: true, value: { accepted: true, stopped: false, stopEvidence: 'NOT_CONFIRMED' } });
    const budget = createGoalExecutionBudget(f.core.database.executionBudget, Date.now);
    expect(await budget.isCancelled(runId)).toBe(true);
    await f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId } });
    expect(f.rawInvocations.n).toBe(0);
    await expect.poll(async () => (await f.core.database.runs.get(runId))?.failureReason).toBe('cancelled');
    expect((await f.core.database.runs.get(runId))?.state).toBe('FAILED');
  });
  it('a missing financial/token proof fails closed before a real provider-shaped invocation', async () => {
    const f = await composeF5({ executionSafety: { ...config, boundOf: () => null } }); const runId = await goal(f);
    await f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId } });
    expect(f.rawInvocations.n).toBe(0);
  });
  it('Goal policy binds the execution run and does not acquire a new independent budget', async () => {
    const f = await composeF5({ executionSafety: config }); const runId = await goal(f);
    await f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId } });
    const children = f.core.database.db.prepare('SELECT id FROM runs WHERE execution_goal_run_id = ? AND id != ?').all(runId, runId);
    expect(children.length).toBeGreaterThan(0);
    const states = f.core.database.db.prepare('SELECT id FROM runs WHERE execution_budget_json IS NOT NULL').all();
    expect(states).toEqual([{ id: runId }]);
  });
  it('a late model response cannot turn the cancellation winner into COMPLETED', async () => {
    const f = await composeF5({ executionSafety: config }); const runId = await goal(f);
    f.mode.value = 'raw:ok';
    const tasks = await f.core.database.tasks.listByRun(runId);
    // Materialize the pinned planning task through its existing owner.
    const made = await f.core.normalTaskMaterializer!.materialize({ companyId: COMPANY, runId, stageId: 'plan' });
    if (!made.ok) throw made.error;
    const actor = (await f.core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
    const prepared = await f.core.runtime.prepare({ modelKey: 'f5.planner', explicit: true, scopes: [], agentId: 'offline', roleId: 'offline', taskId: made.value.taskId, runId, actorId: actor });
    if (!prepared.ok) throw prepared.error;
    f.executionGate.armed = 'settle';
    const pending = f.core.runtime.run({ executionId: prepared.value.executionId, actorId: actor, context: { company: { id: COMPANY, label: COMPANY }, workflow: { id: 'offline', label: 'offline' }, workflowVersion: 'v1', workflowRun: { id: runId, label: 'run' }, task: { id: made.value.taskId, label: 'offline' }, role: { id: 'offline', label: 'offline' }, objective: 'offline terminal race', constraints: [] } });
    await expect.poll(() => f.executionGate.paused).toBe(true);
    const budget = createGoalExecutionBudget(f.core.database.executionBudget, Date.now);
    await budget.requestCancel(runId, 'cancel-before-terminal-cas');
    f.executionGate.release(); await pending;
    expect((await f.core.database.agentExecutions.get(prepared.value.executionId))?.status).toBe('CANCELLED');
    const events = f.core.database.db.prepare("SELECT type FROM events WHERE aggregate_id = ? AND type IN ('agent.execution_completed','agent.execution_cancelled')").all(prepared.value.executionId);
    expect(events).toEqual([{ type: 'agent.execution_cancelled' }]);
    expect(tasks).toHaveLength(0);
  });
});
