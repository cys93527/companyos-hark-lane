/**
 * Sprint 18 / Task-18-02 — production execution-context wiring.
 *
 * Asserts the TRUSTED APPLICATION CONFIGURATION of the real production composition entry
 * (`composeCoreServices`, the same module the desktop bootstrap uses): the run-goal writer, the
 * run-creation replay ledger and the model-binding registry are wired, and the engine carries
 * the run-pin verifier. This is the T17-08 lesson applied to Sprint 18: the wiring is proven
 * through the production entry, not through a hand-built look-alike.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ok, type Result } from '@companyos/core';
import { createMockProvider, createWorkflowEngine } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18prod-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18P${String(++seq).padStart(12, '0')}`,
  ulid: () => `18P${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'] as const;
const COMPANY = 'company_default';

/**
 * The production composition authorizes the SESSION actor (the bootstrap owner). The test
 * discovers it from the durable role assignment instead of hard-coding it, so it stays honest
 * about what production actually grants.
 */
const sessionActorOf = async (core: { database: DurableDatabase }): Promise<string> => {
  const assignments = (await core.database.roleAssignments.list({ limit: 10 })).items;
  const actor = assignments[0]?.actorId;
  if (actor === undefined) throw new Error('the production composition provisioned no owner');
  return actor;
};

const compose = async (): Promise<NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>> => {
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  // Phase 1 is the REAL `openArtifactFoundation` over a real temporary CAS root: the test
  // must not hand the composition a content store that skips the startup reconciliation.
  const { openArtifactFoundation } = await import('../../apps/desktop/src/artifact-stack.js');
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error(`artifact foundation failed: ${foundation.error.message}`);
  const core = await composeCoreServices(db, nullLogger as never, { artifactFoundation: foundation as never });
  if (core === null) throw new Error('production composition failed');
  return core;
};

