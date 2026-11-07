/**
 * STAGE 3 — the read-only E1 usage projection exposed to the client.
 *
 * Semantics are the frozen E1 ones (apps/desktop/src/efficiency/usage-coverage.ts):
 *   KNOWN      an authoritative, provider-reported value (an observed true zero stays KNOWN);
 *   ESTIMATED  derived from a declared estimation rule;
 *   UNKNOWN    no authoritative source — missing is never zero.
 *
 * Sources (all durable, read-only, main-process):
 *   - `agent_executions.input_usage` / `output_usage` JSON → per-execution provider usage
 *     (the same assembly the latency-trace reader uses), classified via `classifyUsageRecord`;
 *   - `provider_dispatches` rows whose attempt has no usage-bearing execution → one UNKNOWN
 *     dispatch each, so coverage is a real ratio rather than a false total;
 *   - `agent.provider_invoked` events → the only MEASURED model-output timing (a single
 *     provider invocation), which is the sole basis for a tokens/second figure;
 *   - `model_records.pricing` → an explicitly-labelled ESTIMATED cost over known usage.
 *
 * What is deliberately NOT derivable, and therefore reported UNKNOWN:
 *   - current context occupancy (no per-attempt context measurement exists, and cumulative
 *     Goal tokens must NOT be treated as the model's current context);
 *   - cache-hit rate (no cached-token source exists anywhere).
 */
import type { DomainError, Result } from '@companyos/core';

import {
  classifyUsageRecord,
  summarizeGoalUsage,
  type GoalUsageSummary,
  type UsageLedgerEntry,
} from './usage-coverage.js';

const ok = <T>(value: T): Result<T, DomainError> => ({ ok: true, value });
const err = (error: DomainError): Result<never, DomainError> => ({ ok: false, error });

const GOAL_WORKFLOW_ID = 'wf-companyos-goal';

/** The goal run id → {goalRunId, executionRunIds} shape the reader must resolve. */
export interface UsageReader {
  /** All runs of the goal (the goal run plus every execution run compiled from it). */
  runsOf(runId: string): Promise<readonly { readonly id: string; readonly state: string }[]>;
  /** Per-execution usage rows (already parsed; null tokens stay null → UNKNOWN). */
  agentExecutions(runIds: readonly string[]): Promise<
    readonly {
      readonly executionId: string;
      readonly agentId: string;
      readonly roleId: string | null;
      readonly taskId: string | null;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly provenance: 'provider-reported' | 'estimated';
    }[]
  >;
  /** Dispatch rows that carry no usage-bearing execution (→ UNKNOWN each). */
  providerDispatches(runIds: readonly string[]): Promise<
    readonly { readonly attemptId: string; readonly providerKey: string | null }[]
  >;
  /**
   * Broker-observed usage of each dispatch attempt (the kernel's model calls), keyed by
   * attempt id. Optional: a reader without it leaves every dispatch UNKNOWN.
   */
  brokeredUsage?(attemptIds: readonly string[]): Promise<
    ReadonlyMap<string, { readonly inputTokens: number; readonly outputTokens: number; readonly complete: boolean; readonly exchanges: number }>
  >;
  /** Measured provider invocations (output tokens over the invocation wall time). */
  providerInvocations(runIds: readonly string[]): Promise<
    readonly { readonly outputTokens: number; readonly latencyMs: number }[]
  >;
  /** Declared pricing of the selected model(s), per million tokens. */
  modelPricing(modelKey: string | null): Promise<{ inputPerMillion: number | null; outputPerMillion: number | null; currency?: string | null } | null>;
  modelKeyOf(runId: string): Promise<string | null>;
  /**
   * LIVE-CONTRACT-FILL run 4: the Goal's execution-budget ledger. Every admitted model call
   * is priced by the trusted budget proof and settled with its exact cost (KNOWN) — the
   * authoritative cost, independent of a ModelRecord price. Optional: absent = no ledger.
   */
  settledCost?(goalRunId: string): Promise<{
    readonly costMicros: number;
    readonly knownCalls: number;
    /** Calls whose charge is unproven (UNKNOWN) or still reserved (in flight). */
    readonly openCalls: number;
    readonly currency: string | null;
  } | null>;
}

