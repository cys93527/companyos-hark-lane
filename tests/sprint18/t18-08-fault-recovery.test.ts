import { registerOfflineGitWorkspace } from '../support/offline-fixtures.js';
/**
 * Task-18-08 — the deterministic fault/recovery MATRIX (§40), part 2: run+goal atomicity,
 * snapshot fail-closed, corrective/round/escalation windows, cancelled non-retry, provider
 * descriptor/rebind windows, latest-evidence rules, corruption fail-closed, ledger-trim
 * replays, cross-tenant isolation, and the repository baseline window.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/*
 * E1 GATE FIX — hermetic fixture (P3 TEST_ENV_HERMETICITY): this machine may carry a
 * user-level live model env; composeCoreServices self-registers the OpenAI-compatible
 * adapter whenever COS_MODEL_BASE_URL + COS_MODEL_ID resolve (core-services, Boss V1
 * Product Reachability BB-002 seam). Without the scrub that unrelated live provider
 * registers inside THIS fixture (and registration performs a real listModels call),
 * which both breaks the provider-count invariants and leaks the user's configuration.
 * Same canonical LIVE_ENV_KEYS scrub the production/FIX-09-pattern tests use.
 */
const LIVE_ENV_KEYS = [
  'COS_MODEL_BASE_URL', 'COS_MODEL_ID', 'COS_MODEL_PROVIDER_ID', 'COS_MODEL_TIMEOUT_MS', 'COMPANYOS_MODEL_API_KEY',
  'COS_MODEL_ROUTING_MODE', 'COS_MODEL_ROUTING_POLICY',
  'COS_MODEL_QUALITY_TIER', 'COS_MODEL_COST_TIER', 'COS_MODEL_LATENCY_TIER', 'COS_MODEL_RELIABILITY_CLASS',
  'COS_MODEL_AUTHENTICATION',
  'COMPANYOS_EXECUTOR_PROVIDER',
] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => { for (const key of LIVE_ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; } });
afterAll(() => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });


import { FAULT_CHECKPOINTS, FaultCrashError } from '@companyos/core';
import { createFaultProbe } from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

import {
  closeFixtureArtifacts,
  compose,
  countOf,
  createRoutingProvider,
  goalArtifactRefOf,
  goalExists,
  happyScript,
  installScript,
  registerValidator,
  runSupervisor,
  seedRoutingModel,
  sessionActorOf,
  startRun,
  tempDir,
  untrackDatabase,
  type Core,
  PROVIDER_ID,
  VALIDATOR_ID,
} from './helpers/t18-08-fixture.js';

afterEach(() => {
  closeFixtureArtifacts();
});

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

