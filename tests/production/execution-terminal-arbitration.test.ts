/**
 * F5-D — DURABLE TERMINAL TRANSITION ARBITRATION (release blocker, post-Codex).
 *
 * Codex reproduced the last-writer-wins defect: CANCELLED → late provider error →
 * FAILED, with BOTH `agent.execution_cancelled` and `agent.execution_failed` durable
 * for the same execution. Root: settlement used a STALE in-memory object and the store
 * performed an unconditional UPSERT.
 *
 * The fix (Phase 1 of the closure): every lifecycle transition — completion, failure,
 * cancellation, restart interruption — goes through ONE canonical arbiter that
 *   1. reads the CURRENT durable row (never a stale capture),
 *   2. treats an existing terminal state as authoritative (the late writer LOSES),
 *   3. lands the transition through a conditional compare-and-set write while the row
 *      is still RUNNING — one SQL statement decides the race.
 *
 * Invariants pinned here:
 *   1. CANCELLED then late FAILED      → remains CANCELLED
 *   2. FAILED    then late COMPLETED   → remains FAILED
 *   3. COMPLETED then late cancellation→ remains COMPLETED
 *   4. timeout/completion simultaneous race → one terminal winner
 *   5. restart recovery vs late result → exactly one durable winner
 *   + exactly ONE authoritative terminal event per execution, never contradictory ones.
 */
import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { normalizeExecutionError } from '@companyos/core';

import { COMPANY, composeF5, createdDirs, openDatabases, recomposeF5Over, type F5Fixture } from './helpers/f5-fixture.js';

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});

interface Seeded {
  readonly runId: string;
  readonly taskId: string;
  readonly actor: string;
}

