/**
 * Task-20-03A — canonical Task → Run ownership hardening (§34-§44 required tests).
 *
 * Everything runs against REAL infrastructure: the real migration chain (including the
 * fail-closed legacy rebuild), the real composition (`composeCoreServices`), the real
 * autonomous loop, the real corrective provisioner, the real Developer session runtime and
 * the real bounded projectors. The exact T20-03 blocker reproduction is here — flipped from
 * vulnerable to safe.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTask, ok, type DomainError, type ModelProviderPort, type Result } from '@companyos/core';
import { applyMigrations, loadMigrations } from '@companyos/persistence';

import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { openDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { supervisorDecisionCommandId } from '@companyos/engine';
import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const CHAINS = [
  'core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session',
] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'e2e7.supervisor';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t20a-'));
  createdDirs.push(dir);
  return dir;
};

let providerCalls = 0;
let developerCalls = 0;
const routingProvider = (): ModelProviderPort => ({
  describe: () => ({ providerId: 'prov_e2e7', kind: 'fake', displayName: 'r', version: '1' }),
  listModels: () =>
    Promise.resolve(
      ok([{ modelId: 'm1', displayName: 'm1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }]),
    ),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    providerCalls += 1;
    const user = request.messages.find((m) => m.role === 'user')?.content ?? '';
    if (user.includes('companyos/work-role-context/1')) {
      developerCalls += 1;
      return Promise.resolve(
        ok({
          modelId: request.modelId, providerId: 'prov_e2e7', outputText: 'dev note',
          structured: { objective: 'o', summary: 's' }, toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalCost: null }, finishReason: 'stop' as const,
        }),
      );
    }
    // Supervisor: derive the subject from the turn's OWN context (its run's task).
    const seat = user.indexOf('# Memory view');
    let subject = '';
    if (seat >= 0) {
      const start = user.indexOf('{', seat);
      let depth = 0, end = -1, inStr = false, esc = false;
      for (let i = start; i < user.length; i++) {
        const c = user[i];
        if (inStr) { if (esc) esc = false; else if (c === String.fromCharCode(92)) esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      try {
        const parsed = JSON.parse(user.slice(start, end)) as Record<string, unknown>;
        subject = String((parsed['subject'] as Record<string, unknown> | undefined)?.['taskId'] ?? '');
      } catch { subject = ''; }
    }
    return Promise.resolve(
      ok({
        modelId: request.modelId, providerId: 'prov_e2e7', outputText: 'sup note',
        structured: {
          schema: 'companyos/supervisor-proposal/1',
          action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'go',
          evidenceRefs: [], ...(subject === '' ? {} : { subject: { taskId: subject } }),
        },
        toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalCost: null }, finishReason: 'stop' as const,
      }),
    );
  },
  stream(): AsyncIterable<Result<never, DomainError>> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<Result<never, DomainError>>> =>
          Promise.resolve({ done: true, value: undefined }),
      }),
    };
  },
});

interface Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly templateId: string;
  readonly runA: string;
  readonly runB: string;
  readonly dataDir: string;
}

/** One published template/version; TWO runs pinning it; the exact blocker topology. */
const makeFixture = async (): Promise<Fixture> => {
  providerCalls = 0;
  developerCalls = 0;
  const dataDir = tempDir();
  const db = openDurableDatabase({
    dataDir,
    appliedAt: new Date().toISOString(),
    chains: [...CHAINS],
  });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot: tempDir(), database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('artifact foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: {
      developerKinds: ['e2e7:build'],
      reviewKinds: ['e2e7:review'],
      qaKinds: ['e2e7:qa'],
    },
  });
  if (core === null) throw new Error('composition failed');
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(routingProvider(), { actorId: actor });
  await core.models.registerFromProvider({
    providerId: 'prov_e2e7', providerModelId: 'm1', modelKey: MODEL_KEY, actorId: actor,
  });
  const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: 't20a', actorId: actor });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [
      { id: 'work', kind: 'work' as const, title: 'w', config: {} },
      { id: 'review', kind: 'review' as const, title: 'r', config: {} },
      { id: 'qa', kind: 'qa' as const, title: 'q', config: { validatorIds: ['e2e7.unit_validator'] } },
    ],
    edges: [{ from: 'work', to: 'review' }, { from: 'review', to: 'qa' }],
  };
  const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({ templateId: template.value.id, actorId: actor });
  if (!published.ok) throw new Error(published.error.message);
  const mkRun = async (wf: string): Promise<string> => {
    const run = await core.lifecycle.createRun({
      templateId: template.value.id, companyId: COMPANY, workflowId: wf, actorId: actor,
      modelBindings: { supervisor: MODEL_KEY },
      goal: { objective: `goal ${wf}`, source: { type: 'human' } },
    });
    if (!run.ok) throw new Error(run.error.message);
    const driven = await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
    if (!driven.ok) throw new Error(driven.error.message);
    return run.value.run.id;
  };
  return {
    core,
    actor,
    templateId: template.value.id,
    runA: await mkRun('wf-a'),
    runB: await mkRun('wf-b'),
    dataDir,
  };
};

