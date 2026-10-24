/**
 * Port: event store — CONTRACT ONLY (Sprint 1 Task 7, ADR-0002).
 *
 * The audit trail (规划书 §四十三 Event System / §四十四 Audit) and crash recovery
 * (§四十五) both require an append-only, position-ordered log. The bus (`EventBus`)
 * distributes events; this port *persists* them. Keeping them separate means the
 * in-process bus can never become the system of record.
 *
 * Sprint 1 ships TYPES ONLY; the SQLite implementation lands in Sprint 3.
 */
import type { DomainEvent } from '../kernel/events.js';

export interface StoredEvent {
  /** Monotonic global position in the log (1-based), used as the replay cursor. */
  readonly globalPosition: number;
  readonly event: DomainEvent;
}

export interface EventStorePort {
  /** Append events atomically; returns their assigned positions. */
  append(events: readonly DomainEvent[]): Promise<readonly number[]>;
  /** Replay from a cursor (exclusive) — the recovery entry point. */
  readFrom(globalPosition: number, limit: number): Promise<readonly StoredEvent[]>;
  /** Last assigned position, or 0 when the log is empty. */
  lastPosition(): Promise<number>;
  /** Full history of one aggregate, in order. */
  readByAggregate(aggregateType: string, aggregateId: string): Promise<readonly StoredEvent[]>;
}
