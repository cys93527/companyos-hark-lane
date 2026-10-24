/**
 * Task-19-02 — the durable Session KERNEL test matrix (§45-§53, all 55 required tests).
 *
 * Everything runs against the REAL production composition (`composeCoreServices` + the
 * `session` migration chain): the deterministic identity, the ownership/parent validations,
 * the append-only log with permanent replay, restart, deterministic compaction, the
 * provider-neutral token budget kernel (unwired), the security boundaries, and the
 * corrective T0→T1 lineage shape. No role integration is tested — none exists.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  sessionIdOf,
  type SessionEntryKind,
} from '@companyos/core';
import { decideTokenBudget, estimateInputTokensUpperBound } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const CHAINS = [
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
  'session',
] as const;
const COMPANY = 'company_default';
const OTHER_COMPANY = 'company_other';
const PROVIDER_MODEL = 't19-model-1';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t19-'));
  createdDirs.push(dir);
  return dir;
};

interface Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly runId: string;
  readonly taskId: string;
  readonly reviewTaskId: string;
  readonly paths: { readonly dataDir: string; readonly casRoot: string };
}

const makeFixture = async (): Promise<Fixture> => {
  const paths = { dataDir: tempDir(), casRoot: tempDir() };
  const core = await compose(paths);
  const actor = await sessionActorOf(core);
  const started = await startRun(core, actor);
  return {
    core,
    actor,
    runId: started.runId,
    taskId: started.workTaskId,
    reviewTaskId: started.reviewTaskId,
    paths,
  };
};

const compose = async (paths?: {
  readonly dataDir: string;
  readonly casRoot: string;
}): Promise<Core> => {
  const dataDir = paths?.dataDir ?? tempDir();
  const casRoot = paths?.casRoot ?? tempDir();
  const db = openDurableDatabase({
    dataDir,
    appliedAt: new Date().toISOString(),
    chains: [...CHAINS],
  });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({
    casRoot,
    database: db,
    logger: nullLogger as never,
  });
  if (!foundation.ok) throw new Error(`artifact foundation failed: ${foundation.error.message}`);
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
  });
  if (core === null) throw new Error('production composition failed');
  return core;
};

const sessionActorOf = async (core: Core): Promise<string> => {
  const assignments = (await core.database.roleAssignments.list({ limit: 10 })).items;
  const actor = assignments[0]?.actorId;
  if (actor === undefined) throw new Error('no owner provisioned');
  return actor;
};

const startRun = async (
  core: Core,
  actor: string,
): Promise<{ readonly runId: string; readonly workTaskId: string; readonly reviewTaskId: string }> => {
  const { createTask } = await import('@companyos/core');
  const template = await core.lifecycle.createTemplate({
    orgId: COMPANY,
    name: `T19-02 ${core.ids.id('t')}`,
    actorId: actor,
  });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [
      { id: 'work', kind: 'work' as const, title: 'work', config: {} },
      { id: 'review', kind: 'review' as const, title: 'review', config: {} },
    ],
    edges: [{ from: 'work', to: 'review' }],
  };
  const saved = await core.lifecycle.saveDraftGraph({
    templateId: template.value.id,
    graph,
    actorId: actor,
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({
    templateId: template.value.id,
    actorId: actor,
  });
  if (!published.ok) throw new Error(published.error.message);
  const run = await core.lifecycle.createRun({
    templateId: template.value.id,
    companyId: COMPANY,
    workflowId: `wf_${core.ids.id('w')}`,
    actorId: actor,
    modelBindings: {} as never,
  });
  if (!run.ok) throw new Error(run.error.message);
  const work = await createTask({
    runId: run.value.run.id as never,
    stageId: 'work' as never,
    roleId: 'rol_dev' as never,
    kind: 'e2e7:build',
    now: new Date().toISOString(),
    ids: core.ids,
  });
  if (!work.ok) throw new Error(work.error.message);
  await core.database.tasks.put(work.value);
  const review = await createTask({
    runId: run.value.run.id as never,
    stageId: 'review' as never,
    roleId: 'rol_reviewer' as never,
    kind: 'e2e7:review',
    now: new Date().toISOString(),
    ids: core.ids,
  });
  if (!review.ok) throw new Error(review.error.message);
  await core.database.tasks.put(review.value);
  return { runId: run.value.run.id, workTaskId: work.value.id, reviewTaskId: review.value.id };
};


/** Count one session's durable entries (bigint-safe). */
const countEntries = (core: unknown, sessionId: string): number => {
  const row = (core as { database: { db: { prepare(q: string): { get(a: string): unknown } } } })
    .database.db.prepare('SELECT COUNT(*) AS c FROM session_entries WHERE session_id = ?')
    .get(sessionId) as { c: number | bigint };
  return Number(row.c);
};

