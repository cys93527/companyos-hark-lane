/**
 * LIVE-CONTRACT-FILL defect 2 (hark-live-goal 42075419348): the session usage read only the
 * planner's tokens (3.8K) for a goal whose execution run had settled ~96.6K through the
 * broker. Two root causes, both pinned here against a REAL SQLite database:
 *  1. runsOf() asked `database.artifacts`, which the durable database does not have, so the
 *     execution run compiled from the goal never joined the usage scope;
 *  2. kernel dispatches have no agent_executions row — their usage lives in the broker's
 *     executor.model_exchange_observed events, which the projection never read.
 * An attempt with any exchange lacking observed usage stays UNKNOWN (never a partial sum).
 */
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { executionRunIdOf } from '@companyos/engine';

import { createDurableUsageReader } from '../../apps/desktop/src/efficiency/durable-usage-reader.js';
import { projectGoalUsage } from '../../apps/desktop/src/efficiency/goal-usage-projection.js';

const COMPANY = 'company_default';
const GOAL = 'run_goal_1';
const PLAN = 'plan_1';
const EXEC = executionRunIdOf(COMPANY, GOAL, PLAN, `goal-compile:${PLAN}`);

const fixture = (exchanges: readonly { attempt: string; disposition: string; input?: number; output?: number }[]) => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, state TEXT, company_id TEXT, snapshot_id TEXT);
    CREATE TABLE run_snapshots (id TEXT PRIMARY KEY, model_bindings_json TEXT);
    CREATE TABLE model_records (model_key TEXT PRIMARY KEY, pricing TEXT);
    CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, run_id TEXT, kind TEXT, creation_command_id TEXT);
    CREATE TABLE agent_executions (execution_id TEXT, run_id TEXT, agent_id TEXT, role_id TEXT, task_id TEXT, status TEXT, input_usage TEXT, output_usage TEXT);
    CREATE TABLE provider_dispatches (attempt_id TEXT, run_id TEXT, provider_key TEXT);
    CREATE TABLE events (aggregate_id TEXT, type TEXT, payload TEXT);
  `);
  db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run(GOAL, 'COMPLETED', COMPANY, null);
  db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run(EXEC, 'FAILED', COMPANY, null);
  db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?)').run('art_plan', GOAL, 'companyos:plan-compilation', `plan-compile:${COMPANY}:goal-compile:${PLAN}`);
  // The planner: one completed agent execution on the goal run (3 784 tokens).
  db.prepare('INSERT INTO agent_executions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'exe_plan', GOAL, 'planner', 'planner', null, 'COMPLETED', '{}', JSON.stringify({ inputTokens: 3000, outputTokens: 784 }),
  );
  // Two kernel dispatches on the EXECUTION run (no agent_executions rows).
  db.prepare('INSERT INTO provider_dispatches VALUES (?, ?, ?)').run('exa_1', EXEC, 'deepseek');
  db.prepare('INSERT INTO provider_dispatches VALUES (?, ?, ?)').run('exa_2', EXEC, 'deepseek');
  for (const exchange of exchanges) {
    db.prepare('INSERT INTO events VALUES (?, ?, ?)').run(
      exchange.attempt,
      'executor.model_exchange_observed',
      JSON.stringify({
        usageDisposition: exchange.disposition,
        usage: exchange.input === undefined ? null : { inputTokens: exchange.input, outputTokens: exchange.output },
      }),
    );
  }
  const runs = {
    get: async (id: string) => {
      const row = db.prepare('SELECT id, state, company_id FROM runs WHERE id = ?').get(id) as
        | { id: string; state: string; company_id: string }
        | undefined;
      return row === undefined ? null : { id: row.id, state: row.state, companyId: row.company_id };
    },
  };
  return createDurableUsageReader({ db: db as never, runs }, COMPANY);
};

describe('LIVE-CONTRACT-FILL defect 2: goal usage includes the execution run and the kernel dispatches', () => {
  it('derives the execution run from the plan-compilation artifact row', async () => {
    const reader = fixture([]);
    expect((await reader.runsOf(GOAL)).map((run) => run.id)).toEqual([GOAL, EXEC]);
  });

  it('counts broker-observed kernel usage as KNOWN when every exchange was observed', async () => {
    const reader = fixture([
      { attempt: 'exa_1', disposition: 'observed', input: 40000, output: 2000 },
      { attempt: 'exa_1', disposition: 'observed', input: 45000, output: 1500 },
      { attempt: 'exa_2', disposition: 'observed', input: 4000, output: 100 },
    ]);
    const projection = await projectGoalUsage(reader, GOAL);
    expect(projection.usage.knownInputTokens).toBe(3000 + 40000 + 45000 + 4000);
    expect(projection.usage.knownOutputTokens).toBe(784 + 2000 + 1500 + 100);
    expect(projection.usage.unknownDispatchCount).toBe(0);
    expect(projection.usage.complete).toBe(true);
  });

  it('keeps an attempt UNKNOWN when any exchange lacks observed usage (never a partial sum)', async () => {
    const reader = fixture([
      { attempt: 'exa_1', disposition: 'observed', input: 40000, output: 2000 },
      { attempt: 'exa_1', disposition: 'absent' },
      { attempt: 'exa_2', disposition: 'observed', input: 4000, output: 100 },
    ]);
    const projection = await projectGoalUsage(reader, GOAL);
    expect(projection.usage.knownInputTokens).toBe(3000 + 4000);
    expect(projection.usage.unknownDispatchCount).toBe(1);
    expect(projection.usage.complete).toBe(false);
  });
});
