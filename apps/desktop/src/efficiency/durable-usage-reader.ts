/**
 * STAGE 3 — the durable reader that feeds the E1 usage projection.
 *
 * Every source is a durable, read-only table of the ONE canonical database. No provider is
 * called and no value is invented: absent data yields UNKNOWN, never zero.
 */
import { executionRunIdOf } from '@companyos/engine';

import type { UsageReader } from './goal-usage-projection.js';

/** The minimal durable surface this reader needs (row shapes are normalised here). */
interface DurableLike {
  readonly db: {
    prepare(sql: string): {
      all(...params: unknown[]): readonly unknown[];
      get(...params: unknown[]): unknown;
    };
  };
  readonly runs: {
    get(id: string): Promise<{ readonly id: string; readonly state: string; readonly companyId: string } | null>;
  };
  readonly artifacts?: {
    listByRun(runId: string): Promise<readonly { readonly id: string; readonly kind: string }[]>;
  } | null;
}

type Row = Readonly<Record<string, unknown>>;

const asRow = (value: unknown): Row => (typeof value === 'object' && value !== null ? (value as Row) : {});

const parse = (value: unknown): Row | null => {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Row) : null;
  } catch {
    return null;
  }
};

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const tokenOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export const createDurableUsageReader = (database: DurableLike, companyId: string): UsageReader => {
  const allRows = (sql: string, params: readonly unknown[]): readonly Row[] =>
    database.db.prepare(sql).all(...params).map(asRow);

  const oneRow = (sql: string, params: readonly unknown[]): Row =>
    asRow(database.db.prepare(sql).get(...params));

  /**
   * Every run of one Goal: the goal (planning) run plus each execution run compiled from
   * it — derived exactly the way the control-plane `goal.workspace` does (plan-compilation
   * anchor → deterministic execution run id). No second truth.
   */
  const runsOf = async (runId: string) => {
    const runs = new Map<string, string>();
    const goal = await database.runs.get(runId);
    runs.set(runId, goal?.state ?? 'UNKNOWN');
    const anchors = database.artifacts === null || database.artifacts === undefined ? [] : await database.artifacts.listByRun(runId);
    for (const anchor of anchors) {
      if (anchor.kind !== 'companyos:plan-compilation') continue;
      const row = oneRow('SELECT creation_command_id AS command_id FROM artifacts WHERE artifact_id = ?', [anchor.id]);
      const commandId = textOrNull(row['command_id']);
      if (commandId === null) continue;
      const prefix = `plan-compile:${companyId}:goal-compile:`;
      if (!commandId.startsWith(prefix)) continue;
      const planId = commandId.slice(prefix.length);
      const executionRunId = executionRunIdOf(companyId, runId, planId, `goal-compile:${planId}`);
      const executionRun = await database.runs.get(executionRunId);
      if (executionRun !== null && executionRun.companyId === companyId) runs.set(executionRunId, executionRun.state);
    }
    return [...runs.entries()].map(([id, state]) => ({ id, state }));
  };

  return {
    runsOf,

    agentExecutions: async (runIds) => {
      if (runIds.length === 0) return [];
      const placeholders = runIds.map(() => '?').join(', ');
      return allRows(
        `SELECT execution_id, agent_id, role_id, task_id, status, input_usage, output_usage
           FROM agent_executions WHERE run_id IN (${placeholders})`,
        runIds,
      ).map((row) => {
        const input = parse(row['input_usage']);
        const output = parse(row['output_usage']);
        // AgentRuntime stores the provider's measured input AND output in
        // output_usage. input_usage is a creation-time zero placeholder.
        // Failed/in-flight records do not establish zero upstream consumption.
        const measured = row['status'] === 'COMPLETED' ? output : null;
        const provenance =
          input?.['provenance'] === 'estimated' || output?.['provenance'] === 'estimated'
            ? ('estimated' as const)
            : ('provider-reported' as const);
        return {
          executionId: String(row['execution_id'] ?? ''),
          agentId: String(row['agent_id'] ?? ''),
          roleId: textOrNull(row['role_id']),
          taskId: textOrNull(row['task_id']),
          inputTokens: tokenOrNull(measured?.['inputTokens']),
          outputTokens: tokenOrNull(measured?.['outputTokens']),
          provenance,
        };
      });
    },

    providerDispatches: async (runIds) => {
      if (runIds.length === 0) return [];
      const placeholders = runIds.map(() => '?').join(', ');
      return allRows(`SELECT attempt_id, provider_key FROM provider_dispatches WHERE run_id IN (${placeholders})`, runIds).map(
        (row) => ({ attemptId: String(row['attempt_id'] ?? ''), providerKey: textOrNull(row['provider_key']) }),
      );
    },

    providerInvocations: async (runIds) => {
      if (runIds.length === 0) return [];
      const placeholders = runIds.map(() => '?').join(', ');
      return allRows(
        `SELECT payload FROM events
           WHERE type = 'agent.provider_invoked' AND aggregate_id IN (${placeholders})`,
        runIds,
      )
        .map((row) => {
          const payload = parse(String(row['payload'] ?? ''));
          const outputTokens = numberOrNull(payload?.['outputTokens']);
          const latencyMs = numberOrNull(payload?.['latencyMs']);
          return outputTokens !== null && latencyMs !== null ? { outputTokens, latencyMs } : null;
        })
        .filter((entry): entry is { outputTokens: number; latencyMs: number } => entry !== null);
    },

    modelKeyOf: async (runId) => {
      const runRow = oneRow('SELECT snapshot_id FROM runs WHERE id = ?', [runId]);
      const snapshotId = textOrNull(runRow['snapshot_id']);
      if (snapshotId === null) return null;
      const snapshot = oneRow('SELECT model_bindings_json FROM run_snapshots WHERE id = ?', [snapshotId]);
      const bindings = parse(String(snapshot['model_bindings_json'] ?? ''));
      if (bindings === null) return null;
      const first = Object.values(bindings)[0];
      return typeof first === 'string' ? first : null;
    },

    modelPricing: async (modelKey) => {
      if (modelKey === null) return null;
      const row = oneRow('SELECT pricing FROM model_records WHERE model_key = ?', [modelKey]);
      const pricing = parse(String(row['pricing'] ?? ''));
      if (pricing === null) return null;
      return { inputPerMillion: numberOrNull(pricing['input']), outputPerMillion: numberOrNull(pricing['output']) };
    },
  };
};