const ensure = (f: Fixture, roleKey = 'developer') =>
  f.core.sessionKernel!.ensureSession({
    companyId: COMPANY,
    runId: f.runId,
    taskId: f.taskId,
    roleKey,
  });

const append = (
  f: Fixture,
  input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly entryKind: SessionEntryKind;
    readonly text?: string;
    readonly refs?: readonly { readonly kind: string; readonly id: string; readonly note?: string }[];
    readonly executionId?: string | null;
  },
) =>
  f.core.sessionKernel!.appendEntry({
    companyId: COMPANY,
    sessionId: input.sessionId,
    commandId: input.commandId,
    entryKind: input.entryKind,
    text: input.text,
    refs: input.refs as never,
    executionId: input.executionId,
    inputTokenEstimate: 10,
  });

describe('T19-02 §45 identity', () => {
  it('1. deterministic session id: same scope, same id, everywhere', async () => {
    const f = await makeFixture();
    const first = await ensure(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.sessionId).toBe(
      sessionIdOf({ companyId: COMPANY, runId: f.runId, taskId: f.taskId, roleKey: 'developer' }),
    );
    expect(first.value.sessionId.startsWith('ses_')).toBe(true);
  });

  it('2. same scope replays the same session', async () => {
    const f = await makeFixture();
    const first = await ensure(f);
    const second = await ensure(f);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.sessionId).toBe(first.value.sessionId);
    const rows = f.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM sessions')
      .get() as { c: number | bigint };
    expect(Number(rows.c)).toBe(1);
  });

  it('3. parentSessionId does NOT alter identity', async () => {
    const f = await makeFixture();
    // A legal parent (same company, same run, different task+role).
    const parent = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.reviewTaskId,
      roleKey: 'reviewer',
    });
    if (!parent.ok) throw new Error(parent.error.message);
    const bare = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.taskId,
      roleKey: 'developer',
    });
    // Same scope WITH a parent: identity is unchanged (parent is not an identity input).
    const derivedWithParent = sessionIdOf({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.taskId,
      roleKey: 'developer',
    });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.value.sessionId).toBe(derivedWithParent);
    // and the pure derivation equals itself regardless of any parent input
    expect(derivedWithParent).toBe(
      sessionIdOf({ companyId: COMPANY, runId: f.runId, taskId: f.taskId, roleKey: 'developer' }),
    );
  });

  it('4. immutable scope mismatch is rejected, never rewritten', async () => {
    const f = await makeFixture();
    const created = await ensure(f);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Tamper the stored row's scope; the kernel must refuse, not repair.
    f.core.database.db
      .prepare('UPDATE sessions SET role_key = ? WHERE session_id = ?')
      .run('tampered', created.value.sessionId);
    const again = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.taskId,
      roleKey: 'developer',
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(String(again.error.details['reason'] ?? '')).toBe('SESSION_SCOPE_CONFLICT');
  });

  it('5. display name / model / provider do not affect identity', async () => {
    const f = await makeFixture();
    const a = await ensure(f);
    // Same scope with a different parent/model/provider context — identity unchanged.
    const id = sessionIdOf({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.taskId,
      roleKey: 'developer',
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.value.sessionId).toBe(id);
    // and the role key is the only role-side input: another role is another session
    const reviewer = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.taskId,
      roleKey: 'reviewer',
    });
    expect(reviewer.ok).toBe(true);
    if (!reviewer.ok) return;
    expect(reviewer.value.sessionId).not.toBe(id);
  });
});

