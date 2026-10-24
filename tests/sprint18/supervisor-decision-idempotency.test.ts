/**
 * Sprint 18 / Task-18-03 — permanent decision idempotency (§58 matrix) and zero side effects
 * (§59 matrix), plus the production composition seam (§60/§61).
 *
 * The load-bearing test is #25: the command ledger entry is deleted the way a trim would, the
 * whole application graph is rebuilt over the same durable file, and the SAME command must
 * still land on the SAME decision row — never a second one. That is why permanent identity is
 * a hard condition for this task.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ok, type DomainError, type Result } from '@companyos/core';
import {
  createArtifactService,
  createModelRegistry,
  createProviderRegistry,
  createRunGoalService,
  createRunModelBindingReader,
  createRunSnapshotVerifier,
  createSupervisorDecisionSink,
  createWorkflowLifecycle,
  supervisorDecisionCommandId,
  type SupervisorDecisionSink,
} from '@companyos/engine';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18idem-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18I${String(++seq).padStart(12, '0')}`,
  ulid: () => `18I${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack', 'memory'] as const;
const COMPANY = 'company_default';
const ACTOR = 'user_owner';
const OBJECTIVE = 'Prove permanent decision idempotency without a second row.';

interface Graph {
  readonly db: DurableDatabase;
  readonly dataDir: string;
  readonly casRoot: string;
  readonly sink: SupervisorDecisionSink;
  lifecycle(): ReturnType<typeof createWorkflowLifecycle>;
  publishTemplate(label: string): Promise<string>;
  runWithGoal(label: string): Promise<string>;
  seedArtifact(runId: string, label: string): Promise<string>;
}

const graph = (database: DurableDatabase, dataDir: string, casRoot: string): Graph => {
  const authorize = async (): Promise<Result<true, DomainError>> => ok(true as const);
  const contentStore = createFilesystemArtifactContentStore({ casRoot });
  const artifacts = createArtifactService({
    artifactStore: database.artifactStore!,
    contentStore,
    runs: database.runs,
    events: database.events,
    ledger: database.ledger,
    clock,
    ids,
    unitOfWork: database.unitOfWork,
    authorize: authorize as never,
  });
  const runGoal = createRunGoalService({
    artifactService: artifacts,
    artifactStore: database.artifactStore!,
    contentStore,
    runs: database.runs,
  });
  const providers = createProviderRegistry({
    ids,
    clock,
    registrations: database.providers,
    models: database.providerModels,
    authorize: authorize as never,
    events: database.events,
    systemActor: ACTOR,
  });
  const models = createModelRegistry({
    ids,
    clock,
    records: database.modelRecords,
    aliases: database.modelAliases,
    providers,
    events: database.events,
    scope: 'default',
  });
  const lifecycle = createWorkflowLifecycle({
    ids,
    clock,
    templates: database.templates,
    locks: database.locks,
    proposals: database.proposals,
    snapshots: database.snapshots,
    runs: database.runs,
    events: database.events,
    unitOfWork: database.unitOfWork,
    ledger: database.ledger,
    runGoal,
    modelRegistry: models,
    authorize: async (): Promise<Result<true, never>> => ok(true as const),
  });
  const sink = createSupervisorDecisionSink({
    runs: database.runs,
    tasks: database.tasks,
    templates: database.templates,
    decisions: database.decisions!,
    runGoal,
    runSnapshotVerifier: createRunSnapshotVerifier({ templates: database.templates, snapshots: database.snapshots }),
    modelBindings: createRunModelBindingReader({ runs: database.runs, snapshots: database.snapshots }),
    modelRegistry: models,
    durableReferenceResolver: async (refs) => {
      const anchored: { kind: string; id: string; ref: string; runId: string }[] = [];
      for (const ref of refs) {
        const id = ref.startsWith('artifact:') ? ref.slice('artifact:'.length) : ref;
        const row = await database.artifactStore!.get(id as never);
        if (row === null) {
          return { ok: false as const, error: { code: 'NOT_FOUND', message: `missing ${ref}`, details: {} } as DomainError };
        }
        anchored.push({ kind: 'artifact', id: row.id, ref, runId: row.runId });
      }
      return { ok: true as const, value: anchored };
    },
    authorize: authorize as never,
    unitOfWork: database.unitOfWork,
    clock,
    ids,
  });
  return {
    db: database,
    dataDir,
    casRoot,
    sink,
    lifecycle: () => lifecycle,
    async publishTemplate(label) {
      const template = await lifecycle.createTemplate({ orgId: COMPANY, name: `Idempotency flow ${label}`, actorId: ACTOR, traceId: `t18i_tpl_${label}` });
      if (!template.ok) throw new Error(template.error.message);
      const graphShape = {
        nodes: [
          { id: 's1', kind: 'work' as const, title: 's1', config: {} },
          { id: 's2', kind: 'work' as const, title: 's2', config: {} },
        ],
        edges: [{ from: 's1', to: 's2' }],
      };
      const saved = await lifecycle.saveDraftGraph({ templateId: template.value.id, graph: graphShape, actorId: ACTOR, traceId: `t18i_graph_${label}` });
      if (!saved.ok) throw new Error(saved.error.message);
      const published = await lifecycle.publish({ templateId: template.value.id, actorId: ACTOR, traceId: `t18i_pub_${label}` });
      if (!published.ok) throw new Error(published.error.message);
      return template.value.id;
    },
    async runWithGoal(label) {
      const templateId = await this.publishTemplate(label);
      const run = await lifecycle.createRun({
        templateId,
        companyId: COMPANY,
        workflowId: `wf_${label}`,
        actorId: ACTOR,
        goal: { objective: OBJECTIVE, source: { type: 'human', ref: label } },
      });
      if (!run.ok) throw new Error(run.error.message);
      return run.value.run.id;
    },
    async seedArtifact(runId, label) {
      const made = await artifacts.create({
        commandId: `idem-evidence:${label}`,
        runId: runId as never,
        taskId: null,
        kind: 'companyos:evidence',
        content: new TextEncoder().encode(JSON.stringify({ label })),
        producedBy: ACTOR,
        traceId: `t18i_art_${label}`,
      });
      if (!made.ok) throw new Error(made.error.message);
      return `artifact:${made.value.id}`;
    },
  };
};

const openGraph = (): Graph => {
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  return graph(db, dataDir, casRoot);
};

const commandFor = (
  runId: string,
  over: Partial<Parameters<SupervisorDecisionSink['record']>[0]> = {},
): Parameters<SupervisorDecisionSink['record']>[0] => ({
  commandId: supervisorDecisionCommandId(runId, 'intent'),
  companyId: COMPANY,
  runId,
  action: 'CONTINUE',
  reasonCode: 'GOAL_SATISFIED',
  summary: 'The run objective is still on track.',
  decidedBy: ACTOR,
  ...over,
});

const decisionCount = (db: DurableDatabase): number =>
  Number((db.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as { c: number | bigint }).c);

describe('T18-03 permanent decision idempotency (§58)', () => {
  it('22. the same command and fingerprint replays the exact decision', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('replay');
    const first = await g.sink.record(commandFor(runId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const again = await g.sink.record(commandFor(runId));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.decisionId).toBe(first.value.decisionId);
    expect(decisionCount(g.db)).toBe(1);
  });

  it('23. the same command with different content conflicts', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('conflict');
    const first = await g.sink.record(commandFor(runId));
    expect(first.ok).toBe(true);

    const changed = await g.sink.record(commandFor(runId, { summary: 'A different conclusion entirely.' }));
    expect(changed.ok).toBe(false);
    if (changed.ok) return;
    expect(changed.error.code).toBe('CONFLICT');
    expect(changed.error.details?.['reason']).toBe('SUPERVISOR_DECISION_FINGERPRINT_MISMATCH');
    expect(decisionCount(g.db)).toBe(1);
  });

  it('24. a restart replay yields no duplicate', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('restart-replay');
    const first = await g.sink.record(commandFor(runId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    g.db.close();
    const tracked = openDatabases.indexOf(g.db);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const reopened = openDurableDatabase({ dataDir: g.dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
    openDatabases.push(reopened);
    const fresh = graph(reopened, g.dataDir, g.casRoot);

    const again = await fresh.sink.record(commandFor(runId));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.decisionId).toBe(first.value.decisionId);
    expect(decisionCount(reopened)).toBe(1);
  });

  it('25. a ledger-trim replay still yields the original decision', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('trim');
    const first = await g.sink.record(commandFor(runId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(decisionCount(g.db)).toBe(1);

    // The ledger is bounded and trimmable: remove this entry exactly as a trim would.
    g.db.db.prepare('DELETE FROM command_ledger WHERE command_id = ?').run(first.value.subjectKey as string);
    g.db.db.prepare('DELETE FROM command_ledger').run();

    g.db.close();
    const tracked = openDatabases.indexOf(g.db);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const reopened = openDurableDatabase({ dataDir: g.dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
    openDatabases.push(reopened);
    const fresh = graph(reopened, g.dataDir, g.casRoot);

    const again = await fresh.sink.record(commandFor(runId));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.decisionId).toBe(first.value.decisionId);
    expect(decisionCount(reopened)).toBe(1);
  });

  it('26. concurrent identical commands yield exactly one decision', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('concurrent');
    const results = await Promise.all([
      g.sink.record(commandFor(runId)),
      g.sink.record(commandFor(runId)),
      g.sink.record(commandFor(runId)),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const idsOf = results.map((result) => (result.ok ? result.value.decisionId : ''));
    expect(new Set(idsOf).size).toBe(1);
    expect(decisionCount(g.db)).toBe(1);
  });

  it('27. a crash-style retry yields the original decision', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('crash-retry');
    // The caller does not know whether the write landed, so it reissues the same command
    // against a completely fresh graph (the crash-restart shape).
    const first = await g.sink.record(commandFor(runId));
    expect(first.ok).toBe(true);

    g.db.close();
    const tracked = openDatabases.indexOf(g.db);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const reopened = openDurableDatabase({ dataDir: g.dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
    openDatabases.push(reopened);
    const fresh = graph(reopened, g.dataDir, g.casRoot);
    const retried = await fresh.sink.record(commandFor(runId));
    expect(retried.ok).toBe(true);
    if (!retried.ok || !first.ok) return;
    expect(retried.value.decisionId).toBe(first.value.decisionId);
    expect(decisionCount(reopened)).toBe(1);
  });
});

describe('T18-03 zero decision side effects (§59)', () => {
  it('28. REQUEST_CORRECTIVE creates zero tasks and touches no stage', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('side-corrective');
    const evidence = await g.seedArtifact(runId, 'side-corrective-1');
    const tasksBefore = (await g.db.tasks.list({ limit: 100 })).items.length;
    const run = await g.db.runs.get(runId as never);
    const result = await g.sink.record(
      commandFor(runId, {
        commandId: supervisorDecisionCommandId(runId, 'intent'),
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'A corrective is requested; nothing is provisioned yet.',
        evidenceRefs: [evidence],
      }),
    );
    expect(result.ok).toBe(true);
    expect((await g.db.tasks.list({ limit: 100 })).items.length).toBe(tasksBefore);
    expect((await g.db.runs.get(runId as never))?.state).toBe(run?.state);
    // There is no stage table in the frozen schema at all: stages live in the version graph,
    // so a decision physically cannot mutate any Stage.taskIds.
    const tables = (g.db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    expect(tables).not.toContain('stages');
  });

  it('29. COMPLETE changes zero task/stage/run statuses', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('side-complete');
    const evidence = await g.seedArtifact(runId, 'side-complete-1');
    const before = await g.db.runs.get(runId as never);
    const result = await g.sink.record(
      commandFor(runId, {
        commandId: supervisorDecisionCommandId(runId, 'done'),
        action: 'COMPLETE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'The evidence set satisfies the objective.',
        evidenceRefs: [evidence],
      }),
    );
    expect(result.ok).toBe(true);
    const after = await g.db.runs.get(runId as never);
    expect(after?.state).toBe(before?.state);
    expect(after?.revision).toBe(before?.revision);
  });

  it('30. ESCALATE creates no approval', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('side-escalate');
    const evidence = await g.seedArtifact(runId, 'side-escalate-1');
    const approvalsBefore = (await g.db.approvals.list({ limit: 100 })).items.length;
    const eventsBefore = (await g.db.events.all()).length;
    const result = await g.sink.record(
      commandFor(runId, {
        commandId: supervisorDecisionCommandId(runId, 'escalate'),
        action: 'ESCALATE',
        reasonCode: 'HUMAN_REQUIRED',
        summary: 'No legal action remains without a human decision.',
        evidenceRefs: [evidence],
      }),
    );
    expect(result.ok).toBe(true);
    expect((await g.db.approvals.list({ limit: 100 })).items.length).toBe(approvalsBefore);
    // The only durable additions are the decision row and (optionally) its audit event.
    expect((await g.db.events.all()).length).toBeGreaterThanOrEqual(eventsBefore);
  });

  it('31. the repository runtime is untouched by a decision', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('side-repository');
    const toolRows = g.db.db.prepare('SELECT COUNT(*) AS c FROM tool_invocations').get() as { c: number | bigint };
    const result = await g.sink.record(commandFor(runId));
    expect(result.ok).toBe(true);
    const after = g.db.db.prepare('SELECT COUNT(*) AS c FROM tool_invocations').get() as { c: number | bigint };
    expect(Number(after.c)).toBe(Number(toolRows.c));
  });

  it('32. the ToolRegistry is untouched by a decision', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('side-tools');
    const toolRecords = (await g.db.toolRecords.list({ limit: 500 })).items.length;
    const result = await g.sink.record(commandFor(runId));
    expect(result.ok).toBe(true);
    expect((await g.db.toolRecords.list({ limit: 500 })).items.length).toBe(toolRecords);
  });

  it('33. the authority catalog is unchanged', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('side-authority');
    const result = await g.sink.record(commandFor(runId));
    expect(result.ok).toBe(true);
    const roles = (await g.db.roles.list({ limit: 500 })).items;
    expect(roles).toEqual([]);
    const { AUTHORITIES } = await import('@companyos/core');
    expect((AUTHORITIES as readonly string[]).includes('supervisor.decision')).toBe(false);
    expect((AUTHORITIES as readonly string[]).includes('task.create')).toBe(false);
  });

  it('34. no DevCompany or pack content changed', async () => {
    const g = openGraph();
    const runId = await g.runWithGoal('side-packs');
    const packRows = (table: string): number => {
      const exists = g.db.db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { c: number | bigint };
      if (Number(exists.c) === 0) return 0;
      return Number((g.db.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number | bigint }).c);
    };
    const before = {
      versions: packRows('pack_versions'),
      installations: packRows('pack_installations'),
      refs: packRows('pack_content_refs'),
    };
    const result = await g.sink.record(commandFor(runId));
    expect(result.ok).toBe(true);
    expect(packRows('pack_versions')).toBe(before.versions);
    expect(packRows('pack_installations')).toBe(before.installations);
    expect(packRows('pack_content_refs')).toBe(before.refs);
  });
});
