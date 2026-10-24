/**
 * SQLite access — the only module that touches `node:sqlite`.
 *
 * Why `node:sqlite` (ADR-0001): the desktop app must ship without a native
 * compilation step, so `better-sqlite3`/`electron-rebuild` were rejected.
 * Every connection is opened with the pragmas the planning document §五十六
 * requires: WAL, foreign keys ON, a bounded busy timeout inside transactions.
 *
 * 314caae re-audit (N314-T1 / N314-OWN1 / N314-REC1 / N314-ERR1) — the connection's
 * ASYNC transaction-ownership contract. Statements are synchronous, but a persistence
 * operation spans `await`s: between two statements of one operation another async context
 * can BEGIN a transaction on the same connection, write the same rows uncommitted, and
 * later ROLL BACK — so an operation that only checked "no owner" at entry could read
 * uncommitted foreign rows as authoritative truth and announce a success that vanishes.
 *
 * The contract enforced here:
 *   - `transaction` / `serialize` / `immediate` are the ONLY ways a unit obtains the
 *     connection's write order. `transaction` and `serialize` queue on ONE per-connection
 *     FIFO (exclusive for their whole duration, INCLUDING their awaits). `immediate` runs
 *     a SYNCHRONOUS statement burst at once and blocks BEGIN until it finishes.
 *   - EVERY statement execution is checked against the CURRENT effective ownership
 *     (unit id + generation + open-transaction state) at execution time — not at entry.
 *   - a stale unit context (its transaction already ended) can never write again;
 *   - a mutation attempted inside a FOREIGN open transaction is refused, typed;
 *   - COMMIT/ROLLBACK uncertainty fails CLOSED (`indeterminate` connection state), and a
 *     closed connection refuses queued work with a typed error — never a fake success.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { DatabaseSync } from 'node:sqlite';

import { type DomainError, domainError, err, ok, type Result } from '@companyos/core';

import { toPersistenceError } from './durable/storage-errors.js';

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  iterate?(...params: SqlValue[]): IterableIterator<unknown>;
}

/**
 * The connection-level write-order / ownership fence: ONE per SQLite connection.
 * `mutation` gives an async persistence operation EXCLUSIVE access across its awaits; the
 * store-level wrappers route every production mutation through it.
 */
export interface ConnectionWriteFence {
  /** BEGIN IMMEDIATE … COMMIT on the connection's FIFO; nested calls join the outer unit. */
  transaction<R>(work: () => Promise<R>): Promise<Result<R, DomainError>>;
  /** The same FIFO slot WITHOUT a transaction (exclusive across the callback's awaits). */
  serialize<R>(work: () => Promise<R>, operation?: string): Promise<R>;
  /**
   * An ordinary async production mutation: EXCLUSIVE connection access for the whole
   * callback (its awaits included). Inside its own unit it runs in place.
   */
  mutation<T>(operation: string, work: () => Promise<T>): Promise<T>;
  /**
   * A SYNCHRONOUS statement burst (e.g. the LEVEL B commit-at-arrival event append):
   * runs immediately when no transaction is open (the statements' own synchronous commit
   * is the durability point) and blocks BEGIN until it completes; when a foreign
   * transaction is open it waits for legal access. `work` must not open a transaction.
   */
  immediate<T>(operation: string, work: () => Promise<T>): Promise<T>;
  /** The unit id currently owning the connection's open transaction (null when none). */
  readonly openTransactionOwner: () => string | null;
  readonly committed: () => number;
  readonly rolledBack: () => number;
  /** 'ok' | 'indeterminate' (COMMIT+ROLLBACK failed) | 'closed'. */
  readonly connectionState: () => 'ok' | 'indeterminate' | 'closed';
}

export interface Database {
  /** `:memory:` or an absolute file path. */
  readonly path: string;
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Runs `work` inside BEGIN IMMEDIATE / COMMIT, rolling back on throw. */
  inTransaction<R>(work: () => R): R;
  close(): void;
  /**
   * The underlying driver. Production code must not use it for MUTATIONS (the guarded
   * statement layer and the fence are the only mutation entrances); tests use it for
   * fault injection and read-only introspection.
   */
  readonly raw: DatabaseSync;
  /** The ONE write-order/ownership fence of this connection (shared by every store). */
  readonly writeFence: ConnectionWriteFence;
}