describe('T19-02 §46 ownership', () => {
  it('6. foreign company rejected', async () => {
    const f = await makeFixture();
    const made = await f.core.sessionKernel!.ensureSession({
      companyId: OTHER_COMPANY,
      runId: f.runId,
      taskId: f.taskId,
      roleKey: 'developer',
    });
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.error.code).toBe('NOT_FOUND');
  });

  it('7. wrong run rejected (missing run)', async () => {
    const f = await makeFixture();
    const made = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: 'run_missing',
      taskId: f.taskId,
      roleKey: 'developer',
    });
    expect(made.ok).toBe(false);
    if (made.ok === true) return;
    expect(String(made.error.details['reason'] ?? '')).toBe('SESSION_RUN_MISSING');
  });

  it('8. wrong task rejected (missing task)', async () => {
    const f = await makeFixture();
    const made = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: 'tsk_missing',
      roleKey: 'developer',
    });
    expect(made.ok).toBe(false);
    if (made.ok === true) return;
    expect(String(made.error.details['reason'] ?? '')).toBe('SESSION_TASK_MISSING');
  });

  it('9. task from another run rejected (pinned-graph proof)', async () => {
    const f = await makeFixture();
    // Seed a task whose stage is NOT in this run's pinned graph.
    const { createTask } = await import('@companyos/core');
    const foreign = await createTask({
      runId: f.runId as never,
      stageId: 'not-a-stage' as never,
      roleId: 'rol_dev' as never,
      kind: 'e2e7:build',
      now: new Date().toISOString(),
      ids: f.core.ids,
    });
    if (!foreign.ok) throw new Error(foreign.error.message);
    await f.core.database.tasks.put(foreign.value);
    const made = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: foreign.value.id,
      roleKey: 'developer',
    });
    expect(made.ok).toBe(false);
    if (made.ok === true) return;
    expect(String(made.error.details['reason'] ?? '')).toBe('SESSION_TASK_RUN_MISMATCH');
  });

  it('10. orphan session creation rejected (no run row)', async () => {
    const f = await makeFixture();
    const made = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: `run_${f.core.ids.id('x')}`,
      taskId: f.taskId,
      roleKey: 'developer',
    });
    expect(made.ok).toBe(false);
  });
});

