/**
 * 42ed326 re-audit (N42-T1) — STORE-LEVEL WRITE FENCE APPLICATION.
 *
 * Every store assembled for a SQLite connection has its MUTATING methods routed through
 * that connection's ONE write fence (`db.writeFence.mutation`). Ordering/ownership therefore
 * has a single scope: the connection. A store-local lock could never provide cross-store
 * isolation, and a store that wrote directly could still land inside another async context's
 * open transaction — which this application removes wholesale.
 *
 * Semantics per call (all decided inside `mutation`):
 *   - the context already owns a unit (transaction or serialize)  → runs in place, so an
 *     in-transaction write stays atomic with that unit;
 *   - NO transaction is open                                      → runs immediately (the
 *     statement's synchronous commit is the durability point — commit-at-arrival preserved);
 *   - ANOTHER context's transaction is open                        → WAITS for legal access.
 *
 * Naming: `storeName.method` is carried on the fence for diagnostics only.
 */
import type { Database } from '../db.js';

/**
 * 314caae re-audit (N314-COV1) — NO METHOD-NAME LIST: EVERY function member of a store
 * (reads and writes alike) is routed through the connection fence. Guessing which names are
 * mutations (the previous approach missed `routerDecisions.save`) is exactly the failure
 * mode this replaces. Reads ride the same exclusive access, so no store operation — read
 * or write — can observe a foreign transaction's uncommitted rows as authoritative truth
 * (INVARIANT C). The wrap preserves every member signature and return semantics: a store
 * method is async, the wrapper returns the same promise type; methods not present are not
 * invented.
 */
export const STORE_WRITE_METHODS: readonly string[] = [];

export const fenceStoreWrites = <S extends object>(
  db: Database,
  storeName: string,
  store: S,
  options: { readonly skip?: readonly string[] } = {},
): S => {
  const source = store as unknown as Record<string, unknown>;
  const wrapped: Record<string, unknown> = { ...source };
  const skip = new Set(options.skip ?? []);
  for (const method of Object.keys(source)) {
    const original = source[method];
    if (typeof original !== 'function' || skip.has(method)) continue;
    const fn = original as (...args: unknown[]) => unknown;
    wrapped[method] = (...args: unknown[]) =>
      db.writeFence.mutation(`${storeName}.${method}`, async () => fn.apply(store, args));
  }
  return wrapped as S;
};
