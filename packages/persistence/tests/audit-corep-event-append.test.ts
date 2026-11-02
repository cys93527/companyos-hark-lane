/**
 * AUDIT-P7 — a multi-event append is atomic: a rejected batch leaves NO rows behind,
 * standalone (outside any unit) and nested inside an outer transaction.
 */
import { describe, expect, it } from 'vitest';

import { openDurableDatabase } from '../src/index.js';

const AT = 'Thu 2026-01-01 8:00 AM CST (UTC+08:00)';
const ev = (id: string) => ({
  eventId: id,
  type: 't',
  version: 1,
  occurredAt: AT,
  aggregateId: 'a',
  aggregateType: 'X',
  actorId: 'u',
  traceId: 'tr',
  payload: {},
});

describe('AUDIT-P7 events.append batch atomicity', () => {
  it('a batch failing on its k-th row persists none of it outside a unit (and positions are not consumed)', async () => {
    const d = openDurableDatabase({ dataDir: ':memory:', appliedAt: AT });
    try {
      await d.events.append([ev('e0')]);
      await expect(d.events.append([ev('e1'), ev('e2'), ev('e0')])).rejects.toThrow();
      expect((await d.events.all()).map((s) => s.event.eventId)).toEqual(['e0']);
      expect(d.db.writeFence.openTransactionOwner()).toBeNull();
      // The connection stays healthy and the next batch gets the next position.
      expect(await d.events.append([ev('e3'), ev('e4')])).toEqual([2, 3]);
      expect(d.db.writeFence.connectionState()).toBe('ok');
    } finally {
      d.close();
    }
  });

  it('nested in an outer transaction, a failed batch is rolled back alone and the outer unit still commits', async () => {
    const d = openDurableDatabase({ dataDir: ':memory:', appliedAt: AT });
    try {
      await d.events.append([ev('e0')]);
      const r = await d.db.writeFence.transaction(async () => {
        await d.events.append([ev('o1')]);
        await expect(d.events.append([ev('x1'), ev('e0')])).rejects.toThrow();
        return d.events.append([ev('o2')]);
      });
      expect(r.ok).toBe(true);
      expect((await d.events.all()).map((s) => s.event.eventId)).toEqual(['e0', 'o1', 'o2']);
    } finally {
      d.close();
    }
  });
});