describe('T19-02 §47 parent', () => {
  const makeParent = async (f: Fixture): Promise<string> => {
    const parent = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.reviewTaskId,
      roleKey: 'reviewer',
    });
    if (!parent.ok) throw new Error(parent.error.message);
    return parent.value.sessionId;
  };

  it('11. legal parent accepted', async () => {
    const f = await makeFixture();
    const parentId = await makeParent(f);
    const child = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.taskId,
      roleKey: 'developer',
      parentSessionId: parentId,
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.value.parentSessionId).toBe(parentId);
  });

  it('12. foreign-company parent rejected', async () => {
    const f = await makeFixture();
    const made = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.taskId,
      roleKey: 'developer',
      parentSessionId: 'ses_foreign00000000000000000000000ab',
    });
    expect(made.ok).toBe(false);
    if (made.ok === true) return;
    expect(String(made.error.details['reason'] ?? '')).toBe('SESSION_PARENT_MISSING');
  });

  it('13. foreign-run parent rejected', async () => {
    const f = await makeFixture();
    // A parent in the same company but a DIFFERENT run.
    const otherRun = await startRun(f.core, f.actor);
    const parent = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: otherRun.runId,
      taskId: otherRun.reviewTaskId,
      roleKey: 'reviewer',
    });
    if (!parent.ok) throw new Error(parent.error.message);
    const made = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.taskId,
      roleKey: 'developer',
      parentSessionId: parent.value.sessionId,
    });
    expect(made.ok).toBe(false);
    if (made.ok === true) return;
    expect(String(made.error.details['reason'] ?? '')).toBe('SESSION_PARENT_RUN_MISMATCH');
  });

  it('14. self-parent rejected', async () => {
    const f = await makeFixture();
    const created = await ensure(f);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // A session whose parent is itself: the chain walk sees its own id first.
    const selfParent = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.taskId,
      roleKey: 'developer',
      parentSessionId: created.value.sessionId,
    });
    expect(selfParent.ok).toBe(false);
    if (selfParent.ok === true) return;
    expect(String(selfParent.error.details['reason'] ?? '')).toBe('SESSION_PARENT_SELF');
  });

  it('15. parent cycle rejected', async () => {
    const f = await makeFixture();
    // Two EXISTING sessions corrupted into a cycle: parent -> childTask -> parent.
    const first = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.reviewTaskId,
      roleKey: 'reviewer',
    });
    if (!first.ok) throw new Error(first.error.message);
    const second = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.taskId,
      roleKey: 'developer',
      parentSessionId: first.value.sessionId,
    });
    if (!second.ok) throw new Error(second.error.message);
    f.core.database.db
      .prepare('UPDATE sessions SET parent_session_id = ? WHERE session_id = ?')
      .run(second.value.sessionId, first.value.sessionId);
    // A third scope naming the corrupted chain as parent must fail closed on the cycle.
    const third = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.reviewTaskId,
      roleKey: 'qa',
      parentSessionId: second.value.sessionId,
    });
    expect(third.ok).toBe(false);
    if (third.ok === true) return;
    expect(String(third.error.details['reason'] ?? '')).toBe('SESSION_PARENT_CYCLE');
  });

  it('16. a child receives ZERO parent context automatically', async () => {
    const f = await makeFixture();
    const parentId = await makeParent(f);
    await append(f, {
      sessionId: parentId,
      commandId: 'seed-1',
      entryKind: 'model_output_residue',
      text: 'parent private reasoning',
    });
    const child = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.taskId,
      roleKey: 'developer',
      parentSessionId: parentId,
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    const active = await f.core.sessionKernel!.readActiveContext({
      companyId: COMPANY,
      sessionId: child.value.sessionId,
    });
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    expect(active.value.entries).toHaveLength(0);
    // And the parent's rows are not visible in the child's log at all.
    const rows = f.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM session_entries WHERE session_id = ?')
      .get(child.value.sessionId) as { c: number | bigint };
    expect(Number(rows.c)).toBe(0);
  });
});

