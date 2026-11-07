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

/**
 * AUDIT session cost: model_records.pricing stores the core ModelPricing shape
 * {inputPerMillion, outputPerMillion, currency}. The reader used to read `input`/`output`,
 * so every declared price came back null.
 */
export const pricingFromRecord = (
  pricing: Row | null,
): { inputPerMillion: number | null; outputPerMillion: number | null; currency: string | null } | null => {
  if (pricing === null) return null;
  const currency = pricing['currency'];
  return {
    inputPerMillion: numberOrNull(pricing['inputPerMillion']),
    outputPerMillion: numberOrNull(pricing['outputPerMillion']),
    currency: typeof currency === 'string' && currency !== '' ? currency : null,
  };
};

export const createDurableUsageReader = (
  database: DurableLike,
  companyId: string,
  options: { readonly budgetCurrency?: string | null } = {},
): UsageReader => {
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
    // LIVE-CONTRACT-FILL (hark-live-goal 42075419348): the anchors come straight from the
    // artifacts table. The reader used to ask `database.artifacts`, a member the durable
    // database does not have (it is `artifactStore`), so every execution run - its
    // supervisor turns AND its kernel dispatches - silently fell out of run.usage and the
    // UI showed the planner's 3.8K tokens for a goal that had settled 96.6K.
    const anchors = allRows(
      "SELECT creation_command_id AS command_id FROM artifacts WHERE run_id = ? AND kind = 'companyos:plan-compilation' ORDER BY rowid",
      [runId],
    );
    for (const row of anchors) {
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

    /*
     * LIVE-CONTRACT-FILL: the kernel's model calls go through the CompanyOS broker, which
     * records each exchange's provider-reported usage (executor.model_exchange_observed,
     * aggregate = the attempt). An attempt whose every exchange carried observed usage is
     * KNOWN; any exchange without it keeps the whole attempt UNKNOWN (never a partial sum).
     */
    brokeredUsage: async (attemptIds) => {
      const out = new Map<string, { inputTokens: number; outputTokens: number; complete: boolean; exchanges: number }>();
      if (attemptIds.length === 0) return out;
      const placeholders = attemptIds.map(() => '?').join(', ');
      for (const row of allRows(
        `SELECT aggregate_id, payload FROM events WHERE type = 'executor.model_exchange_observed' AND aggregate_id IN (${placeholders}) ORDER BY rowid`,
        attemptIds,
      )) {
        const attemptId = String(row['aggregate_id'] ?? '');
        const payload = parse(String(row['payload'] ?? ''));
        const usage = payload === null ? null : (typeof payload['usage'] === 'object' && payload['usage'] !== null ? payload['usage'] as Row : null);
        const input = tokenOrNull(usage?.['inputTokens']);
        const output = tokenOrNull(usage?.['outputTokens']);
        const entry = out.get(attemptId) ?? { inputTokens: 0, outputTokens: 0, complete: true, exchanges: 0 };
        entry.exchanges += 1;
        if (payload?.['usageDisposition'] === 'observed' && input !== null && output !== null) {
          entry.inputTokens += input;
          entry.outputTokens += output;
        } else entry.complete = false;
        out.set(attemptId, entry);
      }
      return out;
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

    settledCost: async (goalRunId) => {
      let row: Row;
      try {
        row = oneRow('SELECT execution_budget_json FROM runs WHERE id = ? AND execution_goal_run_id = id', [goalRunId]);
      } catch {
        return null; // a database without the execution-budget columns has no ledger
      }
      const budget = parse(String(row['execution_budget_json'] ?? ''));
      const reservations = budget?.['reservations'];
      if (!Array.isArray(reservations)) return null;
      let costMicros = 0;
      let knownCalls = 0;
      let openCalls = 0;
      for (const raw of reservations) {
        const reservation = asRow(raw);
        const usage = asRow(reservation['usage']);
        const cost = numberOrNull(usage['costMicros']);
        if (reservation['status'] === 'KNOWN' && cost !== null && cost >= 0) {
          costMicros += cost;
          knownCalls += 1;
        } else openCalls += 1;
      }
      return { costMicros, knownCalls, openCalls, currency: options.budgetCurrency ?? null };
    },

    modelPricing: async (modelKey) => {
      if (modelKey === null) return null;
      const row = oneRow('SELECT pricing FROM model_records WHERE model_key = ?', [modelKey]);
      return pricingFromRecord(parse(String(row['pricing'] ?? '')));
    },
  };
};
