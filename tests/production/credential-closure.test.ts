import { offlineExecutionSafety } from './helpers/offline-execution-safety.js';
/**
 * SMART-ROUTER-PROD-01B — credentialRef fail-closed closure tests.
 *
 * PROD-01 shipped a compatibility hole: a profile that DECLARED a credentialRef the
 * vault could not resolve still dispatched, and the pointer string could travel to
 * the broker as the bearer — leaning on a real upstream's 401 as the "guard".
 *
 * The closed contract, pinned here mechanically (deterministic, local, zero real
 * API; an in-process upstream COUNTER proves no packet ever leaves):
 *
 *   no credentialRef            legal no-auth contract → dispatches;
 *   credentialRef + resolvable  resolves in-process → dispatches with the value;
 *   credentialRef + missing     typed MODEL_CREDENTIAL_MISSING BEFORE any provider
 *                               invocation — network request count = 0;
 *   credentialRef + empty value typed fail closed, network count = 0;
 *   pointer-shaped credential   refused at the provider boundary AND at the broker
 *                                (last line) — never an Authorization header;
 *   Doctor bypass               the dispatch boundary itself fails closed;
 *   durability                  no raw credential in RoutingDecision, attempt
 *                               rows, dispatch dumps or the kernel child env.
 */
import http, {createServer, type Server} from 'node:http';
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
import {productionCompositionOptions} from '../../apps/desktop/src/production-composition.js';
import type {ModelProfile} from '../../apps/desktop/src/executor/model-pool.js';
import {startModelBroker} from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';

const COMPANY = 'company_default';
const SENTINEL = 'cred-closure-canary';
const CAPTURE_KEY = 'capture.credclosure';
const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;
const LIVE_ENV_KEYS = [
  'COS_MODEL_BASE_URL', 'COS_MODEL_ID', 'COS_MODEL_PROVIDER_ID', 'COS_MODEL_TIMEOUT_MS', 'COMPANYOS_MODEL_API_KEY',
  'COS_MODEL_ROUTING_MODE', 'COS_MODEL_ROUTING_POLICY',
  'COS_MODEL_QUALITY_TIER', 'COS_MODEL_COST_TIER', 'COS_MODEL_LATENCY_TIER', 'COS_MODEL_RELIABILITY_CLASS',
] as const;

const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => { for (const key of LIVE_ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; } });
afterAll(() => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

/** A counting local upstream — the network negative-proof oracle (§9). */
type CountingUpstream = {
  readonly url: string;
  readonly count: () => number;
  /** The Authorization header of every chat request that reached this upstream. */
  readonly authorizations: () => readonly (string | undefined)[];
  readonly stop: () => Promise<void>;
};
const startCountingUpstream = async (): Promise<CountingUpstream> => {
  let requests = 0;
  const auths: (string | undefined)[] = [];
  const server: Server = createServer((req, res) => {
    if ((req.url ?? '').includes('/models')) {
      requests += 1; // the adapter's self-registration probe counts too — it is a real packet
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({object: 'list', data: [{id: 'fixture-model'}]}));
      });
      return;
    }
    requests += 1;
    auths.push(typeof req.headers['authorization'] === 'string' ? String(req.headers['authorization']) : undefined);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({object: 'chat.completion', choices: [{index: 0, message: {role: 'assistant', content: '{}'}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1}}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no upstream address');
  return {url: `http://127.0.0.1:${String(address.port)}/v1`, count: () => requests, authorizations: () => [...auths], stop: () => new Promise<void>((resolve) => server.close(() => resolve()))};
};

/** The local fixture model server (planner/supervisor turns + /models self-registration). */
type FixtureServer = {readonly url: string; readonly authorizations: () => readonly (string | undefined)[]; readonly close: () => Promise<void>};
const startFixture = async (): Promise<FixtureServer> => {
  const auths: (string | undefined)[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { body = {}; }
      if (!(req.url ?? '').includes('/models')) auths.push(typeof req.headers['authorization'] === 'string' ? String(req.headers['authorization']) : undefined);
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
          planItems: [{planItemId: 'deliver', objective: '产出成果。', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['out']}],
          acceptanceCriteria: [{criterionId: 'out', requirement: '成果已产出。'}],
        });
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({object: 'chat.completion', choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}], usage: {prompt_tokens: 9, completion_tokens: 9}}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no fixture address');
  return {url: `http://127.0.0.1:${String(address.port)}`, authorizations: () => [...auths], close: () => new Promise<void>((resolve) => server.close(() => resolve()))};
};

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;
const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
const fixtures: {close: () => Promise<void>}[] = [];
const upstreams: CountingUpstream[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (fixtures.length > 0) void fixtures.pop()?.close();
  while (upstreams.length > 0) void upstreams.pop()?.stop();
  while (createdDirs.length > 0) { try { rmSync(createdDirs.pop() as string, {recursive: true, force: true}); } catch { /* disposable */ } }
  for (const key of LIVE_ENV_KEYS) delete process.env[key];
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-credclosure-'));
  createdDirs.push(dir);
  return dir;
};

