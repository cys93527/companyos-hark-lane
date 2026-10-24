/**
 * Task-18-08 — the three CHAOS scenarios (§42/§43/§44), as deterministic production E2Es over
 * the REAL composition: forced crashes (the `FaultCrashError` sentinel, which no service can
 * convert into a domain failure) interleaved with fresh compositions over the SAME durable
 * files, reaching the required end states with no manual state injection.
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

interface Phase {
  readonly core: Core;
  readonly actor: string;
}

const openPhase = async (
  paths: { readonly dataDir: string; readonly casRoot: string },
  crashAt?: string,
): Promise<Phase> => {
  const probe = createFaultProbe(crashAt === undefined ? {} : { crashAt: [{ name: crashAt }] });
  const core = await compose(paths, probe.port);
  const actor = await sessionActorOf(core);
  await seedRoutingModel(core, actor);
  await registerValidator(core, actor);
  // 25b98d1 — the production BOOT step: a dead process's pre-start admission claims
  // are reclaimed so their logical turns can be claimed again.
  await core.runtime.reclaimStaleClaims(actor);
  return { core, actor };
};

const closePhase = (core: Core): void => {
  core.database.close();
  untrackDatabase(core.database);
};

const readStarted = (core: Core, actor: string): Started => {
  void actor;
  const one = (sql: string): string =>
    (core.database.db.prepare(sql).get() as { id: string }).id;
  return {
    runId: one('SELECT id FROM runs'),
    workTaskId: one("SELECT id FROM tasks WHERE kind = 'e2e7:build'"),
    reviewTaskId: one(
      "SELECT id FROM tasks WHERE kind = 'e2e7:review' ORDER BY created_at, id LIMIT 1",
    ),
    review2TaskId: one(
      "SELECT id FROM tasks WHERE kind = 'e2e7:review' ORDER BY created_at, id LIMIT 1 OFFSET 1",
    ),
    qaTaskId: one("SELECT id FROM tasks WHERE kind = 'e2e7:qa'"),
  };
};

describe('T18-08 chaos — §42 full happy path with a forced crash at every phase', () => {
  it('Goal → Developer → CRASH → restart → Reviewer → CRASH → restart → QA → CRASH → restart → COMPLETE → COMPLETED', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };

    // Phase 1: the work stage executes, then the crash lands inside the work CONTINUE's
    // receipt window.
    let phase = await openPhase(paths, FAULT_CHECKPOINTS.decisionActionBeforeReceipt);
    let started = await startRun(phase.core, phase.actor, 'chaos42');
    let qaTarget = await goalArtifactRefOf(phase.core, started.runId);
    installScript(happyScript(started.workTaskId, qaTarget));
    await expect(runSupervisor(phase.core, started, phase.actor, 'c42')).rejects.toBeInstanceOf(
      FaultCrashError,
    );
    expect(await taskState(phase.core, started.workTaskId)).toBe('DONE');
    closePhase(phase.core);

    // Phase 2 (Sprint21 migration): review executes via the GENERIC ENGINE CLAIM path;
    // the equivalent window is Task/Attempt SETTLED but the carrier NOT yet routed
    // (after_task_settled_before_carrier). Crash matrix + restart reconciliation below.
    phase = await openPhase(paths, FAULT_CHECKPOINTS.taskSettledBeforeCarrier);
    started = readStarted(phase.core, phase.actor);
    qaTarget = await goalArtifactRefOf(phase.core, started.runId);
    installScript(happyScript(started.workTaskId, qaTarget));
    await expect(runSupervisor(phase.core, started, phase.actor, 'c42')).rejects.toBeInstanceOf(
      FaultCrashError,
    );
    {
      // Crash matrix: the review task is DONE, its ExecutionAttempt COMPLETED at
      // attempt 1, Task.attempts unchanged — never re-executed on recovery.
      const rows = await phase.core.database.tasks.listByRun(started.runId);
      const review = rows.find((row) => String(row.stageId) === 'review');
      expect(review?.state).toBe('DONE');
      expect(Number(review?.attempts)).toBe(1);
      const attempts = phase.core.database.db
        .prepare('SELECT state, attempt_number FROM execution_attempts WHERE task_id = ?')
        .all(String(review?.id)) as { state: string; attempt_number: number }[];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.state).toBe('COMPLETED');
      expect(Number(attempts[0]!.attempt_number)).toBe(1);
      // stageOutput durable with the task settlement; carrier/finding NOT yet reconciled.
      expect((review?.outputs['stageOutput'] as unknown) !== undefined).toBe(true);
    }
    closePhase(phase.core);
    {
      // Restart: carrier reconciliation happens BEFORE any next readiness selection —
      // the canonical finding becomes durable without re-executing the review task.
      const phase2 = await openPhase(paths);
      const started2 = readStarted(phase2.core, phase2.actor);
      const qaTarget2 = await goalArtifactRefOf(phase2.core, started2.runId);
      installScript(happyScript(started2.workTaskId, qaTarget2));
      const result2 = (await runSupervisor(phase2.core, started2, phase2.actor, 'c42')) as {
        ok: boolean;
      };
      expect(result2.ok).toBe(true);
      const reviewAfter = (await phase2.core.database.tasks.listByRun(started2.runId)).find(
        (row) => String(row.stageId) === 'review',
      );
      expect(Number(reviewAfter?.attempts)).toBe(1); // DONE never re-executed
      expect(
        (await phase2.core.database.artifactStore!.listByRun(started2.runId as never)).filter(
          (row) => row.kind === 'companyos:review-findings',
        ).length,
      ).toBeGreaterThanOrEqual(1);
      closePhase(phase2.core);
      phase = phase2;
    }

    // Phase 3 (Sprint21 migration): the at-least-once external window — the executor
    // RETURNED but no canonical settlement exists (after_executor_result_before_settlement).
    // A FRESH run exercises it on the first settling task; restart reacquires the SAME
    // attempt (attempts never incremented by recovery) and settles canonically.
    phase = await openPhase(paths, FAULT_CHECKPOINTS.executorResultBeforeSettlement);
    started = await startRun(phase.core, phase.actor, 'chaos42b');
    qaTarget = await goalArtifactRefOf(phase.core, started.runId);
    installScript(happyScript(started.workTaskId, qaTarget));
    await expect(runSupervisor(phase.core, started, phase.actor, 'c42')).rejects.toBeInstanceOf(
      FaultCrashError,
    );
    {
      // Crash matrix (§5 window "executor called / result not durable"): the work task is
      // RUNNING (not settled), its attempt is ACTIVE at attempt 1, attempts = 1, and the
      // executor round DID run — the honest external-outcome-unknown window.
      const rows = await phase.core.database.tasks.listByRun(started.runId);
      const work = rows.find((row) => String(row.stageId) === 'work');
      expect(work?.state).toBe('RUNNING');
      expect(Number(work?.attempts)).toBe(1);
      const attempts = phase.core.database.db
        .prepare('SELECT state, attempt_number FROM execution_attempts WHERE task_id = ?')
        .all(String(work?.id)) as { state: string; attempt_number: number }[];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.state).toBe('ACTIVE');
      expect(Number(attempts[0]!.attempt_number)).toBe(1);
      expect(work?.outputs['stageOutput']).toBeUndefined(); // no canonical settlement yet
    }
    closePhase(phase.core);
    {
      // Restart: startup orphan recovery transitions the attempt to INTERRUPTED, the loop
      // reacquires the SAME attempt (attempts stays 1) and settles canonically.
      const phase3 = await openPhase(paths);
      const started3 = readStarted(phase3.core, phase3.actor);
      const qaTarget3 = await goalArtifactRefOf(phase3.core, started3.runId);
      installScript(happyScript(started3.workTaskId, qaTarget3));
      const result3 = (await runSupervisor(phase3.core, started3, phase3.actor, 'c42')) as {
        ok: boolean;
      };
      expect(result3.ok).toBe(true);
      const workAfter = (await phase3.core.database.tasks.listByRun(started3.runId)).find(
        (row) => String(row.stageId) === 'work',
      );
      expect(workAfter?.state).toBe('DONE');
      expect(Number(workAfter?.attempts)).toBe(1); // same attempt — no recovery increment
      const attemptsAfter = phase3.core.database.db
        .prepare('SELECT state FROM execution_attempts WHERE task_id = ?')
        .all(String(workAfter?.id)) as { state: string }[];
      expect(attemptsAfter).toHaveLength(1);
      expect(attemptsAfter[0]!.state).toBe('COMPLETED');
      closePhase(phase3.core);
      phase = phase3;
    }

    // Phase 4: a FRESH composition completes the run on the same files, the same goal, the
    // same frozen snapshot and the same pinned bindings.
    phase = await openPhase(paths);
    started = readStarted(phase.core, phase.actor);
    qaTarget = await goalArtifactRefOf(phase.core, started.runId);
    installScript(happyScript(started.workTaskId, qaTarget));
    const result = (await runSupervisor(phase.core, started, phase.actor, 'c42')) as {
      ok: boolean;
      value: { stopReason: string };
    };
    expect(result.ok).toBe(true);
    expect(result.value.stopReason).toBe('completed');
    expect((await phase.core.database.runs.get(started.runId as never))?.state).toBe(
      'COMPLETED',
    );
    // No duplicate canonical evidence anywhere. Sprint21: BOTH pre-seeded review tasks
    // run (the DAG selects every open task of the review stage as one unit), so the
    // canonical count is one review-findings report PER review round task — exactly 2.
    const runId = started.runId;
    expect(
      (await phase.core.database.artifactStore!.listByRun(runId as never)).filter(
        (row) => row.kind === 'companyos:review-findings',
      ).length,
    ).toBe(2);
    expect((await phase.core.database.validationStore!.listByRun(runId as never)).length).toBe(
      1,
    );
    const reports = (
      await phase.core.database.artifactStore!.listByRun(runId as never)
    ).filter((row) => row.kind === VALIDATOR_REPORT_KIND);
    expect(reports.length).toBe(1);
    expect(reports[0]!.producedBy).toBe(`validator:${VALIDATOR_ID}@${VALIDATOR_VERSION}`);
    // No duplicate corrective work: zero corrective tasks in the happy chain.
    expect(
      countOf(
        phase.core,
        "SELECT COUNT(*) AS c FROM tasks WHERE inputs_json LIKE '%corrective%'",
      ),
    ).toBe(0);
  });
});

describe('T18-08 chaos — §43 corrective path with forced crashes', () => {
  it('Developer → Reviewer CHANGES → CRASH → restart → REQUEST_CORRECTIVE → T1 → CRASH → restart → Reviewer PASS → QA PASS → COMPLETE', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const changesScript = (subjectTaskId: string, qaTarget: string) => ({
      proposals: [
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review.' },
        {
          action: 'REQUEST_CORRECTIVE',
          reasonCode: 'REVIEW_FINDING',
          summary: 'The reviewer requires corrective work.',
        },
      ],
      reviewOutcomes: [
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Reviewer requests changes.',
          verdict: 'CHANGES_REQUESTED',
          subjectTaskId,
          findings: [
            {
              code: 'semantic.boundary',
              summary: 'Crosses a frozen boundary.',
              detail: 'detail',
              blocking: true,
            },
          ],
        },
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Reviewer pass after the corrective round.',
          verdict: 'PASS',
          subjectTaskId,
          findings: [],
        },
      ],
      qaTarget,
    });

    // Phase 1 (Sprint21 migration): review executes via the generic engine claim path;
    // the equivalent window is settled-before-carrier — the CHANGES finding reconciles
    // on restart BEFORE any next readiness selection.
    let phase = await openPhase(paths, FAULT_CHECKPOINTS.taskSettledBeforeCarrier);
    let started = await startRun(phase.core, phase.actor, 'chaos43');
    let qaTarget = await goalArtifactRefOf(phase.core, started.runId);
    installScript(changesScript(started.workTaskId, qaTarget) as never);
    await expect(runSupervisor(phase.core, started, phase.actor, 'c43')).rejects.toBeInstanceOf(
      FaultCrashError,
    );
    closePhase(phase.core);

    // Phase 2: the CHANGES verdict from the crashed phase is the standing latest review, so
    // the recovered supervisor's legal move is REQUEST_CORRECTIVE: T1 is provisioned and
    // EXECUTED, and the crash lands before its receipt.
    phase = await openPhase(paths, FAULT_CHECKPOINTS.correctiveTaskCommitBeforeReceipt);
    started = readStarted(phase.core, phase.actor);
    qaTarget = await goalArtifactRefOf(phase.core, started.runId);
    // Turns 0 and 1 REPLAY the decisions the crashed phase already recorded (the sink's
    // permanent replay semantics), so only the FIRST FRESH turn reads the script: it must
    // propose the corrective the standing CHANGES verdict calls for.
    installScript({
      proposals: [
        {
          action: 'REQUEST_CORRECTIVE',
          reasonCode: 'REVIEW_FINDING',
          summary: 'The reviewer requires corrective work.',
        },
      ],
      reviewOutcomes: [
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Reviewer requests changes.',
          verdict: 'CHANGES_REQUESTED',
          subjectTaskId: started.workTaskId,
          findings: [
            {
              code: 'semantic.boundary',
              summary: 'Crosses a frozen boundary.',
              detail: 'detail',
              blocking: true,
            },
          ],
        },
      ],
      qaTarget,
    } as never);
    await expect(runSupervisor(phase.core, started, phase.actor, 'c43')).rejects.toBeInstanceOf(
      FaultCrashError,
    );
    const t1Row = phase.core.database.db
      .prepare("SELECT id, inputs_json FROM tasks WHERE inputs_json LIKE '%corrective%'")
      .get() as { id: string; inputs_json: string } | undefined;
    expect(t1Row).toBeDefined();
    const t1Id = t1Row!.id;
    const lineageAtCrash = JSON.parse(String(t1Row!.inputs_json))['corrective'] as Record<
      string,
      unknown
    >;
    closePhase(phase.core);

    // Phase 3: a fresh composition runs the round-two review (PASS), QA and COMPLETE.
    phase = await openPhase(paths);
    started = readStarted(phase.core, phase.actor);
    qaTarget = await goalArtifactRefOf(phase.core, started.runId);
    const passScript = happyScript(t1Id, qaTarget);
    installScript(passScript);
    const result = (await runSupervisor(phase.core, started, phase.actor, 'c43')) as {
      ok: boolean;
      value: { stopReason: string };
    };
    expect(result.ok).toBe(true);
    expect(result.value.stopReason).toBe('completed');
    expect((await phase.core.database.runs.get(started.runId as never))?.state).toBe(
      'COMPLETED',
    );
    // The T1 lineage is UNCHANGED by the crashes: same identity, parent, root, round.
    const after = phase.core.database.db
      .prepare("SELECT id, inputs_json FROM tasks WHERE inputs_json LIKE '%corrective%'")
      .all() as { id: string; inputs_json: string }[];
    // Sprint21: the LIKE matches the ROOT corrective + producer/descendant reassessments
    // (all carry the lineage key). Filter to the ROOT corrective (no reassessment marker).
    const rootAfter = after.filter(
      (row) => JSON.parse(String(row.inputs_json))['companyos:reassessment'] === undefined,
    );
    expect(rootAfter.length).toBe(1);
    expect(rootAfter[0]!.id).toBe(t1Id);
    const after0 = rootAfter;
    const lineageAfter = JSON.parse(String(after0[0]!.inputs_json))['corrective'] as Record<
      string,
      unknown
    >;
    expect(lineageAfter['round']).toBe(lineageAtCrash['round']);
    expect(lineageAfter['parentTaskId']).toBe(lineageAtCrash['parentTaskId']);
    expect(lineageAfter['rootTaskId']).toBe(lineageAtCrash['rootTaskId']);
    expect(lineageAfter['originDecisionId']).toBe(lineageAtCrash['originDecisionId']);
  });
});

describe('T18-08 chaos — §44 human stop scenario', () => {
  it('round exhaustion → REWORK.EXHAUST → PAUSED → CRASH → restart: still PAUSED, zero model calls, then exactly one RUN.RESUME continuation', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const phase = await openPhase(paths, FAULT_CHECKPOINTS.reworkExhaustBeforeReturn);
    const started = await startRun(phase.core, phase.actor, 'chaos44');
    const qaTarget = await goalArtifactRefOf(phase.core, started.runId);
    // A third and fourth review task so four rounds exist.
    for (let index = 0; index < 2; index += 1) {
      const { createTask } = await import('@companyos/core');
      const task = await createTask({
        runId: started.runId as never,
        stageId: 'review' as never,
        roleId: 'rol_reviewer' as never,
        kind: 'e2e7:review',
        now: new Date().toISOString(),
        ids: phase.core.ids,
      });
      if (!task.ok) throw new Error(task.error.message);
      await phase.core.database.tasks.put(task.value);
    }
    const roundScript = (withWork: boolean) => ({
      proposals: [
        ...(withWork
          ? [{ action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' }]
          : []),
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review round.' },
        {
          action: 'REQUEST_CORRECTIVE',
          reasonCode: 'REVIEW_FINDING',
          summary: 'The reviewer requires corrective work.',
        },
        // The immediate-corrective cycle in one invocation: each CONTINUE executes the next
        // DAG unit (a review round / its reassessment — a durable finding), each
        // REQUEST_CORRECTIVE cites that round's corpus evidence and lands the next round.
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Settle the round.' },
        {
          action: 'REQUEST_CORRECTIVE',
          reasonCode: 'REVIEW_FINDING',
          summary: 'The reviewer requires corrective work.',
        },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Settle the round.' },
        {
          action: 'REQUEST_CORRECTIVE',
          reasonCode: 'REVIEW_FINDING',
          summary: 'The reviewer requires corrective work.',
        },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Settle the round.' },
        {
          action: 'REQUEST_CORRECTIVE',
          reasonCode: 'REVIEW_FINDING',
          summary: 'The reviewer requires corrective work.',
        },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Settle the round.' },
        {
          action: 'REQUEST_CORRECTIVE',
          reasonCode: 'REVIEW_FINDING',
          summary: 'The reviewer requires corrective work.',
        },
      ],
      reviewOutcomes: [
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Reviewer requests changes.',
          verdict: 'CHANGES_REQUESTED',
          // No pinned subjectTaskId: the fake follows the subject the last turn anchored —
          // each corrective round reviews ITS OWN durable corrective work.
          findings: [{ code: 'a.b', summary: 'A finding.', detail: 'd', blocking: true }],
        },
      ],
      qaTarget,
    });
    const newest = (): string => {
      const rows = phase.core.database.db
        .prepare('SELECT id, inputs_json FROM tasks')
        .all() as { id: string; inputs_json: string }[];
      let best: { id: string; round: number } | null = null;
      for (const row of rows) {
        const lineage = JSON.parse(String(row.inputs_json))['corrective'] as
          | { round?: unknown }
          | undefined;
        if (lineage === undefined || typeof lineage['round'] !== 'number') continue;
        if (best === null || Number(lineage['round']) > best.round) {
          best = { id: row.id, round: Number(lineage['round']) };
        }
      }
      return (best ?? { id: started.workTaskId }).id;
    };
    /*
     * Sprint21 generic orchestration — §44 exhaustion. The immediate-corrective applicator
     * provisions AND executes each round inside the apply, so ONE invocation drives the
     * whole cycle; the model alternates the two legal shapes: CONTINUE executes the next
     * DAG unit (the review round: a durable finding), REQUEST_CORRECTIVE cites that round's
     * corpus evidence and lands the next corrective. Rounds 1-3 apply; round 4 is refused
     * at the cap, the durable human stop commits (PAUSED) and THEN the crash fires — so a
     * restart sees PAUSED, spends zero model turns, and the trusted RESUME is the only
     * way on. No out-of-band evidence: the fake cites only the current corpus.
     */
    installScript(roundScript(true) as never);
    // Rounds 1-3 apply; round 4 is refused at the cap, the durable human stop commits
    // (PAUSED) and THEN the crash fires — the orchestrator never returns.
    await expect(
      runSupervisor(phase.core, started, phase.actor, 'chaos44-exhaust', started.workTaskId),
    ).rejects.toBeInstanceOf(FaultCrashError);
    expect((await phase.core.database.runs.get(started.runId as never))?.state).toBe('PAUSED');
    const decisionsAtCrash = countOf(phase.core, 'SELECT COUNT(*) AS c FROM decisions');
    void newest;
    closePhase(phase.core);

    // Restart: still PAUSED, ZERO model calls (the decision count cannot move).
    const again = await openPhase(paths);
    expect((await again.core.database.runs.get(started.runId as never))?.state).toBe('PAUSED');
    installScript(roundScript(false) as never);
    const stopped = (await runSupervisor(again.core, started, again.actor, 'h5')) as {
      ok: boolean;
      value: { stopReason: string; turns: number };
    };
    expect(stopped.ok).toBe(true);
    expect(stopped.value.stopReason).toBe('human_required');
    expect(stopped.value.turns).toBe(0);
    expect(countOf(again.core, 'SELECT COUNT(*) AS c FROM decisions')).toBe(decisionsAtCrash);

    // The trusted RUN.RESUME: exactly one continuation.
    const pausedRun = await again.core.database.runs.get(started.runId as never);
    if (pausedRun === null) throw new Error('run missing');
    const resumed = await again.core.sprint13.engine.dispatch({
      commandId: `t18f-chaos-resume:${started.runId}`,
      runId: started.runId,
      type: 'RUN.RESUME',
      expectedRevision: pausedRun.revision,
      actorId: again.actor,
      traceId: 't18f_chaos_resume',
      issuedAt: new Date().toISOString(),
      reason: 'human re-decision after exhaustion',
    });
    expect(resumed.ok).toBe(true);
    expect((await again.core.database.runs.get(started.runId as never))?.state).not.toBe(
      'PAUSED',
    );
    const runNow = await again.core.database.runs.get(started.runId as never);
    if (runNow === null) throw new Error('run missing');
    const second = await again.core.sprint13.engine.dispatch({
      commandId: `t18f-chaos-resume-2:${started.runId}`,
      runId: started.runId,
      type: 'RUN.RESUME',
      expectedRevision: runNow.revision,
      actorId: again.actor,
      traceId: 't18f_chaos_resume2',
      issuedAt: new Date().toISOString(),
      reason: 'a second continuation attempt',
    });
    expect(second.ok).toBe(false);
  });
});
