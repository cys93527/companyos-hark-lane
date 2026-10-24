/**
 * SQLite UnitOfWork — the public face of the CONNECTION's write fence.
 *
 * 42ed326 re-audit (N42-T1): transaction ownership and FIFO ordering live in ONE place per
 * SQLite connection (`db.writeFence`, see `db.ts`). Every store, service and runtime that
 * writes through this connection shares that single fence — there is no per-store lock, no
 * second queue, and no store that "writes directly" outside the protocol:
 *
 *   - `transaction(work)` — BEGIN IMMEDIATE … COMMIT inside one FIFO slot; nested calls
 *     join the outer transaction; a nested throw POISONS the outer transaction (no
 *     half-applied unit can commit);
 *   - `serialize(work)` — the same FIFO slot WITHOUT a transaction, so an independent
 *     write can never be captured by someone else's open transaction; nesting is in
 *     place (no self-wait);
 *   - `mutation(operation, work)` — an ordinary async production write that WAITS for
 *     legal access instead of failing;
 *   - any statement that would mutate inside a FOREIGN open transaction is REFUSED typed
 *     by the database wrapper's guarded statements (never silently swallowed).
 *
 * Guarantees preserved from the original implementation:
 *   - any throw (or err returned by a write) triggers ROLLBACK, so a partial commit is
 *     impossible;
 *   - transactions are serialized on the single connection;
 *   - one canonical state per transaction.
 */
import { type Result, type DomainError, type UnitOfWork } from '@companyos/core';

import type { Database } from '../db.js';
import { toPersistenceError } from './storage-errors.js';

export { toPersistenceError };

export interface SqliteUnitOfWork extends UnitOfWork {
  /** Test/introspection helper: how many transactions have committed. */
  committed(): number;
  /** Test/introspection helper: how many transactions have rolled back. */
  rolledBack(): number;
}

/**
 * The connection's fence, exposed as the UnitOfWork port. Two calls on the same connection
 * return the SAME fence — that identity IS the single-writer guarantee.
 */
export function createSqliteUnitOfWork(db: Database): SqliteUnitOfWork {
  const fence = db.writeFence;
  return {
    transaction: <R>(work: () => Promise<R>): Promise<Result<R, DomainError>> => fence.transaction(work),
    serialize: <R>(work: () => Promise<R>): Promise<R> => fence.serialize(work),
    committed: () => fence.committed(),
    rolledBack: () => fence.rolledBack(),
  };
}