export interface OpenDatabaseOptions {
  readonly path: string;
  readonly readOnly?: boolean;
  readonly journalMode?: 'WAL' | 'DELETE' | 'TRUNCATE' | 'MEMORY';
  readonly synchronous?: 'FULL' | 'NORMAL' | 'OFF';
  readonly busyTimeoutMs?: number;
  readonly foreignKeys?: boolean;
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** A single-quoted-free integer pragma value, validated to avoid SQL injection. */
const pragmaInt = (value: number): string => {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`Illegal pragma integer: ${String(value)}`);
  }
  return String(value);
};

export function openDatabase(options: OpenDatabaseOptions): Database {
  const raw = new DatabaseSync(options.path, options.readOnly === true ? { readOnly: true } : {});
  const journalMode = options.journalMode ?? 'WAL';
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const foreignKeys = options.foreignKeys ?? true;
  const synchronous = options.synchronous ?? 'NORMAL';

  raw.exec(`PRAGMA journal_mode = ${journalMode}`);
  raw.exec(`PRAGMA synchronous = ${synchronous}`);
  raw.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  raw.exec(`PRAGMA busy_timeout = ${pragmaInt(busyTimeoutMs)}`);

  /* ---- the connection's ONE write-order / ownership fence ------------------------ */
  interface UnitState {
    readonly unitId: string;
    readonly operation: string;
    readonly generation: number;
    readonly kind: 'transaction' | 'serialize' | 'immediate';
    aborted: DomainError | null;
  }
  const unitContext = new AsyncLocalStorage<UnitState>();
  let openTransactionOwner: string | null = null;
  let syncTransactionDepth = 0;
  let unitSeq = 0;
  let generationSeq = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let commits = 0;
  let rollbacks = 0;
  let inFlightImmediate = 0;
  const quiescentWaiters: (() => void)[] = [];
  let connectionState: 'ok' | 'indeterminate' | 'closed' = 'ok';

  const refuseIfNotHealthy = (operation: string): void => {
    if (connectionState === 'ok') return;
    throw domainError(
      'PERSISTENCE_FAILED',
      `The connection refuses "${operation}": its transaction state is ${connectionState}.`,
      { reason: connectionState === 'closed' ? 'CONNECTION_CLOSED' : 'CONNECTION_STATE_UNCERTAIN', operation },
    );
  };
  const crossContextRefusal = (operation: string, form: 'run' | 'get' | 'all' | 'iterate' = 'run'): DomainError =>
    domainError(
      'PERSISTENCE_FAILED',
      form === 'run'
        ? `The durable mutation "${operation}" was refused: it would have executed inside another async context's open transaction on this connection (whose ROLLBACK would silently erase it).`
        : `The durable READ "${operation}" was refused: it would have observed another async context's UNCOMMITTED rows on this connection.`,
      {
        reason:
          form === 'run'
            ? 'CROSS_CONTEXT_TRANSACTION_WRITE_REFUSED'
            : 'CROSS_CONTEXT_TRANSACTION_READ_REFUSED',
        form,
        operation,
        transactionOwner: openTransactionOwner,
      },
    );
  const staleOwnerRefusal = (
    operation: string,
    unit: UnitState,
    form: 'run' | 'get' | 'all' | 'iterate' = 'run',
  ): DomainError =>
    domainError(
      'PERSISTENCE_FAILED',
      `The durable ${form === 'run' ? 'mutation' : 'READ'} "${operation}" was refused: its unit "${unit.unitId}" no longer owns this connection's transaction (stale async context).`,
      {
        reason: 'STALE_TRANSACTION_OWNER_REFUSED',
        form,
        operation,
        unitId: unit.unitId,
        generation: unit.generation,
        transactionOwner: openTransactionOwner,
      },
    );

  /**
   * N07-I1 — execution-time ownership for EVERY statement execution form, reads included.
   * `run`, `get`, `all` and `iterate` all touch the shared connection, so all of them must
   * respect the CURRENT legal ownership: while a foreign transaction is open (or the
   * connection is indeterminate/closed), a read on this connection would observe that
   * transaction's UNCOMMITTED rows — it is refused typed instead. `UPDATE ... RETURNING`
   * and any other statement is covered because the guard is bound to the execution FORM,
   * never to the SQL's first word.
   */
  const guardAccess = (operation: string, form: 'run' | 'get' | 'all' | 'iterate'): void => {
    refuseIfNotHealthy(operation);
    if (syncTransactionDepth > 0) return; // the synchronous section owns the connection stack
    const unit = unitContext.getStore();
    if (unit === undefined) {
      if (openTransactionOwner !== null) throw crossContextRefusal(operation, form);
      return;
    }
    if (unit.kind === 'transaction') {
      if (openTransactionOwner !== unit.unitId) throw staleOwnerRefusal(operation, unit, form);
      return;
    }
    if (openTransactionOwner !== null && openTransactionOwner !== unit.unitId) {
      throw crossContextRefusal(operation, form);
    }
  };
  const guardMutation = (operation: string): void => guardAccess(operation, 'run');

  const statementOperation = (sql: string): string => {
    const stripped = sql.replace(/^\s*(?:--[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*/, '');
    const verb = (/^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|WITH)\b/i.exec(stripped)?.[1] ?? 'MUTATION').toUpperCase();
    return `${verb} statement`;
  };

  /**
   * The guarded statement layer: EVERY execution form keeps the original statement API
   * (run/get/all/iterate are bound from the real statement — never lost by a spread), and
   * `run` is treated STRUCTURALLY as a mutation (stores use get/all for reads; run is the
   * only mutating execution form) and checked against current ownership at call time.
   */
  const guardStatement = (sql: string, statement: SqlStatement): SqlStatement => {
    const operation = statementOperation(sql);
    const iterate = statement.iterate?.bind(statement);
    return {
      run: (...params: SqlValue[]) => {
        guardAccess(operation, 'run');
        return statement.run(...params);
      },
      get: (...params: SqlValue[]) => {
        guardAccess(operation, 'get');
        return statement.get(...params);
      },
      all: (...params: SqlValue[]) => {
        guardAccess(operation, 'all');
        return statement.all(...params);
      },
      ...(iterate === undefined
        ? {}
        : {
            iterate: (...params: SqlValue[]) => {
              guardAccess(operation, 'iterate');
              return iterate(...params);
            },
          }),
    };
  };

  /** Wait until no synchronous statement burst is in flight on this connection. */
  const quiescent = async (): Promise<void> => {
    while (inFlightImmediate > 0) {
      await new Promise<void>((resolve) => quiescentWaiters.push(resolve));
    }
  };

  /** The one physical transaction body (BEGIN … COMMIT/ROLLBACK + the state machine). */
  const executeTransaction = async <R>(
    unit: UnitState,
    work: () => Promise<R>,
  ): Promise<Result<R, DomainError>> => {
    try {
      raw.exec('BEGIN IMMEDIATE');
    } catch (error) {
      // N314-ERR1 — a failed BEGIN never claims ownership and never blocks the queue.
      return err(toPersistenceError(error, { operation: 'BEGIN' }));
    }
    openTransactionOwner = unit.unitId;
    try {
      const value = await unitContext.run(unit, work);
      if (unit.aborted !== null) throw unit.aborted;
      raw.exec('COMMIT');
      commits += 1;
      openTransactionOwner = null;
      return ok(value);
    } catch (error) {
      let rollbackKnown = true;
      try {
        raw.exec('ROLLBACK');
      } catch {
        // N314-REC1 — if the ROLLBACK also fails, the connection's transaction state is
        // UNKNOWN: fail CLOSED instead of clearing the owner and accepting new writes.
        rollbackKnown = false;
        connectionState = 'indeterminate';
      }
      rollbacks += 1;
      openTransactionOwner = null;
      return err(toPersistenceError(error, ...(rollbackKnown ? [] : [{ rollbackUnknown: true }])));
    }
  };

  const newUnit = (kind: UnitState['kind'], operation: string = kind): UnitState => ({
    unitId: `${kind}-${String(++unitSeq)}`,
    operation,
    generation: ++generationSeq,
    kind,
    aborted: null,
  });

  const writeFence: ConnectionWriteFence = {
    async transaction<R>(work: () => Promise<R>): Promise<Result<R, DomainError>> {
      const outer = unitContext.getStore();
      if (outer !== undefined) {
        // N07-A1 — a STALE context (its transaction already ended) must never borrow the
        // connection again: joining is only legal while the outer unit still owns it.
        if (outer.kind === 'transaction' && openTransactionOwner !== outer.unitId) {
          return err(staleOwnerRefusal('nested transaction', outer));
        }
        if (outer.kind !== 'transaction' && openTransactionOwner !== null && openTransactionOwner !== outer.unitId) {
          return err(crossContextRefusal('nested transaction'));
        }
        if (outer.kind === 'immediate') {
          // A synchronous burst must not open a transaction (it would have to queue on the
          // FIFO behind its own in-flight body). Typed refusal, never a hang.
          return err(
            domainError(
              'PERSISTENCE_FAILED',
              'A transaction cannot be opened inside an immediate() burst on one connection.',
              { reason: 'IMMEDIATE_TRANSACTION_NESTING_REFUSED' },
            ),
          );
        }
        if (outer.kind === 'transaction') {
          // Nested transaction: the outer unit owns BEGIN/COMMIT — join it in place. A
          // nested THROW poisons the outer transaction (it must roll back).
          try {
            return ok(await work());
          } catch (error) {
            const abort = toPersistenceError(error, { nested: true });
            outer.aborted = abort;
            return err(abort);
          }
        }
        // serialize → transaction: ESCALATE in place. The serialize slot already holds the
        // connection's write order (no other transaction can be open), so opening one here
        // is safe and cannot self-wait. The unit adopts transaction semantics for the body.
        const escalated = newUnit('transaction');
        return executeTransaction(escalated, work);
      }
      if (connectionState !== 'ok') {
        return err(
          domainError(
            'PERSISTENCE_FAILED',
            `The connection refuses a transaction: its transaction state is ${connectionState}.`,
            { reason: connectionState === 'closed' ? 'CONNECTION_CLOSED' : 'CONNECTION_STATE_UNCERTAIN' },
          ),
        );
      }
      const unit = newUnit('transaction');
      const runTransaction = async (): Promise<Result<R, DomainError>> => {
        // A synchronous statement burst in flight owns this tick's writes; BEGIN waits for
        // it to finish so it can never be captured by (or capture) a transaction.
        await quiescent();
        if (connectionState !== 'ok') {
          return err(
            domainError(
              'PERSISTENCE_FAILED',
              `The connection refuses "${unit.unitId}": its transaction state is ${connectionState}.`,
              { reason: connectionState === 'closed' ? 'CONNECTION_CLOSED' : 'CONNECTION_STATE_UNCERTAIN' },
            ),
          );
        }
        return executeTransaction(unit, work);
      };
      const scheduled = tail.then(runTransaction, runTransaction);
      tail = scheduled.then(
        () => undefined,
        () => undefined,
      );
      return scheduled;
    },
    async serialize<R>(work: () => Promise<R>, operation: string = 'serialize'): Promise<R> {
      const outer = unitContext.getStore();
      if (outer !== undefined) {
        // N07-A1 — only a unit that STILL owns the connection may run in place.
        if (outer.kind === 'transaction' && openTransactionOwner !== outer.unitId) {
          throw staleOwnerRefusal(operation, outer);
        }
        if (outer.kind !== 'transaction' && openTransactionOwner !== null && openTransactionOwner !== outer.unitId) {
          throw crossContextRefusal(operation);
        }
        return work(); // the outer unit already owns the write order
      }
      const unit = newUnit('serialize', operation);
      const runStandalone = async (): Promise<R> => {
        refuseIfNotHealthy(unit.operation); // a queued unit re-checks the connection at run time
        await quiescent(); // never interleave a synchronous statement burst
        return unitContext.run(unit, work);
      };
      const scheduled = tail.then(runStandalone, runStandalone);
      tail = scheduled.then(
        () => undefined,
        () => undefined,
      );
      return scheduled;
    },
    async mutation<T>(operation: string, work: () => Promise<T>): Promise<T> {
      // N314-T1 — an async mutation gets EXCLUSIVE access for the WHOLE callback (awaits
      // included): it takes the FIFO slot, so no transaction and no other mutation can
      // interleave between its steps. Entry-time checks alone are not ownership.
      //
      // ERROR TRANSPARENCY (N314-COV1): errors propagate UNCHANGED — the fence never
      // rewrites a store's own error shape (callers detect UNIQUE losses by the raw
      // driver error); the fence's own ownership/state refusals are already typed.
      const outer = unitContext.getStore();
      if (outer !== undefined) return work(); // inside its own unit: in place
      return writeFence.serialize(() => work(), operation);
    },
    async immediate<T>(operation: string, work: () => Promise<T>): Promise<T> {
      const outer = unitContext.getStore();
      if (outer !== undefined) {
        // N07-A1 — a stale unit never re-enters the connection.
        if (outer.kind === 'transaction' && openTransactionOwner !== outer.unitId) {
          throw staleOwnerRefusal(operation, outer);
        }
        if (outer.kind !== 'transaction' && openTransactionOwner !== null && openTransactionOwner !== outer.unitId) {
          throw crossContextRefusal(operation);
        }
        return work();
      }
      refuseIfNotHealthy(operation);
      /*
       * N07-O1 — THE LINEARIZATION CONTRACT (stated, not implied):
       *   - immediate is linearized against OPEN TRANSACTIONS: it waits for legal access and
       *     never executes inside a foreign transaction (whose ROLLBACK could erase it),
       *     exactly like every other mutation;
       *   - it MAY proceed while a non-transactional unit (serialize) is in flight, because
       *     such a unit is a single-statement burst whose steps are individually durable —
       *     there is no transaction to break. Every read-modify-write production path (e.g.
       *     guarded task creation) runs inside its OWN transaction and is therefore
       *     protected by the first rule;
       *   - BEGIN waits for in-flight immediate bursts (quiescence), so no transaction can
       *     start in the middle of one.
       * This preserves the LEVEL B commit-at-arrival property without ever exposing a
       * transactional boundary.
       */
      if (openTransactionOwner !== null) {
        return writeFence.serialize(() => work(), operation);
      }
      // No transaction is open: run the synchronous burst NOW — its statements' own
      // synchronous commits are the durability points (LEVEL B commit-at-arrival).
      const unit = newUnit('immediate');
      inFlightImmediate += 1;
      try {
        return await unitContext.run(unit, work);
      } finally {
        inFlightImmediate -= 1;
        if (inFlightImmediate === 0) {
          for (const waiter of quiescentWaiters.splice(0)) waiter();
        }
      }
    },
    openTransactionOwner: (): string | null => openTransactionOwner,
    committed: (): number => commits,
    rolledBack: (): number => rollbacks,
    connectionState: (): 'ok' | 'indeterminate' | 'closed' => connectionState,
  };

  /*
   * N314-OWN1 — statement-level ownership. `db.prepare` and `raw.prepare` return guarded
   * statements (mutating `run`/`exec` checked at execution time), so SQL shape (comment
   * prefixes, WITH…INSERT, DDL) is never the safety argument. `raw.exec` stays the plain,
   * patchable driver entry: it is the TEST fault-injection seam (COMMIT/ROLLBACK failure
   * tests patch it) and the migration runner's DDL channel. PRODUCTION CODE NEVER WRITES
   * THROUGH IT — the connection-wide mutation audit finds zero production `raw.exec`
   * mutations; the guarded facade (`db.exec`) and the fenced stores are the only
   * production mutation entrances.
   */
  const guardedRaw = new Proxy(raw, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string): SqlStatement => {
          refuseIfNotHealthy(statementOperation(sql));
          return guardStatement(sql, target.prepare(sql) as unknown as SqlStatement);
        };
      }
      const value = (target as unknown as Record<string, unknown>)[String(property)];
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as DatabaseSync;



  return {
    path: options.path,
    raw: guardedRaw,
    writeFence,
    exec: (sql: string): void => {
      guardMutation(statementOperation(sql));
      raw.exec(sql);
    },
    prepare: (sql: string): SqlStatement => {
      // N07-R1/R1-10 — a closed or INDETERMINATE connection refuses at PREPARE time: the
      // driver must never be touched after the connection's transaction state is unknown.
      refuseIfNotHealthy(statementOperation(sql));
      return guardStatement(sql, raw.prepare(sql) as unknown as SqlStatement);
    },
    /**
     * Synchronous transaction helper (the migration runner AND the stores' synchronous
     * create paths — e.g. HandoffService.createDraft → handoffStore.create).
     *
     * N07-R1 — it obeys the SAME connection state machine as the async fence:
     *   - BEGIN is refused typed while any transaction is already open on this connection
     *     (an async owner or a residual one): a second independent owner is impossible, and
     *     the sync API never blocks the event loop waiting for the FIFO;
     *   - a FAILED COMMIT or a FAILED ROLLBACK makes the connection INDETERMINATE (fail
     *     closed): no later mutation may report success on a connection whose transaction
     *     state is unknown, and residual transaction data is never presented as committed
     *     truth;
     *   - errors are normalised to typed DomainErrors with the raw cause retained.
     * No `await` interleaves inside the body, so the sync section owns the connection
     * stack for its whole duration.
     */
    inTransaction: <R>(work: () => R): R => {
      if (connectionState !== 'ok') {
        throw domainError(
          'PERSISTENCE_FAILED',
          `The connection refuses a synchronous transaction: its transaction state is ${connectionState}.`,
          { reason: connectionState === 'closed' ? 'CONNECTION_CLOSED' : 'CONNECTION_STATE_UNCERTAIN' },
        );
      }
      if (openTransactionOwner !== null) {
        throw domainError(
          'PERSISTENCE_FAILED',
          'A synchronous transaction was refused: this connection already has an open transaction owned by another context.',
          { reason: 'SYNC_TRANSACTION_OWNER_CONFLICT', transactionOwner: openTransactionOwner },
        );
      }
      try {
        raw.exec('BEGIN IMMEDIATE');
      } catch (error) {
        // A failed BEGIN never claims ownership and never leaves state behind.
        throw toPersistenceError(error, { operation: 'BEGIN', form: 'sync' });
      }
      const unitId = `sync-${String(++unitSeq)}`;
      openTransactionOwner = unitId;
      syncTransactionDepth += 1;
      let settled = false;
      try {
        const result = work();
        try {
          raw.exec('COMMIT');
        } catch (error) {
          let rollbackKnown = true;
          try {
            raw.exec('ROLLBACK');
          } catch {
            rollbackKnown = false;
          }
          if (!rollbackKnown) connectionState = 'indeterminate';
          rollbacks += 1;
          settled = true;
          if (rollbackKnown) openTransactionOwner = null;
          throw toPersistenceError(error, {
            operation: 'COMMIT',
            form: 'sync',
            ...(rollbackKnown ? {} : { rollbackUnknown: true, residualTransaction: true }),
          });
        }
        commits += 1;
        openTransactionOwner = null;
        settled = true;
        return result;
      } catch (error) {
        if (settled) throw error; // the failed-COMMIT path already handled its state
        let rollbackKnown = true;
        try {
          raw.exec('ROLLBACK');
        } catch {
          // N07-R1 — a failed ROLLBACK leaves a RESIDUAL OPEN TRANSACTION: the connection's
          // state is UNKNOWN. It is never reported as recovered, and every later mutation is
          // refused typed until a controlled reopen proves a safe state.
          rollbackKnown = false;
          connectionState = 'indeterminate';
        }
        rollbacks += 1;
        if (rollbackKnown) openTransactionOwner = null;
        if (rollbackKnown) {
          // The unwind was clean: the ORIGINAL error propagates UNCHANGED (callers keep
          // classifying their own constraint/domain failures exactly as before).
          throw error;
        }
        // The unwind FAILED: the connection's state is unknown. The typed failure keeps the
        // original cause in DETAILS (the message never borrows driver constraint wording, so
        // no caller can mistake it for its own conflict classification).
        throw domainError(
          'PERSISTENCE_FAILED',
          'The synchronous transaction could not be unwound: the connection state is unknown.',
          {
            reason: 'SYNC_TRANSACTION_ROLLBACK_FAILED',
            operation: 'ROLLBACK',
            form: 'sync',
            rollbackUnknown: true,
            residualTransaction: true,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      } finally {
        syncTransactionDepth -= 1;
      }
    },
    close: (): void => {
      connectionState = 'closed';
      raw.close();
    },
  };
}

/** Read a single pragma value, e.g. `journal_mode` — used by tests and diagnostics. */
export function readPragma(db: Database, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get();
  if (row === undefined || row === null || typeof row !== 'object') return null;
  const values = Object.values(row as Record<string, unknown>);
  return values.length === 1 ? (values[0] as unknown) : row;
}

/** Table existence check (kept here so callers never hand-roll introspection SQL). */
export const tableExists = (db: Database, table: string): boolean => {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row !== undefined;
};
