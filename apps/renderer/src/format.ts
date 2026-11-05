/**
 * UI-PAPER-INK — shared display words and time formatting. Display-only: nothing here
 * decides anything; an unparsable or missing value renders `--` (never a guess).
 */
import { formatMoney } from './budget.js';
import { terminalOutcomeOf, TERMINAL_OUTCOME_LABELS, type RunEndInput } from './run-outcome.js';
import { projectTelemetry, type GoalUsageProjection } from './usage.js';

export const UNKNOWN_TEXT = '--';

/** Canonical run states (core RUN_STATES) in the boss's words, while a run is live. */
const LIVE_STATE_WORDS: Readonly<Record<string, string>> = {
  IDLE: '待开始',
  INITIALIZING: '准备中',
  DESIGNING_WORKFLOW: '规划中',
  WORKFLOW_REVIEW: '规划中',
  WORKFLOW_PUBLISHED: '规划中',
  PLANNING: '规划中',
  ROUTING: '执行中',
  WAITING_APPROVAL: '待批准',
  EXECUTING: '执行中',
  REVIEWING: '验证中',
  VALIDATING: '验证中',
  REWORK: '纠正中',
  FINALIZING: '收尾中',
  PAUSED: '已暂停',
  RECOVERING: '恢复中',
};

/**
 * UI-AUDIT-12: the state word of a Goal in lists (sidebar 最近, goal list). Ended -> the
 * typed outcome label; live -> the Chinese word of the canonical state (never the raw
 * English enum); an approval of THIS Goal known to be pending -> 待批准.
 */
export const goalStateWord = (input: RunEndInput & { readonly approvalPending?: boolean }): string => {
  const outcome = terminalOutcomeOf(input);
  if (outcome !== null) return TERMINAL_OUTCOME_LABELS[outcome];
  if (input.approvalPending === true) return '待批准';
  const state = String(input.state ?? '');
  return LIVE_STATE_WORDS[state] ?? (state === '' ? UNKNOWN_TEXT : state);
};

/** True while the Goal is live (the accent colour is reserved for live / needs-you). */
export const isGoalLive = (input: RunEndInput): boolean => terminalOutcomeOf(input) === null;

const pad = (value: number): string => String(value).padStart(2, '0');

const parse = (iso: string | null | undefined): Date | null => {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
};

/** `HH:MM` on the user's clock; null when the stamp is missing/unparsable. */
export const clockTime = (iso: string | null | undefined): string | null => {
  const date = parse(iso);
  return date === null ? null : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** `HH:MM:SS`, with the date in front when it is not today (approval request times). */
export const clockStamp = (iso: string | null | undefined, now: Date = new Date()): string => {
  const date = parse(iso);
  if (date === null) return UNKNOWN_TEXT;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? time : `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
};

/** `今天 23:41 开始` / `2026-11-03 23:41 开始`; null when unknown. */
export const startedAtText = (iso: string | null | undefined, now: Date = new Date()): string | null => {
  const date = parse(iso);
  if (date === null) return null;
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const day = sameDay ? '今天' : `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())} 开始`;
};

/** Measured wall time between a canonical start and now: `6 分 12 秒`; null when unknown. */
export const elapsedText = (fromIso: string | null | undefined, nowMs: number): string | null => {
  const date = parse(fromIso);
  if (date === null || nowMs < date.getTime()) return null;
  const seconds = Math.floor((nowMs - date.getTime()) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${String(hours)} 小时 ${String(minutes)} 分`;
  if (minutes > 0) return `${String(minutes)} 分 ${pad(rest)} 秒`;
  return `${String(rest)} 秒`;
};

/** UI-AUDIT-16: canonical risk levels in words; anything else is shown as given, empty -> --. */
const RISK_WORDS: Readonly<Record<string, string>> = { LOW: '低', MEDIUM: '中', HIGH: '高', CRITICAL: '极高' };
export const riskWord = (level: string | null | undefined): string => {
  if (typeof level !== 'string' || level === '' || level === 'UNKNOWN') return UNKNOWN_TEXT;
  return RISK_WORDS[level.toUpperCase()] ?? level;
};

export const orUnknown = (value: string | null | undefined): string =>
  typeof value === 'string' && value.trim() !== '' ? value : UNKNOWN_TEXT;

/**
 * UI-AUDIT-26: the composer's session cost is main's canonical usage cost (with its currency,
 * `≈` when ESTIMATED); the renderer's own model snapshot carries no currency, so it always
 * said `--`. Anything not provably known stays `--`.
 */
export const sessionCostText = (usage: GoalUsageProjection | null): string => {
  const telemetry = projectTelemetry(usage, null);
  if (telemetry.cost === UNKNOWN_TEXT || usage === null || usage.cost.knownScopeCost === null) return UNKNOWN_TEXT;
  const currency = usage.cost.currency;
  const text = currency === 'CNY' || currency === 'USD' || currency === 'EUR'
    ? formatMoney(Math.round(usage.cost.knownScopeCost * 1_000_000), currency)
    : telemetry.cost;
  return telemetry.costLabel === 'ESTIMATED' ? `≈${text}` : text;
};
