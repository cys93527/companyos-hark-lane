// H12b — the typed cancellation terminal, end to end through the production composition.
//
// The frozen L1 machine (17 states, 规划书 §三十三) records a cancelled run as FAILED with
// the typed failureReason `cancelled` (STATE_MACHINE.md SM-L1-07). H12 found the boss-facing
// projections did not carry that type (the UI showed a cancelled Goal as FAILED / 失败 and
// compared against a non-existent `CANCELLED` run state), and that a process ending between
// the durable cancellation intent and the terminal settlement left the Goal non-terminal
// forever. These tests pin the root fix. Offline: no provider call is ever made.
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { createGoalExecutionBudget } from '@companyos/engine';

import { COMPANY, composeF5, createdDirs, openDatabases, recomposeF5Over } from '../production/helpers/f5-fixture.js';
import type { GoalSafetyConfiguration } from '../../apps/desktop/src/execution-safety-coordinator.js';

afterEach(() => {
  while (openDatabases.length) openDatabases.pop()?.close();
  while (createdDirs.length) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

const config: GoalSafetyConfiguration = {
  policyId: 'OFFLINE_TEST', maxCalls: 20, maxTokens: 1000000, maxCostMicros: 1000000, durationMs: 120000,
  boundOf: ({ modelKey }) => ({ modelKey, inputTokens: 20000, outputTokens: 16000, costMicros: 1000, evidenceRef: 'OFFLINE_ONLY', validUntilMs: Date.now() + 120000 }),
  costOf: () => 1,
};

type F = Awaited<ReturnType<typeof composeF5>>;
type Handle = (request: { operation: string; payload: Record<string, unknown> }) => Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>;
const handleOf = (core: F['core']): Handle => core.controlPlane!.handle as unknown as Handle;

const createGoal = async (f: F, commandId: string): Promise<string> => {
  const created = await handleOf(f.core)({ operation: 'goal.create', payload: { companyId: COMPANY, objective: `H12b ${commandId}`, commandId } });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return (created.value as { runId: string }).runId;
};

interface WorkspaceRead {
  planningRun: { state: string; terminalOutcome: string | null };
  cancellationRequested: boolean;
  overview: { state: string; failureReason: string | null; terminalOutcome: string | null };
  blockers: { code: string }[];
}
const workspaceOf = async (handle: Handle, runId: string): Promise<WorkspaceRead> => {
  const read = await handle({ operation: 'goal.workspace', payload: { companyId: COMPANY, runId } });
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  return read.value as WorkspaceRead;
};
const homeOf = async (handle: Handle): Promise<{ runId: string; state: string; terminalOutcome: string | null }[]> => {
  const read = await handle({ operation: 'home.summary', payload: { companyId: COMPANY } });
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  return (read.value as { goals: { runId: string; state: string; terminalOutcome: string | null }[] }).goals;
};

describe('H12b typed cancellation terminal (production composition, offline)', () => {
  it('C1 a cancelled Goal is projected as CANCELLED (not FAILED) in workspace, overview, blockers and home', async () => {
    const f = await composeF5({ executionSafety: config });
    const runId = await createGoal(f, 'c1');
    const cancelled = await handleOf(f.core)({ operation: 'goal.cancel', payload: { runId } });
    expect(cancelled.ok).toBe(true);
    await expect.poll(async () => (await f.core.database.runs.get(runId))?.failureReason).toBe('cancelled');

    const ws = await workspaceOf(handleOf(f.core), runId);
    expect(ws.planningRun).toMatchObject({ state: 'FAILED', terminalOutcome: 'CANCELLED' });
    expect(ws.overview).toMatchObject({ state: 'FAILED', failureReason: 'cancelled', terminalOutcome: 'CANCELLED' });
    expect(ws.cancellationRequested).toBe(true);
    expect(ws.blockers.map((b) => b.code)).toContain('RUN_CANCELLED');
    expect(ws.blockers.map((b) => b.code)).not.toContain('RUN_FAILED');
    const home = await homeOf(handleOf(f.core));
    expect(home.find((goal) => goal.runId === runId)).toMatchObject({ state: 'FAILED', terminalOutcome: 'CANCELLED' });
    expect(f.rawInvocations.n).toBe(0);
  });

  it('C2 a live Goal is not ended and carries no cancellation', async () => {
    const f = await composeF5({ executionSafety: config });
    const runId = await createGoal(f, 'c2');
    const ws = await workspaceOf(handleOf(f.core), runId);
    expect(ws.overview.terminalOutcome).toBeNull();
    expect(ws.planningRun.terminalOutcome).toBeNull();
    expect(ws.cancellationRequested).toBe(false);
    expect((await homeOf(handleOf(f.core))).find((goal) => goal.runId === runId)?.terminalOutcome).toBeNull();
  });

  it('C3 process ends between the durable intent and the terminal settlement: the next composition converges to FAILED/cancelled', async () => {
    const f = await composeF5({ executionSafety: config });
    const runId = await createGoal(f, 'c3');
    // Exactly what goal.cancel commits first; the engine settlement never ran (simulated exit).
    await createGoalExecutionBudget(f.core.database.executionBudget, Date.now).requestCancel(runId, `cancel:${runId}`);
    const before = await f.core.database.runs.get(runId);
    expect(before?.state).not.toBe('FAILED');
    expect(before?.failureReason).toBeNull();
    // Visible as requested-but-not-ended before convergence.
    const pending = await workspaceOf(handleOf(f.core), runId);
    expect(pending.cancellationRequested).toBe(true);
    expect(pending.overview.terminalOutcome).toBeNull();

    const reopened = await recomposeF5Over(f, config);
    const after = await reopened.database.runs.get(runId);
    expect(after).toMatchObject({ state: 'FAILED', failureReason: 'cancelled' });
    expect(after?.history.at(-1)?.event).toBe('CANCEL');
    const ws = await workspaceOf(handleOf(reopened as never), runId);
    expect(ws.overview.terminalOutcome).toBe('CANCELLED');
    expect(f.rawInvocations.n).toBe(0);

    // A further restart leaves the cancelled terminal byte-identical (never re-settled).
    const historyJson = JSON.stringify(after?.history);
    const revision = after?.revision;
    const third = await recomposeF5Over(f, config);
    const again = await third.database.runs.get(runId);
    expect(JSON.stringify(again?.history)).toBe(historyJson);
    expect(again?.revision).toBe(revision);
  });

  it('C4 convergence never rewrites a run that ended before the cancel (a FAILED run stays FAILED/its own reason)', async () => {
    const f = await composeF5({ executionSafety: config });
    const runId = await createGoal(f, 'c4');
    const run = await f.core.database.runs.get(runId);
    if (run === null) throw new Error('fixture run missing');
    await f.core.database.runs.put({ ...run, state: 'FAILED', failureReason: 'execution_failed', revision: run.revision + 1 });
    await createGoalExecutionBudget(f.core.database.executionBudget, Date.now).requestCancel(runId, `cancel:${runId}`);
    const reopened = await recomposeF5Over(f, config);
    expect(await reopened.database.runs.get(runId)).toMatchObject({ state: 'FAILED', failureReason: 'execution_failed' });
    const ws = await workspaceOf(handleOf(reopened as never), runId);
    expect(ws.overview.terminalOutcome).toBe('FAILED');
    expect(ws.cancellationRequested).toBe(true);
  });

  it('C5 the storage refuses an untyped terminal; a legacy corrupt row fails closed on read (never cast through)', async () => {
    const f = await composeF5({ executionSafety: config });
    const runId = await createGoal(f, 'c5');
    const db = f.core.database.db;
    // Migration 0009: the typed reason is enforced by the storage itself.
    expect(() => db.prepare("UPDATE runs SET state = 'FAILED', failure_reason = 'cancelled_by_magic' WHERE id = ?").run(runId)).toThrow(/RUN_FAILURE_REASON_INVALID/);
    // 0001 CHECK: there is no CANCELLED run state to write.
    expect(() => db.prepare("UPDATE runs SET state = 'CANCELLED' WHERE id = ?").run(runId)).toThrow(/CHECK constraint failed/);
    // A legacy row written before 0009 (trigger absent) is refused by the typed decode.
    db.exec('DROP TRIGGER runs_failure_reason_typed_update');
    db.prepare("UPDATE runs SET state = 'FAILED', failure_reason = 'cancelled_by_magic' WHERE id = ?").run(runId);
    await expect(f.core.database.runs.get(runId)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
  });

  it('C6 home.summary lists every Goal even past 100 runs (no silent truncation)', async () => {
    const f = await composeF5({ executionSafety: config });
    const first = await createGoal(f, 'c6-first');
    const template = await f.core.database.runs.get(first);
    if (template === null) throw new Error('fixture run missing');
    // 120 extra non-goal rows (e.g. execution runs) that would fill a single 100-row page.
    for (let i = 0; i < 120; i += 1) {
      await f.core.database.runs.put({ ...template, id: `run_h12b_filler_${String(i).padStart(3, '0')}` as never, workflowId: 'wf_h12b_filler' as never, history: [], revision: 0 });
    }
    const last = await createGoal(f, 'c6-last');
    const ids = (await homeOf(handleOf(f.core))).map((goal) => goal.runId);
    expect(ids).toContain(first);
    expect(ids).toContain(last);
  });

  it('C7 a boss read during another context\'s open transaction waits and succeeds (no spurious PERSISTENCE_FAILED)', async () => {
    const f = await composeF5({ executionSafety: config });
    const runId = await createGoal(f, 'c7');
    const db = f.core.database.db;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const tx = db.writeFence.transaction(async () => { entered(); await held; return true; });
    await inside;
    // Negative control: an unfenced raw read in this window is refused typed (this is what
    // killed the autonomy driver's snapshot read while another Goal's cancel settled).
    expect(() => db.prepare('SELECT COUNT(*) AS n FROM events').get()).toThrow(/UNCOMMITTED/);
    const reads = Promise.all([homeOf(handleOf(f.core)), workspaceOf(handleOf(f.core), runId)]);
    let settled = false;
    void reads.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false); // waiting for the transaction, not failing
    release();
    expect((await tx).ok).toBe(true);
    const [home, ws] = await reads;
    expect(home.map((goal) => goal.runId)).toContain(runId);
    expect(ws.overview.terminalOutcome).toBeNull();
  });
});
