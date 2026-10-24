/**
 * Sprint 23 — BLOCKER PROJECTION + D1 visibility (Boss §31/§48).
 *
 * Every blocker in the matrix must point back to canonical source evidence,
 * and the D1 split must stay visible: subject-scoped proposal projection vs
 * ALL-UNRESOLVED-ANCHORS global blocking — a clean anchor NEVER clears an
 * unresolved one.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  COMPANY, cleanup, makeFixture, recordReport, seedValidation, setRunState,
  type S23Fixture,
} from './helpers/s23-fixture.js';

afterEach(cleanup);

const blockersOf = async (f: S23Fixture) => {
  const result = await f.core.runObservation!.getRunBlockers({ companyId: COMPANY, runId: f.runId });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const overviewOf = async (f: S23Fixture) => {
  const result = await f.core.runObservation!.getRunOverview({ companyId: COMPANY, runId: f.runId });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('S23 blocker matrix — each blocker cites canonical evidence', () => {
  it('unresolved actionable finding → UNRESOLVED_FINDING with the report artifact as evidence', async () => {
    const f = await makeFixture();
    const artifactId = await recordReport(f, {
      reviewTaskId: f.reviewTaskId, subjectTaskId: f.workTaskId, verdict: 'CHANGES_REQUESTED',
    });
    const blockers = await blockersOf(f);
    const blocker = blockers.find((b) => b.code === 'UNRESOLVED_FINDING');
    expect(blocker).toBeDefined();
    expect(blocker!.subjectId).toBe(f.workTaskId);
    expect(blocker!.sourceType).toBe('ReviewReport');
    expect(blocker!.sourceId).toBe(artifactId);
    expect(blocker!.evidenceRefs).toContain(`artifact:${artifactId}`);
    expect(blocker!.explanation).toContain('no corrective decision has consumed');
    // the finding is ALSO visible in the overview's unresolved list
    const overview = await overviewOf(f);
    expect(overview.unresolvedFindings).toHaveLength(1);
    expect(overview.unresolvedFindings[0]!.artifactId).toBe(artifactId);
  });

  it('validation requirements missing → VALIDATION_REQUIREMENTS_MISSING backed by the pinned version', async () => {
    const f = await makeFixture();
    const blockers = await blockersOf(f);
    const blocker = blockers.find((b) => b.code === 'VALIDATION_REQUIREMENTS_MISSING');
    expect(blocker).toBeDefined();
    expect(blocker!.sourceType).toBe('WorkflowVersion');
    expect(blocker!.evidenceRefs).toContain('validator:val.observe');
    await seedValidation(f, { validatorId: 'val.observe', status: 'pass' });
    expect((await blockersOf(f)).find((b) => b.code === 'VALIDATION_REQUIREMENTS_MISSING')).toBeUndefined();
  });

  it('validation failure → VALIDATION_FAILED citing the failing row', async () => {
    const f = await makeFixture();
    await seedValidation(f, { validatorId: 'val.observe', status: 'fail', taskId: f.qaTaskId });
    const blockers = await blockersOf(f);
    const blocker = blockers.find((b) => b.code === 'VALIDATION_FAILED');
    expect(blocker).toBeDefined();
    expect(blocker!.evidenceRefs).toContain('validation:val.observe');
  });

  it('human-required / PAUSED → RUN_PAUSED (and round exhaustion on top)', async () => {
    const f = await makeFixture();
    await setRunState(f, 'PAUSED');
    let blockers = await blockersOf(f);
    expect(blockers.find((b) => b.code === 'RUN_PAUSED')).toBeDefined();
    // round exhaustion: the canonical rework counters crossed the cap
    const run = await f.core.database.runs.get(f.runId as never);
    await f.core.database.runs.put({ ...run!, reworkCount: 4, maxRework: 3 } as never);
    blockers = await blockersOf(f);
    const exhausted = blockers.find((b) => b.code === 'ROUND_LIMIT_EXHAUSTED');
    expect(exhausted).toBeDefined();
    expect(exhausted!.explanation).toContain('exhausted');
  });

  it('execution failure → EXECUTION_FAILURE scoped to the failed task', async () => {
    const f = await makeFixture();
    const { applyTaskEvent } = await import('@companyos/core');
    const task = await f.core.database.tasks.get(f.workTaskId as never);
    const planned = applyTaskEvent(task!, 'PLAN', new Date().toISOString());
    if (!planned.ok) throw new Error(planned.error.message);
    const started = applyTaskEvent(planned.value, 'START', new Date().toISOString());
    if (!started.ok) throw new Error(started.error.message);
    const failed = applyTaskEvent(started.value, 'FAIL', new Date().toISOString());
    if (!failed.ok) throw new Error(failed.error.message);
    await f.core.database.tasks.put(failed.value);
    const blockers = await blockersOf(f);
    const blocker = blockers.find((b) => b.code === 'EXECUTION_FAILURE');
    expect(blocker).toBeDefined();
    expect(blocker!.scope).toBe('TASK');
    expect(blocker!.subjectId).toBe(f.workTaskId);
  });

  it('causal corrective wait → CAUSAL_CORRECTIVE_WAIT while the corrective is not DONE', async () => {
    const f = await makeFixture();
    const { createTask } = await import('@companyos/core');
    const corrective = await createTask({
      runId: f.runId as never, stageId: 'work' as never, roleId: 'rol.worker' as never, kind: 'task.observation-work',
      now: new Date().toISOString(), ids: f.core.ids,
      inputs: { corrective: { round: 1, parentTaskId: f.workTaskId, rootTaskId: f.workTaskId } },
    });
    if (!corrective.ok) throw new Error(corrective.error.message);
    await f.core.database.tasks.put(corrective.value);
    const reassessment = await createTask({
      runId: f.runId as never, stageId: 'review' as never, roleId: 'rol.inspector' as never, kind: 'task.observation-review',
      now: new Date().toISOString(), ids: f.core.ids,
      inputs: { 'companyos:reassessment': { correctiveTaskId: String(corrective.value.id) } },
    });
    if (!reassessment.ok) throw new Error(reassessment.error.message);
    await f.core.database.tasks.put(reassessment.value);
    const blockers = await blockersOf(f);
    const blocker = blockers.find((b) => b.code === 'CAUSAL_CORRECTIVE_WAIT');
    expect(blocker).toBeDefined();
    expect(blocker!.subjectId).toBe(String(reassessment.value.id));
    expect(blocker!.sourceId).toBe(String(corrective.value.id));
    // the reassessment is also causally explained in its own task observation
    const observation = await f.core.runObservation!.getTaskObservation({ companyId: COMPANY, taskId: String(reassessment.value.id) });
    if (!observation.ok) throw new Error(observation.error.message);
    expect(observation.value.reassessmentMarker).not.toBeNull();
    expect(observation.value.blockers.some((b) => b.code === 'CAUSAL_CORRECTIVE_WAIT')).toBe(true);
  });
});

describe('S23 D1 observability — subject scope vs all-unresolved-anchors', () => {
  it('anchor A unresolved + anchor B clean: A stays visible, B does NOT clear A', async () => {
    const f = await makeFixture();
    const { createTask } = await import('@companyos/core');
    // a SECOND review anchor (both are pinned review-stage tasks)
    const anchorB = await createTask({
      runId: f.runId as never, stageId: 'review' as never, roleId: 'rol.inspector' as never, kind: 'task.observation-review',
      now: new Date().toISOString(), ids: f.core.ids,
    });
    if (!anchorB.ok) throw new Error(anchorB.error.message);
    await f.core.database.tasks.put(anchorB.value);

    const reportA = await recordReport(f, {
      reviewTaskId: f.reviewTaskId, subjectTaskId: f.workTaskId, verdict: 'CHANGES_REQUESTED',
    });
    // the NEWER clean report (anchor B, later timestamp) must not mask anchor A
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordReport(f, { reviewTaskId: String(anchorB.value.id), subjectTaskId: f.workTaskId, verdict: 'PASS' });

    const overview = await overviewOf(f);
    expect(overview.unresolvedFindings).toHaveLength(1);
    expect(overview.unresolvedFindings[0]!.artifactId).toBe(reportA);
    const blocker = overview.blockers.find((b) => b.code === 'UNRESOLVED_FINDING');
    expect(blocker).toBeDefined();
    expect(blocker!.sourceId).toBe(reportA);
    // both anchors remain individually visible in the timeline (D1: per-anchor truth)
    const timeline = await f.core.runObservation!.getRunTimeline({ companyId: COMPANY, runId: f.runId, limit: 50 });
    if (!timeline.ok) throw new Error(timeline.error.message);
    const findingEntries = timeline.value.entries.filter((entry) => entry.kind === 'finding.reported');
    expect(findingEntries).toHaveLength(2);
    expect(findingEntries.some((entry) => entry.summary.includes('UNRESOLVED'))).toBe(true);
    expect(findingEntries.some((entry) => !entry.summary.includes('UNRESOLVED'))).toBe(true);
  });

  it('the overview exposes corrective/reassessment lineage activity for inspection', async () => {
    const f = await makeFixture();
    const { createTask } = await import('@companyos/core');
    const corrective = await createTask({
      runId: f.runId as never, stageId: 'work' as never, roleId: 'rol.worker' as never, kind: 'task.observation-work',
      now: new Date().toISOString(), ids: f.core.ids,
      inputs: { corrective: { round: 2, parentTaskId: f.workTaskId, rootTaskId: f.workTaskId, originDecisionId: 'dec_x' } },
    });
    if (!corrective.ok) throw new Error(corrective.error.message);
    await f.core.database.tasks.put(corrective.value);
    const overview = await overviewOf(f);
    expect(overview.correctiveActivity.rounds).toBe(1);
    expect(overview.correctiveActivity.correctiveTaskIds).toContain(String(corrective.value.id));
    expect(overview.correctiveActivity.latest?.round).toBe(2);
    expect(overview.correctiveActivity.latest?.parentTaskId).toBe(f.workTaskId);
    expect(overview.correctiveActivity.latest?.originDecisionId).toBe('dec_x');
  });
});
