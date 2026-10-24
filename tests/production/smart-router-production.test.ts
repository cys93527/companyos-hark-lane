import { offlineExecutionSafety } from './helpers/offline-execution-safety.js';
/**
 * SMART-ROUTER-PROD-01 — production Smart Router wiring tests.
 *
 * Proves the REAL production path end-to-end through `productionCompositionOptions`
 * (the same function main.ts consumes): typed env config → the ONE production
 * ModelPool → the Stage 8 `ModelRoutingPolicyV1` fixtures (by REFERENCE, never a
 * copy) → the existing routeModelOf seam → a durable RoutingDecision on the dispatch
 * row → the in-memory resolved credential on the provider request → the capture
 * executor. Deterministic and local throughout: an in-process OpenAI-compatible
 * fixture server answers the planner/supervisor turns; NO real API is called.
 *
 * The ambient user live env (COS_MODEL_* / COMPANYOS_MODEL_API_KEY on this machine)
 * is scrubbed around every composition — test isolation, never a user action.
 */
import {createServer, type Server} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {openDurableDatabase, type DurableDatabase} from '@companyos/persistence';
import {nullLogger} from '@companyos/observability';
import type {ExecutorProvider, ExecutorProviderOutcome, ExecutorExecutionRequest, TypedExecutorConfig} from '@companyos/engine';

import {composeCoreServices} from '../../apps/desktop/src/core-services.js';
import {openArtifactFoundation} from '../../apps/desktop/src/artifact-stack.js';
import {GOAL_WORK_KIND} from '../../apps/desktop/src/control-plane.js';
import {productionCompositionOptions, productionModelRouting, type ProductionModelRouting} from '../../apps/desktop/src/production-composition.js';
import {ROUTING_POLICIES} from '../../apps/desktop/src/executor/smart-model-router.js';
import type {ModelProfile} from '../../apps/desktop/src/executor/model-pool.js';
import {resolveOpenAiCompatibleConfig} from '../../apps/desktop/src/models/openai-compatible-provider.js';

const COMPANY = 'company_default';
const SENTINEL = 'sk-sprodc1';
const CAPTURE_KEY = 'capture.smart-prod';
const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;
const LIVE_ENV_KEYS = [
  'COS_MODEL_BASE_URL', 'COS_MODEL_ID', 'COS_MODEL_PROVIDER_ID', 'COS_MODEL_TIMEOUT_MS', 'COMPANYOS_MODEL_API_KEY',
  'COS_MODEL_ROUTING_MODE', 'COS_MODEL_ROUTING_POLICY',
  'COS_MODEL_QUALITY_TIER', 'COS_MODEL_COST_TIER', 'COS_MODEL_LATENCY_TIER', 'COS_MODEL_RELIABILITY_CLASS',
] as const;

