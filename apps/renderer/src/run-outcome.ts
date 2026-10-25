/**
 * H12b — how a run ENDED, as the boss sees it.
 *
 * The frozen L1 machine (STATE_MACHINE.md SM-L1-07) records a cancelled run as
 * `FAILED` + typed `failureReason: 'cancelled'` and a timed-out run as `FAILED` +
 * `timed_out`. The main process projects the typed `terminalOutcome`
 * (COMPLETED / CANCELLED / TIMED_OUT / FAILED, null while running); the renderer reads
 * it here and never compares a run state with a `CANCELLED` string (no such run state
 * exists) and never shows a cancelled Goal as 失败.
 *
 * Display-only: nothing here decides or grants anything.
 */

export const TERMINAL_OUTCOMES = ['COMPLETED', 'CANCELLED', 'TIMED_OUT', 'FAILED'] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

export interface RunEndInput {
  readonly state?: string | null;
  readonly failureReason?: string | null;
  /** Main-process projection; `undefined` = an older payload without the field. */
  readonly terminalOutcome?: string | null;
}

const isTerminalOutcome = (value: unknown): value is TerminalOutcome =>
  typeof value === 'string' && (TERMINAL_OUTCOMES as readonly string[]).includes(value);

/**
 * The typed outcome. A present main-process `terminalOutcome` wins (null = not ended);
 * an older payload without it is derived from the same canonical pair (state +
 * failureReason) with the same rule as the core `runTerminalOutcome`.
 */
export const terminalOutcomeOf = (input: RunEndInput | null | undefined): TerminalOutcome | null => {
  if (input === null || input === undefined) return null;
  if (input.terminalOutcome !== undefined) return isTerminalOutcome(input.terminalOutcome) ? input.terminalOutcome : null;
  if (input.state === 'COMPLETED') return 'COMPLETED';
  if (input.state !== 'FAILED') return null;
  if (input.failureReason === 'cancelled') return 'CANCELLED';
  if (input.failureReason === 'timed_out') return 'TIMED_OUT';
  return 'FAILED';
};

export const TERMINAL_OUTCOME_LABELS: Readonly<Record<TerminalOutcome, string>> = {
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  TIMED_OUT: '已超时',
  FAILED: '失败',
};

/** Badge text: the outcome label once ended, the canonical run state while running. */
export const runStateLabel = (input: RunEndInput): string => {
  const outcome = terminalOutcomeOf(input);
  return outcome === null ? String(input.state ?? '') : TERMINAL_OUTCOME_LABELS[outcome];
};

/** Badge CSS modifier: the outcome once ended, else the run state. */
export const runStateModifier = (input: RunEndInput): string => {
  const outcome = terminalOutcomeOf(input);
  return (outcome ?? String(input.state ?? 'unknown')).toLowerCase().replace(/_/g, '-');
};

export const isRunEnded = (input: RunEndInput | null | undefined): boolean => terminalOutcomeOf(input) !== null;
