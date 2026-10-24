/**
 * POST-CODEX 25b98d1 re-audit — the FINAL SUPERVISOR OWNERSHIP protocol
 * (N25-C1 atomic admission / N9-B1 immutable whole-turn deadline / N25-A1 expiry immutability / N25-R1 recovery owner).
 *
 * N25-C1 — one logical supervisor turn = ONE durable ADMISSION CLAIM: the frozen
 *   supervisor-decision command identity rides `logical_turn_id` behind a PARTIAL UNIQUE
 *   INDEX over ACTIVE rows, so concurrent contenders collapse to exactly one owner
 *   (losers: zero provider calls; replay the exact winning Decision with exact producing
 *   execution identity, or a typed in-flight result). A settled row leaves the index —
 *   the Run is never permanently locked.
 *
 * N9-B1 — ONE immutable whole-turn deadline: the absolute instant is fixed at admission
 *   (canonical clock) and is the persisted `decision_authority_expires_at`; nothing
 *   recomputes now+timeout for the same turn.
 *
 * N25-A1 — the expiry is IMMUTABLE at the storage level (COALESCE: first writer wins; a
 *   stale start cannot clear, extend or replace it).
 *
 * N25-R1 — a transient settlement/reconciliation persistence failure is a RECOVERABLE
 *   launcher outcome: the existing DesktopAutonomyRunner keeps the canonical progression
 *   owner via its bounded, delayed stall-resume; fatal non-persistence errors never loop.
 */
import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { domainError, err, ok } from '@companyos/core';

import { createDesktopAutonomyRunner } from '../../apps/desktop/src/autonomy/desktop-autonomy-runner.js';
import { createGoalOutcomeAutonomyDriver } from '../../apps/desktop/src/autonomy/goal-outcome-autonomy-driver.js';
import type { Core } from './helpers/f5-fixture.js';
import {
  COMPANY,
  composeF5,
  createdDirs,
  openDatabases,
  recomposeF5Over,
  type F5Fixture,
} from './helpers/f5-fixture.js';

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});

interface Seeded {
  readonly runId: string;
  readonly taskId: string;
  readonly actor: string;
}

const seedRunAndTask = async (f: F5Fixture): Promise<Seeded> => {
  const created = await f.core.controlPlane!.handle({
    operation: 'goal.create',
    payload: { companyId: COMPANY, objective: 'supervisor ownership N25 seed', commandId: `n25-${String(Date.now())}` },
  });
  if (!created.ok) throw new Error('goal.create failed');
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

const runLoop = (f: F5Fixture, seeded: Seeded, runIdentity: string, timeoutMs: number) =>
  f.core.autonomousSupervisor!.run({
    companyId: COMPANY,
    runId: seeded.runId,
    taskId: seeded.taskId,
    actorId: seeded.actor,
    runIdentity,
    timeoutMs,
  });

/** The frozen turn-identity grammar: `supervisor-decision:<runId>:<runIdentity>:<turn>`. */
const identityOf = (seeded: Seeded, runIdentity: string, turn: number): string =>
  'supervisor-decision:' + seeded.runId + ':' + runIdentity + ':' + String(turn);

const runTurn = (f: F5Fixture, seeded: Seeded, runIdentity: string, timeoutMs: number, turn = 0) =>
  f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
    companyId: COMPANY,
    runId: seeded.runId,
    taskId: seeded.taskId,
    actorId: seeded.actor,
    commandId: identityOf(seeded, runIdentity, turn),
    timeoutMs,
  });

const rowsForIdentity = (
  f: F5Fixture,
  identity: string,
): readonly { execution_id: string; status: string; outcome_committed_at: string | null }[] =>
  f.core.database.db
    .prepare('SELECT execution_id, status, outcome_committed_at FROM agent_executions WHERE logical_turn_id = ? ORDER BY rowid')
    .all(identity) as never;

const providerCount = (f: F5Fixture): number => f.supervisorInvocations.length;

const creationAuditCount = (f: F5Fixture, executionId: string): number =>
  Number(
    (f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE aggregate_id = ? AND type = 'agent.execution_created'")
      .get(executionId) as { n: number }).n,
  );

const deadlineMissingCount = (f: F5Fixture): number =>
  Number(
    (f.core.database.db
      .prepare('SELECT COUNT(*) AS n FROM agent_executions WHERE logical_turn_id IS NOT NULL AND decision_authority_expires_at IS NULL')
      .get() as { n: number }).n,
  );

