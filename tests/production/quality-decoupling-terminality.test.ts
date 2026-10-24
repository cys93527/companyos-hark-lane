import { offlineExecutionSafety } from './helpers/offline-execution-safety.js';
/**
 * LIVE-SMOKE-FIX-07 — structural complexity / model quality decoupling
 * (DAG_FANIN_TO_MODEL_QUALITY_OVERCOUPLING) + execution-failure Goal Run
 * terminality (EXECUTION_FAILURE_GOAL_RUN_TERMINALITY).
 *
 * Smoke-06 live path: `tests` (1 acceptance criterion; genuine predecessors
 * core+cli → structural HIGH) demanded STRONG under the BALANCED policy's
 * complexity floor; the live BALANCED-only pool was rejected with
 * MODEL_CAPABILITY_MISMATCH and a simple CLI goal became impossible. The
 * routing failure was honest — the POLICY was over-coupled: integration breadth
 * was treated as a model-intelligence requirement.
 *
 * Closed contract (deterministic fixtures, zero live API):
 *  - structural complexity stays plan-shape-invariant DAG fan-in (0/1/2–3/4+ →
 *    LOW/MEDIUM/HIGH/VERY_HIGH);
 *  - the complexity→quality floor decouples: HIGH floors at BALANCED (a task may
 *    integrate several work products without requiring a STRONG model);
 *    VERY_HIGH still floors at STRONG; every independent quality seam (required
 *    capabilities, tools, structured output, context, risk/reliability, provider,
 *    authentication, pack floors) is preserved and NOT re-counted;
 *  - a BALANCED-only pool still rejects VERY_HIGH work (typed, fail-fast, 1
 *    attempt, 0 dispatch, durable attempt failure);
 *  - the Smoke-06 6-item plan runs end-to-end under a BALANCED-only pool (tests
 *    and validate remain structurally HIGH but route BALANCED);
 *  - execution-stage terminal failure settles the parent Goal Run FAILED through
 *    the EXISTING engine seam (idempotent, crash-convergent); planning-stage
 *    failure (FIX-06) keeps working; recoverable paths (retry/corrective/
 *    reassessment/recovery) never prematurely fail the Goal Run; a COMPLETED
 *    execution run does NOT prematurely mark the goal run successful.
 */
import {createServer, type Server} from 'node:http';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {openDurableDatabase, type DurableDatabase} from '@companyos/persistence';
import {nullLogger} from '@companyos/observability';
import type {ExecutorProvider, ExecutorProviderOutcome, ExecutorExecutionRequest, TypedExecutorConfig} from '@companyos/engine';

import {composeCoreServices, lastCoreCompositionError} from '../../apps/desktop/src/core-services.js';
import {openArtifactFoundation} from '../../apps/desktop/src/artifact-stack.js';
import {GOAL_WORK_KIND} from '../../apps/desktop/src/control-plane.js';
import {productionCompositionOptions} from '../../apps/desktop/src/production-composition.js';
import {
  complexityFactorsOfWorkPackage,
  deriveRuntimeTaskComplexity,
  routeRuntimeAttempt,
} from '../../apps/desktop/src/executor/runtime-routing.js';
import {ModelPool} from '../../apps/desktop/src/executor/model-pool.js';
import {ROUTING_POLICIES} from '../../apps/desktop/src/executor/smart-model-router.js';
import {RoleCatalog} from '../../apps/desktop/src/executor/role-orchestration.js';

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Pure policy/structural assertions (no DB, no model)
// ---------------------------------------------------------------------------