/* ------------------------------------------------- ambient live env scrubbing --- */
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of LIVE_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/* ------------------------------------------------------- local model fixture --- */
type FixtureServer = {readonly url: string; readonly requests: {readonly path: string; readonly auth: string | null}[]; readonly close: () => Promise<void>};
const planFor = (objective: string): unknown => ({
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {planItemId: 'analyze', objective: `分析目标「${objective}」。`, dependencyPlanItemIds: [], acceptanceCriterionRefs: ['facts']},
    {planItemId: 'deliver', objective: `产出「${objective}」的成果。`, dependencyPlanItemIds: ['analyze'], acceptanceCriterionRefs: ['out']},
  ],
  acceptanceCriteria: [
    {criterionId: 'facts', requirement: '关键事实已列出。'},
    {criterionId: 'out', requirement: '成果已产出。'},
  ],
});
const startFixture = async (): Promise<FixtureServer> => {
  const requests: {readonly path: string; readonly auth: string | null}[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { body = {}; }
      requests.push({path: req.url ?? '/', auth: typeof req.headers['authorization'] === 'string' ? String(req.headers['authorization']) : null});
      // The adapter's self-registration performs a REAL /models list call — the
      // deterministic fixture answers it locally (no network beyond loopback).
      if ((req.url ?? '').includes('/models')) {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({object: 'list', data: [{id: 'fixture-model'}]}));
        return;
      }
      const rfText = JSON.stringify((body as {readonly response_format?: unknown}).response_format ?? {});
      let content: string;
      if (rfText.includes('"action"')) {
        // The frozen stub discipline: the action's SUBJECT is read from the bounded
        // context's memory view — never invented.
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
        const messages = Array.isArray(body['messages']) ? (body['messages'] as readonly {readonly role?: unknown; readonly content?: unknown}[]) : [];
        const userText = messages.filter((m) => m?.role === 'user').map((m) => String(m?.content ?? '')).join('\n');
        const objective = /目标是[：:]?(.+)/u.exec(userText)?.[1] ?? userText.slice(0, 200);
        content = JSON.stringify(planFor(String(objective)));
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({
        object: 'chat.completion',
        choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 111, completion_tokens: 7},
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture address unavailable');
  return {url: `http://127.0.0.1:${String(address.port)}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve()))};
};

/* -------------------------------------------------------- capture executor --- */
const captureExecutor = (captures: {readonly request: ExecutorExecutionRequest}[]): {readonly provider: ExecutorProvider; readonly config: TypedExecutorConfig} => ({
  config: {
    providerKey: CAPTURE_KEY,
    fields: [{name: 'profile', value: 'smart-prod', source: 'composition'}],
    fingerprint: `scfg_smartprod${'0'.repeat(17)}`,
  },
  provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
    descriptor: {
      providerKey: CAPTURE_KEY,
      capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics'],
    },
    async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
      captures.push({request});
      return {kind: 'succeeded', exitCode: 0, stdoutText: 'delivered', providerSessionId: `session-smart-${String(request.attemptId).slice(4, 12)}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()};
    },
  } as unknown as ExecutorProvider,
});

/* ------------------------------------------------------------ the harness --- */
const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
const openServers: FixtureServer[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (openServers.length > 0) void openServers.pop()?.close();
  while (createdDirs.length > 0) { try { rmSync(createdDirs.pop() as string, {recursive: true, force: true}); } catch { /* disposable */ } }
  for (const key of LIVE_ENV_KEYS) delete process.env[key];
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-smartprod-'));
  createdDirs.push(dir);
  return dir;
};

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const composeProd = async (
  env: Readonly<Record<string, string | undefined>>,
  options: {readonly extraModelProfiles?: readonly Omit<ModelProfile, 'configurationVersion'>[]} = {},
): Promise<{core: Core; fixture: FixtureServer; captures: {readonly request: ExecutorExecutionRequest}[]}> => {
  const fixture = await startFixture();
  openServers.push(fixture);
  const dataDir = tempDir();
  const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never});
  if (!foundation.ok) throw new Error('foundation failed');
  const captures: {readonly request: ExecutorExecutionRequest}[] = [];
  const executor = captureExecutor(captures);
  // The composition's adapter self-registration reads process.env directly: mirror
  // the explicit env onto it for the compose window (restored by afterEach).
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    ...productionCompositionOptions(env, {extraModelProfiles: options.extraModelProfiles ?? []}),
    executionSafety: offlineExecutionSafety,
    executorProviderImplementations: [executor as never],
  } as never);
  if (core === null) throw new Error('composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({root: dataDir, commandProfile: {}});
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
  const registered = await core.models.registerFromProvider({providerId: 'model.openai-compatible', providerModelId: 'fixture-model', modelKey: 'smart.prod', actorId: actor});
  if (!registered.ok) throw new Error(`model registration failed: ${registered.error.message}`);
  const savedPolicy = await core.policies.savePolicy({
    id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'smart.prod', actorId: actor,
  } as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  return {core, fixture, captures};
};

const baseEnv = (fixtureUrl: string): Record<string, string | undefined> => ({
  COS_MODEL_BASE_URL: fixtureUrl,
  COS_MODEL_ID: 'fixture-model',
  COMPANYOS_MODEL_API_KEY: SENTINEL,
  COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY,
});

/** Traits expressed as the DEPLOYMENT env names (never key-mismatched spreads). */
const traitEnv = (traits: {
  readonly qualityTier: 'ECONOMY' | 'BALANCED' | 'STRONG' | 'PREMIUM';
  readonly costTier: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly latencyTier: 'FAST' | 'BALANCED' | 'SLOW';
  readonly reliabilityClass: 'STANDARD' | 'HIGH' | 'CRITICAL';
}): Record<string, string> => ({
  COS_MODEL_QUALITY_TIER: traits.qualityTier,
  COS_MODEL_COST_TIER: traits.costTier,
  COS_MODEL_LATENCY_TIER: traits.latencyTier,
  COS_MODEL_RELIABILITY_CLASS: traits.reliabilityClass,
});

const driveGoal = async (core: Core, commandId: string): Promise<string> => {
  const cp = core.controlPlane!;
  const created = await cp.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: '目标是产出一份简短说明。', commandId}});
  if (!created.ok) throw new Error(`goal.create failed: ${JSON.stringify(created.error)}`);
  const goalRunId = String((created.value as {readonly runId: string}).runId);
  let executionRunId = '';
  for (let turn = 0; turn < 6; turn += 1) {
    const advanced = await cp.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: goalRunId}});
    if (!advanced.ok) throw new Error(`goal.advance failed: ${JSON.stringify(advanced.error)}`);
    executionRunId = String((advanced.value as {readonly executionRunId: string}).executionRunId);
    const states = core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as {state: string}[];
    if (states.length > 0 && states.every((row) => row.state === 'DONE' || row.state === 'FAILED')) break;
  }
  return executionRunId;
};

