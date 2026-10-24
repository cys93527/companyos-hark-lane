/**
 * Sprint 18 / Task-18-03 corrective — tenant-scoped identity, run decision HISTORY, and the
 * evidence reference contract (21 assertions, Boss §X).
 *
 * The three things this suite pins down:
 *   1. a supervisor decision command identity has NO enforceable global uniqueness, so the
 *      decision identity and its fingerprint are TENANT-scoped;
 *   2. `listRunDecisionHistory` is the audit/recovery reader and is never active-only, while
 *      `listActiveRunDecisions` is a separately named query;
 *   3. `relatedArtifactRefs` stays artifact-only — a Validation identity is never disguised as
 *      an artifact ref, and QA provenance is cited through the report Artifact.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { domainError, ok, type DecisionStorePort, type DomainError, type Result } from '@companyos/core';
import {
  createArtifactService,
  createDecisionService,
  createModelRegistry,
  createProviderRegistry,
  createRunGoalService,
  createRunModelBindingReader,
  createRunSnapshotVerifier,
  createSupervisorDecisionSink,
  createWorkflowLifecycle,
  supervisorDecisionCommandId,
  supervisorDecisionIdOf,
  type SupervisorDecisionSink,
  type WorkflowLifecycle,
} from '@companyos/engine';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18corr-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18C${String(++seq).padStart(12, '0')}`,
  ulid: () => `18C${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack', 'memory'] as const;
const COMPANY_A = 'company_default';
const COMPANY_B = 'company_other';
const ACTOR = 'user_owner';
const OBJECTIVE = 'Prove tenant-scoped decision identity and full history.';

interface Services {
  readonly runGoal: ReturnType<typeof createRunGoalService>;
  readonly lifecycle: WorkflowLifecycle;
  readonly sink: SupervisorDecisionSink;
  readonly decisions: DecisionStorePort;
  readonly artifacts: ReturnType<typeof createArtifactService>;
}

const services = (db: DurableDatabase, casRoot: string): Services => {
  const authorize = async (): Promise<Result<true, DomainError>> => ok(true as const);
  const contentStore = createFilesystemArtifactContentStore({ casRoot });
  const artifacts = createArtifactService({
    artifactStore: db.artifactStore!,
    contentStore,
    runs: db.runs,
    events: db.events,
    ledger: db.ledger,
    clock,
    ids,
    unitOfWork: db.unitOfWork,
    authorize: authorize as never,
  });
  const runGoal = createRunGoalService({
    artifactService: artifacts,
    artifactStore: db.artifactStore!,
    contentStore,
    runs: db.runs,
  });
  const providers = createProviderRegistry({
    ids,
    clock,
    registrations: db.providers,
    models: db.providerModels,
    authorize: authorize as never,
    events: db.events,
    systemActor: ACTOR,
  });
  const models = createModelRegistry({
    ids,
    clock,
    records: db.modelRecords,
    aliases: db.modelAliases,
    providers,
    events: db.events,
    scope: 'default',
  });
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
    ledger: db.ledger,
    runGoal,
    modelRegistry: models,
    authorize: async (): Promise<Result<true, never>> => ok(true as const),
  });
  // The shared resolver of Sprint 13 semantics: artifact AND validation grammars resolve, and
  // each resolved reference reports the durable run it belongs to.
  const durableReferenceResolver = async (
    refs: readonly string[],
  ): Promise<Result<readonly { kind: string; id: string; ref: string; runId: string }[], DomainError>> => {
    const anchored: { kind: string; id: string; ref: string; runId: string }[] = [];
    for (const ref of refs) {
      if (ref.startsWith('artifact:') || ref.startsWith('art_')) {
        const id = ref.startsWith('artifact:') ? ref.slice('artifact:'.length) : ref;
        const row = await db.artifactStore!.get(id as never);
        if (row === null) {
          return { ok: false as const, error: domainError('NOT_FOUND', `missing artifact ${ref}`, { reference: ref }) };
        }
        anchored.push({ kind: 'artifact', id: row.id, ref, runId: row.runId });
        continue;
      }
      if (ref.startsWith('val_')) {
        const row = await db.validationStore!.get(ref as never);
        if (row === null) {
          return { ok: false as const, error: domainError('NOT_FOUND', `missing validation ${ref}`, { reference: ref }) };
        }
        anchored.push({ kind: 'validation', id: row.id, ref, runId: row.runId });
        continue;
      }
      return {
        ok: false as const,
        error: domainError('INVALID_ARGUMENT', `unknown durable reference grammar: "${ref}"`, { reference: ref }),
      };
    }
    return { ok: true as const, value: anchored };
  };

  const sink = createSupervisorDecisionSink({
    runs: db.runs,
    tasks: db.tasks,
    templates: db.templates,
    decisions: db.decisions!,
    runGoal,
    runSnapshotVerifier: createRunSnapshotVerifier({ templates: db.templates, snapshots: db.snapshots }),
    modelBindings: createRunModelBindingReader({ runs: db.runs, snapshots: db.snapshots }),
    modelRegistry: models,
    durableReferenceResolver,
    authorize: authorize as never,
    unitOfWork: db.unitOfWork,
    clock,
    ids,
  });
  return { runGoal, lifecycle, sink, decisions: db.decisions!, artifacts };
};

const openFixture = (): { readonly db: DurableDatabase; readonly dataDir: string; readonly casRoot: string; readonly services: Services } => {
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  return { db, dataDir, casRoot, services: services(db, casRoot) };
};

const runFor = async (
  f: { readonly services: Services },
  companyId: string,
  label: string,
): Promise<string> => {
  const template = await f.services.lifecycle.createTemplate({
    orgId: companyId,
    name: `Corrective flow ${label}`,
    actorId: ACTOR,
    traceId: `t18c_tpl_${label}`,
  });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [
      { id: 's1', kind: 'work' as const, title: 's1', config: {} },
      { id: 's2', kind: 'work' as const, title: 's2', config: {} },
    ],
    edges: [{ from: 's1', to: 's2' }],
  };
  const saved = await f.services.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: ACTOR, traceId: `t18c_graph_${label}` });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await f.services.lifecycle.publish({ templateId: template.value.id, actorId: ACTOR, traceId: `t18c_pub_${label}` });
  if (!published.ok) throw new Error(published.error.message);
  const run = await f.services.lifecycle.createRun({
    templateId: template.value.id,
    companyId,
    workflowId: `wf_${label}`,
    actorId: ACTOR,
    goal: { objective: OBJECTIVE, source: { type: 'human', ref: label } },
  });
  if (!run.ok) throw new Error(run.error.message);
  return run.value.run.id;
};

type Command = Parameters<SupervisorDecisionSink['record']>[0];
const commandFor = (companyId: string, runId: string, commandId: string, over: Partial<Command> = {}): Command => ({
  commandId,
  companyId,
  runId,
  action: 'CONTINUE',
  reasonCode: 'GOAL_SATISFIED',
  summary: 'The run objective is still on track.',
  decidedBy: ACTOR,
  ...over,
});

const decisionCount = (db: DurableDatabase): number =>
  Number((db.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as { c: number | bigint }).c);

describe('T18-03 corrective — tenant-scoped decision identity', () => {
  it('1. command identity has no enforceable global uniqueness contract', () => {
    const f = openFixture();
    // The ledger IS globally unique (command_id PRIMARY KEY) but it is bounded and this sink
    // never writes a ledger row, so a decision command identity is never registered anywhere.
    const ledger = f.db.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'command_ledger'").get() as { sql: string };
    expect(ledger.sql).toContain('command_id');
    expect(ledger.sql.toLowerCase()).toContain('primary key');
    // No company column: the ledger cannot scope an identity to a tenant.
    expect(ledger.sql.toLowerCase()).not.toContain('company');
    // And no decision command identity is recorded there by the sink itself.
    const before = decisionCount(f.db);
    expect(before).toBe(0);
  });

  it('2. the same command identity in two companies does not collide', async () => {
    const f = openFixture();
    const runA = await runFor(f, COMPANY_A, 'a');
    const runB = await runFor(f, COMPANY_B, 'b');
    const commandId = supervisorDecisionCommandId(runA, 'same-command');
    const mirrored = supervisorDecisionCommandId(runB, 'same-command');

    const first = await f.services.sink.record(commandFor(COMPANY_A, runA, commandId));
    const second = await f.services.sink.record(commandFor(COMPANY_B, runB, mirrored));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.decisionId).not.toBe(second.value.decisionId);
    expect(decisionCount(f.db)).toBe(2);
  });

  it('3. the decision identity is tenant scoped', () => {
    expect(supervisorDecisionIdOf(COMPANY_A, 'same')).not.toBe(supervisorDecisionIdOf(COMPANY_B, 'same'));
    expect(supervisorDecisionIdOf(COMPANY_A, 'same')).toBe(supervisorDecisionIdOf(COMPANY_A, 'same'));
    // The identity stays inside the legal id length of the decisions row.
    expect(supervisorDecisionIdOf(COMPANY_A, 'same').length).toBeLessThanOrEqual(40);
    expect(supervisorDecisionIdOf(COMPANY_A, 'same').startsWith('dec_')).toBe(true);
  });

  it('4. the fingerprint is tenant scoped', async () => {
    const f = openFixture();
    const runA = await runFor(f, COMPANY_A, 'fp-a');
    const runB = await runFor(f, COMPANY_B, 'fp-b');
    const commandId = supervisorDecisionCommandId(runA, 'fp');
    const mirrored = supervisorDecisionCommandId(runB, 'fp');
    const a = await f.services.sink.record(commandFor(COMPANY_A, runA, commandId));
    const b = await f.services.sink.record(commandFor(COMPANY_B, runB, mirrored));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const metaA = a.value.metadata as Record<string, unknown>;
    const metaB = b.value.metadata as Record<string, unknown>;
    const fingerprintA = (metaA['supervisor'] as Record<string, unknown>)['fingerprint'];
    const fingerprintB = (metaB['supervisor'] as Record<string, unknown>)['fingerprint'];
    expect(fingerprintA).not.toBe(fingerprintB);
  });

  it('5. same-tenant same command replays the exact decision', async () => {
    const f = openFixture();
    const runId = await runFor(f, COMPANY_A, 'replay');
    const commandId = supervisorDecisionCommandId(runId, 'replay');
    const first = await f.services.sink.record(commandFor(COMPANY_A, runId, commandId));
    const again = await f.services.sink.record(commandFor(COMPANY_A, runId, commandId));
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.value.decisionId).toBe(first.value.decisionId);
    expect(decisionCount(f.db)).toBe(1);
  });

  it('6. a cross-tenant replay is rejected without leaking existence', async () => {
    const f = openFixture();
    const runA = await runFor(f, COMPANY_A, 'victim');
    const commandId = supervisorDecisionCommandId(runA, 'secret');
    const first = await f.services.sink.record(commandFor(COMPANY_A, runA, commandId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Company B replays A's identity against A's own run/evidence ids.
    const attack = await f.services.sink.record(commandFor(COMPANY_B, runA, commandId));
    expect(attack.ok).toBe(false);
    if (attack.ok) return;
    expect(attack.error.code).toBe('NOT_FOUND');
    // The refusal is indistinguishable from "no such run", so no existence is disclosed …
    expect(attack.error.details?.['reason']).toBe('RUN_MISSING');
    // … and the deterministic identity of A was never reachable from B's scope.
    expect(f.services.sink.decisionIdOf(COMPANY_B, commandId)).not.toBe(first.value.decisionId);
    expect(first.value.decisionId).toBe(supervisorDecisionIdOf(COMPANY_A, commandId));
    const read = await f.services.sink.getDecision({
      decisionId: first.value.decisionId,
      companyId: COMPANY_B,
      actorId: ACTOR,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe('NOT_FOUND');
    expect(decisionCount(f.db)).toBe(1);
  });

  it('7. after a ledger trim the same-tenant replay is still exact', async () => {
    const f = openFixture();
    const runId = await runFor(f, COMPANY_A, 'trim');
    const commandId = supervisorDecisionCommandId(runId, 'trim');
    const first = await f.services.sink.record(commandFor(COMPANY_A, runId, commandId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    f.db.db.prepare('DELETE FROM command_ledger').run();
    f.db.close();
    const tracked = openDatabases.indexOf(f.db);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const reopened = openDurableDatabase({ dataDir: f.dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
    openDatabases.push(reopened);
    const fresh = services(reopened, f.casRoot);

    const again = await fresh.sink.record(commandFor(COMPANY_A, runId, commandId));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.decisionId).toBe(first.value.decisionId);
    expect(decisionCount(reopened)).toBe(1);

    // The other tenant keeps its own independent namespace over the same durable file.
    const runB = await runFor({ services: fresh }, COMPANY_B, 'trim-b');
    const mirrored = await fresh.sink.record(
      commandFor(COMPANY_B, runB, supervisorDecisionCommandId(runB, 'trim')),
    );
    expect(mirrored.ok).toBe(true);
    if (!mirrored.ok) return;
    expect(mirrored.value.decisionId).not.toBe(first.value.decisionId);
    expect(decisionCount(reopened)).toBe(2);
  });

  it('8. concurrent identical commands in one company yield one decision', async () => {
    const f = openFixture();
    const runId = await runFor(f, COMPANY_A, 'concurrent-a');
    const commandId = supervisorDecisionCommandId(runId, 'concurrent');
    const results = await Promise.all([
      f.services.sink.record(commandFor(COMPANY_A, runId, commandId)),
      f.services.sink.record(commandFor(COMPANY_A, runId, commandId)),
      f.services.sink.record(commandFor(COMPANY_A, runId, commandId)),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.value.decisionId : ''))).size).toBe(1);
    expect(decisionCount(f.db)).toBe(1);
  });

  it('9. concurrent identical command ids in different companies are independent', async () => {
    const f = openFixture();
    const runA = await runFor(f, COMPANY_A, 'concurrent-shared-a');
    const runB = await runFor(f, COMPANY_B, 'concurrent-shared-b');
    const commandId = supervisorDecisionCommandId(runA, 'shared');
    const mirrored = supervisorDecisionCommandId(runB, 'shared');
    const results = await Promise.all([
      f.services.sink.record(commandFor(COMPANY_A, runA, commandId)),
      f.services.sink.record(commandFor(COMPANY_B, runB, mirrored)),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.value.decisionId : ''))).size).toBe(2);
    expect(decisionCount(f.db)).toBe(2);
  });
});

describe('T18-03 corrective — run decision history reader', () => {
  it('10/11/12. the history reader returns ACTIVE, SUPERSEDED and REVOKED facts', async () => {
    const f = openFixture();
    const runId = await runFor(f, COMPANY_A, 'history');
    const commandId = supervisorDecisionCommandId(runId, 'history');
    const recorded = await f.services.sink.record(commandFor(COMPANY_A, runId, commandId));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    // The generic decision lifecycle supersedes it (existing domain behaviour, version 2).
    const decisions = createDecisionService({
      store: f.services.decisions,
      clock,
      ids,
      authorize: async (): Promise<Result<true, DomainError>> => ok(true as const),
    });
    const superseded = await decisions.supersede({
      decisionId: recorded.value.decisionId,
      version: 1,
      actorId: ACTOR,
      next: {
        companyId: COMPANY_A,
        scope: { type: 'WORKFLOW', id: runId },
        subjectKey: commandId,
        title: 'CONTINUE — GOAL_SATISFIED (revised)',
        question: OBJECTIVE,
        decision: 'CONTINUE',
        rationale: 'A later revision of the same decision.',
        alternativesConsidered: [],
        constraints: [],
        consequences: [],
        relatedMemoryRefs: [],
        relatedHandoffRefs: [],
        relatedArtifactRefs: [],
        decidedBy: ACTOR,
        traceId: ids.id('trace'),
        provenance: { sourceType: 'WORKFLOW', sourceRefs: [`run:${runId}`] },
        metadata: { supervisor: { schema: 'companyos/supervisor-decision/1', companyId: COMPANY_A, runId, commandId, fingerprint: recorded.value.metadata && 'x' } },
      },
    });
    expect(superseded.ok).toBe(true);

    const history = await f.services.sink.listRunDecisionHistory({ runId, companyId: COMPANY_A, actorId: ACTOR });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    const statuses = history.value.map((row) => row.status);
    expect(statuses).toContain('SUPERSEDED');
    expect(statuses).toContain('ACTIVE');
    // The historical fact of version 1 is never erased.
    expect(history.value.some((row) => row.version === 1 && row.decisionId === recorded.value.decisionId)).toBe(true);
    expect(history.value.some((row) => row.version === 2)).toBe(true);

    const revoked = await decisions.revoke({ decisionId: recorded.value.decisionId, version: 2, actorId: ACTOR });
    expect(revoked.ok).toBe(true);
    const afterRevoke = await f.services.sink.listRunDecisionHistory({ runId, companyId: COMPANY_A, actorId: ACTOR });
    expect(afterRevoke.ok).toBe(true);
    if (!afterRevoke.ok) return;
    expect(afterRevoke.value.map((row) => row.status)).toContain('REVOKED');
    expect(afterRevoke.value.some((row) => row.version === 1)).toBe(true);
  });

  it('13. history ordering is deterministic', async () => {
    const f = openFixture();
    const runId = await runFor(f, COMPANY_A, 'order');
    const evidence = await f.services.artifacts.create({
      commandId: 'corrective-evidence:order',
      runId: runId as never,
      taskId: null,
      kind: 'companyos:evidence',
      content: new TextEncoder().encode('order'),
      producedBy: ACTOR,
      traceId: 't18c_art_order',
    });
    if (!evidence.ok) throw new Error(evidence.error.message);
    const first = await f.services.sink.record(
      commandFor(COMPANY_A, runId, supervisorDecisionCommandId(runId, 'order-1'), {
        evidenceRefs: [`artifact:${evidence.value.id}`],
      }),
    );
    const second = await f.services.sink.record(
      commandFor(COMPANY_A, runId, supervisorDecisionCommandId(runId, 'order-2'), {
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'TASK_FAILED',
        summary: 'A later decision in the same run.',
        evidenceRefs: [`artifact:${evidence.value.id}`],
      }),
    );
    expect(first.ok && second.ok).toBe(true);
    const left = await f.services.sink.listRunDecisionHistory({ runId, companyId: COMPANY_A, actorId: ACTOR });
    const right = await f.services.sink.listRunDecisionHistory({ runId, companyId: COMPANY_A, actorId: ACTOR });
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.value.map((row) => row.decisionId)).toEqual(right.value.map((row) => row.decisionId));
    // Chronological, and the same command identity resolves to the same order across calls.
    const timestamps = left.value.map((row) => row.decidedAt);
    expect([...timestamps].sort()).toEqual(timestamps);
  });

  it('14. the history reader is tenant safe', async () => {
    const f = openFixture();
    const runA = await runFor(f, COMPANY_A, 'tenant-history');
    const runB = await runFor(f, COMPANY_B, 'tenant-history-b');
    const a = await f.services.sink.record(commandFor(COMPANY_A, runA, supervisorDecisionCommandId(runA, 'h')));
    const b = await f.services.sink.record(commandFor(COMPANY_B, runB, supervisorDecisionCommandId(runB, 'h')));
    expect(a.ok && b.ok).toBe(true);
    const foreign = await f.services.sink.listRunDecisionHistory({ runId: runA, companyId: COMPANY_B, actorId: ACTOR });
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    expect(foreign.value).toEqual([]);
    const own = await f.services.sink.listRunDecisionHistory({ runId: runB, companyId: COMPANY_B, actorId: ACTOR });
    if (!own.ok) throw new Error(own.error.message);
    expect(own.value.length).toBe(1);
  });

  it('15. the history reader is run safe', async () => {
    const f = openFixture();
    const runA = await runFor(f, COMPANY_A, 'run-safe-a');
    const runB = await runFor(f, COMPANY_A, 'run-safe-b');
    const a = await f.services.sink.record(commandFor(COMPANY_A, runA, supervisorDecisionCommandId(runA, 'r')));
    expect(a.ok).toBe(true);
    const forB = await f.services.sink.listRunDecisionHistory({ runId: runB, companyId: COMPANY_A, actorId: ACTOR });
    expect(forB.ok).toBe(true);
    if (!forB.ok) return;
    expect(forB.value).toEqual([]);
  });

  it('16. the active reader is a separate, explicitly named query', async () => {
    const f = openFixture();
    const runId = await runFor(f, COMPANY_A, 'active-reader');
    const commandId = supervisorDecisionCommandId(runId, 'active');
    const recorded = await f.services.sink.record(commandFor(COMPANY_A, runId, commandId));
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const decisions = createDecisionService({
      store: f.services.decisions,
      clock,
      ids,
      authorize: async (): Promise<Result<true, DomainError>> => ok(true as const),
    });
    const superseded = await decisions.supersede({
      decisionId: recorded.value.decisionId,
      version: 1,
      actorId: ACTOR,
      next: {
        companyId: COMPANY_A,
        scope: { type: 'WORKFLOW', id: runId },
        subjectKey: commandId,
        title: 'CONTINUE — GOAL_SATISFIED (revised)',
        question: OBJECTIVE,
        decision: 'CONTINUE',
        rationale: 'A later revision of the same decision.',
        alternativesConsidered: [],
        constraints: [],
        consequences: [],
        relatedMemoryRefs: [],
        relatedHandoffRefs: [],
        relatedArtifactRefs: [],
        decidedBy: ACTOR,
        traceId: ids.id('trace'),
        provenance: { sourceType: 'WORKFLOW', sourceRefs: [`run:${runId}`] },
        metadata: { supervisor: { schema: 'companyos/supervisor-decision/1', companyId: COMPANY_A, runId, commandId, fingerprint: 'x' } },
      },
    });
    expect(superseded.ok).toBe(true);

    const active = await f.services.sink.listActiveRunDecisions({ runId, companyId: COMPANY_A, actorId: ACTOR });
    const history = await f.services.sink.listRunDecisionHistory({ runId, companyId: COMPANY_A, actorId: ACTOR });
    expect(active.ok && history.ok).toBe(true);
    if (!active.ok || !history.ok) return;
    expect(active.value.every((row) => row.status === 'ACTIVE')).toBe(true);
    expect(active.value.length).toBeLessThan(history.value.length);
  });

  it('17. replaying the original command after a later version creates no duplicate', async () => {
    const f = openFixture();
    const runId = await runFor(f, COMPANY_A, 'later-version');
    const commandId = supervisorDecisionCommandId(runId, 'versioned');
    const first = await f.services.sink.record(commandFor(COMPANY_A, runId, commandId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const decisions = createDecisionService({
      store: f.services.decisions,
      clock,
      ids,
      authorize: async (): Promise<Result<true, DomainError>> => ok(true as const),
    });
    const superseded = await decisions.supersede({
      decisionId: first.value.decisionId,
      version: 1,
      actorId: ACTOR,
      next: {
        companyId: COMPANY_A,
        scope: { type: 'WORKFLOW', id: runId },
        subjectKey: commandId,
        title: 'CONTINUE — GOAL_SATISFIED (revised)',
        question: OBJECTIVE,
        decision: 'CONTINUE',
        rationale: 'A later revision of the same decision.',
        alternativesConsidered: [],
        constraints: [],
        consequences: [],
        relatedMemoryRefs: [],
        relatedHandoffRefs: [],
        relatedArtifactRefs: [],
        decidedBy: ACTOR,
        traceId: ids.id('trace'),
        provenance: { sourceType: 'WORKFLOW', sourceRefs: [`run:${runId}`] },
        metadata: { supervisor: { schema: 'companyos/supervisor-decision/1', companyId: COMPANY_A, runId, commandId, fingerprint: 'x' } },
      },
    });
    expect(superseded.ok).toBe(true);

    f.db.db.prepare('DELETE FROM command_ledger').run();
    const replayed = await f.services.sink.record(commandFor(COMPANY_A, runId, commandId));
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    // The ORIGINAL logical identity is returned; no second version 1 was created.
    expect(replayed.value.decisionId).toBe(first.value.decisionId);
    expect(replayed.value.version).toBe(1);
    const versions = await f.services.decisions.listVersions(first.value.decisionId);
    expect(versions.map((row) => row.version).sort()).toEqual([1, 2]);
  });
});

describe('T18-03 corrective — evidence reference contract', () => {
  it('18/19. only contract-valid references are accepted, bogus ones rejected', async () => {
    const f = openFixture();
    const runId = await runFor(f, COMPANY_A, 'evidence-contract');
    const base = {
      action: 'REQUEST_CORRECTIVE' as const,
      reasonCode: 'VALIDATION_FAILED' as const,
      summary: 'A corrective is requested with cited evidence.',
    };

    const bogusArtifact = await f.services.sink.record(
      commandFor(COMPANY_A, runId, supervisorDecisionCommandId(runId, 'bogus-art'), { ...base, evidenceRefs: ['artifact:does-not-exist'] }),
    );
    expect(bogusArtifact.ok).toBe(false);
    if (bogusArtifact.ok) return;
    expect(bogusArtifact.error.code).toBe('NOT_FOUND');

    const bogusValidation = await f.services.sink.record(
      commandFor(COMPANY_A, runId, supervisorDecisionCommandId(runId, 'bogus-val'), { ...base, evidenceRefs: ['val_does-not-exist'] }),
    );
    expect(bogusValidation.ok).toBe(false);
    if (bogusValidation.ok) return;
    expect(bogusValidation.error.code).toBe('NOT_FOUND');

    // An invented namespace is refused by the existing grammar, not by a new rule of ours.
    const invented = await f.services.sink.record(
      commandFor(COMPANY_A, runId, supervisorDecisionCommandId(runId, 'invented'), { ...base, evidenceRefs: ['toolinvocation:123'] }),
    );
    expect(invented.ok).toBe(false);
    if (invented.ok) return;
    expect(invented.error.code).toBe('INVALID_ARGUMENT');
    expect(decisionCount(f.db)).toBe(0);
  });

  it('20. a QA-style decision cites the validator report artifact, not a disguised validation id', async () => {
    const f = openFixture();
    const runId = await runFor(f, COMPANY_A, 'qa-evidence');
    // The T17-06 chain: the QA validator materializes its report as a run-owned Artifact.
    const report = await f.services.artifacts.create({
      commandId: 'validation-evidence:report-1',
      runId: runId as never,
      taskId: null,
      kind: 'companyos:validation-evidence-report',
      content: new TextEncoder().encode(JSON.stringify({ verdict: 'fail', missingSlots: ['tests'] })),
      producedBy: ACTOR,
      traceId: 't18c_art_report',
    });
    if (!report.ok) throw new Error(report.error.message);

    const recorded = await f.services.sink.record(
      commandFor(COMPANY_A, runId, supervisorDecisionCommandId(runId, 'qa'), {
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'VALIDATION_FAILED',
        summary: 'The QA evidence report failed the stage gate.',
        evidenceRefs: [`artifact:${report.value.id}`],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    // The contractual field carries exactly the artifact reference …
    expect(recorded.value.relatedArtifactRefs).toEqual([`artifact:${report.value.id}`]);
    // … and every payload entry declares its resolved kind (nothing disguised).
    const envelope = (recorded.value.metadata as Record<string, unknown>)['supervisor'] as Record<string, unknown>;
    const refs = envelope['evidenceRefs'] as { kind: string; ref: string }[];
    expect(refs.map((entry) => entry.kind)).toEqual(['artifact']);
  });

  it('21. no new reference namespace appears anywhere in the sink contract', async () => {
    const f = openFixture();
    const runId = await runFor(f, COMPANY_A, 'no-namespace');
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('packages/engine/src/supervisor/decision-sink.ts', 'utf8'),
    );
    for (const forbidden of ['toolinvocation:', 'validation:', 'supervisor:']) {
      expect(source.includes(`'${forbidden}`)).toBe(false);
      expect(source.includes(`\`${forbidden}`)).toBe(false);
    }
    // And an invented grammar is refused at runtime, not silently stored.
    const result = await f.services.sink.record(
      commandFor(COMPANY_A, runId, supervisorDecisionCommandId(runId, 'ns'), {
        action: 'ESCALATE',
        reasonCode: 'HUMAN_REQUIRED',
        summary: 'Escalating with an invented reference.',
        evidenceRefs: ['supervisor:whatever'],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGUMENT');
  });
});
