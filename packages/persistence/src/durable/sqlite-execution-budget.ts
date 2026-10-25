import { domainError, type ExecutionBudgetStore, type GoalExecutionBudget } from '@companyos/core';
import type { Database } from '../db.js';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Corrupt persisted facts must deny admission, never recreate an empty allowance. */
function validState(value: unknown, goalRunId: string): value is GoalExecutionBudget {
  if (!record(value) || value['goalRunId'] !== goalRunId || !record(value['policy']) || !Array.isArray(value['reservations'])) return false;
  const policy = value['policy'];
  if (!identity(policy['policyId']) || !count(policy['maxCalls']) || policy['maxCalls'] > 1000 || !count(policy['maxTokens']) || !count(policy['maxCostMicros']) || !count(policy['deadlineMs'])) return false;
  const cancel = value['cancellation'];
  if (cancel !== null && (!record(cancel) || !count(cancel['requestedAtMs']) || !identity(cancel['requestId']))) return false;
  if (policy['maxCalls'] === 0 && (policy['policyId'] !== 'LEGACY_CANCEL_ONLY' || cancel === null || value['reservations'].length !== 0)) return false;
  if (value['reservations'].length > policy['maxCalls']) return false;
  const calls = new Set<string>();
  let tokens = 0; let cost = 0;
  for (const reservation of value['reservations']) {
    if (!record(reservation) || !identity(reservation['callId']) || calls.has(reservation['callId']) || !identity(reservation['runId']) || !identity(reservation['ownerId']) || !record(reservation['bound'])) return false;
    calls.add(reservation['callId']);
    const bound = reservation['bound'];
    if (!identity(bound['modelKey']) || !identity(bound['evidenceRef']) || !count(bound['inputTokens']) || !count(bound['outputTokens']) || !count(bound['costMicros']) || !count(bound['validUntilMs']) || !count(bound['inputTokens'] + bound['outputTokens'])) return false;
    const usage = reservation['usage'];
    const reconciliation = reservation['reconciliation'];
    if (reconciliation !== undefined) {
      // H12c: only a KNOWN reservation can carry an operator reconciliation, fully formed.
      if (reservation['status'] !== 'KNOWN' || !record(reconciliation) || !identity(reconciliation['reconciliationId']) || !identity(reconciliation['attestedBy']) || !identity(reconciliation['attestedAt']) || typeof reconciliation['evidenceRef'] !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(reconciliation['evidenceRef'])) return false;
    }
    if (reservation['status'] === 'KNOWN') {
      if (!record(usage) || !count(usage['tokens']) || !count(usage['costMicros']) || usage['tokens'] > bound['inputTokens'] + bound['outputTokens'] || usage['costMicros'] > bound['costMicros']) return false;
      tokens += usage['tokens']; cost += usage['costMicros'];
    } else {
      if ((reservation['status'] !== 'RESERVED' && reservation['status'] !== 'UNKNOWN') || usage !== null) return false;
      tokens += bound['inputTokens'] + bound['outputTokens']; cost += bound['costMicros'];
    }
  }
  return count(tokens) && count(cost) && tokens <= policy['maxTokens'] && cost <= policy['maxCostMicros'];
}

export function createSqliteExecutionBudgetStore(db: Database): ExecutionBudgetStore {
  const read = (goalRunId: string): GoalExecutionBudget | null => {
    const row = db.prepare('SELECT execution_budget_json FROM runs WHERE id = ? AND execution_goal_run_id = id').get(goalRunId) as { execution_budget_json: string | null } | undefined;
    if (row?.execution_budget_json == null) return null;
    let value: unknown;
    try { value = JSON.parse(row.execution_budget_json); } catch { value = undefined; }
    if (!validState(value, goalRunId)) throw domainError('POLICY_DENIED', 'Persisted execution budget is invalid.', { reason: 'GOAL_BUDGET_STATE_INVALID', retryable: false });
    return value;
  };
  return {
    async bind(runId, goalRunId) {
      const result = await db.writeFence.transaction(async () => {
        const goal = db.prepare('SELECT company_id FROM runs WHERE id = ?').get(goalRunId) as { company_id: string } | undefined;
        const run = db.prepare('SELECT company_id, execution_goal_run_id FROM runs WHERE id = ?').get(runId) as { company_id: string; execution_goal_run_id: string | null } | undefined;
        if (goal === undefined || run === undefined || goal.company_id !== run.company_id) throw domainError('POLICY_DENIED', 'Execution budget ownership could not be verified.', { reason: 'GOAL_BUDGET_OWNER_INVALID' });
        if (run.execution_goal_run_id !== null && run.execution_goal_run_id !== goalRunId) throw domainError('CONFLICT', 'Execution budget ownership is immutable.', { reason: 'GOAL_BUDGET_OWNER_CONFLICT' });
        db.prepare('UPDATE runs SET execution_goal_run_id = ? WHERE id = ?').run(goalRunId, runId);
      });
      if (!result.ok) throw result.error;
    },
    async goalOf(runId) {
      return db.writeFence.serialize(async () => {
        const row = db.prepare('SELECT execution_goal_run_id FROM runs WHERE id = ?').get(runId) as { execution_goal_run_id: string | null } | undefined;
        return row?.execution_goal_run_id ?? null;
      });
    },
    async read(goalRunId) { return db.writeFence.serialize(async () => read(goalRunId)); },
    async update(goalRunId, change) {
      const result = await db.writeFence.transaction(async () => {
        const current = read(goalRunId);
        const { next, value } = change(current);
        if (next.goalRunId !== goalRunId) throw domainError('CONFLICT', 'Execution budget owner cannot change.');
        if (!validState(next, goalRunId)) throw domainError('POLICY_DENIED', 'Execution budget update is invalid.', { reason: 'GOAL_BUDGET_STATE_INVALID', retryable: false });
        const changed = db.prepare('UPDATE runs SET execution_budget_json = ? WHERE id = ? AND execution_goal_run_id = id').run(JSON.stringify(next), goalRunId);
        if (Number(changed.changes) !== 1) throw domainError('POLICY_DENIED', 'Execution budget root is not bound.');
        return value;
      });
      if (!result.ok) throw result.error;
      return result.value;
    },
  };
}