export interface GoalUsageProjection {
  readonly goalRunId: string;
  readonly scope: 'GOAL';
  readonly usage: {
    readonly knownInputTokens: number;
    readonly knownOutputTokens: number;
    readonly estimatedInputTokens: number;
    readonly estimatedOutputTokens: number;
    readonly unknownDispatchCount: number;
    readonly totalDispatchCount: number;
    readonly coverageRatio: number | null;
    readonly complete: boolean;
  };
  /** Measured output tokens per second from single provider invocations (no attempt/tool time). */
  readonly speed: { readonly state: 'KNOWN' | 'UNKNOWN'; readonly samples: readonly number[]; readonly note: string };
  /** No authoritative cached-token source exists → always UNKNOWN with a stated reason. */
  readonly cacheHit: { readonly state: 'UNKNOWN'; readonly reason: string };
  /** Cost over KNOWN usage × declared pricing; explicitly labelled ESTIMATED. */
  readonly cost: {
    readonly state: 'KNOWN' | 'ESTIMATED' | 'UNKNOWN';
    readonly knownScopeCost: number | null;
    /** The declared price's currency; a cost is never shown without one. */
    readonly currency: string | null;
    readonly coverageComplete: boolean;
    readonly note: string;
  };
  /** Current context occupancy cannot be proven → UNKNOWN (never the cumulative Goal total). */
  readonly contextRemaining: { readonly state: 'UNKNOWN'; readonly reason: string };
}

const seatOf = (agentId: string, roleId: string | null): string => {
  if (agentId.startsWith('agent.planner')) return 'planner';
  if (agentId.startsWith('supervisor')) return 'supervisor';
  if (agentId.startsWith('agent.review')) return 'reviewer';
  return roleId ?? 'work';
};

/** Build the ledger entries the E1 summariser needs (pure over the reader). */
type BrokeredUsage = ReadonlyMap<string, { readonly inputTokens: number; readonly outputTokens: number; readonly complete: boolean; readonly exchanges: number }>;

const ledgerOf = (
  executions: Awaited<ReturnType<UsageReader['agentExecutions']>>,
  dispatches: Awaited<ReturnType<UsageReader['providerDispatches']>>,
  goalRunId: string,
  brokered: BrokeredUsage = new Map(),
): UsageLedgerEntry[] => {
  const entries: UsageLedgerEntry[] = [];
  const usageBearingAttempts = new Set<string>();
  for (const execution of executions) {
    const record = {
      provenance: execution.provenance,
      inputTokens: execution.inputTokens,
      outputTokens: execution.outputTokens,
      totalTokens:
        execution.inputTokens === null || execution.outputTokens === null
          ? null
          : execution.inputTokens + execution.outputTokens,
    };
    classifyUsageRecord(record);
    entries.push({
      goalRunId,
      runId: null,
      taskId: execution.taskId,
      roleId: execution.roleId,
      attemptId: null,
      seat: seatOf(execution.agentId, execution.roleId),
      providerId: null,
      modelId: null,
      state: classifyUsageRecord(record) === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN',
      record,
    });
    usageBearingAttempts.add(execution.executionId);
  }
  for (const dispatch of dispatches) {
    if (usageBearingAttempts.has(dispatch.attemptId)) continue;
    const observed = brokered.get(dispatch.attemptId);
    if (observed !== undefined && observed.complete && observed.exchanges > 0) {
      const record = { provenance: 'provider-reported' as const, inputTokens: observed.inputTokens, outputTokens: observed.outputTokens, totalTokens: observed.inputTokens + observed.outputTokens };
      entries.push({
        goalRunId, runId: null, taskId: null, roleId: null, attemptId: dispatch.attemptId, seat: 'work',
        providerId: dispatch.providerKey, modelId: null,
        state: classifyUsageRecord(record) === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN',
        record,
      });
      continue;
    }
    entries.push({
      goalRunId,
      runId: null,
      taskId: null,
      roleId: null,
      attemptId: dispatch.attemptId,
      seat: 'work',
      providerId: dispatch.providerKey,
      modelId: null,
      state: 'UNKNOWN',
      record: null,
    });
  }
  return entries;
};

const UNKNOWN_PROJECTION = (goalRunId: string, note: string): GoalUsageProjection => ({
  goalRunId,
  scope: 'GOAL',
  usage: {
    knownInputTokens: 0,
    knownOutputTokens: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    unknownDispatchCount: 0,
    totalDispatchCount: 0,
    coverageRatio: null,
    complete: false,
  },
  speed: { state: 'UNKNOWN', samples: [], note },
  cacheHit: { state: 'UNKNOWN', reason: note },
  cost: { state: 'UNKNOWN', knownScopeCost: null, currency: null, coverageComplete: false, note },
  contextRemaining: { state: 'UNKNOWN', reason: note },
});

export const projectGoalUsage = async (
  reader: UsageReader,
  goalRunId: string,
): Promise<GoalUsageProjection> => {
  // A durable read failure is NOT "no usage": every metric degrades to UNKNOWN with an
  // explicit note, and the IPC answer stays a typed envelope (never a rejection).
  try {
    return await readGoalUsage(reader, goalRunId);
  } catch (error) {
    return UNKNOWN_PROJECTION(
      goalRunId,
      `usage 投影读取失败（${error instanceof Error ? error.message : String(error)}），所有值按 UNKNOWN 呈现。`,
    );
  }
};