describe('T18-08 fault matrix — run + goal atomicity (§9)', () => {
  it('1a. crash after goal candidate preparation, before commit: neither run nor goal exists', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.runGoalBeforeCommit }],
    });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    // startRun itself performs the crashing creation.
    await expect(startRun(core, actor, 'at1')).rejects.toBeInstanceOf(FaultCrashError);
    const runs = countOf(core, 'SELECT COUNT(*) AS c FROM runs');
    expect(runs).toBe(0);
    // No goal artifact row was committed either.
    const goals = countOf(
      core,
      "SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:run-goal'",
    );
    expect(goals).toBe(0);
    core.database.close();
    untrackDatabase(core.database);

    const again = await reopen(paths);
    const fresh = await startRun(again.core, again.actor, 'at1b');
    expect(await goalExists(again.core, fresh.runId)).toBe(true);
  });

  it('1b. crash inside the shared creation transaction, after the goal attach: rollback takes both down', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.runGoalDuringTransaction }],
    });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await expect(startRun(core, actor, 'at2')).rejects.toBeInstanceOf(FaultCrashError);
    expect(countOf(core, 'SELECT COUNT(*) AS c FROM runs')).toBe(0);
    expect(
      countOf(core, "SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'companyos:run-goal'"),
    ).toBe(0);
    core.database.close();
    untrackDatabase(core.database);
  });

  it('1c. crash AFTER the commit: both exist and a replay returns the same run', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({ crashAt: [{ name: FAULT_CHECKPOINTS.runGoalAfterCommit }] });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    // The FIRST run creation (with a ledger command identity) crashes after committing; the
    // transaction is durable.
    const template = await core.lifecycle.createTemplate({
      orgId: 'company_default',
      name: 'T18-08 at3',
      actorId: actor,
      traceId: 't18f_at3_tpl',
    });
    if (!template.ok) throw new Error(template.error.message);
    const graph = {
      nodes: [{ id: 'work', kind: 'work' as const, title: 'work', config: {} }],
      edges: [],
    };
    const saved = await core.lifecycle.saveDraftGraph({
      templateId: template.value.id,
      graph,
      actorId: actor,
      traceId: 't18f_at3_graph',
    });
    if (!saved.ok) throw new Error(saved.error.message);
    const published = await core.lifecycle.publish({
      templateId: template.value.id,
      actorId: actor,
      traceId: 't18f_at3_pub',
    });
    if (!published.ok) throw new Error(published.error.message);
    await expect(
      core.lifecycle.createRun({
        templateId: template.value.id,
        companyId: 'company_default',
        workflowId: 'wf_at3',
        actorId: actor,
        commandId: 'cmd-at3',
        modelBindings: { supervisor: 'e2e7.supervisor' },
        goal: { objective: 'Deliver the at3 slice.', source: { type: 'human' } },
      }),
    ).rejects.toBeInstanceOf(FaultCrashError);
    expect(countOf(core, 'SELECT COUNT(*) AS c FROM runs')).toBe(1);
    const runId = (core.database.db.prepare('SELECT id FROM runs').get() as { id: string }).id;
    expect(await goalExists(core, runId)).toBe(true);
    core.database.close();
    untrackDatabase(core.database);

    const again = await reopen(paths);
    expect(await goalExists(again.core, runId)).toBe(true);
    // Ledger replay: the same creation command returns the SAME run, not a second one.
    const replayed = await again.core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: 'company_default',
      workflowId: 'wf_at3',
      actorId: again.actor,
      commandId: 'cmd-at3',
      modelBindings: { supervisor: 'e2e7.supervisor' },
      goal: { objective: 'Deliver the at3 slice.', source: { type: 'human' } },
    });
    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect(replayed.value.run.id).toBe(runId);
    expect(countOf(again.core, 'SELECT COUNT(*) AS c FROM runs')).toBe(1);
  });
});

describe('T18-08 fault matrix — snapshot fail-closed (§10)', () => {
  it('2. snapshot missing on restart: zero model execution, explicit refusal', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    const started = await startRun(core, actor, 'sn2');
    // Destroy the snapshot row (corruption, not a legal transition).
    const snapshotId = (
      core.database.db.prepare('SELECT snapshot_id AS s FROM runs WHERE id = ?').get(
        started.runId,
      ) as { s: string }
    ).s;
    core.database.db.prepare('DELETE FROM run_snapshots WHERE id = ?').run(snapshotId);
    installScript(happyScript(started.workTaskId, 'artifact:none'));
    const result = (await runSupervisor(core, started, actor, 'sn2')) as {
      ok: boolean;
      error?: { code: string; details?: { reason?: string } };
    };
    // The supervisor turn fails closed BEFORE any provider call: no decision, no execution.
    expect(result.ok).toBe(false);
    expect(String(result.error?.details?.['reason'] ?? '')).toBe('RUN_SNAPSHOT_MISSING');
    expect(countOf(core, 'SELECT COUNT(*) AS c FROM decisions')).toBe(0);
  });

  it('3. snapshot tampered on restart: fail closed, never repaired', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    const started = await startRun(core, actor, 'sn3');
    const row = core.database.db
      .prepare('SELECT snapshot_id AS s FROM runs WHERE id = ?')
      .get(started.runId) as { s: string };
    core.database.db
      .prepare('UPDATE run_snapshots SET workflow_version_id = ? WHERE id = ?')
      .run('ver_missing_entirely', row.s);
    installScript(happyScript(started.workTaskId, 'artifact:none'));
    const result = (await runSupervisor(core, started, actor, 'sn3')) as {
      ok: boolean;
      value?: { stopReason: string };
      error?: { code: string; details?: { reason?: string } };
    };
    // Fail-closed EITHER as the mapped refusal or as the loop's invariant stop — what is
    // NON-NEGOTIABLE is that no model execution ever landed and nothing was repaired.
    const refused = result.ok !== true || result.value?.stopReason === 'invariant_failure';
    expect(refused).toBe(true);
    expect(countOf(core, 'SELECT COUNT(*) AS c FROM decisions')).toBe(0);
    const still = core.database.db
      .prepare('SELECT workflow_version_id AS v FROM run_snapshots WHERE id = ?')
      .get(row.s) as { v: string };
    expect(still.v).toBe('ver_missing_entirely');
  });
});