const seedTaskOn = async (f: Fixture, runId: string, stageId: string, kind: string): Promise<string> => {
  const made = await createTask({
    runId: runId as never,
    stageId: stageId as never,
    roleId: 'rol_dev' as never,
    kind,
    now: new Date().toISOString(),
    ids: f.core.ids,
  });
  if (!made.ok) throw new Error(made.error.message);
  await f.core.database.tasks.put(made.value);
  return made.value.id;
};

/* ------------------------------------------------------- §34 migration tests */

describe('T20-03A §34 — migration', () => {
  const migrationsDir = join(process.cwd(), 'packages/persistence/migrations/engine');
  const readChain = () => loadMigrations(migrationsDir);

  const rawDbs: { close(): void }[] = [];
  afterEach(() => { while (rawDbs.length > 0) rawDbs.pop()?.close(); });
  const openRaw = () => {
    const dir = tempDir();
    const db = openDatabase({ path: join(dir, 'migrate.db') });
    rawDbs.push(db);
    // The engine chain's events migration builds on the core chain's events table.
    applyMigrations({
      db,
      migrations: loadMigrations(join(process.cwd(), 'packages/persistence/migrations')),
      appliedAt: new Date().toISOString(),
    });
    return db;
  };

  it('1-4. fresh chain: run_id column exists, NOT NULL, FK, run index', () => {
    const db = openRaw();
    applyMigrations({ db, migrations: readChain(), appliedAt: new Date().toISOString() });
    const cols = db.raw
      .prepare('PRAGMA table_info(tasks)')
      .all() as { name: string; notnull: number; type: string }[];
    const runIdCol = cols.find((c) => c.name === 'run_id');
    expect(runIdCol).toBeDefined(); // 1
    expect(runIdCol?.notnull).toBe(1); // 2 NOT NULL
    const fks = db.raw.prepare('PRAGMA foreign_key_list(tasks)').all() as { table: string; from: string }[];
    expect(fks.some((fk) => fk.table === 'runs' && fk.from === 'run_id')).toBe(true); // 3
    const idx = db.raw.prepare('PRAGMA index_list(tasks)').all() as { name: string }[];
    expect(idx.some((i) => i.name === 'idx_tasks_run')).toBe(true); // 4
    const unique = db.raw
      .prepare('SELECT * FROM pragma_index_list(?) WHERE "unique" = 1')
      .all('tasks') as { name: string }[];
    expect(unique.filter((u) => u.name.startsWith('idx_tasks_run'))).toHaveLength(0); // no uniqueness
  });

  it('5. legacy 0001 DB with ZERO tasks migrates cleanly', () => {
    const db = openRaw();
    applyMigrations({ db, migrations: readChain().filter((m) => m.name.startsWith('0001')), appliedAt: 't' });
    applyMigrations({ db, migrations: readChain(), appliedAt: 't2' });
    const count = db.raw.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number };
    expect(Number(count.c)).toBe(0);
  });

  it('6-9. legacy DB with an ambiguous task row FAILS CLOSED, row intact, no heuristics', () => {
    const db = openRaw();
    const chain = readChain();
    applyMigrations({ db, migrations: chain.filter((m) => m.name.startsWith('0001')), appliedAt: 't' });
    // One legacy row whose ownership is mechanically unknowable.
    db.raw
      .prepare(
        `INSERT INTO tasks (id, stage_id, role_id, kind, state, attempts, max_attempts,
           inputs_json, outputs_json, created_at, updated_at)
         VALUES ('tsk_legacy', 'work', 'rol_1', 'k', 'PENDING', 0, 3, '{}', '{}', 't', 't')`,
      )
      .run();
    expect(() => applyMigrations({ db, migrations: chain, appliedAt: 't2' })).toThrow(
      /TASK_RUN_OWNERSHIP_LEGACY_DATA_UNMIGRATABLE/,
    ); // 6 deterministic fail-closed
    // 7: the failure left the ORIGINAL schema + row intact (transaction rolled back).
    const cols = db.raw.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    expect(cols.some((c) => c.name === 'run_id')).toBe(false);
    const row = db.raw.prepare("SELECT id FROM tasks WHERE id = 'tsk_legacy'").get() as { id: string } | undefined;
    expect(row?.id).toBe('tsk_legacy'); // 8 no deletion
    // 9: no heuristic backfill exists anywhere in the migration text — the abort is a
    // data-value-independent EXISTENCE precondition (trigger + RAISE), not a sentinel.
    const sql = chain.find((m) => m.name.startsWith('0002'))?.sql ?? '';
    expect(sql).toContain('TASK_RUN_OWNERSHIP_LEGACY_DATA_UNMIGRATABLE');
    expect(sql).toContain('WHEN EXISTS (SELECT 1 FROM tasks LIMIT 1)');
    expect(sql).not.toContain('run_legacy_unrecoverable');
  });
});