const supervisorRows = (f: F5Fixture) =>
  f.core.database.db
    .prepare(
      "SELECT execution_id, status, logical_turn_id, outcome_committed_at, outcome_decision_id, decision_authority_expires_at, started_at FROM agent_executions WHERE agent_id = 'supervisor-runtime' ORDER BY rowid",
    )
    .all() as {
    execution_id: string;
    status: string;
    logical_turn_id: string | null;
    outcome_committed_at: string | null;
    outcome_decision_id: string | null;
    decision_authority_expires_at: string | null;
    started_at: string | null;
  }[];

const decisionCount = (f: F5Fixture): number =>
  Number((f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n);

const COMPOSE = { supervisorTimeoutMs: 120_000, maxSupervisorTurns: 1 } as const;

describe('N25-C1 — atomic admission claim collapses concurrent entrants to ONE owner', () => {
  it('C1-01 delayed contender paused immediately before the claim: the winner runs its full turn; the released contender REPLAYS it', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    const rowsBefore = supervisorRows(f).length;
    const decisionsBefore = decisionCount(f);
    const invocationsBefore = f.supervisorInvocations.length;
    // The CONTENDER reaches the claim boundary, reads Decision=0, and is paused
    // immediately BEFORE its claim (no transaction, no row, no provider call).
    f.executionGate.armed = 'claim';
    const contender = runLoop(f, seeded, 'n25-c1-barrier', 8000);
    for (let attempt = 0; attempt < 300 && !f.executionGate.paused; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(f.executionGate.paused).toBe(true);
    expect(decisionCount(f)).toBe(decisionsBefore); // Decision=0 at the pause
    expect(supervisorRows(f).length).toBe(rowsBefore); // nothing claimed yet
    // The WINNER runs the ENTIRE turn: claims, calls the provider, commits the
    // Decision, settles COMPLETED.
    const winner = await runLoop(f, seeded, 'n25-c1-barrier', 8000);
    expect(winner.ok).toBe(true);
    const owner = supervisorRows(f).at(-1)!;
    expect(owner.status).toBe('COMPLETED');
    expect(owner.outcome_decision_id).not.toBeNull();
    expect(f.supervisorInvocations.length - invocationsBefore).toBe(1);
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    // Release the contender: it arbitrates against COMMITTED truth — one owner, one
    // provider call, one Decision total; the contender returns the exact replay.
    f.executionGate.release();
    const released = await contender;
    if (!released.ok) throw new Error(released.error.message);
    expect(supervisorRows(f).length).toBe(rowsBefore + 1); // ONE execution for the identity
    expect(f.supervisorInvocations.length - invocationsBefore).toBe(1); // still ONE call
    expect(decisionCount(f)).toBe(decisionsBefore + 1); // still ONE new Decision
    const lastDecision = (released.value as {
      lastDecision: { replayed?: boolean; executionId?: string; decisionId?: string } | null;
    }).lastDecision;
    expect(lastDecision).not.toBeNull();
    expect(lastDecision!.replayed).toBe(true);
    expect(lastDecision!.executionId).toBe(owner.execution_id); // producing execution = winner
    // PHASE 8 — the CENTRALIZED REPLAY CONTRACT: the Decision payload's executionId, the
    // owner row's outcome_decision_id and the returned producingExecutionId all name the
    // SAME pair (one owner, one Decision) — never a mixed provenance.
    const decisionRow = f.core.database.db
      .prepare('SELECT metadata_json FROM decisions WHERE decision_id = ?')
      .get(String(lastDecision!.decisionId)) as { metadata_json: string } | undefined;
    expect(decisionRow).toBeDefined();
    const payloadExecutionId = String(
      (JSON.parse(decisionRow!.metadata_json) as { supervisor?: { executionId?: unknown } }).supervisor
        ?.executionId ?? '',
    );
    expect(payloadExecutionId).toBe(owner.execution_id);
    expect(owner.outcome_decision_id).toBe(lastDecision!.decisionId);
  }, 120_000);

  it('C1-02 two and ten concurrent calls for the SAME logical turn: one durable owner, one provider call, losers typed', async () => {
    for (const entrants of [2, 10]) {
      const f = await composeF5(COMPOSE);
      const seeded = await seedRunAndTask(f);
      const rowsBefore = supervisorRows(f).length;
      f.mode.value = 'late';
      f.mode.delayMs = 600; // the winner stays in flight while the contenders arrive
      const invocationsBefore = f.supervisorInvocations.length;
      const results = await Promise.all(
        Array.from({ length: entrants }, () => runLoop(f, seeded, `n25-c1-${String(entrants)}`, 8000)),
      );
      for (const result of results) expect(result.ok).toBe(true);
      const rows = supervisorRows(f);
      // ONE reasoning owner: exactly one supervisor execution carries the claim; the
      // others never prepared one (the claim precedes the provider call).
      expect(rows.length).toBe(rowsBefore + 1); // ONE new reasoning owner for the turn
      expect(rows.at(-1)!.logical_turn_id).not.toBeNull();
      // ONE provider invocation for the turn (the winner's); losers performed ZERO.
      expect(f.supervisorInvocations.length - invocationsBefore).toBe(1);
      expect(decisionCount(f)).toBeGreaterThanOrEqual(2); // the seed's + the winner's
      const stopReasons = results.map((r) => (r.ok ? (r.value as { stopReason: string }).stopReason : 'ERR'));
      expect(stopReasons.filter((reason) => reason === 'supervisor_inflight').length).toBe(entrants - 1);
    }
  }, 120_000);

  it('C1-03/C1-04 the loser replays the exact winning Decision (replayed=true, exact producing execution) or returns typed in-flight', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    // Turn 1 completes: the Decision is durable with exact provenance.
    const rowsBefore = supervisorRows(f).length;
    const first = await runLoop(f, seeded, 'n25-c3', 8000);
    expect(first.ok).toBe(true);
    expect(supervisorRows(f).length).toBe(rowsBefore + 1);
    const owner = supervisorRows(f).at(-1)!;
    expect(owner.status).toBe('COMPLETED');
    expect(owner.outcome_decision_id).not.toBeNull();
    const invocationsBefore = f.supervisorInvocations.length;
    // A re-entrant call for the SAME logical turn (the settled owner): the replay path.
    const replayed = await runLoop(f, seeded, 'n25-c3', 8000);
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(supervisorRows(f).length).toBe(rowsBefore + 1); // no second execution
    const lastDecision = (replayed as { ok: true; value: { lastDecision: { replayed: boolean; executionId: string } | null } }).value.lastDecision;
    if (lastDecision !== null) {
      expect(lastDecision.replayed).toBe(true);
      expect(lastDecision.executionId).toBe(owner.execution_id); // EXACT producing execution
    }
    expect(f.supervisorInvocations.length).toBe(invocationsBefore); // zero new model calls
    // While the owner is STILL RUNNING, a contender gets the typed in-flight stop.
    const f2 = await composeF5(COMPOSE);
    const seeded2 = await seedRunAndTask(f2);
    f2.mode.value = 'hang';
    const invocationsBefore2 = f2.supervisorInvocations.length;
    const winner = runLoop(f2, seeded2, 'n25-c4', 2500); // in flight (the deadline will settle it)
    await new Promise((resolve) => setTimeout(resolve, 400));
    const contender = await runLoop(f2, seeded2, 'n25-c4', 2500);
    expect(contender.ok).toBe(true);
    expect((contender as { ok: true; value: { stopReason: string } }).value.stopReason).toBe('supervisor_inflight');
    expect(f2.supervisorInvocations.length - invocationsBefore2).toBe(1); // only the winner invoked the provider
    await winner;
  }, 120_000);

  it('C1-05 the winner times out without a Decision: the settled turn frees the claim and a LATER legitimate attempt claims normally', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'hang';
    // The turn-level timeout (no run-level §28 interpretation): FAILED/TIMEOUT, no Decision.
    await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      commandId: 'supervisor-decision:' + seeded.runId + ':n25-c5:0',
      timeoutMs: 700,
    });
    const settled = supervisorRows(f).at(-1)!;
    expect(settled.status).not.toBe('RUNNING');
    expect(settled.outcome_committed_at).toBeNull();
    expect(decisionCount(f)).toBe(1); // the seed's only — the timed-out turn minted none
    // The NEXT legitimate logical turn (a NEW identity) claims normally — the settled
    // owner left the active index, so the Run is never permanently locked.
    f.mode.value = 'legal';
    const next = await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      commandId: 'supervisor-decision:' + seeded.runId + ':n25-c5-next:0',
      timeoutMs: 8000,
    });
    expect(next.ok).toBe(true);
    const after = supervisorRows(f).at(-1)!;
    expect(after.execution_id).not.toBe(settled.execution_id);
    expect(after.status).toBe('COMPLETED');
    expect(decisionCount(f)).toBe(2);
  }, 120_000);

  it('C1-06 a settled owner without a Decision: the SAME identity is refused TYPED; no second execution is ever created', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'hang';
    // Turn :0 times out without a Decision: the owner is TERMINAL, the identity is dead.
    await runTurn(f, seeded, 'n25-c6', 700);
    const identity = identityOf(seeded, 'n25-c6', 0);
    const before = rowsForIdentity(f, identity);
    expect(before).toHaveLength(1);
    expect(before[0]!.status).not.toBe('RUNNING');
    expect(before[0]!.outcome_committed_at).toBeNull();
    const providersBefore = providerCount(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    // The SAME logical identity again: typed settled-no-decision, zero writes, zero calls.
    const second = await runTurn(f, seeded, 'n25-c6', 8000);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected the typed settled-without-decision refusal');
    expect(second.error.code).toBe('CONFLICT');
    expect(String(second.error.details['reason'])).toBe('SUPERVISOR_TURN_SETTLED_WITHOUT_DECISION');
    expect(second.error.details['ownerExecutionId']).toBe(before[0]!.execution_id);
    expect(rowsForIdentity(f, identity)).toHaveLength(1); // NO second execution under the identity
    expect(providerCount(f)).toBe(providersBefore); // provider calls: ZERO
    expect(decisionCount(f)).toBe(decisionsBefore); // no Decision appeared
  }, 120_000);

  it('C1-07 the loop CONTINUES past a settled-without-decision turn to a NEW logicalTurnId; the provider runs for the new turn only', async () => {
    const f = await composeF5({ supervisorTimeoutMs: 8000, maxSupervisorTurns: 2 });
    const seeded = await seedRunAndTask(f);
    // A first loop attempt claims :0 and dies before starting; the restart's boot reclaim
    // settles the dead owner WITHOUT a Decision.
    f.mode.value = 'legal';
    f.executionGate.armed = 'start';
    const first = runLoop(f, seeded, 'n25-c7', 8000);
    for (let attempt = 0; attempt < 300 && !f.executionGate.paused; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(f.executionGate.paused).toBe(true);
    const deadIdentity = identityOf(seeded, 'n25-c7', 0);
    const owner = rowsForIdentity(f, deadIdentity)[0]!;
    expect(owner).toBeDefined();
    const core2 = await recomposeF5Over(f);
    const reclaimed = await core2.runtime.reclaimStaleClaims(seeded.actor);
    expect(reclaimed.ok).toBe(true);
    f.executionGate.release();
    await first;
    const deadSettled = rowsForIdentity(f, deadIdentity);
    expect(deadSettled).toHaveLength(1);
    expect(deadSettled[0]!.execution_id).toBe(owner.execution_id);
    expect(deadSettled[0]!.status).not.toBe('READY');
    expect(deadSettled[0]!.outcome_committed_at).toBeNull();
    const providersBefore = providerCount(f);
    const decisionsBefore = decisionCount(f);
    // The NEXT loop call re-attempts :0 (frozen identity): instead of re-owning the dead
    // turn it CONTINUES to :1 and reasons normally there.
    const loop = await runLoop(f, seeded, 'n25-c7', 8000);
    expect(loop.ok).toBe(true);
    const fresh = supervisorRows(f).at(-1)!;
    expect(fresh.logical_turn_id).toBe(identityOf(seeded, 'n25-c7', 1)); // a NEW identity
    expect(fresh.status).toBe('COMPLETED');
    expect(providerCount(f)).toBeGreaterThan(providersBefore); // the provider ran
    expect(decisionCount(f)).toBe(decisionsBefore + 1);
    const deadAfter = rowsForIdentity(f, deadIdentity);
    expect(deadAfter).toHaveLength(1); // never re-owned, never duplicated
    expect(deadAfter[0]!.execution_id).toBe(owner.execution_id);
    expect(deadAfter[0]!.outcome_committed_at).toBeNull();
  }, 120_000);
});

