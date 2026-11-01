/**
 * AUDIT desktop autonomy launcher regressions.
 *   D5 — restart resume must page through every run, not only the first (oldest) 500.
 *   D6 — the stall-resume guard counts CONSECUTIVE stalls without progress, not lifetime stalls.
 */
import { describe, expect, it } from 'vitest';

import { createDesktopAutonomyRunner } from '../src/autonomy/desktop-autonomy-runner.js';

interface Row { readonly id: string; readonly workflowId: string; readonly state: string }

const okResult = (terminal: string, stepsExecuted = 3, fingerprint = 'afp_0') => ({
  ok: true,
  value: {
    terminal, terminalReason: 'r', stepsExecuted, attempts: 1, correctiveCycles: 0, userDecisionCount: 0,
    externalBlockCount: 0, durationMs: 1, doctor: [], outcome: null, progress: { phase: 'x' }, fingerprint,
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Drive generations: each driver call returns the next scripted result; timers run on demand. */
const stallHarness = (script: (generation: number) => ReturnType<typeof okResult>) => {
  let generation = 0;
  const timers: (() => void)[] = [];
  const runner = createDesktopAutonomyRunner({
    companyId: 'c',
    logger: null,
    maxStallResumes: 3,
    stallResumeDelayMs: 1,
    scheduleDelay: (fn) => { timers.push(fn); },
    goalRunState: async () => 'EXECUTING',
    driver: { run: async () => { generation += 1; return script(generation); } } as never,
  });
  const pump = async (maxTimers: number): Promise<void> => {
    await flush();
    for (let fired = 0; fired < maxTimers && timers.length > 0; fired += 1) {
      timers.shift()?.();
      await flush();
    }
  };
  return { runner, generations: () => generation, pendingTimers: () => timers.length, pump };
};

describe('AUDIT-D6 stall-resume guard is consecutive', () => {
  it('a Goal that progresses between stalls keeps getting resumed past maxStallResumes', async () => {
    // Every generation progresses (40 steps) and then stalls at a NEW canonical fingerprint.
    const h = stallHarness((g) => (g <= 8 ? okResult('AUTONOMY_STALLED', 40, `afp_${String(g)}`) : okResult('COMPLETED')));
    h.runner.start('c', 'run_long');
    await h.pump(20);
    expect(h.generations()).toBe(9); // 8 progressing stalls all resumed, then terminal
    expect(h.runner.activeRunIds()).toEqual([]);
    expect(h.pendingTimers()).toBe(0);
  });

  it('stalls with NO progress (same fingerprint) are still bounded by maxStallResumes', async () => {
    const h = stallHarness(() => okResult('AUTONOMY_STALLED', 40, 'afp_same'));
    h.runner.start('c', 'run_stuck');
    await h.pump(20);
    expect(h.generations()).toBe(4); // first + 3 resumes
    expect(h.pendingTimers()).toBe(0);
  });

  it('a non-stall finish resets the streak', async () => {
    // stall x3 same fp, then a USER_DECISION boundary, then started again: 3 more resumes allowed.
    const h = stallHarness((g) => (g === 4 ? okResult('USER_DECISION_REQUIRED') : okResult('AUTONOMY_STALLED', 40, 'afp_same')));
    h.runner.start('c', 'run_mixed');
    await h.pump(20);
    expect(h.generations()).toBe(4);
    h.runner.start('c', 'run_mixed');
    await h.pump(20);
    expect(h.generations()).toBe(8); // fresh budget of 3 resumes after the boundary
  });
});
