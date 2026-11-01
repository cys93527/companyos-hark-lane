/**
 * AUDIT desktop autonomy launcher regressions.
 *   D5 — restart resume must page through every run, not only the first (oldest) 500.
 */
import { describe, expect, it } from 'vitest';

import { createDesktopAutonomyRunner } from '../src/autonomy/desktop-autonomy-runner.js';

interface Row { readonly id: string; readonly workflowId: string; readonly state: string }

const okResult = (terminal: string, stepsExecuted = 3) => ({
  ok: true,
  value: {
    terminal, terminalReason: 'r', stepsExecuted, attempts: 1, correctiveCycles: 0, userDecisionCount: 0,
    externalBlockCount: 0, durationMs: 1, doctor: [], outcome: null, progress: { phase: 'x' },
  },
});

/** A store that behaves like sqlite-run-store: created_at ASC, page clamped to 500, offset honoured. */
const pagedDatabase = (rows: readonly Row[]) => ({
  database: {
    runs: {
      list: async (q: { limit?: number; offset?: number }) => {
        const limit = Math.min(q.limit ?? 50, 500);
        const offset = q.offset ?? 0;
        return { items: rows.slice(offset, offset + limit), total: rows.length };
      },
    },
  },
});

describe('AUDIT-D5 restart resume pages through all runs', () => {
  it('non-terminal goal runs past the first 500 rows are resumed', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 1200; i += 1) {
      const live = i >= 690 && i <= 698 || i === 1199;
      rows.push({ id: `run_${i}`, workflowId: i % 2 === 0 ? 'wf-companyos-goal' : 'wf-exec', state: live ? 'EXECUTING' : 'COMPLETED' });
    }
    const runner = createDesktopAutonomyRunner({
      companyId: 'c',
      logger: null,
      driver: { run: async () => okResult('COMPLETED') } as never,
    });
    const resumed = await runner.resumeNonTerminalGoalRuns(pagedDatabase(rows) as never);
    expect([...resumed].sort()).toEqual(['run_690', 'run_692', 'run_694', 'run_696', 'run_698'].sort());
  });
});
