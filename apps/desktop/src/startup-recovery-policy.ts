/**
 * AUDIT-E2 (desktop) — which startup-recovery failures are fatal.
 *
 * The engine orchestrator now scans EVERY run and reports each one it could not recover
 * (RUN_RECOVERY_FAILED with details.failures[]); an honoured cancel intent is a success. A
 * per-run failure used to exit the app with code 1 on every boot, so one unrecoverable run
 * bricked CompanyOS forever. Such runs are now quarantined (left untouched, no driver started,
 * the user is told which), while every other failure (agent/tool recovery, run enumeration,
 * anything unrecognised) stays fatal, fail closed.
 */
export type RecoveryFailurePolicy =
  | { readonly kind: 'quarantine'; readonly runIds: readonly string[] }
  | { readonly kind: 'fatal' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const recoveryFailurePolicy = (error: { readonly details?: unknown }): RecoveryFailurePolicy => {
  const details = isRecord(error.details) ? error.details : null;
  if (details === null || details['reason'] !== 'RUN_RECOVERY_FAILED' || !Array.isArray(details['failures'])) return { kind: 'fatal' };
  const runIds: string[] = [];
  for (const failure of details['failures']) {
    if (!isRecord(failure) || typeof failure['runId'] !== 'string' || failure['runId'] === '') return { kind: 'fatal' };
    runIds.push(failure['runId']);
  }
  return runIds.length === 0 ? { kind: 'fatal' } : { kind: 'quarantine', runIds };
};
