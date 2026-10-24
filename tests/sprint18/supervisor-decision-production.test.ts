/**
 * Sprint 18 / Task-18-03 — the decision sink through the PRODUCTION composition entry.
 *
 * The T17-08/T18-02 rule applies: the test must not hand-wire a sink that production does not
 * have. Everything goes through `composeCoreServices` (the same module the desktop bootstrap
 * uses), including the canonical goal written by the production lifecycle, the real snapshot
 * verifier the production engine carries, and the real durable-reference resolver.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nullLogger } from '@companyos/observability';
import {
  createMockProvider,
  supervisorDecisionCommandId,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18prod2-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack', 'memory'] as const;
const COMPANY = 'company_default';

const compose = async (): Promise<NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>> => {
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error(`artifact foundation failed: ${foundation.error.message}`);
  const core = await composeCoreServices(db, nullLogger as never, { artifactFoundation: foundation as never });
  if (core === null) throw new Error('production composition failed');
  return core;
};

/** The production composition authorizes the session actor; read it from the durable bootstrap. */
const sessionActorOf = async (core: { database: DurableDatabase }): Promise<string> => {
  const assignments = (await core.database.roleAssignments.list({ limit: 10 })).items;
  const actor = assignments[0]?.actorId;
  if (actor === undefined) throw new Error('the production composition provisioned no owner');
  return actor;
};

