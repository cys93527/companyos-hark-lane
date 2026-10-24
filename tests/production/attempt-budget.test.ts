import { offlineExecutionSafety } from './helpers/offline-execution-safety.js';
/**
 * LIVE-SMOKE-FIX-02 — production execution-attempt budget closure tests.
 *
 * The live smoke proved the work attempt's effective timeout fell through to the DSH
 * provider's hidden 120_000 ms fallback: role execution budgets carry no timeBudgetMs,
 * the dispatch propagated `undefined`, and the provider invented product policy —
 * three real attempts each died at ~128s. The closed contract, pinned mechanically
 * (deterministic, local, zero real API):
 *
 *   precedence   explicit Role timeBudgetMs > deployment override
 *                (COS_EXECUTION_ATTEMPT_TIMEOUT_MS, validated 30s..3600s)
 *                > the CompanyOS production default 600_000 ms;
 *   ownership    the production dispatch ALWAYS passes an explicit resolved timeout —
 *                the provider's internal fallback is defensive-only and the shipped
 *                composition never depends on it (§14: a provider that cannot run
 *                under the hidden fallback succeeds under the CompanyOS budget);
 *   semantics    timeout/UNCERTAIN/retry-with-new-attempt semantics are untouched —
 *                every retry re-resolves the SAME budget (never in-place mutation).
 */
import {createServer, type Server} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {openDurableDatabase, type DurableDatabase} from '@companyos/persistence';
import {nullLogger} from '@companyos/observability';
import type {ExecutorExecutionRequest, ExecutorProvider, ExecutorProviderOutcome, TypedExecutorConfig} from '@companyos/engine';

import {composeCoreServices, lastCoreCompositionError} from '../../apps/desktop/src/core-services.js';
import {openArtifactFoundation} from '../../apps/desktop/src/artifact-stack.js';
import {GOAL_WORK_KIND} from '../../apps/desktop/src/control-plane.js';
import {
  DEFAULT_EXECUTION_ATTEMPT_TIMEOUT_MS,
  EXECUTION_ATTEMPT_TIMEOUT_ENV,
  productionCompositionOptions,
  resolveAttemptTimeoutMs,
  resolveExecutionAttemptTimeoutMs,
} from '../../apps/desktop/src/production-composition.js';

const COMPANY = 'company_default';
const CAPTURE_KEY = 'capture.budget';
const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;
const LIVE_ENV_KEYS = [
  'COS_MODEL_BASE_URL', 'COS_MODEL_ID', 'COS_MODEL_PROVIDER_ID', 'COS_MODEL_TIMEOUT_MS', 'COMPANYOS_MODEL_API_KEY',
  'COS_MODEL_ROUTING_MODE', 'COS_MODEL_ROUTING_POLICY',
  'COS_MODEL_QUALITY_TIER', 'COS_MODEL_COST_TIER', 'COS_MODEL_LATENCY_TIER', 'COS_MODEL_RELIABILITY_CLASS',
  EXECUTION_ATTEMPT_TIMEOUT_ENV,
] as const;