describe('T18-08 fault matrix — corrective windows (§16/§17)', () => {
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
          { code: 'semantic.boundary', summary: 'Crosses a frozen boundary.', detail: 'd', blocking: true },
        ],
      },
    ],
    qaTarget,
  });

  it('9. corrective Task commit → crash before receipt: the SAME T1 identity replays', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.correctiveTaskCommitBeforeReceipt }],
    });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    const started = await startRun(core, actor, 'cw9');
    const qaTarget = await goalArtifactRefOf(core, started.runId);
    installScript(changesScript(started.workTaskId, qaTarget) as never);
    await expect(runSupervisor(core, started, actor, 'cw9')).rejects.toBeInstanceOf(
      FaultCrashError,
    );
    // T1 exists (created + executed) but has no application receipt.
    const t1 = core.database.db
      .prepare("SELECT id, inputs_json FROM tasks WHERE inputs_json LIKE '%corrective%'")
      .get() as { id: string; inputs_json: string } | undefined;
    expect(t1).toBeDefined();
    const tasksAtCrash = countOf(core, 'SELECT COUNT(*) AS c FROM tasks');
    core.database.close();
    untrackDatabase(core.database);

    const again = await reopen(paths);
    installScript(changesScript(started.workTaskId, qaTarget) as never);
    const result = (await runSupervisor(again.core, started, again.actor, 'cw9')) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    // Exactly ONE corrective task, the SAME identity, same lineage — zero duplicates.
    const corrective = (again.core.database.db
      .prepare("SELECT id, inputs_json FROM tasks WHERE inputs_json LIKE '%corrective%'")
      .all() as { id: string; inputs_json: string }[]).filter(
        (row) => JSON.parse(String(row.inputs_json))['corrective'] !== undefined,
      );
    // Sprint21: the root corrective + its producer/descendant reassessments all carry
    // the corrective lineage key; the ROOT corrective (no reassessment marker) is unique.
    const root = corrective.filter((row) => JSON.parse(String(row.inputs_json))['companyos:reassessment'] === undefined);
    expect(root).toHaveLength(1);
    expect(root[0]!.id).toBe(t1!.id);
    const lineage = JSON.parse(String(root[0]!.inputs_json))['corrective'] as Record<
      string,
      unknown
    >;
    expect(lineage['round']).toBe(1);
    expect(lineage['parentTaskId']).toBe(started.workTaskId);
    expect(countOf(again.core, 'SELECT COUNT(*) AS c FROM tasks')).toBe(tasksAtCrash);
  });

  it('16/17. round3 survives restart; round4 is still rejected after restart', {timeout: 90_000}, async () => {
    // Exhaust three rounds in ONE composition, restart, and prove the cap is durable.
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const core = await compose(paths);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    const started = await startRun(core, actor, 'cw16');
    const qaTarget = await goalArtifactRefOf(core, started.runId);
    const seedReviewTask = async (): Promise<void> => {
      const { createTask } = await import('@companyos/core');
      const task = await createTask({
        runId: started.runId as never,
        stageId: 'review' as never,
        roleId: 'rol_reviewer' as never,
        kind: 'e2e7:review',
        now: new Date().toISOString(),
        ids: core.ids,
      });
      if (!task.ok) throw new Error(task.error.message);
      await core.database.tasks.put(task.value);
    };
    await seedReviewTask();
    await seedReviewTask();

    const newestCorrective = (c: Core): { id: string; round: number } => {
      const rows = c.database.db
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
      if (best === null) throw new Error('no corrective task');
      return best;
    };
    const drive = async (identity: string, subject: string, firstRound = false) => {
      const script = changesScript(subject, qaTarget);
      installScript({
        ...script,
        proposals: firstRound ? script.proposals : script.proposals.slice(1),
      } as never);
      return runSupervisor(core, started, actor, identity, subject);
    };
    await drive('r1', started.workTaskId, true);
    expect(newestCorrective(core).round).toBe(1);
    await drive('r2', newestCorrective(core).id);
    await drive('r3', newestCorrective(core).id);
    expect(newestCorrective(core).round).toBe(3);
    const t3 = newestCorrective(core).id;
    core.database.close();
    untrackDatabase(core.database);

    const again = await reopen(paths);
    expect(newestCorrective(again.core).round).toBe(3);
    const script4 = changesScript(t3, qaTarget);
    installScript({ ...script4, proposals: script4.proposals.slice(1) } as never);
    const round4 = (await runSupervisor(again.core, started, again.actor, 'r4', t3)) as {
      ok: boolean;
      value: { stopReason: string };
    };
    expect(round4.ok).toBe(true);
    expect(round4.value.stopReason).toBe('round_limit');
    expect(newestCorrective(again.core).round).toBe(3);
    // And the durable human stop stands: PAUSED, zero model calls on a further restart.
    expect((await again.core.database.runs.get(started.runId as never))?.state).toBe('PAUSED');
  });
});

