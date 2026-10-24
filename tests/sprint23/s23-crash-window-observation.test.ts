/**
 * Sprint 23 — CRASH WINDOW observability (Boss §47): A claim-without-executor,
 * B executor-returned-without-settlement, C settled-without-carrier. Each
 * fixture seeds the EXACT durable state the crash window leaves behind and
 * asserts the observation tells the truth about it — never "exactly once".
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  COMPANY, cleanup, makeFixture, recordReport,
  type S23Fixture,
} from './helpers/s23-fixture.js';

afterEach(cleanup);

const taskObservation = async (f: S23Fixture, taskId: string) => {
  const result = await f.core.runObservation!.getTaskObservation({ companyId: COMPANY, taskId });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const overviewOf = async (f: S23Fixture) => {
  const result = await f.core.runObservation!.getRunOverview({ companyId: COMPANY, runId: f.runId });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('S23 crash window A — claim durable, executor not called', () => {
  it('observes Task RUNNING + ExecutionAttempt ACTIVE + external invocation NOT PROVEN', async () => {
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
      runtimeInstanceId: 'rt_a', now: new Date().toISOString(),
    });
    if (!made.ok) throw new Error(made.error.message);
    await f.core.database.executionAttempts.claim(made.value);

    const observation = await taskObservation(f, f.workTaskId);
    expect(observation.state).toBe('RUNNING');
    expect(observation.executionAttempts).toHaveLength(1);
    expect(observation.executionAttempts[0]!.state).toBe('ACTIVE');
    expect(observation.executionAttempts[0]!.settledAt).toBeNull();
    // honesty: nothing proves the external invocation happened — and nothing proves it did not
    expect(observation.uncertainty).not.toBeNull();
    expect(observation.uncertainty!.externalInvocationProven).toBe(false);
    expect(observation.uncertainty!.replayPossible).toBe(true);
    expect(observation.uncertainty!.note).toContain('NOT exactly-once');
    const overview = await overviewOf(f);
    expect(overview.executing).toHaveLength(1);
    expect(overview.attempts.active).toBe(1);
  });
});

describe('S23 crash window B — executor returned, settlement absent', () => {
  it('observes Task not DONE + Attempt not COMPLETED + outcome uncertain + replay possible', async () => {
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
      runtimeInstanceId: 'rt_b', now: new Date().toISOString(),
    });
    if (!made.ok) throw new Error(made.error.message);
    await f.core.database.executionAttempts.claim(made.value);
    // an agent execution DID run (provenance exists) but no canonical settlement landed
    await import('@companyos/core').then((m) => m.createExecution({
      executionId: f.core.ids.id('exc'),
      agentId: 'agent.worker',
      roleId: 'rol.worker' as never,
      taskId: f.workTaskId as never,
      runId: f.runId as never,
      binding: { modelKey: 'e2e7.supervisor', providerId: 'prov_e2e7', providerModelId: 'p1', source: 'EXPLICIT_BINDING' as const },
      attempt: 1,
      traceId: f.core.ids.id('trace'),
      now: new Date().toISOString(),
    })).then(async (made2) => {
      if (!made2.ok) throw new Error(made2.error.message);
      await f.core.database.agentExecutions.put({ ...made2.value, status: 'COMPLETED' as never });
    });

    const observation = await taskObservation(f, f.workTaskId);
    expect(observation.state).not.toBe('DONE');
    expect(observation.executionAttempts[0]!.state).toBe('ACTIVE');
    expect(observation.executionAttempts[0]!.state).not.toBe('COMPLETED');
    expect(observation.uncertainty).not.toBeNull();
    expect(observation.uncertainty!.canonicalSettlementAbsent).toBe(true);
    expect(observation.uncertainty!.replayPossible).toBe(true);
    // the provenance row is visible but NEVER claims the task settled
    expect(observation.provenance[0]!.status).toBe('COMPLETED');
    expect(observation.state).toBe('RUNNING');
    // the ONLY mention of exactly-once is its explicit NEGATION in the honesty note
    expect(observation.uncertainty!.note).toContain('NOT exactly-once');
    expect(JSON.parse(JSON.stringify(observation)).uncertainty.note).not.toMatch(/(?<!NOT )exactly-once/);
  });
});

describe('S23 crash window C — settled, carrier not reconciled', () => {
  it('observes the settlement AND the pending reconciliation; the run is not falsely terminal', async () => {
    const f = await makeFixture();
    const { applyTaskEvent } = await import('@companyos/core');
    const settle = async (taskId: string, kind: string) => {
      const row = await f.core.database.tasks.get(taskId as never);
      const planned = applyTaskEvent(row!, 'PLAN', new Date().toISOString());
      if (!planned.ok) throw new Error(planned.error.message);
      const started = applyTaskEvent(planned.value, 'START', new Date().toISOString());
      if (!started.ok) throw new Error(started.error.message);
      const done = applyTaskEvent(started.value, 'COMPLETE', new Date().toISOString());
      if (!done.ok) throw new Error(done.error.message);
      await f.core.database.tasks.put({
        ...done.value,
        outputs: { stageOutput: { schemaVersion: 'companyos/stage-output/1', kind, executionId: 'exec_c', artifactRefs: [], validationRefs: [], payload: {} } },
      } as never);
    };
    // work settles normally; the review task settles with a FINDINGS CANDIDATE whose
    // canonical report was never routed (the exact S21D-A crash shape)
    await settle(f.workTaskId, 'companyos:work-role-work');
    await settle(f.reviewTaskId, 'companyos:review-findings-candidate');

    const overview = await overviewOf(f);
    // the settlements ARE visible
    expect(overview.taskCounts['DONE']).toBe(2);
    const reviewObservation = await taskObservation(f, f.reviewTaskId);
    expect(reviewObservation.state).toBe('DONE');
    expect(reviewObservation.stageOutput?.kind).toBe('companyos:review-findings-candidate');
    // …and the pending reconciliation is a truthful blocker
    const carrier = overview.blockers.find((b) => b.code === 'UNRECONCILED_CARRIER');
    expect(carrier).toBeDefined();
    expect(carrier!.subjectId).toBe(f.reviewTaskId);
    expect(carrier!.evidenceRefs).toContain(`task:${f.reviewTaskId}`);
    // the work task (ordinary work output) is NOT flagged — its carrier is skipped by design
    expect(overview.blockers.find((b) => b.subjectId === f.workTaskId && b.code === 'UNRECONCILED_CARRIER')).toBeUndefined();

    // once the carrier reconciles (the canonical report lands), the blocker clears
    await recordReport(f, { reviewTaskId: f.reviewTaskId, subjectTaskId: f.workTaskId, verdict: 'PASS' });
    const reconciled = await overviewOf(f);
    expect(reconciled.blockers.find((b) => b.code === 'UNRECONCILED_CARRIER')).toBeUndefined();
  });
});
