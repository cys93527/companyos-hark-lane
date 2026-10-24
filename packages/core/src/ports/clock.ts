/**
 * Port: time. Core NEVER calls `Date.now()` directly, so every lifecycle test
 * can pin the clock (see docs/ARCHITECTURE.md, hexagonal core).
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** ISO-8601 UTC timestamp derived from `now()`. */
  nowIso(): string;
}

export class SystemClock implements Clock {
  public now(): number {
    return Date.now();
  }

  public nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** Deterministic clock for tests: advances only when told to. */
export class FixedClock implements Clock {
  #current: number;

  public constructor(start: number = Date.parse('2026-01-01T00:00:00.000Z')) {
    this.#current = start;
  }

  public now(): number {
    return this.#current;
  }

  public nowIso(): string {
    return new Date(this.#current).toISOString();
  }

  public advance(ms: number): void {
    this.#current += ms;
  }

  public set(epochMs: number): void {
    this.#current = epochMs;
  }
}