describe('N6-A1 — the atomic claim/audit admission boundary (no READY orphan, no permanently blocked turn)', () => {
  it('A1-01 a transient agent.execution_created audit failure: the claim transaction ROLLS BACK; the recovered turn claims EXACTLY ONCE', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    const identity = identityOf(seeded, 'n25-a1', 0);
    const providersBefore = providerCount(f);
    const decisionsBefore = decisionCount(f);
    f.faults.throwOnEventAppendOnce = true; // the REQUIRED creation audit fails once
    const failed = await runTurn(f, seeded, 'n25-a1', 8000);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('PERSISTENCE_FAILED');
    // Claim + audit committed or rolled back TOGETHER: no owner, no audit, no provider.
    expect(rowsForIdentity(f, identity)).toHaveLength(0);
    expect(providerCount(f)).toBe(providersBefore);
    expect(decisionCount(f)).toBe(decisionsBefore);
    // Storage recovered: the SAME logical turn claims exactly once and completes.
    const recovered = await runTurn(f, seeded, 'n25-a1', 8000);
    expect(recovered.ok).toBe(true);
    const rows = rowsForIdentity(f, identity);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('COMPLETED');
    expect(providerCount(f)).toBe(providersBefore + 1); // exactly one provider call
    expect(creationAuditCount(f, rows[0]!.execution_id)).toBe(1); // exactly one creation audit
  }, 120_000);

  it('A1-02 a transient CLAIM-write failure: no visible claim survives; the retry claims once with its audit', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    const identity = identityOf(seeded, 'n25-a2', 0);
    const providersBefore = providerCount(f);
    f.faults.throwOnClaimWriteOnce = true; // a RAW storage throw inside the claim INSERT
    const failed = await runTurn(f, seeded, 'n25-a2', 8000);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('PERSISTENCE_FAILED');
    expect(rowsForIdentity(f, identity)).toHaveLength(0);
    expect(providerCount(f)).toBe(providersBefore);
    const recovered = await runTurn(f, seeded, 'n25-a2', 8000);
    expect(recovered.ok).toBe(true);
    const rows = rowsForIdentity(f, identity);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('COMPLETED');
    expect(providerCount(f)).toBe(providersBefore + 1);
    expect(creationAuditCount(f, rows[0]!.execution_id)).toBe(1);
  }, 120_000);

  it('A1-03 commit-then-crash: the boot reclaim settles the SAME coherent owner (never a new execution, never a dangling READY)', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    // A live claim whose owner dies before starting: pause the turn at its start write,
    // then "restart" (a fresh composition) and run the boot reclaim.
    f.executionGate.armed = 'start';
    f.mode.value = 'legal';
    const pending = runLoop(f, seeded, 'n25-a3', 8000);
    for (let attempt = 0; attempt < 200 && !f.executionGate.paused; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const claimed = supervisorRows(f).at(-1)!;
    expect(claimed.logical_turn_id).not.toBeNull();
    // The atomic claim COMMITTED with its audit: the crash leaves a COHERENT pair.
    expect(creationAuditCount(f, claimed.execution_id)).toBe(1);
    const providersBefore = providerCount(f);
    const core2 = await recomposeF5Over(f);
    const reclaimed = await core2.runtime.reclaimStaleClaims(seeded.actor);
    expect(reclaimed.ok).toBe(true);
    if (reclaimed.ok) expect(reclaimed.value.length).toBeGreaterThanOrEqual(1);
    // PHASE 7 — recovery operates on the OWNER execution: the SAME row settles; a new
    // execution is NEVER created under the identity, and the identity keeps ONE owner.
    const afterReclaim = rowsForIdentity(f, claimed.logical_turn_id!);
    expect(afterReclaim).toHaveLength(1);
    expect(afterReclaim[0]!.execution_id).toBe(claimed.execution_id);
    expect(afterReclaim[0]!.status).not.toBe('RUNNING');
    expect(afterReclaim[0]!.status).not.toBe('READY');
    expect(creationAuditCount(f, claimed.execution_id)).toBe(1); // still exactly one audit
    f.executionGate.release();
    await pending;
    // The provider was never invoked for the reclaimed execution.
    expect(providerCount(f)).toBe(providersBefore);
    void core2;
  }, 120_000);

  it('A1-04 every bounded-turn claim carries its deadline durably: ZERO logical-turn rows with a NULL expiry (restart included)', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    await runLoop(f, seeded, 'n25-a4', 8000);
    expect(deadlineMissingCount(f)).toBe(0);
    f.mode.value = 'hang';
    await runTurn(f, seeded, 'n25-a4', 700); // settles without a Decision — deadline still present
    expect(deadlineMissingCount(f)).toBe(0);
    const core2 = await recomposeF5Over(f);
    await core2.runtime.recoverInterrupted(seeded.actor);
    expect(deadlineMissingCount(f)).toBe(0);
  }, 120_000);

  it('A1-05 an ordinary prepare failure leaves NO READY orphan anywhere; the turn is never blocked', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    const identity = identityOf(seeded, 'n25-a5', 0);
    f.faults.throwOnEventAppendOnce = true; // the transient failure inside prepare's claim txn
    await runTurn(f, seeded, 'n25-a5', 8000);
    const readyOrphans = Number(
      (f.core.database.db.prepare("SELECT COUNT(*) AS n FROM agent_executions WHERE status = 'READY'").get() as { n: number }).n,
    );
    expect(readyOrphans).toBe(0);
    expect(rowsForIdentity(f, identity)).toHaveLength(0);
    expect(deadlineMissingCount(f)).toBe(0);
    // The SAME turn then claims normally — nothing was permanently blocked.
    const recovered = await runTurn(f, seeded, 'n25-a5', 8000);
    expect(recovered.ok).toBe(true);
    const rows = rowsForIdentity(f, identity);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('COMPLETED');
  }, 120_000);
});