const dispatchRows = (core: Core): {provider_invocation_id: string | null; attempt_id: string; state: string; routing_decision_json: string | null; result_summary: string | null}[] =>
  core.database.db.prepare('SELECT provider_invocation_id, attempt_id, state, routing_decision_json, result_summary FROM provider_dispatches ORDER BY rowid').all() as never;

const routingEvidenceOf = (core: Core): {json: Record<string, unknown> | null; row: {attempt_id: string; state: string; result_summary: string | null} | null} => {
  const rows = dispatchRows(core);
  const routed = rows.find((row) => row.routing_decision_json !== null) ?? null;
  return {
    json: routed === null ? null : (JSON.parse(String(routed.routing_decision_json)) as Record<string, unknown>),
    row: routed,
  };
};

/* ============================================================ config contract === */

describe('SMART-ROUTER-PROD-01 — typed routing configuration', () => {
  it('mode/policy/traits validate loudly; absent stays absent (no guessed defaults)', () => {
    const none = resolveOpenAiCompatibleConfig({COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm'});
    expect(none.ok && none.value?.routingMode).toBeUndefined();
    expect(none.ok && none.value?.routingPolicy).toBeUndefined();
    expect(none.ok && none.value?.routingTraits).toBeUndefined();

    const badMode = resolveOpenAiCompatibleConfig({COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm', COS_MODEL_ROUTING_MODE: 'AUTO'});
    expect(badMode.ok).toBe(false);

    const badPolicy = resolveOpenAiCompatibleConfig({COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm', COS_MODEL_ROUTING_POLICY: 'SPEED'});
    expect(badPolicy.ok).toBe(false);

    const partial = resolveOpenAiCompatibleConfig({COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm', COS_MODEL_QUALITY_TIER: 'STRONG'});
    expect(partial.ok).toBe(false);

    const badTier = resolveOpenAiCompatibleConfig({
      COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm',
      COS_MODEL_QUALITY_TIER: 'ULTRA', COS_MODEL_COST_TIER: 'LOW', COS_MODEL_LATENCY_TIER: 'FAST', COS_MODEL_RELIABILITY_CLASS: 'HIGH',
    });
    expect(badTier.ok).toBe(false);

    const full = resolveOpenAiCompatibleConfig({
      COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm', COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'COST_AWARE',
      COS_MODEL_QUALITY_TIER: 'STRONG', COS_MODEL_COST_TIER: 'LOW', COS_MODEL_LATENCY_TIER: 'FAST', COS_MODEL_RELIABILITY_CLASS: 'HIGH',
    });
    expect(full.ok && full.value?.routingMode).toBe('SMART_ROUTER_V1');
    expect(full.ok && full.value?.routingPolicy).toBe('COST_AWARE');
    expect(full.ok && full.value?.routingTraits).toEqual({qualityTier: 'STRONG', costTier: 'LOW', latencyTier: 'FAST', reliabilityClass: 'HIGH'});
  });

  it('productionModelRouting: deterministic default; SMART without traits fails loud; policies are the Stage 8 fixtures BY REFERENCE', () => {
    expect(productionModelRouting({COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm'})).toBeUndefined();
    expect(productionModelRouting({COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm', COS_MODEL_ROUTING_MODE: 'DETERMINISTIC_V1'})).toBeUndefined();

    expect(() => productionModelRouting({COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm', COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1'}))
      .toThrow(/MODEL_ROUTING_PROFILE_INCOMPLETE/);
    expect(() => productionModelRouting({COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1'}))
      .toThrow(/COS_MODEL_BASE_URL/);

    const traits = traitEnv({qualityTier: 'STRONG', costTier: 'MEDIUM', latencyTier: 'BALANCED', reliabilityClass: 'HIGH'});
    const smart = productionModelRouting({COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm', COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', ...traits});
    expect(smart?.mode).toBe('SMART_ROUTER_V1');
    expect(smart?.policy).toBe(ROUTING_POLICIES['BALANCED']); // reference identity — no copy
    const quality = productionModelRouting({COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm', COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'QUALITY_FIRST', ...traits});
    expect(quality?.policy).toBe(ROUTING_POLICIES['QUALITY_FIRST']);
    const cost = productionModelRouting({COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm', COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'COST_AWARE', ...traits});
    expect(cost?.policy).toBe(ROUTING_POLICIES['COST_AWARE']);
    // Same env → same pool identity (restart determinism, §35).
    const again = productionModelRouting({COS_MODEL_BASE_URL: 'http://x/v1', COS_MODEL_ID: 'm', COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', ...traits});
    const ids = (routing: ProductionModelRouting | undefined): readonly string[] =>
      routing?.pool === undefined ? [] : routing.pool.listEnabled().map((p) => p.modelProfileId);
    expect(ids(again)).toEqual(ids(smart));
  });
});

/* ========================================================= the real attempt path === */

describe('SMART-ROUTER-PROD-01 — production attempt path', () => {
  it('DETERMINISTIC default (mode absent): existing behaviour, no routing decision, no selected route', async () => {
    const fixture = await startFixture();
    openServers.push(fixture);
    const f = await composeProd(baseEnv(fixture.url));
    const executionRunId = await driveGoal(f.core, 'smart-prod-det-1');
    expect(executionRunId).toMatch(/^run_/);
    expect(f.captures.length).toBeGreaterThanOrEqual(1);
    expect(dispatchRows(f.core).every((row) => row.routing_decision_json === null)).toBe(true);
    expect(f.captures.every((capture) => capture.request.selectedModelRoute === undefined)).toBe(true);
  });

  it('SMART single profile (wired): durable RoutingDecision, credentialValue in-memory, no secret in evidence', async () => {
    const fixture = await startFixture();
    openServers.push(fixture);
    const f = await composeProd({
      ...baseEnv(fixture.url),
      COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1',
      ...traitEnv({qualityTier: 'STRONG', costTier: 'MEDIUM', latencyTier: 'BALANCED', reliabilityClass: 'HIGH'}),
    });
    const executionRunId = await driveGoal(f.core, 'smart-prod-one-1');
    expect(executionRunId).toMatch(/^run_/);
    expect(f.captures.length).toBeGreaterThanOrEqual(1);
    const routed = routingEvidenceOf(f.core);
    expect(routed.json).not.toBeNull();
    const evidence = String(JSON.stringify(routed.json));
    expect(routed.json!['policyId']).toBe('BALANCED');
    expect(routed.json!['policyVersion']).toBe(ROUTING_POLICIES['BALANCED'].policyVersion);
    expect(routed.json!['selectedProfileId']).toBe('env:fixture-model');
    expect(Array.isArray(routed.json!['eligibleCandidates'])).toBe(true);
    expect(Array.isArray(routed.json!['rejectedCandidates'])).toBe(true);
    expect(Array.isArray(routed.json!['scoreBreakdown'])).toBe(true);
    // The decision is ATTEMPT-scoped and matches the durable attempt row.
    const attemptId = String(routed.json!['attemptId']);
    const attempt = f.core.database.db.prepare('SELECT id FROM execution_attempts WHERE id = ?').get(attemptId) as {id: string} | undefined;
    expect(attempt?.id).toBe(attemptId);
    expect(routed.row!.attempt_id).toBe(attemptId);
    // The provider received the CompanyOS-selected route with the RESOLVED credential.
    const route = f.captures.at(-1)!.request.selectedModelRoute!;
    expect(route.modelProfileId).toBe('env:fixture-model');
    expect(route.credentialRef).toBe('vault://COMPANYOS_MODEL_API_KEY/live');
    expect(route.credentialValue).toBe(SENTINEL);
    // No raw secret anywhere durable.
    expect(evidence).not.toContain(SENTINEL);
    expect(evidence).not.toContain('sk-');
    const dispatchDump = JSON.stringify(dispatchRows(f.core));
    expect(dispatchDump).not.toContain(SENTINEL);
  });

  it('SMART multi-profile: different policies select different profiles through the SAME production path', async () => {
    const profiles: readonly Omit<ModelProfile, 'configurationVersion'>[] = [
      profileOf('PROFILE_A', {qualityTier: 'PREMIUM', costTier: 'HIGH', latencyTier: 'SLOW', reliabilityClass: 'CRITICAL'}),
      profileOf('PROFILE_B', {qualityTier: 'ECONOMY', costTier: 'LOW', latencyTier: 'FAST', reliabilityClass: 'STANDARD'}),
      profileOf('PROFILE_C', {qualityTier: 'BALANCED', costTier: 'MEDIUM', latencyTier: 'BALANCED', reliabilityClass: 'HIGH'}),
    ];
    const fixture = await startFixture();
    openServers.push(fixture);
    const traits = traitEnv({qualityTier: 'BALANCED', costTier: 'MEDIUM', latencyTier: 'BALANCED', reliabilityClass: 'HIGH'});
    const quality = await composeProd({
      ...baseEnv(fixture.url), COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'QUALITY_FIRST', ...traits,
    }, {extraModelProfiles: profiles});
    await driveGoal(quality.core, 'smart-prod-multi-q-1');
    expect(routingEvidenceOf(quality.core).json!['selectedProfileId']).toBe('PROFILE_A');

    const fixture2 = await startFixture();
    openServers.push(fixture2);
    const cost = await composeProd({
      ...baseEnv(fixture2.url), COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'COST_AWARE', ...traits,
    }, {extraModelProfiles: profiles});
    await driveGoal(cost.core, 'smart-prod-multi-c-1');
    expect(routingEvidenceOf(cost.core).json!['selectedProfileId']).toBe('PROFILE_B');
  });

  it('SMART with an unsatisfiable policy floor: typed fail-loud at dispatch, no deterministic fallback', async () => {
    const fixture = await startFixture();
    openServers.push(fixture);
    const f = await composeProd({
      ...baseEnv(fixture.url),
      COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'QUALITY_FIRST',
      ...traitEnv({qualityTier: 'ECONOMY', costTier: 'LOW', latencyTier: 'FAST', reliabilityClass: 'STANDARD'}),
    });
    const cp = f.core.controlPlane!;
    const created = await cp.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: '目标是产出说明。', commandId: 'smart-prod-fail-1'}});
    expect(created.ok).toBe(true);
    const goalRunId = String((created.value as {readonly runId: string}).runId);
    const advanced = await cp.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: goalRunId}});
    expect(advanced.ok).toBe(true);
    const executionRunId = String((advanced.value as {readonly executionRunId: string}).executionRunId);
    // QUALITY_FIRST demands minimum BALANCED quality: the only ECONOMY profile is
    // hard-filtered, the routing fails TYPED, the work attempt settles FAILED and no
    // provider ever runs — never a silent fallback to the deterministic selector.
    const work = f.core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as {state: string}[];
    expect(work.length).toBeGreaterThanOrEqual(1);
    expect(work.some((row) => row.state === 'FAILED')).toBe(true);
    expect(f.captures).toHaveLength(0);
  });

  it('SMART with a missing vault credential: doctor fails AND the dispatch fails typed MODEL_CREDENTIAL_MISSING', async () => {
    const fixture = await startFixture();
    openServers.push(fixture);
    const env: Record<string, string | undefined> = {
      ...baseEnv(fixture.url),
      COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1',
      ...traitEnv({qualityTier: 'STRONG', costTier: 'MEDIUM', latencyTier: 'BALANCED', reliabilityClass: 'HIGH'}),
    };
    delete env['COMPANYOS_MODEL_API_KEY'];
    const f = await composeProd(env);
    // The autonomy driver's PREFLIGHT (the Runtime Doctor) runs BEFORE any churn:
    // a missing routable credential must surface as the typed external block.
    const cp = f.core.controlPlane!;
    const created = await cp.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: '目标是产出说明。', commandId: 'smart-prod-cred-1'}});
    expect(created.ok).toBe(true);
    const goalRunId = String((created.value as {readonly runId: string}).runId);
    if (f.core.autonomyDriver === null) throw new Error('autonomy driver unavailable');
    const driven = await f.core.autonomyDriver.run({companyId: COMPANY, runId: goalRunId});
    expect(driven.ok).toBe(true);
    if (!driven.ok) throw new Error(driven.error.message);
    expect(driven.value.terminal).toBe('EXTERNAL_PRECONDITION_BLOCKED');
    expect(driven.value.terminalReason).toContain('MODEL_CREDENTIAL_MISSING');
    // Safe output: the doctor names the missing credential, never its value.
    expect(JSON.stringify(driven.value.doctor)).not.toContain('sk-');
    // No resolved credential may EVER reach a provider request while the vault
    // cannot resolve it: routes may carry the auditable pointer, never a value.
    expect(f.captures.every((capture) => capture.request.selectedModelRoute?.credentialValue === undefined)).toBe(true);
    const dispatchDump = JSON.stringify(dispatchRows(f.core));
    expect(dispatchDump).not.toContain('sk-');
  });
});

const profileOf = (id: string, traits: {qualityTier: 'ECONOMY' | 'BALANCED' | 'STRONG' | 'PREMIUM'; costTier: 'LOW' | 'MEDIUM' | 'HIGH'; latencyTier: 'FAST' | 'BALANCED' | 'SLOW'; reliabilityClass: 'STANDARD' | 'HIGH' | 'CRITICAL'}): Omit<ModelProfile, 'configurationVersion'> => ({
  modelProfileId: id,
  providerId: 'prov-fixtures',
  modelId: `model-${id}`,
  displayName: id,
  endpointURL: 'http://127.0.0.1:9/v1',
  credentialRef: 'vault://COMPANYOS_MODEL_API_KEY/live',
  enabled: true,
  capabilities: new Set(['structured-output', 'tool-calling', 'streaming'] as const),
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
  supportsTools: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  routingTraits: traits,
});

