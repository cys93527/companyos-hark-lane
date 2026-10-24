/**
 * Sprint 1 Task 3: WorkflowRun — the aggregate that can only move through the L1
 * machine, with honest rework accounting, a recorded resume point and an
 * append-only history.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REWORK_LIMIT,
  applyRunEvent,
  createWorkflowRun,
  isRunFinished,
  replayRunEvents,
  runSummary,
  type CompanyId,
  type RunSnapshotId,
  type WorkflowId,
  type WorkflowRunId,
  type WorkflowTemplateId,
  type WorkflowVersionId,
} from '@companyos/core';

import { expectErr, expectOk, makeIds, nowIso } from './support.js';

const rawRun = (maxRework?: number) =>
  createWorkflowRun({
    companyId: 'cmp_1' as CompanyId,
    workflowId: 'wfl_1' as WorkflowId,
    templateId: 'tpl_1' as WorkflowTemplateId,
    versionId: 'ver_1' as WorkflowVersionId,
    snapshotId: 'snp_1' as RunSnapshotId,
    startedBy: 'user_owner',
    now: nowIso(),
    ids: makeIds(),
    ...(maxRework === undefined ? {} : { maxRework }),
  });

const newRun = (maxRework?: number) => expectOk(rawRun(maxRework));

const HAPPY_PATH = [
  'START',
  'TEMPLATE_RESOLVED',
  'PLAN_READY',
  'ROUTE_RESOLVED',
  'EXECUTION_DONE',
  'REVIEW_PASSED',
  'VALIDATION_PASSED',
  'DELIVERED',
] as const;

/** START → … → REVIEW_REDIRECT: reach REVIEWING so rework can be exercised. */
const advanceToReviewing = (run = newRun()) => {
  let current = run;
  for (const event of ['START', 'TEMPLATE_RESOLVED', 'PLAN_READY', 'ROUTE_RESOLVED', 'EXECUTION_DONE'] as const) {
    current = expectOk(applyRunEvent(current, event, { at: nowIso() }));
  }
  return current;
};