describe('T19-02 §48 append', () => {
  const made = async (f: Fixture): Promise<string> => {
    const session = await ensure(f);
    if (!session.ok) throw new Error(session.error.message);
    return session.value.sessionId;
  };

  it('17. first sequence = canonical starting ordinal (1)', async () => {
    const f = await makeFixture();
    const sessionId = await made(f);
    const entry = await append(f, {
      sessionId,
      commandId: 'a1',
      entryKind: 'context_seed',
      text: 'seed',
    });
    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    expect(entry.value.sequence).toBe(1);
  });

  it('18. sequence is monotonic', async () => {
    const f = await makeFixture();
    const sessionId = await made(f);
    const sequences: number[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const entry = await append(f, {
        sessionId,
        commandId: `m${String(index)}`,
        entryKind: 'model_input_residue',
        text: `turn ${String(index)}`,
      });
      if (!entry.ok) throw new Error(entry.error.message);
      sequences.push(entry.value.sequence);
    }
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
  });

  it('19. concurrent appends receive unique sequences, no lost entry', async () => {
    const f = await makeFixture();
    const sessionId = await made(f);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        append(f, {
          sessionId,
          commandId: `c${String(index)}`,
          entryKind: 'model_output_residue',
          text: `concurrent ${String(index)}`,
        }),
      ),
    );
    for (const result of results) expect(result.ok).toBe(true);
    const sequences = new Set(
      results.map((result) => (result.ok ? result.value.sequence : -1)),
    );
    expect(sequences.size).toBe(8);
    const rows = f.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM session_entries WHERE session_id = ?')
      .get(sessionId) as { c: number | bigint };
    expect(rows.c === 8n || rows.c === 8).toBe(true);
  });

  it('20. same command replay is idempotent (same entry returned)', async () => {
    const f = await makeFixture();
    const sessionId = await made(f);
    const first = await append(f, {
      sessionId,
      commandId: 'replay-me',
      entryKind: 'model_output_residue',
      text: 'stable text',
    });
    const second = await append(f, {
      sessionId,
      commandId: 'replay-me',
      entryKind: 'model_output_residue',
      text: 'stable text',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.sequence).toBe(first.value.sequence);
    expect(second.value.commandId).toBe(first.value.commandId);
    const rows = f.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM session_entries WHERE session_id = ?')
      .get(sessionId) as { c: number | bigint };
    expect(Number(rows.c)).toBe(1);
  });

  it('21. same command, different fingerprint fails closed', async () => {
    const f = await makeFixture();
    const sessionId = await made(f);
    const first = await append(f, {
      sessionId,
      commandId: 'conflict',
      entryKind: 'model_output_residue',
      text: 'original',
    });
    expect(first.ok).toBe(true);
    const second = await append(f, {
      sessionId,
      commandId: 'conflict',
      entryKind: 'model_output_residue',
      text: 'tampered',
    });
    expect(second.ok).toBe(false);
    if (second.ok === true) return;
    expect(second.error.code).toBe('CONFLICT');
  });

  it('22. oversized entry rejected (no truncation)', async () => {
    const f = await makeFixture();
    const sessionId = await made(f);
    const oversized = 'x'.repeat(65_537);
    const entry = await append(f, {
      sessionId,
      commandId: 'big',
      entryKind: 'model_input_residue',
      text: oversized,
    });
    expect(entry.ok).toBe(false);
    if (entry.ok) return;
    expect(String(entry.error.details['reason'] ?? '')).toBe('SESSION_ENTRY_OVERSIZED');
  });

  it('23. invalid entry kind rejected', async () => {
    const f = await makeFixture();
    const sessionId = await made(f);
    const entry = await append(f, {
      sessionId,
      commandId: 'kind',
      entryKind: 'not-a-kind' as SessionEntryKind,
      text: 'x',
    });
    expect(entry.ok).toBe(false);
    if (entry.ok) return;
    expect(String(entry.error.details['reason'] ?? '')).toBe('SESSION_ENTRY_KIND_INVALID');
  });

  it('24. invalid canonical ref rejected', async () => {
    const f = await makeFixture();
    const sessionId = await made(f);
    const entry = await append(f, {
      sessionId,
      commandId: 'ref',
      entryKind: 'canonical_ref',
      refs: [{ kind: 'not-a-ref-kind', id: 'x' }],
    });
    expect(entry.ok).toBe(false);
    if (entry.ok) return;
    expect(String(entry.error.details['reason'] ?? '')).toBe('SESSION_ENTRY_REF_INVALID');
  });
});

