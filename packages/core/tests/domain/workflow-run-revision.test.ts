/**
 * Sprint 2 requirement 15 (Core side) — the revision field and its optimistic
 * concurrency guard live in Core, so no adapter can bypass them.
 */
import { describe, expect, it } from 'vitest';

import {
  applyRunEvent,
  createWorkflowRun,
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

const newRun = () =>
  expectOk(
    createWorkflowRun({
      companyId: 'cmp_1' as CompanyId,
      workflowId: 'wfl_1' as WorkflowId,
      templateId: 'tpl_1' as WorkflowTemplateId,
      versionId: 'ver_1' as WorkflowVersionId,
      snapshotId: 'snp_1' as RunSnapshotId,
      startedBy: 'user_owner',
      now: nowIso(),
      ids: makeIds(),
    }),
  );

describe('WorkflowRun revision', () => {
  it('starts at 0 and bumps by exactly one per applied event', () => {
    let run = newRun();
    expect(run.revision).toBe(0);

    run = expectOk(applyRunEvent(run, 'START', { at: nowIso(1) }));
    expect(run.revision).toBe(1);
    run = expectOk(applyRunEvent(run, 'TEMPLATE_RESOLVED', { at: nowIso(2) }));
    expect(run.revision).toBe(2);
    run = expectOk(applyRunEvent(run, 'PLAN_READY', { at: nowIso(3) }));
    expect(run.revision).toBe(3);

    expect(runSummary(run)).toMatchObject({ revision: 3, transitions: 3 });
  });

  it('refuses a stale expected revision without changing anything', () => {
    const run = newRun();
    const started = expectOk(applyRunEvent(run, 'START', { at: nowIso(1) }));
    const before = JSON.stringify(started);

    const stale = applyRunEvent(started, 'TEMPLATE_RESOLVED', { at: nowIso(2), expectedRevision: 0 });
    const error = expectErr(stale);
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toMatchObject({ expectedRevision: 0, actualRevision: 1, reason: 'stale_revision' });
    expect(JSON.stringify(started)).toBe(before);
  });

  it('accepts a matching expected revision and rejects one from the future', () => {
    const run = newRun();
    expect(applyRunEvent(run, 'START', { at: nowIso(1), expectedRevision: 0 }).ok).toBe(true);
    expect(applyRunEvent(run, 'START', { at: nowIso(1), expectedRevision: 5 }).ok).toBe(false);
  });

  it('keeps the guard inert when no revision is supplied (Sprint 1 callers)', () => {
    const run = newRun();
    const applied = applyRunEvent(run, 'START', { at: nowIso(1) });
    expect(applied.ok).toBe(true);
  });

  it('bumps the revision once per replayed step', () => {
    const replayed = expectOk(
      replayRunEvents(
        newRun(),
        ['START', 'TEMPLATE_RESOLVED', 'PLAN_READY', 'ROUTE_RESOLVED'].map((event, index) => ({
          event: event as Parameters<typeof applyRunEvent>[1],
          at: nowIso(index + 1),
        })),
      ),
    );
    expect(replayed.state).toBe('EXECUTING');
    expect(replayed.revision).toBe(4);
    expect(replayed.history).toHaveLength(4);
  });

  it('does not bump the revision when an event is refused', () => {
    const run = expectOk(applyRunEvent(newRun(), 'START', { at: nowIso(1) }));
    const refused = applyRunEvent(run, 'DELIVERED', { at: nowIso(2) });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('ILLEGAL_TRANSITION');
    expect(run.revision).toBe(1);
  });

  it('exposes the revision as part of the run identity for optimistic clients', () => {
    const run = newRun();
    const asId: WorkflowRunId = run.id;
    expect(typeof asId).toBe('string');
    expect(Number.isInteger(run.revision)).toBe(true);
  });
});
