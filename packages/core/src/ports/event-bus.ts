/** Port: event bus. The concrete implementation decides durability (outbox). */
import type { DomainEvent } from '../kernel/events.js';

export type EventHandler = (event: DomainEvent) => void | Promise<void>;

export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  publishAll(events: readonly DomainEvent[]): Promise<void>;
  subscribe(type: string, handler: EventHandler): () => void;
}
