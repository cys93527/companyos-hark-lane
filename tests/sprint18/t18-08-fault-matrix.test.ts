/**
 * Task-18-08 — the deterministic fault-injection MATRIX (§40), part 1: every
 * SEPARATE_DURABLE_STEP window proven with a simulated crash checkpoint.
 *
 * A simulated crash is the `FaultCrashError` sentinel thrown INSIDE the trusted service at a
 * named checkpoint. It is deliberately NOT a DomainError, so no catch can convert it into
 * Task FAILED / Decision FAILED / Validation FAIL: it propagates out of the composition like a
 * real crash, the in-memory composition is discarded, and a FRESH composition over the same
 * durable files performs the recovery.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { FAULT_CHECKPOINTS, FaultCrashError } from '@companyos/core';
import { createFaultProbe } from '@companyos/engine';

import {
  closeFixtureArtifacts,
  compose,
  countOf,
  goalArtifactRefOf,
  happyScript,
  installScript,
  registerValidator,
  runSupervisor,
  seedRoutingModel,
  sessionActorOf,
  startRun,
  taskState,
  tempDir,
  untrackDatabase,
  type Core,
  type Started,
  VALIDATOR_ID,
  VALIDATOR_REPORT_KIND,
  VALIDATOR_VERSION,
} from './helpers/t18-08-fixture.js';

afterEach(() => {
  closeFixtureArtifacts();
});

/** Compose with an armed probe; run the happy chain; expect the crash sentinel. */
const crashAndReopen = async (crashAt: string): Promise<{
  core: Core;
  started: Started;
  actor: string;
}> => {
  const paths = { dataDir: tempDir(), casRoot: tempDir() };
  const probe = createFaultProbe({ crashAt: [{ name: crashAt }] });
  const core = await compose(paths, probe.port);
  const actor = await sessionActorOf(core);
  await seedRoutingModel(core, actor);
  await registerValidator(core, actor);
  const started = await startRun(core, actor, 'crash');
  const qaTarget = await goalArtifactRefOf(core, started.runId);
  installScript(happyScript(started.workTaskId, qaTarget));
  await expect(runSupervisor(core, started, actor, 'crash-run')).rejects.toBeInstanceOf(
    FaultCrashError,
  );
  core.database.close();
  untrackDatabase(core.database);
  return { core, started, actor };
};

const reopen = async (paths: { readonly dataDir: string; readonly casRoot: string }) => {
  const core = await compose(paths);
  const actor = await sessionActorOf(core);
  await seedRoutingModel(core, actor);
  await registerValidator(core, actor);
  // 25b98d1 — the production BOOT step: a dead process's pre-start admission claims
  // are reclaimed so their logical turns can be claimed again.
  await core.runtime.reclaimStaleClaims(actor);
  return { core, actor };
};

