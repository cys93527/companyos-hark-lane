/**
 * Sprint 23 — RESTART RECONSTRUCTION + performance check (Boss §39/§51).
 *
 * Close the process (database), reopen the SAME SQLite files in a fresh
 * composition, and the observation must rebuild the IDENTICAL canonical
 * current-state projection — no renderer memory, no live-event memory, no
 * process-local cache. Timings are recorded for the performance report.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  COMPANY, cleanup, composeAt, makeFixture, recordReport, seedValidation, setRunState,
  type S23Fixture,
} from './helpers/s23-fixture.js';

afterEach(cleanup);

const overviewSnapshot = (overview: {
  readonly runId: string;
  readonly state: string;
  readonly revision: number;
  readonly taskCounts: Readonly<Record<string, number>>;
  readonly stages: readonly { readonly stageId: string; readonly terminalSuccessful: boolean; readonly canonicalSubject: { readonly taskId: string } | null }[];
  readonly attempts: { readonly active: number; readonly interrupted: number; readonly completed: number; readonly failed: number };
  readonly blockers: readonly { readonly code: string; readonly subjectId?: string }[];
  readonly unresolvedFindings: readonly { readonly artifactId: string }[];
  readonly progress: { readonly stagesTerminalSuccessful: number; readonly tasksDone: number };
}) => JSON.stringify(overview);

describe('S23 restart reconstruction', () => {
  it('closing and reopening SQLite rebuilds the IDENTICAL projection', async () => {
    const f = await makeFixture();
    // a rich canonical state: finding + validation + paused + a RUNNING task with an attempt
    await recordReport(f, { reviewTaskId: f.reviewTaskId, subjectTaskId: f.workTaskId, verdict: 'CHANGES_REQUESTED' });
    await seedValidation(f, { validatorId: 'val.observe', status: 'pass' });
    await setRunState(f, 'PAUSED');
    const { applyTaskEvent, createExecutionAttempt } = await import('@companyos/core');
    const task = await f.core.database.tasks.get(f.qaTaskId as never);
    const planned = applyTaskEvent(task!, 'PLAN', new Date().toISOString());
    if (!planned.ok) throw new Error(planned.error.message);
    const started = applyTaskEvent(planned.value, 'START', new Date().toISOString());
    if (!started.ok) throw new Error(started.error.message);
    await f.core.database.tasks.put(started.value);
    const made = createExecutionAttempt({
      id: f.core.ids.id('exa'), companyId: COMPANY, runId: f.runId as never, taskId: f.qaTaskId as never,
      attemptNumber: 1, roleId: 'rol.verifier', taskKind: 'task.observation-qa',
      runtimeInstanceId: 'rt_restart', now: new Date().toISOString(),
    });
    if (!made.ok) throw new Error(made.error.message);
    await f.core.database.executionAttempts.claim(made.value);

    const before = await f.core.runObservation!.getRunOverview({ companyId: COMPANY, runId: f.runId });
    if (!before.ok) throw new Error(before.error.message);
    const taskBefore = await f.core.runObservation!.getTaskObservation({ companyId: COMPANY, taskId: f.qaTaskId });
    if (!taskBefore.ok) throw new Error(taskBefore.error.message);
    const timelineBefore = await f.core.runObservation!.getRunTimeline({ companyId: COMPANY, runId: f.runId, limit: 200 });
    if (!timelineBefore.ok) throw new Error(timelineBefore.error.message);

    // close the process; reopen the SAME files in a FRESH composition
    f.close();
    const again = await composeAt(f.paths);

    const after = await again.core.runObservation!.getRunOverview({ companyId: COMPANY, runId: f.runId });
    if (!after.ok) throw new Error(after.error.message);
    /*
     * The ONE canonical difference a restart legitimately makes: the composition's
     * startup orphan conversion (Sprint21) moves the dead runtime's ACTIVE attempt to
     * INTERRUPTED — that IS the durable truth after a process death. Everything else
     * must be byte-identical.
     */
    const stripAttempt = (overview: typeof before.value) => ({
      ...overview,
      executing: overview.executing.map((entry) => ({ ...entry, attempt: 'STRIPPED' as const })),
      attempts: 'STRIPPED' as const,
    });
    expect(JSON.stringify(stripAttempt(after.value))).toBe(JSON.stringify(stripAttempt(before.value)));
    expect(after.value.attempts.interrupted).toBe(1);
    expect(after.value.attempts.active).toBe(0);
    expect(after.value.executing[0]!.attempt).toBeNull();
    expect(after.value.taskCounts['RUNNING']).toBe(before.value.taskCounts['RUNNING']);
    const taskAfter = await again.core.runObservation!.getTaskObservation({ companyId: COMPANY, taskId: f.qaTaskId });
    if (!taskAfter.ok) throw new Error(taskAfter.error.message);
    // same canonical restart conversion on the task projection: identity/number kept,
    // state honestly INTERRUPTED (never fabricated COMPLETED), settledAt still null.
    expect(taskAfter.value.executionAttempts).toHaveLength(1);
    expect(taskAfter.value.executionAttempts[0]!.attemptId).toBe(taskBefore.value.executionAttempts[0]!.attemptId);
    expect(taskAfter.value.executionAttempts[0]!.attemptNumber).toBe(taskBefore.value.executionAttempts[0]!.attemptNumber);
    expect(taskAfter.value.executionAttempts[0]!.state).toBe('INTERRUPTED');
    expect(taskAfter.value.executionAttempts[0]!.settledAt).toBeNull();
    expect(taskAfter.value.state).toBe(taskBefore.value.state);
    expect(taskAfter.value.uncertainty).toEqual(taskBefore.value.uncertainty);
    const timelineAfter = await again.core.runObservation!.getRunTimeline({ companyId: COMPANY, runId: f.runId, limit: 200 });
    if (!timelineAfter.ok) throw new Error(timelineAfter.error.message);
    expect(timelineAfter.value.entries.map((entry) => entry.key)).toEqual(
      timelineBefore.value.entries.map((entry) => entry.key),
    );
    expect(timelineAfter.value.limitation).toBe(timelineBefore.value.limitation);
  });

  it('the rebuilt projection needs NO live notification to be correct (loss = refresh)', async () => {
    const f = await makeFixture();
    await seedValidation(f, { validatorId: 'val.observe', status: 'pass' });
    f.core.runObservationNotifier.notify(f.runId); // notification LOST before anyone reads
    const first = await f.core.runObservation!.getRunOverview({ companyId: COMPANY, runId: f.runId });
    if (!first.ok) throw new Error(first.error.message);
    f.close();
    const again = await composeAt(f.paths);
    const rebuilt = await again.core.runObservation!.getRunOverview({ companyId: COMPANY, runId: f.runId });
    if (!rebuilt.ok) throw new Error(rebuilt.error.message);
    expect(overviewSnapshot(rebuilt.value)).toBe(overviewSnapshot(first.value));
    expect(rebuilt.value.validation.completed).toHaveLength(1);
  });
});

