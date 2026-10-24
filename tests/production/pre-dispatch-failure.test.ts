import { offlineExecutionSafety } from './helpers/offline-execution-safety.js';
/**
 * LIVE-SMOKE-FIX-04 — pre-dispatch failure truth integrity + stage receipt semantics.
 *
 * Smoke-04 forensics (all confirmed by deterministic reproduction): the work task's
 * three attempts each failed in ~0s at the ROUTING phase — the router's complexity
 * floor rejected the ONLY profile (a multi-criteria work item derived HIGH/VERY_HIGH
 * complexity, demanding STRONG, while the operator declared BALANCED) — and THREE
 * product defects compounded it:
 *
 *   1. TRUTH LOSS: settleExecutionAttempt was called with failureMessage undefined and
 *      dropped even passed messages (only `runtimeInstanceId: null` was used) — a
 *      terminal FAILED claim had NO durable cause.
 *   2. RETRY BURN: the deterministic, non-retryable routing failure consumed all 3
 *      attempts (identical failure, zero provider contact).
 *   3. RECEIPT CONTRADICTION: after a retryable FAIL+RETRY the stage loop fell through
 *      to outcome 'completed', so the supervisor wrote `stage:<id>:completed` receipts
 *      for FAILED work.
 *
 * Closed contract (pinned here mechanically — deterministic, local fixture model,
 * zero real API): a handler may attach a typed `failure` envelope to a failed result;
 * the engine persists it on the task's canonical outputs (`companyos:attempt-failure`:
 * failureCode/failureStage/retryable/attemptNumber/attemptId/failedAt — restart-readable,
 * sanitized identifiers only); deterministic failures (retryable false) settle FAILED
 * without the automatic RETRY (one attempt, fail fast); retryable failures keep the
 * existing RETRY semantics and the stage outcome is 'blocked' — the supervisor's receipt
 * reads `:blocked`, never `:completed`, for work that has not succeeded.
 *
 * LIVE-SMOKE-FIX-05: the root fixture is now GENUINE routing difficulty — an assembly
 * item integrating FOUR prerequisite producer stages derives VERY_HIGH complexity
 * (canonical DAG fan-in) and honestly demands STRONG. The Smoke-04 presentation shape
 * (one item, five acceptance criteria, zero dependencies) now derives LOW and routes
 * BALANCED-eligible — that invariance is pinned in plan-shape-complexity.test.ts.
 */
import {createServer, type Server} from 'node:http';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
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
const CAPTURE_KEY = 'capture.pretruth';
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
 * The planner fixture's two deterministic plan shapes:
 *  - 'single': the Smoke-04 PRESENTATION shape (one item, FIVE acceptance criteria,
 *    zero dependencies). Since FIX-05 this derives LOW complexity — criteria count is
 *    validation detail, not difficulty — so it routes BALANCED-eligible and the
 *    dispatch phases (executor faults, transport retry, success) become reachable.
 *  - 'fanin': GENUINE difficulty (FIX-05 §20) — four independent producers plus one
 *    assembly item integrating all four. The assembly derives VERY_HIGH (canonical
 *    DAG fan-in 4) and honestly demands STRONG; a BALANCED-only pool is rejected at
 *    the complexity floor.
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
        // The deterministic planner answer for this fixture's plan shape.
        const plan =
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
                // ONE work item with MANY acceptance criteria: the exact Smoke-04 shape.
                // Since FIX-05 this presentation alone derives LOW (criteria are
                // validation detail) — the invariance is asserted in plan-shape-complexity.
                schema: 'companyos/plan-proposal/1',
                planItems: [{planItemId: 'p1', objective: 'Deliver the CLI.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['c1', 'c2', 'c3', 'c4', 'c5']}],
                acceptanceCriteria: ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({criterionId: id, requirement: `${id} met.`})),
              };
        content = JSON.stringify(plan);
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
  const dir = mkdtempSync(join(tmpdir(), 'companyos-pretruth-'));
  createdDirs.push(dir);
  return dir;
};

interface ComposeOptions {
  /** failWhenDispatched: the capture provider FAILS once it is actually invoked (retryable class). */
  readonly providerOutcome?: 'succeed' | 'transport-failed';
  /** open the workspace (default true; false injects the untrusted-workspace fault). */
  readonly openWorkspace?: boolean;
  /** route the work kind at a NONEXISTENT executor provider key. */
  readonly unknownExecutor?: boolean;
  /** the planner fixture's plan shape (default 'single'). */
  readonly plan?: PlanShape;
}