describe('T18-02 production wiring (execution context)', () => {
  it('wires the run-goal writer, the replay ledger and the binding registry', async () => {
    const core = await compose();
    const ACTOR = await sessionActorOf(core);
    // The composition's own lifecycle carries the Sprint 18 seams; they are not reachable from
    // a caller payload, only from this trusted configuration.
    const template = await core.lifecycle.createTemplate({
      orgId: COMPANY,
      name: 'Production wiring flow',
      actorId: ACTOR,
      traceId: 't18p_tpl',
    });
    expect(template.ok).toBe(true);
    if (!template.ok) return;
    const graph = { nodes: [{ id: 's1', kind: 'work' as const, title: 'Work', config: {} }], edges: [] };
    await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: ACTOR, traceId: 't18p_graph' });
    await core.lifecycle.publish({ templateId: template.value.id, actorId: ACTOR, traceId: 't18p_pub' });

    const run = await core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_prod',
      actorId: ACTOR,
      goal: { objective: 'Prove the production execution context end to end.', source: { type: 'human' } },
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    // 1. the goal landed as a run-owned immutable artifact through the production writer.
    const goalArtifacts = await core.database.artifactStore!.listByRun(run.value.run.id as never);
    expect(goalArtifacts.map((entry) => entry.kind)).toEqual(['companyos:run-goal']);

    // 2. the run-creation identity is recorded in the durable ledger of the SAME database.
    const replayed = await core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_prod',
      actorId: ACTOR,
      commandId: 'run-create:production-1',
      goal: { objective: 'Prove the production execution context end to end.', source: { type: 'human' } },
    });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    const again = await core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_prod',
      actorId: ACTOR,
      commandId: 'run-create:production-1',
      goal: { objective: 'Different content, same identity.', source: { type: 'human' } },
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('CONFLICT');

    // 3. the engine carries the run-pin verifier, so a tampered pin cannot execute.
    const snapshot = await core.lifecycle.readSnapshot(replayed.value.snapshot.snapshotId);
    expect(snapshot).not.toBeNull();
    const verdict = await core.sprint13.runSnapshotVerifier.verify({
      runId: replayed.value.run.id,
      snapshotId: replayed.value.snapshot.snapshotId,
    });
    expect(verdict.ok).toBe(true);

    // 4. bindings are proven against the real registry: an unknown model is refused.
    const provider = await core.providers.register(
      createMockProvider({
        providerId: 'prov_prod',
        kind: 'mock',
        displayName: 'Production provider',
        script: { models: [{ modelId: 'prod-model', displayName: 'prod-model', contextWindow: 8_192, capabilities: { streaming: false } }] },
      }),
      { actorId: ACTOR },
    );
    if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
    const model = await core.models.registerFromProvider({
      providerId: 'prov_prod',
      providerModelId: 'prod-model',
      modelKey: 'prod.model',
      actorId: ACTOR,
    });
    expect(model.ok).toBe(true);

    const pinned = await core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_prod',
      actorId: ACTOR,
      modelBindings: { default: 'prod.model' },
    });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    const stored = await core.lifecycle.readSnapshot(pinned.value.snapshot.snapshotId);
    expect(stored?.modelBindings).toEqual({ default: 'prod.model' });

    const unknown = await core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_prod',
      actorId: ACTOR,
      modelBindings: { default: 'no.such.model' },
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.details?.['reason']).toBe('RUN_BINDING_UNKNOWN');
  });

  it('the production engine refuses to execute a run whose snapshot was tampered', async () => {
    const core = await compose();
    const ACTOR = await sessionActorOf(core);
    const template = await core.lifecycle.createTemplate({
      orgId: COMPANY,
      name: 'Production tamper flow',
      actorId: ACTOR,
      traceId: 't18p_tpl2',
    });
    if (!template.ok) throw new Error(template.error.message);
    const graph = { nodes: [{ id: 's1', kind: 'work' as const, title: 'Work', config: {} }], edges: [] };
    await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: ACTOR, traceId: 't18p_graph2' });
    await core.lifecycle.publish({ templateId: template.value.id, actorId: ACTOR, traceId: 't18p_pub2' });
    const run = await core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_prod2',
      actorId: ACTOR,
      goal: { objective: 'Refuse execution on a tampered pin.' },
    });
    if (!run.ok) throw new Error(run.error.message);

    const snapshotId = run.value.snapshot.snapshotId;
    core.database.db
      .prepare('UPDATE run_snapshots SET memory_view_ref = ? WHERE id = ?')
      .run('memory:attacker', snapshotId);

    // The engine's own path (not the verifier helper) fails closed.
    await expect(
      core.sprint13.engine.advance({
        runId: run.value.run.id,
        stageId: 'stg_prod' as never,
        taskIds: [],
        snapshot: { snapshotId, snapshotHash: run.value.snapshot.snapshotHash },
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' });
  });

  it('a legacy composition without the Sprint 18 seams still creates runs', async () => {
    // The seams are additive: a composition that wires neither goal writer nor ledger keeps the
    // Sprint 4 behaviour, and a caller-supplied goal then fails closed instead of vanishing.
    const dataDir = tempDir();
    const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: ['core', 'engine', 'lifecycle'] });
    const ACTOR = 'user_owner';
    openDatabases.push(db);
    const engine = createWorkflowEngine({
      ids,
      clock,
      runs: db.runs,
      tasks: db.tasks,
      approvals: db.approvals,
      events: db.events,
      handlers: { resolve: () => null },
    });
    expect(engine).toBeDefined();

    const { createWorkflowLifecycle } = await import('@companyos/engine');
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
      authorize: (async (): Promise<Result<true, never>> => ok(true as const)) as never,
    });
    const template = await lifecycle.createTemplate({ orgId: COMPANY, name: 'Legacy flow', actorId: ACTOR, traceId: 't18p_legacy' });
    if (!template.ok) throw new Error(template.error.message);
    const graph = { nodes: [{ id: 's1', kind: 'work' as const, title: 'Work', config: {} }], edges: [] };
    await lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: ACTOR, traceId: 't18p_legacy_graph' });
    await lifecycle.publish({ templateId: template.value.id, actorId: ACTOR, traceId: 't18p_legacy_pub' });

    const plain = await lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_legacy',
      actorId: ACTOR,
    });
    expect(plain.ok).toBe(true);

    const withGoal = await lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_legacy',
      actorId: ACTOR,
      goal: { objective: 'A goal with nowhere durable to go.' },
    });
    expect(withGoal.ok).toBe(false);
    if (withGoal.ok) return;
    expect(withGoal.error.details?.['reason']).toBe('RUN_GOAL_WRITER_UNAVAILABLE');
    // The refusal is transactional: the promised goal took the whole run down with it.
    expect((await db.runs.list({ limit: 10 })).items.length).toBe(1);

    const withIdentity = await lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_legacy',
      actorId: ACTOR,
      commandId: 'run-create:legacy-1',
    });
    expect(withIdentity.ok).toBe(false);
    if (withIdentity.ok) return;
    expect(withIdentity.error.details?.['reason']).toBe('RUN_CREATE_LEDGER_UNAVAILABLE');
  });
});