const readGoalUsage = async (
  reader: UsageReader,
  goalRunId: string,
): Promise<GoalUsageProjection> => {
  const runs = await reader.runsOf(goalRunId);
  const runIds = runs.map((run) => run.id);
  const executions = await reader.agentExecutions(runIds);
  const dispatches = await reader.providerDispatches(runIds);
  const invocations = await reader.providerInvocations(runIds);
  const modelKey = await reader.modelKeyOf(goalRunId);
  const pricing = await reader.modelPricing(modelKey);

  const brokered = reader.brokeredUsage === undefined ? new Map() : await reader.brokeredUsage(dispatches.map((dispatch) => dispatch.attemptId));
  const summary: GoalUsageSummary = summarizeGoalUsage(goalRunId, ledgerOf(executions, dispatches, goalRunId, brokered));

  // Measured speed: output tokens over the SINGLE provider invocation wall time. Attempt
  // duration, tool time and Goal wall time are deliberately NOT used.
  const samples = invocations
    .filter((invocation) => invocation.latencyMs > 0)
    .map((invocation) => Math.round((invocation.outputTokens / (invocation.latencyMs / 1000)) * 10) / 10);

  // AUDIT session cost: a cost exists only with BOTH declared prices and a currency; a missing
  // price is unknown, never 0.
  const currency = pricing?.currency ?? null;
  const knownCost =
    pricing === null || pricing.inputPerMillion === null || pricing.outputPerMillion === null || currency === null
      ? null
      : (summary.knownInputTokens / 1_000_000) * pricing.inputPerMillion +
        (summary.knownOutputTokens / 1_000_000) * pricing.outputPerMillion;

  // The budget ledger's settled exact cost wins over an estimate: it is what was charged,
  // priced by the trusted proof. Shown only with a currency and at least one settled call.
  const ledger = reader.settledCost === undefined ? null : await reader.settledCost(goalRunId);
  const ledgerCost = ledger !== null && ledger.knownCalls > 0 && ledger.currency !== null ? ledger : null;

  return {
    goalRunId,
    scope: 'GOAL',
    usage: {
      knownInputTokens: summary.knownInputTokens,
      knownOutputTokens: summary.knownOutputTokens,
      estimatedInputTokens: summary.estimatedInputTokens,
      estimatedOutputTokens: summary.estimatedOutputTokens,
      unknownDispatchCount: summary.unknownDispatchCount,
      totalDispatchCount: summary.totalDispatchCount,
      coverageRatio: summary.coverageRatio,
      complete: summary.complete,
    },
    speed:
      samples.length === 0
        ? { state: 'UNKNOWN', samples: [], note: '尚无单次模型调用的实测输出耗时。' }
        : { state: 'KNOWN', samples, note: '按单次 provider 调用的输出 token / 调用耗时计算。' },
    cacheHit: {
      state: 'UNKNOWN',
      reason: 'provider/kernel 未提供权威 cached-token 证据；不由重复命令或会话复用推断。',
    },
    cost:
      ledgerCost !== null
        ? {
            state: 'KNOWN',
            knownScopeCost: Math.round(ledgerCost.costMicros) / 1_000_000,
            currency: ledgerCost.currency,
            coverageComplete: ledgerCost.openCalls === 0,
            note: ledgerCost.openCalls === 0
              ? `按预算账本逐次结算的实际费用（${String(ledgerCost.knownCalls)} 次调用，可信定价）。`
              : `按预算账本逐次结算的实际费用（${String(ledgerCost.knownCalls)} 次已结算；${String(ledgerCost.openCalls)} 次未结算或费用未证实，未计入）。`,
          }
        : knownCost === null
        ? { state: 'UNKNOWN', knownScopeCost: null, currency: null, coverageComplete: summary.complete, note: '未配置完整的可信定价（输入/输出价格与币种）。' }
        : {
            state: 'ESTIMATED',
            knownScopeCost: Math.round(knownCost * 1000) / 1000,
            currency,
            coverageComplete: summary.complete,
            note: summary.complete
              ? '按已知用量 × 已声明价格估算。'
              : '按已知用量 × 已声明价格估算（部分 dispatch 用量未知，非 Goal 总量）。',
          },
    contextRemaining: {
      state: 'UNKNOWN',
      reason: '无逐次上下文占位证据；累计 Goal token 不代表模型当前上下文占用。',
    },
  };
};

export const createGoalUsageService = (reader: UsageReader) => ({
  usageOf: async (input: { readonly companyId: string; readonly runId: string }): Promise<Result<unknown, DomainError>> => {
    if (input.runId.trim() === '') {
      return err({ code: 'NOT_FOUND', message: 'A goal run id is required.' } as DomainError);
    }
    return ok(await projectGoalUsage(reader, input.runId));
  },
});

export { GOAL_WORKFLOW_ID };