describe('WorkflowRun', () => {
  it('is born IDLE with no history, no failure and no resume point', () => {
    const run = newRun();
    expect(run.state).toBe('IDLE');
    expect(run.reworkCount).toBe(0);
    expect(run.maxRework).toBe(DEFAULT_REWORK_LIMIT);
    expect(run.failureReason).toBeNull();
    expect(run.resumePoint).toBeNull();
    expect(run.history).toEqual([]);
    expect(run.id.startsWith('run_')).toBe(true);
  });

  it('validates maxRework', () => {
    expect(expectErr(rawRun(-1)).code).toBe('INVALID_ARGUMENT');
  });

  it('walks the happy path and records every transition', () => {
    let run = newRun();
    let tick = 0;
    for (const event of HAPPY_PATH) {
      tick += 1000;
      run = expectOk(applyRunEvent(run, event, { at: nowIso(tick) }));
    }
    expect(run.state).toBe('COMPLETED');
    expect(isRunFinished(run)).toBe(true);
    expect(run.history).toHaveLength(HAPPY_PATH.length);
    expect(run.history[0]).toMatchObject({ from: 'IDLE', to: 'INITIALIZING', event: 'START' });

    const summary = runSummary(run);
    expect(summary).toMatchObject({ state: 'COMPLETED', reworkCount: 0, transitions: HAPPY_PATH.length });
  });

  it('refuses any further event once terminal', () => {
    const run = replayRunEvents(newRun(), HAPPY_PATH.map((event, index) => ({ event, at: nowIso(index) })));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(expectErr(applyRunEvent(run.value, 'START', { at: nowIso(99_000) })).code).toBe(
      'ILLEGAL_TRANSITION',
    );
  });

  it('allows exactly maxRework rounds of rework, then forces PAUSED', () => {
    // Review finding LOW-3: maxRework = 2 must mean two FULL rework rounds may
    // return to execution, and the third entry into REWORK is the one that pauses.
    let run = advanceToReviewing(newRun(2));

    for (let round = 1; round <= 2; round += 1) {
      run = expectOk(applyRunEvent(run, 'REVIEW_REJECTED', { at: nowIso() }));
      expect(run.state).toBe('REWORK');
      expect(run.reworkCount).toBe(round);
      run = expectOk(applyRunEvent(run, 'REWORK_READY', { at: nowIso() }));
      expect(run.state).toBe('EXECUTING');
      run = expectOk(applyRunEvent(run, 'EXECUTION_DONE', { at: nowIso() }));
    }

    // Third entry: the budget is spent, so the run must be paused instead.
    run = expectOk(applyRunEvent(run, 'REVIEW_REJECTED', { at: nowIso() }));
    expect(run.reworkCount).toBe(3);
    expect(expectErr(applyRunEvent(run, 'REWORK_READY', { at: nowIso() })).code).toBe('LIMIT_EXCEEDED');

    run = expectOk(applyRunEvent(run, 'REWORK_EXHAUSTED', { at: nowIso() }));
    expect(run.state).toBe('PAUSED');
  });

  it('counts a validation failure as a rework round too', () => {
    let run = advanceToReviewing();
    run = expectOk(applyRunEvent(run, 'REVIEW_PASSED', { at: nowIso() }));
    run = expectOk(applyRunEvent(run, 'VALIDATION_FAILED', { at: nowIso() }));
    expect(run.state).toBe('REWORK');
    expect(run.reworkCount).toBe(1);
  });

  it('records the resume point on pause/crash and returns to it (HIGH-2)', () => {
    let run = expectOk(applyRunEvent(newRun(), 'START', { at: nowIso(1) }));
    run = expectOk(applyRunEvent(run, 'TEMPLATE_RESOLVED', { at: nowIso(2) }));
    expect(run.state).toBe('PLANNING');

    run = expectOk(applyRunEvent(run, 'PAUSE', { at: nowIso(3) }));
    expect(run.state).toBe('PAUSED');
    expect(run.resumePoint).toBe('PLANNING');

    // A resume returns to PLANNING — it must not jump into EXECUTING and thereby
    // skip routing and the approval gate.
    run = expectOk(applyRunEvent(run, 'RESUME', { at: nowIso(4) }));
    expect(run.state).toBe('PLANNING');
    expect(run.resumePoint).toBeNull();

    // Crash during execution recovers back into execution.
    run = expectOk(applyRunEvent(run, 'PLAN_READY', { at: nowIso(5) }));
    run = expectOk(applyRunEvent(run, 'ROUTE_RESOLVED', { at: nowIso(6) }));
    run = expectOk(applyRunEvent(run, 'CRASH_DETECTED', { at: nowIso(7) }));
    expect(run.state).toBe('RECOVERING');
    expect(run.resumePoint).toBe('EXECUTING');
    run = expectOk(applyRunEvent(run, 'RECOVERED', { at: nowIso(8) }));
    expect(run.state).toBe('EXECUTING');
    expect(run.resumePoint).toBeNull();
  });

  it('cannot be paused before planning starts', () => {
    expect(expectErr(applyRunEvent(newRun(), 'PAUSE', { at: nowIso() })).code).toBe('ILLEGAL_TRANSITION');
  });

  it('records the failure reason instead of inventing new states', () => {
    const cancelled = expectOk(
      applyRunEvent(newRun(), 'CANCEL', { at: nowIso(), failureReason: 'cancelled' }),
    );
    expect(cancelled.state).toBe('FAILED');
    expect(cancelled.failureReason).toBe('cancelled');

    const started = expectOk(applyRunEvent(newRun(), 'START', { at: nowIso(1) }));
    const timedOut = expectOk(applyRunEvent(started, 'TIMEOUT', { at: nowIso(2) }));
    expect(timedOut.state).toBe('FAILED');
    expect(timedOut.failureReason).toBe('timed_out');
    expect(expectErr(applyRunEvent(newRun(), 'TIMEOUT', { at: nowIso() })).code).toBe('ILLEGAL_TRANSITION');

    expect(
      expectErr(applyRunEvent(started, 'CANCEL', { at: nowIso(3), failureReason: 'timed_out' })).code,
    ).toBe('INVALID_ARGUMENT');

    expect(
      expectErr(
        applyRunEvent(started, 'TEMPLATE_RESOLVED', { at: nowIso(4), failureReason: 'cancelled' }),
      ).code,
    ).toBe('INVALID_ARGUMENT');
  });

  it('stops replaying at the first illegal step and never mutates the input', () => {
    const run = newRun();
    const frozen = JSON.stringify(run);
    const replayed = replayRunEvents(run, [
      { event: 'START', at: nowIso(1) },
      { event: 'DELIVERED', at: nowIso(2) },
    ]);
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) expect(replayed.error.code).toBe('ILLEGAL_TRANSITION');
    expect(JSON.stringify(run)).toBe(frozen);
  });

  it('keeps run ids distinct from other aggregates', () => {
    const run = newRun();
    const asRunId: WorkflowRunId = run.id;
    expect(asRunId).toBe(run.id);
    expect(run.id).not.toBe(run.snapshotId);
  });
});