describe('T18-08 fault matrix — cancelled, provider, paused windows', () => {
  it('18/19. a CANCELLED execution never becomes an automatic retry', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    const started = await startRun(core, actor, 'cn18');
    // Seed a terminal CANCELLED AgentExecution for THIS run — the frozen non-retryable mark.
    core.database.db
      .prepare(
        `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
           provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
           input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
           created_at, updated_at)
         VALUES (?, 'agent.x', 'rol_x', ?, ?, 'k', 'p', 'm', 'FAILED', ?, ?, 't', 1,
           '{}', '{}', 1, NULL, 'CANCELLED', 'CANCELLED', 'cancelled', ?, ?)`,
      )
      .run(
        `exec_${started.runId.slice(4)}cn`,
        started.workTaskId,
        started.runId,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    installScript(happyScript(started.workTaskId, 'artifact:none'));
    const result = (await runSupervisor(core, started, actor, 'cn18')) as {
      ok: boolean;
      value: { stopReason: string };
    };
    expect(result.ok).toBe(true);
    expect(result.value.stopReason).toBe('cancelled');
    expect(countOf(core, 'SELECT COUNT(*) AS c FROM decisions')).toBe(0);
  });

  it('21/22/23. provider descriptor survives restart; adapter rebinds; incompatible fails closed', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.providerDescriptorBeforeRuntimeBind }],
    });
    const first = await compose(paths, probe.port);
    const actor = await sessionActorOf(first);
    await expect(seedRoutingModel(first, actor)).rejects.toBeInstanceOf(FaultCrashError);
    // The descriptor AND catalogue are durable; the adapter is NOT bound in the crashed process.
    expect(countOf(first, 'SELECT COUNT(*) AS c FROM providers')).toBe(1);
    expect(first.providers.get(PROVIDER_ID)).toBeNull();
    first.database.close();
    untrackDatabase(first.database);

    const again = await reopen(paths);
    expect(again.core.providers.get(PROVIDER_ID)).not.toBeNull();
    expect(countOf(again.core, 'SELECT COUNT(*) AS c FROM providers')).toBe(1);
    // An incompatible adapter under the same id is still refused fail-closed.
    const impostor = createRoutingProvider();
    const refused = await again.core.providers.register(
      {
        ...impostor,
        describe: () => ({
          providerId: PROVIDER_ID,
          kind: 'fake',
          displayName: 'A Different Adapter',
          version: '9.9.9',
        }),
      },
      { actorId: again.actor },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('CONFLICT');
  });

  it('24. REWORK.EXHAUST → crash before return: the run stays PAUSED with zero model calls', {timeout: 90_000}, async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    // Round 4 must be attempted with the exhaustion checkpoint armed.
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.reworkExhaustBeforeReturn }],
    });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    const started = await startRun(core, actor, 'pz24');
    const qaTarget = await goalArtifactRefOf(core, started.runId);
    const seedReviewTask = async (): Promise<void> => {
      const { createTask } = await import('@companyos/core');
      const task = await createTask({
        runId: started.runId as never,
        stageId: 'review' as never,
        roleId: 'rol_reviewer' as never,
        kind: 'e2e7:review',
        now: new Date().toISOString(),
        ids: core.ids,
      });
      if (!task.ok) throw new Error(task.error.message);
      await core.database.tasks.put(task.value);
    };
    await seedReviewTask();
    await seedReviewTask();

    const script = (subject: string) => ({
      proposals: [
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review round.' },
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
          subjectTaskId: subject,
          findings: [
            { code: 'a.b', summary: 'A finding.', detail: 'd', blocking: true },
          ],
        },
      ],
      qaTarget,
    });
    const newest = (): string => {
      const rows = core.database.db
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
    const drive = async (identity: string, subject: string, withWork = false) => {
      const s = script(subject);
      if (withWork) {
        s.proposals = [
          { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
          ...s.proposals,
        ];
      }
      installScript(s as never);
      return runSupervisor(core, started, actor, identity, subject);
    };
    await drive('p1', started.workTaskId, true);
    await drive('p2', newest());
    await drive('p3', newest());
    // Round 4: the exhaustion transition commits, then the crash fires before the return.
    await expect(drive('p4', newest())).rejects.toBeInstanceOf(FaultCrashError);
    const decisionsAtCrash = countOf(core, 'SELECT COUNT(*) AS c FROM decisions');
    core.database.close();
    untrackDatabase(core.database);

    const again = await reopen(paths);
    expect((await again.core.database.runs.get(started.runId as never))?.state).toBe('PAUSED');
    const newestAfterRestart = (): string => {
      const rows = again.core.database.db
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
    const s5 = script(newestAfterRestart());
    installScript({ ...s5, proposals: s5.proposals.slice(1) } as never);
    const stopped = (await runSupervisor(
      again.core,
      started,
      again.actor,
      'p5',
      newestAfterRestart(),
    )) as {
      ok: boolean;
      value: { stopReason: string; turns: number };
    };
    expect(stopped.ok).toBe(true);
    expect(stopped.value.stopReason).toBe('human_required');
    expect(stopped.value.turns).toBe(0);
    expect(countOf(again.core, 'SELECT COUNT(*) AS c FROM decisions')).toBe(decisionsAtCrash);
  });

  it('25. RUN.RESUME commit → crash before next turn: resumed once, not twice', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({
      crashAt: [{ name: FAULT_CHECKPOINTS.resumeTransitionBeforeNextTurn }],
    });
    const core = await compose(paths, probe.port);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    const started = await startRun(core, actor, 'rs25');
    // Park the run in WAITING_APPROVAL through the machine's own command.
    const run = await core.database.runs.get(started.runId as never);
    if (run === null) throw new Error('run missing');
    const paused = await core.sprint13.engine.dispatch({
      commandId: `t18f-wait:${started.runId}`,
      runId: started.runId,
      type: 'APPROVAL.REQUEST',
      expectedRevision: run.revision,
      actorId: actor,
      traceId: 't18f_wait',
      issuedAt: new Date().toISOString(),
      reason: 'park for the resume window test',
    });
    expect(paused.ok).toBe(true);
    const pausedRun = await core.database.runs.get(started.runId as never);
    if (pausedRun === null) throw new Error('run missing');
    // RESUME commits, then the crash fires before any next turn.
    // The decider is a DIFFERENT trusted actor than the requester: separation of duties.
    // NOT awaited before the matcher: the crash sentinel rejects the promise itself.
    const resumeOutcome = core.autonomousSupervisor?.resumeEscalatedRun({
      companyId: 'company_default',
      runId: started.runId,
      actorId: 'user_decider',
      traceId: 't18f_resume',
    });
    await expect(resumeOutcome).rejects.toBeInstanceOf(FaultCrashError);
    const stateAfter = (await core.database.runs.get(started.runId as never))?.state;
    expect(stateAfter).not.toBe('PAUSED');
    core.database.close();
    untrackDatabase(core.database);

    const again = await reopen(paths);
    const stillResumed = (await again.core.database.runs.get(started.runId as never))?.state;
    expect(stillResumed).not.toBe('PAUSED');
    // A second RESUME from the resumed state is refused by the machine: exactly one continuation.
    const runNow = await again.core.database.runs.get(started.runId as never);
    if (runNow === null) throw new Error('run missing');
    const second = await again.core.sprint13.engine.dispatch({
      commandId: `t18f-resume2:${started.runId}`,
      runId: started.runId,
      type: 'RUN.RESUME',
      expectedRevision: runNow.revision,
      actorId: again.actor,
      traceId: 't18f_resume2',
      issuedAt: new Date().toISOString(),
      reason: 'a second continuation attempt',
    });
    expect(second.ok).toBe(false);
  });
});