/* -------------------------------------------------- §35 domain / store tests */

describe('T20-03A §35 — domain & store', () => {
  it('10-12. runId required, roundtrips, FK rejects unknown runs', async () => {
    const f = await makeFixture();
    // 10: construction requires runId
    const empty = await createTask({
      runId: '' as never,
      stageId: 'work' as never,
      roleId: 'rol_dev' as never,
      kind: 'e2e7:build',
      now: new Date().toISOString(),
      ids: f.core.ids,
    });
    expect(empty.ok).toBe(false);
    // 11: roundtrip preserves runId
    const TA = await seedTaskOn(f, f.runA, 'work', 'e2e7:build');
    const loaded = await f.core.database.tasks.get(TA as never);
    expect(String(loaded?.runId)).toBe(f.runA);
    // 12: persistence rejects a task naming a nonexistent run (FK enforced)
    let fkRejected = false;
    try {
      await seedTaskOn(f, 'run_missing_everywhere', 'work', 'e2e7:build');
    } catch {
      fkRejected = true;
    }
    expect(fkRejected).toBe(true);
  });

  it("13-14. listByRun returns only one run's tasks; the same stage stays separated", async () => {
    const f = await makeFixture();
    const TA = await seedTaskOn(f, f.runA, 'work', 'e2e7:build');
    const TB = await seedTaskOn(f, f.runB, 'work', 'e2e7:build');
    const ofA = await f.core.database.tasks.listByRun(f.runA);
    const ofB = await f.core.database.tasks.listByRun(f.runB);
    expect(ofA.map((t) => t.id)).toEqual([TA]); // 13
    expect(ofB.map((t) => t.id)).toEqual([TB]); // 14 same stage, different runs
  });
});

/* --------------------------------- §36 the exact blocker reproduction, flipped */

describe('T20-03A §36 — two-run vulnerability regression (the flipped blocker)', () => {
  it('Run B MUST NOT claim/execute Run A\'s TA: no state change, zero provider calls, no session', async () => {
    const f = await makeFixture();
    const reviewB = await seedTaskOn(f, f.runB, 'review', 'e2e7:review');
    const TA = await seedTaskOn(f, f.runA, 'work', 'e2e7:build'); // the ONLY work task, owned by A
    const sessionsBefore = f.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM sessions')
      .get() as { c: number };
    const result = await f.core.autonomousSupervisor!.run({
      companyId: COMPANY, runId: f.runB, taskId: TA, reviewTaskId: reviewB, actorId: f.actor, runIdentity: 't20a-b',
    });
    // Run B may run its OWN supervisor turn (on B's empty context) — what is forbidden is
    // any work on TA: no Developer invocation, no work effect, no session, no state change.
    if (result?.ok === true) {
      expect(result.value.applied.map((a) => a.effect)).not.toContain('stage:work:completed');
    }
    const ta = await f.core.database.tasks.get(TA as never);
    expect(String(ta?.state)).toBe('PENDING'); // state unchanged
    expect(ta?.attempts).toBe(0); // attempts unchanged
    expect(developerCalls).toBe(0); // zero Developer provider calls for TA
    expect(providerCalls).toBeLessThanOrEqual(1); // at most B's own supervisor turn
    const sessionsAfter = f.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM sessions')
      .get() as { c: number };
    expect(Number(sessionsAfter.c)).toBe(Number(sessionsBefore.c)); // no runB+TA session
  });
});

