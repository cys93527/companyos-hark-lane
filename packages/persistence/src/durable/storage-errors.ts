/**
 * 4a6e362 re-audit (N4-M1) — STORAGE-BOUNDARY ERROR NORMALIZATION.
 *
 * The durable stores surface driver-level failures (node:sqlite / SQLite codes, OS I/O
 * errors) as RAW throws on reads as well as writes. A caller that lets such a throw escape
 * its own boundary cannot classify it, and a launcher that string-matches messages would
 * be guessing. This module is the ONE structured normalizer:
 *
 *   - a DomainError already typed passes through unchanged;
 *   - the fault-injection CRASH sentinel is NEVER disguised (it must tear the process
 *     down exactly like a real crash);
 *   - a recognized STORAGE-ORIGIN failure becomes the canonical typed PERSISTENCE_FAILED,
 *     retaining the raw code, the cause and the operation context;
 *   - anything else — validation, domain invariant, programmer error, provider failure —
 *     is returned UNTOUCHED (null), so the caller rethrows it and it can never be
 *     misclassified as recoverable.
 *
 * `pure` marks a boundary whose ONLY job is durable storage (a store read, a state
 * projection). OS-level I/O codes (EIO/EBUSY/ENOSPC/EROFS) are storage-origin ONLY at a
 * `pure` boundary — an EIO escaping a composite operation (which may touch workspaces,
 * files, providers) is never blindly reinterpreted as a database failure.
 *
 * This is a CLASSIFIER, not a retry policy: it neither retries nor swallows anything.
 */
import { DomainError, FaultCrashError, domainError } from '@companyos/core';

/**
 * Thrown/returned failures are normalised to a Core error so callers see one shape.
 * (Lives here so the connection write fence and the UnitOfWork share ONE normalizer
 * without an import cycle.)
 */
export function toPersistenceError(error: unknown, context: Record<string, unknown> = {}): DomainError {
  if (error instanceof DomainError) return error;
  /*
   * Task-18-08: the fault-injection CRASH SENTINEL is not a persistence failure — it stands
   * for a killed process. It must keep propagating (the transaction still rolls back above),
   * because converting it would disguise a crash as a domain failure, exactly what the
   * deterministic proof forbids.
   */
  if (error instanceof FaultCrashError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  return new DomainError('PERSISTENCE_FAILED', `Persistence operation failed: ${message}`, {
    details: { ...context, cause: message },
    cause: error,
  });
}

/** Structured codes that unambiguously originate in the SQLite driver. */
const SQLITE_CODE_PREFIXES = ['SQLITE_', 'ERR_SQLITE'] as const;
/** OS I/O codes that are storage-origin only at a PURE persistence boundary. */
const PURE_IO_CODES = ['EIO', 'EBUSY', 'ENOSPC', 'EROFS'] as const;

export interface StorageBoundaryContext {
  /** The durable operation being performed ('run.state.read', 'goal.advance', …). */
  readonly operation: string;
  /** TRUE only when the boundary does nothing but durable storage. */
  readonly pure: boolean;
}

const codeOf = (error: unknown): string =>
  String((error as { readonly code?: unknown } | null)?.code ?? '');

/** The structured code classification, without any message parsing. */
export const isStorageOriginCode = (code: string, pure: boolean): boolean => {
  if (SQLITE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) return true;
  return pure && (PURE_IO_CODES as readonly string[]).includes(code);
};

/**
 * Normalize one error that crossed a persistence boundary. Returns the typed
 * PERSISTENCE_FAILED (or the already-typed DomainError) when the error is storage-origin;
 * returns null when the error must stay untouched (the caller rethrows).
 */
export const storageBoundaryErrorOf = (
  error: unknown,
  context: StorageBoundaryContext,
): DomainError | null => {
  if (error instanceof FaultCrashError) throw error; // a crash is never a domain failure
  if (error instanceof DomainError) return error; // already typed — pass through
  const code = codeOf(error);
  if (!isStorageOriginCode(code, context.pure)) return null;
  return domainError('PERSISTENCE_FAILED', `The durable operation "${context.operation}" failed.`, {
    reason: 'STORAGE_OPERATION_FAILED',
    operation: context.operation,
    storageCode: code,
    cause: error instanceof Error ? error.message : String(error),
  });
};

/**
 * The boundary helper for `Result`-shaped durable reads: a storage-origin throw becomes
 * err(PERSISTENCE_FAILED); every other throw stays a throw.
 */
export const runDurableRead = async <T>(
  context: StorageBoundaryContext,
  read: () => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DomainError }> => {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    const typed = storageBoundaryErrorOf(error, context);
    if (typed === null) throw error;
    return { ok: false, error: typed };
  }
};