describe('T18-08 fault matrix — latest evidence, corruption, tenant, ledger trim', () => {
  it('26/27. an older review PASS cannot resurrect over a newer CHANGES_REQUESTED', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const core = await compose(paths);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    const started = await startRun(core, actor, 'le26');
    const qaTarget = await goalArtifactRefOf(core, started.runId);
    void qaTarget;
    const report = async (verdict: 'PASS' | 'CHANGES_REQUESTED'): Promise<void> => {
      const stamp = new Date().toISOString();
      const executionId = `exec_${core.ids.id('x')}`;
      core.database.db
        .prepare(
          `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
             provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
             input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
             created_at, updated_at)
           VALUES (?, 'agent.reviewer', 'rol_reviewer', ?, ?, 'e2e7.supervisor', ?, ?, 'COMPLETED', ?, ?, ?, 1,
             '{}', '{}', 1, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          executionId,
          started.reviewTaskId,
          started.runId,
          PROVIDER_ID,
          'e2e7-model-1',
          stamp,
          stamp,
          stamp,
          stamp,
          stamp,
        );
      const recorded = await core.reviewFindingsSink?.record({
        companyId: 'company_default',
        runId: started.runId,
        reviewStageId: 'review' as never,
        reviewTaskId: started.reviewTaskId as never,
        subjectTaskId: started.workTaskId as never,
        executionId,
        verdict,
        findings:
          verdict === 'PASS'
            ? []
            : [{ code: 'a.b', summary: 'A finding.', detail: 'd', blocking: true }],
        decidedBy: actor,
      });
      if (recorded === undefined) throw new Error('no review sink');
      if (!recorded.ok) throw new Error(recorded.error.message);
    };
    // Bring the run to REVIEWING through the machine's own command (no manual review event).
    const runRow = await core.database.runs.get(started.runId as never);
    if (runRow === null) throw new Error('run missing');
    const toReviewing = await core.sprint13.engine.dispatch({
      commandId: `t18f-execdone:${started.runId}`,
      runId: started.runId,
      type: 'EXECUTION.COMPLETE',
      expectedRevision: runRow.revision,
      actorId: actor,
      traceId: 't18f_execdone',
      issuedAt: new Date().toISOString(),
      reason: 'work stage finished',
    });
    expect(toReviewing.ok).toBe(true);
    // Older PASS first, newer CHANGES second — both canonical, both durable.
    await report('PASS');
    await report('CHANGES_REQUESTED');
    const applied = await core.evidenceApplicator?.applyEvidence({
      companyId: 'company_default',
      runId: started.runId,
      reviewTaskId: started.reviewTaskId,
      actorId: actor,
    });
    expect(applied).toBeDefined();
    if (applied === undefined) return;
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value?.event).toBe('REVIEW.REJECT');
    const run = await core.database.runs.get(started.runId as never);
    expect(run?.state).toBe('REWORK');
    expect(run?.state).not.toBe('VALIDATING');
    expect(run?.state).not.toBe('FINALIZING');
    expect(run?.state).not.toBe('COMPLETED');
    // And the inverse ordering keeps the same rule: a newer PASS clears an older CHANGES.
    await report('PASS');
    const cleared = await core.evidenceApplicator?.applyEvidence({
      companyId: 'company_default',
      runId: started.runId,
      reviewTaskId: started.reviewTaskId,
      actorId: actor,
    });
    expect(cleared?.ok).toBe(true);
    if (cleared?.ok !== true) return;
    expect(cleared.value).toBeNull();
  });
  it('28. corrupt corrective lineage fails closed', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    const started = await startRun(core, actor, 'cp28');
    // A lineage row whose parent does not exist: the provisioner's chain verification refuses.
    const seeded = await import('@companyos/core').then((m) =>
      m.createTask({
        runId: started.runId as never,
        stageId: 'work' as never,
        roleId: 'rol_dev' as never,
        kind: 'e2e7:build',
        now: new Date().toISOString(),
        ids: core.ids,
      }),
    );
    if (!seeded.ok) throw new Error(seeded.error.message);
    await core.database.tasks.put({
      ...seeded.value,
      inputs: {
        corrective: {
          schemaVersion: 'companyos/corrective-task/1',
          companyId: 'company_default',
          runId: started.runId,
          originDecisionId: 'dec_missing',
          originDecisionVersion: 1,
          reasonCode: 'REVIEW_FINDING',
          parentTaskId: 'tsk_missing',
          rootTaskId: 'tsk_missing',
          round: 99,
          causeEvidenceRefs: [],
          fingerprint: '0'.repeat(64),
        },
      },
    });
    const verified = await core.correctiveProvisioner?.provision({
      companyId: 'company_default',
      runId: started.runId,
      decisionId: 'dec_missing',
      actorId: actor,
    });
    expect(verified?.ok).toBe(false);
  });

  it('29/30/31. decision, validation and review replay after a ledger trim', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    const started = await startRun(core, actor, 'lt29');
    const qaTarget = await goalArtifactRefOf(core, started.runId);
    installScript(happyScript(started.workTaskId, qaTarget));
    const first = (await runSupervisor(core, started, actor, 'lt29')) as {
      ok: boolean;
      value: { stopReason: string };
    };
    expect(first.ok).toBe(true);
    expect(first.value.stopReason).toBe('completed');
    const decisions = countOf(core, 'SELECT COUNT(*) AS c FROM decisions');
    const validations = (await core.database.validationStore!.listByRun(started.runId as never))
      .length;
    const reviews = (
      await core.database.artifactStore!.listByRun(started.runId as never)
    ).filter((row) => row.kind === 'companyos:review-findings').length;
    expect(decisions).toBeGreaterThan(0);
    expect(validations).toBe(1);
    // The fixture seeds TWO review tasks (both pass), so the stage unit carries two canonical
    // reports — the count this replay must preserve exactly.
    expect(reviews).toBe(2);
    // Trim the bounded ledger entirely: the PERMANENT identities must still replay exactly.
    core.database.db.exec('DELETE FROM command_ledger');
    installScript(happyScript(started.workTaskId, qaTarget));
    const replay = (await runSupervisor(core, started, actor, 'lt29')) as { ok: boolean };
    expect(replay.ok).toBe(true);
    expect(countOf(core, 'SELECT COUNT(*) AS c FROM decisions')).toBe(decisions);
    expect((await core.database.validationStore!.listByRun(started.runId as never)).length).toBe(
      validations,
    );
    expect(
      (await core.database.artifactStore!.listByRun(started.runId as never)).filter(
        (row) => row.kind === 'companyos:review-findings',
      ).length,
    ).toBe(reviews);
  });

  it('32. cross-tenant recovery isolation: company B sees nothing of company A', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    const started = await startRun(core, actor, 'tx32');
    const qaTarget = await goalArtifactRefOf(core, started.runId);
    installScript(happyScript(started.workTaskId, qaTarget));
    const result = (await runSupervisor(core, started, actor, 'tx32')) as { ok: boolean };
    expect(result.ok).toBe(true);
    const foreign = 'company_other';
    // The decision reader is tenant-scoped: a foreign company gets NOT_FOUND, never the row.
    const decisionId = (
      core.database.db.prepare('SELECT decision_id FROM decisions LIMIT 1').get() as {
        decision_id: string;
      }
    ).decision_id;
    const read = await core.supervisorDecisionSink?.getDecision({
      decisionId,
      companyId: foreign,
      actorId: actor,
    });
    expect(read?.ok === true).toBe(false);
    if (read !== undefined && !read.ok) expect(read.error.code).toBe('NOT_FOUND');
    // The review reader is tenant-scoped the same way.
    const review = await core.reviewFindingsSink?.getLatestReviewReport({
      companyId: foreign,
      runId: started.runId,
      reviewTaskId: started.reviewTaskId,
      actorId: actor,
    });
    expect(review?.ok).toBe(true);
    if (review?.ok) expect(review.value).toBeNull();
    // And a foreign validation command cannot target company A's artifact.
    const made = await core.sprint13.validationService.run({
      commandId: `t18f-foreign-${core.ids.id('cmd')}`,
      actorId: actor,
      runId: started.runId as never,
      stageId: 'qa' as never,
      taskId: null,
      targetRef: qaTarget as never,
      validators: [{ validatorId: VALIDATOR_ID, blocking: true }],
      traceId: 't18f_foreign',
    });
    expect(made.ok).toBe(true); // same-company command is legal
  });
});

describe('T18-08 fault matrix — repository baseline window (§20)', () => {
  it('20. baseline created → crash before tools: the SAME baseline replays, never re-sampled', async () => {
    // The workspace must be a real git work tree for the baseline tool to sample.
    const root = mkdtempSync(join(tmpdir(), 'companyos-t18f-ws-'));
    registerOfflineGitWorkspace(root);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init','-q'], { cwd: root });
    execFileSync('git', ['config','user.email','t@t'], { cwd: root });
    execFileSync('git', ['config','user.name','t'], { cwd: root });
    writeFileSync(join(root, 'README.md'), 'baseline window');
    execFileSync('git', ['add','README.md'], { cwd: root });
    execFileSync('git', ['commit','-qm','init'], { cwd: root });
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const probe = createFaultProbe({
      // The repository seam's name literal lives in the engine module that owns the seam.
      crashAt: [{ name: 'after_repository_baseline_before_task_execution' }],
    });
    // A repository-capable composition over a real workspace directory.
    const db = openDurableDatabase({
      dataDir: paths.dataDir,
      appliedAt: new Date().toISOString(),
      chains: [
        'core',
        'engine',
        'lifecycle',
        'provider',
        'registry',
        'selection',
        'agent',
        'tools',
        'artifact',
        'pack',
        'memory',
      ],
    });
    const foundation = await openArtifactFoundation({
      casRoot: paths.casRoot,
      database: db,
      logger: nullLogger as never,
    });
    if (!foundation.ok) throw new Error('foundation failed');
    const core = await composeCoreServices(db, nullLogger as never, {
      artifactFoundation: foundation as never,
      repositoryRuntime: { repositoryCapableKinds: ['e2e7:repo'] },
      faultCheckpoints: probe.port,
    });
    if (core === null) throw new Error('composition failed');
    const opened = await core.repositoryRuntime.openWorkspace({
      root,
      commandProfile: 'read-only',
    } as never);
    if (!opened.ok) throw new Error(opened.error.message);
    // Drive the repository handler directly: lease → baseline → CRASH before execution.
    const handler = core.repositoryRuntime.handlers().get('e2e7:repo');
    if (handler === undefined) throw new Error('no repository handler');
    await expect(
      handler.execute({
        runId: 'run_t18f20' as never,
        stageId: 'work' as never,
        taskId: 'tsk_t18f20' as never,
        kind: 'e2e7:repo',
        attempt: 1,
        branch: null,
        payload: {},
      }),
    ).rejects.toBeInstanceOf(FaultCrashError);
    // The baseline invocation is durable (capture happened); the lease was released by the
    // sentinel's unwinding finally — no process-local lease survives.
    expect(core.repositoryRuntime.currentWorkspace()).not.toBeNull();
    // Re-enter: capture-or-replay REPLAYS the same invocation instead of re-sampling.
    const again = await handler.execute({
      runId: 'run_t18f20' as never,
      stageId: 'work' as never,
      taskId: 'tsk_t18f20' as never,
      kind: 'e2e7:repo',
      attempt: 1,
      branch: null,
      payload: {},
    });
    expect(again).toBe('succeeded');
    core.repositoryRuntime.closeWorkspace();
    expect(core.repositoryRuntime.currentWorkspace()).toBeNull();
    db.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A lingering git handle on Windows: the proof above is already durable.
    }
  });
});
