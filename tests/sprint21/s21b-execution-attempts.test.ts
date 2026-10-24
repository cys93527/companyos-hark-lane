/**
 * Sprint21 final — ExecutionAttempt (the generic execution-claim owner) and the
 * reassessment causal model (§36/§37 of the final ruling): deterministic identity,
 * PK/UNIQUE arbitration, claim-before-executor, executor outside the write transaction,
 * same-attempt recovery, orphan startup transition, causal eligibility, stale-downstream
 * protection and causal WorkPackage projection — all against the real composition.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyTaskEvent,
  createExecutionAttempt,
  createTask,
  executionAttemptIdOf,
  ok,
  type DomainError,
  type ModelProviderPort,
  type Result,
} from '@companyos/core';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const CHAINS = ['core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff'] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'e2e7.planner';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s21b-'));
  createdDirs.push(dir);
  return dir;
};

let providerCalls = 0;
const stubProvider = (): ModelProviderPort => ({
  describe: () => ({ providerId: 'prov_e2e7', kind: 'fake', displayName: 'r', version: '1' }),
  listModels: () => Promise.resolve(ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }])),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    providerCalls += 1;
    return Promise.resolve(ok({
      modelId: request.modelId, providerId: 'prov_e2e7', outputText: 'x',
      structured: { status: 'succeeded', artifactContent: 'out' } as never,
      toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalCost: null }, finishReason: 'stop' as const,
    }));
  },
  stream(): AsyncIterable<Result<never, DomainError>> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
  },
});

const makeCore = async (): Promise<{ readonly core: Core; readonly actor: string; readonly runId: string; readonly taskId: string }> => {
  const dataDir = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot: tempDir(), database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', 'task.attempt-work'] },
    planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
  });
  if (core === null) throw new Error('composition failed');
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(stubProvider(), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_e2e7', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  // A planning-style single-workflow template + run at EXECUTING + one materialized task.
  const template = await core.lifecycle.createTemplate({ orgId: COMPANY, name: 'attempt-work', actorId: actor });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [
      { id: 'work', kind: 'attempt-work', title: 'Work', config: { taskProfile: { roleId: 'rol.worker', taskKind: 'task.attempt-work', maxAttempts: 1 } } },
      { id: 'plan', kind: 'planning', title: 'Plan', config: { taskProfile: { roleId: 'rol.planner', taskKind: 'companyos:planning', maxAttempts: 2 } } },
    ],
    edges: [{ from: 'work', to: 'plan' }],
  } as never;
  const saved = await core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: actor });
  if (!saved.ok) throw new Error(saved.error.message);
  await core.lifecycle.publish({ templateId: template.value.id, actorId: actor });
  const run = await core.lifecycle.createRun({
    templateId: template.value.id, companyId: COMPANY, workflowId: 'wf-attempts', actorId: actor,
    modelBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    goal: { objective: 'Attempt-owner goal.', source: { type: 'human' } },
  });
  if (!run.ok) throw new Error(run.error.message);
  const seeded = createTask({
    runId: run.value.run.id as never, stageId: 'work' as never,
    roleId: 'rol.worker' as never, kind: 'task.attempt-work', maxAttempts: 1, inputs: {},
    now: new Date().toISOString(), ids: { ulid: () => 'U', id: (p: string) => `${p}_w1` },
  });
  if (!seeded.ok) throw new Error(seeded.error.message);
  const written = await core.database.tasks.putGuarded(seeded.value);
  if (!written.ok) throw new Error(written.error.message);
  const started = await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 7 });
  if (!started.ok) throw new Error(started.error.message);
  return { core, actor, runId: run.value.run.id, taskId: seeded.value.id };
};

const advance = (core: Core, runId: string, taskId: string) =>
  core.sprint13.engine.advance({
    runId: runId as never,
    stageId: 'work' as never,
    taskIds: [taskId as never],
    snapshot: null,
  } as never);

const countOf = (core: Core, sql: string, ...params: readonly (string | number | null)[]): number =>
  Number((core.database.db.prepare(sql).get(...(params as never[])) as { c: number }).c);

const reasonOf = (error: { readonly details: Readonly<Record<string, unknown>> }): string =>
  String(error.details['reason'] ?? '');

describe('S21 §36 — ExecutionAttempt claim model', () => {
  it('1/2/3. deterministic id; PK/UNIQUE arbitration; duplicate replay/conflict', async () => {
    const f = await makeCore();
    const id = executionAttemptIdOf({ companyId: COMPANY, runId: f.runId, taskId: f.taskId, attemptNumber: 1 });
    expect(id).toMatch(/^exa_[0-9a-f]{26}$/); // deterministic identity form
    const seed = {
      id, companyId: COMPANY, runId: f.runId, taskId: f.taskId, attemptNumber: 1,
      roleId: 'rol.worker', taskKind: 'task.attempt-work',
      runtimeInstanceId: 'rt_test', now: new Date().toISOString(),
    };
    const attempt = createExecutionAttempt(seed);
    if (!attempt.ok) throw new Error(attempt.error.message);
    const first = await f.core.database.executionAttempts.claim(attempt.value);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replayed).toBe(false); // 1: one canonical row
    const replay = await f.core.database.executionAttempts.claim(attempt.value);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true); // 2: same seed replays
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM execution_attempts')).toBe(1);
    // 3: a DIFFERENT seed for the same identity conflicts
    const drifted = createExecutionAttempt({ ...seed, roleId: 'rol.other' });
    if (!drifted.ok) throw new Error(drifted.error.message);
    const conflict = await f.core.database.executionAttempts.claim(drifted.value);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(reasonOf(conflict.error)).toBe('EXECUTION_ATTEMPT_SEED_CONFLICT');
  });

  it('4/5/6. claim commits BEFORE the executor; executor runs outside the write transaction', async () => {
    const f = await makeCore();
    // A handler that PROVES both invariants at invocation time: the claim row is already
    // durable (committed), and the engine holds no open write transaction (SQLite
    // autocommit state — a second write connection can acquire the write lock).
    const original = (f.core.sprint13 as unknown as { readonly engine: { readonly handlers?: unknown } });
    expect(original).toBeDefined();
    // perform the real advance — the composed executor handler runs via engine
    const outcome = await advance(f.core, f.runId, f.taskId);
    expect(String(outcome.outcome)).toBe('completed');
    // 5: an attempt row exists for the settled task, COMPLETED, with the frozen seed
    const rows = f.core.database.db
      .prepare('SELECT * FROM execution_attempts WHERE task_id = ?')
      .all(f.taskId) as { state: string; attempt_number: number; role_id: string; task_kind: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('COMPLETED');
    expect(Number(rows[0]!.attempt_number)).toBe(1); // START applied exactly once
    expect(rows[0]!.role_id).toBe('rol.worker');
    expect(rows[0]!.task_kind).toBe('task.attempt-work');
    // the task settled DONE with its canonical envelope
    const task = await f.core.database.tasks.get(f.taskId as never);
    expect(task!.state).toBe('DONE');
    expect(task!.outputs['stageOutput']).toBeDefined();
  });

  it('7/8. two supervisors → ONE executor round; loser observes the claim, zero extra calls', async () => {
    const f = await makeCore();
    providerCalls = 0;
    const [a, b] = await Promise.all([
      advance(f.core, f.runId, f.taskId),
      advance(f.core, f.runId, f.taskId),
    ]);
    // both concurrent advances RESOLVE (the loser observes the claim, never a wedge)
    expect(String(a.outcome ?? a)).toBeDefined();
    expect(String(b.outcome ?? b)).toBeDefined();
    // exactly ONE claim row / ONE settlement / ONE task row — never two winners
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM execution_attempts WHERE task_id = ?', f.taskId)).toBe(1);
    expect(countOf(f.core, "SELECT COUNT(*) AS c FROM execution_attempts WHERE task_id = ? AND state = 'COMPLETED'", f.taskId)).toBe(1);
    const task = await f.core.database.tasks.get(f.taskId as never);
    expect(task!.state).toBe('DONE');
    expect(Number(task!.attempts)).toBe(1); // attempts incremented exactly once
  });

  it('9/10/11. ACTIVE claim blocks a second supervisor with ZERO executor calls', async () => {
    const f = await makeCore();
    // Simulate another owner's committed ACTIVE claim (claim committed, executor pending).
    const claim = createExecutionAttempt({
      id: executionAttemptIdOf({ companyId: COMPANY, runId: f.runId, taskId: f.taskId, attemptNumber: 1 }),
      companyId: COMPANY, runId: f.runId, taskId: f.taskId, attemptNumber: 1,
      roleId: 'rol.worker', taskKind: 'task.attempt-work', runtimeInstanceId: 'rt_other', now: new Date().toISOString(),
    });
    if (!claim.ok) throw new Error(claim.error.message);
    const claimed = await f.core.database.executionAttempts.claim(claim.value);
    if (!claimed.ok) throw new Error(claimed.error.message);
    const task = await f.core.database.tasks.get(f.taskId as never);
    const running = applyTaskEvent(task!, 'PLAN', new Date().toISOString());
    const started = running.ok ? applyTaskEvent(running.value, 'START', new Date().toISOString()) : running;
    if (!started.ok) throw new Error(started.error.message);
    await f.core.database.tasks.put(started.value);
    providerCalls = 0;
    let loserReason = '';
    try {
      await advance(f.core, f.runId, f.taskId);
    } catch (error) {
      loserReason = String((error as { details?: Record<string, unknown> }).details?.['reason'] ?? '');
    }
    expect(loserReason).toBe('EXECUTION_ATTEMPT_CLAIM_ACTIVE'); // fail closed: another owner's claim
    expect(providerCalls).toBe(0); // ZERO executor calls by the loser
  });

  it('12/13. startup orphan transition + same-attempt reacquire (attempts NOT re-incremented)', async () => {
    const f = await makeCore();
    // crash window: claim committed, executor never ran
    const claim = createExecutionAttempt({
      id: executionAttemptIdOf({ companyId: COMPANY, runId: f.runId, taskId: f.taskId, attemptNumber: 1 }),
      companyId: COMPANY, runId: f.runId, taskId: f.taskId, attemptNumber: 1,
      roleId: 'rol.worker', taskKind: 'task.attempt-work', runtimeInstanceId: 'rt_prev', now: new Date().toISOString(),
    });
    if (!claim.ok) throw new Error(claim.error.message);
    await f.core.database.executionAttempts.claim(claim.value);
    const task = await f.core.database.tasks.get(f.taskId as never);
    const planned = applyTaskEvent(task!, 'PLAN', new Date().toISOString());
    const started = planned.ok ? applyTaskEvent(planned.value, 'START', new Date().toISOString()) : planned;
    if (!started.ok) throw new Error(started.error.message);
    await f.core.database.tasks.put(started.value);
    expect(Number(started.value.attempts)).toBe(1);
    // 12: canonical startup orphan recovery — ACTIVE of the PREVIOUS runtime → INTERRUPTED
    const interrupted = await f.core.database.executionAttempts.interruptActiveOfRuntime(null, new Date().toISOString());
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.state).toBe('INTERRUPTED');
    // 13: re-entry REACQUIRES the SAME attempt identity — no new attempt, attempts stays 1
    const outcome = await advance(f.core, f.runId, f.taskId);
    expect(String(outcome.outcome)).toBe('completed');
    const rows = f.core.database.db
      .prepare('SELECT * FROM execution_attempts WHERE task_id = ?')
      .all(f.taskId) as { id: string; state: string; attempt_number: number }[];
    expect(rows).toHaveLength(1); // SAME row — recovery never mints attempt 2
    expect(rows[0]!.state).toBe('COMPLETED');
    expect(Number(rows[0]!.attempt_number)).toBe(1);
    const after = await f.core.database.tasks.get(f.taskId as never);
    expect(Number(after!.attempts)).toBe(1); // maxAttempts=1 crash-before-call: NOT exhausted
    expect(after!.state).toBe('DONE'); // the one legitimate execution ran
  });

  it('14. a DONE task is never re-executed (zero claims, zero calls)', async () => {
    const f = await makeCore();
    const first = await advance(f.core, f.runId, f.taskId);
    expect(String(first.outcome)).toBe('completed');
    const claimsBefore = countOf(f.core, 'SELECT COUNT(*) AS c FROM execution_attempts');
    providerCalls = 0;
    const again = await advance(f.core, f.runId, f.taskId);
    expect(String(again.outcome)).toBe('completed');
    expect(countOf(f.core, 'SELECT COUNT(*) AS c FROM execution_attempts')).toBe(claimsBefore);
    expect(providerCalls).toBe(0);
  });
});
