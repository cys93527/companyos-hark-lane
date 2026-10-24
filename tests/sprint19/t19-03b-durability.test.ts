/**
 * Task-19-03 CLOSEOUT — DEVELOPER_SESSION_EXECUTION_RESIDUE_DURABILITY (§10: the 14 required
 * tests), ALL against the REAL production composition (`composeCoreServices` + the trusted
 * `developerKinds` registration + the REAL session kernel / AgentRuntime / ProviderRegistry).
 *
 * The ordering under proof is the RESIDUE-FIRST shape (closeout §5, Shape B):
 *
 *   prepare (READY) → provider invoke → session residue DURABLE → terminal settlement (COMPLETED)
 *
 * so the forbidden state (closeout §3) — a durably COMPLETED execution whose session residue is
 * missing with no other durable copy — is impossible BY CONSTRUCTION. Every crash window below
 * uses the T18-08 deterministic fault seam (`after_provider_result_before_session_residue` and
 * the new `after_session_residue_before_execution_settlement`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTask,
  ok,
  type DomainError,
  type ModelProviderPort,
  type Result,
} from '@companyos/core';
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
const MODEL_KEY = 'e2e7.supervisor';
const PROVIDER_ID = 'prov_e2e7';
const PROVIDER_MODEL_ID = 'e2e7-model-1';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t19d-'));
  createdDirs.push(dir);
  return dir;
};

/** Every provider message is captured so the tests can SEE what each turn received. */
const invocationLog: { readonly messages: readonly { readonly role: string; readonly content: string }[] }[] = [];

