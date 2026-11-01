/**
 * AUDIT-P9 — closing the connection while an async transaction is mid-await reports
 * CONNECTION_CLOSED (never the retryable CONNECTION_STATE_UNCERTAIN), `closed` stays sticky,
 * and close() is idempotent.
 */
import { describe, expect, it } from 'vitest';

import { openDurableDatabase } from '../src/index.js';

const AT = 'Thu 2026-01-01 8:00 AM CST (UTC+08:00)';

const reasonOf = (error: unknown): unknown =>
  (error as { details?: { reason?: unknown } } | undefined)?.details?.reason;

describe('AUDIT-P9 close during an in-flight transaction', () => {
  it('the in-flight unit and every later refusal carry CONNECTION_CLOSED; the state stays closed', async () => {
    const d = openDurableDatabase({ dataDir: ':memory:', appliedAt: AT });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = d.db.writeFence.transaction(async () => {
      await gate;
      return 'done';
    });
    // Let the unit BEGIN and park on its await.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(d.db.writeFence.openTransactionOwner()).not.toBeNull();

    d.close();
    release();
    const result = await inFlight;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(reasonOf(result.error)).toBe('CONNECTION_CLOSED');
    expect(d.db.writeFence.connectionState()).toBe('closed');
    expect(d.db.writeFence.openTransactionOwner()).toBeNull();

    const later = await d.db.writeFence.transaction(async () => 'x');
    expect(later.ok).toBe(false);
    if (!later.ok) expect(reasonOf(later.error)).toBe('CONNECTION_CLOSED');
  });

  it('close() is idempotent', () => {
    const d = openDurableDatabase({ dataDir: ':memory:', appliedAt: AT });
    d.close();
    expect(() => d.close()).not.toThrow();
    expect(() => d.db.close()).not.toThrow();
    expect(d.db.writeFence.connectionState()).toBe('closed');
  });
});