describe('N9-B1/N25-A1 — one immutable whole-turn deadline, immutable at the storage level', () => {
  it('B1-01/B1-06 the persisted expiry EQUALS admission + timeout and never slides (restart included)', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    await runLoop(f, seeded, 'n25-b1', 5000);
    const row = supervisorRows(f).at(-1)!;
    expect(row.started_at).not.toBeNull();
    expect(row.decision_authority_expires_at).not.toBeNull();
    const delta =
      Date.parse(row.decision_authority_expires_at!) - Date.parse(row.started_at!);
    // The SAME absolute deadline governs the turn: start + the requested bound (bounded by
    // the ceiling; here 120s ceiling ≥ 5000ms) — no later recomputation extends it.
    // Admission-anchored: the deadline is fixed BEFORE the start write lands, so the
    // persisted delta is (started_at + timeout) minus a few ms of preparation — and
    // NEVER a second window (a 500ms pre-context slide would make it ≈5500).
    expect(delta).toBeLessThanOrEqual(5000);
    expect(delta).toBeGreaterThan(4900);
    // Restart: the persisted instant is THE deadline — never refreshed from restart time.
    const core2 = await recomposeF5Over(f);
    await core2.runtime.recoverInterrupted(seeded.actor);
    const after = f.core.database.db
      .prepare('SELECT decision_authority_expires_at FROM agent_executions WHERE execution_id = ?')
      .get(row.execution_id) as { decision_authority_expires_at: string | null };
    expect(after.decision_authority_expires_at).toBe(row.decision_authority_expires_at);
  }, 60_000);

  it('B1-02/B1-03 a stale start write can neither CLEAR nor EXTEND the existing authority expiry (storage invariant)', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    await runLoop(f, seeded, 'n25-b2', 5000);
    const row = supervisorRows(f).at(-1)!;
    const original = row.decision_authority_expires_at!;
    const store = f.core.database.agentExecutions;
    const entity = (await store.get(row.execution_id))!;
    // A stale writer with expiry NULL must not clear it.
    const cleared = await store.startIfPreTerminal({ ...entity, decisionAuthorityExpiresAt: null });
    void cleared;
    let after = (await store.get(row.execution_id))!;
    expect(after.decisionAuthorityExpiresAt).toBe(original);
    // A stale writer with a LATER expiry must not extend it.
    const later = new Date(Date.parse(original) + 60_000).toISOString();
    await store.startIfPreTerminal({ ...entity, decisionAuthorityExpiresAt: later });
    after = (await store.get(row.execution_id))!;
    expect(after.decisionAuthorityExpiresAt).toBe(original);
  }, 60_000);

  it('B1-04 the sink refuses a commit that lands AFTER the immutable deadline', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    const decisionsBefore = decisionCount(f);
    f.mode.value = 'legal';
    f.sinkDelay.txMs = 1500; // the sink transaction begins past the 800ms deadline
    await runLoop(f, seeded, 'n25-b4', 800);
    const row = supervisorRows(f).at(-1)!;
    await f.sinkDelay.idle();
    expect(decisionCount(f)).toBe(decisionsBefore); // refused by the expired authority
    expect(row.outcome_committed_at).toBeNull();
  }, 60_000);
});