describe('T18-03 production decision sink wiring', () => {
  it('the trusted application seam exists on the production composition', async () => {
    const core = await compose();
    expect(core.supervisorDecisionSink).not.toBeNull();
    // It is NOT an IPC channel and NOT a Tool: the only keys are the service surface.
    if (core.supervisorDecisionSink === null) return;
    expect(Object.keys(core.supervisorDecisionSink).sort()).toEqual(['decisionIdOf', 'getDecision', 'listActiveRunDecisions', 'listRunDecisionHistory', 'record']);
    const toolRows = (await core.database.toolRecords.list({ limit: 500 })).items.map((row) => row.toolId);
    expect(toolRows).not.toContain('supervisor.decision');
    expect(toolRows).not.toContain('decision.record');
  });

  it('records a decision for a production run that has a canonical goal', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    const template = await core.lifecycle.createTemplate({
      orgId: COMPANY,
      name: 'Production decision flow',
      actorId: actor,
      traceId: 't18q_tpl',
    });
    if (!template.ok) throw new Error(template.error.message);
    const graph = {
      nodes: [
        { id: 's1', kind: 'work' as const, title: 's1', config: {} },
        { id: 's2', kind: 'work' as const, title: 's2', config: {} },
      ],
      edges: [{ from: 's1', to: 's2' }],
    };
    const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor, traceId: 't18q_graph' });
    if (!saved.ok) throw new Error(saved.error.message);
    const published = await core.lifecycle.publish({ templateId: template.value.id, actorId: actor, traceId: 't18q_pub' });
    if (!published.ok) throw new Error(published.error.message);

    const run = await core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_decision',
      actorId: actor,
      goal: { objective: 'Record one supervisor decision through the production entry.', source: { type: 'human' } },
    });
    if (!run.ok) throw new Error(run.error.message);

    const sink = core.supervisorDecisionSink;
    if (sink === null) throw new Error('the production sink is not wired');
    const commandId = supervisorDecisionCommandId(run.value.run.id, 'production-first');
    const recorded = await sink.record({
      commandId,
      companyId: COMPANY,
      runId: run.value.run.id,
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'The objective is still achievable with the current context.',
      decidedBy: actor,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.decision).toBe('CONTINUE');
    expect(recorded.value.status).toBe('ACTIVE');

    // The same command replays the SAME row through the production sink.
    const again = await sink.record({
      commandId,
      companyId: COMPANY,
      runId: run.value.run.id,
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'The objective is still achievable with the current context.',
      decidedBy: actor,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.decisionId).toBe(recorded.value.decisionId);
    const rows = core.database.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as { c: number | bigint };
    expect(Number(rows.c)).toBe(1);

    // And the tenant-safe reader lists exactly that one decision for the run.
    const listed = await sink.listRunDecisionHistory({ runId: run.value.run.id, companyId: COMPANY, actorId: actor });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((row) => row.decisionId)).toEqual([recorded.value.decisionId]);
  });

  it('a decision about a run without a canonical goal fails closed', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    const template = await core.lifecycle.createTemplate({
      orgId: COMPANY,
      name: 'Production goalless flow',
      actorId: actor,
      traceId: 't18q_tpl2',
    });
    if (!template.ok) throw new Error(template.error.message);
    const graph = {
      nodes: [{ id: 's1', kind: 'work' as const, title: 's1', config: {} }],
      edges: [],
    };
    const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor, traceId: 't18q_graph2' });
    if (!saved.ok) throw new Error(saved.error.message);
    const published = await core.lifecycle.publish({ templateId: template.value.id, actorId: actor, traceId: 't18q_pub2' });
    if (!published.ok) throw new Error(published.error.message);
    const run = await core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_goalless',
      actorId: actor,
    });
    if (!run.ok) throw new Error(run.error.message);

    const sink = core.supervisorDecisionSink;
    if (sink === null) throw new Error('the production sink is not wired');
    const result = await sink.record({
      commandId: supervisorDecisionCommandId(run.value.run.id, 'goalless'),
      companyId: COMPANY,
      runId: run.value.run.id,
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'There is nothing to decide without a goal.',
      decidedBy: actor,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.['reason']).toBe('RUN_GOAL_MISSING');
    const rows = core.database.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as { c: number | bigint };
    expect(Number(rows.c)).toBe(0);
  });

  it('a decision whose binding is pinned in the run snapshot records its provenance', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    const provider = await core.providers.register(
      createMockProvider({
        providerId: 'prov_prod',
        kind: 'mock',
        displayName: 'Production provider',
        script: {
          models: [
            { modelId: 'prod-model', displayName: 'prod-model', contextWindow: 8_192, capabilities: { streaming: false } },
          ],
        },
      }),
      { actorId: actor },
    );
    if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
    const model = await core.models.registerFromProvider({
      providerId: 'prov_prod',
      providerModelId: 'prod-model',
      modelKey: 'prod.model',
      actorId: actor,
    });
    expect(model.ok).toBe(true);

    const template = await core.lifecycle.createTemplate({
      orgId: COMPANY,
      name: 'Production binding flow',
      actorId: actor,
      traceId: 't18q_tpl3',
    });
    if (!template.ok) throw new Error(template.error.message);
    const graph = { nodes: [{ id: 's1', kind: 'work' as const, title: 's1', config: {} }], edges: [] };
    const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor, traceId: 't18q_graph3' });
    if (!saved.ok) throw new Error(saved.error.message);
    const published = await core.lifecycle.publish({ templateId: template.value.id, actorId: actor, traceId: 't18q_pub3' });
    if (!published.ok) throw new Error(published.error.message);
    const run = await core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: 'wf_binding',
      actorId: actor,
      modelBindings: { supervisor: 'prod.model' },
      goal: { objective: 'Record the model binding provenance of a supervisor decision.' },
    });
    if (!run.ok) throw new Error(run.error.message);

    const sink = core.supervisorDecisionSink;
    if (sink === null) throw new Error('the production sink is not wired');
    const recorded = await sink.record({
      commandId: supervisorDecisionCommandId(run.value.run.id, 'bound'),
      companyId: COMPANY,
      runId: run.value.run.id,
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'The decision was produced under the run-pinned binding.',
      modelBindingKey: 'supervisor',
      decidedBy: actor,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const metadata = recorded.value.metadata as Record<string, unknown>;
    const envelope = metadata['supervisor'] as Record<string, unknown>;
    expect(envelope['modelBindingKey']).toBe('supervisor');
    expect(envelope['resolvedModelKey']).toBe('prod.model');
  });
});
