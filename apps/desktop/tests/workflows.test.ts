/**
 * Sprint 5 STEP 2 — the desktop Workflow IPC layer (tests A, B, F, G, H, I, J, K, L,
 * M, N, Q, R).
 *
 * The API is exercised exactly as the renderer would call it: raw payload in, structured
 * response out. Every request goes through `parseWorkflowRequest`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DomainError,
  FixedClock,
  SequenceIdFactory,
  verifyRunSnapshot,
  type WorkflowRun,
  type WorkflowTemplate,
  type WorkflowVersion,
} from '@companyos/core';
import { createScriptedRegistry, createWorkflowEngine, createWorkflowLifecycle } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { createWorkflowApi, parseWorkflowRequest, type WorkflowApi } from '../src/workflows.js';

const EPOCH = Date.parse('2026-07-01T00:00:00.000Z');

interface Fixture {
  readonly dataDir: string;
  readonly clock: FixedClock;
  readonly ids: SequenceIdFactory;
  database(): DurableDatabase;
  api(): WorkflowApi;
  restart(): void;
  call(operation: string, payload?: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string; details: Readonly<Record<string, unknown>> } }>;
  seedPublishedTemplate(): Promise<WorkflowTemplate>;
  cleanup(): void;
}

const make = (): Fixture => {
  const dataDir = mkdtempSync(join(tmpdir(), 'companyos-designer-'));
  const clock = new FixedClock(EPOCH);
  const ids = new SequenceIdFactory();

  const open = (): DurableDatabase =>
    openDurableDatabase({ dataDir, appliedAt: clock.nowIso(), chains: ['core', 'engine', 'lifecycle'] });

  let database = open();

  const buildApi = (db: DurableDatabase): WorkflowApi =>
    createWorkflowApi({
      lifecycle: createWorkflowLifecycle({
        ids,
        clock,
        templates: db.templates,
        locks: db.locks,
        proposals: db.proposals,
        snapshots: db.snapshots,
        runs: db.runs,
        events: db.events,
        unitOfWork: db.unitOfWork,
      }),
      listTemplates: async () => (await db.templates.list({ limit: 500 })).items,
      roleIds: ['rol_analyst', 'rol_reviewer'],
      validatorIds: ['val_schema', 'val_tone'],
      usageCounts: async () => {
        const runs = (await db.runs.list({ limit: 500 })).items;
        return runs.reduce<Record<string, number>>((accumulator, run) => {
          accumulator[run.templateId] = (accumulator[run.templateId] ?? 0) + 1;
          return accumulator;
        }, {});
      },
    });

  let api = buildApi(database);

  const fixture: Fixture = {
    dataDir,
    clock,
    ids,
    database: () => database,
    api: () => api,
    restart(): void {
      database.close();
      database = open();
      api = buildApi(database);
    },
    async call(operation, payload = {}) {
      const response = await api.handle({ operation, requestId: 'req_1', payload });
      return response.ok
        ? { ok: true, value: response.value }
        : { ok: false, error: response.error };
    },
    async seedPublishedTemplate(): Promise<WorkflowTemplate> {
      const created = await fixture.call('draft.create', {
        orgId: 'org_1',
        name: 'Intake SOP',
        actorId: 'user_designer',
      });
      if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
      const templateId = (created.value as WorkflowTemplate).id;

      const applied = await fixture.call('draft.applyOps', {
        templateId,
        actorId: 'user_designer',
        ops: [
          { op: 'ADD_STAGE', stage: { id: 's1', kind: 'pack-a:step', title: 'Intake', config: {} } },
          { op: 'ADD_STAGE', stage: { id: 's2', kind: 'pack-a:step', title: 'Review', config: {} } },
          { op: 'CONNECT_STAGE', from: 's1', to: 's2' },
          { op: 'SET_ROLE', stageId: 's1', roleId: 'rol_analyst' },
          { op: 'SET_ROLE', stageId: 's2', roleId: 'rol_reviewer' },
        ],
      });
      if (!applied.ok) throw new Error(`apply failed: ${JSON.stringify(applied.error)}`);

      const published = await fixture.call('publish', { templateId, actorId: 'user_lead' });
      if (!published.ok) throw new Error(`publish failed: ${JSON.stringify(published.error)}`);
      return published.value as WorkflowTemplate;
    },
    cleanup(): void {
      try {
        database.close();
      } catch {
        // already closed
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return fixture;
};

const fixtures: Fixture[] = [];
const fixture = (): Fixture => {
  const created = make();
  fixtures.push(created);
  return created;
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

describe('Q. every IPC request is schema-validated first', () => {
  const bad: readonly { readonly name: string; readonly request: unknown; readonly code: string }[] = [
    { name: 'non-object', request: 'draft.create', code: 'INVALID_ARGUMENT' },
    { name: 'null', request: null, code: 'INVALID_ARGUMENT' },
    { name: 'unknown operation', request: { operation: 'sql.exec', payload: {} }, code: 'INVALID_ARGUMENT' },
    { name: 'array payload', request: { operation: 'library.list', payload: [] }, code: 'INVALID_ARGUMENT' },
    { name: 'blank requestId', request: { operation: 'library.list', requestId: '  ', payload: {} }, code: 'INVALID_ARGUMENT' },
  ];

  for (const testCase of bad) {
    it(`refuses ${testCase.name}`, async () => {
      const parsed = parseWorkflowRequest(testCase.request);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.code).toBe(testCase.code);

      const response = await fixture().api().handle(testCase.request);
      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.error.code).toBe(testCase.code);
    });
  }

  it('validates per-operation payload shapes', async () => {
    const api = fixture().api();
    const cases: readonly (readonly [string, Record<string, unknown>, string])[] = [
      ['draft.create', { orgId: 'org_1', name: 'x' }, 'actorId'],
      ['draft.create', { orgId: '', name: 'x', actorId: 'a' }, 'orgId'],
      ['draft.applyOps', { templateId: 'tpl_1', actorId: 'a', ops: [] }, 'ops'],
      ['draft.applyOps', { templateId: 'tpl_1', actorId: 'a', ops: [{ nope: true }] }, 'op'],
      ['draft.save', { templateId: 'tpl_1', actorId: 'a', graph: { nodes: 'no' } }, 'graph'],
      ['review.decide', { proposalId: 'chp_1', actorId: 'a', decision: 'maybe' }, 'decision'],
      ['publish', { templateId: '', actorId: 'a' }, 'templateId'],
      ['compare', { fromVersionId: 'ver_1' }, 'toVersionId'],
      ['run.create', { templateId: 'tpl_1', companyId: 'cmp_1' }, 'workflowId'],
    ];
    for (const [operation, payload, field] of cases) {
      const response = await api.handle({ operation, payload });
      expect(response.ok, `${operation} should fail`).toBe(false);
      if (response.ok) continue;
      expect(response.error.code).toBe('INVALID_ARGUMENT');
      expect(JSON.stringify(response.error.details)).toContain(field);
    }
  });

  it('rejects a payload object that carries an unexpected shape for graph nodes', async () => {
    const response = await fixture()
      .api()
      .handle({
        operation: 'draft.save',
        payload: { templateId: 'tpl_1', actorId: 'a', graph: { nodes: [{ id: 1 }], edges: [] } },
      });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('A/B. creating and editing a draft through the IPC layer', () => {
  it('A: creates a draft and lists it in the library with usage count 0', async () => {
    const f = fixture();
    const created = await f.call('draft.create', { orgId: 'org_1', name: 'Intake SOP', actorId: 'user_designer' });
    expect(created.ok).toBe(true);
    const template = created.value as WorkflowTemplate;
    expect(template.state).toBe('draft');

    const library = await f.call('library.list');
    expect(library.ok).toBe(true);
    const rows = library.value as readonly { templateId: string; usageCount: number; editable: boolean; currentVersion: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ templateId: template.id, usageCount: 0, editable: true, currentVersion: null });
  });

  it('B: applies ops, then reports the draft through draft.open', async () => {
    const f = fixture();
    const created = await f.call('draft.create', { orgId: 'org_1', name: 'SOP', actorId: 'user_designer' });
    const templateId = (created.value as WorkflowTemplate).id;

    const applied = await f.call('draft.applyOps', {
      templateId,
      actorId: 'user_designer',
      roleIds: ['rol_analyst'],
      ops: [
        { op: 'ADD_STAGE', stage: { id: 's1', kind: 'pack-a:step', title: 'Intake', config: {} } },
        { op: 'ADD_STAGE', stage: { id: 's2', kind: 'pack-a:step', title: 'Review', config: {} } },
        { op: 'CONNECT_STAGE', from: 's1', to: 's2' },
        { op: 'SET_ROLE', stageId: 's1', roleId: 'rol_analyst' },
        { op: 'SET_VALIDATOR', stageId: 's2', validatorIds: ['val_schema'] },
        { op: 'SET_RISK', stageId: 's2', riskLevel: 'HIGH' },
        { op: 'SET_APPROVAL', stageId: 's2', approval: { required: true, mode: 'owner' } },
      ],
    });
    expect(applied.ok).toBe(true);

    const opened = await f.call('draft.open', { templateId, validatorIds: ['val_schema'] });
    expect(opened.ok).toBe(true);
    const view = opened.value as {
      editable: boolean;
      graph: { nodes: readonly unknown[]; edges: readonly unknown[] };
      validation: { valid: boolean; issues: readonly unknown[] };
    };
    expect(view.editable).toBe(true);
    expect(view.graph.nodes).toHaveLength(2);
    expect(view.graph.edges).toHaveLength(1);
    expect(view.validation.valid).toBe(true);
  });

  it('refuses an op set that produces an invalid graph (atomic: nothing is saved)', async () => {
    const f = fixture();
    const created = await f.call('draft.create', { orgId: 'org_1', name: 'SOP', actorId: 'user_designer' });
    const templateId = (created.value as WorkflowTemplate).id;

    // Two stages pointing at each other: no entry, no terminal, unreachable - Core's
    // validation refuses it, and the draft must stay empty.
    const refused = await f.call('draft.applyOps', {
      templateId,
      actorId: 'user_designer',
      ops: [
        { op: 'ADD_STAGE', stage: { id: 's1', kind: 'pack-a:step', title: 'A', config: {} } },
        { op: 'ADD_STAGE', stage: { id: 's2', kind: 'pack-a:step', title: 'B', config: {} } },
        { op: 'CONNECT_STAGE', from: 's1', to: 's2' },
        { op: 'CONNECT_STAGE', from: 's2', to: 's1' },
      ],
    });
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('VALIDATION_FAILED');
    expect(String(JSON.stringify(refused.error?.details))).toContain('NO_ENTRY_STAGE');

    const stored = (await f.database().templates.get(templateId)) as WorkflowTemplate;
    expect(stored.versions).toHaveLength(0); // nothing was written
  });

  it('refuses a duplicate stage id before anything is saved', async () => {
    const f = fixture();
    const created = await f.call('draft.create', { orgId: 'org_1', name: 'SOP', actorId: 'user_designer' });
    const templateId = (created.value as WorkflowTemplate).id;
    const refused = await f.call('draft.applyOps', {
      templateId,
      actorId: 'user_designer',
      ops: [
        { op: 'ADD_STAGE', stage: { id: 's1', kind: 'pack-a:step', title: 'A', config: {} } },
        { op: 'ADD_STAGE', stage: { id: 's1', kind: 'pack-a:step', title: 'Again', config: {} } },
      ],
    });
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('CONFLICT');
  });
});

describe('F/G. published is read-only, and the boundary is NOT the UI', () => {
  it('F: reports editable=false for a published template', async () => {
    const f = fixture();
    const published = await f.seedPublishedTemplate();
    const opened = await f.call('draft.open', { templateId: published.id });
    const view = opened.value as { editable: boolean };
    expect(view.editable).toBe(false);
  });

  it('G: the lifecycle service still refuses a direct write attempt that bypasses the UI', async () => {
    const f = fixture();
    const published = await f.seedPublishedTemplate();

    for (const operation of ['draft.applyOps', 'draft.save']) {
      const payload =
        operation === 'draft.applyOps'
          ? {
              templateId: published.id,
              actorId: 'user_designer',
              ops: [{ op: 'ADD_STAGE', stage: { id: 's9', kind: 'pack-a:step', title: 'Sneaky', config: {} } }],
            }
          : {
              templateId: published.id,
              actorId: 'user_designer',
              graph: {
                nodes: [
                  { id: 's1', kind: 'pack-a:step', title: 'Hacked', config: {} },
                  { id: 's2', kind: 'pack-a:step', title: 'Review', config: {} },
                ],
                edges: [{ from: 's1', to: 's2' }],
              },
            };
      const refused = await f.call(operation, payload);
      expect(refused.ok, `${operation} must be refused`).toBe(false);
      expect(refused.error?.code).toBe('ILLEGAL_TRANSITION');
    }

    // The published version is byte-identical afterwards.
    const stored = (await f.database().templates.get(published.id)) as WorkflowTemplate;
    expect(stored.versions).toHaveLength(1);
    expect(stored.versions[0]?.graph.nodes.map((node) => node.title)).toEqual(['Intake', 'Review']);
  });
});

describe('H/I/J/K/L/M. fork, proposal, publish, compare, deprecate, archive', () => {
  it('H: forks into a new draft, leaving the source untouched', async () => {
    const f = fixture();
    const published = await f.seedPublishedTemplate();
    const forked = await f.call('fork', { templateId: published.id, name: 'Intake SOP (v2 branch)', actorId: 'user_designer' });
    expect(forked.ok).toBe(true);
    const clone = forked.value as WorkflowTemplate;
    expect(clone.state).toBe('draft');
    expect(clone.forkedFrom?.templateId).toBe(published.id);
    expect(clone.versions).toHaveLength(0);

    const source = (await f.database().templates.get(published.id)) as WorkflowTemplate;
    expect(source.state).toBe('published');
    expect(source.versions).toHaveLength(1);
  });

  it('I: submits a review proposal and refuses self-approval', async () => {
    const f = fixture();
    const published = await f.seedPublishedTemplate();

    const submitted = await f.call('review.submit', {
      templateId: published.id,
      actorId: 'user_designer',
      rationale: 'the review stage needs an extra validation step',
      summary: 'add validation',
      changeSummary: [{ op: 'ADD_STAGE', stageId: 's3' }],
    });
    expect(submitted.ok).toBe(true);
    const proposal = submitted.value as { id: string; status: string };
    expect(proposal.status).toBe('open');

    const selfDecision = await f.call('review.decide', {
      proposalId: proposal.id,
      actorId: 'user_designer',
      decision: 'accept',
    });
    expect(selfDecision.ok).toBe(false);
    expect(selfDecision.error?.code).toBe('VALIDATION_FAILED');

    const decided = await f.call('review.decide', {
      proposalId: proposal.id,
      actorId: 'user_lead',
      decision: 'accept',
      note: 'ok',
    });
    expect(decided.ok).toBe(true);
    expect((decided.value as { status: string }).status).toBe('accepted');
  });

  it('J: publishes the first version through the UI path', async () => {
    const f = fixture();
    const published = await f.seedPublishedTemplate();
    expect(published.state).toBe('published');
    expect(published.versions).toHaveLength(1);
    expect(published.versions[0]?.semver).toBe('1.0.0');
  });

  it('J: refuses to publish an invalid draft (the publish gate)', async () => {
    const f = fixture();
    const created = await f.call('draft.create', { orgId: 'org_1', name: 'Empty SOP', actorId: 'user_designer' });
    const refused = await f.call('publish', { templateId: (created.value as WorkflowTemplate).id, actorId: 'user_lead' });
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('VALIDATION_FAILED');
    expect(String(JSON.stringify(refused.error?.details))).toContain('NO_STAGES');
  });

  it('K: compares two versions and reports the structural diff', async () => {
    const f = fixture();
    const published = await f.seedPublishedTemplate();
    const v1 = published.currentVersionId as string;

    // Revision path: proposal → accept → open revision (extra stage) → publish.
    const proposal = await f.call('review.submit', {
      templateId: published.id,
      actorId: 'user_designer',
      rationale: 'add a third stage to the intake flow for validation',
      summary: 'add validation stage',
      changeSummary: [{ op: 'ADD_STAGE', stageId: 's3' }],
    });
    const proposalId = (proposal.value as { id: string }).id;
    await f.call('review.decide', { proposalId, actorId: 'user_lead', decision: 'accept' });

    const opened = await f.call('revision.open', {
      templateId: published.id,
      proposalId,
      actorId: 'user_designer',
      graph: {
        nodes: [
          { id: 's1', kind: 'pack-a:step', title: 'Intake', config: { roleId: 'rol_analyst' } },
          { id: 's2', kind: 'pack-a:step', title: 'Review', config: { roleId: 'rol_reviewer' } },
          { id: 's3', kind: 'pack-a:step', title: 'Validate', config: {} },
        ],
        edges: [
          { from: 's1', to: 's2' },
          { from: 's2', to: 's3' },
        ],
      },
    });
    expect(opened.ok).toBe(true);

    const released = await f.call('publish.revision', { templateId: published.id, actorId: 'user_lead' });
    expect(released.ok).toBe(true);
    const v2 = (released.value as WorkflowTemplate).currentVersionId as string;
    expect(v2).not.toBe(v1);

    const compared = await f.call('compare', { fromVersionId: v1, toVersionId: v2 });
    expect(compared.ok).toBe(true);
    const diff = (compared.value as { diff: { addedStageIds: readonly string[]; addedEdges: readonly string[] } }).diff;
    expect(diff.addedStageIds).toEqual(['s3']);
    expect(diff.addedEdges).toContain('s2->s3');
  });

  it('L: deprecation blocks new runs but not a run already created', async () => {
    const f = fixture();
    const published = await f.seedPublishedTemplate();
    const run = await f.call('run.create', {
      templateId: published.id,
      companyId: 'cmp_1',
      workflowId: 'wfl_1',
      actorId: 'user_owner',
    });
    expect(run.ok).toBe(true);

    const deprecated = await f.call('deprecate', {
      templateId: published.id,
      reason: 'replaced by the new intake SOP',
      actorId: 'user_lead',
    });
    expect(deprecated.ok).toBe(true);

    const blocked = await f.call('run.create', {
      templateId: published.id,
      companyId: 'cmp_1',
      workflowId: 'wfl_1',
      actorId: 'user_owner',
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.code).toBe('DEPRECATED_TEMPLATE');

    // The already-created run keeps executing on its pinned version.
    const engine = createWorkflowEngine({
      ids: f.ids,
      clock: f.clock,
      runs: f.database().runs,
      tasks: f.database().tasks,
      approvals: f.database().approvals,
      events: f.database().events,
      ledger: f.database().ledger,
      unitOfWork: f.database().unitOfWork,
      handlers: createScriptedRegistry({}),
    });
    const created = run.value as { run: WorkflowRun };
    const driven = await engine.drive(created.run.id, { maxSteps: 4 });
    expect(driven.ok).toBe(true);
    if (driven.ok) expect(driven.value.run.state).toBe('EXECUTING');
  });

  it('M: archive makes the template read-only forever', async () => {
    const f = fixture();
    const published = await f.seedPublishedTemplate();
    await f.call('deprecate', { templateId: published.id, reason: 'end of life', actorId: 'user_lead' });
    const archived = await f.call('archive', { templateId: published.id, actorId: 'user_lead' });
    expect(archived.ok).toBe(true);

    const refused = await f.call('draft.applyOps', {
      templateId: published.id,
      actorId: 'user_designer',
      ops: [{ op: 'SET_RISK', stageId: 's1', riskLevel: 'LOW' }],
    });
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('ARCHIVED_READONLY');

    const readable = await f.call('template.get', { templateId: published.id });
    expect(readable.ok).toBe(true);
    expect((readable.value as WorkflowTemplate).state).toBe('archived');
  });
});

describe('N. Run snapshot regression across a Designer publish', () => {
  it('keeps a v1.0 run pinned to v1.0 while the Designer publishes v1.1', async () => {
    const f = fixture();
    const published = await f.seedPublishedTemplate();
    const v1 = published.versions[0] as WorkflowVersion;

    const created = await f.call('run.create', {
      templateId: published.id,
      companyId: 'cmp_1',
      workflowId: 'wfl_1',
      actorId: 'user_owner',
    });
    const run = (created.value as { run: WorkflowRun; snapshot: { snapshotId: string } }).run;
    expect(run.versionId).toBe(v1.id);

    // Designer publishes v1.1 with three stages.
    const proposal = await f.call('review.submit', {
      templateId: published.id,
      actorId: 'user_designer',
      rationale: 'v1.1 adds the validation stage to the intake workflow',
      summary: 'v1.1',
      changeSummary: [{ op: 'ADD_STAGE', stageId: 's3' }],
    });
    const proposalId = (proposal.value as { id: string }).id;
    await f.call('review.decide', { proposalId, actorId: 'user_lead', decision: 'accept' });
    await f.call('revision.open', {
      templateId: published.id,
      proposalId,
      actorId: 'user_designer',
      graph: {
        nodes: [
          { id: 's1', kind: 'pack-a:step', title: 'Intake', config: {} },
          { id: 's2', kind: 'pack-a:step', title: 'Review', config: {} },
          { id: 's3', kind: 'pack-a:step', title: 'Validate', config: {} },
        ],
        edges: [
          { from: 's1', to: 's2' },
          { from: 's2', to: 's3' },
        ],
      },
    });
    const released = await f.call('publish.revision', { templateId: published.id, actorId: 'user_lead' });
    const template = released.value as WorkflowTemplate;
    expect(template.versions.find((version) => version.id === template.currentVersionId)?.semver).toBe('1.1.0');

    // The old run still reads the v1.0 snapshot, and the hash still verifies.
    const snapshotResponse = await f.call('run.snapshot', { snapshotId: run.snapshotId });
    expect(snapshotResponse.ok).toBe(true);
    const snapshot = snapshotResponse.value as { workflowVersionId: string; snapshotHash: string };
    expect(snapshot.workflowVersionId).toBe(v1.id);
    expect(verifyRunSnapshot(snapshot as never, v1)).toEqual({ ok: true, value: true });

    const storedRun = (await f.database().runs.get(run.id)) as WorkflowRun;
    expect(storedRun.versionId).toBe(v1.id);

    // …and a NEW run pins v1.1.
    const second = await f.call('run.create', {
      templateId: published.id,
      companyId: 'cmp_1',
      workflowId: 'wfl_1',
      actorId: 'user_owner',
    });
    const newRun = (second.value as { run: WorkflowRun }).run;
    expect(newRun.versionId).toBe(template.currentVersionId);
    expect(newRun.versionId).not.toBe(v1.id);
  });
});

describe('production wiring defaults (Sprint 5 review MEDIUM-1/2/3)', () => {
  /** An API configured the way `main.ts` configures it. */
  const productionApi = (f: Fixture, actorId: string): WorkflowApi => {
    const db = f.database();
    return createWorkflowApi({
      lifecycle: createWorkflowLifecycle({
        ids: f.ids,
        clock: f.clock,
        templates: db.templates,
        locks: db.locks,
        proposals: db.proposals,
        snapshots: db.snapshots,
        runs: db.runs,
        events: db.events,
        unitOfWork: db.unitOfWork,
        authorize: async ({ actorId: candidate }: { readonly actorId: string }) =>
          candidate === actorId
            ? { ok: true as const, value: true as const }
            : {
                ok: false as const,
                error: new DomainError('POLICY_DENIED', 'not the session actor', { details: {} }),
              },
      }),
      listTemplates: async () => (await db.templates.list({ limit: 500 })).items,
      listProposals: async () => (await db.proposals.list({ limit: 500 })).items,
      defaultRequireRole: true,
    });
  };

  it('enforces the role-binding rule in production without the caller asking', async () => {
    const f = fixture();
    const api = productionApi(f, 'user_owner');

    const created = await api.handle({
      operation: 'draft.create',
      payload: { orgId: 'org_1', name: 'SOP', actorId: 'user_owner' },
    });
    expect(created.ok).toBe(true);
    const templateId = (created.ok ? (created.value as WorkflowTemplate) : null)?.id as string;

    // No role bound: refused in production (and nothing is written).
    const refused = await api.handle({
      operation: 'draft.applyOps',
      payload: {
        templateId,
        actorId: 'user_owner',
        ops: [{ op: 'ADD_STAGE', stage: { id: 's1', kind: 'pack-a:step', title: 'A', config: {} } }],
      },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(refused.error.details)).toContain('MISSING_ROLE');
    }
    expect(((await f.database().templates.get(templateId)) as WorkflowTemplate).versions).toHaveLength(0);

    // With a role bound it goes through.
    const accepted = await api.handle({
      operation: 'draft.applyOps',
      payload: {
        templateId,
        actorId: 'user_owner',
        ops: [
          { op: 'ADD_STAGE', stage: { id: 's1', kind: 'pack-a:step', title: 'A', config: {} } },
          { op: 'SET_ROLE', stageId: 's1', roleId: 'rol_analyst' },
        ],
      },
    });
    expect(accepted.ok).toBe(true);
  });

  it('refuses any actor that is not the session actor', async () => {
    const f = fixture();
    const api = productionApi(f, 'user_owner');
    const refused = await api.handle({
      operation: 'draft.create',
      payload: { orgId: 'org_1', name: 'SOP', actorId: 'intruder' },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('POLICY_DENIED');
  });

  it('proposal.list returns real proposals, not templates', async () => {
    const f = fixture();
    const api = productionApi(f, 'user_owner');
    const created = await api.handle({
      operation: 'draft.create',
      payload: { orgId: 'org_1', name: 'SOP', actorId: 'user_owner' },
    });
    const templateId = (created.ok ? (created.value as WorkflowTemplate) : null)?.id as string;
    await api.handle({
      operation: 'draft.applyOps',
      payload: {
        templateId,
        actorId: 'user_owner',
        ops: [
          { op: 'ADD_STAGE', stage: { id: 's1', kind: 'pack-a:step', title: 'A', config: {} } },
          { op: 'SET_ROLE', stageId: 's1', roleId: 'rol_analyst' },
        ],
      },
    });
    await api.handle({ operation: 'publish', payload: { templateId, actorId: 'user_owner' } });
    await api.handle({
      operation: 'review.submit',
      payload: {
        templateId,
        actorId: 'user_owner',
        rationale: 'add a second stage to the intake workflow',
        changeSummary: [{ op: 'ADD_STAGE', stageId: 's2' }],
      },
    });

    const listed = await api.handle({ operation: 'proposal.list', payload: {} });
    expect(listed.ok).toBe(true);
    const proposals = listed.ok
      ? (listed.value as readonly { proposalId: string; status: string; templateId: string }[])
      : [];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ status: 'open', templateId });
    // …and it is NOT a template summary.
    expect(JSON.stringify(proposals[0])).not.toContain('currentVersion');
  });
});