/** One legal advance puts the execution run + work task in place; then read their ids. */
const seedRunAndTask = async (f: F5Fixture): Promise<Seeded> => {
  const created = await f.core.controlPlane!.handle({
    operation: 'goal.create',
    payload: { companyId: COMPANY, objective: 'terminal arbitration seed', commandId: `f5d-${String(Date.now())}` },
  });
  if (!created.ok) throw new Error('goal.create failed: ' + JSON.stringify(created.error));
  const goalRunId = String((created.value as { readonly runId: string }).runId);
  await f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
  const executionRun = f.core.database.db
    .prepare("SELECT id FROM runs WHERE id != ? AND company_id = 'company_default' ORDER BY created_at DESC LIMIT 1")
    .get(goalRunId) as { id: string };
  const subject = f.core.database.db
    .prepare('SELECT id FROM tasks WHERE run_id = ? ORDER BY created_at LIMIT 1')
    .get(executionRun.id) as { id: string };
  const actor = (await f.core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  return { runId: executionRun.id, taskId: subject.id, actor };
};

const prepareExecution = async (f: F5Fixture, seeded: Seeded): Promise<string> => {
  const prepared = await f.core.runtime.prepare({
    modelKey: 'f5.planner',
    explicit: true,
    scopes: [],
    agentId: 'f5-arbitration',
    roleId: 'f5-arbitration',
    taskId: seeded.taskId,
    runId: seeded.runId,
    actorId: seeded.actor,
  });
  if (!prepared.ok) throw new Error('prepare failed: ' + prepared.error.message);
  return prepared.value.executionId;
};

/** Drive the runtime's invocation in the background (the caller settles it later). */
const startInvocation = (f: F5Fixture, seeded: Seeded, executionId: string): Promise<unknown> =>
  f.core.runtime
    .runWithOutput({
      executionId,
      actorId: seeded.actor,
      context: {
        company: { id: COMPANY, label: COMPANY },
        workflow: { id: 'f5', label: 'f5' },
        workflowVersion: 'v1',
        workflowRun: { id: seeded.runId, label: 'run' },
        stage: { id: 'stage', label: 'stage' },
        task: { id: seeded.taskId, label: 'task' },
        role: { id: 'f5-arbitration', label: 'role' },
        objective: 'terminal arbitration',
        instructions: ['answer'],
        constraints: [],
        acceptanceCriteria: [],
        memoryView: [],
        decisionView: [],
        artifactRefs: [],
      },
      deferCompletion: true,
    } as never)
    .then(
      () => 'settled',
      () => 'rejected',
    )
    .catch(() => 'rejected');

const statusOf = (f: F5Fixture, executionId: string): string =>
  String(
    (
      f.core.database.db
        .prepare('SELECT status FROM agent_executions WHERE execution_id = ?')
        .get(executionId) as { status: string } | undefined
    )?.status ?? 'MISSING',
  );

const errorKindOf = (f: F5Fixture, executionId: string): string | null =>
  (f.core.database.db
    .prepare('SELECT error_kind FROM agent_executions WHERE execution_id = ?')
    .get(executionId) as { error_kind: string | null } | undefined)?.error_kind ?? null;

const terminalEventsOf = (f: F5Fixture, executionId: string): readonly string[] =>
  (
    f.core.database.db
      .prepare(
        "SELECT type FROM events WHERE aggregate_id = ? AND type IN ('agent.execution_completed','agent.execution_failed','agent.execution_cancelled','agent.execution_interrupted') ORDER BY rowid",
      )
      .all(executionId) as { type: string }[]
  ).map((row) => row.type);

const waitForStatus = async (f: F5Fixture, executionId: string, status: string, attempts = 100): Promise<void> => {
  for (let index = 0; index < attempts; index += 1) {
    if (statusOf(f, executionId) === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`execution never reached ${status} (is ${statusOf(f, executionId)})`);
};

describe('F5-D — durable terminal transition arbitration (one canonical arbiter)', () => {
  it('1. CANCELLED then late FAILED → remains CANCELLED; only ONE terminal event', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'raw:hang';
    const executionId = await prepareExecution(f, seeded);
    const pending = startInvocation(f, seeded, executionId);
    await waitForStatus(f, executionId, 'RUNNING');
    const cancelled = await f.core.runtime.cancel(executionId, seeded.actor);
    expect(cancelled.ok).toBe(true);
    expect(statusOf(f, executionId)).toBe('CANCELLED');
    // The LATE failure (the stale provider error) must lose the race.
    const late = await f.core.runtime.failExecution({
      executionId,
      actorId: seeded.actor,
      error: normalizeExecutionError({ kind: 'PROVIDER_UNAVAILABLE', message: 'late provider outage' }),
    });
    expect(late.ok).toBe(false);
    expect(statusOf(f, executionId)).toBe('CANCELLED');
    expect(errorKindOf(f, executionId)).toBe('CANCELLED');
    expect(terminalEventsOf(f, executionId)).toEqual(['agent.execution_cancelled']);
    void pending;
  }, 60_000);

  it('2. FAILED then late COMPLETED → remains FAILED; only ONE terminal event', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'raw:failFast';
    const executionId = await prepareExecution(f, seeded);
    const invocation = startInvocation(f, seeded, executionId);
    await invocation;
    await waitForStatus(f, executionId, 'FAILED');
    const late = await f.core.runtime.completeExecution({
      executionId,
      actorId: seeded.actor,
      resultRef: null,
      artifacts: [],
    });
    // F5-D: a LOST completion reports ALREADY_TERMINAL explicitly — never a write.
    expect(late.ok).toBe(false);
    expect(statusOf(f, executionId)).toBe('FAILED');
    expect(terminalEventsOf(f, executionId)).toEqual(['agent.execution_failed']);
  }, 60_000);

  it('3. COMPLETED then late cancellation → remains COMPLETED; only ONE terminal event', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'raw:ok';
    const executionId = await prepareExecution(f, seeded);
    const invocation = startInvocation(f, seeded, executionId);
    await invocation;
    await waitForStatus(f, executionId, 'RUNNING');
    const completed = await f.core.runtime.completeExecution({
      executionId,
      actorId: seeded.actor,
      resultRef: null,
      artifacts: [],
    });
    expect(completed.ok).toBe(true);
    expect(statusOf(f, executionId)).toBe('COMPLETED');
    const late = await f.core.runtime.cancel(executionId, seeded.actor);
    expect(late.ok).toBe(true);
    if (late.ok) expect(late.value.status).toBe('COMPLETED');
    expect(statusOf(f, executionId)).toBe('COMPLETED');
    expect(terminalEventsOf(f, executionId)).toEqual(['agent.execution_completed']);
  }, 60_000);

  it('4. terminal race (completion vs failure fired together) → exactly one winner, one event', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'raw:ok';
    const executionId = await prepareExecution(f, seeded);
    const invocation = startInvocation(f, seeded, executionId);
    await invocation;
    await waitForStatus(f, executionId, 'RUNNING');
    await Promise.all([
      f.core.runtime.completeExecution({ executionId, actorId: seeded.actor, resultRef: null, artifacts: [] }),
      f.core.runtime.failExecution({
        executionId,
        actorId: seeded.actor,
        error: normalizeExecutionError({ kind: 'PROVIDER_UNAVAILABLE', message: 'racing failure' }),
      }),
    ]);
    const status = statusOf(f, executionId);
    expect(['COMPLETED', 'FAILED']).toContain(status);
    const events = terminalEventsOf(f, executionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe(status === 'COMPLETED' ? 'agent.execution_completed' : 'agent.execution_failed');
  }, 60_000);

  it('5. restart recovery vs late result → exactly one durable winner (INTERRUPTED preserved)', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'raw:hang';
    const executionId = await prepareExecution(f, seeded);
    const pending = startInvocation(f, seeded, executionId);
    await waitForStatus(f, executionId, 'RUNNING');
    // The production reboot path: a fresh composition + the EXISTING recovery primitive.
    const core2 = await recomposeF5Over(f);
    const actor2 = (await core2.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
    const recovered = await core2.runtime.recoverInterrupted(actor2);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.some((row) => row.executionId === executionId && row.status === 'INTERRUPTED')).toBe(true);
    }
    // The late writer (the ORIGINAL composition's runtime) must lose the race.
    const late = await f.core.runtime.failExecution({
      executionId,
      actorId: seeded.actor,
      error: normalizeExecutionError({ kind: 'PROVIDER_UNAVAILABLE', message: 'late after restart' }),
    });
    expect(late.ok).toBe(false);
    expect(statusOf(f, executionId)).toBe('INTERRUPTED');
    expect(errorKindOf(f, executionId)).toBe('INTERRUPTED');
    expect(terminalEventsOf(f, executionId)).toEqual(['agent.execution_interrupted']);
    void pending;
  }, 60_000);

  it('CAS primitive: the store refuses the conditional write once the row is terminal', async () => {
    const f = await composeF5();
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'raw:hang';
    const executionId = await prepareExecution(f, seeded);
    const pending = startInvocation(f, seeded, executionId);
    await waitForStatus(f, executionId, 'RUNNING');
    const store = f.core.database.agentExecutions as unknown as {
      putIfStatus(entity: unknown, expected: string): Promise<boolean>;
      get(id: string): Promise<{ readonly status: string } | null>;
    };
    const row = await store.get(executionId);
    expect(row?.status).toBe('RUNNING');
    const cancelled = await f.core.runtime.cancel(executionId, seeded.actor);
    expect(cancelled.ok).toBe(true);
    // The row is CANCELLED now: a conditional write against RUNNING must be REFUSED.
    const staleWrite = await store.putIfStatus(
      { ...(await store.get(executionId)), status: 'FAILED' },
      'RUNNING',
    );
    expect(staleWrite).toBe(false);
    expect(statusOf(f, executionId)).toBe('CANCELLED');
    void pending;
  }, 60_000);
});