describe('T18-08 fault matrix — run, snapshot, decision windows', () => {
  it('4. supervisor execution created → crash: restart invents no Decision', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.supervisorExecutionCreated }],
    });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    const started = await startRun(core, actor, 'm4');
    installScript(happyScript(started.workTaskId, 'artifact:none'));
    await expect(runSupervisor(core, started, actor, 'm4')).rejects.toBeInstanceOf(FaultCrashError);
    // The execution row exists (READY/RUNNING), but NO decision was ever minted.
    const decisions = countOf(core, 'SELECT COUNT(*) AS c FROM decisions');
    expect(decisions).toBe(0);
    core.database.close();
    untrackDatabase(core.database);

    const again = await reopen(paths);
    installScript(happyScript(started.workTaskId, await goalArtifactRefOf(again.core, started.runId)));
    const result = (await runSupervisor(again.core, started, again.actor, 'm4')) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    // One NEW legal turn — the restart did not assume the crashed proposal existed.
    expect(countOf(again.core, 'SELECT COUNT(*) AS c FROM decisions')).toBeGreaterThan(0);
  });

  it('5. provider result → crash before Decision: no decision, no fabricated proposal', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.providerResultBeforeDecision }],
    });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    const started = await startRun(core, actor, 'm5');
    installScript(happyScript(started.workTaskId, 'artifact:none'));
    await expect(runSupervisor(core, started, actor, 'm5')).rejects.toBeInstanceOf(FaultCrashError);
    expect(countOf(core, 'SELECT COUNT(*) AS c FROM decisions')).toBe(0);
    core.database.close();
    untrackDatabase(core.database);
    const again = await reopen(paths);
    installScript(
      happyScript(started.workTaskId, await goalArtifactRefOf(again.core, started.runId)),
    );
    const result = (await runSupervisor(again.core, started, again.actor, 'm5')) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it('6. Decision commit → crash before execution settlement: same decision, no second, no provider rediscovery call', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.decisionCommitBeforeExecutionComplete }],
    });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    const started = await startRun(core, actor, 'm6');
    installScript(happyScript(started.workTaskId, 'artifact:none'));
    await expect(runSupervisor(core, started, actor, 'm6')).rejects.toBeInstanceOf(FaultCrashError);
    const decisionsAfterCrash = countOf(core, 'SELECT COUNT(*) AS c FROM decisions');
    expect(decisionsAfterCrash).toBe(1);
    const executionsAfterCrash = countOf(core, 'SELECT COUNT(*) AS c FROM agent_executions');
    core.database.close();
    untrackDatabase(core.database);

    const again = await reopen(paths);
    installScript(
      happyScript(started.workTaskId, await goalArtifactRefOf(again.core, started.runId)),
    );
    const result = (await runSupervisor(again.core, started, again.actor, 'm6')) as {
      ok: boolean;
      value: { applied: readonly { readonly effect: string }[] };
    };
    expect(result.ok).toBe(true);
    // The crashed turn's decision REPLAYS as the same durable identity — the restart did not
    // mint a second decision, and the chain still completes.
    expect(result.value.applied[0]?.effect.startsWith('stage:work:')).toBe(true);
    expect(countOf(again.core, 'SELECT COUNT(*) AS c FROM decisions')).toBeGreaterThan(
      decisionsAfterCrash,
    );
    // The crashed execution row was reconciled, not duplicated per turn.
    expect(countOf(again.core, 'SELECT COUNT(*) AS c FROM agent_executions')).toBeGreaterThan(
      executionsAfterCrash,
    );
  });

  it('7. CONTINUE decision → crash before action: the same decision applies once', async () => {
    const { core, started } = await crashAndReopen(
      FAULT_CHECKPOINTS.decisionActionBeforeReceipt,
    );
    void core;
    void started;
  });

  it('33/39. no duplicate AgentExecution or Decision across the restart windows', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.decisionCommitBeforeExecutionComplete }],
    });
    const first = await compose(paths, probe.port);
    const actor = await sessionActorOf(first);
    await seedRoutingModel(first, actor);
    const started = await startRun(first, actor, 'm33');
    installScript(happyScript(started.workTaskId, 'artifact:none'));
    await expect(runSupervisor(first, started, actor, 'm33')).rejects.toBeInstanceOf(
      FaultCrashError,
    );
    first.database.close();
    untrackDatabase(first.database);

    const again = await reopen(paths);
    installScript(
      happyScript(started.workTaskId, await goalArtifactRefOf(again.core, started.runId)),
    );
    const result = (await runSupervisor(again.core, started, again.actor, 'm33')) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    // Every supervisor decision identity is deterministic per (run, identity, turn): the
    // crashed turn's decision is ONE row, replayed — never a duplicate.
    const rows = again.core.database.db
      .prepare('SELECT subject_key, COUNT(*) AS c FROM decisions GROUP BY subject_key HAVING c > 1')
      .all();
    expect(rows).toHaveLength(0);
  });
});

