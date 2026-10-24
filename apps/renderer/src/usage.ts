/**
 * STAGE 3 — the honest model-runtime telemetry read model.
 *
 * Feeds the model popover from the canonical `run.usage` projection (main-process E1
 * semantics). Rules enforced here, matching the frozen policy:
 *   - KNOWN renders the value (an observed true zero renders 0, never as unknown);
 *   - ESTIMATED is labelled ESTIMATED;
 *   - UNKNOWN renders `--` — a fabricated 97% or a false total is forbidden;
 *   - context remaining is UNKNOWN unless current-context occupancy is provable, and
 *     cumulative Goal usage is NEVER treated as the model's current context.
 */
import type { ControlPlaneBridge } from './workspace.js';

export type UsageState = 'KNOWN' | 'ESTIMATED' | 'UNKNOWN';

export interface GoalUsageProjection {
  readonly goalRunId: string;
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
  readonly speed: { readonly state: UsageState; readonly samples: readonly number[]; readonly note: string };
  readonly cacheHit: { readonly state: 'UNKNOWN'; readonly reason: string };
  readonly cost: {
    readonly state: UsageState;
    readonly knownScopeCost: number | null;
    readonly coverageComplete: boolean;
    readonly note: string;
  };
  readonly contextRemaining: { readonly state: 'UNKNOWN'; readonly reason: string };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Read the canonical usage projection for one Goal; a typed failure degrades to UNKNOWN. */
export const loadGoalUsage = async (
  bridge: ControlPlaneBridge,
  runId: string | null,
): Promise<GoalUsageProjection | null> => {
  if (runId === null) return null;
  const response = (await bridge.controlPlaneRequest({
    operation: 'run.usage',
    payload: { companyId: 'company_default', runId },
  })) as { readonly ok: boolean; readonly value?: unknown };
  if (!response.ok || response.value === undefined) return null;
  const value = asRecord(response.value);
  if (value === null) return null;
  const usage = asRecord(value['usage']) ?? {};
  const speed = asRecord(value['speed']) ?? {};
  const cacheHit = asRecord(value['cacheHit']) ?? {};
  const cost = asRecord(value['cost']) ?? {};
  const contextRemaining = asRecord(value['contextRemaining']) ?? {};
  return {
    goalRunId: String(value['goalRunId'] ?? runId),
    usage: {
      knownInputTokens: num(usage['knownInputTokens']) ?? 0,
      knownOutputTokens: num(usage['knownOutputTokens']) ?? 0,
      estimatedInputTokens: num(usage['estimatedInputTokens']) ?? 0,
      estimatedOutputTokens: num(usage['estimatedOutputTokens']) ?? 0,
      unknownDispatchCount: num(usage['unknownDispatchCount']) ?? 0,
      totalDispatchCount: num(usage['totalDispatchCount']) ?? 0,
      coverageRatio: num(usage['coverageRatio']),
      complete: usage['complete'] === true,
    },
    speed: {
      state: speed['state'] === 'KNOWN' ? 'KNOWN' : 'UNKNOWN',
      samples: Array.isArray(speed['samples']) ? (speed['samples'] as readonly number[]) : [],
      note: typeof speed['note'] === 'string' ? (speed['note'] as string) : '',
    },
    cacheHit: { state: 'UNKNOWN', reason: typeof cacheHit['reason'] === 'string' ? (cacheHit['reason'] as string) : '' },
    cost: {
      state: cost['state'] === 'KNOWN' || cost['state'] === 'ESTIMATED' ? (cost['state'] as 'KNOWN' | 'ESTIMATED') : 'UNKNOWN',
      knownScopeCost: num(cost['knownScopeCost']),
      coverageComplete: cost['coverageComplete'] === true,
      note: typeof cost['note'] === 'string' ? (cost['note'] as string) : '',
    },
    contextRemaining: { state: 'UNKNOWN', reason: typeof contextRemaining['reason'] === 'string' ? (contextRemaining['reason'] as string) : '' },
  };
};

export interface TelemetryView {
  readonly tokens: string;
  readonly coverage: string;
  readonly unknownDispatches: string;
  readonly speed: string;
  readonly speedNote: string;
  readonly cacheHit: string;
  readonly cost: string;
  readonly costLabel: 'ESTIMATED' | 'KNOWN' | null;
  readonly contextRemaining: string;
  readonly note: string;
}

const formatCompact = (value: number): string => {
  if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`;
  if (value >= 1_000) return `${Math.round((value / 1_000) * 10) / 10}K`;
  return String(value);
};

/** Pure: the popover's display strings, with `--` for anything not provably known. */
export const projectTelemetry = (
  usage: GoalUsageProjection | null,
  contextWindow: number | null,
): TelemetryView => {
  if (usage === null) {
    return {
      tokens: '--',
      coverage: '--',
      unknownDispatches: '--',
      speed: '--',
      speedNote: '',
      cacheHit: '--',
      cost: '--',
      costLabel: null,
      contextRemaining: '--',
      note: '该 Goal 尚无 usage 投影。',
    };
  }
  const knownTokens = usage.usage.knownInputTokens + usage.usage.knownOutputTokens;
  const estimatedTokens = usage.usage.estimatedInputTokens + usage.usage.estimatedOutputTokens;
  const tokens =
    knownTokens === 0 && estimatedTokens === 0 && usage.usage.totalDispatchCount === 0
      ? '--'
      : formatCompact(knownTokens + estimatedTokens);
  const coverage =
    usage.usage.coverageRatio === null
      ? '--'
      : `${Math.round(usage.usage.coverageRatio * 100)}%`;
  const speedSample = usage.speed.samples.length === 0 ? null : usage.speed.samples[usage.speed.samples.length - 1]!;
  return {
    tokens,
    coverage,
    unknownDispatches:
      usage.usage.unknownDispatchCount === 0 ? '0' : String(usage.usage.unknownDispatchCount),
    speed: speedSample === null || usage.speed.state !== 'KNOWN' ? '--' : `${speedSample}/s`,
    speedNote: usage.speed.note,
    cacheHit: '--',
    cost:
      usage.cost.state === 'UNKNOWN' || usage.cost.knownScopeCost === null
        ? '--'
        : `$${usage.cost.knownScopeCost}`,
    costLabel: usage.cost.state === 'UNKNOWN' ? null : (usage.cost.state as 'KNOWN' | 'ESTIMATED'),
    contextRemaining: contextWindow === null ? '--' : '--',
    note:
      usage.usage.complete === false && usage.usage.unknownDispatchCount > 0
        ? `${usage.usage.unknownDispatchCount} 个 work dispatch 用量未知，覆盖率 ${coverage}——非 Goal 总量。`
        : usage.cost.note,
  };
};
