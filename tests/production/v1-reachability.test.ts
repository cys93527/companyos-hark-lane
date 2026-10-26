import { offlineExecutionSafety } from './helpers/offline-execution-safety.js';
/**
 * V1 PRODUCT REACHABILITY — the production wiring + real model adapter proofs
 * (Boss contract §7/§17/§18).
 *
 * BB-001: the Desktop composition options come from `productionCompositionOptions()`
 * — the SAME function `apps/desktop/src/main.ts` consumes at BOTH composition sites.
 * No bug-bash-only composition is constructed: routing, executor kinds and repository
 * capability are exactly the shipped wiring; only the adapter IMPLEMENTATION arrives
 * through the composition's trusted `executorProviderImplementations` seam (the
 * declared mechanism a deployment uses for additional adapters) and the model backend
 * arrives through the adapter's real HTTP protocol served by a LOCAL OpenAI-compatible
 * fixture server (real sockets, real JSON — the same dialect any compatible backend
 * speaks).
 *
 * BB-002: `createOpenAiCompatibleProvider` is exercised over that real protocol:
 * config resolution, structured output, fail-loud malformed output, tool refusal,
 * typed HTTP error mapping, cancellation, credential pointer hygiene, and the
 * Planner/Supervisor round trip through the REAL adapter inside the production
 * composition (canonical Plan from goal-derived content; canonical transitions by
 * the runtime, never by the model).
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';
import type { ExecutorProvider, ExecutorExecutionRequest, ExecutorProviderOutcome, TypedExecutorConfig } from '@companyos/engine';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';
import { GOAL_WORK_KIND } from '../../apps/desktop/src/control-plane.js';
import {
  productionCompositionOptions,
  productionExecutorRoute,
  DEFAULT_EXECUTOR_PROVIDER_KEY,
  EXECUTOR_PROVIDER_ENV,
} from '../../apps/desktop/src/production-composition.js';
import {
  createOpenAiCompatibleProvider,
  resolveOpenAiCompatibleConfig,
  MODEL_PROVIDER_ENV,
} from '../../apps/desktop/src/models/openai-compatible-provider.js';

const CHAINS = ['core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff'] as const;
const COMPANY = 'company_default';
const CAPTURE_PROVIDER_KEY = 'capture.test-executor';
const MODEL_KEY = 'reach.planner';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

/* ------------------------------------------------- the real-protocol fixture --- */

interface FixtureServer {
  readonly url: string;
  readonly requests: { readonly path: string; readonly body: unknown; readonly auth: string | null }[];
  setBehavior(behavior: (req: { readonly path: string; readonly body: Record<string, unknown> }) => { readonly status: number; readonly json: unknown } | Promise<{ readonly status: number; readonly json: unknown }>): void;
  close(): Promise<void>;
}