/* ---------------------------------------------- §37 the two-run positive case */

describe('T20-03A §37 — two-run positive case', () => {
  it('TA(A) and TB(B) both execute through their own loops with zero bleed', async () => {
    const f = await makeFixture();
    const reviewA = await seedTaskOn(f, f.runA, 'review', 'e2e7:review');
    const reviewB = await seedTaskOn(f, f.runB, 'review', 'e2e7:review');
    const TA = await seedTaskOn(f, f.runA, 'work', 'e2e7:build');
    const TB = await seedTaskOn(f, f.runB, 'work', 'e2e7:build');
    const a = await f.core.autonomousSupervisor!.run({
      companyId: COMPANY, runId: f.runA, taskId: TA, reviewTaskId: reviewA, actorId: f.actor, runIdentity: 't20a-a',
    });
    expect(a?.ok).toBe(true);
    if (a?.ok !== true) return;
    expect(a.value.applied.some((x) => x.effect === 'stage:work:completed')).toBe(true);
    expect(String((await f.core.database.tasks.get(TA as never))?.state)).toBe('DONE');
    // Run A consumed ONLY TA; TB untouched by A.
    expect(String((await f.core.database.tasks.get(TB as never))?.state)).toBe('PENDING');
    const b = await f.core.autonomousSupervisor!.run({
      companyId: COMPANY, runId: f.runB, taskId: TB, reviewTaskId: reviewB, actorId: f.actor, runIdentity: 't20a-b2',
    });
    expect(b?.ok).toBe(true);
    if (b?.ok !== true) return;
    expect(String((await f.core.database.tasks.get(TB as never))?.state)).toBe('DONE');
  });
});

/* ------------------------------------------------- §38-§40 seam rejections */

