/**
 * Sprint 18 / Task-18-02 — production run-pin verification (§40 assertion matrix 11–18).
 *
 * The verifier under test is the PRODUCTION one: the same `createRunSnapshotVerifier` the
 * desktop composition injects into the engine (`composeSprint13Application`), wired to the
 * engine's `runSnapshotVerifier` seam and driven through the engine's authoritative execution
 * path (`advance`). A tampered durable snapshot with an unchanged `snapshotId` is the case the
 * Task exists to close — it must fail closed, never execute.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTask, ok, type Result, type TaskId, type WorkflowRun } from '@companyos/core';
import {
  createScriptedRegistry,
  createRunSnapshotVerifier,
  createWorkflowEngine,
  createWorkflowLifecycle,
  type WorkflowEngine,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18snp-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18S${String(++seq).padStart(12, '0')}`,
  ulid: () => `18S${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'] as const;
const COMPANY = 'company_default';

interface Fixture {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  /** Remove the durable snapshot row the way storage loss would (the store refuses it). */
  dropSnapshot(snapshotId: string): Promise<void>;
  readonly lifecycle: ReturnType<typeof createWorkflowLifecycle>;
  readonly engine: WorkflowEngine;
  /** Overwrite the durable snapshot row in place — the "tampered store" scenario. */
  tamperSnapshot(snapshotId: string, mutate: (snapshot: Record<string, unknown>) => void): Promise<void>;
}

const make = (): Fixture => {
  const dataDir = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);

  const lifecycle = createWorkflowLifecycle({
    ids,
    clock,
    templates: db.templates,
    locks: db.locks,
    proposals: db.proposals,
    snapshots: db.snapshots,
    runs: db.runs,
    events: db.events,
    unitOfWork: db.unitOfWork,
    authorize: async (): Promise<Result<true, never>> => ok(true as const),
  });

  const verifier = createRunSnapshotVerifier({ templates: db.templates, snapshots: db.snapshots });
  const engine = createWorkflowEngine({
    ids,
    clock,
    runs: db.runs,
    tasks: db.tasks,
    approvals: db.approvals,
    events: db.events,
    unitOfWork: db.unitOfWork,
    ledger: db.ledger,
    handlers: createScriptedRegistry({}),
    runSnapshotVerifier: verifier,
  });

  return {
    db,
    dataDir,
    lifecycle,
    engine,
    async tamperSnapshot(snapshotId: string, mutate: (row: Record<string, unknown>) => void): Promise<void> {
      // A fixture-level corruption of the durable row. The snapshot STORE refuses this by design
      // (its upsert only rewrites `snapshot_hash`, its delete throws), so the corruption is
      // written the way real storage corruption happens: directly on the row.
      const current = (db.db.prepare('SELECT * FROM run_snapshots WHERE id = ?').get(snapshotId) as Record<string, unknown> | undefined);
      if (current === undefined) throw new Error(`snapshot ${snapshotId} is missing`);
      const row: Record<string, unknown> = { ...current };
      const value = (key: string): string | number | null => {
        const raw = row[key];
        return typeof raw === 'string' || typeof raw === 'number' ? raw : raw === null ? null : String(raw);
      };
      mutate(row);
      db.db
        .prepare(
          `UPDATE run_snapshots SET org_id = ?, template_id = ?, workflow_version_id = ?, template_lock_id = ?,
             pack_versions_json = ?, model_bindings_json = ?, memory_view_ref = ?, snapshot_hash = ?, created_at = ?, created_by = ?
           WHERE id = ?`,
        )
        .run(
          value('org_id'), value('template_id'), value('workflow_version_id'), value('template_lock_id'),
          value('pack_versions_json'), value('model_bindings_json'), value('memory_view_ref'), value('snapshot_hash'),
          value('created_at'), value('created_by'), snapshotId,
        );
    },
    async dropSnapshot(snapshotId: string): Promise<void> {
      db.db.prepare('DELETE FROM run_snapshots WHERE id = ?').run(snapshotId);
    },
  };
};

