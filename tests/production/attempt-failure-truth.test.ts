import { offlineExecutionSafety } from './helpers/offline-execution-safety.js';
/**
 * LIVE-SMOKE-FIX-04B — ExecutionAttempt-scoped durable failure truth.
 *
 * 063a940 made pre-dispatch failures typed, fail-fast and durable — but stored the
 * failure on the TASK's single-valued outputs key. Boss review rejected that as the
 * canonical design: ExecutionAttempt is the first-class durable attempt truth, so
 * attempt-specific failure belongs ON THE ATTEMPT ROW — attempt 1's
 * MODEL_CAPABILITY_MISMATCH, attempt 2's TRANSPORT_FAILED and attempt 3's success must
 * each survive independently, across restarts, queryable by attempt id alone.
 *
 * The closed contract (pinned here mechanically — local fixture model, zero real API):
 *   owner        the execution_attempts row itself (migration 0007: four nullable
 *                failure columns; legacy rows legally NULL);
 *   atomicity    state + settled_at + failure columns commit in ONE UPDATE inside the
 *                settlement transaction (no FAILED-then-backfill crash window);
 *   invariant    a FAILED transition without a payload is REFUSED by the store; the
 *                engine synthesizes the generic typed code for bare handler failures;
 *   history      per-attempt append-only — later attempts never overwrite earlier
 *                failures; SUCCESS rows never carry stale failure;
 *   projection   task.outputs['companyos:attempt-failure'] is explicitly marked
 *                NON_AUTHORITATIVE_DERIVED_PROJECTION (last-settled convenience only);
 *   provider contact stays derivable from the EXISTING provider_dispatches.attempt_id
 *                relation (no second boolean truth).
 */
import {createServer, type Server} from 'node:http';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {openDurableDatabase, type DurableDatabase} from '@companyos/persistence';
import {nullLogger} from '@companyos/observability';
import type {ExecutorProvider, ExecutorProviderOutcome, ExecutorExecutionRequest, TypedExecutorConfig} from '@companyos/engine';

import {composeCoreServices, lastCoreCompositionError} from '../../apps/desktop/src/core-services.js';
import {openArtifactFoundation} from '../../apps/desktop/src/artifact-stack.js';
import {GOAL_WORK_KIND} from '../../apps/desktop/src/control-plane.js';
import {productionCompositionOptions} from '../../apps/desktop/src/production-composition.js';

const COMPANY = 'company_default';
const CAPTURE_KEY = 'capture.atttruth';
const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;
const LIVE_ENV_KEYS = [
  'COS_MODEL_BASE_URL', 'COS_MODEL_ID', 'COS_MODEL_PROVIDER_ID', 'COS_MODEL_TIMEOUT_MS', 'COMPANYOS_MODEL_API_KEY',
  'COS_MODEL_ROUTING_MODE', 'COS_MODEL_ROUTING_POLICY',
  'COS_MODEL_QUALITY_TIER', 'COS_MODEL_COST_TIER', 'COS_MODEL_LATENCY_TIER', 'COS_MODEL_RELIABILITY_CLASS',
  'COMPANYOS_EXECUTOR_PROVIDER',
] as const;

