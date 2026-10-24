/**
 * V1 EFFICIENCY E1-C — truthful usage coverage semantics (DERIVED, READ-ONLY).
 *
 * A Goal's model/token usage is only as truthful as its provenance. This module
 * classifies every usage-bearing record into exactly one state and aggregates
 * WITHOUT ever converting missing usage into zero:
 *
 *   KNOWN     — a provider-reported usage record exists (actual response usage).
 *   ESTIMATED — a record exists whose provenance is an estimate (no estimator
 *               ships today; the state exists so future provenance is honest).
 *   UNKNOWN   — no usage record is available (missing ≠ zero, ever).
 *
 * This is a projection over existing durable rows (agent_executions usage JSON,
 * provider_dispatches presence). It owns no storage, writes nothing, and is
 * never read by execution, settlement, or validation — billing/workflow truth
 * it is not.
 */

/** The three truthful states. Missing usage is UNKNOWN, never zero. */
export type UsageCoverageState = 'KNOWN' | 'ESTIMATED' | 'UNKNOWN';

/** Provenance of one usage record. 'provider-reported' is the only producer today. */
export type UsageProvenance = 'provider-reported' | 'estimated';

/** A normalized usage record with explicit provenance (raw numbers; null = not reported). */
export interface UsageRecord {
  readonly provenance: UsageProvenance;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

/**
 * Classify one usage record. A record that reports real numbers under
 * provider-reported provenance is KNOWN; estimated provenance is ESTIMATED;
 * anything without usable numbers is UNKNOWN. Zero is a legitimate REPORTED
 * value only when the provider actually reported it (a record with
 * totalTokens: 0 supplied by the provider is KNOWN-zero; absence of a record
 * is UNKNOWN — the two are never conflated).
 */
export const classifyUsageRecord = (record: UsageRecord | null | undefined): UsageCoverageState => {
  if (record === null || record === undefined) return 'UNKNOWN';
  if (record.provenance === 'estimated') return 'ESTIMATED';
  // provider-reported: at least one non-null number means the provider supplied usage
  if (record.inputTokens === null && record.outputTokens === null && record.totalTokens === null) return 'UNKNOWN';
  return 'KNOWN';
};

export interface UsageLedgerEntry {
  /** Dimension refs (existing lineage only; null when not applicable). */
  readonly goalRunId: string | null;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly roleId: string | null;
  readonly attemptId: string | null;
  /** Control-plane seat when derivable: planner / supervisor / reviewer / validator / work. */
  readonly seat: string;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly state: UsageCoverageState;
  readonly record: UsageRecord | null;
}

export interface GoalUsageSummary {
  readonly goalRunId: string;
  readonly knownInputTokens: number;
  readonly knownOutputTokens: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly unknownDispatchCount: number;
  readonly totalDispatchCount: number;
  /** known+estimated dispatches / total dispatches; null when total is 0 (not meaningful). */
  readonly coverageRatio: number | null;
  /**
   * Honest completeness marker: when unknownDispatchCount > 0 NO single
   * "total tokens" value exists and none is ever produced here. A renderer
   * must show the known/estimated/unknown split, never a manufactured sum.
   */
  readonly complete: boolean;
}

const sum = (values: readonly number[]): number => values.reduce((acc, value) => acc + value, 0);
const nonNull = (values: readonly (number | null)[]): number[] => values.filter((value): value is number => value !== null);

/**
 * Aggregate entries into a Goal-level summary. Partial coverage is preserved:
 * known/estimated sums are reported separately, unknown dispatches counted,
 * and no combined total is manufactured while any dispatch is UNKNOWN.
 */
export const summarizeGoalUsage = (
  goalRunId: string,
  entries: readonly UsageLedgerEntry[],
): GoalUsageSummary => {
  const known = entries.filter((entry) => entry.state === 'KNOWN');
  const estimated = entries.filter((entry) => entry.state === 'ESTIMATED');
  const unknown = entries.filter((entry) => entry.state === 'UNKNOWN');
  return {
    goalRunId,
    knownInputTokens: sum(nonNull(known.map((entry) => entry.record?.inputTokens ?? null))),
    knownOutputTokens: sum(nonNull(known.map((entry) => entry.record?.outputTokens ?? null))),
    estimatedInputTokens: sum(nonNull(estimated.map((entry) => entry.record?.inputTokens ?? null))),
    estimatedOutputTokens: sum(nonNull(estimated.map((entry) => entry.record?.outputTokens ?? null))),
    unknownDispatchCount: unknown.length,
    totalDispatchCount: entries.length,
    coverageRatio: entries.length === 0 ? null : (known.length + estimated.length) / entries.length,
    complete: unknown.length === 0,
  };
};
