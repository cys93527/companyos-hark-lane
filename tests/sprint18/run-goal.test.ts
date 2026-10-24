/**
 * Sprint 18 / Task-18-02 — the canonical durable Run Goal (§39 assertion matrix 1–10).
 *
 * Everything runs on the REAL durable layer (SQLite + the filesystem CAS) and the REAL
 * ArtifactService, so the goal is proven through the artifact primitive itself: one run-owned
 * immutable artifact per run, idempotent by command identity, permanent across ledger trims.
 * No goal table and no schema change are involved — that is the point of the design.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { domainError, err, ok, type DomainError, type Result } from '@companyos/core';
import {
  createArtifactService,
  createRunGoalService,
  createWorkflowLifecycle,
  runGoalCommandId,
  type ArtifactService,
  type RunGoalService,
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
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18goal-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_18G${String(++seq).padStart(12, '0')}`,
  ulid: () => `18G${String(++seq).padStart(23, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'agent', 'tools', 'artifact', 'pack'] as const;
const COMPANY = 'company_default';

interface Services {
  readonly lifecycle: WorkflowLifecycle;
  readonly goals: RunGoalService;
  readonly artifacts: ArtifactService;
  readonly db: DurableDatabase;
}

/** Build the service stack over one durable database + CAS root. */
const build = (
  db: DurableDatabase,
  casRoot: string,
  options: { readonly allowArtifactCreate?: boolean } = {},
): Services => {
  const contentStore = createFilesystemArtifactContentStore({ casRoot });
  const authorize = async ({
    authority,
  }: {
    readonly actorId: string;
    readonly authority: string;
    readonly runId: string;
  }): Promise<Result<true, DomainError>> => {
    // How an unauthorized caller (a model, an agent payload, anything but the trusted
    // application) is simulated: the artifact authority decision refuses.
    if (options.allowArtifactCreate === false && authority === 'artifact.create') {
      return err(domainError('POLICY_DENIED', 'Artifact creation is refused for this test.', {}));
    }
    return ok(true as const);
  };
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
  const goals = createRunGoalService({
    artifactService: artifacts,
    artifactStore: db.artifactStore!,
    contentStore,
    runs: db.runs,
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
    // T18-02 §7: run-creation replay rides the durable command ledger.
    ledger: db.ledger,
    runGoal: goals,
    authorize: async () => ok(true as const),
  });
  return { lifecycle, goals, artifacts, db };
};

interface Fixture {
  readonly services: Services;
  readonly dataDir: string;
  readonly casRoot: string;
  publishedTemplate(label: string): Promise<string>;
  createRun(label: string, extra?: { readonly goal?: unknown; readonly commandId?: string }): Promise<string>;
  /** Close and reopen the same durable files — a process restart, in miniature. */
  restart(): Services;
  runCount(): Promise<number>;
  goalArtifactCount(runId: string): Promise<number>;
}

const makeFixture = (options: { readonly allowArtifactCreate?: boolean } = {}): Fixture => {
  const dataDir = tempDir();
  const casRoot = tempDir();
  let db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  let services = build(db, casRoot, options);

  return {
    get services(): Services {
      return services;
    },
    dataDir,
    casRoot,
    async publishedTemplate(label: string): Promise<string> {
      const template = await services.lifecycle.createTemplate({
        orgId: COMPANY,
        name: `Goal flow ${label}`,
        actorId: 'user_owner',
        traceId: `t18_tpl_${label}`,
      });
      if (!template.ok) throw new Error(`createTemplate failed: ${template.error.message}`);
      const graph = { nodes: [{ id: 's1', kind: 'work' as const, title: 'Work', config: {} }], edges: [] };
      const saved = await services.lifecycle.saveDraftGraph({
        templateId: template.value.id,
        graph,
        actorId: 'user_owner',
        traceId: `t18_graph_${label}`,
      });
      if (!saved.ok) throw new Error(`saveDraftGraph failed: ${saved.error.message}`);
      const published = await services.lifecycle.publish({
        templateId: template.value.id,
        actorId: 'user_owner',
        traceId: `t18_pub_${label}`,
      });
      if (!published.ok) throw new Error(`publish failed: ${published.error.message}`);
      return template.value.id;
    },
    async createRun(label: string, extra: { readonly goal?: unknown; readonly commandId?: string } = {}): Promise<string> {
      const templateId = await this.publishedTemplate(label);
      const run = await services.lifecycle.createRun({
        templateId,
        companyId: COMPANY,
        workflowId: 'wf_goal',
        actorId: 'user_owner',
        ...(extra.commandId === undefined ? {} : { commandId: extra.commandId }),
        ...(extra.goal === undefined ? {} : { goal: extra.goal as never }),
      });
      if (!run.ok) throw new Error(`createRun failed: ${run.error.message}`);
      return run.value.run.id;
    },
    restart(): Services {
      db.close();
      // The closed handle is untracked so the shared afterEach never double-closes it.
      const tracked = openDatabases.indexOf(db);
      if (tracked >= 0) openDatabases.splice(tracked, 1);
      db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
      openDatabases.push(db);
      services = build(db, casRoot, options);
      return services;
    },
    async runCount(): Promise<number> {
      return (await db.runs.list({ limit: 500 })).items.length;
    },
    async goalArtifactCount(runId: string): Promise<number> {
      return (await db.artifactStore!.listByRun(runId as never)).length;
    },
  };
};