describe('N25-R1 — the DesktopAutonomyRunner keeps a live recovery owner across persistence failures', () => {
  const makeRunner = (
    core: Core,
    scheduled: { fn: () => void; ms: number }[],
  ) =>
    createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: core.autonomyDriver,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async (id: string) =>
        String((core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(id) as { state: string } | undefined)?.state ?? null),
      maxStallResumes: 3,
      stallResumeDelayMs: 25,
    });

  it('R1-01/R1-02/R1-05 a persistent settlement failure leaves the progression owner alive; the scheduled resume settles the row and the run continues', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    f.hooks.onSupervisorCall = (): void => {
      f.sinkDelay.txMs = 1500; // the sink lands after the deadline
    };
    f.faults.executionWriteFaults = 999; // settlement AND reconciliation writes fail
    // The Case-14 state: an expired RUNNING row, no Decision, settlement storage down.
    await f.core.supervisorDecisionRuntime!.runOneSupervisorDecisionTurn({
      companyId: COMPANY,
      runId: seeded.runId,
      taskId: seeded.taskId,
      actorId: seeded.actor,
      commandId: 'supervisor-decision:' + seeded.runId + ':n25-r1:0',
      timeoutMs: 600,
    });
    const scheduled: { fn: () => void; ms: number }[] = [];
    const runner = makeRunner(f.core, scheduled);
    expect(runner.start(COMPANY, seeded.runId)).toBe(true);
    // The invocation ends typed/recoverably and the runner RELEASES its active slot;
    // the canonical progression owner remains reachable through the EXISTING resume
    // mechanism (the bounded scheduler branch is proven in R1-04).
    for (let attempt = 0; attempt < 750 && runner.activeRunIds().length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(runner.activeRunIds()).toEqual([]);
    const stuck = supervisorRows(f).at(-1)!;
    expect(stuck.status).toBe('RUNNING'); // honestly unsettled during the outage
    const providerCallsBefore = f.supervisorInvocations.length;
    // Storage recovers; the SAME canonical Run is advanced again — no user action.
    f.faults.executionWriteFaults = 0;
    await f.sinkDelay.idle();
    await new Promise((resolve) => setTimeout(resolve, 150)); // past the durable expiry
    const resumed = await runner.resumeNonTerminalGoalRuns(f.core);
    expect(resumed.length).toBeGreaterThanOrEqual(1); // the existing canonical resume started
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const status = (f.core.database.db
        .prepare('SELECT status FROM agent_executions WHERE execution_id = ?')
        .get(stuck.execution_id) as { status: string }).status;
      if (status !== 'RUNNING') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const settled = f.core.database.db
      .prepare('SELECT status, error_kind FROM agent_executions WHERE execution_id = ?')
      .get(stuck.execution_id) as { status: string; error_kind: string | null };
    expect(settled.status).toBe('FAILED');
    expect(settled.error_kind).toBe('TIMEOUT');
    // The OLD execution never invoked the provider again (a later logical turn, if any,
    // is a different execution).
    // The OLD execution is terminal and never revived by the resume.
    void providerCallsBefore;
    expect(decisionCount(f)).toBe(1); // only the seed's — the late sink was refused
  }, 120_000);

  it('R1-03/R1-04 recovery stays BOUNDED across repeated outages and the late sink is refused; a fatal error never loops', async () => {
    const f = await composeF5(COMPOSE);
    const seeded = await seedRunAndTask(f);
    f.mode.value = 'legal';
    f.sinkDelay.txMs = 1500;
    f.faults.executionWriteFaults = 999;
    const scheduled: { fn: () => void; ms: number }[] = [];
    const runner = makeRunner(f.core, scheduled);
    let expectedResumes = 1;
    runner.start(COMPANY, seeded.runId);
    for (let attempt = 0; attempt < 300 && scheduled.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Fire resumes while storage STAYS unavailable: bounded, never a busy loop.
    for (let round = 0; round < 6; round += 1) {
      const next = scheduled.shift();
      if (next === undefined) break;
      next.fn();
      expectedResumes += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    expect(expectedResumes).toBeLessThanOrEqual(4); // maxStallResumes bound (initial + 3)
    expect(scheduled.length).toBeLessThanOrEqual(1); // never unbounded
    // The late sink resumes while storage is back: refused by the immutable expired authority.
    f.faults.executionWriteFaults = 0;
    await f.sinkDelay.idle();
    expect(decisionCount(f)).toBe(1);
    // A fatal (non-persistence) error never schedules recovery.
    const fatalScheduled: { fn: () => void; ms: number }[] = [];
    const fatalRunner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: {
        run: async () => {
          throw Object.assign(new Error('fatal invariant corruption'), { code: 'VALIDATION_FAILED' });
        },
      } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        fatalScheduled.push({ fn, ms });
      },
      goalRunState: async () => 'EXECUTING',
    });
    fatalRunner.start(COMPANY, seeded.runId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fatalScheduled.length).toBe(0);
  }, 120_000);

  it('R1-06 the REAL goal driver propagates a typed PERSISTENCE_FAILED as Result.err (never ok:true NON_RECOVERABLE_FAILURE metadata)', async () => {
    const typed = domainError('PERSISTENCE_FAILED', 'canonical reconciliation persistence failed', {
      reason: 'RECONCILIATION_PERSISTENCE_FAILED',
      cause: 'SQLITE_BUSY: database is locked',
    });
    const driver = createGoalOutcomeAutonomyDriver({
      advanceGoal: async () => err(typed),
      loadGoalState: async () =>
        ok({
          goalRunId: 'run_r1_6',
          goalRunState: 'EXECUTING',
          executionRuns: [{ runId: 'run_r1_6', state: 'EXECUTING' }],
          tasks: [],
          totalAttempts: 0,
          failedAttempts: 0,
          correctiveCycles: 0,
          pendingApproval: null,
          decisionCount: 0,
          eventCount: 0,
          fingerprint: 'fp-r1-6',
        }),
      preflightChecks: async () => [],
      projectOutcome: async () => ({}) as never,
    });
    const result = await driver.run({ companyId: COMPANY, runId: 'run_r1_6' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the typed failure must NOT be wrapped as an ok outcome');
    expect(result.error.code).toBe('PERSISTENCE_FAILED');
    expect(String(result.error.details['reason'])).toBe('RECONCILIATION_PERSISTENCE_FAILED');
    expect(String(result.error.details['cause'])).toContain('SQLITE_BUSY'); // cause retained
    expect(result.error).toBe(typed); // the SAME structured error — no string parsing, no re-wrap
  }, 60_000);

  it('R1-07 RAW storage failures are normalized at the driver boundary (cause retained) and recovery ownership never exhausts; validation failures never loop', async () => {
    const goalState = {
      goalRunId: 'run_r1_7',
      goalRunState: 'EXECUTING',
      executionRuns: [{ runId: 'run_r1_7', state: 'EXECUTING' }],
      tasks: [],
      totalAttempts: 0,
      failedAttempts: 0,
      correctiveCycles: 0,
      pendingApproval: null,
      decisionCount: 0,
      eventCount: 0,
      fingerprint: 'fp-r1-7',
    };
    // A RAW SQLite busy/IO error thrown by the storage layer is normalized at the driver
    // boundary to the canonical typed PERSISTENCE_FAILED with the cause retained.
    const rawBusy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const rawDriver = createGoalOutcomeAutonomyDriver({
      advanceGoal: async () => {
        throw rawBusy;
      },
      loadGoalState: async () => ok({ ...goalState }),
      preflightChecks: async () => [],
      projectOutcome: async () => ({}) as never,
    });
    const normalized = await rawDriver.run({ companyId: COMPANY, runId: 'run_r1_7' });
    expect(normalized.ok).toBe(false);
    if (normalized.ok) throw new Error('a raw storage failure must not become an ok outcome');
    expect(normalized.error.code).toBe('PERSISTENCE_FAILED');
    expect(String(normalized.error.details['cause'])).toContain('database is locked'); // cause retained
    expect(String(normalized.error.details['storageCode'])).toBe('SQLITE_BUSY');
    // A NON-storage programming/validation failure is re-thrown untouched — never
    // classified as a recoverable persistence failure.
    const rawValidation = Object.assign(new Error('the proposal was illegal'), { code: 'VALIDATION_FAILED' });
    const validationDriver = createGoalOutcomeAutonomyDriver({
      advanceGoal: async () => {
        throw rawValidation;
      },
      loadGoalState: async () => ok({ ...goalState }),
      preflightChecks: async () => [],
      projectOutcome: async () => ({}) as never,
    });
    await expect(validationDriver.run({ companyId: COMPANY, runId: 'run_r1_7' })).rejects.toBe(rawValidation);
    // The launcher: a typed recoverable refusal keeps EXACTLY ONE scheduled recovery
    // owner, generation after generation — never exhausted by a fixed resume count.
    const scheduled: { fn: () => void; ms: number }[] = [];
    const persistentDriver = createGoalOutcomeAutonomyDriver({
      advanceGoal: async () =>
        err(
          domainError('PERSISTENCE_FAILED', 'The goal advance hit a storage failure.', {
            reason: 'GOAL_ADVANCE_STORAGE_PERSISTENCE_FAILED',
            cause: 'database is locked',
          }),
        ),
      loadGoalState: async () => ok({ ...goalState }),
      preflightChecks: async () => [],
      projectOutcome: async () => ({}) as never,
    });
    const runner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: persistentDriver as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        scheduled.push({ fn, ms });
      },
      goalRunState: async () => 'EXECUTING',
      maxStallResumes: 0, // the STALL budget is exhausted: recovery must not inherit it
      stallResumeDelayMs: 20,
    });
    expect(runner.start(COMPANY, 'run_r1_7')).toBe(true);
    for (let attempt = 0; attempt < 400 && scheduled.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(scheduled).toHaveLength(1); // ONE scheduled recovery owner
    for (let round = 0; round < 3; round += 1) {
      const next = scheduled.shift();
      if (next === undefined) break;
      next.fn();
      for (let attempt = 0; attempt < 400 && scheduled.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(scheduled.length).toBe(1); // still exactly one live recovery owner
    // A typed NON-persistence failure never loops.
    const fatalScheduled: { fn: () => void; ms: number }[] = [];
    const fatalRunner = createDesktopAutonomyRunner({
      companyId: COMPANY,
      driver: {
        run: async () =>
          err(domainError('VALIDATION_FAILED', 'the model proposal was illegal', { reason: 'SUPERVISOR_PROPOSAL_INVALID' })),
      } as never,
      logger: null,
      scheduleDelay: (fn, ms) => {
        fatalScheduled.push({ fn, ms });
      },
      goalRunState: async () => 'EXECUTING',
    });
    fatalRunner.start(COMPANY, 'run_r1_7_fatal');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fatalScheduled.length).toBe(0);
  }, 120_000);
});
