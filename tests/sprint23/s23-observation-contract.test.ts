/**
 * Sprint 23 — observability CONTRACT tests (Boss §46, all 18 points).
 *
 * Every assertion reads through the production composition's RunObservationService
 * over canonical SQLite truth. No observation path may mutate workflow state.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunObservationService } from '@companyos/engine';

import {
  COMPANY, OTHER_COMPANY, VALIDATOR_ID, cleanup, makeFixture, recordReport, seedExecution, seedValidation,
  setRunState,
  type S23Fixture,
} from './helpers/s23-fixture.js';

afterEach(cleanup);

const overviewOf = async (f: S23Fixture, companyId = COMPANY) => {
  const result = await f.core.runObservation!.getRunOverview({ companyId, runId: f.runId });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('S23 contract — run overview', () => {
  it('1. uses the PINNED WorkflowVersion (a later publish never re-points a live run)', async () => {
    const f = await makeFixture();
    const run = await f.core.database.runs.get(f.runId as never);
    const overview = await overviewOf(f);
    expect(overview.versionId).toBe(String(run?.versionId));
    expect(overview.pinnedVersion.versionId).toBe(String(run?.versionId));
    expect(overview.pinnedVersion.nodeCount).toBe(3);
    expect(overview.pinnedVersion.edgeCount).toBe(2);
    // A NEWER published template/version now exists in the registry (the "latest"
    // temptation). The observation must keep reading the run's OWN pinned version —
    // the same law ARCH-004 guards at source level.
    const template2 = await f.core.lifecycle.createTemplate({ orgId: COMPANY, name: `obs2-${f.core.ids.id('t')}`, actorId: f.actor });
    if (!template2.ok) throw new Error(template2.error.message);
    const graph2 = {
      nodes: [
        { id: 'work', kind: 'work' as const, title: 'work', config: { taskProfile: { roleId: 'rol.worker', taskKind: 'task.observation-work', maxAttempts: 2 } } },
        { id: 'review', kind: 'review' as const, title: 'review', config: { taskProfile: { roleId: 'rol.inspector', taskKind: 'task.observation-review', maxAttempts: 2 } } },
        { id: 'qa', kind: 'qa' as const, title: 'qa', config: { taskProfile: { roleId: 'rol.verifier', taskKind: 'task.observation-qa', maxAttempts: 1 }, validatorIds: [VALIDATOR_ID] } },
        { id: 'extra', kind: 'work' as const, title: 'extra', config: { taskProfile: { roleId: 'rol.worker', taskKind: 'task.observation-work', maxAttempts: 1 } } },
      ],
      edges: [{ from: 'work', to: 'review' }, { from: 'review', to: 'qa' }, { from: 'qa', to: 'extra' }],
    } as never;
    const saved2 = await f.core.lifecycle.saveDraftGraph({ templateId: template2.value.id, graph: graph2, actorId: f.actor });
    if (!saved2.ok) throw new Error(saved2.error.message);
    const published2 = await f.core.lifecycle.publish({ templateId: template2.value.id, actorId: f.actor });
    if (!published2.ok) throw new Error(published2.error.message);
    const stillPinned = await overviewOf(f);
    expect(stillPinned.pinnedVersion.versionId).toBe(String(run?.versionId));
    expect(stillPinned.pinnedVersion.nodeCount).toBe(3);
  });

  it('2. Task and ExecutionAttempt remain DISTINCT projections', async () => {
    const f = await makeFixture();
    const { applyTaskEvent, createExecutionAttempt } = await import('@companyos/core');
    const task = await f.core.database.tasks.get(f.workTaskId as never);
    const planned = applyTaskEvent(task!, 'PLAN', new Date().toISOString());
    if (!planned.ok) throw new Error(planned.error.message);
    const started = applyTaskEvent(planned.value, 'START', new Date().toISOString());
    if (!started.ok) throw new Error(started.error.message);
    await f.core.database.tasks.put(started.value);
    const made = createExecutionAttempt({
      id: f.core.ids.id('exa'), companyId: COMPANY, runId: f.runId as never, taskId: f.workTaskId as never,
      attemptNumber: 1, roleId: 'rol.worker', taskKind: 'task.observation-work',
      runtimeInstanceId: 'rt_obs', now: new Date().toISOString(),
    });
    if (!made.ok) throw new Error(made.error.message);
    await f.core.database.executionAttempts.claim(made.value);

    const overview = await overviewOf(f);
    expect(overview.taskCounts['RUNNING']).toBe(1);
    expect(overview.attempts.active).toBe(1);
    expect(overview.executing).toHaveLength(1);
    expect(overview.executing[0]!.taskId).toBe(f.workTaskId);
    expect(overview.executing[0]!.attempt?.state).toBe('ACTIVE');
    // the task LIFECYCLE and the ATTEMPT lifecycle are separate fields, never one "running"
    const observation = await f.core.runObservation!.getTaskObservation({ companyId: COMPANY, taskId: f.workTaskId });
    if (!observation.ok) throw new Error(observation.error.message);
    expect(observation.value.state).toBe('RUNNING');
    expect(observation.value.executionAttempts[0]!.state).toBe('ACTIVE');
    expect(observation.value.state).not.toBe(observation.value.executionAttempts[0]!.state);
  });

  it('3. AgentExecution stays PROVENANCE-ONLY (model fields never touch task/attempt lifecycle)', async () => {
    const f = await makeFixture();
    await seedExecution(f, f.workTaskId);
    const observation = await f.core.runObservation!.getTaskObservation({ companyId: COMPANY, taskId: f.workTaskId });
    if (!observation.ok) throw new Error(observation.error.message);
    expect(observation.value.provenance).toHaveLength(1);
    expect(observation.value.provenance[0]!.modelKey).toBe('e2e7.supervisor');
    expect(observation.value.provenance[0]!.status).toBe('COMPLETED');
    // provenance is a SEPARATE array: attempts and task carry no model fields
    expect(observation.value.executionAttempts).toEqual([]);
    expect(JSON.stringify(observation.value.executionAttempts)).not.toContain('modelKey');
    expect(JSON.stringify(observation.value)).not.toMatch(/"state":"COMPLETED".*modelKey.*state/s);
  });

  it('7. a canonical reassessment REPLACES the stale stage output (subject authority)', async () => {
    const f = await makeFixture();
    const { applyTaskEvent, createTask } = await import('@companyos/core');
    const settle = async (taskId: string, output: { kind: string }) => {
      const row = await f.core.database.tasks.get(taskId as never);
      const planned = applyTaskEvent(row!, 'PLAN', new Date().toISOString());
      if (!planned.ok) throw new Error(planned.error.message);
      const started = applyTaskEvent(planned.value, 'START', new Date().toISOString());
      if (!started.ok) throw new Error(started.error.message);
      const done = applyTaskEvent(started.value, 'COMPLETE', new Date().toISOString());
      if (!done.ok) throw new Error(done.error.message);
      await f.core.database.tasks.put({
        ...done.value,
        outputs: { stageOutput: { schemaVersion: 'companyos/stage-output/1', kind: output.kind, executionId: 'exec_x', artifactRefs: [], validationRefs: [], payload: {} } },
      } as never);
    };
    await settle(f.reviewTaskId, { kind: 'companyos:work-role-work' });
    // a corrective child of the review stage becomes the canonical subject
    const corrective = await createTask({
      runId: f.runId as never, stageId: 'review' as never, roleId: 'rol.inspector' as never, kind: 'task.observation-review',
      now: new Date().toISOString(), ids: f.core.ids,
      inputs: { corrective: { round: 1, parentTaskId: f.reviewTaskId, rootTaskId: f.reviewTaskId } },
    });
    if (!corrective.ok) throw new Error(corrective.error.message);
    await f.core.database.tasks.put(corrective.value);
    await settle(String(corrective.value.id), { kind: 'companyos:review-findings-candidate' });

    const overview = await overviewOf(f);
    const reviewStage = overview.stages.find((stage) => stage.stageId === 'review')!;
    // the corrective child WINS as the stage subject — never the stale seeded task
    expect(reviewStage.canonicalSubject?.taskId).toBe(String(corrective.value.id));
    expect(reviewStage.canonicalSubject?.output?.kind).toBe('companyos:review-findings-candidate');
  });

  it('8. validatorIds DRIVE validation visibility (required vs completed vs missing)', async () => {
    const f = await makeFixture();
    const overview = await overviewOf(f);
    expect(overview.validation.requiredValidatorIds).toEqual(['val.observe']);
    expect(overview.validation.missing).toEqual(['val.observe']);
    await seedValidation(f, { validatorId: 'val.observe', status: 'pass', taskId: f.qaTaskId });
    const completed = await overviewOf(f);
    expect(completed.validation.missing).toEqual([]);
    expect(completed.validation.completed[0]!.validatorId).toBe('val.observe');
    expect(completed.validation.completed[0]!.evidenceRefs).toEqual([]);
  });

  it('9. Artifact/Evidence are REFERENCES — no content duplication', async () => {
    const f = await makeFixture();
    await recordReport(f, { reviewTaskId: f.reviewTaskId, subjectTaskId: f.workTaskId, verdict: 'PASS' });
    const overview = await overviewOf(f);
    expect(overview.artifacts.length).toBeGreaterThan(0);
    for (const artifact of overview.artifacts) {
      const keys = Object.keys(artifact);
      expect(keys).not.toContain('contentRef');
      expect(keys).not.toContain('contentHash');
      expect(keys).not.toContain('sizeBytes');
    }
    expect(overview.goal).toBeDefined();
  });

  it('10. Handoff stays the Sprint11 owner (count read, no second owner created)', async () => {
    const f = await makeFixture();
    const overview = await overviewOf(f);
    expect(overview.handoffCount).toBe(0);
    const tables = f.core.database.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%handoff%'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(['handoff_refs', 'handoffs']);
  });

  it('11. an observation FAILURE is typed and mutates NOTHING', async () => {
    const f = await makeFixture();
    const before = await f.core.database.runs.get(f.runId as never);
    const tasksBefore = await f.core.database.tasks.listByRun(f.runId);
    // a broken deps seam (pinned version unreadable) must produce a typed error
    const broken = createRunObservationService({
      actorId: 'user_owner',
      runs: f.core.database.runs,
      tasks: f.core.database.tasks,
      executionAttempts: f.core.database.executionAttempts,
      templates: { get: async () => null },
      validations: { listByRun: (runId) => f.core.database.validationStore!.listByRun(runId as never) },
      artifacts: {
        listByRun: (runId) => f.core.database.artifactStore!.listByRun(runId as never),
        getByCreationCommand: (cmd) => f.core.database.artifactStore!.getByCreationCommand(cmd) as never,
      },
      events: f.core.database.events,
      decisionHistory: {
        listRunDecisionHistory: async () => ({ ok: true as const, value: [] as never }),
      },
      reviewReports: {
        listRunReports: async () => ({ ok: true as const, value: [] }),
      },
      clock: { nowIso: () => new Date().toISOString() },
    });
    const failed = await broken.getRunOverview({ companyId: COMPANY, runId: f.runId });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(String(failed.error.details['reason'])).toBe('PINNED_VERSION_MISSING');
    const after = await f.core.database.runs.get(f.runId as never);
    expect(after?.state).toBe(before?.state);
    expect(after?.revision).toBe(before?.revision);
    expect(await f.core.database.tasks.listByRun(f.runId)).toEqual(tasksBefore);
  });

  it('12+13. cross-run and cross-company lookups FAIL CLOSED', async () => {
    const f = await makeFixture();
    const crossCompany = await f.core.runObservation!.getRunOverview({ companyId: OTHER_COMPANY, runId: f.runId });
    expect(crossCompany.ok).toBe(false);
    if (!crossCompany.ok) expect(crossCompany.error.code).toBe('NOT_FOUND');
    const taskCross = await f.core.runObservation!.getTaskObservation({ companyId: OTHER_COMPANY, taskId: f.workTaskId });
    expect(taskCross.ok).toBe(false);
    const timelineCross = await f.core.runObservation!.getRunTimeline({ companyId: OTHER_COMPANY, runId: f.runId });
    expect(timelineCross.ok).toBe(false);
    const blockersCross = await f.core.runObservation!.getRunBlockers({ companyId: OTHER_COMPANY, runId: f.runId });
    expect(blockersCross.ok).toBe(false);
  });

  it('14. timeline pagination is deterministic and walks every entry exactly once', async () => {
    const f = await makeFixture();
    await recordReport(f, { reviewTaskId: f.reviewTaskId, subjectTaskId: f.workTaskId, verdict: 'PASS' });
    await seedValidation(f, { validatorId: 'val.observe', status: 'pass' });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await f.core.runObservation!.getRunTimeline({ companyId: COMPANY, runId: f.runId, limit: 3, cursor });
      if (!result.ok) throw new Error(result.error.message);
      seen.push(...result.value.entries.map((entry) => entry.key));
      expect(new Set(seen).size).toBe(seen.length); // never a duplicate across pages
      expect(result.value.entries.every((entry) => entry.key.length > 0)).toBe(true);
      expect(result.value.entries.every((entry) => entry.source.owner.length > 0)).toBe(true);
      if (!result.value.hasMore) {
        expect(result.value.nextCursor).toBeNull();
        cursor = undefined;
        break;
      }
      cursor = result.value.nextCursor ?? undefined;
    }
    expect(seen.length).toBeGreaterThanOrEqual(4); // task creations + finding + validation at least
    // the SAME paging walk twice yields the IDENTICAL order (deterministic)
    const again: string[] = [];
    let cursor2: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await f.core.runObservation!.getRunTimeline({ companyId: COMPANY, runId: f.runId, limit: 3, cursor: cursor2 });
      if (!result.ok) throw new Error(result.error.message);
      again.push(...result.value.entries.map((entry) => entry.key));
      if (!result.value.hasMore) break;
      cursor2 = result.value.nextCursor ?? undefined;
    }
    expect(again).toEqual(seen);
  });

  it('15. a LOST live notification is recoverable by refresh (non-authoritative signal)', async () => {
    const f = await makeFixture();
    let fired = 0;
    const unsubscribe = f.core.runObservationNotifier.subscribe(f.runId, () => { fired += 1; });
    // canonical change happens WITHOUT any notification (the "lost" case)
    await seedValidation(f, { validatorId: 'val.observe', status: 'pass' });
    expect(fired).toBe(0);
    const refreshed = await overviewOf(f);
    expect(refreshed.validation.completed).toHaveLength(1); // re-reading SQLite recovers
    // and the notification, when it DOES fire, carries no truth — just the signal
    f.core.runObservationNotifier.notify(f.runId);
    expect(fired).toBe(1);
    unsubscribe();
    f.core.runObservationNotifier.notify(f.runId);
    expect(fired).toBe(1);
  });

  it('16. NO renderer-local truth: the projection rebuilds from SQLite alone', async () => {
    const f = await makeFixture();
    await recordReport(f, { reviewTaskId: f.reviewTaskId, subjectTaskId: f.workTaskId, verdict: 'CHANGES_REQUESTED' });
    const first = await overviewOf(f);
    // a SECOND service instance over the SAME database (no shared memory) agrees
    const second = createRunObservationService({
      actorId: 'user_owner',
      runs: f.core.database.runs,
      tasks: f.core.database.tasks,
      executionAttempts: f.core.database.executionAttempts,
      templates: f.core.database.templates,
      validations: { listByRun: (runId) => f.core.database.validationStore!.listByRun(runId as never) },
      artifacts: {
        listByRun: (runId) => f.core.database.artifactStore!.listByRun(runId as never),
        getByCreationCommand: (cmd) => f.core.database.artifactStore!.getByCreationCommand(cmd) as never,
      },
      events: f.core.database.events,
      decisionHistory: {
        listRunDecisionHistory: (input) =>
          f.core.supervisorDecisionSink!.listRunDecisionHistory(input) as never,
      },
      reviewReports: {
        listRunReports: async () => ({ ok: true as const, value: [] }),
      },
      clock: { nowIso: () => new Date().toISOString() },
    });
    const rebuilt = await second.getRunOverview({ companyId: COMPANY, runId: f.runId });
    if (!rebuilt.ok) throw new Error(rebuilt.error.message);
    expect(rebuilt.value.runId).toBe(first.runId);
    expect(rebuilt.value.taskCounts).toEqual(first.taskCounts);
    expect(rebuilt.value.stages).toEqual(first.stages);
    expect(rebuilt.value.attempts).toEqual(first.attempts);
    expect(rebuilt.value.progress).toEqual(first.progress);
    expect(rebuilt.value.pinnedVersion).toEqual(first.pinnedVersion);
  });

  it('17. NO second observation table exists in any migration', () => {
    const migrationsRoot = fileURLToPath(new URL('../../packages/persistence/migrations', import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
      );
    const sqlFiles = walk(migrationsRoot).filter((file) => file.endsWith('.sql'));
    expect(sqlFiles.length).toBeGreaterThan(10);
    for (const file of sqlFiles) {
      const sql = readFileSync(file, 'utf8');
      expect(sql).not.toMatch(/CREATE TABLE[^;]*(observation|dashboard|ui_run|runtime_projection)/i);
    }
  });

  it('18. NO second event store: the timeline reads the EXISTING events feed only', async () => {
    const f = await makeFixture();
    const eventsBefore = (await f.core.database.events.readByRun(f.runId)).length;
    const page = await f.core.runObservation!.getRunTimeline({ companyId: COMPANY, runId: f.runId });
    if (!page.ok) throw new Error(page.error.message);
    const eventsAfter = (await f.core.database.events.readByRun(f.runId)).length;
    expect(eventsAfter).toBe(eventsBefore); // reading the timeline appended nothing
    const tables = f.core.database.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%event%'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(['events']);
  });
});

describe('S23 contract — pause/failure reason and discrete progress', () => {
  it('exposes canonical pause reason and DISCRETE progress (no invented percentage)', async () => {
    const f = await makeFixture();
    await setRunState(f, 'PAUSED');
    const overview = await overviewOf(f);
    expect(overview.state).toBe('PAUSED');
    expect(overview.blockers.some((b) => b.code === 'RUN_PAUSED')).toBe(true);
    expect(overview.progress.stagesTotal).toBe(3);
    expect(overview.progress.stagesTerminalSuccessful).toBe(0);
    expect(overview.progress.tasksTotal).toBe(3);
    const keys = Object.keys(overview.progress);
    expect(keys).not.toContain('percent');
    expect(keys).not.toContain('percentage');
  });
});