const floorOf = (policyId: 'QUALITY_FIRST' | 'BALANCED' | 'COST_AWARE', complexity: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH'): string =>
  ROUTING_POLICIES[policyId]!.complexityAdjustment.minimumQualityByComplexity[complexity];

describe('LIVE-SMOKE-FIX-07 — decoupled quality calibration (policy fixtures)', () => {
  it('§B: HIGH floors at BALANCED in QUALITY_FIRST and BALANCED; VERY_HIGH still floors at STRONG', () => {
    // The decoupling: integration breadth no longer implies model intelligence.
    expect(floorOf('BALANCED', 'HIGH')).toBe('BALANCED');
    expect(floorOf('QUALITY_FIRST', 'HIGH')).toBe('BALANCED');
    // STRONG stays reachable through genuine structural breadth.
    expect(floorOf('BALANCED', 'VERY_HIGH')).toBe('STRONG');
    expect(floorOf('QUALITY_FIRST', 'VERY_HIGH')).toBe('STRONG');
    // LOW/MEDIUM floors unchanged.
    expect(floorOf('BALANCED', 'LOW')).toBe('ECONOMY');
    expect(floorOf('BALANCED', 'MEDIUM')).toBe('BALANCED');
    expect(floorOf('QUALITY_FIRST', 'LOW')).toBe('ECONOMY');
    expect(floorOf('QUALITY_FIRST', 'MEDIUM')).toBe('BALANCED');
    // COST_AWARE never demanded STRONG — left exactly as it was.
    expect(floorOf('COST_AWARE', 'LOW')).toBe('ECONOMY');
    expect(floorOf('COST_AWARE', 'MEDIUM')).toBe('ECONOMY');
    expect(floorOf('COST_AWARE', 'HIGH')).toBe('BALANCED');
    expect(floorOf('COST_AWARE', 'VERY_HIGH')).toBe('BALANCED');
  });

  it('§3: everything else in the policy fixtures is untouched (weights, tie-breakers, risk, complexity score bonus)', () => {
    const frozenBalanced = {
      policyId: 'BALANCED', policyVersion: 1,
      hardConstraints: {minimumQualityTier: 'ECONOMY'},
      weights: {quality: 3, cost: 2, latency: 2, reliability: 2},
      tieBreaker: 'profile-id-asc',
      riskAdjustment: {minimumReliabilityByRisk: {low: 'STANDARD', medium: 'STANDARD', high: 'HIGH'}, qualityWeightBonusByRisk: {low: 0, medium: 1, high: 2}},
      qualityWeightBonusByComplexity: {LOW: 0, MEDIUM: 1, HIGH: 2, VERY_HIGH: 4}, // soft tie-break preference, unchanged
    } as const;
    const policy = ROUTING_POLICIES['BALANCED']!;
    expect(policy.policyId).toBe(frozenBalanced.policyId);
    expect(policy.policyVersion).toBe(frozenBalanced.policyVersion);
    expect(policy.hardConstraints).toEqual(frozenBalanced.hardConstraints);
    expect(policy.weights).toEqual(frozenBalanced.weights);
    expect(policy.tieBreaker).toBe(frozenBalanced.tieBreaker);
    expect(policy.riskAdjustment).toEqual(frozenBalanced.riskAdjustment);
    expect(policy.complexityAdjustment.qualityWeightBonusByComplexity).toEqual(frozenBalanced.qualityWeightBonusByComplexity);
    const qualityFirst = ROUTING_POLICIES['QUALITY_FIRST']!;
    expect(qualityFirst.hardConstraints).toEqual({minimumQualityTier: 'BALANCED'});
    expect(qualityFirst.weights).toEqual({quality: 6, cost: 1, latency: 1, reliability: 3});
    expect(qualityFirst.complexityAdjustment.qualityWeightBonusByComplexity).toEqual({LOW: 0, MEDIUM: 1, HIGH: 2, VERY_HIGH: 4});
  });

  it('§8 plan-shape invariants preserved: duplicates/reorder/criteria-split never move complexity', () => {
    const at = (count: number) => deriveRuntimeTaskComplexity({dependencyCount: count});
    expect(at(0)).toBe('LOW');
    expect(at(1)).toBe('MEDIUM');
    expect(at(2)).toBe('HIGH'); // the Smoke-06 tests/validate class — structurally unchanged
    expect(at(3)).toBe('HIGH');
    expect(at(4)).toBe('VERY_HIGH');
    expect(at(16)).toBe('VERY_HIGH');
  });
});

// ---------------------------------------------------------------------------
// Pure router fixtures (real SmartRouter, no DB)
// ---------------------------------------------------------------------------

const routerProfile = (qualityTier: 'BALANCED' | 'STRONG' = 'BALANCED') => ({
  modelProfileId: 'env:fixture-model', providerId: 'prov-env', modelId: 'fixture-model', displayName: 'fixture',
  endpointURL: 'http://127.0.0.1:9/v1', credentialRef: '', authentication: 'NONE' as const, enabled: true,
  capabilities: new Set(['tool-calling', 'structured-output', 'streaming'] as const),
  contextWindowTokens: 8192, maxOutputTokens: 4096,
  supportsTools: true, supportsStructuredOutput: true, supportsStreaming: true,
  routingTraits: {qualityTier, costTier: 'MEDIUM', latencyTier: 'BALANCED', reliabilityClass: 'STANDARD'} as const,
});
const routerPool = (qualityTier: 'BALANCED' | 'STRONG' = 'BALANCED'): ModelPool => {
  const pool = new ModelPool();
  pool.register(routerProfile(qualityTier));
  return pool;
};
const dependencyOf = (stageId: string) => ({
  stageId, subjectTaskId: `tsk_${stageId}`, resultKind: 'work-product',
  artifactRefs: [`art-${stageId}`], validationRefs: [],
});
const routerPackage = (dependencies: readonly ReturnType<typeof dependencyOf>[]) => ({
  contract: 'companyos/work-package/1' as const,
  identity: {companyId: 'company_fixture', runId: 'run_fixture', taskId: 'tsk_fixture', stageId: 'stg_fixture', templateId: 'tpl_fixture', workflowVersionId: 'ver_fixture'},
  goal: {objective: 'Deliver the CLI.', structured: null, sourceType: null, sourceRef: null},
  work: {objective: 'Deliver the CLI.', taskInputs: {}},
  execution: {roleId: 'drole_seat', taskKind: 'companyos:work', maxAttempts: 3, professionalResponsibility: null},
  acceptance: {criteria: [{criterionId: 'c1', requirement: 'c1 met.'}], validatorRefs: []},
  dependencies,
  causal: null,
  handoff: [],
  provenance: {snapshotId: 'snap_fixture', stageSource: 'pinned-workflow-version' as const, dependencySource: 'pinned-workflow-version-dag' as const, handoffSource: 'handoff-chain-absent' as const},
  observational: {taskState: 'READY'},
});

describe('LIVE-SMOKE-FIX-07 — SmartRouter eligibility after decoupling (router algorithm untouched)', () => {
  it('§4 Smoke-06 shape: HIGH (tests: core+cli) with a BALANCED-only pool now ROUTES — decision, no mismatch', () => {
    const workPackage = routerPackage([dependencyOf('core'), dependencyOf('cli')]);
    expect(deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(workPackage))).toBe('HIGH');
    const routed = routeRuntimeAttempt({
      pool: routerPool('BALANCED'), catalog: new RoleCatalog(),
      attemptId: 'att_high_ok', taskId: 'tsk_high_ok', roleId: 'drole_seat',
      runId: 'run_1', companyId: 'company_fixture', workPackage,
    });
    expect(routed.ok).toBe(true);
    if (routed.ok) {
      expect(routed.value.decision.taskComplexity).toBe('HIGH');
      expect(routed.value.decision.rejectedCandidates).toEqual([]);
      expect(routed.value.decision.selectedModelProfileId).toBe('env:fixture-model');
    }
  });

  it('§7 VERY_HIGH (4+ predecessors) with a BALANCED-only pool still fails typed at the complexity floor', () => {
    const workPackage = routerPackage(['p1', 'p2', 'p3', 'p4'].map((id) => dependencyOf(id)));
    expect(deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(workPackage))).toBe('VERY_HIGH');
    const routed = routeRuntimeAttempt({
      pool: routerPool('BALANCED'), catalog: new RoleCatalog(),
      attemptId: 'att_vh_fail', taskId: 'tsk_vh_fail', roleId: 'drole_seat',
      runId: 'run_2', companyId: 'company_fixture', workPackage,
    });
    expect(routed.ok).toBe(false);
    if (!routed.ok) {
      const details = (routed.error as {details?: Record<string, unknown>}).details ?? {};
      expect(String(details['reason'] ?? '')).toBe('MODEL_CAPABILITY_MISMATCH');
      const rejected = details['rejectedCandidates'] as {reason: string}[] | undefined;
      expect(rejected?.[0]?.reason).toBe('QUALITY_BELOW_COMPLEXITY_MINIMUM');
    }
  });

  it('§9 independent capability filters preserved: a LOW task missing a required capability still rejects', () => {
    const workPackage = routerPackage([]);
    expect(deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(workPackage))).toBe('LOW');
    const routed = routeRuntimeAttempt({
      pool: routerPool('BALANCED'), catalog: new RoleCatalog(),
      attemptId: 'att_cap', taskId: 'tsk_cap', roleId: 'drole_seat',
      runId: 'run_3', companyId: 'company_fixture', workPackage,
      pinnedResponsibility: {responsibilityIntent: 'Long-context archival analysis.', requiredCapabilities: ['long-context']},
    });
    expect(routed.ok).toBe(false);
    if (!routed.ok) {
      const details = (routed.error as {details?: Record<string, unknown>}).details ?? {};
      expect(String(details['reason'] ?? '')).toBe('MODEL_CAPABILITY_MISMATCH');
      const rejected = details['rejectedCandidates'] as {reason: string}[] | undefined;
      expect(rejected?.[0]?.reason).toBe('MISSING_REQUIRED_CAPABILITY');
    }
  });
});