const STAGE_ID = 'stg_1' as never;

const makeRunWithTask = async (
  f: Fixture,
  label: string,
): Promise<{ readonly runId: WorkflowRun['id']; readonly taskId: TaskId }> => {
  const template = await f.lifecycle.createTemplate({
    orgId: COMPANY,
    name: `Pin flow ${label}`,
    actorId: 'user_owner',
    traceId: `t18s_tpl_${label}`,
  });
  if (!template.ok) throw new Error(template.error.message);
  const graph = { nodes: [{ id: 's1', kind: 'work' as const, title: 'Work', config: {} }], edges: [] };
  const saved = await f.lifecycle.saveDraftGraph({
    templateId: template.value.id,
    graph,
    actorId: 'user_owner',
    traceId: `t18s_graph_${label}`,
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await f.lifecycle.publish({
    templateId: template.value.id,
    actorId: 'user_owner',
    traceId: `t18s_pub_${label}`,
  });
  if (!published.ok) throw new Error(published.error.message);

  const run = await f.lifecycle.createRun({
    templateId: template.value.id,
    companyId: COMPANY,
    workflowId: 'wf_pin',
    actorId: 'user_owner',
  });
  if (!run.ok) throw new Error(run.error.message);

  const started = await f.engine.dispatch({
    commandId: `cmd_start_${label}`,
    runId: run.value.run.id,
    type: 'RUN.START',
    expectedRevision: run.value.run.revision,
    actorId: 'user_owner',
    traceId: `t18s_start_${label}`,
    issuedAt: nowIso(),
  });
  if (!started.ok) throw new Error(started.error.message);
  const ready = await f.engine.dispatch({
    commandId: `cmd_ready_${label}`,
    runId: run.value.run.id,
    type: 'TEMPLATE.RESOLVE',
    expectedRevision: started.value.revision,
    actorId: 'user_owner',
    traceId: `t18s_ready_${label}`,
    issuedAt: nowIso(),
  });
  if (!ready.ok) throw new Error(ready.error.message);
  const planned = await f.engine.dispatch({
    commandId: `cmd_plan_${label}`,
    runId: run.value.run.id,
    type: 'PLAN.COMPLETE',
    expectedRevision: ready.value.revision,
    actorId: 'user_owner',
    traceId: `t18s_plan_${label}`,
    issuedAt: nowIso(),
  });
  if (!planned.ok) throw new Error(planned.error.message);
  const routed = await f.engine.dispatch({
    commandId: `cmd_route_${label}`,
    runId: run.value.run.id,
    type: 'ROUTE.RESOLVE',
    expectedRevision: planned.value.revision,
    actorId: 'user_owner',
    traceId: `t18s_route_${label}`,
    issuedAt: nowIso(),
  });
  if (!routed.ok) throw new Error(routed.error.message);

  const task = await createTask({
    runId: run.value.run.id as never,
    stageId: STAGE_ID,
    roleId: 'rol_1' as never,
    kind: 'pack-a:build',
    now: nowIso(),
    ids,
  });
  if (!task.ok) throw new Error(task.error.message);
  await f.db.tasks.put(task.value);
  return { runId: run.value.run.id, taskId: task.value.id };
};

describe('T18-02 run snapshot verification (fail closed before execution)', () => {
  it('11. an intact snapshot executes', async () => {
    const f = make();
    const { runId, taskId } = await makeRunWithTask(f, 'intact');
    const run = await f.db.runs.get(runId);
    const result = await f.engine.advance({
      runId,
      stageId: STAGE_ID,
      taskIds: [taskId as never],
      snapshot: {
        snapshotId: run!.snapshotId as never,
        snapshotHash: (await f.db.snapshots.get(run!.snapshotId as never))!.snapshotHash,
      },
    });
    expect(result.outcome).toBe('completed');
    const finished = await f.db.runs.get(runId as never);
    expect(finished?.state).toBe('REVIEWING');
  });

  it('12. a missing snapshot fails closed and executes nothing', async () => {
    const f = make();
    const { runId, taskId } = await makeRunWithTask(f, 'missing');
    const run = await f.db.runs.get(runId);
    await f.dropSnapshot(run!.snapshotId);
    const before = await f.db.tasks.get(taskId as never);
    expect(before?.state).toBe('PENDING');

    const verifier = createRunSnapshotVerifier({ templates: f.db.templates, snapshots: f.db.snapshots });
    const verdict = await verifier.verify({ runId, snapshotId: run!.snapshotId });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error.code).toBe('NOT_FOUND');
    expect(verdict.error.details?.['reason']).toBe('RUN_SNAPSHOT_MISSING');

    // The engine path refuses too, and the task was never touched.
    const result = await f.engine
      .advance({
        runId,
        stageId: STAGE_ID,
        taskIds: [taskId],
        snapshot: { snapshotId: run!.snapshotId as never, snapshotHash: 'tampered' },
      })
      .then(
        () => null,
        (error: unknown) => error as { code: string },
      );
    expect(result).not.toBeNull();
    expect((result as unknown as { code: string }).code).toBe('NOT_FOUND');
    const after = await f.db.tasks.get(taskId as never);
    expect(after?.state).toBe(before?.state);
  });

  it('13. tampered pinned content fails closed even though the snapshotId is unchanged', async () => {
    const f = make();
    const { runId, taskId } = await makeRunWithTask(f, 'tampered');
    const run = await f.db.runs.get(runId);
    await f.tamperSnapshot(run!.snapshotId, (row) => {
      row['memory_view_ref'] = 'memory:attacker';
    });
    const before = await f.db.tasks.get(taskId as never);

    const verifier = createRunSnapshotVerifier({ templates: f.db.templates, snapshots: f.db.snapshots });
    const verdict = await verifier.verify({ runId, snapshotId: run!.snapshotId });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error.code).toBe('SNAPSHOT_MISMATCH');

    // And the authoritative execution path refuses before any task write.
    await expect(
      f.engine.advance({
        runId,
        stageId: STAGE_ID,
        taskIds: [taskId],
        snapshot: {
          snapshotId: run!.snapshotId as never,
          snapshotHash: (await f.db.snapshots.get(run!.snapshotId as never))!.snapshotHash,
        },
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' });
    const after = await f.db.tasks.get(taskId as never);
    expect(after?.state).toBe(before?.state);
  });

  it('14. the same snapshotId with altered content never becomes a different accepted pin', async () => {
    const f = make();
    const { runId, taskId } = await makeRunWithTask(f, 'same-id');
    const run = await f.db.runs.get(runId);
    const snapshotId = run!.snapshotId;
    const pristine = await f.db.snapshots.get(snapshotId as never);
    await f.tamperSnapshot(snapshotId, (row) => {
      row['pack_versions_json'] = JSON.stringify({ 'pack-a': '9.9.9' });
    });

    const rejected = await createRunSnapshotVerifier({ templates: f.db.templates, snapshots: f.db.snapshots }).verify({
      runId,
      snapshotId,
    });
    expect(rejected.ok).toBe(false);

    // Restoring the pinned content makes the very same id verifiable again: the check is about
    // CONTENT, and it never mutates or regenerates anything.
    await f.tamperSnapshot(snapshotId, (row) => {
      row['pack_versions_json'] = JSON.stringify(pristine!.packVersions);
    });
    const restored = await createRunSnapshotVerifier({ templates: f.db.templates, snapshots: f.db.snapshots }).verify({
      runId,
      snapshotId,
    });
    expect(restored.ok).toBe(true);
    void taskId;
  });

  it('15. the verifier is Core’s canonical verifier, not a second algorithm', async () => {
    const f = make();
    const { runId } = await makeRunWithTask(f, 'canonical');
    const run = await f.db.runs.get(runId);
    const snapshot = await f.db.snapshots.get(run!.snapshotId as never);
    const template = await f.db.templates.get(snapshot!.templateId as never);
    const version = template!.versions.find((entry) => entry.id === snapshot!.workflowVersionId);

    // Same inputs, same verdict, straight from Core — including its pack-drift tolerance.
    const core = (await import('@companyos/core')).verifyRunSnapshot(snapshot!, version!);
    expect(core.ok).toBe(true);
    const verifier = createRunSnapshotVerifier({ templates: f.db.templates, snapshots: f.db.snapshots });
    const production = await verifier.verify({ runId, snapshotId: run!.snapshotId });
    expect(production.ok).toBe(core.ok);

    await f.tamperSnapshot(run!.snapshotId, (row) => {
      row['memory_view_ref'] = 'memory:someone-else';
    });
    const coreAfter = (await import('@companyos/core')).verifyRunSnapshot(
      (await f.db.snapshots.get(run!.snapshotId as never))!,
      version!,
    );
    const productionAfter = await verifier.verify({ runId, snapshotId: run!.snapshotId });
    expect(productionAfter.ok).toBe(false);
    expect(coreAfter.ok).toBe(false);
  });

  it('16. verification survives a restart', async () => {
    const f = make();
    const { runId } = await makeRunWithTask(f, 'restart');
    const run = await f.db.runs.get(runId);
    f.db.close();
    const tracked = openDatabases.indexOf(f.db);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const reopened = openDurableDatabase({ dataDir: f.dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
    openDatabases.push(reopened);

    const verifier = createRunSnapshotVerifier({ templates: reopened.templates, snapshots: reopened.snapshots });
    const verdict = await verifier.verify({ runId, snapshotId: run!.snapshotId });
    expect(verdict.ok).toBe(true);
  });

  it('17. execution never recreates or repairs a snapshot', async () => {
    const f = make();
    const { runId, taskId } = await makeRunWithTask(f, 'no-repair');
    const run = await f.db.runs.get(runId);
    const before = await f.db.snapshots.get(run!.snapshotId as never);
    const countBefore = (await f.db.templates.get(before!.templateId as never))!.versions.length;

    await f.engine.advance({
      runId,
      stageId: STAGE_ID,
      taskIds: [taskId as never],
      snapshot: { snapshotId: before!.snapshotId, snapshotHash: before!.snapshotHash },
    });

    const after = await f.db.snapshots.get(run!.snapshotId as never);
    expect(after).toEqual(before);
    const template = await f.db.templates.get(before!.templateId as never);
    expect(template!.versions.length).toBe(countBefore);
    expect((await f.db.runs.get(runId as never))!.snapshotId).toBe(run!.snapshotId);
  });

  it('18. the immutable workflow fields stay unchanged across execution', async () => {
    const f = make();
    const { runId, taskId } = await makeRunWithTask(f, 'immutable');
    const run = await f.db.runs.get(runId);
    const snapshot = await f.db.snapshots.get(run!.snapshotId as never);

    await f.engine.advance({
      runId,
      stageId: STAGE_ID,
      taskIds: [taskId as never],
      snapshot: { snapshotId: snapshot!.snapshotId, snapshotHash: snapshot!.snapshotHash },
    });

    const afterRun = await f.db.runs.get(runId as never);
    const afterSnapshot = await f.db.snapshots.get(run!.snapshotId as never);
    expect(afterRun!.templateId).toBe(run!.templateId);
    expect(afterRun!.versionId).toBe(run!.versionId);
    expect(afterRun!.snapshotId).toBe(run!.snapshotId);
    expect(afterSnapshot!.workflowVersionId).toBe(snapshot!.workflowVersionId);
    expect(afterSnapshot!.snapshotHash).toBe(snapshot!.snapshotHash);
  });
});
