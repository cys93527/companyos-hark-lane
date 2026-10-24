/**
 * STAGE 2 — the desktop autonomy launcher (UX-25..UX-28).
 *
 * The launcher is deliberately thin, so these tests pin its contract rather than the
 * canonical driver's loop (that is covered by the Stage 9 suites):
 *   - exactly ONE active driver per Goal run;
 *   - a terminal/approval-classified run stops the loop (the driver's own classification);
 *   - restart-time recovery re-reads DURABLE truth (never renderer memory) and resumes
 *     every non-terminal goal run exactly once;
 *   - a second start for an already-active run is refused, never duplicated.
 */
import { describe, expect, it } from 'vitest';

import { createDesktopAutonomyRunner, type DesktopAutonomyRunner } from '../src/autonomy/desktop-autonomy-runner.js';

interface FakeRunRow {
  readonly id: string;
  readonly workflowId: string;
  readonly state: string;
}

interface FakeDriverCall {
  readonly companyId: string;
  readonly runId: string;
}

const makeRunner = (options: {
  readonly terminal?: string;
  readonly failRuns?: readonly string[];
} = {}): { runner: DesktopAutonomyRunner; calls: FakeDriverCall[]; logs: Record<string, unknown>[] } => {
  const calls: FakeDriverCall[] = [];
  const logs: Record<string, unknown>[] = [];
  const logger = {
    info: (message: string, context: Record<string, unknown>) => logs.push({ level: 'info', message, ...context }),
    warn: (message: string, context: Record<string, unknown>) => logs.push({ level: 'warn', message, ...context }),
    error: (message: string, context: Record<string, unknown>) => logs.push({ level: 'error', message, ...context }),
  };
  const runner = createDesktopAutonomyRunner({
    companyId: 'company_default',
    logger: logger as never,
    driver: {
      run: async (input: { companyId: string; runId: string }) => {
        calls.push(input);
        if (options.failRuns?.includes(input.runId)) {
          return { ok: false, error: { code: 'AUTONOMY_BUDGET_EXHAUSTED', message: 'budget exhausted' } };
        }
        return {
          ok: true,
          value: {
            terminal: options.terminal ?? 'COMPLETED',
            terminalReason: 'canonical terminal state',
            stepsExecuted: 3,
            attempts: 2,
            correctiveCycles: 0,
            userDecisionCount: 0,
            externalBlockCount: 0,
            durationMs: 10,
            doctor: [],
            outcome: null,
            progress: { phase: 'completed' },
          },
        };
      },
    } as never,
  });
  return { runner, calls, logs };
};

const databaseWith = (runs: readonly FakeRunRow[]) => ({
  database: { runs: { list: async () => ({ items: runs, total: runs.length }) } },
});

describe('STAGE 2 desktop autonomy launcher (UX-25..28)', () => {
  it('UX-25 a Goal starts its driver immediately — no manual 继续 in the client', async () => {
    const { runner, calls, logs } = makeRunner();
    expect(runner.start('company_default', 'run_1')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ companyId: 'company_default', runId: 'run_1' }]);
    expect(logs.some((line) => line['message'] === 'autonomy driver started')).toBe(true);
    expect(logs.some((line) => line['message'] === 'autonomy driver finished')).toBe(true);
  });

  it('UX-25b exactly one active driver per Goal (a second start is refused, not duplicated)', async () => {
    const { runner, calls } = makeRunner({ terminal: 'AUTONOMY_BUDGET_EXHAUSTED' });
    expect(runner.start('company_default', 'run_1')).toBe(true);
    expect(runner.start('company_default', 'run_1')).toBe(false);
    expect(runner.activeRunIds()).toEqual(['run_1']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    // After the driver settles, the run is no longer active.
    expect(runner.activeRunIds()).toEqual([]);
  });

  it('UX-26 an approval-classified run stops the loop at the boundary', async () => {
    const { runner, calls, logs } = makeRunner({ terminal: 'USER_DECISION_REQUIRED' });
    runner.start('company_default', 'run_approval');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    const finished = logs.find((line) => line['message'] === 'autonomy driver finished');
    expect(finished?.['terminal']).toBe('USER_DECISION_REQUIRED');
    expect(finished?.['terminalReason']).toBe('canonical terminal state');
  });

  it('UX-27 a terminal Goal stops the autonomy loop', async () => {
    const { runner, calls, logs } = makeRunner({ terminal: 'COMPLETED' });
    runner.start('company_default', 'run_done');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    expect(logs.some((line) => line['terminal'] === 'COMPLETED')).toBe(true);
    expect(runner.activeRunIds()).toEqual([]);
  });

  it('UX-28 restart reconstructs drivers from DURABLE truth, once per run', async () => {
    const { runner, calls } = makeRunner();
    const resumed = await runner.resumeNonTerminalGoalRuns(
      databaseWith([
        { id: 'run_live', workflowId: 'wf-companyos-goal', state: 'EXECUTING' },
        { id: 'run_paused', workflowId: 'wf-companyos-goal', state: 'WAITING_APPROVAL' },
        { id: 'run_done', workflowId: 'wf-companyos-goal', state: 'COMPLETED' },
        { id: 'run_failed', workflowId: 'wf-companyos-goal', state: 'FAILED' },
        { id: 'run_other', workflowId: 'wf-design', state: 'EXECUTING' },
      ]) as never,
    );
    expect([...resumed].sort()).toEqual(['run_live', 'run_paused'].sort());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((call) => call.runId).sort()).toEqual(['run_live', 'run_paused'].sort());
    // Terminal and non-goal runs are never resumed.
    expect(calls.some((call) => call.runId === 'run_done')).toBe(false);
    expect(calls.some((call) => call.runId === 'run_failed')).toBe(false);
    expect(calls.some((call) => call.runId === 'run_other')).toBe(false);
  });

  it('a driver refusal is logged and never retried by the launcher', async () => {
    const { runner, calls, logs } = makeRunner({ failRuns: ['run_bad'] });
    expect(runner.start('company_default', 'run_bad')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    expect(logs.some((line) => line['message'] === 'autonomy driver refused' && line['code'] === 'AUTONOMY_BUDGET_EXHAUSTED')).toBe(true);
    expect(runner.activeRunIds()).toEqual([]);
  });

  it('a missing driver is a no-op start, never a crash', () => {
    const runner = createDesktopAutonomyRunner({
      companyId: 'company_default',
      driver: null as never,
      logger: null,
    });
    expect(runner.start('company_default', 'run_1')).toBe(false);
    expect(runner.activeRunIds()).toEqual([]);
  });
});