describe('S23 performance check (recorded, no hard target)', () => {
  it('records overview / task / first-timeline-page timings on a representative fixture', async () => {
    const f: S23Fixture = await makeFixture();
    await recordReport(f, { reviewTaskId: f.reviewTaskId, subjectTaskId: f.workTaskId, verdict: 'CHANGES_REQUESTED' });
    await seedValidation(f, { validatorId: 'val.observe', status: 'pass' });

    const overviewStart = performance.now();
    const overview = await f.core.runObservation!.getRunOverview({ companyId: COMPANY, runId: f.runId });
    const overviewMs = performance.now() - overviewStart;
    expect(overview.ok).toBe(true);

    const taskStart = performance.now();
    const task = await f.core.runObservation!.getTaskObservation({ companyId: COMPANY, taskId: f.reviewTaskId });
    const taskMs = performance.now() - taskStart;
    expect(task.ok).toBe(true);

    const timelineStart = performance.now();
    const timeline = await f.core.runObservation!.getRunTimeline({ companyId: COMPANY, runId: f.runId, limit: 50 });
    const timelineMs = performance.now() - timelineStart;
    expect(timeline.ok).toBe(true);

    // Recorded for the Sprint23 report (Boss §51). Loose sanity bound only — the
    // point is to detect N+1 / full-table-scan regressions, not to optimize.
    expect(overviewMs).toBeLessThan(5_000);
    expect(taskMs).toBeLessThan(2_000);
    expect(timelineMs).toBeLessThan(5_000);
    if (process.env['S23_TIMINGS'] === '1') {
      console.error(
        `S23 timings: overview=${overviewMs.toFixed(1)}ms task=${taskMs.toFixed(1)}ms timeline-first-page=${timelineMs.toFixed(1)}ms`,
      );
    }
  });
});
