/**
 * Hark lane — H4: owner -> watchdog lease transport over a fixed-size record file.
 *
 * Record (64 bytes, ASCII, space padded, newline at byte 63):
 *   "HL1 <sequence> <released 0|1> <sha256(prefix)[0..16]>"
 * The owner rewrites the record IN PLACE at offset 0 through one open handle
 * (no rename, so a concurrent reader never makes the writer fail). A reader
 * that sees a torn/invalid record retries a bounded number of times and then
 * returns null, which the watchdog treats as a STOP trigger (fail closed).
 *
 * The lease file must live in an owner-controlled directory OUTSIDE the child
 * workspace, so a child cannot forge heartbeats. Even a forged lease cannot
 * extend a run past the watchdog's independent hard deadline.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import type { OwnerLeaseWriter } from './job-lifetime.js';
import type { LeaseSnapshot } from './owner-watchdog.js';

export const LEASE_RECORD_BYTES = 64;
const DIGEST_CHARS = 16;

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, DIGEST_CHARS);

export function encodeLeaseRecord(sequence: number, released: boolean): Buffer {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('lease-sequence-refused');
  const prefix = `HL1 ${sequence} ${released ? 1 : 0}`;
  const text = `${prefix} ${digest(prefix)}`;
  if (text.length > LEASE_RECORD_BYTES - 1) throw new Error('lease-record-too-long');
  return Buffer.from(`${text.padEnd(LEASE_RECORD_BYTES - 1, ' ')}\n`, 'ascii');
}

export function decodeLeaseRecord(bytes: Buffer): LeaseSnapshot | null {
  if (bytes.length !== LEASE_RECORD_BYTES || bytes[LEASE_RECORD_BYTES - 1] !== 0x0a) return null;
  const match = /^HL1 ([1-9][0-9]{0,15}) ([01]) ([0-9a-f]{16}) *$/u.exec(bytes.toString('ascii', 0, LEASE_RECORD_BYTES - 1));
  if (!match) return null;
  const [, seq = '', rel = '', check = ''] = match;
  if (digest(`HL1 ${seq} ${rel}`) !== check) return null;
  const sequence = Number(seq);
  if (!Number.isSafeInteger(sequence)) return null;
  return { sequence, released: rel === '1' };
}

/** Owner side. Throttles disk writes; the sequence handed out stays strictly increasing. */
export function createFileLeaseWriter(path: string, options: { clock: () => number; minIntervalMs?: number }): OwnerLeaseWriter & { close(): void } {
  const fd = openSync(path, 'wx'); // must not pre-exist: a stale/forged file is refused
  const minInterval = options.minIntervalMs ?? 100;
  let last = -Infinity;
  let lastSequence = 0;
  let closed = false;
  const write = (sequence: number, released: boolean): void => {
    if (closed) throw new Error('lease-writer-closed');
    const record = encodeLeaseRecord(sequence, released);
    if (writeSync(fd, record, 0, record.length, 0) !== record.length) throw new Error('lease-short-write');
  };
  return {
    beat(sequence) {
      if (closed) throw new Error('lease-writer-closed'); // even when the write would be throttled
      if (sequence <= lastSequence) throw new Error('lease-sequence-not-increasing');
      lastSequence = sequence;
      const now = options.clock();
      if (now - last < minInterval) return;
      last = now;
      write(sequence, false);
    },
    release() {
      write(Math.max(lastSequence, 0) + 1, true);
      lastSequence += 1;
    },
    close() {
      if (!closed) { closed = true; closeSync(fd); }
    },
  };
}

/** Watchdog side. Missing file = lease not started yet (null); torn record retried, then null. */
export function readFileLease(path: string, attempts = 3): LeaseSnapshot | null {
  for (let i = 0; i < attempts; i += 1) {
    let fd: number;
    try { fd = openSync(path, 'r'); } catch { return null; }
    try {
      const buf = Buffer.alloc(LEASE_RECORD_BYTES);
      const n = readSync(fd, buf, 0, LEASE_RECORD_BYTES, 0);
      if (n === 0) return null;
      const snap = n === LEASE_RECORD_BYTES ? decodeLeaseRecord(buf) : null;
      if (snap) return snap;
    } finally {
      closeSync(fd);
    }
  }
  return null;
}
