/**
 * Port: persistence.
 *
 * ADR-0001 — this port is called `EntityStore`, never `Repository`: the word
 * "repository" is owned by the coding Industry Pack (see docs/CORE_BOUNDARIES.md).
 * Core defines the contract; `@companyos/persistence` implements it on SQLite.
 */

import type { Result } from '../kernel/result.js';
import type { DomainError } from '../kernel/errors.js';

export interface EntityId {
  readonly id: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

export interface PageRequest {
  readonly offset?: number;
  readonly limit?: number;
  readonly orderBy?: string;
  readonly descending?: boolean;
}

export interface EntityStore<T extends EntityId> {
  get(id: string): Promise<T | null>;
  put(entity: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(page?: PageRequest): Promise<Page<T>>;
}

/** Transactional scope. Nested calls must join the outer transaction. */
export interface UnitOfWork {
  transaction<R>(work: () => Promise<R>): Promise<Result<R, DomainError>>;
  /**
   * 6ec4d81 re-audit (N25-C1 ten-entrant race) — the SINGLE-CONNECTION WRITE-ORDER fence.
   * Runs `work` (a conditional statement burst) when NO transaction is open on the shared
   * connection, WITHOUT opening one: it queues on the same FIFO as `transaction`, so a
   * direct write can never execute inside a foreign transaction and be silently undone by
   * that transaction's rollback. Nested calls (already inside a transaction) run in place.
   * Optional and default-absent: stores without it keep their historical direct writes.
   */
  serialize?<R>(work: () => Promise<R>): Promise<R>;
}

/** Applies ordered, checksum-verified schema migrations. */
export interface MigrationRunner {
  pending(): Promise<readonly MigrationInfo[]>;
  apply(): Promise<MigrationReport>;
}

export interface MigrationInfo {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string | null;
}

export interface MigrationReport {
  readonly applied: readonly MigrationInfo[];
  readonly skipped: readonly MigrationInfo[];
  readonly currentVersion: number;
}
