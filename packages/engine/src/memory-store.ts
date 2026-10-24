/**
 * In-memory implementations of the Core persistence ports (Sprint 2 test doubles).
 *
 * They let the engine be exercised end-to-end today (`pnpm test`) and stand in as
 * the reference behaviour that `@companyos/persistence` must match in Sprint 3.
 * They are deterministic: no timers, no randomness, insertion-ordered.
 */
import type {
  CommandLedgerPort,
  CommandLedgerRecord,
  DomainEvent,
  EntityStore,
  EntityId,
  Page,
  PageRequest,
  StoredEvent,
  MemoryRecord,
  MemoryStorePort,
  DecisionRecord,
  DecisionStorePort,
} from '@companyos/core';

export interface ObservableEntityStore<T extends EntityId> extends EntityStore<T> {
  /** Insertion-ordered snapshot (deterministic for assertions). */
  snapshot(): readonly T[];
  /** Extra accessor used by tests only. */
  clear(): void;
}

export function createInMemoryEntityStore<T extends EntityId>(
  seed: readonly T[] = [],
): ObservableEntityStore<T> {
  const rows = new Map<string, T>();
  for (const entity of seed) rows.set(entity.id, entity);

  return {
    async get(id: string): Promise<T | null> {
      return rows.get(id) ?? null;
    },
    async put(entity: T): Promise<void> {
      rows.set(entity.id, entity);
    },
    async delete(id: string): Promise<boolean> {
      return rows.delete(id);
    },
    async list(page: PageRequest = {}): Promise<Page<T>> {
      const limit = Math.min(Math.max(page.limit ?? 50, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const items = [...rows.values()];
      const descending = page.descending === true;
      items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (descending) items.reverse();
      return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
    },
    snapshot(): readonly T[] {
      return [...rows.values()];
    },
    clear(): void {
      rows.clear();
    },
  };
}

export interface InMemoryEventStore extends EventStorePortLike {
  /** Append-only view of everything recorded (audit assertions). */
  all(): readonly StoredEvent[];
  clear(): void;
}

/** Structural copy of the Core port so this module needs no runtime import. */
interface EventStorePortLike {
  append(events: readonly DomainEvent[]): Promise<readonly number[]>;
  readFrom(globalPosition: number, limit: number): Promise<readonly StoredEvent[]>;
  lastPosition(): Promise<number>;
  readByAggregate(aggregateType: string, aggregateId: string): Promise<readonly StoredEvent[]>;
}

export function createInMemoryEventStore(): InMemoryEventStore {  const log: StoredEvent[] = [];

  return {
    async append(events: readonly DomainEvent[]): Promise<readonly number[]> {
      const positions: number[] = [];
      for (const event of events) {
        log.push({ globalPosition: log.length + 1, event });
        positions.push(log.length);
      }
      return positions;
    },
    async readFrom(globalPosition: number, limit: number): Promise<readonly StoredEvent[]> {
      return log.filter((entry) => entry.globalPosition > globalPosition).slice(0, limit);
    },
    async lastPosition(): Promise<number> {
      return log.length;
    },
    async readByAggregate(aggregateType: string, aggregateId: string): Promise<readonly StoredEvent[]> {
      return log.filter(
        (entry) => entry.event.aggregateType === aggregateType && entry.event.aggregateId === aggregateId,
      );
    },
    all(): readonly StoredEvent[] {
      return [...log];
    },
    clear(): void {
      log.length = 0;
    },
  };
}

export interface InMemoryCommandLedger extends CommandLedgerPort {
  all(): readonly CommandLedgerRecord[];
  clear(): void;
}

/**
 * In-memory command ledger — the default when no durable ledger is injected.
 *
 * Insertion-ordered, so `trim(limit)` drops the OLDEST records first and the
 * idempotency window stays explicit (the durable SQLite ledger behaves the same way).
 */
export function createInMemoryCommandLedger(): InMemoryCommandLedger {
  const rows = new Map<string, CommandLedgerRecord>();

  return {
    async get(commandId: string): Promise<CommandLedgerRecord | null> {
      return rows.get(commandId) ?? null;
    },
    async put(record: CommandLedgerRecord): Promise<void> {
      rows.set(record.commandId, record);
    },
    async count(): Promise<number> {
      return rows.size;
    },
    async trim(limit: number): Promise<number> {
      const bound = Math.max(limit, 0);
      let removed = 0;
      for (const commandId of [...rows.keys()]) {
        if (rows.size <= bound) break;
        rows.delete(commandId);
        removed += 1;
      }
      return removed;
    },
    all(): readonly CommandLedgerRecord[] {
      return [...rows.values()];
    },
    clear(): void {
      rows.clear();
    },
  };
}

export function createInMemoryMemoryStore(seed: readonly MemoryRecord[] = []): MemoryStorePort {
  const rows = new Map<string, MemoryRecord>();
  for (const r of seed) rows.set(`${r.memoryId}:${r.version}`, r);
  return {
    async create(r) { const k=`${r.memoryId}:${r.version}`; if(rows.has(k)) throw new Error('UNIQUE memory version'); rows.set(k,r); },
    async update(r) { const k=`${r.memoryId}:${r.version}`; if(!rows.has(k)) throw new Error('missing memory'); rows.set(k,r); },
    async get(id,v=null) { const xs=[...rows.values()].filter(r=>r.memoryId===id).sort((a,b)=>b.version-a.version); return v===null?(xs[0]??null):(xs.find(r=>r.version===v)??null); },
    async listVersions(id) { return [...rows.values()].filter(r=>r.memoryId===id).sort((a,b)=>b.version-a.version); },
    async listRecent(limit) { return [...rows.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,limit); },
    async listAll() { return [...rows.values()]; },
  };
}

export function createInMemoryDecisionStore(seed: readonly DecisionRecord[] = []): DecisionStorePort {
  const rows = new Map<string, DecisionRecord>();
  for (const r of seed) rows.set(`${r.decisionId}:${r.version}`, r);
  return {
    async create(r) { const k=`${r.decisionId}:${r.version}`; if(rows.has(k)) throw new Error('UNIQUE decision version'); rows.set(k,r); },
    async update(r) { const k=`${r.decisionId}:${r.version}`; if(!rows.has(k)) throw new Error('missing decision'); rows.set(k,r); },
    async get(id,v=null) { const xs=[...rows.values()].filter(r=>r.decisionId===id).sort((a,b)=>b.version-a.version); return v===null?(xs[0]??null):(xs.find(r=>r.version===v)??null); },
    async listVersions(id) { return [...rows.values()].filter(r=>r.decisionId===id).sort((a,b)=>b.version-a.version); },
    async listActive(companyId,limit=100) { return [...rows.values()].filter(r=>r.companyId===companyId&&r.status==='ACTIVE').sort((a,b)=>b.decidedAt.localeCompare(a.decidedAt)).slice(0,limit); },
    async listAll() { return [...rows.values()]; },
  };
}