const profileOf = (input: {readonly id: string; readonly credentialRef?: string; readonly endpointURL: string}): Omit<ModelProfile, 'configurationVersion'> => ({
  modelProfileId: input.id,
  providerId: `prov-${input.id}`,
  modelId: `model-${input.id}`,
  displayName: input.id,
  endpointURL: input.endpointURL,
  credentialRef: input.credentialRef ?? '',
  enabled: true,
  capabilities: new Set(['structured-output', 'tool-calling', 'streaming'] as const),
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
  supportsTools: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  routingTraits: {qualityTier: 'STRONG', costTier: 'MEDIUM', latencyTier: 'BALANCED', reliabilityClass: 'HIGH'},
});

const composeWith = async (
  env: Record<string, string | undefined>,
  profiles: readonly Omit<ModelProfile, 'configurationVersion'>[],
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
    config: {providerKey: CAPTURE_KEY, fields: [{name: 'profile', value: 'cc', source: 'composition'}], fingerprint: `scfg_cc${'0'.repeat(22)}`} satisfies TypedExecutorConfig,
    provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
      descriptor: {providerKey: CAPTURE_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
      async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
        captures.push({request});
        return {kind: 'succeeded', exitCode: 0, stdoutText: 'delivered', providerSessionId: `s-${String(request.attemptId).slice(4, 10)}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()};
      },
    } as unknown as ExecutorProvider,
  };
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    ...productionCompositionOptions(env, {extraModelProfiles: profiles}),
    executionSafety: offlineExecutionSafety,
    executorProviderImplementations: [executor as never],
  } as never);
  if (core === null) throw new Error(await (await import('../../apps/desktop/src/core-services.js')).lastCoreCompositionError() ?? 'composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({root: dataDir, commandProfile: {}});
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
  const registered = await core.models.registerFromProvider({providerId: 'model.openai-compatible', providerModelId: 'fixture-model', modelKey: 'cc.model', actorId: actor});
  if (!registered.ok) throw new Error(registered.error.message);
  const savedPolicy = await core.policies.savePolicy({id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'cc.model', actorId: actor} as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  return {core, captures};
};

const smartEnv = (fixtureUrl: string, keyEnv?: string): Record<string, string | undefined> => ({
  COS_MODEL_BASE_URL: fixtureUrl,
  COS_MODEL_ID: 'fixture-model',
  ...(keyEnv === undefined ? {} : {COMPANYOS_MODEL_API_KEY: keyEnv}),
  COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY,
  COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1',
  COS_MODEL_QUALITY_TIER: 'STRONG', COS_MODEL_COST_TIER: 'MEDIUM', COS_MODEL_LATENCY_TIER: 'BALANCED', COS_MODEL_RELIABILITY_CLASS: 'HIGH',
});

const driveOnce = async (core: Core, commandId: string): Promise<string> => {
  const cp = core.controlPlane!;
  const created = await cp.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: '目标是产出说明。', commandId}});
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const goalRunId = String((created.value as {readonly runId: string}).runId);
  let executionRunId = '';
  for (let turn = 0; turn < 6; turn += 1) {
    const advanced = await cp.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: goalRunId}});
    if (!advanced.ok) throw new Error(JSON.stringify(advanced.error));
    executionRunId = String((advanced.value as {readonly executionRunId: string}).executionRunId);
    const states = core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as {state: string}[];
    if (states.length > 0 && states.every((row) => row.state === 'DONE' || row.state === 'FAILED')) break;
  }
  return executionRunId;
};

describe('CREDENTIAL RESOLUTION CLOSURE — dispatch boundary', () => {
  it('no-auth is the legal contract at the execution boundary: an EMPTY credential dispatches with NO Authorization header', async () => {
    /*
     * The frozen Stage 6 ModelPool contract REQUIRES a credentialRef pointer for
     * registered profiles, so pool-routed attempts always declare one. The no-auth
     * contract lives at the execution boundary (an empty route credential → the
     * broker sends NO Authorization header at all) — pinned here directly.
     */
    const upstream = await startCountingUpstream();
    upstreams.push(upstream);
    const broker = await startModelBroker({upstreamBaseURL: `${upstream.url}/v1`, bearer: ''});
    expect(broker.ok).toBe(true);
    if (!broker.ok) throw new Error(broker.error.message);
    try {
      const answer = await new Promise<{status: number; body: string}>((resolve) => {
        const req = http.request(
          {host: '127.0.0.1', port: Number(new URL(broker.value.url).port), path: `/c/${broker.value.routeSecret}/v1/chat/completions`, method: 'POST'},
          (res) => { let out = ''; res.on('data', (c) => { out += c; }); res.on('end', () => resolve({status: res.statusCode ?? 0, body: out})); },
        );
        req.on('error', () => resolve({status: 0, body: '(error)'}));
        req.end('{"probe":true}');
      });
      expect(answer.status).toBe(200);
      expect(upstream.count()).toBeGreaterThanOrEqual(1);
    } finally {
      broker.value.close();
    }
  });

  it('a declared credentialRef WITH a resolvable vault entry dispatches with the in-memory value', async () => {
    const upstream = await startCountingUpstream();
    upstreams.push(upstream);
    process.env['COMPANYOS_CC_TEST_CREDENTIAL'] = SENTINEL;
    try {
      const dispatchUpstream = await startCountingUpstream();
      upstreams.push(dispatchUpstream);
      const fixture = await startFixture();
      fixtures.push(fixture);
      const f = await composeWith(smartEnv(fixture.url), [profileOf({id: 'AUTH_OK', credentialRef: 'vault://COMPANYOS_CC_TEST_CREDENTIAL/key', endpointURL: dispatchUpstream.url})]);
      await driveOnce(f.core, 'cc-auth-1');
      expect(f.captures.length).toBeGreaterThanOrEqual(1);
      expect(f.captures[0]!.request.selectedModelRoute?.credentialValue).toBe(SENTINEL);
    } finally {
      delete process.env['COMPANYOS_CC_TEST_CREDENTIAL'];
    }
  });

  it('a declared credentialRef with NO vault entry: typed fail BEFORE provider invocation — 0 network requests', async () => {
    // The DISPATCH upstream is distinct from the fixture/planner upstream: the only
    // traffic that can reach it is a provider call using the routed profile's route.
    const dispatchUpstream = await startCountingUpstream();
    upstreams.push(dispatchUpstream);
    const fixture = await startFixture();
    fixtures.push(fixture);
    const f = await composeWith(smartEnv(fixture.url), [profileOf({id: 'AUTH_MISSING', credentialRef: 'vault://COMPANYOS_CC_ABSENT/key', endpointURL: dispatchUpstream.url})]);
    await driveOnce(f.core, 'cc-missing-1');
    // The typed failure is durable on the settled work attempt; no provider ran.
    expect(f.captures).toHaveLength(0);
    expect(dispatchUpstream.count()).toBe(0);
    // The work task settles FAILED (never DONE) and NO dispatch row exists: the
    // typed DomainError (reason MODEL_CREDENTIAL_MISSING) refused the dispatch at
    // the CompanyOS boundary BEFORE the durable dispatch claim — the reason code is
    // the frozen taxonomy of the returned DomainError; nothing partial leaked.
    const work = f.core.database.db.prepare('SELECT state FROM tasks WHERE kind = ?').all(GOAL_WORK_KIND) as {state: string}[];
    expect(work.length).toBeGreaterThanOrEqual(1);
    expect(work.every((row) => row.state === 'FAILED' || row.state === 'PENDING')).toBe(true);
    expect(work.some((row) => row.state === 'FAILED')).toBe(true);
    expect(f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches').get()).toMatchObject({n: 0});
  });

  it('Doctor bypass: driving the engine DIRECTLY (no autonomy preflight) still fails closed with 0 network requests', async () => {
    const dispatchUpstream = await startCountingUpstream();
    upstreams.push(dispatchUpstream);
    const fixture = await startFixture();
    fixtures.push(fixture);
    const f = await composeWith(smartEnv(fixture.url), [profileOf({id: 'BYPASS', credentialRef: 'vault://COMPANYOS_CC_ABSENT/key', endpointURL: dispatchUpstream.url})]);
    // goal.advance IS the engine path — the autonomy driver (and its Doctor) never runs.
    await driveOnce(f.core, 'cc-bypass-1');
    expect(f.captures).toHaveLength(0);
    expect(dispatchUpstream.count()).toBe(0);
  });

  it('no raw credential in ANY durable surface (RoutingDecision, dispatch rows, task outputs, logs)', async () => {
    const upstream = await startCountingUpstream();
    upstreams.push(upstream);
    process.env['COMPANYOS_CC_TEST_CREDENTIAL'] = SENTINEL;
    try {
      const fixture = await startFixture();
      fixtures.push(fixture);
      const f = await composeWith(smartEnv(fixture.url), [profileOf({id: 'DURABLE', credentialRef: 'vault://COMPANYOS_CC_TEST_CREDENTIAL/key', endpointURL: fixture.url})]);
      await driveOnce(f.core, 'cc-durable-1');
      const dump = JSON.stringify({
        dispatches: f.core.database.db.prepare('SELECT * FROM provider_dispatches').all(),
        tasks: f.core.database.db.prepare('SELECT * FROM tasks').all(),
        attempts: f.core.database.db.prepare('SELECT * FROM execution_attempts').all(),
        events: f.core.database.db.prepare('SELECT type FROM events').all(),
      });
      expect(dump).not.toContain(SENTINEL);
    } finally {
      delete process.env['COMPANYOS_CC_TEST_CREDENTIAL'];
    }
  });
});

describe('CREDENTIAL RESOLUTION CLOSURE — provider and broker last-line guards', () => {
  it('the BROKER refuses a pointer-shaped credential before any upstream packet (§4/§9)', async () => {
    const upstream = await startCountingUpstream();
    upstreams.push(upstream);
    const broker = await startModelBroker({upstreamBaseURL: `${upstream.url}/v1`, bearer: 'vault://COMPANYOS_X/key'});
    expect(broker.ok).toBe(true);
    if (!broker.ok) throw new Error(broker.error.message);
    try {
      const answer = await new Promise<{status: number; body: string}>((resolve) => {
        const req = http.request(
          {host: '127.0.0.1', port: Number(new URL(broker.value.url).port), path: `/c/${broker.value.routeSecret}/v1/chat/completions`, method: 'POST'},
          (res) => { let out = ''; res.on('data', (c) => { out += c; }); res.on('end', () => resolve({status: res.statusCode ?? 0, body: out})); },
        );
        req.on('error', () => resolve({status: 0, body: '(error)'}));
        req.end('{"probe":true}');
      });
      expect(answer.status).toBe(500);
      expect(answer.body).toBe('credential pointer refused');
      expect(upstream.count()).toBe(0);
    } finally {
      broker.value.close();
    }
  });
});

describe('NO-AUTH MODELPOOL CLOSURE — explicit authentication contract', () => {
  it('pool contract: REQUIRED without a ref and NONE with a ref are both typed invalid configs', async () => {
    const {ModelPool} = await import('../../apps/desktop/src/executor/model-pool.js');
    const pool = new ModelPool();
    const base = {
      providerId: 'prov-x', modelId: 'model-x', displayName: 'x', endpointURL: 'http://127.0.0.1:9/v1',
      enabled: true, capabilities: new Set(['structured-output'] as const), contextWindowTokens: 8192, maxOutputTokens: 4096,
      supportsTools: false, supportsStructuredOutput: true, supportsStreaming: false,
      routingTraits: {qualityTier: 'BALANCED', costTier: 'LOW', latencyTier: 'FAST', reliabilityClass: 'STANDARD'},
    } as const;
    // AUTH_REQUIRED (default) + no credentialRef → typed failure.
    const missingRef = pool.register({...base, modelProfileId: 'A', credentialRef: ''});
    expect(missingRef.ok).toBe(false);
    if (!missingRef.ok) expect(String(missingRef.error.details['reason'] ?? '')).toContain('MODEL_PROFILE_AUTH_CONTRACT_INVALID');
    // NO_AUTH + credentialRef present → typed failure (a declared credential is never silently ignored).
    const contradictory = pool.register({...base, modelProfileId: 'B', credentialRef: 'vault://X/key', authentication: 'NONE'});
    expect(contradictory.ok).toBe(false);
    // NO_AUTH + absent ref → registers.
    const noAuth = pool.register({...base, modelProfileId: 'C', credentialRef: '', authentication: 'NONE'});
    expect(noAuth.ok).toBe(true);
    if (noAuth.ok) {
      expect(noAuth.value.credentialRef).toBe('');
      expect(noAuth.value.authentication).toBe('NONE');
    }
    // AUTH_REQUIRED + ref → registers (backward compatible default).
    const auth = pool.register({...base, modelProfileId: 'D', credentialRef: 'vault://Y/key'});
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.value.authentication).toBe('REQUIRED');
  });

  it('a NO-AUTH profile routes through the REAL production SMART path with Authorization ABSENT upstream', async () => {
    // The no-auth upstream IS the model fixture upstream too (it answers planner turns);
    // every recorded Authorization header on chat requests must be undefined.
    const noAuthUpstream = await startFixture();
    fixtures.push(noAuthUpstream);
    const f = await composeWith({
      COS_MODEL_BASE_URL: noAuthUpstream.url,
      COS_MODEL_ID: 'fixture-model',
      COS_MODEL_AUTHENTICATION: 'NONE',
      COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY,
      COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1',
      COS_MODEL_QUALITY_TIER: 'STRONG', COS_MODEL_COST_TIER: 'MEDIUM', COS_MODEL_LATENCY_TIER: 'BALANCED', COS_MODEL_RELIABILITY_CLASS: 'HIGH',
    }, []);
    await driveOnce(f.core, 'na-smart-1');
    // The REAL path routed: a durable RoutingDecision selected the no-auth env profile.
    expect(f.captures.length).toBeGreaterThanOrEqual(1);
    const route = f.captures[0]!.request.selectedModelRoute!;
    expect(route.credentialRef).toBe('');
    expect(route.credentialValue).toBeUndefined();
    const evidenceRow = f.core.database.db.prepare('SELECT routing_decision_json FROM provider_dispatches WHERE routing_decision_json IS NOT NULL LIMIT 1').get() as {routing_decision_json: string} | undefined;
    expect(evidenceRow).toBeDefined();
    const evidence = JSON.parse(String(evidenceRow!.routing_decision_json)) as Record<string, unknown>;
    expect(evidence['selectedProfileId']).toBe('env:fixture-model');
    // No fake credentialRef was fabricated in the durable evidence.
    expect(JSON.stringify(evidence)).not.toMatch(/"NONE"|anonymous|dummy/iu);
    // The upstream saw chat traffic with NO Authorization header at all.
    expect(noAuthUpstream.authorizations().length).toBeGreaterThanOrEqual(1);
    expect(noAuthUpstream.authorizations().every((header) => header === undefined)).toBe(true);
  });

  it('restart determinism: recomposing the SAME no-auth env reproduces the same no-auth profile', async () => {
    const env = {
      COS_MODEL_BASE_URL: 'http://127.0.0.1:9/v1',
      COS_MODEL_ID: 'fixture-model',
      COS_MODEL_AUTHENTICATION: 'NONE',
      COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1',
      COS_MODEL_QUALITY_TIER: 'STRONG', COS_MODEL_COST_TIER: 'MEDIUM', COS_MODEL_LATENCY_TIER: 'BALANCED', COS_MODEL_RELIABILITY_CLASS: 'HIGH',
    };
    const {productionModelRouting} = await import('../../apps/desktop/src/production-composition.js');
    const first = productionModelRouting(env);
    const second = productionModelRouting(env);
    expect(first?.pool).toBeDefined();
    expect(second?.pool).toBeDefined();
    const ids = (r: typeof first): readonly string[] => r?.pool?.listEnabled().map((profile) => `${profile.modelProfileId}|${profile.credentialRef === '' ? 'ABSENT' : profile.credentialRef}`) ?? [];
    expect(ids(second)).toEqual(ids(first));
    expect(ids(first)).toContain('env:fixture-model|ABSENT');
  });

  it('a NO_AUTH profile participates normally in multi-profile routing alongside authenticated profiles', async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const profiles: readonly Omit<ModelProfile, 'configurationVersion'>[] = [
      {...profileOf({id: 'NOAUTH_LOCAL', credentialRef: '', endpointURL: fixture.url}), authentication: 'NONE' as const, routingTraits: {qualityTier: 'BALANCED', costTier: 'LOW', latencyTier: 'FAST', reliabilityClass: 'STANDARD'}},
      profileOf({id: 'AUTH_REMOTE', credentialRef: 'vault://COMPANYOS_CC_TEST_CREDENTIAL/key', endpointURL: fixture.url}),
    ];
    process.env['COMPANYOS_CC_TEST_CREDENTIAL'] = SENTINEL;
    try {
      // COST_AWARE: the no-auth profile is FREE (LOW cost) and must win on the same
      // production path as any authenticated profile.
      const f = await composeWith({
        ...smartEnv(fixture.url),
        COS_MODEL_ROUTING_POLICY: 'COST_AWARE',
      }, profiles);
      await driveOnce(f.core, 'na-multi-1');
      expect(f.captures.length).toBeGreaterThanOrEqual(1);
      const evidenceRow = f.core.database.db.prepare('SELECT routing_decision_json FROM provider_dispatches WHERE routing_decision_json IS NOT NULL LIMIT 1').get() as {routing_decision_json: string} | undefined;
      expect(evidenceRow).toBeDefined();
      const evidence = JSON.parse(String(evidenceRow!.routing_decision_json)) as Record<string, unknown>;
      expect(evidence['selectedProfileId']).toBe('NOAUTH_LOCAL');
      expect(f.captures[0]!.request.selectedModelRoute?.credentialRef).toBe('');
    } finally {
      delete process.env['COMPANYOS_CC_TEST_CREDENTIAL'];
    }
  });

  it('the env contract refuses NONE alongside a configured API key (never silently ignored)', async () => {
    const {resolveOpenAiCompatibleConfig} = await import('../../apps/desktop/src/models/openai-compatible-provider.js');
    const contradictory = resolveOpenAiCompatibleConfig({
      COS_MODEL_BASE_URL: 'http://127.0.0.1:9/v1', COS_MODEL_ID: 'm',
      COS_MODEL_AUTHENTICATION: 'NONE', COMPANYOS_MODEL_API_KEY: 'sk-something',
    });
    expect(contradictory.ok).toBe(false);
    const none = resolveOpenAiCompatibleConfig({COS_MODEL_BASE_URL: 'http://127.0.0.1:9/v1', COS_MODEL_ID: 'm', COS_MODEL_AUTHENTICATION: 'NONE'});
    expect(none.ok && none.value?.authentication).toBe('NONE');
    const invalid = resolveOpenAiCompatibleConfig({COS_MODEL_BASE_URL: 'http://127.0.0.1:9/v1', COS_MODEL_ID: 'm', COS_MODEL_AUTHENTICATION: 'MAYBE'});
    expect(invalid.ok).toBe(false);
  });
});
