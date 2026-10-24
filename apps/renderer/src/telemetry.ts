/**
 * STAGE 2 — honest telemetry semantics for the model runtime popover.
 *
 * The composer popover may only show numbers that the canonical truth can support:
 *   KNOWN     — an observed, authoritative value (an observed true zero stays KNOWN and
 *               renders as 0, because "0%" must never stand in for "unknown");
 *   ESTIMATED — derived from a declared estimation rule (rendered with ≈);
 *   UNKNOWN   — no authoritative source (rendered "--", NEVER a fabricated zero or a
 *               fabricated percentage).
 *
 * E1's usage/latency projections are main-process-only and are not exposed over IPC, so
 * the renderer receives UNKNOWN for anything it cannot observe. That is the correct
 * answer, not a gap to paper over with placeholder metrics.
 */

/** Usage provenance, mirroring the E1 vocabulary (apps/desktop/src/efficiency/usage-coverage.ts). */
export type UsageState = 'KNOWN' | 'ESTIMATED' | 'UNKNOWN';

export interface TelemetryValue {
  readonly state: UsageState;
  /** Present only for KNOWN/ESTIMATED. */
  readonly value?: number;
  readonly unit?: string;
}

const UNKNOWN: TelemetryValue = { state: 'UNKNOWN' };

export const unknownTelemetry = (): TelemetryValue => UNKNOWN;

export const knownTelemetry = (value: number, unit?: string): TelemetryValue => ({
  state: 'KNOWN',
  value,
  ...(unit === undefined ? {} : { unit }),
});

export const estimatedTelemetry = (value: number, unit?: string): TelemetryValue => ({
  state: 'ESTIMATED',
  value,
  ...(unit === undefined ? {} : { unit }),
});

/** Render one telemetry slot. UNKNOWN is always "--"; never "0", never "0%". */
export const formatTelemetry = (metric: TelemetryValue): string => {
  if (metric.state === 'UNKNOWN' || metric.value === undefined) return '--';
  const rendered = formatNumber(metric.value);
  const withUnit = metric.unit === undefined ? rendered : `${rendered}${metric.unit}`;
  return metric.state === 'ESTIMATED' ? `≈${withUnit}` : withUnit;
};

export const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) return '--';
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  // Keep enough precision for small values (a session cost of 0.017 must not collapse
  // to 0.0) without inventing precision the source does not have.
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
};

/**
 * Remaining context share. Derivable ONLY when both the model's context window and the
 * observed usage are known; otherwise the popover shows "--" rather than inventing a bar.
 */
export const contextRemaining = (
  contextWindow: number | null,
  usedTokens: number | null,
): TelemetryValue => {
  if (contextWindow === null || contextWindow <= 0 || usedTokens === null || usedTokens < 0) return UNKNOWN;
  const remaining = Math.max(0, Math.min(1, (contextWindow - usedTokens) / contextWindow));
  return knownTelemetry(Math.round(remaining * 100), '%');
};

/** A percentage is renderable only when it comes from an observed count (never from activity). */
export const ratioPercent = (numerator: number | null, denominator: number | null): TelemetryValue => {
  if (numerator === null || denominator === null || denominator <= 0) return UNKNOWN;
  return knownTelemetry(Math.round((numerator / denominator) * 100), '%');
};

/** Tokens per second is a measurement; without a measurement it is UNKNOWN. */
export const tokensPerSecond = (samples: readonly number[]): TelemetryValue => {
  if (samples.length === 0) return UNKNOWN;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return knownTelemetry(Math.round(mean * 10) / 10, '/s');
};

/** Cache-hit rate is authoritative only when the provider/kernel reports cached tokens. */
export const cacheHitRate = (cachedTokens: number | null, totalTokens: number | null): TelemetryValue => {
  if (cachedTokens === null || totalTokens === null || totalTokens <= 0) return UNKNOWN;
  return knownTelemetry(Math.round((cachedTokens / totalTokens) * 100), '%');
};

/** Cost is KNOWN only from authoritative token counts × the declared price. */
export const sessionCost = (
  inputTokens: number | null,
  outputTokens: number | null,
  price: { readonly inputPerMillion: number | null; readonly outputPerMillion: number | null } | null,
): TelemetryValue => {
  if (inputTokens === null || outputTokens === null || price === null) return UNKNOWN;
  const inputPrice = price.inputPerMillion ?? 0;
  const outputPrice = price.outputPerMillion ?? 0;
  const cost = (inputTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * outputPrice;
  return knownTelemetry(Math.round(cost * 1000) / 1000, '');
};

/** The popover's model line: the canonical display name, never a nickname invented in the UI. */
export interface ModelRuntimeRow {
  readonly modelKey: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly contextWindow: number | null;
  readonly price: { readonly inputPerMillion: number | null; readonly outputPerMillion: number | null } | null;
  readonly availability: string;
}

export interface ModelRuntimeSnapshot {
  readonly model: ModelRuntimeRow | null;
  /** Goal-scope usage (the token row). Cumulative Goal tokens are NOT context occupancy. */
  readonly usedTokens: number | null;
  /**
   * Proven CURRENT-context occupancy. Only a per-invocation occupancy measurement may fill
   * this; cumulative Goal usage may not, so it stays null and the popover shows "--".
   */
  readonly contextUsedTokens?: number | null;
  readonly cachedTokens: number | null;
  readonly speedSamples: readonly number[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface ModelRuntimeView {
  readonly modelLabel: string;
  readonly contextWindow: string;
  readonly remaining: string;
  readonly used: string;
  readonly speed: string;
  readonly cacheHit: string;
  readonly cost: string;
  /** True when every slot is UNKNOWN — the UI then says "无可用遥测" instead of a metric wall. */
  readonly telemetryUnavailable: boolean;
}

export const projectModelRuntime = (snapshot: ModelRuntimeSnapshot): ModelRuntimeView => {
  const model = snapshot.model;
  const remaining = contextRemaining(model?.contextWindow ?? null, snapshot.contextUsedTokens ?? null);
  const used = snapshot.usedTokens === null ? UNKNOWN : knownTelemetry(snapshot.usedTokens);
  const speed = tokensPerSecond(snapshot.speedSamples);
  const cacheHit = cacheHitRate(snapshot.cachedTokens, snapshot.usedTokens);
  const cost = sessionCost(snapshot.inputTokens, snapshot.outputTokens, model?.price ?? null);
  const slots = [remaining, used, speed, cacheHit, cost];
  return {
    modelLabel: model === null ? '未选择模型' : model.displayName,
    contextWindow: model?.contextWindow === null || model === null ? '--' : formatNumber(model.contextWindow),
    remaining: formatTelemetry(remaining),
    used: formatTelemetry(used),
    speed: formatTelemetry(speed),
    cacheHit: formatTelemetry(cacheHit),
    cost: formatTelemetry(cost),
    telemetryUnavailable: slots.every((slot) => slot.state === 'UNKNOWN'),
  };
};