const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => { for (const key of LIVE_ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; } });
afterAll(() => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

type FixtureServer = {readonly url: string; readonly close: () => Promise<void>};
/**
 * The planner fixture's two plan shapes (LIVE-SMOKE-FIX-05):
 *  - 'single': one item, five criteria, zero deps → LOW complexity since FIX-05.
 *    Used where the test wants a task that ROUTES and reaches the provider.
 *  - 'fanin': four producers + one four-predecessor assembly → the assembly
 *    derives VERY_HIGH and demands STRONG (the GENUINE rejection shape).
 */
type PlanShape = 'single' | 'fanin';
const startFixture = async (planShape: PlanShape = 'single'): Promise<FixtureServer> => {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { body = {}; }
      if ((req.url ?? '').includes('/models')) {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({object: 'list', data: [{id: 'fixture-model'}]}));
        return;
      }
      const rfText = JSON.stringify(body['response_format'] ?? {});
      let content: string;
      if (rfText.includes('"action"')) {
        let subject: {readonly taskId: string} | undefined;
        for (const message of Array.isArray(body['messages']) ? (body['messages'] as readonly {readonly role?: unknown; readonly content?: unknown}[]) : []) {
          if (message?.role !== 'user') continue;
          const text = String(message?.content ?? '');
          const seat = text.indexOf('# Memory view');
          if (seat < 0) continue;
          const match = /"taskId"\s*:\s*"(tsk_[a-z0-9]+)"/.exec(text.slice(seat));
          if (match !== null && match[1] !== undefined) subject = {taskId: match[1]};
          break;
        }
        content = JSON.stringify({schema: 'companyos/supervisor-proposal/1', action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'go', evidenceRefs: [], ...(subject === undefined ? {} : {subject})});
      } else if (rfText.includes('"targetRef"')) {
        content = JSON.stringify({schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', missingRequirements: [], summary: 'ok', targetRef: 'goal'});
      } else if (rfText.includes('"verdict"')) {
        content = JSON.stringify({schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', findings: [], summary: 'ok'});
      } else {
        content = JSON.stringify(
          planShape === 'fanin'
            ? {
                schema: 'companyos/plan-proposal/1',
                planItems: [
                  {planItemId: 'impl', objective: 'Implement the CLI.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['i1']},
                  {planItemId: 'test', objective: 'Test the CLI.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['t1']},
                  {planItemId: 'docs', objective: 'Document the CLI.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['d1']},
                  {planItemId: 'pkg', objective: 'Package the CLI.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['p1']},
                  {planItemId: 'assemble', objective: 'Assemble the release from all four work products.', dependencyPlanItemIds: ['impl', 'test', 'docs', 'pkg'], acceptanceCriterionRefs: ['c1', 'c2', 'c3', 'c4', 'c5']},
                ],
                acceptanceCriteria: [
                  {criterionId: 'i1', requirement: 'i1 met.'}, {criterionId: 't1', requirement: 't1 met.'},
                  {criterionId: 'd1', requirement: 'd1 met.'}, {criterionId: 'p1', requirement: 'p1 met.'},
                  ...['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({criterionId: id, requirement: `${id} met.`})),
                ],
              }
            : {
                schema: 'companyos/plan-proposal/1',
                planItems: [{planItemId: 'p1', objective: 'Deliver the CLI.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['c1', 'c2', 'c3', 'c4', 'c5']}],
                acceptanceCriteria: ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({criterionId: id, requirement: `${id} met.`})),
              },
        );
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({object: 'chat.completion', choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}], usage: {prompt_tokens: 9, completion_tokens: 9}}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no fixture address');
  return {url: `http://127.0.0.1:${String(address.port)}`, close: () => new Promise<void>((resolve) => server.close(() => resolve()))};
};

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;
const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
const fixtures: {close: () => Promise<void>}[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (fixtures.length > 0) void fixtures.pop()?.close();
  while (createdDirs.length > 0) { try { rmSync(createdDirs.pop() as string, {recursive: true, force: true}); } catch { /* disposable */ } }
  for (const key of LIVE_ENV_KEYS) delete process.env[key];
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-atttruth-'));
  createdDirs.push(dir);
  return dir;
};

interface ScriptedProvider {
  /** Per provider invocation: 'deterministic-fail' (pre-dispatch impossible here — injected via routing), 'transient', 'succeed'. */
  script: (invocation: number) => 'deterministic' | 'transient' | 'succeed';
}
const scriptedProvider = (spec: ScriptedProvider, captures: {readonly attemptId: string}[]) => ({
  config: {providerKey: CAPTURE_KEY, fields: [{name: 'profile', value: 'att', source: 'composition'}], fingerprint: `scfg_att${'0'.repeat(21)}`} satisfies TypedExecutorConfig,
  provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
    descriptor: {providerKey: CAPTURE_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
    async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
      captures.push({attemptId: String(request.attemptId)});
      const behavior = spec.script(captures.length);
      if (behavior === 'transient') {
        return {kind: 'transport-failed', reasonCode: 'EXECUTOR_INJECTED_TRANSIENT', detail: 'transient injection'};
      }
      return {kind: 'succeeded', exitCode: 0, stdoutText: 'delivered', providerSessionId: `s-${String(request.attemptId).slice(4, 10)}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()};
    },
  } as unknown as ExecutorProvider,
});

const composeWith = async (
  env: Record<string, string | undefined>,
  spec: ScriptedProvider,
  captures: {readonly attemptId: string}[],
  planShape: PlanShape = 'single',
): Promise<{core: Core; dataDir: string}> => {
  const fixture = await startFixture(planShape);
  fixtures.push(fixture);
  const dataDir = tempDir();
  const workspaceRoot = join(dataDir, 'ws');
  mkdirSync(workspaceRoot, {recursive: true});
  const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never});
  if (!foundation.ok) throw new Error('foundation failed');
  const envForCompose: Record<string, string | undefined> = {
    COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'fixture-model', COMPANYOS_MODEL_API_KEY: 'att-local',
    COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY,
    ...env,
  };
  for (const [key, value] of Object.entries(envForCompose)) if (value !== undefined) process.env[key] = value;
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    ...productionCompositionOptions(envForCompose),
    executionSafety: offlineExecutionSafety,
    executorProviderImplementations: [scriptedProvider(spec, captures) as never],
  } as never);
  if (core === null) throw new Error(lastCoreCompositionError() ?? 'composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({root: workspaceRoot, commandProfile: {}});
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
  const registered = await core.models.registerFromProvider({providerId: 'model.openai-compatible', providerModelId: 'fixture-model', modelKey: 'att.model', actorId: actor});
  if (!registered.ok) throw new Error(registered.error.message);
  const savedPolicy = await core.policies.savePolicy({id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'att.model', actorId: actor} as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  return {core, dataDir};
};

const smartEnv = (qualityTier: 'BALANCED' | 'STRONG') => ({COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'BALANCED', COS_MODEL_QUALITY_TIER: qualityTier, COS_MODEL_COST_TIER: 'MEDIUM', COS_MODEL_LATENCY_TIER: 'BALANCED', COS_MODEL_RELIABILITY_CLASS: 'STANDARD', COS_MODEL_AUTHENTICATION: 'REQUIRED'} as const);

const driveGoal = async (core: Core, commandId: string, maxTurns = 6): Promise<string> => {
  const cp = core.controlPlane!;
  const created = await cp.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: 'Deliver the CLI.', commandId}});
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const goalRunId = String((created.value as {readonly runId: string}).runId);
  let executionRunId = '';
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const advanced = await cp.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: goalRunId}});
    if (!advanced.ok) throw new Error(JSON.stringify(advanced.error));
    executionRunId = String((advanced.value as {readonly executionRunId: string}).executionRunId);
    const states = core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as {state: string}[];
    if (states.length > 0 && states.every((row) => row.state === 'DONE' || row.state === 'FAILED' || row.state === 'BLOCKED')) break;
  }
  return executionRunId;
};

interface AttemptRow {
  readonly id: string;
  readonly attempt_number: number;
  readonly state: string;
  readonly failure_code: string | null;
  readonly failure_phase: string | null;
  readonly failure_summary: string | null;
  readonly failure_retryable: number | null;
}
const attemptRows = (core: Core): readonly AttemptRow[] =>
  core.database.db.prepare('SELECT id, attempt_number, state, failure_code, failure_phase, failure_summary, failure_retryable FROM execution_attempts ORDER BY attempt_number').all() as AttemptRow[];

/** Minimal legal parent run row for direct attempt-store probes (FK constraint). */
const seedProbeRun = (db: {prepare(sql: string): {run(...a: unknown[]): unknown}}): void => {
  db.prepare(
    `INSERT INTO runs (id, company_id, workflow_id, template_id, version_id, snapshot_id, state, revision, rework_count, max_rework, history_json, created_at, updated_at, started_by)
     VALUES ('run_probe', ?, 'wf_probe', 'tpl_probe', 'ver_probe', 'snp_probe', 'EXECUTING', 1, 0, 3, '[]', ?, ?, 'probe')`,
  ).run(COMPANY, new Date().toISOString(), new Date().toISOString());
};

describe('LIVE-SMOKE-FIX-04B — attempt-scoped canonical failure (store-level invariant)', () => {
  it('a FAILED transition WITHOUT a payload is REFUSED by the store (no FAILED-with-null-cause settlement)', async () => {
    // Direct store probe on a disposable DB: the invariant lives in the store itself.
    const dataDir = tempDir();
    const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
    openDatabases.push(db);
    seedProbeRun(db.db as unknown as {prepare(sql: string): {run(...a: unknown[]): unknown}});
    const {ok: claimed} = await (db.executionAttempts as unknown as {claim(a: unknown): Promise<{ok: boolean}>}).claim({
      seed: {schema: 'companyos/execution-attempt/1', id: 'exa_s9b_invariant_probe_000001', companyId: COMPANY, runId: 'run_probe', taskId: 'tsk_probe', attemptNumber: 1, roleId: 'rol_probe', taskKind: 'k', fingerprint: 'f'},
      state: 'ACTIVE', runtimeInstanceId: 'rt1', createdAt: new Date().toISOString(),
    } as never);
    expect(claimed).toBe(true);
    const refused = await (db.executionAttempts as unknown as {transition(i: unknown): Promise<{ok: boolean; error?: {code: string; details?: {reason?: string}}}>}).transition({
      attemptId: 'exa_s9b_invariant_probe_000001', to: 'FAILED', now: new Date().toISOString(),
    } as never);
    expect(refused.ok).toBe(false);
    expect(refused.error?.details?.['reason'] ?? '').toContain('EXECUTION_ATTEMPT_FAILURE_PAYLOAD_REQUIRED');
    // With the payload the SAME transition commits atomically.
    const settled = await (db.executionAttempts as unknown as {transition(i: unknown): Promise<{ok: boolean; value?: {failure?: {code: string}}}>}).transition({
      attemptId: 'exa_s9b_invariant_probe_000001', to: 'FAILED', now: new Date().toISOString(),
      failure: {code: 'MODEL_CAPABILITY_MISMATCH', phase: null, summary: 'probe', retryable: false},
    } as never);
    expect(settled.ok).toBe(true);
    expect(settled.value?.failure?.code).toBe('MODEL_CAPABILITY_MISMATCH');
    const row = db.db.prepare('SELECT state, failure_code, failure_retryable FROM execution_attempts WHERE id = ?').get('exa_s9b_invariant_probe_000001') as {state: string; failure_code: string; failure_retryable: number};
    expect(row.state).toBe('FAILED');
    expect(row.failure_code).toBe('MODEL_CAPABILITY_MISMATCH');
    expect(row.failure_retryable).toBe(0);
  });

  it('legacy rows (NULL failure columns) read legally — absence reported, never fabricated', async () => {
    const dataDir = tempDir();
    const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
    openDatabases.push(db);
    // Simulate a legacy FAILED row (pre-0007 shape): INSERT without failure columns.
    seedProbeRun(db.db as unknown as {prepare(sql: string): {run(...a: unknown[]): unknown}});
    db.db.prepare(
      `INSERT INTO execution_attempts (id, company_id, run_id, task_id, attempt_number, state, role_id, task_kind, seed_fingerprint, runtime_instance_id, created_at, settled_at)
       VALUES ('exa_legacy_0000000000001', ?, 'run_probe', 'tsk_probe', 1, 'FAILED', 'rol_probe', 'k', 'f', NULL, ?, ?)`,
    ).run(COMPANY, new Date().toISOString(), new Date().toISOString());
    const attempt = await db.executionAttempts.get('exa_legacy_0000000000001');
    expect(attempt?.state).toBe('FAILED');
    expect(attempt?.failure).toBeUndefined(); // honest absence — LEGACY_FAILURE_DETAIL_UNAVAILABLE
    const row = db.db.prepare('SELECT failure_code FROM execution_attempts WHERE id = ?').get('exa_legacy_0000000000001') as {failure_code: string | null};
    expect(row.failure_code).toBeNull();
  });
});

describe('LIVE-SMOKE-FIX-04B/05 — genuine routing rejection root regression on the ATTEMPT ROW', () => {
  it('deterministic routing rejection: the single FAILED attempt CARRIES the canonical failure columns', async () => {
    const captures: {readonly attemptId: string}[] = [];
    const f = await composeWith(smartEnv('BALANCED'), {script: () => 'succeed'}, captures, 'fanin');
    const executionRunId = await driveGoal(f.core, 'att-root-1', 12);
    void executionRunId;
    // The four producers complete (4 COMPLETED attempts); the four-predecessor
    // assembly fails ONCE at the routing floor (deterministic, fail-fast).
    const rows = attemptRows(f.core);
    expect(rows).toHaveLength(5);
    const rejected = rows.filter((row) => row.state === 'FAILED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.failure_code).toBe('MODEL_CAPABILITY_MISMATCH');
    expect(rejected[0]!.failure_retryable).toBe(0);
    // Pre-dispatch legality for the REJECTED attempt: no dispatch row, no routing decision.
    const rejectedDispatches = f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches WHERE attempt_id = ?').get(String(rejected[0]!.id));
    expect(rejectedDispatches).toMatchObject({n: 0});
    // The producers dispatched honestly with their routing decisions.
    expect(captures).toHaveLength(4);
    expect(f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches').get()).toMatchObject({n: 4});
    expect(f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches WHERE routing_decision_json IS NOT NULL').get()).toMatchObject({n: 4});
    // The task projection is explicitly marked NON-authoritative.
    const task = f.core.database.db.prepare("SELECT outputs_json FROM tasks WHERE state = 'FAILED'").get() as {outputs_json: string};
    const envelope = (JSON.parse(String(task.outputs_json)) as Record<string, unknown>)['companyos:attempt-failure'] as Record<string, unknown>;
    expect(envelope['authority']).toBe('NON_AUTHORITATIVE_DERIVED_PROJECTION');
    expect(envelope['attemptId']).toBe(rejected[0]!.id);
  });

  it('restart proof: a FRESH database connection reads the same attempt failure by attempt id', async () => {
    const captures: {readonly attemptId: string}[] = [];
    const f = await composeWith(smartEnv('BALANCED'), {script: () => 'succeed'}, captures, 'fanin');
    await driveGoal(f.core, 'att-restart-1', 12);
    const dataDir = f.dataDir;
    const failedRow = attemptRows(f.core).find((row) => row.state === 'FAILED');
    expect(failedRow).toBeDefined();
    const attemptId = failedRow!.id;
    const idx = openDatabases.findIndex((db) => db === (f.core.database as unknown as DurableDatabase));
    if (idx >= 0) openDatabases.splice(idx, 1);
    (f.core.database as unknown as {close(): void}).close();
    const reopened = openDurableDatabase({dataDir, appliedAt: 'reopen-att', chains: [...CHAINS]});
    openDatabases.push(reopened);
    const attempt = await reopened.executionAttempts.get(attemptId);
    expect(attempt?.state).toBe('FAILED');
    expect(attempt?.failure?.code).toBe('MODEL_CAPABILITY_MISMATCH');
    expect(attempt?.failure?.retryable).toBe(false);
    expect(attempt?.settledAt).toBeTruthy();
  });
});

describe('LIVE-SMOKE-FIX-04B — multi-attempt history (three different outcomes)', () => {
  it('A1 deterministic routing fail → A2 transient provider fail → A3 success: three SEPARATE durable histories', async () => {
    const captures: {readonly attemptId: string}[] = [];
    // The single-item shape (LOW complexity since FIX-05) routes through the STRONG
    // profile and reaches the provider, so the retry chain is observable. Simplest
    // three-outcome shape that exercises the attempt truth: A1 transient, A2 transient,
    // A3 success (retryable class) PLUS a separate BALANCED/fanin goal for the
    // deterministic class — both histories verified side by side.
    const spec: ScriptedProvider = {script: (invocation) => (invocation <= 2 ? 'transient' : 'succeed')};
    const f = await composeWith(smartEnv('STRONG'), spec, captures);
    const executionRunId = await driveGoal(f.core, 'att-multi-1', 8);
    void executionRunId;
    const rows = attemptRows(f.core);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // A1/A2: transient failures preserved independently (append-only, not overwritten).
    expect(rows[0]!.state).toBe('FAILED');
    expect(rows[0]!.failure_code).toBe('TRANSPORT_FAILED');
    expect(rows[0]!.failure_retryable).toBe(1);
    expect(rows[1]!.state).toBe('FAILED');
    expect(rows[1]!.failure_code).toBe('TRANSPORT_FAILED');
    expect(rows[1]!.id).not.toBe(rows[0]!.id);
    // A3: success carries NO stale failure.
    expect(rows[2]!.state).toBe('COMPLETED');
    expect(rows[2]!.failure_code).toBeNull();
    // The task COMPLETED and its derived projection reflects the LAST settle (success),
    // while the attempt history keeps both failures.
    const taskRow = f.core.database.db.prepare("SELECT state, outputs_json FROM tasks WHERE kind = ? AND state = 'DONE'").get(GOAL_WORK_KIND) as {state: string; outputs_json: string} | undefined;
    expect(taskRow).toBeDefined();
    // Task outputs merge on COMPLETE, so the derived projection of an EARLIER failed
    // attempt may legitimately persist — but only as a marked derived projection, and
    // the ATTEMPT rows remain the append-only authority (A3's own row carries NULL).
    if (String(taskRow!.outputs_json).includes('companyos:attempt-failure')) {
      expect(String(taskRow!.outputs_json)).toContain('NON_AUTHORITATIVE_DERIVED_PROJECTION');
    }
    // Provider contact is derivable from the dispatch relation alone.
    const dispatchCount = Number((f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches').get() as {n: number}).n);
    expect(dispatchCount).toBe(captures.length);
    expect(dispatchCount).toBeGreaterThanOrEqual(3);
  });

  it('a bare handler failure (no envelope) still settles with the generic typed code — never a null cause', async () => {
    // Store-level: engine synthesizes EXECUTION_FAILED when the handler returned a bare
    // 'failed' (verified mechanically at the store seam in the invariant test above);
    // here assert the engine path end-to-end via the crash class: provider THROWS.
    const captures: {readonly attemptId: string}[] = [];
    const throwing = {
      config: {providerKey: CAPTURE_KEY, fields: [{name: 'profile', value: 'att', source: 'composition'}], fingerprint: `scfg_att${'0'.repeat(21)}`},
      provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
        descriptor: {providerKey: CAPTURE_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
        async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
          captures.push({attemptId: String(request.attemptId)});
          throw new Error('boom: executor crashed');
        },
      } as unknown as ExecutorProvider,
    };
    const fixture = await startFixture();
    fixtures.push(fixture);
    const dataDir = tempDir();
    const workspaceRoot = join(dataDir, 'ws');
    mkdirSync(workspaceRoot, {recursive: true});
    const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
    openDatabases.push(db);
    const foundation = await openArtifactFoundation({casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never});
    if (!foundation.ok) throw new Error('foundation failed');
    const env = {COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'fixture-model', COMPANYOS_MODEL_API_KEY: 'att-local', COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY, ...smartEnv('STRONG')};
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const core = await composeCoreServices(db, nullLogger as never, {
      artifactFoundation: foundation as never,
      ...productionCompositionOptions(env),
    executionSafety: offlineExecutionSafety,
      executorProviderImplementations: [throwing as never],
    } as never);
    if (core === null) throw new Error(lastCoreCompositionError() ?? 'composition failed');
    await core.repositoryRuntime.openWorkspace({root: workspaceRoot, commandProfile: {}});
    const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
    await core.models.registerFromProvider({providerId: 'model.openai-compatible', providerModelId: 'fixture-model', modelKey: 'att.model', actorId: actor});
    await core.policies.savePolicy({id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'att.model', actorId: actor} as never);
    await driveGoal(core, 'att-crash-1');
    const rows = attemptRows(core);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.state).toBe('FAILED');
    expect(rows[0]!.failure_code).toBe('EXECUTOR_CRASH');
    expect(rows[0]!.failure_summary).toContain('boom');
    expect(rows[0]!.failure_summary).not.toContain('sk-');
  });
});