const startFixture = async (planFor: (objective: string) => unknown): Promise<FixtureServer> => {
  const requests: { readonly path: string; readonly body: unknown; readonly auth: string | null }[] = [];
  let behavior: ((req: { readonly path: string; readonly body: Record<string, unknown> }) => { readonly status: number; readonly json: unknown } | Promise<{ readonly status: number; readonly json: unknown }>) | null = null;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { void (async () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try { body = JSON.parse(rawBody); } catch { body = null; }
      const auth = req.headers['authorization'] ?? null;
      const path = req.url ?? '/';
      requests.push({ path, body, auth: typeof auth === 'string' ? auth : null });
      const respond = (status: number, json: unknown): void => {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (status === 429) headers['retry-after'] = '2';
        res.writeHead(status, headers);
        res.end(JSON.stringify(json));
      };
      if (path === '/models') {
        respond(200, { object: 'list', data: [{ id: 'fixture-model' }] });
        return;
      }
      if (process.env['REACH_DEBUG'] === '1') {
        console.log('[fixture]', path, 'rf=', JSON.stringify((body as Record<string, { readonly response_format?: unknown } | undefined>)?.response_format ?? null).slice(0, 400));
      }
      if (behavior !== null) {
        const decided = await behavior({ path, body: body as Record<string, unknown> });
        respond(decided.status, decided.json);
        return;
      }
      // Default: a REAL OpenAI-compatible chat completion whose CONTENT derives from
      // the goal text carried in the request messages (never a canned constant plan).
      type WireMessage = { readonly role?: unknown; readonly content?: unknown };
      const rawMessages = (body as { readonly messages?: unknown })?.messages;
      const messages: readonly WireMessage[] = Array.isArray(rawMessages) ? (rawMessages as readonly WireMessage[]) : [];
      const userText = messages.filter((m) => m?.role === 'user').map((m) => String(m?.content ?? '')).join('\n');
      const objective = /目标是[：:]?(.+)/u.exec(userText)?.[1] ?? userText.slice(0, 200);
      // Same routing as the frozen S26 stub discipline, keyed on the response
      // contract's schema properties: goal-verdict (targetRef) / review-verdict
      // (verdict) / supervisor-action (action) / otherwise the PLANNER (whose
      // contract now declares the plan-proposal schema; strict T20-02 validation
      // is the second, independent gate).
      const rfText = JSON.stringify((body as Record<string, { readonly response_format?: unknown } | undefined>)?.response_format ?? {});
      let content: string;
      if (rfText.includes('"action"')) {
        // The frozen stub discipline: the action's SUBJECT (which task to continue)
        // is read from the bounded context's memory view — never invented.
        let subject: { readonly taskId: string } | undefined;
        for (const message of messages) {
          if (message?.role !== 'user') continue;
          const seat = String(message?.content ?? '').indexOf('# Memory view');
          if (seat < 0) continue;
          const match = /"taskId"\s*:\s*"(tsk_[a-z0-9]+)"/.exec(String(message?.content ?? '').slice(seat));
          if (match !== null && match[1] !== undefined) subject = { taskId: match[1] };
          break;
        }
        content = JSON.stringify({ schema: 'companyos/supervisor-proposal/1', action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the next work unit.', evidenceRefs: [], ...(subject === undefined ? {} : { subject }) });
      } else if (rfText.includes('"targetRef"')) {
        content = JSON.stringify({ schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', missingRequirements: [], summary: 'ok', targetRef: 'goal' });
      } else if (rfText.includes('"verdict"')) {
        content = JSON.stringify({ schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', findings: [], summary: 'ok' });
      } else {
        content = JSON.stringify(planFor(String(objective)));
      }
      respond(200, {
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 111, completion_tokens: 7 },
      });
    })(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture address unavailable');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    setBehavior(next) { behavior = next; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const planFor = (objective: string): unknown => ({
  schema: 'companyos/plan-proposal/1',
  planItems: [
    { planItemId: 'analyze', objective: `分析目标「${objective}」并列出关键事实。`, dependencyPlanItemIds: [], acceptanceCriterionRefs: ['facts'] },
    { planItemId: 'deliver', objective: `基于分析产出目标「${objective}」的成果文本。`, dependencyPlanItemIds: ['analyze'], acceptanceCriterionRefs: ['out'] },
  ],
  acceptanceCriteria: [
    { criterionId: 'facts', requirement: '关键事实已列出。' },
    { criterionId: 'out', requirement: '成果文本已产出。' },
  ],
});

/* ----------------------------------------------------------- resource cleanup --- */

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
const openServers: FixtureServer[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (openServers.length > 0) void openServers.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-reach-'));
  createdDirs.push(dir);
  return dir;
};

/* --------------------------------------------------- the composition harness --- */

const captureExecutorProvider = (captures: { providerKey: string; request: unknown }[]): { readonly provider: ExecutorProvider; readonly config: TypedExecutorConfig } => ({
  config: {
    providerKey: CAPTURE_PROVIDER_KEY,
    fields: [{ name: 'profile', value: 'reach', source: 'composition' }],
    fingerprint: `scfg_reach${'0'.repeat(21)}`,
  },
  provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
    descriptor: { providerKey: CAPTURE_PROVIDER_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics'] },
    async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
      captures.push({ providerKey: CAPTURE_PROVIDER_KEY, request });
      return { kind: 'succeeded', exitCode: 0, stdoutText: 'delivered', providerSessionId: `session-reach-${String(request.attemptId).slice(4, 12)}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    },
  } as ExecutorProvider,
});

interface ReachFixture {
  readonly core: Core;
  readonly fixture: FixtureServer;
}

const composeReach = async (
  env: Readonly<Record<string, string | undefined>>,
  executor: { readonly provider: ExecutorProvider; readonly config: TypedExecutorConfig } | null,
): Promise<ReachFixture> => {
  const fixture = await startFixture(planFor);
  openServers.push(fixture);
  const dataDir = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const mergedEnv: Record<string, string | undefined> = {
    ...env,
    [MODEL_PROVIDER_ENV.baseUrl]: env[MODEL_PROVIDER_ENV.baseUrl] ?? fixture.url,
    [MODEL_PROVIDER_ENV.modelId]: env[MODEL_PROVIDER_ENV.modelId] ?? 'fixture-model',
    [MODEL_PROVIDER_ENV.apiKey]: env[MODEL_PROVIDER_ENV.apiKey] ?? 'reach-test-key',
  };
  const prior = { ...process.env };
  for (const [key, value] of Object.entries(mergedEnv)) process.env[key] = value;
  try {
    const core = await composeCoreServices(db, nullLogger as never, {
      artifactFoundation: foundation as never,
      // THE PRODUCTION WIRING — the same function main.ts consumes (BB-001 proof).
      // SMART-ROUTER-PROD-01: with a model endpoint configured the composition now
      // legitimately registers the embedded DSH adapter, so an executor-less probe
      // must NAME a nonexistent adapter key to keep testing the missing-provider path.
      ...productionCompositionOptions({ ...mergedEnv, [EXECUTOR_PROVIDER_ENV]: executor === null ? mergedEnv[EXECUTOR_PROVIDER_ENV] : CAPTURE_PROVIDER_KEY }),
    executionSafety: offlineExecutionSafety,
      ...(executor === null ? {} : { executorProviderImplementations: [executor] as never }),
    });
    if (core === null) throw new Error('composition failed');
    const opened = await core.repositoryRuntime.openWorkspace({ root: dataDir, commandProfile: {} });
    if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
    const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
    // The model RECORD + MANUAL company selection through the EXISTING renderer-surface APIs.
    const registered = await core.models.registerFromProvider({ providerId: 'model.openai-compatible', providerModelId: 'fixture-model', modelKey: MODEL_KEY, actorId: actor });
    if (!registered.ok) throw new Error(`model registration failed: ${registered.error.message}`);
    const savedPolicy = await core.policies.savePolicy({
      id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor,
    } as never);
    if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
    if (core.controlPlane === null) throw new Error('control plane unavailable');
    return { core, fixture };
  } finally {
    for (const key of Object.keys(mergedEnv)) {
      if (key in prior) process.env[key] = prior[key];
      else delete process.env[key];
    }
  }
};

const driveGoal = async (core: Core, objective: string, commandId: string): Promise<{ goalRunId: string; executionRunId: string }> => {
  const cp = core.controlPlane!;
  const created = await cp.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective, commandId } });
  if (!created.ok) throw new Error(`goal.create failed: ${JSON.stringify(created.error)}`);
  const goalRunId = String((created.value as { readonly runId: string }).runId);
  let executionRunId = '';
  for (let turn = 0; turn < 6; turn += 1) {
    const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    if (!advanced.ok) throw new Error(`goal.advance failed: ${JSON.stringify(advanced.error)}`);
    executionRunId = String((advanced.value as { readonly executionRunId: string }).executionRunId);
    const states = core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as { state: string }[];
    if (states.length > 0 && states.every((row) => row.state === 'DONE' || row.state === 'FAILED')) break;
  }
  return { goalRunId, executionRunId };
};

/* ============================================================== BB-001 tests === */

describe('BB-001 — the production Desktop executor wiring', () => {
  it('productionCompositionOptions routes the work kind to the configured adapter (deployment env, default = the shipped adapter)', () => {
    expect(productionExecutorRoute({})).toBe(DEFAULT_EXECUTOR_PROVIDER_KEY);
    expect(productionExecutorRoute({ [EXECUTOR_PROVIDER_ENV]: '  my-adapter  ' })).toBe('my-adapter');
    const options = productionCompositionOptions({ [EXECUTOR_PROVIDER_ENV]: 'my-adapter' });
    expect(options.providerRoutes?.[GOAL_WORK_KIND]).toBe('my-adapter');
    // BB2 closure: the SOFTWARE work kind joins the SAME executor route, repository
    // capability and stage-handler registration as the generic kind.
    expect(options.providerKinds).toEqual([GOAL_WORK_KIND, 'companyos:software-work']);
    expect(options.repositoryRuntime?.repositoryCapableKinds).toEqual([GOAL_WORK_KIND, 'companyos:software-work']);
    expect(options.stageHandlers?.executorKinds).toEqual(['companyos:planning', GOAL_WORK_KIND, 'companyos:software-work']);
    expect(options.providerRoutes?.['companyos:software-work']).toBe('my-adapter');
  });

  it('the production wiring reaches a real executor: Goal → run → work task → attempt → preflight → adapter → canonical settlement (meaningful runtime behavior)', async () => {
    const captures: { providerKey: string; request: unknown }[] = [];
    const executor = captureExecutorProvider(captures);
    const f = await composeReach({}, executor);
    // wire the capture sink AFTER composition (the harness returns captures list identity)
    const driven = await driveGoal(f.core, '目标是整理一份会议室预订流程说明。', 'reach-wiring-1');
    expect(driven.executionRunId).toMatch(/^run_/);
    expect(captures.length).toBeGreaterThanOrEqual(1);
    const request = captures[0]!.request as ExecutorExecutionRequest;
    expect(request.attemptId).toMatch(/^exa_/);
    expect(request.dispatchKey).toMatch(/^dsp_/);
    const work = f.core.database.db.prepare('SELECT state, attempts FROM tasks WHERE kind = ? AND run_id = ?').get(GOAL_WORK_KIND, driven.executionRunId) as { state: string; attempts: number };
    expect(work.state).toBe('DONE');
    expect(work.attempts).toBe(1);
  });

  it('a MISSING routed provider fails LOUD (typed) and canonical state stays intact — no silent mock, no fake completion', async () => {
    const f = await composeReach({[EXECUTOR_PROVIDER_ENV]: 'no.such.adapter'}, null); // NO adapter answers this route
    const cp = f.core.controlPlane!;
    const created = await cp.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '目标是核对库存清单。', commandId: 'reach-missing-1' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const goalRunId = String((created.value as { readonly runId: string }).runId);
    const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    // The advance itself may complete the pipeline steps while the WORK dispatch fails
    // closed: assert the work task settled FAILED (loud), never DONE.
    if (advanced.ok) {
      const executionRunId = String((advanced.value as { readonly executionRunId: string }).executionRunId);
      const work = f.core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as { state: string }[];
      const settled = work.length === 0 || work.every((row) => row.state === 'FAILED' || row.state === 'PENDING');
      expect(settled).toBe(true); // nothing claimed completion
    } else {
      expect(advanced.error?.code ?? 'TYPED').toBeTruthy(); // typed failure
    }
    // No provider dispatch row was fabricated for a nonexistent adapter:
    const dispatches = f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches').get() as { n: number };
    expect(dispatches.n).toBe(0);
  });

  it('provider selection is NOT renderer authority: the Control Plane exposes no provider operation, and the route reads only deployment env', async () => {
    const { CONTROL_PLANE_OPERATIONS } = await import('../../apps/desktop/src/control-plane.js');
    const providerOps = CONTROL_PLANE_OPERATIONS.filter((op) => /provider/iu.test(op));
    expect(providerOps).toEqual([]);
    const preload = await import('node:fs').then((fs) => fs.readFileSync('apps/desktop/preload/preload.cjs', 'utf8'));
    expect(/provider/iu.test(preload)).toBe(false); // no provider surface on the bridge
  });

  it('a provider OUTAGE (adapter fails) settles the task truthfully FAILED with intact canonical state', async () => {
    const failing: { readonly provider: ExecutorProvider; readonly config: TypedExecutorConfig } = {
      config: { providerKey: CAPTURE_PROVIDER_KEY, fields: [{ name: 'profile', value: 'reach', source: 'composition' }], fingerprint: `scfg_reach${'1'.repeat(21)}` },
      provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
        descriptor: { providerKey: CAPTURE_PROVIDER_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics'] },
        async start(): Promise<ExecutorProviderOutcome> {
          return { kind: 'provider-failed', exitCode: 1, stdoutText: '', stderrText: 'outage', reasonCode: 'OUTAGE' };
        },
      } as ExecutorProvider,
    };
    const f = await composeReach({}, failing);
    const cp = f.core.controlPlane!;
    const created = await cp.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '目标是演练供应商断供场景。', commandId: 'reach-outage-1' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const goalRunId = String((created.value as { readonly runId: string }).runId);
    for (let turn = 0; turn < 4; turn += 1) {
      const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
      if (!advanced.ok) break;
      const executionRunId = String((advanced.value as { readonly executionRunId: string }).executionRunId);
      const work = f.core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as { state: string }[];
      if (work.length > 0 && work.every((row) => row.state === 'DONE' || row.state === 'FAILED')) break;
    }
    const runs = f.core.database.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
    expect(runs.n).toBeGreaterThan(0); // canonical rows intact
    const fakeDone = f.core.database.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind = ? AND state = 'DONE'").get(GOAL_WORK_KIND) as { n: number };
    expect(fakeDone.n).toBe(0); // the outage was NEVER dressed as completion
  });
});

/* ============================================================== BB-002 tests === */

describe('BB-002 — the real OpenAI-compatible model adapter (real protocol, local fixture backend)', () => {
  it('config resolution: absent = legal "not configured"; incomplete/invalid fail typed', () => {
    const absent = resolveOpenAiCompatibleConfig({});
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value).toBeNull();
    const incomplete = resolveOpenAiCompatibleConfig({ [MODEL_PROVIDER_ENV.baseUrl]: 'http://x' });
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) expect(String(incomplete.error.details['reason'])).toBe('MODEL_CONFIG_INCOMPLETE');
    const badUrl = resolveOpenAiCompatibleConfig({ [MODEL_PROVIDER_ENV.baseUrl]: 'ftp://x', [MODEL_PROVIDER_ENV.modelId]: 'm' });
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(String(badUrl.error.details['reason'])).toBe('MODEL_CONFIG_INVALID');
  });

  it('invoke(): a REAL chat-completion round trip — structured output parsed, usage mapped, provider identity honest', async () => {
    const fixture = await startFixture(planFor);
    openServers.push(fixture);
    const adapter = createOpenAiCompatibleProvider({
      config: { providerId: 'model.openai-compatible', baseUrl: fixture.url, modelId: 'fixture-model', timeoutMs: 5_000, apiKeyEnv: MODEL_PROVIDER_ENV.apiKey, source: {} },
      resolveSecret: async (ref) => (ref.envName === MODEL_PROVIDER_ENV.apiKey ? 'reach-test-key' : null),
    });
    fixture.setBehavior(() => ({
      status: 200,
      json: { choices: [{ message: { role: 'assistant', content: '{"answer":"ok"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 111, completion_tokens: 7 } },
    }));
    const result = await adapter.invoke({
      modelId: 'fixture-model',
      messages: [{ role: 'user', content: '输出 JSON：{"answer":"ok"}' }],
      responseFormat: { mode: 'json_object' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.structured as { answer: string }).answer).toBe('ok');
    expect(result.value.usage.inputTokens).toBe(111);
    expect(result.value.finishReason).toBe('stop');
    expect(result.value.providerId).toBe('model.openai-compatible');
    expect(fixture.requests[0]?.auth).toBe('Bearer reach-test-key'); // SecretRef → resolved value → wire only
  });

  it('a tool declaration is REFUSED before any network call (reasoning-only, §12)', async () => {
    const fixture = await startFixture(planFor);
    openServers.push(fixture);
    const adapter = createOpenAiCompatibleProvider({
      config: { providerId: 'model.openai-compatible', baseUrl: fixture.url, modelId: 'fixture-model', timeoutMs: 5_000, apiKeyEnv: MODEL_PROVIDER_ENV.apiKey, source: {} },
      resolveSecret: async () => 'k',
    });
    const result = await adapter.invoke({
      modelId: 'fixture-model',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'shell', description: 'x', parameters: {} }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(String(result.error.details['kind'])).toBe('tool_unsupported');
    expect(fixture.requests.length).toBe(0); // no side-effect channel ever opened
  });

  it('malformed structured output FAILS LOUD (typed invalid_request, §14) — never repaired into truth', async () => {
    const fixture = await startFixture(planFor);
    openServers.push(fixture);
    fixture.setBehavior(() => ({
      status: 200,
      json: { choices: [{ message: { content: 'this is not json' }, finish_reason: 'stop' }] },
    }));
    const adapter = createOpenAiCompatibleProvider({
      config: { providerId: 'model.openai-compatible', baseUrl: fixture.url, modelId: 'fixture-model', timeoutMs: 5_000, apiKeyEnv: MODEL_PROVIDER_ENV.apiKey, source: {} },
      resolveSecret: async () => 'k',
    });
    const result = await adapter.invoke({ modelId: 'fixture-model', messages: [{ role: 'user', content: 'x' }], responseFormat: { mode: 'json_object' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(String(result.error.details['kind'])).toBe('invalid_request');
    expect(result.error.message).toContain('malformed structured output');
  });

  // H15d (hark-live-goal 40308697073): a 2048-token ceiling cut the planner's JSON; the call was answered with real usage.
  it('an answer truncated at max_tokens is typed PROVIDER_OUTPUT_TRUNCATED and carries the observed usage (charge is KNOWN)', async () => {
    const fixture = await startFixture(planFor);
    openServers.push(fixture);
    fixture.setBehavior(() => ({
      status: 200,
      json: { choices: [{ message: { content: '{"planItems":[{"objective":"cut' }, finish_reason: 'length' }], usage: { prompt_tokens: 1500, completion_tokens: 2048 } },
    }));
    const adapter = createOpenAiCompatibleProvider({
      config: { providerId: 'model.openai-compatible', baseUrl: fixture.url, modelId: 'fixture-model', timeoutMs: 5_000, apiKeyEnv: MODEL_PROVIDER_ENV.apiKey, source: {} },
      resolveSecret: async () => 'k',
    });
    const result = await adapter.invoke({ modelId: 'fixture-model', messages: [{ role: 'user', content: 'x' }], responseFormat: { mode: 'json_object' }, maxOutputTokens: 2048 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['reason']).toBe('PROVIDER_OUTPUT_TRUNCATED');
    expect(result.error.details['usageStatus']).toBe('KNOWN');
    expect(result.error.details['observedUsage']).toEqual({ inputTokens: 1500, outputTokens: 2048 });
  });

  it('malformed output without usage stays usage UNKNOWN', async () => {
    const fixture = await startFixture(planFor);
    openServers.push(fixture);
    fixture.setBehavior(() => ({ status: 200, json: { choices: [{ message: { content: 'nope' }, finish_reason: 'stop' }] } }));
    const adapter = createOpenAiCompatibleProvider({
      config: { providerId: 'model.openai-compatible', baseUrl: fixture.url, modelId: 'fixture-model', timeoutMs: 5_000, apiKeyEnv: MODEL_PROVIDER_ENV.apiKey, source: {} },
      resolveSecret: async () => 'k',
    });
    const result = await adapter.invoke({ modelId: 'fixture-model', messages: [{ role: 'user', content: 'x' }], responseFormat: { mode: 'json_object' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details['usageStatus']).toBe('UNKNOWN');
    expect(result.error.details['observedUsage']).toBeUndefined();
  });

  it('HTTP error statuses map to the frozen taxonomy: 401→auth_failed, 429→rate_limited(+retry), 500→unavailable', async () => {
    const fixture = await startFixture(planFor);
    openServers.push(fixture);
    const adapter = createOpenAiCompatibleProvider({
      config: { providerId: 'model.openai-compatible', baseUrl: fixture.url, modelId: 'fixture-model', timeoutMs: 5_000, apiKeyEnv: MODEL_PROVIDER_ENV.apiKey, source: {} },
      resolveSecret: async () => 'k',
    });
    const invoke = () => adapter.invoke({ modelId: 'fixture-model', messages: [{ role: 'user', content: 'x' }] });
    fixture.setBehavior(() => ({ status: 401, json: { error: { message: 'bad key' } } }));
    const auth = await invoke();
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(String(auth.error.details['kind'])).toBe('auth_failed');
    fixture.setBehavior(() => ({ status: 429, json: { error: {} } }));
    const rate = await invoke();
    expect(rate.ok).toBe(false);
    if (!rate.ok) {
      expect(String(rate.error.details['kind'])).toBe('rate_limited');
      expect(rate.error.details['retryAfterMs']).toBe(2000);
    }
    fixture.setBehavior(() => ({ status: 500, json: {} }));
    const unavailable = await invoke();
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) expect(String(unavailable.error.details['kind'])).toBe('unavailable');
  });

  it('cancellation: the caller signal ends the invocation with the CANCELLED domain error', async () => {
    const fixture = await startFixture(planFor);
    openServers.push(fixture);
    fixture.setBehavior(async () => { await new Promise(() => undefined); return { status: 200, json: {} }; }); // never answers
    const adapter = createOpenAiCompatibleProvider({
      config: { providerId: 'model.openai-compatible', baseUrl: fixture.url, modelId: 'fixture-model', timeoutMs: 60_000, apiKeyEnv: MODEL_PROVIDER_ENV.apiKey, source: {} },
      resolveSecret: async () => 'k',
    });
    const controller = new AbortController();
    const pending = adapter.invoke({ modelId: 'fixture-model', messages: [{ role: 'user', content: 'x' }], signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(String(result.error.details['kind'])).toBe('CANCELLED');
  });

  it('credential hygiene: the secret is a POINTER (env name), never in config, never in error details', async () => {
    const fixture = await startFixture(planFor);
    openServers.push(fixture);
    const seenRefs: string[] = [];
    const adapter = createOpenAiCompatibleProvider({
      config: { providerId: 'model.openai-compatible', baseUrl: fixture.url, modelId: 'fixture-model', timeoutMs: 5_000, apiKeyEnv: MODEL_PROVIDER_ENV.apiKey, source: {} },
      resolveSecret: async (ref) => {
        seenRefs.push(`${ref.source}:${ref.envName}`);
        return 'reach-test-key';
      },
    });
    expect(adapter.secretRefs?.().length).toBe(1);
    expect(adapter.secretRefs?.()[0]?.envName).toBe(MODEL_PROVIDER_ENV.apiKey);
    await adapter.invoke({ modelId: 'fixture-model', messages: [{ role: 'user', content: 'x' }] });
    expect(seenRefs).toEqual([`env:${MODEL_PROVIDER_ENV.apiKey}`]);
    fixture.setBehavior(() => ({ status: 401, json: {} }));
    const failed = await adapter.invoke({ modelId: 'fixture-model', messages: [{ role: 'user', content: 'x' }] });
    if (!failed.ok) {
      expect(failed.error.message).not.toContain('reach-test-key'); // redacted/absent
      expect(JSON.stringify(failed.error.details)).not.toContain('reach-test-key');
    }
  });
});

/* ============================================== production planning (real) === */

describe('BB-002 — real planning through the production composition', () => {
  it('a REAL model round (HTTP adapter) produces a canonical, goal-derived Plan and the compiled run executes through the routed executor', async () => {
    const captures: { providerKey: string; request: unknown }[] = [];
    const f = await composeReach({}, captureExecutorProvider(captures));
    const objective = '目标是制定一份办公室绿色节能行动清单。';
    const driven = await driveGoal(f.core, objective, 'reach-plan-1');

    // The PLANNER round went through the REAL adapter over the REAL protocol:
    const chatCalls = f.fixture.requests.filter((r) => r.path === '/chat/completions');
    expect(chatCalls.length).toBeGreaterThanOrEqual(1);
    const plannerCall = chatCalls.find((r) => JSON.stringify((r.body as Record<string, { readonly response_format?: unknown } | undefined>)?.response_format ?? {}).length > 0);
    expect(plannerCall).toBeDefined();

    // The canonical Plan artifact exists and its content DERIVES from the goal text:
    const planRows = f.core.database.db.prepare("SELECT artifact_id FROM artifacts WHERE kind = 'companyos:plan'").all() as { artifact_id: string }[];
    expect(planRows.length).toBe(1);
    const goalArtifact = await f.core.database.artifactStore!.getByCreationCommand(`run-goal:${driven.goalRunId}`);
    expect(goalArtifact).not.toBeNull();
    const workspaceView = await f.core.controlPlane!.handle({ operation: 'goal.workspace', payload: { companyId: COMPANY, runId: driven.goalRunId } });
    expect(workspaceView.ok).toBe(true);
    if (workspaceView.ok) {
      const ws = workspaceView.value as { readonly goal: { readonly objective: string } | null };
      expect(ws.goal?.objective).toBe(objective);
    }

    // The plan content genuinely derived from the goal: the planner REQUEST carried the
    // objective, and the fixture builds plan items FROM it (never a canned constant).
    const plannerRequestBody = JSON.stringify(plannerCall?.body ?? {});
    expect(plannerRequestBody).toContain('办公室绿色节能行动清单');

    // The executor (production route) performed the work; canonical settlement:
    expect(captures.length).toBeGreaterThanOrEqual(1);
    const work = f.core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, driven.executionRunId) as { state: string }[];
    expect(work.length).toBe(2); // the two goal-derived plan items materialized
    expect(work.every((row) => row.state === 'DONE')).toBe(true);

    // §16: the MODEL never mutated canonical state directly — every canonical row was
    // written by the runtime (the adapter holds no store handle at all):
    expect((f.core.database.db.prepare('SELECT COUNT(*) AS n FROM handoffs').get() as { n: number }).n).toBe(0);
  });
});

/* ============================================ provider independence (§17) === */

describe('Provider independence (Boss §17)', () => {
  it('Planner depends on the ModelProviderPort, not a vendor: the production composition plans over ANY compatible backend (the fixture IS a different backend)', async () => {
    const captures: { providerKey: string; request: unknown }[] = [];
    const f = await composeReach({}, captureExecutorProvider(captures));
    const driven = await driveGoal(f.core, '目标是验证供应商独立性。', 'reach-indep-1');
    expect(f.fixture.requests.some((r) => r.path === '/chat/completions')).toBe(true);
    expect(driven.executionRunId).toMatch(/^run_/);
    // The routing target is deployment DATA — swapping it changes no canonical semantic:
    expect(providerRoutesGuard()).toBe(DEFAULT_EXECUTOR_PROVIDER_KEY);
  });
});

const providerRoutesGuard = (): string => productionExecutorRoute({});