describe('R. state stays consistent across a restart', () => {
  it('keeps drafts, versions, proposals and the library view after reopening', async () => {
    const f = fixture();
    const published = await f.seedPublishedTemplate();
    const forked = await f.call('fork', { templateId: published.id, name: 'branch', actorId: 'user_designer' });
    const forkId = (forked.value as WorkflowTemplate).id;
    await f.call('draft.applyOps', {
      templateId: forkId,
      actorId: 'user_designer',
      ops: [
        { op: 'ADD_STAGE', stage: { id: 's1', kind: 'pack-a:step', title: 'Only', config: {} } },
      ],
    });

    f.restart();

    const library = await f.call('library.list');
    const rows = library.value as readonly { templateId: string; state: string; currentVersion: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.templateId === published.id)?.state).toBe('published');
    expect(rows.find((row) => row.templateId === forkId)?.state).toBe('draft');

    const opened = await f.call('draft.open', { templateId: forkId });
    const view = opened.value as { graph: { nodes: readonly unknown[] }; editable: boolean; validation: { valid: boolean } };
    expect(view.editable).toBe(true);
    expect(view.graph.nodes).toHaveLength(1);
    expect(view.validation.valid).toBe(true);

    // The published template's version content survived the restart untouched.
    const stored = (await f.database().templates.get(published.id)) as WorkflowTemplate;
    expect(stored.versions).toHaveLength(1);
    expect(stored.versions[0]?.semver).toBe('1.0.0');
  });
});
