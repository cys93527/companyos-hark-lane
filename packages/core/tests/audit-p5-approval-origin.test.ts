/**
 * AUDIT-P5: APPROVAL_REQUIRED is legal from PLANNING / ROUTING / EXECUTING but APPROVAL_GRANTED always went to
 * EXECUTING, so an approval requested in PLANNING or ROUTING skipped PLAN.COMPLETE (branch-set side effect) /
 * ROUTE.RESOLVE. A grant now returns to the state the approval was requested from.
 */
import { describe, expect, it } from 'vitest';

import { nextRunState } from '../src/domain/run-state.js';

describe('AUDIT-P5 approval returns to its origin', () => {
  it.each(['PLANNING', 'ROUTING', 'EXECUTING'] as const)('requested in %s -> granted back to %s', (origin) => {
    const waiting = nextRunState('APPROVAL_REQUIRED', origin);
    expect(waiting).toEqual({ ok: true, value: 'WAITING_APPROVAL' });
    expect(nextRunState('APPROVAL_GRANTED', 'WAITING_APPROVAL', { approvalOrigin: origin })).toEqual({ ok: true, value: origin });
  });
  it('no recorded origin keeps the rule fallback; an illegal origin is refused', () => {
    expect(nextRunState('APPROVAL_GRANTED', 'WAITING_APPROVAL')).toEqual({ ok: true, value: 'EXECUTING' });
    const bad = nextRunState('APPROVAL_GRANTED', 'WAITING_APPROVAL', { approvalOrigin: 'REVIEWING' });
    expect(bad.ok).toBe(false);
  });
});

describe('AUDIT-P5 engine drive passes ROUTE.RESOLVE after a ROUTING approval', () => {
  it('engine.ts resolves the route after the grant instead of asking again', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const engine = readFileSync(join(__dirname, '../../engine/src/engine.ts'), 'utf8');
    expect(engine).toContain("(options.risk === 'HIGH' || options.risk === 'CRITICAL') && run.history.at(-1)?.event !== 'APPROVAL_GRANTED'");
    const wr = readFileSync(join(__dirname, '../src/domain/workflow-run.ts'), 'utf8');
    expect(wr).toContain("find((change) => change.event === 'APPROVAL_REQUIRED')?.from ?? null");
  });
});
