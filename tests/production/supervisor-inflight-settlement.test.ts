import '../support/offline-validator-snapshot.js';
/**
 * F5 — SUPERVISOR_INFLIGHT_BOUNDED_SETTLEMENT / AUTONOMY_SINGLE_FLIGHT (release blocker).
 *
 * Root cause proven from the production E2E durable rows: a supervisor Decision the
 * authority REFUSED (e.g. an unresolvable evidence citation) returned from the turn
 * WITHOUT settling the deferred execution. The replay lookup then missed (no Decision
 * was recorded), so every autonomy step re-ran the same logical turn as a NEW
 * execution — one dangling RUNNING supervisor round per ~2.5s until the driver's step
 * budget died; only a restart (recovery → INTERRUPTED) cleaned them up. The provider
 * calls themselves had SUCCEEDED (agent.provider_invoked durable) — the leak was the
 * turn's missing settlement ownership, not the network.
 *
 * This suite pins the generic runtime invariants (deterministic provider fixtures only):
 *
 *   F5-01  a supervisor provider promise that never resolves → the deadline settles the
 *          canonical execution terminally; RUNNING = 0
 *   F5-02  while a supervisor execution is in flight, a repeated autonomy step starts
 *          NO overlapping equivalent round (single-flight; durable intervals disjoint)
 *   F5-03  a provider that ignores cancellation and resolves late cannot create a
 *          Decision or advance any lifecycle state
 *   F5-04  cancellation before the deadline → exactly one deterministic settlement
 *   F5-05  timeout vs provider completion race → exactly one winner, no stale RUNNING
 *   F5-06  restart during an in-flight supervisor call → the EXISTING recovery model
 *          settles INTERRUPTED; the resumed run does not duplicate the round
 *   F5-07  a healthy supervisor call still works (the corrective path stays legal)
 *   F5-09  a slow-but-within-deadline provider call completes normally
 *   F5-10  repeated driver ticks during a slow call → still one logical round
 *   INCIDENT  the authority-refused Decision (the production burst): every refused turn
 *          now settles durably (typed INVALID_OUTPUT + the sink's reason) and the
 *          durable illegal-proposal budget bounds the retries with the typed terminal
 *   (F5-08 — the full F1 corrective flow — remains covered green by
 *   tests/production/corrective-software-validation.test.ts.)
 */
import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { createStartupRecoveryOrchestrator } from '@companyos/engine';

import {
  COMPANY,
  composeF5,
  createdDirs,
  openDatabases,
  recomposeF5Over,
  type Core,
} from './helpers/f5-fixture.js';

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const goalStateOf = (core: Core, runId: string): string =>
  String((core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string } | undefined)?.state ?? 'MISSING');

const supervisorExecutionsOf = (core: Core) =>
  core.database.db
    .prepare("SELECT execution_id, agent_id, status, error_kind, started_at, finished_at, updated_at, substr(error_message,1,200) AS msg FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY started_at, rowid")
    .all() as {
    execution_id: string;
    status: string;
    error_kind: string | null;
    started_at: string | null;
    finished_at: string | null;
    updated_at: string;
    msg: string | null;
  }[];

/** Max count of SIMULTANEOUSLY RUNNING supervisor executions (the single-flight invariant). */
const maxConcurrentRunning = (rows: ReturnType<typeof supervisorExecutionsOf>): number => {
  const events: { at: number; delta: number }[] = [];
  for (const row of rows) {
    if (row.started_at === null) continue;
    events.push({ at: Date.parse(row.started_at), delta: 1 });
    const end = row.finished_at ?? row.updated_at;
    events.push({ at: Date.parse(end), delta: -1 });
  }
  events.sort((left, right) => left.at - right.at || right.delta - left.delta);
  let current = 0;
  let max = 0;
  for (const event of events) {
    current += event.delta;
    if (current > max) max = current;
  }
  return max;
};

