/**
 * LIVE-CONTRACT-FILL run 4 (hark-live-goal 42346111946) — runtime-panel contradiction
 * (phase status half: apps/renderer/tests/live-contract-fill-run4-phase.test.ts):
 *  "未配置完整的可信定价" while every one of the 20 calls was settled KNOWN with an exact
 *      cost by the budget ledger (priced by the trusted proof). The ledger's settled cost is
 *      now the session cost.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { createDurableUsageReader } from '../../apps/desktop/src/efficiency/durable-usage-reader.js';
import { projectGoalUsage } from '../../apps/desktop/src/efficiency/goal-usage-projection.js';

const GOAL = 'run_01M6TB5T7B9MXV78FGTGG8K61Y';

const ledgerDb = (reservations: unknown[] | null, withBudgetColumns = true) => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, state TEXT, company_id TEXT, snapshot_id TEXT${withBudgetColumns ? ', execution_goal_run_id TEXT, execution_budget_json TEXT' : ''});
    CREATE TABLE run_snapshots (id TEXT PRIMARY KEY, model_bindings_json TEXT);
    CREATE TABLE model_records (model_key TEXT PRIMARY KEY, pricing TEXT);
    CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, run_id TEXT, kind TEXT, creation_command_id TEXT);
    CREATE TABLE agent_executions (execution_id TEXT, run_id TEXT, agent_id TEXT, role_id TEXT, task_id TEXT, status TEXT, input_usage TEXT, output_usage TEXT);
    CREATE TABLE provider_dispatches (attempt_id TEXT, run_id TEXT, provider_key TEXT);
    CREATE TABLE events (aggregate_id TEXT, type TEXT, payload TEXT);
  `);
  if (withBudgetColumns) {
    db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)').run(GOAL, 'FAILED', 'company_default', null, GOAL,
      reservations === null ? null : JSON.stringify({ policy: {}, reservations }));
  } else db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run(GOAL, 'FAILED', 'company_default', null);
  db.prepare('INSERT INTO agent_executions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('exe_plan', GOAL, 'agent.planner', 'planner', null, 'COMPLETED', '{}', JSON.stringify({ inputTokens: 2000, outputTokens: 903 }));
  const runs = { get: async (id: string) => (id === GOAL ? { id, state: 'FAILED', companyId: 'company_default' } : null) };
  return { db: db as never, runs };
};
const known = (costMicros: number) => ({ status: 'KNOWN', usage: { tokens: 1000, costMicros }, bound: {} });

describe('session cost from the budget ledger (trusted pricing)', () => {
  it('all calls KNOWN -> KNOWN exact cost in the proof currency, no "未配置…可信定价" note', async () => {
    const reader = createDurableUsageReader(ledgerDb([known(14068), known(3790), known(355260)]), 'company_default', { budgetCurrency: 'CNY' });
    const projection = await projectGoalUsage(reader, GOAL);
    expect(projection.cost.state).toBe('KNOWN');
    expect(projection.cost.knownScopeCost).toBe(0.373118);
    expect(projection.cost.currency).toBe('CNY');
    expect(projection.cost.coverageComplete).toBe(true);
    expect(projection.cost.note).not.toMatch(/未配置/u);
    expect(projection.cost.note).toContain('3 次调用');
  });
  it('an unproven or in-flight call is named and not counted; no currency or no settled call stays UNKNOWN', async () => {
    const partial = await projectGoalUsage(createDurableUsageReader(ledgerDb([known(1000), { status: 'UNKNOWN', usage: null, bound: {} }, { status: 'RESERVED', usage: null, bound: {} }]), 'company_default', { budgetCurrency: 'CNY' }), GOAL);
    expect(partial.cost.state).toBe('KNOWN');
    expect(partial.cost.knownScopeCost).toBe(0.001);
    expect(partial.cost.coverageComplete).toBe(false);
    expect(partial.cost.note).toContain('2 次未结算或费用未证实');
    const noCurrency = await projectGoalUsage(createDurableUsageReader(ledgerDb([known(1000)]), 'company_default'), GOAL);
    expect(noCurrency.cost.state).toBe('UNKNOWN');
    const none = await projectGoalUsage(createDurableUsageReader(ledgerDb([]), 'company_default', { budgetCurrency: 'CNY' }), GOAL);
    expect(none.cost.state).toBe('UNKNOWN');
    const oldDb = await projectGoalUsage(createDurableUsageReader(ledgerDb(null, false), 'company_default', { budgetCurrency: 'CNY' }), GOAL);
    expect(oldDb.cost.state).toBe('UNKNOWN');
    expect(oldDb.usage.knownInputTokens).toBe(2000);
  });
});