const createRoutingProvider = (): ModelProviderPort => ({
  describe: () => ({
    providerId: PROVIDER_ID,
    kind: 'fake',
    displayName: 'Routing model',
    version: '1.0.0',
  }),
  listModels: () =>
    Promise.resolve(
      ok([
        {
          modelId: PROVIDER_MODEL_ID,
          displayName: PROVIDER_MODEL_ID,
          contextWindow: 8_192,
          capabilities: { streaming: false, structuredOutput: true },
        },
      ]),
    ),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    invocationLog.push({ messages: request.messages.map((m) => ({ role: m.role, content: m.content })) });
    return Promise.resolve(
      ok({
        modelId: request.modelId,
        providerId: PROVIDER_ID,
        outputText: `developer note ${String(invocationLog.length)}`,
        structured: { summary: `work note ${String(invocationLog.length)}` },
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
        finishReason: 'stop' as const,
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

const compose = async (
  paths?: { readonly dataDir: string; readonly casRoot: string },
  options?: {
    readonly crashAt?: string;
  },
): Promise<Core> => {
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
    stageHandlers: { developerKinds: ['e2e7:build'] },
    ...(options?.crashAt === undefined ? {} : { faultCheckpoints: crashProbe(options.crashAt) }),
  });
  if (core === null) throw new Error('production composition failed');
  return core;
};

/** A one-shot crash probe wired through the SAME composition option the T18-08 tests use. */
const crashProbe = (crashAt: string) => ({
  checkpoint: (name: string): Promise<void> => {
    if (name === crashAt) return Promise.reject(new Error(`crash:${String(name)}`));
    return Promise.resolve();
  },
});

const seedRoutingModel = async (core: Core, actor: string): Promise<void> => {
  const provider = await core.providers.register(createRoutingProvider(), { actorId: actor });
  if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
  const model = await core.models.registerFromProvider({
    providerId: PROVIDER_ID,
    providerModelId: PROVIDER_MODEL_ID,
    modelKey: MODEL_KEY,
    actorId: actor,
  });
  if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
};

interface Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly runId: string;
  readonly workTaskId: string;
  readonly paths: { readonly dataDir: string; readonly casRoot: string };
}

const makeFixture = async (options?: {
  readonly crashAt?: string;
}): Promise<Fixture> => {
  invocationLog.length = 0;
  const paths = { dataDir: tempDir(), casRoot: tempDir() };
  const core = await compose(paths, options);
  const assignments = (await core.database.roleAssignments.list({ limit: 10 })).items;
  const actor = assignments[0]?.actorId;
  if (actor === undefined) throw new Error('no owner provisioned');
  await seedRoutingModel(core, actor);
  const template = await core.lifecycle.createTemplate({
    orgId: COMPANY,
    name: `T19-03b ${core.ids.id('t')}`,
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
    modelBindings: { supervisor: MODEL_KEY },
    goal: { objective: 'Prove the residue durability window is closed.', source: { type: 'human' } },
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
  return { core, actor, runId: run.value.run.id, workTaskId: work.value.id, paths };
};

/** ONE authorized developer turn through the exposed runtime (§23: no inner loop). */
const developerTurn = (f: Fixture, taskId = f.workTaskId) =>
  f.core.developerSession!.runTurn({
    companyId: COMPANY,
    runId: f.runId,
    taskId,
    actorId: f.actor,
    structuredKeys: ['objective', 'summary'],
  });

/** Close THIS fixture's database and compose a fresh production stack on the SAME paths. */
const restart = async (f: Fixture): Promise<Core> => {
  f.core.database.close();
  const tracked = openDatabases.indexOf(f.core.database);
  if (tracked >= 0) openDatabases.splice(tracked, 1);
  const second = await compose(f.paths);
  await seedRoutingModel(second, f.actor);
  return second;
};

const runTurnOn = (core: Core, f: Fixture, taskId = f.workTaskId): Promise<TurnResult> =>
  core.developerSession!.runTurn({
    companyId: COMPANY,
    runId: f.runId,
    taskId,
    actorId: f.actor,
    structuredKeys: ['objective', 'summary'],
  });

type TurnResult = Awaited<ReturnType<NonNullable<Core['developerSession']>['runTurn']>>;

const entriesOf = (core: Core, sessionId: string) =>
  core.database.sessionStore!.listEntries(sessionId);

const executionRow = (core: Core, executionId: string) =>
  core.database.db
    .prepare('SELECT execution_id, status, task_id, run_id FROM agent_executions WHERE execution_id = ?')
    .get(executionId) as { execution_id: string; status: string; task_id: string; run_id: string } | undefined;

const countExecutions = (core: Core, taskId: string): number =>
  Number(
    (core.database.db
      .prepare('SELECT COUNT(*) AS c FROM agent_executions WHERE task_id = ?')
      .get(taskId) as { c: number | bigint }).c,
  );

const countCompletedWithoutResidue = (core: Core): number =>
  Number(
    (core.database.db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_executions e
         WHERE e.status = 'COMPLETED'
           AND NOT EXISTS (
             SELECT 1 FROM session_entries se WHERE se.execution_id = e.execution_id
           )`,
      )
      .get() as { c: number | bigint }).c,
  );

const taskStateOf = async (core: Core, taskId: string): Promise<string> => {
  const task = await core.database.tasks.get(taskId as never);
  return String(task?.state);
};

const userMessageOf = (index: number): string => {
  const call = invocationLog[index];
  if (call === undefined) throw new Error(`no provider invocation #${String(index)}`);
  return call.messages.find((m) => m.role === 'user')!.content;
};

describe('T19-03b closeout §10.1-4 — the exact ordering and its crash windows', () => {
  it('1. a normal turn settles exactly one COMPLETED execution with exactly one durable residue', async () => {
    const f = await makeFixture();
    const turn = await developerTurn(f);
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    // terminal: the durable row says COMPLETED before the turn hands back
    const row = executionRow(f.core, turn.value.executionId);
    expect(row?.status).toBe('COMPLETED');
    expect(row?.task_id).toBe(f.workTaskId);
    // exactly ONE residue entry, permanently identified by this execution
    const entries = await entriesOf(f.core, turn.value.sessionId);
    const outputs = entries.filter((entry) => entry.entryKind === 'model_output_residue');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.executionId).toBe(turn.value.executionId);
    expect(outputs[0]!.commandId).toContain(`turn:${turn.value.executionId}`);
    // the forbidden state does not exist anywhere in the database
    expect(countCompletedWithoutResidue(f.core)).toBe(0);
  });

  it('2. crash BEFORE the provider: no execution, no residue, nothing fabricated', async () => {
    const f = await makeFixture({ crashAt: 'after_session_before_provider' });
    await expect(developerTurn(f)).rejects.toThrow('crash:after_session_before_provider');
    expect(countExecutions(f.core, f.workTaskId)).toBe(0);
    const sessionId = (f.core.database.db.prepare('SELECT session_id FROM sessions').get() as { session_id: string }).session_id;
    const entries = await entriesOf(f.core, sessionId);
    expect(entries.filter((entry) => entry.entryKind === 'model_output_residue')).toHaveLength(0);
    expect(await taskStateOf(f.core, f.workTaskId)).not.toBe('DONE');
    // restart: the next authorized turn proceeds cleanly (the caller decides, §23)
    const second = await restart(f);
    const resumed = (await runTurnOn(second, f)) as TurnResult;
    expect(resumed.ok).toBe(true);
  });

  it('3. crash at the EXACT residue boundary: residue missing AND execution NOT terminal — the forbidden state is unreachable', async () => {
    const f = await makeFixture({ crashAt: 'after_provider_result_before_session_residue' });
    await expect(developerTurn(f)).rejects.toThrow('crash:after_provider_result_before_session_residue');
    expect(invocationLog).toHaveLength(1); // the provider WAS called once…
    // …but the settlement never happened: the execution stays RUNNING, never COMPLETED
    const rows = f.core.database.db
      .prepare('SELECT execution_id, status FROM agent_executions WHERE task_id = ?')
      .all(f.workTaskId) as { execution_id: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('RUNNING');
    // residue NOT durable; the forbidden state (COMPLETED without residue) exists nowhere
    const sessionId = (f.core.database.db.prepare('SELECT session_id FROM sessions').get() as { session_id: string }).session_id;
    const entries = await entriesOf(f.core, sessionId);
    expect(entries.filter((entry) => entry.entryKind === 'model_output_residue')).toHaveLength(0);
    expect(countCompletedWithoutResidue(f.core)).toBe(0);
    expect(await taskStateOf(f.core, f.workTaskId)).not.toBe('DONE');
    // restart: the caller MAY run a new authorized turn — a NEW execution, not a resurrection
    const second = await restart(f);
    const next = (await runTurnOn(second, f)) as TurnResult;
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.executionId).not.toBe(rows[0]!.execution_id);
    // the lost provider output is NOT silently reconstructed or replayed into the context
    expect(userMessageOf(1)).not.toContain('developer note 1');
  });

  it('4. crash AFTER the residue, BEFORE the settlement: residue durable + execution non-terminal; never trusted', async () => {
    const f = await makeFixture({ crashAt: 'after_session_residue_before_execution_settlement' });
    await expect(developerTurn(f)).rejects.toThrow('crash:after_session_residue_before_execution_settlement');
    // the residue IS durable, and the execution is NOT terminal (Shape B's recovered state)
    const sessionId = (f.core.database.db.prepare('SELECT session_id FROM sessions').get() as { session_id: string }).session_id;
    const entries = await entriesOf(f.core, sessionId);
    const orphan = entries.find((entry) => entry.entryKind === 'model_output_residue');
    expect(orphan).toBeDefined();
    const rows = f.core.database.db
      .prepare('SELECT execution_id, status FROM agent_executions WHERE task_id = ?')
      .all(f.workTaskId) as { execution_id: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('RUNNING'); // settlement never happened
    expect(orphan!.executionId).toBe(rows[0]!.execution_id);
    expect(await taskStateOf(f.core, f.workTaskId)).not.toBe('DONE');
    // restart: the next turn CAN proceed, and the orphan residue is NOT fed to it (§9)
    const second = await restart(f);
    const next = (await runTurnOn(second, f)) as TurnResult;
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(userMessageOf(1)).not.toContain('developer note 1'); // excluded: non-terminal execution
    // the orphan stays durable as history — no deletion, no rewrite
    const kept = await entriesOf(second, next.value.sessionId);
    expect(kept.some((entry) => entry.text.includes('developer note 1'))).toBe(true);
    // no provider call was made merely to recreate the durable output: one crashed call + one
    // NEW authorized turn = exactly two invocations
    expect(invocationLog).toHaveLength(2);
  });
});

describe('T19-03b closeout §10.5-6 — restart durability', () => {
  it('5. a restart cannot lose a completed turn: residue + COMPLETED row + next context', async () => {
    const f = await makeFixture();
    const turn1 = await developerTurn(f);
    expect(turn1.ok).toBe(true);
    if (!turn1.ok) return;
    const second = await restart(f);
    // the completed turn survived the restart, unchanged
    expect(executionRow(second, turn1.value.executionId)?.status).toBe('COMPLETED');
    const kept = await entriesOf(second, turn1.value.sessionId);
    expect(kept.some((entry) => entry.text.includes('developer note 1'))).toBe(true);
    // and the NEXT turn's context still receives it (eligible: COMPLETED execution)
    const turn2 = (await runTurnOn(second, f)) as TurnResult;
    expect(turn2.ok).toBe(true);
    if (!turn2.ok) return;
    expect(userMessageOf(1)).toContain('developer note 1');
  });

  it('6. a restart NEVER invokes the provider to recreate durable output', async () => {
    const f = await makeFixture();
    const turn1 = await developerTurn(f);
    expect(turn1.ok).toBe(true);
    if (!turn1.ok) return;
    expect(invocationLog).toHaveLength(1);
    const second = await restart(f);
    // composing the stack + reading the session makes ZERO provider calls
    const active = await second.sessionKernel!.readActiveContext({
      companyId: COMPANY,
      sessionId: turn1.value.sessionId,
    });
    expect(active.ok).toBe(true);
    expect(invocationLog).toHaveLength(1);
    // the residue still carries the ORIGINAL execution's permanent command — nothing recreated
    const outputs = (await entriesOf(second, turn1.value.sessionId)).filter(
      (entry) => entry.entryKind === 'model_output_residue',
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.commandId).toContain(`turn:${turn1.value.executionId}`);
  });
});

describe('T19-03b closeout §10.7-10 — idempotence and no fabrication', () => {
  it('7. the permanent residue command replays idempotently (same command, same entry)', async () => {
    const f = await makeFixture();
    const turn = await developerTurn(f);
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    const before = await entriesOf(f.core, turn.value.sessionId);
    const original = before.find((entry) => entry.entryKind === 'model_output_residue')!;
    const replay = await f.core.sessionKernel!.appendEntry({
      companyId: COMPANY,
      sessionId: turn.value.sessionId,
      commandId: `turn:${turn.value.executionId}`, // the SAME permanent command
      entryKind: 'model_output_residue',
      text: original.text,
      refs: [{ kind: 'agent-execution', id: turn.value.executionId }],
      executionId: turn.value.executionId,
      inputTokenEstimate: original.tokenAccounting.inputTokenEstimate, // the SAME fingerprint
    });
    expect(replay.ok).toBe(true);
    const after = await entriesOf(f.core, turn.value.sessionId);
    expect(after).toHaveLength(before.length); // no duplicate entry
    expect(
      after.filter((entry) => entry.entryKind === 'model_output_residue'),
    ).toHaveLength(1);
  });

  it('8. no duplicate residue: three turns ⇒ seed + exactly three distinct residues', async () => {
    const f = await makeFixture();
    for (let i = 0; i < 3; i += 1) {
      const turn = await developerTurn(f);
      expect(turn.ok).toBe(true);
    }
    const sessionId = (f.core.database.db.prepare('SELECT session_id FROM sessions').get() as { session_id: string }).session_id;
    const entries = await entriesOf(f.core, sessionId);
    expect(entries).toHaveLength(4); // one seed + three outputs
    const outputs = entries.filter((entry) => entry.entryKind === 'model_output_residue');
    expect(new Set(outputs.map((entry) => entry.commandId)).size).toBe(3);
    expect(new Set(outputs.map((entry) => entry.executionId)).size).toBe(3);
  });

  it('9. no duplicate AgentExecution: two turns ⇒ exactly two executions for the task', async () => {
    const f = await makeFixture();
    const turn1 = await developerTurn(f);
    const turn2 = await developerTurn(f);
    expect(turn1.ok).toBe(true);
    expect(turn2.ok).toBe(true);
    if (!turn1.ok || !turn2.ok) return;
    expect(countExecutions(f.core, f.workTaskId)).toBe(2);
    expect(turn2.value.executionId).not.toBe(turn1.value.executionId);
  });

  it('10. the task is NEVER fabricated DONE on any crash path', async () => {
    for (const crashAt of [
      'after_session_before_provider',
      'after_provider_result_before_session_residue',
      'after_session_residue_before_execution_settlement',
    ]) {
      const f = await makeFixture({ crashAt });
      await expect(developerTurn(f)).rejects.toThrow(`crash:${String(crashAt)}`);
      expect(await taskStateOf(f.core, f.workTaskId)).not.toBe('DONE');
      expect(countCompletedWithoutResidue(f.core)).toBe(0);
    }
  });
});

describe('T19-03b closeout §10.11-13 — active-context eligibility (§9)', () => {
  it('11. the next turn sees ALL eligible prior residue', async () => {
    const f = await makeFixture();
    await developerTurn(f);
    await developerTurn(f);
    const turn3 = await developerTurn(f);
    expect(turn3.ok).toBe(true);
    if (!turn3.ok) return;
    const user = userMessageOf(2);
    expect(user).toContain('developer note 1');
    expect(user).toContain('developer note 2');
  });

  it('12. FAILED / CANCELLED executions leave durable residue that is NEVER treated as success', async () => {
    const f = await makeFixture();
    const turn1 = await developerTurn(f);
    expect(turn1.ok).toBe(true);
    if (!turn1.ok) return;
    // FAILED: the durable status no longer says COMPLETED ⇒ the residue is ineligible
    f.core.database.db
      .prepare('UPDATE agent_executions SET status = ? WHERE execution_id = ?')
      .run('FAILED', turn1.value.executionId);
    const turn2 = await developerTurn(f);
    expect(turn2.ok).toBe(true);
    if (!turn2.ok) return;
    expect(userMessageOf(1)).not.toContain('developer note 1');
    // CANCELLED: same fail-closed rule (history kept, context excludes it)
    f.core.database.db
      .prepare('UPDATE agent_executions SET status = ? WHERE execution_id = ?')
      .run('CANCELLED', turn1.value.executionId);
    const turn3 = await developerTurn(f);
    expect(turn3.ok).toBe(true);
    if (!turn3.ok) return;
    const user3 = userMessageOf(2);
    expect(user3).not.toContain('developer note 1'); // the CANCELLED turn's residue
    expect(user3).toContain('developer note 2'); // the still-COMPLETED turn's residue
    // INTERRUPTED: the crash-recovery terminal state is equally ineligible (a residue-first
    // crash that recovery swept out of RUNNING still never becomes a completed turn). The
    // storage layer itself also fails closed: an UNKNOWN status cannot even be written
    // (CHECK-constrained whitelist), so no tampered status can sneak past this gate.
    f.core.database.db
      .prepare('UPDATE agent_executions SET status = ? WHERE execution_id = ?')
      .run('INTERRUPTED', turn2.value.executionId);
    const turn4 = await developerTurn(f);
    expect(turn4.ok).toBe(true);
    if (!turn4.ok) return;
    expect(userMessageOf(3)).not.toContain('developer note 2');
  });

  it('13. a foreign execution residue is rejected at append (fail closed, no schema trust)', async () => {
    const f = await makeFixture();
    const turn = await developerTurn(f);
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    // an execution of ANOTHER run cannot attach its output to this session
    const stamp = new Date().toISOString();
    const foreignExecution = `exec_${f.core.ids.id('fx')}`;
    f.core.database.db
      .prepare(
        `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
           provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
           input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
           created_at, updated_at)
         VALUES (?, 'agent.developer', 'rol.developer', ?, 'run_foreign', 'm', 'p', 'pm', 'COMPLETED', ?, NULL, 'tr', 1,
           '{}', '{}', 1, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(foreignExecution, f.workTaskId, stamp, stamp, stamp);
    const foreign = await f.core.sessionKernel!.appendEntry({
      companyId: COMPANY,
      sessionId: turn.value.sessionId,
      commandId: 'foreign-run',
      entryKind: 'model_output_residue',
      text: 'foreign run output',
      executionId: foreignExecution,
      inputTokenEstimate: 1,
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok === true) return;
    expect(String(foreign.error.details['reason'] ?? '')).toBe('SESSION_EXECUTION_RUN_MISMATCH');
    // nothing entered the durable history
    const outputs = (await entriesOf(f.core, turn.value.sessionId)).filter(
      (entry) => entry.entryKind === 'model_output_residue',
    );
    expect(outputs).toHaveLength(1); // only the turn's own residue
  });
});

describe('T19-03b closeout §10.14 — restart preserves the T0→T1 lineage', () => {
  it('14. across a restart, the corrective T1 session keeps parent = the T0 session', async () => {
    const f = await makeFixture();
    const t0 = await developerTurn(f);
    expect(t0.ok).toBe(true);
    if (!t0.ok) return;
    const t1Task = await createTask({
      runId: f.runId as never,
      stageId: 'work' as never,
      roleId: 'rol_dev' as never,
      kind: 'e2e7:build',
      now: new Date().toISOString(),
      ids: f.core.ids,
      inputs: {
        corrective: {
          schemaVersion: 'companyos/corrective-task/1',
          companyId: COMPANY,
          runId: f.runId,
          originDecisionId: 'dec_t19_03b',
          originDecisionVersion: 1,
          reasonCode: 'REVIEW_FINDING',
          parentTaskId: f.workTaskId,
          rootTaskId: f.workTaskId,
          round: 1,
          causeEvidenceRefs: [],
          fingerprint: '0'.repeat(64),
        },
      },
    });
    if (!t1Task.ok) throw new Error(t1Task.error.message);
    await f.core.database.tasks.put(t1Task.value);
    const t1 = await developerTurn(f, t1Task.value.id);
    expect(t1.ok).toBe(true);
    if (!t1.ok) return;
    expect(t1.value.sessionId).not.toBe(t0.value.sessionId);
    // restart: the lineage is re-derived from the DURABLE state, not process memory
    const second = await restart(f);
    const after = (await runTurnOn(second, f, t1Task.value.id)) as TurnResult;
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.sessionId).toBe(t1.value.sessionId);
    const s1 = second.database.db
      .prepare('SELECT parent_session_id FROM sessions WHERE session_id = ?')
      .get(after.value.sessionId) as { parent_session_id: string | null };
    expect(s1.parent_session_id).toBe(t0.value.sessionId);
    // both sessions' residue survived the restart
    expect(
      (await entriesOf(second, t0.value.sessionId)).some((entry) =>
        entry.text.includes('developer note 1'),
      ),
    ).toBe(true);
  });
});