const driveToTerminal = async (core: Core, goalRunId: string, maxAdvances = 60): Promise<string> => {
  const cp = core.controlPlane!;
  for (let index = 0; index < maxAdvances; index += 1) {
    const state = goalStateOf(core, goalRunId);
    if (state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED') return state;
    await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
  }
  return goalStateOf(core, goalRunId);
};

const createGoal = async (core: Core, commandId: string): Promise<string> => {
  const created = await core.controlPlane!.handle({
    operation: 'goal.create',
    payload: { companyId: COMPANY, objective: '修复 multiply 使 multiply(4,3) 返回 12 并独立验证。', commandId },
  });
  if (!created.ok) throw new Error('goal.create failed: ' + JSON.stringify(created.error));
  return String((created.value as { readonly runId: string }).runId);
};

/** The deadline/cancellation settlement is typed and honest: the run-level deadline
 * aborts the caller first (the turn's existing cancel → CANCELLED), and when the turn's
 * own settler wins the race it is FAILED/TIMEOUT. Both leave RUNNING. */
const isBoundedDeadlineSettlement = (row: { status: string; error_kind: string | null }): boolean =>
  row.status === 'CANCELLED' || row.error_kind === 'CANCELLED' || row.error_kind === 'TIMEOUT';

describe('F5 — supervisor inflight bounded settlement / autonomy single-flight', () => {
  it('F5-01 a never-resolving provider promise: the deadline settles the canonical execution terminally (RUNNING = 0)', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 1200 });
    f.mode.value = 'hang';
    const goalRunId = await createGoal(f.core, 'f5-01');
    const t0 = Date.now();
    await f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    const elapsed = Date.now() - t0;
    // The advance returned BOUNDED (the deadline arbitrated; nothing hangs on the provider).
    expect(elapsed).toBeLessThan(15_000);
    const rows = supervisorExecutionsOf(f.core);
    expect(rows.length).toBe(1);
    expect(isBoundedDeadlineSettlement(rows[0]!)).toBe(true);
    expect(rows.every((row) => row.status !== 'RUNNING')).toBe(true);
    // No fake truth: no Decision, no lifecycle advance.
    const decisions = f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
    expect(Number(decisions.n)).toBe(0);
    expect(goalStateOf(f.core, goalRunId)).not.toBe('COMPLETED');
  }, 60_000);

  it('F5-02/F5-10 repeated autonomy steps during an in-flight round start NO overlapping equivalent round', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 2500 });
    f.mode.value = 'hang';
    const goalRunId = await createGoal(f.core, 'f5-02');
    const cp = f.core.controlPlane!;
    const first = cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    await new Promise((resolve) => setTimeout(resolve, 600)); // the first round is IN FLIGHT now
    const during = supervisorExecutionsOf(f.core);
    expect(during.length).toBe(1); // exactly one logical round while in flight
    expect(during[0]!.status).toBe('RUNNING');
    expect(f.supervisorInvocations.length).toBe(1); // and exactly one provider invocation
    const second = cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    await Promise.all([first, second]);
    const rows = supervisorExecutionsOf(f.core);
    // SINGLE-FLIGHT: the rounds never overlapped (the second step observed the first to
    // settlement before its own turn prepared anything).
    expect(maxConcurrentRunning(rows)).toBe(1);
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]!;
      const current = rows[index]!;
      expect(Date.parse(current.started_at ?? '')).toBeGreaterThanOrEqual(Date.parse(previous.finished_at ?? previous.updated_at));
    }
    expect(f.supervisorInvocations.length).toBe(rows.length); // no orphan provider starts
    expect(rows.every((row) => row.status !== 'RUNNING')).toBe(true);
  }, 60_000);

  it('F5-03 a provider that ignores cancellation and resolves late cannot create a Decision or advance anything', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 800 });
    f.mode.value = 'late';
    f.mode.delayMs = 4000;
    const goalRunId = await createGoal(f.core, 'f5-03');
    await f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    const rows = supervisorExecutionsOf(f.core);
    expect(rows.length).toBe(1);
    expect(isBoundedDeadlineSettlement(rows[0]!)).toBe(true);
    const stateBefore = goalStateOf(f.core, goalRunId);
    // The provider resolves LATE (well past the deadline): nothing may be written.
    await new Promise((resolve) => setTimeout(resolve, 4500));
    const decisions = f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
    expect(Number(decisions.n)).toBe(0);
    const rowsAfter = supervisorExecutionsOf(f.core);
    expect(rowsAfter.length).toBe(1);
    expect(isBoundedDeadlineSettlement(rowsAfter[0]!)).toBe(true);
    expect(goalStateOf(f.core, goalRunId)).toBe(stateBefore);
  }, 60_000);

  it('F5-04 cancellation before the deadline: exactly one deterministic settlement', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 20_000, maxSupervisorTurns: 1 });
    const goalRunId = await createGoal(f.core, 'f5-04');
    // One legal advance puts the execution run + work task in place.
    await f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    const executionRun = f.core.database.db
      .prepare("SELECT id FROM runs WHERE id != ? AND company_id = 'company_default' ORDER BY created_at DESC LIMIT 1")
      .get(goalRunId) as { id: string };
    const subject = f.core.database.db
      .prepare('SELECT id FROM tasks WHERE run_id = ? ORDER BY created_at LIMIT 1')
      .get(executionRun.id) as { id: string };
    f.mode.value = 'late';
    f.mode.delayMs = 5000;
    const controller = new AbortController();
    const run = f.core.autonomousSupervisor!.run({
      companyId: COMPANY,
      runId: executionRun.id,
      taskId: subject.id,
      actorId: 'user_owner',
      runIdentity: `f5-probe:${executionRun.id}`,
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 500)); // the round is in flight
    controller.abort(new Error('operator cancelled'));
    const result = await run;
    expect(result.ok).toBe(true);
    const rows = supervisorExecutionsOf(f.core);
    // Row 1: the legal first advance (COMPLETED). Row 2: the direct call's round,
    // cancelled before its deadline — exactly one deterministic settlement.
    expect(rows.length).toBe(2);
    expect(rows[0]!.status).toBe('COMPLETED');
    expect(isBoundedDeadlineSettlement(rows[1]!)).toBe(true);
    expect(Number((f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n)).toBe(1);
    // The late provider result must not double-settle or write anything.
    await new Promise((resolve) => setTimeout(resolve, 5500));
    const rowsAfter = supervisorExecutionsOf(f.core);
    expect(rowsAfter.length).toBe(2);
    expect(rowsAfter[0]!.status).toBe('COMPLETED');
    expect(isBoundedDeadlineSettlement(rowsAfter[1]!)).toBe(true);
  }, 60_000);

  it('F5-05 timeout vs provider completion race: exactly one winner, no duplicate, no stale RUNNING', async () => {
    // (a) the provider completes BEFORE the deadline → the decision wins.
    const fast = await composeF5({ supervisorTimeoutMs: 2000, maxSupervisorTurns: 1 });
    {
      const goalRunId = await createGoal(fast.core, 'f5-05a');
      fast.mode.value = 'late';
      fast.mode.delayMs = 600;
      await fast.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
      const rows = supervisorExecutionsOf(fast.core);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe('COMPLETED');
      const decisions = fast.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
      expect(Number(decisions.n)).toBe(1);
    }
    // (b) the deadline fires FIRST → the late completion is dropped.
    const slow = await composeF5({ supervisorTimeoutMs: 700, maxSupervisorTurns: 1 });
    const goalRunId = await createGoal(slow.core, 'f5-05b');
    slow.mode.value = 'late';
    slow.mode.delayMs = 2000;
    await slow.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    const rows = supervisorExecutionsOf(slow.core);
    expect(rows.length).toBe(1);
    expect(isBoundedDeadlineSettlement(rows[0]!)).toBe(true);
    expect(Number((slow.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 2200)); // the late result lands
    expect(isBoundedDeadlineSettlement(supervisorExecutionsOf(slow.core)[0]!)).toBe(true);
  }, 60_000);

  it('F5-06 restart during an in-flight supervisor call: the EXISTING recovery settles INTERRUPTED, no duplicated round', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 2500 });
    f.mode.value = 'hang';
    const goalRunId = await createGoal(f.core, 'f5-06');
    const pending = f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(supervisorExecutionsOf(f.core)[0]!.status).toBe('RUNNING');
    // RESTART: a fresh composition over the SAME durable storage + the EXISTING startup
    // recovery orchestrator (the production boot order) — no second recovery mechanism.
    const core2 = await recomposeF5Over(f);
    const actor = (await core2.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
    const recovery = await createStartupRecoveryOrchestrator({
      actorId: actor,
      runtime: core2.runtime,
      tools: core2.tools,
      engine: core2.sprint13.engine,
      runs: core2.database.runs,
    }).run();
    if (!recovery.ok) throw new Error('recovery failed: ' + recovery.error.message);
    expect(recovery.value.agentsInterrupted).toBeGreaterThanOrEqual(1);
    // The in-flight round is settled EXACTLY once (INTERRUPTED) and not duplicated.
    const rows = supervisorExecutionsOf(core2);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('INTERRUPTED');
    // The ORIGINAL composition's deadline fires later: the state machine refuses the
    // second settlement — the row stays INTERRUPTED (exactly one winner). Drain past
    // that deadline so no late write lands after the fixtures close.
    await pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2700));
    const rowsAfter = supervisorExecutionsOf(core2);
    expect(rowsAfter.length).toBe(1);
    expect(rowsAfter[0]!.status).toBe('INTERRUPTED');
  }, 60_000);

  it('F5-07/F5-09 a healthy (slow-but-within-deadline) supervisor call completes the corrective path', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 20_000 });
    f.mode.value = 'late';
    f.mode.delayMs = 400; // slow, but well inside the deadline
    const goalRunId = await createGoal(f.core, 'f5-07');
    const state = await driveToTerminal(f.core, goalRunId);
    expect(state).toBe('COMPLETED');
    const rows = supervisorExecutionsOf(f.core);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => row.status !== 'RUNNING')).toBe(true);
    // The F1 corrective chain ran: the refusal-free legal flow delivered and completed.
    const events = f.core.database.db
      .prepare("SELECT type FROM events WHERE aggregate_id = ? AND type IN ('run.delivered','run.completed') ORDER BY rowid")
      .all(goalRunId) as { type: string }[];
    expect(events.map((row) => row.type)).toEqual(['run.delivered', 'run.completed']);
  }, 120_000);

  it('F5-A a Decision from an OLDER turn sharing the run traceId cannot authorize a NEWER RUNNING round (exact identity)', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 120_000, maxSupervisorTurns: 1 });
    const goalRunId = await createGoal(f.core, 'f5-a');
    await f.core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    const executionRun = f.core.database.db
      .prepare("SELECT id FROM runs WHERE id != ? AND company_id = 'company_default' ORDER BY created_at DESC LIMIT 1")
      .get(goalRunId) as { id: string };
    const subject = f.core.database.db
      .prepare('SELECT id FROM tasks WHERE run_id = ? ORDER BY created_at LIMIT 1')
      .get(executionRun.id) as { id: string };
    const actor = (await f.core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
    const sharedTrace = 'f5a-shared-trace';
    const drive = (runIdentity: string, timeoutMs: number) =>
      f.core.autonomousSupervisor!.run({
        companyId: COMPANY,
        runId: executionRun.id,
        taskId: subject.id,
        actorId: actor,
        runIdentity,
        traceId: sharedTrace,
        timeoutMs,
      });
    const decisionsOf = (): number =>
      Number((f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n);
    // Turn 1 completes: a durable Decision exists under the SHARED trace.
    f.mode.value = 'legal';
    const decisionsBefore = decisionsOf();
    const first = await drive('f5a-1', 8000);
    expect(first.ok).toBe(true);
    expect(decisionsOf()).toBe(decisionsBefore + 1);
    const invocationsAfterFirst = f.supervisorInvocations.length;
    // A NEW round hangs INSIDE the provider: its execution is RUNNING, decision-less, and
    // shares the SAME traceId as the earlier Decision — the exact F5-A bypass shape.
    f.mode.value = 'hang';
    const hanging = drive('f5a-2', 2500);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(supervisorExecutionsOf(f.core).filter((row) => row.status === 'RUNNING').length).toBe(1);
    // THE PROBE: while that decision-less round is in flight, another step must NOT start an
    // overlapping round — the older Decision shares the trace but NOT the execution identity.
    const probe = await drive('f5a-3', 2500);
    expect(probe.ok).toBe(true);
    expect(String(probe.ok ? probe.value.stopReason : 'ERR')).toBe('supervisor_inflight');
    expect(f.supervisorInvocations.length).toBe(invocationsAfterFirst + 1); // only the hanging round called the provider
    // The hanging round is bounded by its own deadline; single-flight held throughout.
    await hanging;
    const rows = supervisorExecutionsOf(f.core);
    expect(maxConcurrentRunning(rows)).toBe(1);
    expect(rows.every((row) => row.status !== 'RUNNING')).toBe(true);
  }, 60_000);

  it('INCIDENT regression — an authority-refused corrective proposal settles durably and the durable budget bounds the retries', async () => {
    const f = await composeF5();
    f.mode.value = 'bogus';
    const goalRunId = await createGoal(f.core, 'f5-incident');
    const cp = f.core.controlPlane!;
    // Advances 1-2: the bogus proposal is refused; post-fix each refusal leaves a
    // durably SETTLED (FAILED/INVALID_OUTPUT) row with the sink's typed reason visible.
    await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    let rows = supervisorExecutionsOf(f.core);
    expect(rows.filter((row) => row.status === 'RUNNING')).toHaveLength(0);
    const refusals = rows.filter((row) => row.error_kind === 'INVALID_OUTPUT');
    expect(refusals.length).toBeGreaterThanOrEqual(2);
    expect((refusals[0]!.msg ?? '').length).toBeGreaterThan(0);
    // No fake Decision was ever recorded for the refused proposals.
    const correctiveDecisions = f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM decisions WHERE decision = 'REQUEST_CORRECTIVE'")
      .get() as { n: number };
    expect(Number(correctiveDecisions.n)).toBe(0);
    // The third consecutive refusal trips the DURABLE illegal-proposal budget: the typed
    // terminal surfaces through goal.advance (bounded — never an unbounded retry loop).
    const third = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    expect(third.ok).toBe(false);
    const reason = String(((third as { error?: { details?: Record<string, unknown> } }).error?.details ?? {})['reason'] ?? '');
    expect(reason).toBe('SUPERVISOR_INVALID_ACTIONS_EXHAUSTED');
    rows = supervisorExecutionsOf(f.core);
    expect(rows.every((row) => row.status !== 'RUNNING')).toBe(true);
    expect(maxConcurrentRunning(rows)).toBe(1);
  }, 120_000);
});