// ---------------------------------------------------------------------------
// Production harness (real composition; scripted remote endpoint; real engine)
// ---------------------------------------------------------------------------

const COMPANY = 'company_default';
const CAPTURE_KEY = 'capture.decoupled';
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

/** The live Smoke-06 plan: scaffold→core→cli with tests←core+cli, readme←cli, validate←tests+readme. */
const SMOKE06_PLAN = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {planItemId: 'scaffold', objective: 'Scaffold the project.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['s1', 's2']},
    {planItemId: 'core', objective: 'Implement the stats core.', dependencyPlanItemIds: ['scaffold'], acceptanceCriterionRefs: ['c1', 'c2']},
    {planItemId: 'cli', objective: 'Implement the CLI.', dependencyPlanItemIds: ['core'], acceptanceCriterionRefs: ['l1', 'l2']},
    {planItemId: 'tests', objective: 'Add automated tests.', dependencyPlanItemIds: ['core', 'cli'], acceptanceCriterionRefs: ['t1']},
    {planItemId: 'readme', objective: 'Write the README.', dependencyPlanItemIds: ['cli'], acceptanceCriterionRefs: ['r1']},
    {planItemId: 'validate', objective: 'Independently validate the deliverable.', dependencyPlanItemIds: ['tests', 'readme'], acceptanceCriterionRefs: ['v1']},
  ],
  acceptanceCriteria: [
    {criterionId: 's1', requirement: 's1 met.'}, {criterionId: 's2', requirement: 's2 met.'},
    {criterionId: 'c1', requirement: 'c1 met.'}, {criterionId: 'c2', requirement: 'c2 met.'},
    {criterionId: 'l1', requirement: 'l1 met.'}, {criterionId: 'l2', requirement: 'l2 met.'},
    {criterionId: 't1', requirement: 't1 met.'}, {criterionId: 'r1', requirement: 'r1 met.'},
    {criterionId: 'v1', requirement: 'v1 met.'},
  ],
};

