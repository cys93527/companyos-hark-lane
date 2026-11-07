// LIVE-CONTRACT-FILL run 5 (hark-live-goal 42367067423): the autonomy driver finished
// EXTERNAL_PRECONDITION_BLOCKED (GOAL_USAGE_UNKNOWN) at 7:36 CST, but the run rows stayed
// EXECUTING and the live harness idled 15 min until IDLE_NO_PROGRESS. The app's own JSON
// log line "autonomy driver finished" is the driver's terminal: the monitor ends on it.
// AUTONOMY_STALLED is resumed by the app itself and USER_DECISION_REQUIRED is answered by
// the harness (approval cards), so neither ends the monitor.

export const DRIVER_RESUMED_TERMINALS = new Set(['AUTONOMY_STALLED', 'USER_DECISION_REQUIRED']);

/** The newest driver finish for `runId` in the app log text that ends the run, or null. */
export const driverEndOf = (logText, runId) => {
  if (typeof logText !== 'string' || logText === '' || typeof runId !== 'string' || runId === '') return null;
  let newest = null;
  for (const line of logText.split(/\r?\n/u)) {
    if (!line.includes('autonomy driver finished') || !line.includes(runId)) continue;
    const start = line.indexOf('{');
    if (start < 0) continue;
    let entry;
    try { entry = JSON.parse(line.slice(start)); } catch { continue; }
    if (entry?.msg !== 'autonomy driver finished' || entry.runId !== runId || typeof entry.terminal !== 'string') continue;
    newest = { terminal: entry.terminal, reason: typeof entry.terminalReason === 'string' ? entry.terminalReason : null, at: entry.ts ?? null };
  }
  if (newest === null || DRIVER_RESUMED_TERMINALS.has(newest.terminal)) return null;
  return newest;
};

/** The monitor end label for a driver finish (`DRIVER_<terminal>[:<reason>]`). */
export const driverEndLabel = (end) => `DRIVER_${end.terminal}${end.reason === null ? '' : `:${end.reason.slice(0, 80)}`}`;
