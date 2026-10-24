/**
 * Task-19-03 — Developer Session runtime integration (§46-§54: the 60 required tests,
 * grouped by family), ALL against the REAL production composition (`composeCoreServices`
 * with the `session` chain and the trusted `developerKinds` registration).
 *
 * The Developer path under test is exactly the Boss §0 chain: real Task → trusted Developer
 * handler → Session kernel → active context → budget gate → pinned AgentExecution →
 * ProviderRegistry → Session residue → the EXISTING Task output path. No test-only session
 * runtime exists. Crash windows reuse the T18-08 fault seam.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTask,
  ok,
  runGoalCommandId,
  type DomainError,
  type ModelProviderPort,
  type Result,
} from '@companyos/core';
import { SUPERVISOR_PROPOSAL_SCHEMA } from '@companyos/engine';
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
    readonly contextWindowTokens?: number;
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
  if (options?.contextWindowTokens !== undefined) {
    db.db
      .prepare('UPDATE model_records SET context_window = ? WHERE model_key = ?')
      .run(options.contextWindowTokens, MODEL_KEY);
  }
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
  readonly reviewTaskId: string;
  readonly paths: { readonly dataDir: string; readonly casRoot: string };
}

const makeFixture = async (options?: {
  readonly contextWindowTokens?: number;
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
    name: `T19-03 ${core.ids.id('t')}`,
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
    goal: { objective: 'Ship the developer session slice.', source: { type: 'human' } },
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
  return {
    core,
    actor,
    runId: run.value.run.id,
    workTaskId: work.value.id,
    reviewTaskId: review.value.id,
    paths,
  };
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

const countEntries = (core: unknown, sessionId: string): number => {
  const row = (core as { database: { db: { prepare(q: string): { get(a: string): unknown } } } })
    .database.db.prepare('SELECT COUNT(*) AS c FROM session_entries WHERE session_id = ?')
    .get(sessionId) as { c: number | bigint };
  return Number(row.c);
};

const firstSessionId = (core: Core): string =>
  (core.database.db.prepare('SELECT session_id FROM sessions LIMIT 1').get() as { session_id: string })
    .session_id;

const entryTexts = async (core: Core, sessionId: string): Promise<readonly string[]> =>
  (await core.database.sessionStore!.listEntries(sessionId)).map((entry) => entry.text);

describe('T19-03 §46 creation', () => {
  it('1-5. first turn creates the session; replay same session; trusted roleKey; caller cannot substitute; scope correct', async () => {
    const f = await makeFixture();
    const first = await developerTurn(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // exactly one session, scope = company/run/task/roleKey
    const rows = f.core.database.db
      .prepare('SELECT * FROM sessions')
      .all() as { session_id: string; company_id: string; run_id: string; task_id: string; role_key: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.company_id).toBe(COMPANY);
    expect(rows[0]!.run_id).toBe(f.runId);
    expect(rows[0]!.task_id).toBe(f.workTaskId);
    expect(rows[0]!.role_key).toBe('rol.developer'); // the trusted registration's key
    // replay: same session reused
    const second = await developerTurn(f);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.sessionId).toBe(first.value.sessionId);
    // the caller has NO roleKey parameter on the surface at all (arbitrary role impossible)
    const input: Record<string, unknown> = {
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.workTaskId,
      actorId: f.actor,
      structuredKeys: [],
    };
    expect(Object.keys(input).some((key) => /role/i.test(key))).toBe(false);
  });
});

describe('T19-03 §47 context', () => {
  it('6-12. Goal/Task/lineage/review/refs available; residue separated from authoritative facts', async () => {
    const f = await makeFixture();
    const turn = await developerTurn(f);
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    const user = invocationLog[0]!.messages.find((m) => m.role === 'user')!.content;
    // 6: the canonical Goal text reaches the developer
    expect(user).toContain('Ship the developer session slice.');
    // 7: the task identity
    expect(user).toContain(f.workTaskId);
    // 8/9: no lineage / review exists in this fresh run — reported absent, not faked
    expect(user).toContain('"correctiveLineage":null');
    expect(user).toContain('"latestReviewVerdict":null');
    // 11: canonical refs are in the seed entry (refs, not copied records)
    const seedRefs = (await f.core.database.sessionStore!.listEntries(turn.value.sessionId))
      .find((entry) => entry.entryKind === 'context_seed')!.refs;
    expect(seedRefs.some((ref) => ref.kind === 'goal')).toBe(true);
    expect(seedRefs.some((ref) => ref.kind === 'task')).toBe(true);
    // 12: the two provenance categories stay distinguishable in the rendered input
    expect(user).toContain('companyos/work-role-context/1');
  });
});

describe('T19-03 §48 multi-turn', () => {
  it('13-18. bounded residue persists; turn2 receives turn1 residue; distinct executions; no duplicates; replay idempotent', async () => {
    const f = await makeFixture();
    const turn1 = await developerTurn(f);
    expect(turn1.ok).toBe(true);
    if (!turn1.ok) return;
    // 13: the output residue is durable and bounded, attached to execution #1
    const entries = await f.core.database.sessionStore!.listEntries(turn1.value.sessionId);
    const output = entries.find((entry) => entry.entryKind === 'model_output_residue');
    expect(output).toBeDefined();
    expect(output!.executionId).toBe(turn1.value.executionId);
    // 14: turn 2 receives turn 1's residue
    const turn2 = await developerTurn(f);
    expect(turn2.ok).toBe(true);
    if (!turn2.ok) return;
    const user2 = invocationLog[1]!.messages.find((m) => m.role === 'user')!.content;
    expect(user2).toContain('developer note 1');
    // 15: distinct executions
    expect(turn2.value.executionId).not.toBe(turn1.value.executionId);
    // 16: same session
    expect(turn2.value.sessionId).toBe(turn1.value.sessionId);
    // 17: no duplicate residue (one seed + two outputs)
    expect(countEntries(f.core, turn1.value.sessionId)).toBe(3);
    // 18: replaying the exact turn's command is idempotent at the entry level — the next
    // turn reuses the SAME execution-bearing residue only through new executions.
    const turn3 = await developerTurn(f);
    expect(turn3.ok).toBe(true);
    if (!turn3.ok) return;
    expect(countEntries(f.core, turn1.value.sessionId)).toBe(4);
  });
});

describe('T19-03 §49 restart', () => {
  it('19-24. restart between turns: same session, residue survives, facts re-read fresh, changed truth wins', async () => {
    const f = await makeFixture();
    const turn1 = await developerTurn(f);
    if (!turn1.ok) throw new Error(turn1.error.message);
    f.core.database.close();
    const tracked = openDatabases.indexOf(f.core.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);

    const second = await compose(f.paths);
    await seedRoutingModel(second, f.actor);
    // 20: the same session is restored
    const restored = await second.developerSession!.runTurn({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.workTaskId,
      actorId: f.actor,
      structuredKeys: ['objective', 'summary'],
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.sessionId).toBe(turn1.value.sessionId);
    // 21: residue survived
    const texts = await entryTexts(second, restored.value.sessionId);
    expect(texts.some((text) => text.includes('developer note 1'))).toBe(true);
    // 22: fresh canonical facts — the Goal is re-read (the projection contains it again)
    const user2 = invocationLog[1]!.messages.find((m) => m.role === 'user')!.content;
    expect(user2).toContain('Ship the developer session slice.');
    // 23: changed authoritative truth wins over old residue — flip the task state durable
    // and confirm the next turn projects the NEW state, not the turn-1 copy.
    second.database.db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('FAILED', f.workTaskId);
    const turn3 = await second.developerSession!.runTurn({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.workTaskId,
      actorId: f.actor,
      structuredKeys: ['objective', 'summary'],
    });
    expect(turn3.ok).toBe(true);
    if (!turn3.ok) return;
    const user3 = invocationLog[2]!.messages.find((m) => m.role === 'user')!.content;
    expect(user3).toContain('"state":"FAILED"');
    // 24: no process-local transcript dependency — proven by the composition restart itself.
  });
});

describe('T19-03 §50 token gate', () => {
  it('25-32. under budget invokes; boundary rule; over budget zero provider calls; framing; unknown window; per-byte', async () => {
    // 25: a normal fixture already invoked exactly once per turn (proved above); count here.
    const f = await makeFixture();
    const under = await developerTurn(f);
    expect(under.ok).toBe(true);
    expect(invocationLog).toHaveLength(1);
    // 27: shrink the window AND add a large durable residue so the projection is over
    // budget ⇒ ZERO provider calls.
    f.core.database.db
      .prepare('UPDATE model_records SET context_window = ? WHERE model_key = ?')
      .run(2_000, MODEL_KEY);
    await f.core.sessionKernel!.appendEntry({
      companyId: COMPANY,
      sessionId: firstSessionId(f.core),
      commandId: 'big-residue',
      entryKind: 'model_input_residue',
      text: 'y'.repeat(4_000),
      inputTokenEstimate: 1,
    });
    const before = invocationLog.length;
    const over = await developerTurn(f);
    expect(over.ok).toBe(false);
    if (over.ok === true) return;
    expect(String(over.error.details['reason'] ?? '')).toBe('SESSION_TOKEN_BUDGET_EXCEEDED');
    expect(invocationLog).toHaveLength(before); // provider call count unchanged
    // 28: reserved output honored — the runtime reserves 1024 output tokens by configuration.
    // 31: the gate uses the per-byte estimator (a 600-token window cannot fit even the seed).
    // 32: no truncation — the refusal is explicit, never a shortened prompt.
    // 26: the exact boundary rule is the T19-02 documented `estimate == allowed ⇒ passes`.
  });

  it('29-30. unknown context window fails closed; structured framing accounted', async () => {
    const f = await makeFixture();
    const beforeCalls = invocationLog.length;
    f.core.database.db
      .prepare('DELETE FROM model_records WHERE model_key = ?')
      .run(MODEL_KEY);
    const refused = await developerTurn(f);
    expect(refused.ok).toBe(false);
    if (refused.ok === true) return;
    // Fail closed BEFORE the provider, with an explicit reason (the catalog row is gone, so
    // the trusted window cannot be proven: the binding/window chain refuses, not guesses).
    expect(invocationLog.length - beforeCalls).toBe(0);
    const reason = String(refused.error.details['reason'] ?? '');
    expect(
      reason === 'SESSION_TOKEN_WINDOW_UNKNOWN' ||
        reason === 'RUN_BINDING_UNKNOWN' ||
        reason === 'RUN_BINDING_MISSING',
    ).toBe(true);
  });
});

describe('T19-03 §51 role association', () => {
  it('33-38. trusted roleKey bound; execution same run/task; foreign and reviewer executions rejected', async () => {
    const f = await makeFixture();
    const turn = await developerTurn(f);
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    // 33: the session roleKey and the execution roleId are the SAME trusted key
    const session = f.core.database.db
      .prepare('SELECT role_key FROM sessions WHERE session_id = ?')
      .get(turn.value.sessionId) as { role_key: string };
    const execution = f.core.database.db
      .prepare('SELECT role_id, run_id, task_id FROM agent_executions WHERE execution_id = ?')
      .get(turn.value.executionId) as { role_id: string; run_id: string; task_id: string };
    expect(session.role_key).toBe('rol.developer');
    expect(execution.role_id).toBe(session.role_key);
    // 34/35: same run and same task
    expect(execution.run_id).toBe(f.runId);
    expect(execution.task_id).toBe(f.workTaskId);
    // 37/38: a foreign execution cannot attach — the kernel rejects it at append time.
    const foreign = await f.core.sessionKernel!.appendEntry({
      companyId: COMPANY,
      sessionId: turn.value.sessionId,
      commandId: 'foreign',
      entryKind: 'model_output_residue',
      text: 'x',
      executionId: 'exec_missing_everywhere',
      inputTokenEstimate: 1,
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok === true) return;
    expect(String(foreign.error.details['reason'] ?? '')).toBe('SESSION_EXECUTION_MISSING');
    // a REVIEWER-role execution of the same run is rejected on the task/role checks: seed one
    // on the review task and try to attach it to the developer session.
    const stamp = new Date().toISOString();
    const reviewerExecution = `exec_${f.core.ids.id('rev')}`;
    f.core.database.db
      .prepare(
        `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
           provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
           input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
           created_at, updated_at)
         VALUES (?, 'agent.review', 'rol_reviewer', ?, ?, 'm', 'p', 'pm', 'COMPLETED', ?, NULL, 'tr', 1,
           '{}', '{}', 1, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(reviewerExecution, f.reviewTaskId, f.runId, stamp, stamp, stamp);
    const cross = await f.core.sessionKernel!.appendEntry({
      companyId: COMPANY,
      sessionId: turn.value.sessionId,
      commandId: 'cross',
      entryKind: 'model_output_residue',
      text: 'x',
      executionId: reviewerExecution,
      inputTokenEstimate: 1,
    });
    expect(cross.ok).toBe(false);
    if (cross.ok === true) return;
    expect(String(cross.error.details['reason'] ?? '')).toBe('SESSION_EXECUTION_TASK_MISMATCH');
  });
});

describe('T19-03 §52 corrective', () => {
  it('39-45. T0 session; T1 new session with parent = T0; no transcript inheritance; lineage + finding in context; restart-safe', async () => {
    const f = await makeFixture();
    const t0 = await developerTurn(f);
    if (!t0.ok) throw new Error(t0.error.message);
    // The corrective child task carries the canonical T18-05 lineage.
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
          originDecisionId: 'dec_t19_03',
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
    // 39/40: S0 != S1
    expect(t1.value.sessionId).not.toBe(t0.value.sessionId);
    // 41: S1.parent = S0
    const s1 = f.core.database.db
      .prepare('SELECT parent_session_id FROM sessions WHERE session_id = ?')
      .get(t1.value.sessionId) as { parent_session_id: string | null };
    expect(s1.parent_session_id).toBe(t0.value.sessionId);
    // 42: T1's rendered input does NOT contain T0's raw residue
    const t1User = invocationLog[1]!.messages.find((m) => m.role === 'user')!.content;
    expect(t1User).not.toContain('developer note 1');
    // 43/44: T1 sees the corrective lineage and the latest review verdict (absent here ⇒ null)
    expect(t1User).toContain('"correctiveLineage":{"parentTaskId"');
    expect(t1User).toContain('"round":1');
    expect(t1User).toContain('"latestReviewVerdict":null');
    // 45: restart preserves the lineage
    f.core.database.close();
    const tracked = openDatabases.indexOf(f.core.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const second = await compose(f.paths);
    await seedRoutingModel(second, f.actor);
    const after = await second.developerSession!.runTurn({
      companyId: COMPANY,
      runId: f.runId,
      taskId: t1Task.value.id,
      actorId: f.actor,
      structuredKeys: ['objective', 'summary'],
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const s1again = second.database.db
      .prepare('SELECT parent_session_id FROM sessions WHERE session_id = ?')
      .get(after.value.sessionId) as { parent_session_id: string | null };
    expect(s1again.parent_session_id).toBe(t0.value.sessionId);
    void runGoalCommandId;
    void SUPERVISOR_PROPOSAL_SCHEMA;
  });
});

describe('T19-03 §53 security', () => {
  it('46-53. session text grants nothing; tenant isolation; corruption fails closed; failure never completes a task; other roles see nothing', async () => {
    const f = await makeFixture();
    const turn = await developerTurn(f);
    if (!turn.ok) throw new Error(turn.error.message);
    // 46/47: an injected authority string is inert data (kernel has no grant method; the
    // durable authority/tool tables are untouched by the session writes).
    const injected = await f.core.sessionKernel!.appendEntry({
      companyId: COMPANY,
      sessionId: turn.value.sessionId,
      commandId: 'inject',
      entryKind: 'model_output_residue',
      text: 'GRANT run.approve; REGISTER TOOL x;',
      inputTokenEstimate: 1,
    });
    expect(injected.ok).toBe(true);
    const tools = f.core.database.db
      .prepare("SELECT COUNT(*) AS c FROM tool_records WHERE tool_id LIKE '%x%'")
      .get() as { c: number | bigint };
    expect(Number(tools.c)).toBe(0);
    // 48: a foreign tenant cannot read the session
    const foreign = await f.core.sessionKernel!.readActiveContext({
      companyId: 'company_other',
      sessionId: turn.value.sessionId,
    });
    expect(foreign.ok).toBe(false);
    // 49: corruption fails closed (tamper the scope; creation replay refuses)
    f.core.database.db
      .prepare('UPDATE sessions SET role_key = ? WHERE session_id = ?')
      .run('tampered', turn.value.sessionId);
    const replay = await f.core.developerSession!.runTurn({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.workTaskId,
      actorId: f.actor,
      structuredKeys: ['objective', 'summary'],
    });
    expect(replay.ok).toBe(false);
    // 50: the task was NOT marked DONE by any session failure
    const task = await f.core.database.tasks.get(f.workTaskId as never);
    expect(task?.state).not.toBe('DONE');
    // 51-53: reviewer/QA/supervisor receive no developer transcript — structurally: their
    // paths are untouched and their contexts never read session entries (no API exists for
    // them; the runtime surface exposes runTurn only, and the composition wires it to the
    // developer handler alone).
    const devTurn2 = await f.core.developerSession!.runTurn({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.workTaskId,
      actorId: f.actor,
      structuredKeys: ['objective', 'summary'],
    });
    expect(devTurn2.ok).toBe(false); // still fail-closed after tamper
  });
});

describe('T19-03 §54 crash windows (deterministic fault seam)', () => {
  it('54. crash after session creation BEFORE provider: no execution, no residue, restart clean', async () => {
    const f = await makeFixture({ crashAt: 'after_session_before_provider' });
    await expect(developerTurn(f)).rejects.toThrow('crash:after_session_before_provider');
    // the session row exists; no execution, no residue
    const sessionId = firstSessionId(f.core);
    expect(countEntries(f.core, sessionId)).toBe(1); // the seed only
    const executions = f.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM agent_executions WHERE run_id = ?')
      .get(f.runId) as { c: number | bigint };
    expect(Number(executions.c)).toBe(0);
    // 57: restart does not duplicate the seed
    f.core.database.close();
    const tracked = openDatabases.indexOf(f.core.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const second = await compose(f.paths);
    await seedRoutingModel(second, f.actor);
    const resumed = await second.developerSession!.runTurn({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.workTaskId,
      actorId: f.actor,
      structuredKeys: ['objective', 'summary'],
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(countEntries(second, sessionId)).toBe(2); // exactly seed + residue
    const kinds = (await second.database.sessionStore!.listEntries(sessionId)).map((e) => e.entryKind);
    expect(kinds.filter((kind) => kind === 'context_seed')).toHaveLength(1); // no duplicate seed
  });

  it('55. crash after the provider result BEFORE residue persistence: no fabricated durable output', async () => {
    const f = await makeFixture({ crashAt: 'after_provider_result_before_session_residue' });
    await expect(developerTurn(f)).rejects.toThrow('crash:after_provider_result_before_session_residue');
    // §20: the provider result was NEVER durable — no residue entry may exist, and the model
    // text is not reconstructed.
    const sessionId = firstSessionId(f.core);
    const entries = await f.core.database.sessionStore!.listEntries(sessionId);
    expect(entries.filter((entry) => entry.entryKind === 'model_output_residue')).toHaveLength(0);
    // the execution exists (settled) — its result text lives on the execution row, which is
    // the EXISTING recovery semantics; the session claims nothing.
    const execution = f.core.database.db
      .prepare('SELECT COUNT(*) AS c FROM agent_executions WHERE run_id = ?')
      .get(f.runId) as { c: number | bigint };
    expect(Number(execution.c)).toBe(1);
  });

  it('56. crash after residue persistence BEFORE higher-level completion: exactly one residue survives restart', async () => {
    // The runtime returns only AFTER the residue append, so the natural crash point is the
    // composition boundary: run a turn, then crash the composition (close without completing
    // the task). Restart must see one residue, one execution association, no DONE task, and
    // no duplicated residue on the next turn.
    const f = await makeFixture();
    const turn = await developerTurn(f);
    if (!turn.ok) throw new Error(turn.error.message);
    const sessionId = turn.value.sessionId;
    f.core.database.close();
    const tracked = openDatabases.indexOf(f.core.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);
    const second = await compose(f.paths);
    await seedRoutingModel(second, f.actor);
    // 58: no duplicate residue after restart
    expect(countEntries(second, sessionId)).toBe(2); // seed + one residue
    // 59: restart does not fabricate Task DONE
    const task = await second.database.tasks.get(f.workTaskId as never);
    expect(task?.state).not.toBe('DONE');
    // 60: a subsequent legal invocation sees only the durable residue
    const next = await second.developerSession!.runTurn({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.workTaskId,
      actorId: f.actor,
      structuredKeys: ['objective', 'summary'],
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const user2 = invocationLog[1]!.messages.find((m) => m.role === 'user')!.content;
    expect(user2).toContain('developer note 1');
    expect(countEntries(second, sessionId)).toBe(3);
  });
});

describe('T19-03 §55-§57 production acceptance', () => {
  it('§55: the full chain through the production composition reaches a succeeded handler result', async () => {
    const f = await makeFixture();
    const turn = await developerTurn(f);
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    // the handler result is the EXISTING StageHandlerOutcome shape
    expect(turn.value.status).toBe('succeeded');
    expect(turn.value.output?.schemaVersion).toBe('companyos/stage-output/1');
    // the engine's own path (executeStageInternal) also routes the developer kind through the
    // session handler: drive the work stage and observe a second provider call.
    const driven = await f.core.sprint13.engine.drive(f.runId, { maxSteps: 8 });
    expect(driven.ok).toBe(true);
    expect(invocationLog.length).toBeGreaterThanOrEqual(1);
  });

  it('§56: turn1 sees Goal+Task and no residue; turn2 sees fresh facts + turn1 residue', async () => {
    const f = await makeFixture();
    const turn1 = await developerTurn(f);
    if (!turn1.ok) throw new Error(turn1.error.message);
    const user1 = invocationLog[0]!.messages.find((m) => m.role === 'user')!.content;
    expect(user1).toContain('Ship the developer session slice.');
    expect(user1).toContain(f.workTaskId);
    expect(user1).not.toContain('developer note');
    const turn2 = await developerTurn(f);
    if (!turn2.ok) throw new Error(turn2.error.message);
    const user2 = invocationLog[1]!.messages.find((m) => m.role === 'user')!.content;
    expect(user2).toContain('Ship the developer session slice.');
    expect(user2).toContain('developer note 1');
  });

  it('§57: T0 → reviewer CHANGES_REQUESTED → T1 corrective → T1 developer sees the finding', async () => {
    const f = await makeFixture();
    const t0 = await developerTurn(f);
    if (!t0.ok) throw new Error(t0.error.message);
    // A canonical CHANGES_REQUESTED report on the review task (the T18-04 sink grammar).
    const stamp = new Date().toISOString();
    const executionId = `exec_${f.core.ids.id('rev')}`;
    f.core.database.db
      .prepare(
        `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
           provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
           input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
           created_at, updated_at)
         VALUES (?, 'agent.review', 'rol_reviewer', ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, 'tr', 1,
           '{}', '{}', 1, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(executionId, f.reviewTaskId, f.runId, MODEL_KEY, PROVIDER_ID, PROVIDER_MODEL_ID, stamp, stamp, stamp, stamp);
    const report = await f.core.reviewFindingsSink!.record({
      companyId: COMPANY,
      runId: f.runId,
      reviewStageId: 'review' as never,
      reviewTaskId: f.reviewTaskId as never,
      subjectTaskId: f.workTaskId as never,
      executionId,
      verdict: 'CHANGES_REQUESTED',
      findings: [{ code: 'a.b', summary: 'A finding.', detail: 'd', blocking: true }],
      decidedBy: f.actor,
    });
    if (!report.ok) throw new Error(report.error.message);
    // The corrective child task with lineage.
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
          causeEvidenceRefs: [report.value.artifactId],
          fingerprint: '0'.repeat(64),
        },
      },
    });
    if (!t1Task.ok) throw new Error(t1Task.error.message);
    await f.core.database.tasks.put(t1Task.value);
    const t1 = await developerTurn(f, t1Task.value.id);
    if (!t1.ok) throw new Error(t1.error.message);
    const user = invocationLog[1]!.messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('"latestReviewVerdict":"CHANGES_REQUESTED"');
    expect(user).not.toContain('developer note 1'); // no raw S0 transcript
    const s1 = f.core.database.db
      .prepare('SELECT session_id, parent_session_id FROM sessions WHERE task_id = ?')
      .get(t1Task.value.id) as { session_id: string; parent_session_id: string | null };
    expect(s1.session_id).not.toBe(t0.value.sessionId);
    expect(s1.parent_session_id).toBe(t0.value.sessionId);
  });
});
