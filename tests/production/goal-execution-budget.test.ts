import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type GoalBudgetPolicy, type CostAdmissionBound } from '@companyos/core';
import { createGoalExecutionBudget } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const dirs: string[] = [];
const databases: DurableDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const policy: GoalBudgetPolicy = { policyId: 'offline-policy-1', maxCalls: 2, maxTokens: 100, maxCostMicros: 100, deadlineMs: 2000 };
const bound: CostAdmissionBound = { modelKey: 'offline-only', inputTokens: 30, outputTokens: 10, costMicros: 40, evidenceRef: 'OFFLINE_TEST_BOUND', validUntilMs: 2000 };
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-budget-')); dirs.push(dir);
  const open = () => { const db = openDurableDatabase({ dataDir: dir, appliedAt: '2026-10-11T00:00:00Z' }); databases.push(db); return db; };
  const db = open();
  for (const id of ['goal', 'child', 'other']) db.db.prepare(`INSERT INTO runs (id,company_id,workflow_id,template_id,version_id,snapshot_id,state,revision,rework_count,max_rework,history_json,created_at,updated_at,started_by) VALUES (?,'company','workflow','template','version','snapshot','IDLE',0,0,3,'[]','now','now','actor')`).run(id);
  const time = { now: 1000 };
  const authority = createGoalExecutionBudget(db.executionBudget, () => time.now);
  const admit = (callId: string, runId = 'goal', b = bound) => authority.reserve({ runId, callId, ownerId: 'execution:offline', bound: b });
  return { db, dir, open, time, authority, admit };
};

