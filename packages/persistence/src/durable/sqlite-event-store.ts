/**
 * Durable `EventStorePort` (Sprint 3 requirement 3 / 8).
 *
 * Ordering strategy: every row gets a **monotonic `global_position`** assigned at
 * append time (`MAX(global_position) + 1`, inside the caller's transaction). It is the
 * only ordering authority — never a timestamp, never `rowid` reuse — so replay is
 * stable and a cursor (`readFrom(position)`) is exact.
 *
 * The table also stores `run_id` for the `WorkflowRun` aggregate so a per-run replay
 * is a single indexed scan (`aggregate_type, aggregate_id, global_position`).
 */
import type { DomainEvent, EventStorePort, StoredEvent } from '@companyos/core';

import type { Database } from '../db.js';

interface EventRow {
  readonly event_id: string;
  readonly type: string;
  readonly version: number | bigint;
  readonly occurred_at: string;
  readonly aggregate_id: string;
  readonly aggregate_type: string;
  readonly actor_id: string;
  readonly trace_id: string;
  readonly run_id: string | null;
  readonly org_id: string | null;
  readonly payload: string;
  readonly global_position: number | bigint;
}

const toStoredEvent = (row: EventRow): StoredEvent => ({
  globalPosition: Number(row.global_position),
  event: {
    eventId: row.event_id,
    type: row.type,
    version: Number(row.version),
    occurredAt: row.occurred_at,
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    actorId: row.actor_id,
    traceId: row.trace_id,
    payload: JSON.parse(row.payload) as unknown,
  } satisfies DomainEvent,
});

export interface SqliteEventStore extends EventStorePort {
  /** Full log in position order (audit/diagnostics; tests use it for replay checks). */
  all(): Promise<readonly StoredEvent[]>;
  /**
   * Everything that happened for one run — run-level AND task-level events — in
   * position order (Sprint 3 review LOW-2: task events carry `payload.runId`, so a
   * whole-execution audit is one indexed scan).
   */
  readByRun(runId: string): Promise<readonly StoredEvent[]>;
}

/** `run_id` is filled from the payload when the aggregate is not the run itself. */
const runIdOf = (event: DomainEvent): string | null => {
  if (event.aggregateType === 'WorkflowRun') return event.aggregateId;
  const payload = event.payload as { readonly runId?: unknown } | null | undefined;
  const fromPayload = payload?.runId;
  return typeof fromPayload === 'string' && fromPayload.length > 0 ? fromPayload : null;
};

export function createSqliteEventStore(db: Database): SqliteEventStore {
  const insert = db.prepare(
    `INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type,
       actor_id, trace_id, run_id, org_id, payload, global_position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const nextPosition = (): number => {
    const row = db.prepare('SELECT COALESCE(MAX(global_position), 0) AS max FROM events').get() as
      | { max: number | bigint }
      | undefined;
    return Number(row?.max ?? 0);
  };

  const selectRows = (
    sql: string,
    ...params: readonly (string | number | null)[]
  ): readonly EventRow[] => db.prepare(sql).all(...params) as EventRow[];

  return {
    async append(events: readonly DomainEvent[]): Promise<readonly number[]> {
      /*
       * 42ed326 re-audit (N42-T1) — an audit append is an INDEPENDENT durable mutation: it
       * waits for legal access on the connection's write fence. Inside its own unit it runs
       * in place (so an in-transaction append stays atomic with that unit); outside any unit
       * it queues, so it can never be captured by another async context's open transaction
       * and silently erased by that unit's ROLLBACK.
       */
      return db.writeFence.immediate('events.append', async () => {
        let position = nextPosition();
        const assigned: number[] = [];
        for (const event of events) {
          position += 1;
          insert.run(
            event.eventId,
            event.type,
            event.version,
            event.occurredAt,
            event.aggregateId,
            event.aggregateType,
            event.actorId,
            event.traceId,
            runIdOf(event),
            null,
            JSON.stringify(event.payload ?? null),
            position,
          );
          assigned.push(position);
        }
        return assigned;
      });
    },
    async readFrom(globalPosition: number, limit: number): Promise<readonly StoredEvent[]> {
      return selectRows(
        'SELECT * FROM events WHERE global_position > ? ORDER BY global_position ASC LIMIT ?',
        globalPosition,
        limit,
      ).map(toStoredEvent);
    },
    async lastPosition(): Promise<number> {
      return nextPosition();
    },
    async readByAggregate(aggregateType: string, aggregateId: string): Promise<readonly StoredEvent[]> {
      return selectRows(
        `SELECT * FROM events WHERE aggregate_type = ? AND aggregate_id = ?
         ORDER BY global_position ASC`,
        aggregateType,
        aggregateId,
      ).map(toStoredEvent);
    },
    async all(): Promise<readonly StoredEvent[]> {
      return selectRows('SELECT * FROM events ORDER BY global_position ASC').map(toStoredEvent);
    },
    async readByRun(runId: string): Promise<readonly StoredEvent[]> {
      return selectRows(
        'SELECT * FROM events WHERE run_id = ? ORDER BY global_position ASC',
        runId,
      ).map(toStoredEvent);
    },
  };
}
