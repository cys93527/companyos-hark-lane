import type { DatabaseFailure } from './channels.js';

/**
 * H13 — may a later IPC call re-attempt opening the durable database after the startup
 * bootstrap failed?
 *
 * SCHEMA_FROM_NEWER_VERSION is TERMINAL for this process: the database carries migrations a
 * newer CompanyOS applied, and nothing this build does can change that. Re-opening it on
 * every renderer call only repeats the refusal (the H13 CI downgrade phase logged it six
 * times in one launch) and keeps touching a file this version must leave alone. Only an
 * OPEN_FAILED (e.g. a transient lock or a missing directory) is worth another attempt.
 */
export function isDatabaseBootstrapRetryable(failure: DatabaseFailure | null): boolean {
  return failure?.code !== 'SCHEMA_FROM_NEWER_VERSION';
}