const composeWith = async (
  env: Record<string, string | undefined>,
  options: ComposeOptions = {},
): Promise<{core: Core; captures: {readonly request: ExecutorExecutionRequest}[]; workspaceRoot: string; dataDir: string}> => {
  const fixture = await startFixture(options.plan ?? 'single');
  fixtures.push(fixture);
  const dataDir = tempDir();
  const workspaceRoot = join(dataDir, 'ws');
  mkdirSync(workspaceRoot, {recursive: true});
  const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never});
  if (!foundation.ok) throw new Error('foundation failed');
  const captures: {readonly request: ExecutorExecutionRequest}[] = [];
  const executor = {
    config: {providerKey: CAPTURE_KEY, fields: [{name: 'profile', value: 'pt', source: 'composition'}], fingerprint: `scfg_pt${'0'.repeat(21)}`} satisfies TypedExecutorConfig,
    provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
      descriptor: {providerKey: CAPTURE_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
      async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
        captures.push({request});
        if (options.providerOutcome === 'transport-failed') {
          return {kind: 'transport-failed', reasonCode: 'EXECUTOR_INJECTED_TRANSIENT', detail: 'deterministic transient injection'};
        }
        return {kind: 'succeeded', exitCode: 0, stdoutText: 'delivered', providerSessionId: `s-${String(request.attemptId).slice(4, 10)}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()};
      },
    } as unknown as ExecutorProvider,
  };
  const envForCompose: Record<string, string | undefined> = {
    COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'fixture-model', COMPANYOS_MODEL_API_KEY: 'pt-local',
    COMPANYOS_EXECUTOR_PROVIDER: options.unknownExecutor === true ? 'no.such.executor' : CAPTURE_KEY,
    ...env,
  };
  for (const [key, value] of Object.entries(envForCompose)) if (value !== undefined) process.env[key] = value;
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    ...productionCompositionOptions(envForCompose),
    executionSafety: offlineExecutionSafety,
    executorProviderImplementations: [executor as never],
  } as never);
  if (core === null) throw new Error(lastCoreCompositionError() ?? 'composition failed');
  if (options.openWorkspace !== false) {
    const opened = await core.repositoryRuntime.openWorkspace({root: workspaceRoot, commandProfile: {}});
    if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  }
  const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
  const registered = await core.models.registerFromProvider({providerId: 'model.openai-compatible', providerModelId: 'fixture-model', modelKey: 'pt.model', actorId: actor});
  if (!registered.ok) throw new Error(registered.error.message);
  const savedPolicy = await core.policies.savePolicy({id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'pt.model', actorId: actor} as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  return {core, captures, workspaceRoot, dataDir};
};

const smartEnv = {COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'BALANCED', COS_MODEL_QUALITY_TIER: 'BALANCED', COS_MODEL_COST_TIER: 'MEDIUM', COS_MODEL_LATENCY_TIER: 'BALANCED', COS_MODEL_RELIABILITY_CLASS: 'STANDARD', COS_MODEL_AUTHENTICATION: 'REQUIRED'} as const;

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

const receiptEffectsOf = (core: Core, casRoot: string): readonly string[] => {
  const rows = core.database.db.prepare("SELECT content_ref FROM artifacts WHERE kind = 'companyos:supervisor-application' ORDER BY created_at").all() as {content_ref: string}[];
  const effects: string[] = [];
  for (const row of rows) {
    const ref = String(row.content_ref).replace('sha256:', '');
    const file = join(casRoot, ref.slice(0, 2), ref);
    if (!existsSync(file)) continue;
    const content = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    effects.push(String(content['effect'] ?? ''));
  }
  return effects;
};

const failedWorkTasks = (core: Core): {id: string; state: string; stageId: string; outputs: Record<string, unknown>}[] =>
  (core.database.db.prepare("SELECT id, state, stage_id, outputs_json FROM tasks WHERE kind = ? AND state = 'FAILED'").all(GOAL_WORK_KIND) as {id: string; state: string; stage_id: string; outputs_json: string}[])
    .map((row) => ({id: String(row.id), state: row.state, stageId: String(row.stage_id), outputs: JSON.parse(String(row.outputs_json ?? '{}')) as Record<string, unknown>}));

describe('LIVE-SMOKE-FIX-04/05 — genuine routing rejection root branch (canonical DAG fan-in demands STRONG)', () => {
  it('deterministic routing rejection: ONE attempt, FAILED, DURABLE typed cause on the task AND the attempt row, zero dispatch rows for the rejected task, honest dispatches for its four producers', async () => {
    const f = await composeWith({...smartEnv}, {plan: 'fanin'});
    const executionRunId = await driveGoal(f.core, 'pt-root-1', 12);
    expect(executionRunId).toMatch(/^run_/);
    // Exactly ONE task fails — the four-predecessor assembly item (VERY_HIGH → STRONG floor
    // → the only BALANCED profile is rejected). Its four producers dispatch and succeed.
    const failed = failedWorkTasks(f.core);
    expect(failed).toHaveLength(1);
    const rejected = failed[0]!;
    const envelope = rejected.outputs['companyos:attempt-failure'] as Record<string, unknown>;
    expect(envelope).toBeDefined();
    expect(envelope['failureCode']).toBe('MODEL_CAPABILITY_MISMATCH');
    expect(envelope['retryable']).toBe(false);
    expect(envelope['attemptNumber']).toBe(1);
    expect(typeof envelope['attemptId']).toBe('string');
    expect(typeof envelope['failedAt']).toBe('string');
    // FIX-04B truth: the durable cause lives on the ExecutionAttempt row itself.
    const attempts = f.core.database.db.prepare('SELECT id, state, failure_code, failure_retryable FROM execution_attempts WHERE task_id = ?').all(String(rejected.id)) as {id: string; state: string; failure_code: string | null; failure_retryable: number | null}[];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.state).toBe('FAILED');
    expect(attempts[0]!.failure_code).toBe('MODEL_CAPABILITY_MISMATCH');
    expect(attempts[0]!.failure_retryable).toBe(0);
    // No fake evidence for the REJECTED task: routing failed before any decision or
    // dispatch — the provider was never contacted FOR THIS TASK.
    const rejectedDispatches = f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches WHERE attempt_id = ?').get(String(attempts[0]!.id));
    expect(rejectedDispatches).toMatchObject({n: 0});
    // Its producers dispatched honestly (4 work products, each with its routing decision).
    expect(f.captures.length).toBeGreaterThanOrEqual(4);
    const dispatchCount = Number((f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches').get() as {n: number}).n);
    expect(dispatchCount).toBe(f.captures.length);
    const routedCount = Number((f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches WHERE routing_decision_json IS NOT NULL').get() as {n: number}).n);
    expect(routedCount).toBe(f.captures.length);
    // No success receipt exists for the REJECTED stage (the Smoke-04 contradiction):
    // its receipts never read `stage:<id>:completed`. The producers' completions are theirs.
    // (Stage ids are `stg_<hex>` — plain suffix comparison, no pattern matching.)
    const effects = receiptEffectsOf(f.core, `${f.dataDir}-cas`);
    for (const effect of effects) expect(effect.endsWith(`:${rejected.stageId}:completed`)).toBe(false);
  });

  it('restart readability: a FRESH database connection reads the same typed cause (no memory/console archaeology)', async () => {
    const f = await composeWith({...smartEnv}, {plan: 'fanin'});
    await driveGoal(f.core, 'pt-root-2', 12);
    const dataDir = f.dataDir;
    // Close the harness connection; reopen read-only from disk.
    const idx = openDatabases.findIndex((db) => db === (f.core.database as unknown as DurableDatabase));
    if (idx >= 0) openDatabases.splice(idx, 1);
    (f.core.database as unknown as {close(): void}).close();
    const reopened = openDurableDatabase({dataDir, appliedAt: 'reopen-probe', chains: [...CHAINS]});
    openDatabases.push(reopened);
    const rows = reopened.db.prepare("SELECT outputs_json FROM tasks WHERE state = 'FAILED' AND outputs_json LIKE '%companyos:attempt-failure%'").all() as {outputs_json: string}[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const envelope = (JSON.parse(String(rows[0]!.outputs_json)) as Record<string, unknown>)['companyos:attempt-failure'] as Record<string, unknown>;
    expect(envelope['failureCode']).toBe('MODEL_CAPABILITY_MISMATCH');
    // The attempt row's own durable cause survives the restart too (FIX-04B).
    const attemptRows = reopened.db.prepare("SELECT failure_code, failure_retryable FROM execution_attempts WHERE state = 'FAILED' AND failure_code IS NOT NULL").all() as {failure_code: string; failure_retryable: number}[];
    expect(attemptRows.length).toBeGreaterThanOrEqual(1);
    expect(attemptRows[0]!.failure_code).toBe('MODEL_CAPABILITY_MISMATCH');
    expect(attemptRows[0]!.failure_retryable).toBe(0);
  });
});

describe('LIVE-SMOKE-FIX-04 — pre-dispatch fault injections (each leaves durable typed truth)', () => {
  it('unknown executor provider: typed EXECUTOR_PROVIDER_UNKNOWN durable, one attempt, zero provider calls', async () => {
    const f = await composeWith({...smartEnv}, {unknownExecutor: true});
    await driveGoal(f.core, 'pt-provider-1');
    const failed = failedWorkTasks(f.core);
    expect(failed).toHaveLength(1);
    const envelope = failed[0]!.outputs['companyos:attempt-failure'] as Record<string, unknown>;
    expect(envelope['failureCode']).toBe('EXECUTOR_PROVIDER_UNKNOWN');
    expect(envelope['retryable']).toBe(false);
    const attempts = f.core.database.db.prepare("SELECT COUNT(*) AS n FROM execution_attempts WHERE state = 'FAILED'").get();
    expect(attempts).toMatchObject({n: 1});
    expect(f.captures).toHaveLength(0);
  });

  it('untrusted workspace (never opened): the GOAL.CREATE refuses typed GOAL_WORKSPACE_NOT_OPEN — an even earlier fail-closed', async () => {
    const f = await composeWith({...smartEnv}, {openWorkspace: false});
    // F4: without a trusted workspace the GOAL.CREATE itself now refuses (typed
    // GOAL_WORKSPACE_NOT_OPEN) — no goal, no work, no dispatch, no provider side effect.
    await expect(driveGoal(f.core, 'pt-ws-1')).rejects.toThrow(/GOAL_WORKSPACE_NOT_OPEN/);
    const failed = failedWorkTasks(f.core);
    expect(failed).toHaveLength(0);
    expect(f.captures).toHaveLength(0);
    expect(f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches').get()).toMatchObject({n: 0});
  });
});

describe('LIVE-SMOKE-FIX-04 — retryable provider failure semantics + stage receipt truth', () => {
  it('a provider transport failure keeps RETRY semantics: the receipt reads :blocked, never :completed, and no success receipt exists for unsettled work', async () => {
    const f = await composeWith({...smartEnv, COS_MODEL_QUALITY_TIER: 'STRONG'}, {providerOutcome: 'transport-failed'});
    await driveGoal(f.core, 'pt-retry-1');
    // The provider WAS contacted (a dispatch row exists — honest, not fake).
    expect(f.captures.length).toBeGreaterThanOrEqual(1);
    const dispatchCount = Number((f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches').get() as {n: number}).n);
    expect(dispatchCount).toBe(f.captures.length);
    // Receipts for this run never claim business completion of unsettled work.
    const effects = receiptEffectsOf(f.core, `${f.dataDir}-cas`);
    for (const effect of effects) expect(effect).not.toMatch(/:completed$/u);
  });
});

describe('LIVE-SMOKE-FIX-04 — success control (the normal claim → routing → dispatch → provider path)', () => {
  it('a STRONG-quality profile satisfies the complexity floor and the work COMPLETES with a :completed receipt', async () => {
    const f = await composeWith({...smartEnv, COS_MODEL_QUALITY_TIER: 'STRONG'});
    const executionRunId = await driveGoal(f.core, 'pt-ok-1');
    const states = f.core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as {state: string}[];
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states.every((row) => row.state === 'DONE')).toBe(true);
    expect(f.captures.length).toBeGreaterThanOrEqual(1);
    // The provider request carried the resolved CompanyOS timeout + selected route.
    expect(f.captures[0]!.request.timeoutMs).toBe(600_000);
    expect(f.captures[0]!.request.selectedModelRoute?.modelProfileId).toBe('env:fixture-model');
    const routing = f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches WHERE routing_decision_json IS NOT NULL').get();
    expect(routing).toMatchObject({n: f.captures.length});
    // Success work earns its :completed receipt.
    const effects = receiptEffectsOf(f.core, `${f.dataDir}-cas`);
    expect(effects.some((effect) => effect.endsWith(':completed'))).toBe(true);
  });
});

describe('LIVE-SMOKE-FIX-04 — claimed-attempt invariant (no FAILED claim without durable cause)', () => {
  it('every terminal FAILED ExecutionAttempt in the fresh DB belongs to a task carrying a durable failure envelope', async () => {
    const f = await composeWith({...smartEnv}, {plan: 'fanin'});
    await driveGoal(f.core, 'pt-inv-1', 12);
    const failedAttempts = f.core.database.db.prepare("SELECT task_id FROM execution_attempts WHERE state = 'FAILED'").all() as {task_id: string}[];
    expect(failedAttempts.length).toBeGreaterThanOrEqual(1);
    for (const attempt of failedAttempts) {
      const task = f.core.database.db.prepare('SELECT outputs_json FROM tasks WHERE id = ?').get(String(attempt.task_id)) as {outputs_json: string} | undefined;
      expect(task).toBeDefined();
      const outputs = JSON.parse(String(task?.outputs_json ?? '{}')) as Record<string, unknown>;
      expect(outputs['companyos:attempt-failure']).toBeDefined();
    }
  });
});
