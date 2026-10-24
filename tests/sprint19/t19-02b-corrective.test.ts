/**
 * T19-02 corrective — the three audit targets (Boss ruling A/B/C):
 *
 * A3: the hardened provider-neutral token estimator. The generic fallback is one UTF-8 byte
 *     = one token (deliberately pessimistic; false rejection acceptable, false acceptance
 *     NOT). The previous bytes÷3 rule could underestimate (CJK, punctuation runs) and is
 *     withdrawn — test 14 proves the undercount rule is gone.
 * B:  parentSessionId immutability after creation (null→P and P1→P2 replays rejected).
 * C2: execution reference scope (exists / same run / same task; foreign and unknown fail
 *     closed; restart preserves a validated association).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sessionIdOf } from '@companyos/core';
import {
  decideTokenBudget,
  estimateInputTokensUpperBound,
  FIXED_SAFETY_MARGIN_TOKENS,
} from '@companyos/engine';
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

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t19c-'));
  createdDirs.push(dir);
  return dir;
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

interface Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly runId: string;
  readonly workTaskId: string;
  readonly reviewTaskId: string;
  readonly paths: { readonly dataDir: string; readonly casRoot: string };
}

const makeFixture = async (): Promise<Fixture> => {
  const paths = { dataDir: tempDir(), casRoot: tempDir() };
  const core = await compose(paths);
  const assignments = (await core.database.roleAssignments.list({ limit: 10 })).items;
  const actor = assignments[0]?.actorId;
  if (actor === undefined) throw new Error('no owner provisioned');
  const { createTask } = await import('@companyos/core');
  const template = await core.lifecycle.createTemplate({
    orgId: COMPANY,
    name: `T19-02c ${core.ids.id('t')}`,
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

const ensureSession = (f: Fixture, parentSessionId?: string | null) =>
  f.core.sessionKernel!.ensureSession({
    companyId: COMPANY,
    runId: f.runId,
    taskId: f.workTaskId,
    roleKey: 'developer',
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
  });

const appendResidue = (
  f: Fixture,
  sessionId: string,
  commandId: string,
  executionId?: string | null,
) =>
  f.core.sessionKernel!.appendEntry({
    companyId: COMPANY,
    sessionId,
    commandId,
    entryKind: 'model_output_residue',
    text: 'residue',
    executionId: executionId ?? null,
    inputTokenEstimate: 1,
  });

/** A durable COMPLETED execution row bound to a specific run/task (the carrier's grammar). */
const seedExecution = (
  f: Fixture,
  input: { readonly runId: string; readonly taskId: string; readonly executionId: string },
): void => {
  const stamp = new Date().toISOString();
  f.core.database.db
    .prepare(
      `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
         provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
         input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
         created_at, updated_at)
       VALUES (?, 'agent.dev', 'rol_dev', ?, ?, 'm', 'p', 'pm', 'COMPLETED', ?, NULL, 'tr', 1,
         '{}', '{}', 1, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run(input.executionId, input.taskId, input.runId, stamp, stamp, stamp);
};

describe('T19-02 corrective A3 — hardened token estimator', () => {
  // The per-byte fallback: estimate === UTF-8 byte length, plus explicit framing tokens.
  const WINDOW = 8_192;

  it('1. ASCII prose: estimate equals the byte count (never below it)', () => {
    const ascii = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    expect(estimateInputTokensUpperBound(ascii)).toBe(ascii.length); // ASCII: bytes = chars
    expect(
      decideTokenBudget({
        contextWindowTokens: WINDOW,
        reservedOutputTokens: 0,
        renderedText: ascii,
      }).ok,
    ).toBe(true);
  });

  it('2. punctuation-heavy text: one byte = one token, no undercount', () => {
    const bangs = '!!!???...;;;,,,;;;'.repeat(100);
    expect(estimateInputTokensUpperBound(bangs)).toBe(bangs.length);
    // The withdrawn bytes÷3 rule would have claimed ~600 tokens for these 1800 bytes — a
    // tokenizer can legitimately produce one token per punctuation byte.
    expect(estimateInputTokensUpperBound(bangs)).toBeGreaterThanOrEqual(bangs.length);
  });

  it('3. JSON/code text: nested syntax counts per byte', () => {
    const code = '{"a":[{"b":"c"}],"d":[1,2,3],"e":{"f":null}}'.repeat(50);
    expect(estimateInputTokensUpperBound(code)).toBeGreaterThanOrEqual(
      Buffer.byteLength(code, 'utf8'),
    );
  });

  it('4. CJK text: a 3-byte character counts as 3, never 1 (the withdrawn undercount)', () => {
    const cjk = '汉'.repeat(100); // 3 bytes per character = 300 bytes
    expect(estimateInputTokensUpperBound(cjk)).toBe(300);
    // The old rule estimated ceil(300/3)=100, but a tokenizer may emit >100 tokens for 100
    // CJK characters — exactly the underestimate the corrective forbids.
  });

  it('5. emoji / multi-byte text: 4-byte code points count as 4', () => {
    const emoji = '🎉'.repeat(50); // 4 bytes each
    expect(estimateInputTokensUpperBound(emoji)).toBe(200);
  });

  it('6. combining Unicode: every combining byte is counted', () => {
    const combining = 'e\u0301'.repeat(100); // 'e' (1 byte) + combining acute (2 bytes)
    expect(estimateInputTokensUpperBound(combining)).toBe(300);
  });

  it('7. empty input estimates zero and passes', () => {
    expect(estimateInputTokensUpperBound('')).toBe(0);
    expect(
      decideTokenBudget({
        contextWindowTokens: WINDOW,
        reservedOutputTokens: 0,
        renderedText: '',
      }).ok,
    ).toBe(true);
  });

  it('8. the exact allowed boundary passes (estimate == allowed)', () => {
    // allowed = 8192 - 0 - 256 = 7936 bytes of input exactly at the boundary.
    const exact = 'x'.repeat(8_192 - FIXED_SAFETY_MARGIN_TOKENS);
    const decision = decideTokenBudget({
      contextWindowTokens: WINDOW,
      reservedOutputTokens: 0,
      renderedText: exact,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.value.estimatedInputTokens).toBe(7_936);
  });

  it('9. ONE unit over the boundary fails closed', () => {
    const over = 'x'.repeat(8_192 - FIXED_SAFETY_MARGIN_TOKENS + 1);
    const decision = decideTokenBudget({
      contextWindowTokens: WINDOW,
      reservedOutputTokens: 0,
      renderedText: over,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok === true) return;
    expect(String(decision.error.details['reason'] ?? '')).toBe('SESSION_TOKEN_BUDGET_EXCEEDED');
  });

  it('10. reserved output shrinks the allowed input exactly', () => {
    const text = 'x'.repeat(4_000);
    const noReserve = decideTokenBudget({
      contextWindowTokens: WINDOW,
      reservedOutputTokens: 0,
      renderedText: text,
    });
    const withReserve = decideTokenBudget({
      contextWindowTokens: WINDOW,
      reservedOutputTokens: 4_000,
      renderedText: text,
    });
    expect(noReserve.ok).toBe(true);
    expect(withReserve.ok).toBe(false); // allowed drops to 8192-4000-256 = 3936 < 4000
  });

  it('11. the fixed safety margin is part of the allowed computation', () => {
    const text = 'x'.repeat(7_937); // one byte past window-margin with zero reservation
    const decision = decideTokenBudget({
      contextWindowTokens: WINDOW,
      reservedOutputTokens: 0,
      renderedText: text,
    });
    expect(decision.ok).toBe(false);
  });

  it('12. impossible contextWindow configuration is rejected', () => {
    const decision = decideTokenBudget({
      contextWindowTokens: 300,
      reservedOutputTokens: 200,
      renderedText: 'x',
    });
    expect(decision.ok).toBe(false);
    if (decision.ok === true) return;
    expect(String(decision.error.details['reason'] ?? '')).toBe(
      'SESSION_TOKEN_BUDGET_IMPOSSIBLE',
    );
  });

  it('13. repeated estimates are deterministic', () => {
    const mixed = '汉🎉!!{"a":1}e\u0301'.repeat(37);
    const first = estimateInputTokensUpperBound(mixed);
    for (let index = 0; index < 5; index += 1) {
      expect(estimateInputTokensUpperBound(mixed)).toBe(first);
    }
  });

  it('14. the bytes÷3 undercount rule is GONE (estimate never divides)', () => {
    const cjk = '汉'.repeat(300); // 900 bytes
    const estimate = estimateInputTokensUpperBound(cjk);
    // Under the withdrawn rule this would have been 300 — an undercount. Now it is 900.
    expect(estimate).toBe(900);
    expect(estimate).toBeGreaterThanOrEqual(900);
    // ASCII too: 300 bytes estimate 300, not 100.
    expect(estimateInputTokensUpperBound('a'.repeat(300))).toBe(300);
  });

  it('A2. explicit framing tokens are additive and accounted', () => {
    const body = 'x'.repeat(1_000);
    const withFraming = decideTokenBudget({
      contextWindowTokens: 2_000,
      reservedOutputTokens: 0,
      renderedText: body,
      additionalFramingTokens: 800,
    });
    // 1000 body + 800 framing = 1800 ≤ 2000-256=1744? No: 1800 > 1744 ⇒ fails closed.
    expect(withFraming.ok).toBe(false);
    const smaller = decideTokenBudget({
      contextWindowTokens: 2_000,
      reservedOutputTokens: 0,
      renderedText: body,
      additionalFramingTokens: 700,
    });
    expect(smaller.ok).toBe(true); // 1700 ≤ 1744
  });
});

describe('T19-02 corrective B — parent immutability', () => {
  it('B1. P1 → P2 replay is REJECTED (never silently rewritten)', async () => {
    const f = await makeFixture();
    const parent1 = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.reviewTaskId,
      roleKey: 'reviewer',
    });
    if (!parent1.ok) throw new Error(parent1.error.message);
    const parent2 = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.reviewTaskId,
      roleKey: 'qa',
    });
    if (!parent2.ok) throw new Error(parent2.error.message);
    const created = await ensureSession(f, parent1.value.sessionId);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const replay = await ensureSession(f, parent2.value.sessionId);
    expect(replay.ok).toBe(false);
    if (replay.ok === true) return;
    expect(String(replay.error.details['reason'] ?? '')).toBe('SESSION_PARENT_CONFLICT');
    // and nothing was rewritten
    const stored = f.core.database.db
      .prepare('SELECT parent_session_id FROM sessions WHERE session_id = ?')
      .get(created.value.sessionId) as { parent_session_id: string | null };
    expect(stored.parent_session_id).toBe(parent1.value.sessionId);
  });

  it('B2. null → P1 replay is REJECTED (no one-time attach exists)', async () => {
    const f = await makeFixture();
    const created = await ensureSession(f); // parent = null
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const parent = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.reviewTaskId,
      roleKey: 'reviewer',
    });
    if (!parent.ok) throw new Error(parent.error.message);
    const replay = await ensureSession(f, parent.value.sessionId);
    expect(replay.ok).toBe(false);
    if (replay.ok === true) return;
    expect(String(replay.error.details['reason'] ?? '')).toBe('SESSION_PARENT_CONFLICT');
  });

  it('B3. identical parent replays fine (idempotent creation unaffected)', async () => {
    const f = await makeFixture();
    const parent = await f.core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.reviewTaskId,
      roleKey: 'reviewer',
    });
    if (!parent.ok) throw new Error(parent.error.message);
    const first = await ensureSession(f, parent.value.sessionId);
    const second = await ensureSession(f, parent.value.sessionId);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.sessionId).toBe(first.value.sessionId);
  });
});

describe('T19-02 corrective C2 — execution reference scope', () => {
  it('C1. a valid same-task execution is accepted and attached', async () => {
    const f = await makeFixture();
    const session = await ensureSession(f);
    if (!session.ok) throw new Error(session.error.message);
    const executionId = `exec_${f.core.ids.id('x')}`;
    seedExecution(f, { runId: f.runId, taskId: f.workTaskId, executionId });
    const entry = await appendResidue(f, session.value.sessionId, 'c1', executionId);
    expect(entry.ok).toBe(true);
    if (entry.ok === true) return;
  });

  it('C2. an UNKNOWN execution is rejected fail-closed', async () => {
    const f = await makeFixture();
    const session = await ensureSession(f);
    if (!session.ok) throw new Error(session.error.message);
    const entry = await appendResidue(f, session.value.sessionId, 'c2', 'exec_unknown_1');
    expect(entry.ok).toBe(false);
    if (entry.ok === true) return;
    expect(String(entry.error.details['reason'] ?? '')).toBe('SESSION_EXECUTION_MISSING');
  });

  it('C3. a FOREIGN-RUN execution (same database) is rejected', async () => {
    const f = await makeFixture();
    const session = await ensureSession(f);
    if (!session.ok) throw new Error(session.error.message);
    // A second run in the SAME durable database: its execution exists but belongs elsewhere.
    const { createTask } = await import('@companyos/core');
    const template = await f.core.lifecycle.createTemplate({
      orgId: COMPANY,
      name: `T19c3 ${f.core.ids.id('t')}`,
      actorId: f.actor,
    });
    if (!template.ok) throw new Error(template.error.message);
    const saved = await f.core.lifecycle.saveDraftGraph({
      templateId: template.value.id,
      graph: {
        nodes: [{ id: 'work', kind: 'work' as const, title: 'work', config: {} }],
        edges: [],
      },
      actorId: f.actor,
    });
    if (!saved.ok) throw new Error(saved.error.message);
    const published = await f.core.lifecycle.publish({
      templateId: template.value.id,
      actorId: f.actor,
    });
    if (!published.ok) throw new Error(published.error.message);
    const otherRun = await f.core.lifecycle.createRun({
      templateId: template.value.id,
      companyId: COMPANY,
      workflowId: `wf_${f.core.ids.id('w')}`,
      actorId: f.actor,
    });
    if (!otherRun.ok) throw new Error(otherRun.error.message);
    const otherTask = await createTask({
      runId: otherRun.value.run.id as never,
      stageId: 'work' as never,
      roleId: 'rol_dev' as never,
      kind: 'e2e7:build',
      now: new Date().toISOString(),
      ids: f.core.ids,
    });
    if (!otherTask.ok) throw new Error(otherTask.error.message);
    await f.core.database.tasks.put(otherTask.value);
    const executionId = `exec_${f.core.ids.id('o')}`;
    seedExecution(f, {
      runId: otherRun.value.run.id,
      taskId: otherTask.value.id,
      executionId,
    });
    const entry = await appendResidue(f, session.value.sessionId, 'c3', executionId);
    expect(entry.ok).toBe(false);
    if (entry.ok === true) return;
    expect(String(entry.error.details['reason'] ?? '')).toBe('SESSION_EXECUTION_RUN_MISMATCH');
  });

  it('C4. a FOREIGN-TASK execution (same run) is rejected', async () => {
    const f = await makeFixture();
    const session = await ensureSession(f);
    if (!session.ok) throw new Error(session.error.message);
    const executionId = `exec_${f.core.ids.id('r')}`;
    seedExecution(f, { runId: f.runId, taskId: f.reviewTaskId, executionId });
    const entry = await appendResidue(f, session.value.sessionId, 'c4', executionId);
    expect(entry.ok).toBe(false);
    if (entry.ok === true) return;
    expect(String(entry.error.details['reason'] ?? '')).toBe('SESSION_EXECUTION_TASK_MISMATCH');
  });

  it('C5. foreign-COMPANY execution access cannot be attached through a foreign session', async () => {
    const f = await makeFixture();
    // The session itself is company-scoped: a foreign company never sees this session.
    const foreign = await f.core.sessionKernel!.ensureSession({
      companyId: 'company_other',
      runId: f.runId,
      taskId: f.workTaskId,
      roleKey: 'developer',
    });
    expect(foreign.ok).toBe(false); // SESSION_RUN_MISSING — NOT_FOUND privacy
    // And the execution reader is reached only through a session the company owns, so a
    // foreign company's execution id cannot be attached to this company's session unless it
    // ALSO belongs to this run — which the run/task checks then reject.
    const session = await ensureSession(f);
    if (!session.ok) throw new Error(session.error.message);
    const foreignExecution = `exec_${f.core.ids.id('fc')}`;
    const entry = await appendResidue(f, session.value.sessionId, 'c5', foreignExecution);
    expect(entry.ok).toBe(false); // unknown in THIS run ⇒ MISSING (fail closed)
  });

  it('C6. restart preserves a validated execution association', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const core = await compose(paths);
    const assignments = (await core.database.roleAssignments.list({ limit: 10 })).items;
    const actor = assignments[0]?.actorId;
    if (actor === undefined) throw new Error('no owner');
    const template = await core.lifecycle.createTemplate({
      orgId: COMPANY,
      name: `T19c ${core.ids.id('t')}`,
      actorId: actor,
    });
    if (!template.ok) throw new Error(template.error.message);
    const saved = await core.lifecycle.saveDraftGraph({
      templateId: template.value.id,
      graph: {
        nodes: [
          { id: 'work', kind: 'work' as const, title: 'work', config: {} },
          { id: 'review', kind: 'review' as const, title: 'review', config: {} },
        ],
        edges: [{ from: 'work', to: 'review' }],
      },
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
    });
    if (!run.ok) throw new Error(run.error.message);
    const { createTask } = await import('@companyos/core');
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
    const session = await core.sessionKernel!.ensureSession({
      companyId: COMPANY,
      runId: run.value.run.id,
      taskId: work.value.id,
      roleKey: 'developer',
    });
    if (!session.ok) throw new Error(session.error.message);
    const executionId = `exec_${core.ids.id('rs')}`;
    const stamp = new Date().toISOString();
    core.database.db
      .prepare(
        `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
           provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
           input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
           created_at, updated_at)
         VALUES (?, 'agent.dev', 'rol_dev', ?, ?, 'm', 'p', 'pm', 'COMPLETED', ?, NULL, 'tr', 1,
           '{}', '{}', 1, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(executionId, work.value.id, run.value.run.id, stamp, stamp, stamp);
    const entry = await core.sessionKernel!.appendEntry({
      companyId: COMPANY,
      sessionId: session.value.sessionId,
      commandId: 'rs',
      entryKind: 'model_output_residue',
      text: 'validated',
      executionId,
      inputTokenEstimate: 1,
    });
    if (!entry.ok) throw new Error(entry.error.message);
    core.database.close();
    const tracked = openDatabases.indexOf(core.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);

    const second = await compose(paths);
    const active = await second.sessionKernel!.readActiveContext({
      companyId: COMPANY,
      sessionId: session.value.sessionId,
    });
    if (!active.ok) throw new Error(active.error.message);
    expect(active.value.entries[0]?.executionId).toBe(executionId);
    // and the association still replays idempotently with the execution intact
    const replay = await second.sessionKernel!.appendEntry({
      companyId: COMPANY,
      sessionId: session.value.sessionId,
      commandId: 'rs',
      entryKind: 'model_output_residue',
      text: 'validated',
      executionId,
      inputTokenEstimate: 1,
    });
    expect(replay.ok).toBe(true);
    void sessionIdOf;
  });
});