describe('ADR-A canonical Goal durable admission (real isolated SQLite, no provider)', () => {
  it('legacy NULL is fail-closed, not an unlimited budget', async () => { const f = fixture(); await expect(f.admit('1')).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_NOT_BOUND' } }); });
  it('caps concurrent reservations atomically across two SQLite connections', async () => {
    const f = fixture(); await f.authority.initialize('goal', { ...policy, maxCalls: 1 });
    const other = createGoalExecutionBudget(f.open().executionBudget, () => f.time.now);
    const results = await Promise.allSettled([f.admit('1'), other.reserve({ runId: 'goal', callId: '2', ownerId: 'other', bound })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await f.authority.read('goal')).reservations).toHaveLength(1);
    await expect(other.reserve({ runId: 'goal', callId: 'after-lock', ownerId: 'other', bound })).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_EXHAUSTED' } });
  });
  it('child run consumes the same Goal budget', async () => { const f = fixture(); await f.authority.initialize('goal', policy); await f.authority.bind('child', 'goal'); await f.admit('1'); await f.admit('2', 'child'); await expect(f.admit('3')).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_EXHAUSTED' } }); });
  it('retry identity is not permission for duplicate remote dispatch', async () => { const f = fixture(); await f.authority.initialize('goal', policy); await f.admit('1'); await expect(f.admit('1')).rejects.toMatchObject({ details: { reason: 'GOAL_CALL_ALREADY_RESERVED' } }); });
  it('policy replay never resets reservations; a changed policy is rejected', async () => { const f = fixture(); await f.authority.initialize('goal', policy); await f.admit('1'); await f.authority.initialize('goal', policy); expect((await f.authority.read('goal')).reservations).toHaveLength(1); await expect(f.authority.initialize('goal', { ...policy, maxCalls: 50 })).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_POLICY_CONFLICT' } }); });
  it('deadline remains persistent after a reopen', async () => { const f = fixture(); await f.authority.initialize('goal', policy); f.time.now = 2000; const second = createGoalExecutionBudget(f.open().executionBudget, () => f.time.now); await expect(second.check('goal')).rejects.toMatchObject({ details: { reason: 'GOAL_DEADLINE_EXCEEDED' } }); });
  it('missing usage stays UNKNOWN and forbids another external call', async () => { const f = fixture(); await f.authority.initialize('goal', policy); await f.admit('1'); await f.authority.settle('goal', '1', null); expect((await f.authority.read('goal')).reservations[0]?.usage).toBeNull(); await expect(f.admit('2')).rejects.toMatchObject({ details: { reason: 'GOAL_USAGE_UNKNOWN' } }); });
  it('crash recovery converts open reservations to UNKNOWN without refund', async () => { const f = fixture(); await f.authority.initialize('goal', policy); await f.admit('1'); const second = createGoalExecutionBudget(f.open().executionBudget, () => f.time.now); await second.recover('goal'); await expect(second.check('goal')).rejects.toMatchObject({ details: { reason: 'GOAL_USAGE_UNKNOWN' } }); expect((await second.read('goal')).reservations[0]?.bound.costMicros).toBe(40); });
  it('known settlement is idempotent, does not refund the call count', async () => { const f = fixture(); await f.authority.initialize('goal', { ...policy, maxCalls: 1 }); await f.admit('1'); await f.authority.settle('goal', '1', { tokens: 5, costMicros: 5 }); await f.authority.settle('goal', '1', { tokens: 5, costMicros: 5 }); await expect(f.admit('2')).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_EXHAUSTED' } }); });
  it('unproven price/token bounds cannot reserve', async () => { const f = fixture(); await f.authority.initialize('goal', policy); await expect(f.admit('1', 'goal', { ...bound, evidenceRef: '' })).rejects.toMatchObject({ details: { reason: 'GOAL_ADMISSION_BOUND_UNPROVEN' } }); });
  it('token and cost admission are independent ceilings', async () => { const f = fixture(); await f.authority.initialize('goal', { ...policy, maxTokens: 39 }); await expect(f.admit('1')).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_EXHAUSTED' } }); const g = fixture(); await g.authority.initialize('goal', { ...policy, maxCostMicros: 39 }); await expect(g.admit('1')).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_EXHAUSTED' } }); });
  it('over-bound or malformed settlement stays UNKNOWN', async () => { const f = fixture(); await f.authority.initialize('goal', policy); await f.admit('1'); await f.authority.settle('goal', '1', { tokens: 41, costMicros: 1 }); expect((await f.authority.read('goal')).reservations[0]?.status).toBe('UNKNOWN'); });
  it('cancellation commits before acceptance and blocks admission after restart', async () => { const f = fixture(); await f.authority.initialize('goal', policy); await f.authority.bind('child', 'goal'); await f.authority.requestCancel('child', 'cancel-1'); const second = createGoalExecutionBudget(f.open().executionBudget, () => f.time.now); await expect(second.check('goal')).rejects.toMatchObject({ details: { reason: 'GOAL_CANCEL_REQUESTED' } }); expect((await second.read('child')).cancellation?.requestId).toBe('cancel-1'); });
  it('cancel/admission races are ordered by the same SQLite transaction authority', async () => { const f = fixture(); await f.authority.initialize('goal', policy); await Promise.all([f.admit('1'), f.authority.requestCancel('goal', 'cancel')]); expect((await f.authority.read('goal')).reservations).toHaveLength(1); await expect(f.admit('2')).rejects.toMatchObject({ details: { reason: 'GOAL_CANCEL_REQUESTED' } }); });
  it('cancel does not fabricate remote cancellation or a usage refund', async () => { const f = fixture(); await f.authority.initialize('goal', policy); await f.admit('1'); await f.authority.requestCancel('goal', 'cancel'); await f.authority.settle('goal', '1', null); const state = await f.authority.read('goal'); expect(state.cancellation).not.toBeNull(); expect(state.reservations[0]?.status).toBe('UNKNOWN'); });
  it('a child cannot be rebound to reset its Goal ownership', async () => { const f = fixture(); await f.authority.initialize('goal', policy); await f.authority.bind('child', 'goal'); await expect(f.authority.bind('child', 'other')).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_OWNER_CONFLICT' } }); });
  it.each(['{', '{}', 'null', '{"goalRunId":"goal","policy":{},"cancellation":null,"reservations":[]}'])('corrupt persisted snapshot is not reset or treated as unlimited: %s', async (raw) => {
    const f = fixture(); await f.authority.initialize('goal', policy);
    f.db.db.prepare('UPDATE runs SET execution_budget_json = ? WHERE id = ?').run(raw, 'goal');
    await expect(f.admit('1')).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_STATE_INVALID' } });
    await expect(f.authority.initialize('goal', policy)).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_STATE_INVALID' } });
    expect((f.db.db.prepare('SELECT execution_budget_json FROM runs WHERE id = ?').get('goal') as { execution_budget_json: string }).execution_budget_json).toBe(raw);
  });
  it('legacy cancellation grants no execution quota and replays the first intent', async () => {
    const f = fixture(); await f.authority.requestCancel('goal', 'first'); await f.authority.requestCancel('goal', 'second');
    expect((await f.authority.read('goal')).policy.maxCalls).toBe(0);
    expect((await f.authority.read('goal')).cancellation?.requestId).toBe('first');
    await expect(f.admit('1')).rejects.toMatchObject({ details: { reason: 'GOAL_CANCEL_REQUESTED' } });
    await expect(f.authority.initialize('goal', policy)).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_POLICY_CONFLICT' } });
  });
  it('canonical Run lifecycle upsert preserves budget, cancellation and immutable binding', async () => {
    const f = fixture(); await f.authority.initialize('goal', policy); await f.admit('1'); await f.authority.requestCancel('goal', 'cancel');
    const before = await f.authority.read('goal'); const run = await f.db.runs.get('goal');
    if (run === null) throw new Error('fixture Run missing');
    await f.db.runs.put({ ...run, revision: run.revision + 1 });
    expect(await f.authority.read('goal')).toEqual(before);
  });
  it('another child cannot settle a reservation owned by its sibling', async () => {
    const f = fixture(); await f.authority.initialize('goal', policy); await f.authority.bind('child', 'goal'); await f.admit('1');
    await expect(f.authority.settle('child', '1', { tokens: 0, costMicros: 0 })).rejects.toMatchObject({ details: { reason: 'GOAL_RESERVATION_NOT_FOUND' } });
    expect((await f.authority.read('goal')).reservations[0]?.status).toBe('RESERVED');
  });
});

describe('RC5 static settlement adjudication (deterministic, no provider)', () => {
  it('known success settles actual usage while retaining the call identity', async () => {
    const f = fixture(); await f.authority.initialize('goal', policy); await f.admit('success');
    await f.authority.settle('goal', 'success', { tokens: 15, costMicros: 7 });
    expect((await f.authority.read('goal')).reservations).toMatchObject([{ callId: 'success', status: 'KNOWN', usage: { tokens: 15, costMicros: 7 } }]);
    await f.authority.check('goal');
    await expect(f.admit('success')).rejects.toMatchObject({ details: { reason: 'GOAL_CALL_ALREADY_RESERVED' } });
  });
  it('a known charge can be settled despite a failed business outcome, without refunding the call', async () => {
    const f = fixture(); await f.authority.initialize('goal', policy); await f.admit('failed-known');
    // The budget API accepts trusted accounting, not a business success flag.
    // This is NOT proof that a typed Provider error carries trusted usage.
    const businessOutcome = { kind: 'failed', reason: 'OFFLINE_FAILURE', usage: { tokens: 15, costMicros: 7 } } as const;
    await f.authority.settle('goal', 'failed-known', businessOutcome.usage);
    expect(businessOutcome.kind).toBe('failed');
    expect((await f.authority.read('goal')).reservations[0]).toMatchObject({ status: 'KNOWN', usage: businessOutcome.usage });
    await f.admit('next');
    expect((await f.authority.read('goal')).reservations.map((r) => r.callId)).toEqual(['failed-known', 'next']);
    await expect(f.admit('third')).rejects.toMatchObject({ details: { reason: 'GOAL_BUDGET_EXHAUSTED' } });
  });
  it('UNKNOWN remains charged across reopen; denial and late zero cannot become success or a refund', async () => {
    const f = fixture(); await f.authority.initialize('goal', policy); await f.admit('unknown');
    await f.authority.settle('goal', 'unknown', null);
    const before = await f.authority.read('goal');
    expect(before.reservations[0]).toMatchObject({ callId: 'unknown', status: 'UNKNOWN', usage: null, bound: { costMicros: 40 } });
    const reopened = createGoalExecutionBudget(f.open().executionBudget, () => f.time.now);
    await expect(reopened.check('goal')).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { reason: 'GOAL_USAGE_UNKNOWN', retryable: false } });
    await expect(reopened.reserve({ runId: 'goal', callId: 'later', ownerId: 'offline', bound })).rejects.toMatchObject({ details: { reason: 'GOAL_USAGE_UNKNOWN' } });
    await expect(reopened.settle('goal', 'unknown', { tokens: 0, costMicros: 0 })).rejects.toMatchObject({ details: { reason: 'GOAL_SETTLEMENT_CONFLICT' } });
    expect(await reopened.read('goal')).toEqual(before);
    expect(f.db.db.prepare('SELECT state FROM runs WHERE id = ?').get('goal')).toMatchObject({ state: 'IDLE' });
  });
});
