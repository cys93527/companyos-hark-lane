/**
 * Dependency-free ULID implementation (48-bit timestamp + 80-bit randomness,
 * Crockford base32, lexicographically sortable, monotonic inside one millisecond).
 *
 * Kept in Core on purpose: Core has no runtime dependencies, so a ULID library is
 * not an option (ADR-0005).
 */
import { randomBytes } from 'node:crypto';

import type { Clock } from '../ports/clock.js';
import type { IdFactory } from '../ports/id-factory.js';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const ULID_LENGTH = TIME_LENGTH + RANDOM_LENGTH;
const MAX_TIME = 2 ** 48 - 1;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(timestamp: number, length: number): string {
  let time = timestamp;
  let out = '';
  for (let i = length - 1; i >= 0; i -= 1) {
    const mod = time % 32;
    out = ENCODING[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) {
    out += ENCODING[byte % 32];
  }
  return out;
}

/** Monotonic ULID generator: ids within the same millisecond always increase. */
export class UlidFactory implements IdFactory {
  readonly #clock: Clock;
  #lastTime = -1;
  #lastRandom: number[] = [];

  public constructor(clock: Clock) {
    this.#clock = clock;
  }

  public ulid(): string {
    const now = this.#clock.now();
    let timeChars: string;
    let randomChars: string;

    if (now === this.#lastTime) {
      // increment the previous randomness (base32, big-endian)
      const next = [...this.#lastRandom];
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const current = next[i] ?? 0;
        if (current < 31) {
          next[i] = current + 1;
          break;
        }
        next[i] = 0;
      }
      this.#lastRandom = next;
      randomChars = next.map((value) => ENCODING[value]).join('');
      timeChars = encodeTime(now, TIME_LENGTH);
    } else {
      timeChars = encodeTime(Math.min(now, MAX_TIME), TIME_LENGTH);
      randomChars = encodeRandom(RANDOM_LENGTH);
      this.#lastRandom = [...randomChars].map((char) => ENCODING.indexOf(char));
    }

    this.#lastTime = now;
    return timeChars + randomChars;
  }

  public id(prefix?: string): string {
    const value = this.ulid();
    return prefix === undefined ? value : `${prefix}_${value}`;
  }
}

/** Deterministic factory for tests: a counter rendered as ULID-shaped ids. */
export class SequenceIdFactory implements IdFactory {
  #counter = 0;

  public constructor(private readonly prefix = '0000000000') {}

  public ulid(): string {
    this.#counter += 1;
    return (this.prefix + encodeTime(this.#counter, 10) + '0'.repeat(RANDOM_LENGTH)).slice(
      0,
      ULID_LENGTH,
    );
  }

  public id(prefix?: string): string {
    const value = this.ulid();
    return prefix === undefined ? value : `${prefix}_${value}`;
  }
}

export const isUlid = (value: string): boolean => ULID_PATTERN.test(value);

export const ULID_LENGTH_CONST = ULID_LENGTH;
