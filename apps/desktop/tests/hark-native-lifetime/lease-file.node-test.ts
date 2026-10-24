/** Hark lane H4 — owner->watchdog file lease transport (offline, real fs). */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createFileLeaseWriter, decodeLeaseRecord, encodeLeaseRecord, LEASE_RECORD_BYTES, readFileLease } from '../../src/executor/native-lifetime/lease-file.js';

const dir = mkdtempSync(join(tmpdir(), 'hark-h4-lease-'));

describe('H4 lease file transport', () => {
  it('fixed 64-byte record round-trips sequence and release', () => {
    const rec = encodeLeaseRecord(42, false);
    assert.equal(rec.length, LEASE_RECORD_BYTES);
    assert.deepEqual(decodeLeaseRecord(rec), { sequence: 42, released: false });
    assert.deepEqual(decodeLeaseRecord(encodeLeaseRecord(43, true)), { sequence: 43, released: true });
  });
  it('tampered, torn or malformed records decode to null (fail closed), never to a heartbeat', () => {
    const rec = encodeLeaseRecord(42, false);
    const forged = Buffer.from(rec); forged.write('9', 4, 'ascii'); // sequence changed, checksum not
    assert.equal(decodeLeaseRecord(forged), null);
    assert.equal(decodeLeaseRecord(rec.subarray(0, 40)), null);
    assert.equal(decodeLeaseRecord(Buffer.alloc(LEASE_RECORD_BYTES, 0x20)), null);
    assert.throws(() => encodeLeaseRecord(0, false), /lease-sequence-refused/u);
  });
  it('writer refuses a pre-existing (stale or forged) lease file', () => {
    const p = join(dir, 'pre.rec');
    writeFileSync(p, encodeLeaseRecord(999, false));
    assert.throws(() => createFileLeaseWriter(p, { clock: () => 0 }));
  });
  it('writer: strictly increasing sequence, throttled writes, release visible to the reader', () => {
    const p = join(dir, 'lease.rec');
    let now = 0;
    const w = createFileLeaseWriter(p, { clock: () => now, minIntervalMs: 100 });
    assert.equal(readFileLease(p), null, 'not started yet');
    w.beat(1);
    assert.deepEqual(readFileLease(p), { sequence: 1, released: false });
    now = 50; w.beat(2);
    assert.deepEqual(readFileLease(p), { sequence: 1, released: false }, 'throttled');
    now = 150; w.beat(3);
    assert.deepEqual(readFileLease(p), { sequence: 3, released: false });
    assert.throws(() => w.beat(3), /lease-sequence-not-increasing/u);
    w.release();
    assert.deepEqual(readFileLease(p), { sequence: 4, released: true });
    w.close();
    assert.throws(() => w.beat(9), /lease-writer-closed/u);
  });
  it('a missing lease file reads as not-started (null)', () => {
    assert.equal(readFileLease(join(dir, 'absent.rec')), null);
  });
});