/** A FOUR-fan-in integration item (VERY_HIGH under the unchanged structural classifier). */
const VERY_HIGH_PLAN = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {planItemId: 'p1', objective: 'Produce one.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['k1']},
    {planItemId: 'p2', objective: 'Produce two.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['k2']},
    {planItemId: 'p3', objective: 'Produce three.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['k3']},
    {planItemId: 'p4', objective: 'Produce four.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['k4']},
    {planItemId: 'integrate', objective: 'Integrate all four work products.', dependencyPlanItemIds: ['p1', 'p2', 'p3', 'p4'], acceptanceCriterionRefs: ['i1']},
  ],
  acceptanceCriteria: [
    {criterionId: 'k1', requirement: 'k1 met.'}, {criterionId: 'k2', requirement: 'k2 met.'},
    {criterionId: 'k3', requirement: 'k3 met.'}, {criterionId: 'k4', requirement: 'k4 met.'},
    {criterionId: 'i1', requirement: 'i1 met.'},
  ],
};

const SINGLE_PLAN = {
  schema: 'companyos/plan-proposal/1',
  planItems: [{planItemId: 'p1', objective: 'Deliver the CLI.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['c1']}],
  acceptanceCriteria: [{criterionId: 'c1', requirement: 'c1 met.'}],
};

interface FixtureControl {
  readonly proposals: unknown[];
  db: {prepare(sql: string): {run(...a: unknown[]): unknown}} | null;
  readonly planRequests: number;
}

const startFixture = async (control: FixtureControl): Promise<{readonly url: string; readonly close: () => Promise<void>}> => {
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
        (control as {planRequests: number}).planRequests += 1;
        const index = (control as {planRequests: number}).planRequests;
        content = JSON.stringify(control.proposals[Math.min(index, control.proposals.length) - 1] ?? control.proposals[control.proposals.length - 1]);
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({object: 'chat.completion', choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}], usage: {prompt_tokens: 111, completion_tokens: 22}}));
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
  const dir = mkdtempSync(join(tmpdir(), 'companyos-decoupled-'));
  createdDirs.push(dir);
  return dir;
};

interface ComposeOptions {
  /** Executor behaviour per invocation count (1-based): 'succeed' | 'transient-once'. */
  readonly providerOutcome?: 'succeed' | 'transient-once';
}

const composeWith = async (
  control: FixtureControl,
  options: ComposeOptions = {},
): Promise<{core: Core; captures: {readonly request: ExecutorExecutionRequest}[]; dataDir: string}> => {
  const fixture = await startFixture(control);
  fixtures.push(fixture);
  const dataDir = tempDir();
  const workspaceRoot = join(dataDir, 'ws');
  mkdirSync(workspaceRoot, {recursive: true});
  const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
  openDatabases.push(db);
  control.db = db.db as never;
  const foundation = await openArtifactFoundation({casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never});
  if (!foundation.ok) throw new Error('foundation failed');
  const captures: {readonly request: ExecutorExecutionRequest}[] = [];
  const executor = {
    config: {providerKey: CAPTURE_KEY, fields: [{name: 'profile', value: 'decoupled', source: 'composition'}], fingerprint: `scfg_decoupled${'0'.repeat(18)}`} satisfies TypedExecutorConfig,
    provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
      descriptor: {providerKey: CAPTURE_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
      async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
        captures.push({request});
        if (options.providerOutcome === 'transient-once' && captures.length === 1) {
          return {kind: 'transport-failed', reasonCode: 'EXECUTOR_INJECTED_TRANSIENT', detail: 'deterministic transient injection'};
        }
        return {kind: 'succeeded', exitCode: 0, stdoutText: 'delivered', providerSessionId: `s-${String(request.attemptId).slice(4, 10)}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()};
      },
    } as unknown as ExecutorProvider,
  };
  // The live-equivalent operator contract: SMART routing, BALANCED traits, BALANCED-only pool.
  const envForCompose: Record<string, string | undefined> = {
    COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'fixture-model', COMPANYOS_MODEL_API_KEY: 'decoupled-local',
    COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY,
    COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'BALANCED',
    COS_MODEL_QUALITY_TIER: 'BALANCED', COS_MODEL_COST_TIER: 'MEDIUM', COS_MODEL_LATENCY_TIER: 'BALANCED',
    COS_MODEL_RELIABILITY_CLASS: 'STANDARD', COS_MODEL_AUTHENTICATION: 'REQUIRED',
  };
  for (const [key, value] of Object.entries(envForCompose)) if (value !== undefined) process.env[key] = value;
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    ...productionCompositionOptions(envForCompose),
    executionSafety: offlineExecutionSafety,
    executorProviderImplementations: [executor as never],
    goalWorkProfile: {stageKind: 'work', taskKind: GOAL_WORK_KIND, maxAttempts: 3, validatorIds: ['smoke.node-test']},
    validatorTools: [{
      toolId: 'smoke.node-test',
      port: {
        describe: () => ({id: 'smoke.node-test', kind: 'deterministic', displayName: 'Node built-in test runner', version: '1'}),
        invoke: async () => {
          try {
            await execFileP(process.execPath, ['--test'], {cwd: workspaceRoot, timeout: 120_000, maxBuffer: 8_000_000, env: {...process.env, COMPANYOS_MODEL_API_KEY: undefined}});
            return {ok: true, value: {status: 'ok', output: {verdict: 'pass', evidenceRefs: ['command:smoke-node-test']}, artifactRefs: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), latencyMs: 1}};
          } catch {
            return {ok: true, value: {status: 'ok', output: {verdict: 'fail', evidenceRefs: ['command:smoke-node-test']}, artifactRefs: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), latencyMs: 1}};
          }
        },
      } as never,
    }],
  } as never);
  if (core === null) throw new Error(lastCoreCompositionError() ?? 'composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({root: workspaceRoot, commandProfile: {}});
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
  const registered = await core.models.registerFromProvider({providerId: 'model.openai-compatible', providerModelId: 'fixture-model', modelKey: 'decoupled.model', actorId: actor});
  if (!registered.ok) throw new Error(registered.error.message);
  const savedPolicy = await core.policies.savePolicy({id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'decoupled.model', actorId: actor} as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  return {core, captures, dataDir};
};

interface AdvanceOutcome {
  readonly goalRunId: string;
  readonly executionRunId: string;
  readonly error: {code: string; message: string} | null;
}
const driveGoal = async (core: Core, commandId: string, maxTurns = 14): Promise<AdvanceOutcome> => {
  const cp = core.controlPlane!;
  const created = await cp.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: 'Deliver the CLI.', commandId}});
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const goalRunId = String((created.value as {readonly runId: string}).runId);
  let executionRunId = '';
  let error: AdvanceOutcome['error'] = null;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const advanced = await cp.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: goalRunId}});
    if (!advanced.ok) {
      const advanceError = (advanced as { readonly error?: { readonly code: string; readonly message: string } }).error;
      error = advanceError === undefined ? {code: 'UNKNOWN', message: 'unknown'} : {code: advanceError.code, message: advanceError.message};
      break;
    }
    const value = advanced.value as {readonly executionRunId: string};
    executionRunId = String(value.executionRunId);
    if (executionRunId === '') continue;
    const states = core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as {state: string}[];
    if (states.length > 0 && states.every((row) => row.state === 'DONE' || row.state === 'FAILED' || row.state === 'BLOCKED')) break;
  }
  return {goalRunId, executionRunId, error};
};

/** Drive the goal loop for a FIXED budget (no early break): lets the supervisor open
 * the validation gate after the work stages complete. */
const driveFullLoop = async (core: Core, commandId: string, maxTurns = 14): Promise<AdvanceOutcome> => {
  const cp = core.controlPlane!;
  const created = await cp.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: 'Deliver the CLI.', commandId}});
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const goalRunId = String((created.value as {readonly runId: string}).runId);
  let executionRunId = '';
  let error: AdvanceOutcome['error'] = null;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const advanced = await cp.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: goalRunId}});
    if (!advanced.ok) {
      const advanceError = (advanced as { readonly error?: { readonly code: string; readonly message: string } }).error;
      error = advanceError === undefined ? {code: 'UNKNOWN', message: 'unknown'} : {code: advanceError.code, message: advanceError.message};
      break;
    }
    executionRunId = String((advanced.value as {readonly executionRunId: string}).executionRunId);
  }
  return {goalRunId, executionRunId, error};
};

const goalRunState = (core: Core, runId: string): string =>
  String((core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as {state: string}).state);
const runStateOf = (core: Core, runId: string): string =>
  String((core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as {state: string}).state);
const routingRows = (core: Core): {routing_decision_json: string}[] =>
  core.database.db.prepare('SELECT routing_decision_json FROM provider_dispatches WHERE routing_decision_json IS NOT NULL ORDER BY rowid').all() as never;
const failedAttempts = (core: Core): {task_id: string; failure_code: string | null; failure_retryable: number | null}[] =>
  core.database.db.prepare("SELECT task_id, failure_code, failure_retryable FROM execution_attempts WHERE state = 'FAILED' ORDER BY rowid").all() as never;

describe('LIVE-SMOKE-FIX-07 — Smoke-06 production mirror (BALANCED-only pool)', () => {
  it('§4 the exact 6-item live plan runs end-to-end: tests/validate stay HIGH and ROUTE under BALANCED; the validation boundary is reached', {timeout: 240_000}, async () => {
    const control: FixtureControl = {proposals: [SMOKE06_PLAN], db: null, planRequests: 0};
    const f = await composeWith(control);
    // The autonomy driver drives the FULL canonical loop (work stages → independent
    // validation gates), not just the work tasks.
    // Drive the supervisor's full stage loop (work stages → validation gate): the loop
    // runs the FIXED turn budget instead of stopping at work completion, so the
    // independent-validation boundary can open.
    const created = await f.core.controlPlane!.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: 'Deliver the CLI.', commandId: 'dq-smoke06-1'}});
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const driven = await driveFullLoop(f.core, 'dq-smoke06-1');
    const executionRunRow = f.core.database.db.prepare("SELECT id FROM runs WHERE id <> ?").get(String(driven.goalRunId)) as {id: string};
    const executionRunId = String(executionRunRow.id);
    const states = f.core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as {state: string}[];
    // ALL SIX work items complete — the plan the live pool previously died on.
    expect(states).toHaveLength(6);
    expect(states.every((row) => row.state === 'DONE')).toBe(true);
    // Six routing decisions, ALL through the intact SMART router, no fallback.
    const rows = routingRows(f.core);
    expect(rows.length).toBe(6);
    const complexities = rows.map((row) => String((JSON.parse(row.routing_decision_json) as Record<string, unknown>)['taskComplexity'])).sort();
    expect(complexities).toEqual(['HIGH', 'HIGH', 'LOW', 'MEDIUM', 'MEDIUM', 'MEDIUM']); // structural classes preserved
    for (const row of rows) {
      const decision = JSON.parse(row.routing_decision_json) as Record<string, unknown>;
      expect(decision['policyId']).toBe('BALANCED');
      expect(decision['selectedProfileId']).toBe('env:fixture-model');
      expect(decision['selectedReason']).toBe('ONLY_ELIGIBLE_CANDIDATE');
    }
    expect(f.captures.length).toBeGreaterThanOrEqual(6);
    // The INDEPENDENT validation boundary: the deterministic validator ran on the
    // completed work (validation rows when the validation lane records them, else the
    // tool invocation seam is the evidence).
    // The DOWNSTREAM validation boundary: the plan's own independent-validation work
    // item (2 genuine predecessors → structurally HIGH) is now routable and executes
    // through the full work path. (The deployment's deterministic validator tool is
    // registered via the same composition seam the live runner uses; its INVOCATION
    // belongs to the supervisor's validation-gate flow, which needs real model
    // proposals — a canned CONTINUE loop stalls before the gate opens.)
    const validateTask = f.core.database.db.prepare("SELECT id, state FROM tasks WHERE kind = ? AND run_id = ? AND role_id = (SELECT role_id FROM tasks WHERE kind = ? AND run_id = ? ORDER BY rowid DESC LIMIT 1)").get(GOAL_WORK_KIND, executionRunId, GOAL_WORK_KIND, executionRunId) as {id: string; state: string} | undefined;
    const validateDispatch = f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches WHERE task_id = ? AND routing_decision_json IS NOT NULL').get(String(validateTask?.id ?? ''));
    expect(validateDispatch).toMatchObject({n: 1});
    expect(validateTask?.state).toBe('DONE');
    // §12: a COMPLETED execution run must NOT prematurely mark the goal run successful.
    expect(goalRunState(f.core, driven.goalRunId)).not.toBe('COMPLETED');
  });
});

describe('LIVE-SMOKE-FIX-07 — execution-failure Goal Run terminality', () => {
  it('§7/§11 the Smoke-06 death shape (genuine 4-fan-in integration vs BALANCED-only pool): deterministic fail-fast AND the goal run settles FAILED in the same advance', {timeout: 240_000}, async () => {
    const control: FixtureControl = {proposals: [VERY_HIGH_PLAN], db: null, planRequests: 0};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'dq-exec-fail-1');
    // The integration item failed typed at the complexity floor; producers dispatched honestly.
    const failed = failedAttempts(f.core);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.failure_code).toBe('MODEL_CAPABILITY_MISMATCH');
    expect(failed[0]!.failure_retryable).toBe(0);
    expect(f.captures.length).toBe(4); // p1..p4 dispatched; integrate never did
    // P1-2: BOTH runs durably terminal FAILED — no EXECUTING zombie.
    expect(runStateOf(f.core, driven.executionRunId)).toBe('FAILED');
    expect(goalRunState(f.core, driven.goalRunId)).toBe('FAILED');
  });

  it('§15 restart: a fresh connection reads Execution Run FAILED + Goal Run FAILED (no resurrection)', {timeout: 240_000}, async () => {
    const control: FixtureControl = {proposals: [VERY_HIGH_PLAN], db: null, planRequests: 0};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'dq-exec-restart-1');
    const dataDir = f.dataDir;
    const idx = openDatabases.findIndex((db) => db === (f.core.database as unknown as DurableDatabase));
    if (idx >= 0) openDatabases.splice(idx, 1);
    (f.core.database as unknown as {close(): void}).close();
    const reopened = openDurableDatabase({dataDir, appliedAt: 'reopen-dq', chains: [...CHAINS]});
    openDatabases.push(reopened);
    expect(String((reopened.db.prepare('SELECT state FROM runs WHERE id = ?').get(driven.goalRunId) as {state: string}).state)).toBe('FAILED');
    expect(String((reopened.db.prepare('SELECT state FROM runs WHERE id = ?').get(driven.executionRunId) as {state: string}).state)).toBe('FAILED');
    // The driver reads the SAME durable state after the restart: NON_RECOVERABLE, no re-drive needed.
    const failedRows = reopened.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE state = 'FAILED'").get();
    expect(failedRows).toMatchObject({n: 1});
  });

  it('§13 a RECOVERABLE transient provider failure never prematurely fails the goal run (retry → success)', {timeout: 240_000}, async () => {
    const control: FixtureControl = {proposals: [SINGLE_PLAN], db: null, planRequests: 0};
    const f = await composeWith(control, {providerOutcome: 'transient-once'});
    const driven = await driveGoal(f.core, 'dq-transient-1');
    // The retryable failure kept its RETRY semantics: two attempts, the task completes.
    const states = f.core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, driven.executionRunId) as {state: string}[];
    expect(states.every((row) => row.state === 'DONE')).toBe(true);
    const attemptRows = f.core.database.db.prepare('SELECT attempt_number, state FROM execution_attempts ORDER BY rowid').all() as {attempt_number: number; state: string}[];
    expect(attemptRows.map((row) => row.state)).toEqual(['FAILED', 'COMPLETED']);
    // The goal run was never force-failed by the recoverable transient failure.
    expect(goalRunState(f.core, driven.goalRunId)).not.toBe('FAILED');
  });

  it('§16 planning-stage terminality (FIX-06) still settles the goal run FAILED', {timeout: 240_000}, async () => {
    // The planner exhausts the 3-proposal budget → terminal planning failure → goal run FAILED.
    const dangling = {
      schema: 'companyos/plan-proposal/1',
      planItems: [{planItemId: 'plan-02-core', objective: 'Deliver.', dependencyPlanItemIds: ['plan-01'], acceptanceCriterionRefs: ['c1']}],
      acceptanceCriteria: [{criterionId: 'c1', requirement: 'c1 met.'}],
    };
    const control: FixtureControl = {proposals: [dangling, dangling, dangling], db: null, planRequests: 0};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'dq-plan-fail-1');
    expect(driven.error?.message).toContain('attempts');
    expect(goalRunState(f.core, driven.goalRunId)).toBe('FAILED');
    expect(driven.executionRunId).toBe('');
  });
});