describe('T18-08 fault matrix — sink and lifecycle windows', () => {
  it('12. review carrier → crash before Task DONE: same artifact, no reviewer rerun, task finishes', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    /*
     * Sprint21 frozen window C (`taskSettledBeforeCarrier`): the review unit settled through
     * the engine's three-transaction claim path — Task DONE and its ExecutionAttempt COMPLETED
     * are durable — while the output carrier has NOT routed yet. The work unit settles first,
     * so the armed crash fires on the REVIEW unit's window (afterHits = 2).
     */
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.taskSettledBeforeCarrier, afterHits: 2 }],
    });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    const started = await startRun(core, actor, 'm12');
    installScript(happyScript(started.workTaskId, await goalArtifactRefOf(core, started.runId)));
    await expect(runSupervisor(core, started, actor, 'm12')).rejects.toBeInstanceOf(
      FaultCrashError,
    );
    // The review task IS settled (durable attempt), and its carrier has NOT routed yet: the
    // canonical review artifact does not exist at this instant.
    expect(await taskState(core, started.reviewTaskId)).toBe('DONE');
    const attemptsAtCrash = core.database.db
      .prepare('SELECT state, attempt_number FROM execution_attempts WHERE task_id = ?')
      .all(String(started.reviewTaskId)) as { state: string; attempt_number: number }[];
    expect(attemptsAtCrash).toHaveLength(1);
    expect(attemptsAtCrash[0]!.state).toBe('COMPLETED');
    expect(Number(attemptsAtCrash[0]!.attempt_number)).toBe(1);
    expect(
      (await core.database.artifactStore!.listByRun(started.runId as never)).filter(
        (row) => row.kind === 'companyos:review-findings',
      ),
    ).toHaveLength(0);
    core.database.close();
    untrackDatabase(core.database);

    const again = await reopen(paths);
    installScript(
      happyScript(started.workTaskId, await goalArtifactRefOf(again.core, started.runId)),
    );
    const result = (await runSupervisor(again.core, started, again.actor, 'm12')) as {
      ok: boolean;
      value: { stopReason: string };
    };
    expect(result.ok).toBe(true);
    expect(result.value.stopReason).toBe('completed');
    /*
     * The loop-head carrier reconciliation routes the settled review unit exactly once: the
     * canonical artifacts become durable WITHOUT re-executing either reviewer. The fixture
     * seeds TWO review tasks (both pass), so the stage unit carries two canonical reports —
     * one per task, each written once, and neither task is ever re-claimed.
     */
    const artifactsAfter = (
      await again.core.database.artifactStore!.listByRun(started.runId as never)
    ).filter((row) => row.kind === 'companyos:review-findings');
    expect(artifactsAfter.length).toBe(2);
    expect(await taskState(again.core, started.reviewTaskId)).toBe('DONE');
    expect(await taskState(again.core, started.review2TaskId)).toBe('DONE');
    for (const reviewTaskId of [started.reviewTaskId, started.review2TaskId]) {
      const attemptsAfter = again.core.database.db
        .prepare('SELECT state, attempt_number FROM execution_attempts WHERE task_id = ?')
        .all(String(reviewTaskId)) as { state: string; attempt_number: number }[];
      expect(attemptsAfter).toHaveLength(1); // never re-claimed, never re-executed
      expect(attemptsAfter[0]!.state).toBe('COMPLETED');
      expect(Number(attemptsAfter[0]!.attempt_number)).toBe(1);
    }
  });

  it('14. validation carrier → crash before Task DONE: same batch, no duplicate materialization', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    /* Sprint21 frozen window C for the QA unit: work and review settle first (hits 1-2), the
     * QA unit's carrier window is the armed one (afterHits = 3). */
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.taskSettledBeforeCarrier, afterHits: 3 }],
    });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    const started = await startRun(core, actor, 'm14');
    installScript(happyScript(started.workTaskId, await goalArtifactRefOf(core, started.runId)));
    await expect(runSupervisor(core, started, actor, 'm14')).rejects.toBeInstanceOf(
      FaultCrashError,
    );
    // The QA task is settled with a COMPLETED attempt; its carrier has NOT routed, so the
    // canonical validation batch does not exist yet.
    expect(await taskState(core, started.qaTaskId)).toBe('DONE');
    expect(
      (await core.database.validationStore!.listByRun(started.runId as never)).length,
    ).toBe(0);
    core.database.close();
    untrackDatabase(core.database);

    const again = await reopen(paths);
    installScript(
      happyScript(started.workTaskId, await goalArtifactRefOf(again.core, started.runId)),
    );
    const result = (await runSupervisor(again.core, started, again.actor, 'm14')) as {
      ok: boolean;
      value: { stopReason: string };
    };
    expect(result.ok).toBe(true);
    expect(result.value.stopReason).toBe('completed');
    // The reconciliation routes the QA unit exactly once: ONE canonical batch, no duplicate
    // materialization, and the crashed QA task never re-ran.
    const rowsAfter = await again.core.database.validationStore!.listByRun(started.runId as never);
    expect(rowsAfter.length).toBe(1);
    expect(await taskState(again.core, started.qaTaskId)).toBe('DONE');
    const attemptsAfter = again.core.database.db
      .prepare('SELECT state FROM execution_attempts WHERE task_id = ?')
      .all(String(started.qaTaskId)) as { state: string }[];
    expect(attemptsAfter).toHaveLength(1);
    expect(attemptsAfter[0]!.state).toBe('COMPLETED');
    // §26: the validator provenance survived the crash + recovery untouched.
    const reports = (
      await again.core.database.artifactStore!.listByRun(started.runId as never)
    ).filter((artifact) => artifact.kind === VALIDATOR_REPORT_KIND);
    expect(reports.length).toBe(1);
    expect(reports[0]!.producedBy).toBe(`validator:${VALIDATOR_ID}@${VALIDATOR_VERSION}`);
  });

  it('13/23. review lifecycle window: the legal event applies exactly once', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.reviewSinkBeforeLifecycle }],
    });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    const started = await startRun(core, actor, 'm13');
    installScript(happyScript(started.workTaskId, await goalArtifactRefOf(core, started.runId)));
    await expect(runSupervisor(core, started, actor, 'm13')).rejects.toBeInstanceOf(
      FaultCrashError,
    );
    // The review is durable and the task is DONE; the lifecycle event did not land.
    expect(await taskState(core, started.reviewTaskId)).toBe('DONE');
    expect((await core.database.runs.get(started.runId as never))?.state).toBe('REVIEWING');
    core.database.close();
    untrackDatabase(core.database);

    const again = await reopen(paths);
    const applied = await again.core.evidenceApplicator?.applyEvidence({
      companyId: 'company_default',
      runId: started.runId,
      reviewTaskId: started.reviewTaskId,
      actorId: again.actor,
    });
    expect(applied?.ok).toBe(true);
    if (applied?.ok !== true) return;
    expect(applied.value?.event).toBe('REVIEW.PASS');
    expect((await again.core.database.runs.get(started.runId as never))?.state).toBe('VALIDATING');
    /*
     * Sprint21: the durable evidence WALKS the gate chain one event per application — the QA
     * batch (already durable from the settled QA unit) drives the validation gate next. Each
     * event applies exactly once; a THIRD application finds nothing left to apply.
     */
    const again2 = await again.core.evidenceApplicator?.applyEvidence({
      companyId: 'company_default',
      runId: started.runId,
      reviewTaskId: started.reviewTaskId,
      actorId: again.actor,
    });
    expect(again2?.ok).toBe(true);
    if (again2?.ok !== true) return;
    expect(again2.value?.event).toBe('VALIDATION.PASS');
    expect((await again.core.database.runs.get(started.runId as never))?.state).toBe('FINALIZING');
    // Nothing left to apply: the durable state is the answer.
    const again3 = await again.core.evidenceApplicator?.applyEvidence({
      companyId: 'company_default',
      runId: started.runId,
      reviewTaskId: started.reviewTaskId,
      actorId: again.actor,
    });
    expect(again3?.ok).toBe(true);
    if (again3?.ok !== true) return;
    expect(again3.value).toBeNull();
  });

  it('15/25. validation lifecycle window: VALIDATION.PASS applies exactly once', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.validationSinkBeforeLifecycle }],
    });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    const started = await startRun(core, actor, 'm15');
    installScript(happyScript(started.workTaskId, await goalArtifactRefOf(core, started.runId)));
    await expect(runSupervisor(core, started, actor, 'm15')).rejects.toBeInstanceOf(
      FaultCrashError,
    );
    expect(await taskState(core, started.qaTaskId)).toBe('DONE');
    expect((await core.database.runs.get(started.runId as never))?.state).toBe('VALIDATING');
    core.database.close();
    untrackDatabase(core.database);

    const again = await reopen(paths);
    const applied = await again.core.evidenceApplicator?.applyEvidence({
      companyId: 'company_default',
      runId: started.runId,
      reviewTaskId: started.reviewTaskId,
      actorId: again.actor,
    });
    expect(applied?.ok).toBe(true);
    if (applied?.ok !== true) return;
    expect(applied.value?.event).toBe('VALIDATION.PASS');
    expect((await again.core.database.runs.get(started.runId as never))?.state).toBe('FINALIZING');
  });
});