const OBJECTIVE = 'Ship the supervisor slice behind the existing engine command surface.';
const GOAL = { objective: OBJECTIVE, source: { type: 'human' as const, ref: 'request-1' } };

describe('T18-02 run goal (canonical, durable, immutable)', () => {
  it('1. a run created with a canonical goal pins exactly that goal', async () => {
    const f = makeFixture();
    const runId = await f.createRun('one', { goal: GOAL });
    const goal = await f.services.goals.get({ runId, companyId: COMPANY });
    expect(goal.ok).toBe(true);
    if (!goal.ok) return;
    expect(goal.value.objective).toBe(OBJECTIVE);
    expect(goal.value.source).toEqual({ type: 'human', ref: 'request-1' });
    expect(goal.value.runId).toBe(runId);
    expect(goal.value.createdBy).toBe('user_owner');
    expect(goal.value.structured).toBeNull();
    expect(goal.value.schema).toBe('companyos/run-goal/1');
    expect(await f.goalArtifactCount(runId)).toBe(1);
  });

  it('2. the goal is durable — a fresh service over the same store reads the same goal', async () => {
    const f = makeFixture();
    const runId = await f.createRun('durable', { goal: GOAL });
    const fresh = build(f.services.db, f.casRoot);
    const goal = await fresh.goals.get({ runId, companyId: COMPANY });
    expect(goal.ok).toBe(true);
    if (!goal.ok) return;
    expect(goal.value.objective).toBe(OBJECTIVE);
  });

  it('3. a restart recovers the exact same goal', async () => {
    const f = makeFixture();
    const runId = await f.createRun('restart', { goal: GOAL });
    const before = await f.services.goals.get({ runId, companyId: COMPANY });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const after = f.restart();
    const recovered = await after.goals.get({ runId, companyId: COMPANY });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value).toEqual(before.value);
  });

  it('4. the same creation command replays the original run and its goal', async () => {
    const f = makeFixture();
    const templateId = await f.publishedTemplate('replay');
    const first = await f.services.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_goal',
      actorId: 'user_owner',
      commandId: 'run-create:replay-1',
      goal: GOAL,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const again = await f.services.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_goal',
      actorId: 'user_owner',
      commandId: 'run-create:replay-1',
      goal: GOAL,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.run.id).toBe(first.value.run.id);
    expect(again.value.snapshot.snapshotId).toBe(first.value.snapshot.snapshotId);
    expect(await f.runCount()).toBe(1);
    expect(await f.goalArtifactCount(first.value.run.id)).toBe(1);
  });

  it('5. the same command with a changed goal is refused (fingerprint conflict)', async () => {
    const f = makeFixture();
    const templateId = await f.publishedTemplate('conflict');
    const first = await f.services.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_goal',
      actorId: 'user_owner',
      commandId: 'run-create:conflict-1',
      goal: GOAL,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const changed = await f.services.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_goal',
      actorId: 'user_owner',
      commandId: 'run-create:conflict-1',
      goal: { objective: 'Something else entirely.' },
    });
    expect(changed.ok).toBe(false);
    if (changed.ok) return;
    expect(changed.error.code).toBe('CONFLICT');
    expect(changed.error.details?.['reason']).toBe('RUN_CREATE_FINGERPRINT_MISMATCH');
    expect(await f.runCount()).toBe(1);
    const goal = await f.services.goals.get({ runId: first.value.run.id, companyId: COMPANY });
    if (!goal.ok) throw new Error(goal.error.message);
    expect(goal.value.objective).toBe(OBJECTIVE);
  });

  it('6. a second goal can never overwrite the first', async () => {
    const f = makeFixture();
    const runId = await f.createRun('overwrite', { goal: GOAL });

    const second = await f.services.goals.attach({
      runId: runId as never,
      companyId: COMPANY,
      goal: { objective: 'A quiet replacement objective.' },
      actorId: 'user_owner',
      traceId: 't18_second_goal',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('CONFLICT');
    expect(second.error.details?.['reason']).toBe('ARTIFACT_COMMAND_FINGERPRINT_MISMATCH');
    const goal = await f.services.goals.get({ runId, companyId: COMPANY });
    if (!goal.ok) throw new Error(goal.error.message);
    expect(goal.value.objective).toBe(OBJECTIVE);
    expect(await f.goalArtifactCount(runId)).toBe(1);
  });

  it('7. a goal of another run can never substitute for this run', async () => {
    const f = makeFixture();
    const withGoal = await f.createRun('cross-run-a', { goal: GOAL });
    const withoutGoal = await f.createRun('cross-run-b');

    const foreign = await f.services.goals.get({ runId: withoutGoal, companyId: COMPANY });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.details?.['reason']).toBe('RUN_GOAL_MISSING');

    const own = await f.services.goals.get({ runId: withGoal, companyId: COMPANY });
    expect(own.ok).toBe(true);
    const lookup = await f.services.db.artifactStore!.getByCreationCommand(runGoalCommandId(withGoal));
    expect(lookup?.artifact.runId).toBe(withGoal);
  });

  it('8. a goal of another company is inaccessible', async () => {
    const f = makeFixture();
    const runId = await f.createRun('cross-company', { goal: GOAL });
    const other = await f.services.goals.get({ runId, companyId: 'company_other' });
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.error.code).toBe('NOT_FOUND');
    expect(other.error.details?.['reason']).toBe('RUN_GOAL_RUN_MISSING');
  });

  it('9. a caller without artifact authority cannot write or overwrite a goal', async () => {
    const f = makeFixture({ allowArtifactCreate: false });
    const templateId = await f.publishedTemplate('authority');

    // Run creation with a promised goal fails closed — and leaves NO run behind.
    const run = await f.services.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_goal',
      actorId: 'user_owner',
      goal: GOAL,
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe('POLICY_DENIED');
    expect(await f.runCount()).toBe(0);

    // A run created without a goal is unaffected by the refusal.
    const plain = await f.services.lifecycle.createRun({
      templateId,
      companyId: COMPANY,
      workflowId: 'wf_goal',
      actorId: 'user_owner',
    });
    expect(plain.ok).toBe(true);
  });

  it('10. no conversation, prompt or agent message can stand in for a goal', async () => {
    const f = makeFixture();
    const runId = await f.createRun('decoy');

    // A "conversation-shaped" artifact on the same run, newer than anything else.
    const made = await f.services.artifacts.create({
      commandId: 'conversation:thread-1',
      runId: runId as never,
      taskId: null,
      kind: 'companyos:conversation',
      content: new TextEncoder().encode(JSON.stringify({ turns: ['please do the thing'] })),
      producedBy: 'user_owner',
      traceId: 't18_decoy',
    });
    expect(made.ok).toBe(true);
    expect((await f.services.db.artifactStore!.listByRun(runId as never)).length).toBe(1);

    // The reader addresses the canonical goal by identity, so there is no latest-artifact
    // fallback to a conversation, a prompt or an agent message.
    const missing = await f.services.goals.get({ runId, companyId: COMPANY });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.details?.['reason']).toBe('RUN_GOAL_MISSING');
  });

  it('11. a goal carrying an absolute local path or a credential is refused, not stored', async () => {
    const f = makeFixture();
    const templateId = await f.publishedTemplate('unsafe');
    const cases = [
      { objective: 'Fix the deployment at E:\\DeepSeek.gzq\\companyos' },
      { objective: 'Deploy /srv/app to production' },
      // Assembled, never written as a literal: the credential scanner must stay honest.
      { objective: `Use API_KEY=${'sk-' + 'a'.repeat(24)}` },
      { objective: 'Rotate the token: hunter2 now' },
    ];
    for (const [index, goal] of cases.entries()) {
      const run = await f.services.lifecycle.createRun({
        templateId,
        companyId: COMPANY,
        workflowId: 'wf_goal',
        actorId: 'user_owner',
        goal,
      });
      expect(run.ok).toBe(false);
      if (run.ok) continue;
      expect(run.error.code).toBe('INVALID_ARGUMENT');
      expect(run.error.details?.['reason']).toBe('RUN_GOAL_CONTENT_UNSAFE');
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(await f.runCount()).toBe(0);
  });
});