const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => { for (const key of LIVE_ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; } });
afterAll(() => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

/** Local OpenAI-compatible fixture (planner/supervisor turns + /models self-registration). */
type FixtureServer = {readonly url: string; readonly close: () => Promise<void>};
const startFixture = async (): Promise<FixtureServer> => {
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
        content = JSON.stringify({schema: 'companyos/supervisor-proposal/1', action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the next work unit.', evidenceRefs: [], ...(subject === undefined ? {} : {subject})});
      } else if (rfText.includes('"targetRef"')) {
        content = JSON.stringify({schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', missingRequirements: [], summary: 'ok', targetRef: 'goal'});
      } else if (rfText.includes('"verdict"')) {
        content = JSON.stringify({schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', findings: [], summary: 'ok'});
      } else {
        content = JSON.stringify({
          schema: 'companyos/plan-proposal/1',
          planItems: [
            {planItemId: 'analyze', objective: '分析目标。', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['facts']},
            {planItemId: 'deliver', objective: '产出成果。', dependencyPlanItemIds: ['analyze'], acceptanceCriterionRefs: ['out']},
          ],
          acceptanceCriteria: [
            {criterionId: 'facts', requirement: '关键事实已列出。'},
            {criterionId: 'out', requirement: '成果已产出。'},
          ],
        });
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
  const dir = mkdtempSync(join(tmpdir(), 'companyos-budget-'));
  createdDirs.push(dir);
  return dir;
};

/**
 * §14 — the hidden-fallback detector: this provider REFUSES to run unless the request
 * carries an explicit CompanyOS-resolved timeout (simulating work that needs longer
 * than any provider-internal default would allow). A production dispatch that leaned
 * on the provider's 120s fallback would fail here; the CompanyOS budget lets it run.
 */
const composeWith = async (
  env: Record<string, string | undefined>,
  options: {readonly refuseHiddenFallback?: boolean} = {},
): Promise<{core: Core; captures: {readonly request: ExecutorExecutionRequest}[]}> => {
  const fixture = await startFixture();
  fixtures.push(fixture);
  const dataDir = tempDir();
  const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never});
  if (!foundation.ok) throw new Error('foundation failed');
  const captures: {readonly request: ExecutorExecutionRequest}[] = [];
  const executor = {
    config: {providerKey: CAPTURE_KEY, fields: [{name: 'profile', value: 'budget', source: 'composition'}], fingerprint: `scfg_budget${'0'.repeat(19)}`} satisfies TypedExecutorConfig,
    provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
      descriptor: {providerKey: CAPTURE_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
      async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
        captures.push({request});
        if (options.refuseHiddenFallback === true && request.timeoutMs === undefined) {
          return {kind: 'transport-failed', reasonCode: 'HIDDEN_FALLBACK_DEPENDENCE', detail: 'the request carried no explicit CompanyOS timeout'};
        }
        return {kind: 'succeeded', exitCode: 0, stdoutText: 'delivered', providerSessionId: `s-${String(request.attemptId).slice(4, 10)}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()};
      },
    } as unknown as ExecutorProvider,
  };
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    ...productionCompositionOptions(env),
    executionSafety: offlineExecutionSafety,
    executorProviderImplementations: [executor as never],
  } as never);
  if (core === null) throw new Error(lastCoreCompositionError() ?? 'composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({root: dataDir, commandProfile: {}});
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
  const registered = await core.models.registerFromProvider({providerId: 'model.openai-compatible', providerModelId: 'fixture-model', modelKey: 'budget.model', actorId: actor});
  if (!registered.ok) throw new Error(registered.error.message);
  const savedPolicy = await core.policies.savePolicy({id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'budget.model', actorId: actor} as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  return {core, captures};
};

const driveGoal = async (core: Core, commandId: string): Promise<string> => {
  const cp = core.controlPlane!;
  const created = await cp.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: '目标是产出说明。', commandId}});
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const goalRunId = String((created.value as {readonly runId: string}).runId);
  let executionRunId = '';
  for (let turn = 0; turn < 8; turn += 1) {
    const advanced = await cp.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: goalRunId}});
    if (!advanced.ok) throw new Error(JSON.stringify(advanced.error));
    executionRunId = String((advanced.value as {readonly executionRunId: string}).executionRunId);
    const states = core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as {state: string}[];
    if (states.length > 0 && states.every((row) => row.state === 'DONE' || row.state === 'FAILED')) break;
  }
  return executionRunId;
};

describe('LIVE-SMOKE-FIX-02 — budget resolution contract', () => {
  it('the resolver: unset = the 600s CompanyOS default; the operator override wins; invalid values fail typed (never clamped)', () => {
    expect(resolveExecutionAttemptTimeoutMs({})).toBe(600_000);
    expect(DEFAULT_EXECUTION_ATTEMPT_TIMEOUT_MS).toBe(600_000);
    expect(resolveExecutionAttemptTimeoutMs({[EXECUTION_ATTEMPT_TIMEOUT_ENV]: '900000'})).toBe(900_000);
    for (const bad of ['29999', '3600001', 'abc', '12.5', '']) {
      if (bad === '') { expect(resolveExecutionAttemptTimeoutMs({})).toBe(600_000); continue; }
      expect(() => resolveExecutionAttemptTimeoutMs({[EXECUTION_ATTEMPT_TIMEOUT_ENV]: bad})).toThrow(/COS_EXECUTION_ATTEMPT_TIMEOUT_MS/);
    }
  });

  it('the precedence helper: an explicit Role timeBudgetMs beats the deployment level; absence falls to it', () => {
    expect(resolveAttemptTimeoutMs(45_000, 600_000)).toBe(45_000);
    expect(resolveAttemptTimeoutMs(undefined, 600_000)).toBe(600_000);
    expect(resolveAttemptTimeoutMs(undefined, 45_000)).toBe(45_000);
  });
});

describe('LIVE-SMOKE-FIX-02 — the production dispatch carries the CompanyOS budget', () => {
  it('production composition, no override: both work attempts carry the explicit 600s budget (§14 hidden-fallback refusal cannot trigger)', {timeout: 180_000}, async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const f = await composeWith({COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'fixture-model', COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY}, {refuseHiddenFallback: true});
    const executionRunId = await driveGoal(f.core, 'budget-default-1');
    expect(executionRunId).toMatch(/^run_/);
    expect(f.captures.length).toBeGreaterThanOrEqual(2);
    for (const capture of f.captures) {
      expect(capture.request.timeoutMs).toBe(600_000);
    }
  });

  it('the deployment override wins over the default and reaches every attempt', {timeout: 180_000}, async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const f = await composeWith({
      COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'fixture-model', COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY,
      [EXECUTION_ATTEMPT_TIMEOUT_ENV]: '45000',
    }, {refuseHiddenFallback: true});
    await driveGoal(f.core, 'budget-override-1');
    expect(f.captures.length).toBeGreaterThanOrEqual(1);
    for (const capture of f.captures) {
      expect(capture.request.timeoutMs).toBe(45_000);
    }
  });

  it('an INVALID deployment override fails the composition typed at boot (never clamped, never silent)', {timeout: 120_000}, async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const dataDir = tempDir();
    const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
    openDatabases.push(db);
    const foundation = await openArtifactFoundation({casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never});
    if (!foundation.ok) throw new Error('foundation failed');
    const env = {COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'fixture-model', [EXECUTION_ATTEMPT_TIMEOUT_ENV]: '500'};
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const core = await composeCoreServices(db, nullLogger as never, {
      artifactFoundation: foundation as never,
      ...productionCompositionOptions(env),
    executionSafety: offlineExecutionSafety,
    } as never);
    expect(core).toBeNull();
    expect(lastCoreCompositionError() ?? '').toContain('COS_EXECUTION_ATTEMPT_TIMEOUT_MS');
    for (const key of Object.keys(env)) delete process.env[key];
  });

  it('each retry creates a NEW attempt and re-resolves the SAME budget (no in-place mutation)', {timeout: 180_000}, async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const f = await composeWith({COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'fixture-model', COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY}, {refuseHiddenFallback: true});
    const executionRunId = await driveGoal(f.core, 'budget-retry-1');
    const attempts = f.core.database.db.prepare('SELECT id FROM execution_attempts WHERE run_id = ? ORDER BY rowid').all(executionRunId) as {id: string}[];
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(new Set(attempts.map((a) => a.id)).size).toBe(attempts.length);
    const dispatches = f.core.database.db.prepare('SELECT attempt_id, result_summary FROM provider_dispatches WHERE result_summary IS NOT NULL').all() as {attempt_id: string; result_summary: string | null}[];
    for (const dispatch of dispatches) {
      const capture = f.captures.find((c) => c.request.attemptId === dispatch.attempt_id);
      if (capture !== undefined) expect(capture.request.timeoutMs).toBe(600_000);
    }
  });
});