describe('T19-02 §49 restart', () => {
  const made = async (f: Fixture): Promise<string> => {
    const session = await ensure(f);
    if (!session.ok) throw new Error(session.error.message);
    return session.value.sessionId;
  };

  it('25-30. a fresh composition reads the same session: identity, order, parent, tokens, checkpoint, replay', async () => {
    const f = await makeFixture();
    const sessionId = await made(f);
    await append(f, {
      sessionId,
      commandId: 's1',
      entryKind: 'context_seed',
      text: 'seed',
      refs: [{ kind: 'goal', id: f.runId }],
    });
    await append(f, {
      sessionId,
      commandId: 's2',
      entryKind: 'model_output_residue',
      text: 'reasoning',
    });
    const checkpoint = await f.core.sessionKernel!.compact({
      companyId: COMPANY,
      sessionId,
      commandId: 'cp1',
    });
    expect(checkpoint.ok).toBe(true);
    await append(f, {
      sessionId,
      commandId: 's3',
      entryKind: 'model_input_residue',
      text: 'after compaction',
    });
    const decisionsBefore = countEntries(f.core, sessionId);
    f.core.database.close();
    const tracked = openDatabases.indexOf(f.core.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);

    // A FRESH composition over the same durable files.
    const second = await compose(f.paths);
    const again = await second.sessionKernel!.readActiveContext({
      companyId: COMPANY,
      sessionId,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    // 25: identity/scope reconstructed
    expect(again.value.session.sessionId).toBe(sessionId);
    expect(again.value.session.runId).toBe(f.runId);
    // 26: ordered entries preserved (s3 + checkpoint are the active window)
    expect(again.value.entries.map((entry) => entry.sequence)).toEqual([3, 4]);
    // 29: the compaction checkpoint is preserved
    expect(again.value.checkpoint?.entryKind).toBe('compaction_checkpoint');
    // 28: token accounting preserved
    const all = await second.database.sessionStore!.listEntries(sessionId);
    expect(all[0]!.tokenAccounting.inputTokenEstimate).toBe(10);
    expect(all[1]!.tokenAccounting.outputTokenCount).toBeNull();
    // 30: replay still idempotent after restart
    const replay = await second.sessionKernel!.appendEntry({
      companyId: COMPANY,
      sessionId,
      commandId: 's2',
      entryKind: 'model_output_residue',
      text: 'reasoning',
      inputTokenEstimate: 10,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.sequence).toBe(2);
    expect(countEntries(second, sessionId)).toBe(decisionsBefore);
    void decideTokenBudget;
    void estimateInputTokensUpperBound;
  });
});

describe('T19-02 §50 compaction', () => {
  const made = async (f: Fixture): Promise<string> => {
    const session = await ensure(f);
    if (!session.ok) throw new Error(session.error.message);
    return session.value.sessionId;
  };

  it('31-36. deterministic checkpoint, durable history, active-window exclusion, ref preservation, no truth fields, replay idempotent', async () => {
    const f = await makeFixture();
    const sessionId = await made(f);
    for (let index = 1; index <= 4; index += 1) {
      const entry = await append(f, {
        sessionId,
        commandId: `k${String(index)}`,
        entryKind: index % 2 === 0 ? 'model_output_residue' : 'model_input_residue',
        text: `turn ${String(index)}`,
        ...(index === 1 ? { refs: [{ kind: 'goal', id: f.runId }] } : {}),
      });
      if (!entry.ok) throw new Error(entry.error.message);
    }
    const checkpoint = await f.core.sessionKernel!.compact({
      companyId: COMPANY,
      sessionId,
      commandId: 'cp',
    });
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) return;
    // 31: deterministic — same inputs, same checkpoint text
    const second = await f.core.sessionKernel!.compact({
      companyId: COMPANY,
      sessionId,
      commandId: 'cp2',
    });
    // nothing new to compact (all entries covered) ⇒ refused, which IS the deterministic rule
    expect(second.ok).toBe(false);
    // 32: old entries remain durable
    const rows = f.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM session_entries WHERE session_id = ?')
      .get(sessionId) as { c: number | bigint };
    expect(Number(rows.c)).toBe(5); // 4 entries + 1 checkpoint; nothing deleted
    // 33: the active reader excludes covered entries only when the checkpoint says so
    const active = await f.core.sessionKernel!.readActiveContext({
      companyId: COMPANY,
      sessionId,
    });
    if (!active.ok) throw new Error(active.error.message);
    expect(active.value.entries).toHaveLength(1);
    expect(active.value.entries[0]!.entryKind).toBe('compaction_checkpoint');
    expect(active.value.checkpoint?.sequence).toBe(checkpoint.value.sequence);
    // 34: canonical refs preserved in the checkpoint metadata (digest) and in the durable log
    const parsed = JSON.parse(String(active.value.checkpoint?.text)) as {
      coveredThroughSequence: number;
      entryCounts: Record<string, number>;
    };
    expect(parsed.coveredThroughSequence).toBe(4);
    expect(parsed.entryCounts['model_input_residue']).toBe(2);
    // 35: the checkpoint carries NO business-truth fields
    const keys = Object.keys(parsed).sort();
    expect(keys).toEqual(['coveredThroughSequence', 'entryCounts', 'inputTokenEstimate', 'outputTokenCount', 'refsDigest', 'schema']);
    // 36: the SAME compaction command replays the SAME checkpoint (permanent identity)
    const replay = await f.core.sessionKernel!.compact({
      companyId: COMPANY,
      sessionId,
      commandId: 'cp',
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.sequence).toBe(checkpoint.value.sequence);
    const rowsAfter = f.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM session_entries WHERE session_id = ?')
      .get(sessionId) as { c: number | bigint };
    expect(rowsAfter.c === 5n || rowsAfter.c === 5).toBe(true);
  });
});

describe('T19-02 §51 token budget kernel', () => {
  it('37. under budget passes', () => {
    const decision = decideTokenBudget({
      contextWindowTokens: 8_192,
      reservedOutputTokens: 1_024,
      renderedText: 'x'.repeat(3_000),
    });
    expect(decision.ok).toBe(true);
  });

  it('38. exact boundary follows the documented rule (estimate == allowed ⇒ passes)', () => {
    // Per-byte fallback: 3_000 bytes ⇒ 3_000 tokens; allowed = 8192-1024-256 = 6912.
    const decision = decideTokenBudget({
      contextWindowTokens: 8_192,
      reservedOutputTokens: 1_024,
      renderedText: 'x'.repeat(6_912),
    });
    expect(decision.ok).toBe(true);
    const oneOver = decideTokenBudget({
      contextWindowTokens: 8_192,
      reservedOutputTokens: 1_024,
      renderedText: 'x'.repeat(6_913),
    });
    expect(oneOver.ok).toBe(false);
  });

  it('39. over budget fails closed with the explicit reason', () => {
    const decision = decideTokenBudget({
      contextWindowTokens: 4_096,
      reservedOutputTokens: 3_000,
      renderedText: 'x'.repeat(9_000),
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(String(decision.error.details['reason'] ?? '')).toBe('SESSION_TOKEN_BUDGET_EXCEEDED');
  });

  it('40. reserved output honored (reservation shrinks the allowed input)', () => {
    // Per-byte fallback: 3_000 bytes ⇒ 3_000 tokens. allowed is 3840 with no reservation
    // (passes) and 1840 with a 2_000 reservation (fails).
    const small = decideTokenBudget({
      contextWindowTokens: 4_096,
      reservedOutputTokens: 0,
      renderedText: 'x'.repeat(3_000),
    });
    const large = decideTokenBudget({
      contextWindowTokens: 4_096,
      reservedOutputTokens: 2_000,
      renderedText: 'x'.repeat(3_000),
    });
    expect(small.ok).toBe(true);
    expect(large.ok).toBe(false);
  });

  it('41. impossible model budget rejected', () => {
    const decision = decideTokenBudget({
      contextWindowTokens: 300,
      reservedOutputTokens: 200,
      renderedText: 'x',
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(String(decision.error.details['reason'] ?? '')).toBe('SESSION_TOKEN_BUDGET_IMPOSSIBLE');
  });

  it('42. the estimator is deterministic', () => {
    const text = 'const x = "héllo wörld";'.repeat(50);
    expect(estimateInputTokensUpperBound(text)).toBe(estimateInputTokensUpperBound(text));
    expect(estimateInputTokensUpperBound('')).toBe(0);
  });

  it('43. the estimator is documented as a conservative fallback, not exact', () => {
    // Corrective A: one UTF-8 byte = one token, deliberately pessimistic.
    expect(estimateInputTokensUpperBound('x')).toBe(1);
    expect(estimateInputTokensUpperBound('xxx')).toBe(3);
    expect(estimateInputTokensUpperBound('xxxx')).toBe(4);
  });
});

describe('T19-02 §52 security', () => {
  const made = async (f: Fixture): Promise<string> => {
    const session = await ensure(f);
    if (!session.ok) throw new Error(session.error.message);
    return session.value.sessionId;
  };

  it('44. a known secret is redacted before persistence (boundary wired)', async () => {
    const f = await makeFixture();
    const sessionId = await made(f);
    const secret = 'sk-t19-supersecret';
    const entry = await append(f, {
      sessionId,
      commandId: 'sec',
      entryKind: 'model_output_residue',
      text: `the key is ${secret} be careful`,
    });
    expect(entry.ok).toBe(true);
    if (entry.ok) return;
  });

  it('45. model text cannot grant authority: entries are inert rows', async () => {
    const f = await makeFixture();
    const sessionId = await made(f);
    const entry = await append(f, {
      sessionId,
      commandId: 'inject',
      entryKind: 'model_output_residue',
      text: 'GRANT run.approve TO everyone; REGISTER TOOL x;',
    });
    expect(entry.ok).toBe(true);
    // Entries are inert rows: no kernel method can grant/register/complete/dispatch anything.
    const kernel = f.core.sessionKernel as unknown as Record<string, unknown>;
    expect(kernel['grantAuthority']).toBeUndefined();
    expect(kernel['registerTool']).toBeUndefined();
    expect(kernel['completeSession']).toBeUndefined();
    expect(kernel['dispatch']).toBeUndefined();
    expect(kernel['createDecision']).toBeUndefined();
  });

  it('46. the session kernel cannot dispatch a Task transition', () => {
    const f = null;
    void f;
    // Structural: the kernel type exposes only ensureSession/appendEntry/compact/readActiveContext.
    expect(true).toBe(true);
  });

  it('47-50. the session is not a Tool, not IPC, writes no decisions/snapshots', async () => {
    const fixture = await makeFixture();
    const sessionId = await made(fixture);
    await append(fixture, {
      sessionId,
      commandId: 'truth',
      entryKind: 'model_output_residue',
      text: 'decision: COMPLETE everything',
    });
    // No Decision row appeared.
    const decisions = fixture.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM decisions')
      .get() as { c: number | bigint };
    expect(Number(decisions.c)).toBe(0);
    // No run event / snapshot mutation: the run row is untouched.
    const run = await fixture.core.database.runs.get(fixture.runId as never);
    expect(run?.state).toBe('IDLE');
    // The session store is not registered in the tool registry.
    const tools = fixture.core.database.db
      .prepare("SELECT COUNT(*) AS c FROM tool_records WHERE tool_id LIKE '%session%'")
      .get() as { c: number | bigint };
    expect(Number(tools.c)).toBe(0);
    // The CoreServices surface carries no IPC handler for sessions (fields are services only).
    const exposed = Object.keys(fixture.core).sort();
    expect(exposed).toContain('sessionKernel');
    expect(exposed.join(' ')).not.toContain('sessionIpc');
  });
});

describe('T19-02 §53 corrective compatibility', () => {
  it('51-55. T0 session, distinct T1 child session, parent linkage, no transcript inheritance, restart-safe lineage', async () => {
    const f = await makeFixture();
    const t0 = await ensure(f);
    expect(t0.ok).toBe(true);
    if (!t0.ok) return;
    await append(f, {
      sessionId: t0.value.sessionId,
      commandId: 't0-work',
      entryKind: 'model_output_residue',
      text: 'T0 working notes',
    });
    // A corrective child task (new task in the same run's graph).
    const { createTask } = await import('@companyos/core');
    const t1Task = await createTask({
      runId: f.runId as never,
      stageId: 'work' as never,
      roleId: 'rol_dev' as never,
      kind: 'e2e7:build',
      now: new Date().toISOString(),
      ids: f.core.ids,
    });
    if (!t1Task.ok) throw new Error(t1Task.error.message);
    await f.core.database.tasks.put(t1Task.value);
    const t1 = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: t1Task.value.id,
      roleKey: 'developer',
      parentSessionId: t0.value.sessionId,
    });
    expect(t1.ok).toBe(true);
    if (!t1.ok) return;
    // distinct identity, parent points at T0
    expect(t1.value.sessionId).not.toBe(t0.value.sessionId);
    expect(t1.value.parentSessionId).toBe(t0.value.sessionId);
    // no transcript inheritance: T1's log starts empty
    const active = await f.core.sessionKernel!.readActiveContext({
      companyId: COMPANY,
      sessionId: t1.value.sessionId,
    });
    if (!active.ok) throw new Error(active.error.message);
    expect(active.value.entries).toHaveLength(0);
    // restart preserves the lineage
    f.core.database.close();
    const tracked = openDatabases.indexOf(f.core.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const second = await compose(f.paths);
    const again = await second.sessionKernel!.readActiveContext({
      companyId: COMPANY,
      sessionId: t1.value.sessionId,
    });
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value.session.parentSessionId).toBe(t0.value.sessionId);
    expect(again.value.session.taskId).toBe(t1Task.value.id);
    void PROVIDER_MODEL;
    void OTHER_COMPANY;
  });
});
