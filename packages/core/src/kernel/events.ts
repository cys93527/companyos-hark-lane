/** Domain event envelope shared by every bounded context. */

export interface DomainEvent<TType extends string = string, TPayload = unknown> {
  readonly eventId: string;
  readonly type: TType;
  /** Schema version of `payload`; consumers must tolerate unknown minor versions. */
  readonly version: number;
  readonly occurredAt: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly traceId: string;
  readonly actorId: string;
  readonly payload: TPayload;
}

export interface EventEnvelopeInit<TType extends string, TPayload> {
  readonly type: TType;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly traceId: string;
  readonly actorId: string;
  readonly payload: TPayload;
  readonly version?: number;
}

export const defineEvent = <TType extends string, TPayload>(
  init: EventEnvelopeInit<TType, TPayload>,
  ids: { id(prefix?: string): string },
  now: string,
): DomainEvent<TType, TPayload> => ({
  eventId: ids.id('evt'),
  type: init.type,
  version: init.version ?? 1,
  occurredAt: now,
  aggregateId: init.aggregateId,
  aggregateType: init.aggregateType,
  traceId: init.traceId,
  actorId: init.actorId,
  payload: init.payload,
});

/** In-memory event bus used by unit tests and by the Sprint 0 desktop shell. */
export class InMemoryEventBus {
  readonly #handlers = new Map<string, Set<(event: DomainEvent) => void>>();
  readonly #wildcard = new Set<(event: DomainEvent) => void>();

  public publish(event: DomainEvent): void {
    for (const handler of this.#handlers.get(event.type) ?? []) handler(event);
    for (const handler of this.#wildcard) handler(event);
  }

  /** Returns an unsubscribe function. */
  public subscribe(type: string, handler: (event: DomainEvent) => void): () => void {
    const set = this.#handlers.get(type) ?? new Set();
    set.add(handler);
    this.#handlers.set(type, set);
    return () => {
      set.delete(handler);
    };
  }

  /** Subscribe to every event (used by the audit log and the metrics projector). */
  public subscribeAll(handler: (event: DomainEvent) => void): () => void {
    this.#wildcard.add(handler);
    return () => {
      this.#wildcard.delete(handler);
    };
  }
}