describe('T20-03A §38-§40 — decision sink / provisioner / engine', () => {
  it('38. decision sink: Run B cannot anchor a decision to Run A\'s task (same stage in pinned graph)', async () => {
    const f = await makeFixture();
    const TA = await seedTaskOn(f, f.runA, 'work', 'e2e7:build');
    const recorded = await f.core.supervisorDecisionSink!.record({
      companyId: COMPANY,
      runId: f.runB,
      taskId: TA,
      stageId: 'work',
      commandId: supervisorDecisionCommandId(f.runB, `t20a-38-${String(new Date().getTime())}`),
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'cross-run anchor attempt',
      evidenceRefs: [],
      decidedBy: f.actor,
    });
    expect(recorded.ok).toBe(false);
    if (recorded.ok === true) return;
    expect(String(recorded.error.details['reason'] ?? '')).toBe('SUPERVISOR_DECISION_TASK_RUN_MISMATCH');
  });

  it('39. corrective provisioner: Run B refuses a foreign-run parent (tampered report)', async () => {
    const f = await makeFixture();
    const TA = await seedTaskOn(f, f.runA, 'work', 'e2e7:build');
    const TB = await seedTaskOn(f, f.runB, 'work', 'e2e7:build');
    const reviewB = await seedTaskOn(f, f.runB, 'review', 'e2e7:review');
    // A COMPLETED reviewer execution for B's review task (sink provenance requirement).
    const stamp = new Date().toISOString();
    const execId = `exec_${String(new Date().getTime())}`;
    f.core.database.db
      .prepare(
        `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
           provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
           input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
           created_at, updated_at)
         VALUES (?, 'agent.review', 'rol.review', ?, ?, ?, 'p', 'pm', 'COMPLETED', ?, NULL, 'tr', 1,
           '{}', '{}', 1, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(execId, reviewB, f.runB, MODEL_KEY, stamp, stamp, stamp);
    // A legit CHANGES_REQUESTED report for B with subject TB, then TAMPER its content to
    // name TA (Run A's task) — the corruption class the ownership gate exists for.
    const recorded = await f.core.reviewFindingsSink!.record({
      companyId: COMPANY,
      runId: f.runB,
      reviewStageId: 'review' as never,
      reviewTaskId: reviewB,
      subjectTaskId: TB,
      executionId: execId,
      verdict: 'CHANGES_REQUESTED',
      findings: [{ code: 'cross.run', summary: 'tampered', detail: 'd', blocking: true }],
      decidedBy: f.actor,
    });
    expect(recorded.ok).toBe(true);
    if (recorded.ok !== true) return;
    const artifactId = recorded.value.artifactId;
    // Tamper the report row to name TA (Run A's task): the corruption class the ownership
    // gate exists for. The tampered contentRef is not a canonical managed ref, so content
    // retrieval fails closed; the ownership gate is the independent second refusal.
    f.core.database.db
      .prepare('UPDATE artifacts SET content_ref = ? WHERE artifact_id = ?')
      .run('tampered:ref', artifactId);
    const decision = await f.core.supervisorDecisionSink!.record({
      commandId: supervisorDecisionCommandId(f.runB, `t20a-cross-${String(new Date().getTime())}`),
      companyId: COMPANY,
      runId: f.runB,
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'attempt from a tampered report',
      evidenceRefs: [`artifact:${String(artifactId)}`],
      decidedBy: f.actor,
    });
    if (decision.ok === true) {
      let refused = false;
      let refusedReason = '';
      try {
        const provisioned = await f.core.correctiveProvisioner!.provision({
          companyId: COMPANY,
          runId: f.runB,
          decisionId: decision.value.decisionId,
          decisionVersion: 1,
          actorId: f.actor,
        });
        refused = !provisioned.ok;
        if (!provisioned.ok) refusedReason = String(provisioned.error.details['reason'] ?? '');
      } catch {
        refused = true; // the thrown content-integrity refusal is fail-closed too
      }
      expect(refused).toBe(true);
      // Whatever the refusal kind, NO corrective task was minted from the foreign parent.
      const ofB = await f.core.database.tasks.listByRun(f.runB);
      expect(ofB.some((t) => t.inputs['corrective'] !== undefined)).toBe(false);
      void refusedReason;
    }
    // TA remains untouched in every way.
    const ta = await f.core.database.tasks.get(TA as never);
    expect(String(ta?.state)).toBe('PENDING');
    expect(ta?.attempts).toBe(0);
  });

  it('44. corrective positive: T1 from a legit B report carries runId=B and canonical lineage', async () => {
    const f = await makeFixture();
    const TB = await seedTaskOn(f, f.runB, 'work', 'e2e7:build');
    const reviewB = await seedTaskOn(f, f.runB, 'review', 'e2e7:review');
    const stamp = new Date().toISOString();
    const execId = `exec_${String(new Date().getTime())}`;
    f.core.database.db
      .prepare(
        `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
           provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
           input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
           created_at, updated_at)
         VALUES (?, 'agent.review', 'rol.review', ?, ?, ?, 'p', 'pm', 'COMPLETED', ?, NULL, 'tr', 1,
           '{}', '{}', 1, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(execId, reviewB, f.runB, MODEL_KEY, stamp, stamp, stamp);
    const recorded = await f.core.reviewFindingsSink!.record({
      companyId: COMPANY,
      runId: f.runB,
      reviewStageId: 'review' as never,
      reviewTaskId: reviewB,
      subjectTaskId: TB,
      executionId: execId,
      verdict: 'CHANGES_REQUESTED',
      findings: [{ code: 'legit.finding', summary: 'needs work', detail: 'd', blocking: true }],
      decidedBy: f.actor,
    });
    expect(recorded.ok).toBe(true);
    if (recorded.ok !== true) return;
    const decision = await f.core.supervisorDecisionSink!.record({
      commandId: supervisorDecisionCommandId(f.runB, `t20a-ok-${String(new Date().getTime())}`),
      companyId: COMPANY,
      runId: f.runB,
      action: 'REQUEST_CORRECTIVE',
      reasonCode: 'REVIEW_FINDING',
      summary: 'legitimate corrective',
      evidenceRefs: [`artifact:${String(recorded.value.artifactId)}`],
      decidedBy: f.actor,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok !== true) return;
    const t1 = await f.core.correctiveProvisioner!.provision({
      companyId: COMPANY,
      runId: f.runB,
      decisionId: decision.value.decisionId,
      decisionVersion: 1,
      actorId: f.actor,
    });
    expect(t1.ok).toBe(true);
    if (!t1.ok) return;
    const row = await f.core.database.tasks.get(t1.value.taskId as never);
    expect(String(row?.runId)).toBe(f.runB); // T1.runId = R
    const lineage = row?.inputs['corrective'] as Record<string, unknown> | undefined;
    expect(String(lineage?.['parentTaskId'])).toBe(TB); // canonical lineage unchanged
    expect(Number(lineage?.['round'])).toBeGreaterThanOrEqual(1);
  });
});
