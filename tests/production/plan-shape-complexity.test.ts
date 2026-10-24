import { offlineExecutionSafety } from './helpers/offline-execution-safety.js';
/**
 * LIVE-SMOKE-FIX-05 — plan-shape-invariant runtime complexity derivation.
 *
 * Boss finding (mechanically confirmed): the V1 complexity input summed raw
 * presentation counts (acceptanceCriteriaCount + taskInputsCount +
 * artifactRefsCount + dependencyCount), so the SAME semantic task jumped
 * MEDIUM → VERY_HIGH — and became unroutable under a BALANCED-only pool —
 * purely because the planner split one composite criterion into five atomic
 * rows (PLAN_SHAPE_ROUTING_COMPLEXITY_INSTABILITY, P1).
 *
 * Closed contract (pinned here): DETAIL IS NOT DIFFICULTY. The ONE canonical
 * semantic complexity signal is the DISTINCT pinned-DAG predecessor stage
 * count (genuine prerequisite integration breadth, deduplicated by stage id,
 * order-free). Ladder thresholds unchanged: 0 LOW, 1 MEDIUM, 2–3 HIGH, 4+
 * VERY_HIGH. Criteria/inputs/artifact refs are validation detail and
 * normalized references — excluded by contract. Capability growth raises
 * routing demand through the router's OWN canonical hard filters, never
 * through complexity. The Smart Router algorithm, policies, weights, floors
 * and ModelProfile traits are UNCHANGED.
 */
import {createServer, type Server} from 'node:http';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {openDurableDatabase, type DurableDatabase} from '@companyos/persistence';
import {nullLogger} from '@companyos/observability';
import type {ExecutorProvider, ExecutorProviderOutcome, ExecutorExecutionRequest, TypedExecutorConfig, WorkPackage} from '@companyos/engine';

import {composeCoreServices, lastCoreCompositionError} from '../../apps/desktop/src/core-services.js';
import {openArtifactFoundation} from '../../apps/desktop/src/artifact-stack.js';
import {GOAL_WORK_KIND} from '../../apps/desktop/src/control-plane.js';
import {productionCompositionOptions} from '../../apps/desktop/src/production-composition.js';
import {observeLoopback} from '../support/loopback-observation.js';
import {compositionEvidence, safeError, trackOwnedServer} from '../support/e3-broker-evidence.js';
import {assertObservationComplete} from '../support/transport-plan-fixture.js';
import {
  complexityFactorsOfWorkPackage,
  deriveRuntimeTaskComplexity,
  explainRuntimeTaskComplexity,
  routeRuntimeAttempt,
} from '../../apps/desktop/src/executor/runtime-routing.js';
import {RoleCatalog} from '../../apps/desktop/src/executor/role-orchestration.js';
import {ModelPool} from '../../apps/desktop/src/executor/model-pool.js';
import {ROUTING_POLICIES} from '../../apps/desktop/src/executor/smart-model-router.js';

// ---------------------------------------------------------------------------
// Pure WorkPackage fixtures (deterministic literals; no DB, no model, no clock)
// ---------------------------------------------------------------------------

const dependencyOf = (stageId: string, artifactRefs: readonly string[] = [`art-${stageId}`]) => ({
  stageId,
  subjectTaskId: `tsk_${stageId}`,
  resultKind: 'work-product',
  artifactRefs: [...artifactRefs],
  validationRefs: [],
});

const pkgOf = (input: {
  readonly criteria?: readonly {criterionId: string; requirement: string}[];
  readonly taskInputs?: Readonly<Record<string, unknown>>;
  readonly dependencies?: readonly ReturnType<typeof dependencyOf>[];
}): WorkPackage => ({
  contract: 'companyos/work-package/1',
  identity: {
    companyId: 'company_fixture',
    runId: 'run_fixture',
    taskId: 'tsk_fixture',
    stageId: 'stg_fixture',
    templateId: 'tpl_fixture',
    workflowVersionId: 'ver_fixture',
  },
  goal: {objective: 'Deliver the CLI.', structured: null, sourceType: null, sourceRef: null},
  work: {objective: 'Deliver the CLI.', taskInputs: input.taskInputs ?? {}},
  execution: {roleId: 'drole_fixture', taskKind: 'companyos:work', maxAttempts: 3, professionalResponsibility: null},
  acceptance: {
    criteria: [...(input.criteria ?? [{criterionId: 'c1', requirement: 'c1 met.'}])],
    validatorRefs: [],
  },
  dependencies: [...(input.dependencies ?? [])],
  causal: null,
  handoff: [],
  provenance: {
    snapshotId: 'snap_fixture',
    stageSource: 'pinned-workflow-version',
    dependencySource: 'pinned-workflow-version-dag',
    handoffSource: 'handoff-chain-absent',
  },
  observational: {taskState: 'READY'},
});

const criteria = (count: number): {criterionId: string; requirement: string}[] =>
  Array.from({length: count}, (_, index) => ({criterionId: `c${String(index + 1)}`, requirement: `c${String(index + 1)} met.`}));

const balancedFloorOf = (complexity: ReturnType<typeof deriveRuntimeTaskComplexity>): string =>
  ROUTING_POLICIES['BALANCED']!.complexityAdjustment.minimumQualityByComplexity[complexity];

// ---------------------------------------------------------------------------
// Metamorphic invariance (representation changes NEVER change complexity)
// ---------------------------------------------------------------------------

describe('LIVE-SMOKE-FIX-05 — metamorphic invariance', () => {
  it('§12 criteria split: one composite criterion vs five equivalent atomic criteria → SAME complexity', () => {
    const composite = pkgOf({criteria: criteria(1), dependencies: [dependencyOf('s1')]});
    const atomic = pkgOf({criteria: criteria(5), dependencies: [dependencyOf('s1')]});
    const a = deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(composite));
    const b = deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(atomic));
    expect(a).toBe(b);
    expect(a).toBe('MEDIUM'); // one genuine prerequisite — not five validation rows' worth of difficulty
  });

  it('§13 criteria duplicates: one criterion vs the same criterion repeated → SAME complexity', () => {
    const once = pkgOf({criteria: criteria(1)});
    const repeated = pkgOf({criteria: [...criteria(1), ...criteria(1), ...criteria(1)]});
    expect(deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(repeated)))
      .toBe(deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(once)));
  });

  it('§14 ordering: dependencies, criteria and inputs in a different order → SAME complexity, SAME explanation', () => {
    const ordered = pkgOf({criteria: criteria(3), taskInputs: {alpha: 1, beta: 2}, dependencies: [dependencyOf('s1'), dependencyOf('s2')]});
    const shuffled = pkgOf({criteria: [...criteria(3)].reverse(), taskInputs: {beta: 2, alpha: 1}, dependencies: [dependencyOf('s2'), dependencyOf('s1')]});
    expect(deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(shuffled)))
      .toBe(deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(ordered)));
    expect(explainRuntimeTaskComplexity(shuffled)).toEqual(explainRuntimeTaskComplexity(ordered));
  });

  it('§15 presentation expansion: concise vs verbose shape of the SAME semantic package → SAME complexity AND SAME quality floor', () => {
    const concise = pkgOf({criteria: criteria(1), taskInputs: {}, dependencies: [dependencyOf('s1', ['a1'])]});
    const verbose = pkgOf({
      criteria: criteria(5),
      taskInputs: {alpha: 1, beta: 2, gamma: 3},
      dependencies: [dependencyOf('s1', ['a1', 'a2', 'a3', 'a4'])],
    });
    const a = deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(concise));
    const b = deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(verbose));
    expect(b).toBe(a);
    expect(balancedFloorOf(b)).toBe(balancedFloorOf(a)); // the router sees the identical floor
  });

  it('§8 duplicates never inflate: duplicated artifact refs and a duplicated stage id count ONCE', () => {
    const clean = pkgOf({dependencies: [dependencyOf('s1', ['a1'])]});
    const noisy = pkgOf({dependencies: [dependencyOf('s1', ['a1', 'a1', 'a2']), dependencyOf('s1', ['a1'])]});
    expect(complexityFactorsOfWorkPackage(noisy)).toEqual({dependencyCount: 1});
    expect(deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(noisy)))
      .toBe(deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(clean)));
  });

  it('§7 monotonicity: splitting criteria never raises complexity; adding a GENUINE new prerequisite stage may', () => {
    const oneCriterionTwoDeps = pkgOf({criteria: criteria(1), dependencies: [dependencyOf('s1'), dependencyOf('s2')]});
    const splitCriterionTwoDeps = pkgOf({criteria: criteria(5), dependencies: [dependencyOf('s1'), dependencyOf('s2')]});
    const threeGenuineDeps = pkgOf({criteria: criteria(1), dependencies: [dependencyOf('s1'), dependencyOf('s2'), dependencyOf('s3')]});
    const two = deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(oneCriterionTwoDeps));
    const split = deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(splitCriterionTwoDeps));
    const grown = deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(threeGenuineDeps));
    expect(split).toBe(two); // equivalent rows: never a rise
    expect(grown).toBe(two); // 2→3 genuine deps stays HIGH (documented ladder: 2–3 HIGH)
    const fourGenuineDeps = pkgOf({criteria: criteria(1), dependencies: ['s1', 's2', 's3', 's4'].map((id) => dependencyOf(id))});
    expect(deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(fourGenuineDeps))).toBe('VERY_HIGH'); // a genuine rise
  });

  it('§9 explanation: pure, safe, canonical factor labels only (never prompt/reasoning content)', () => {
    const explanation = explainRuntimeTaskComplexity(pkgOf({dependencies: [dependencyOf('s2'), dependencyOf('s1')]}));
    expect(explanation.complexity).toBe('HIGH');
    expect(explanation.semanticFactors).toEqual(['dag-predecessor:s1', 'dag-predecessor:s2']); // sorted, deduped, canonical ids
  });
});

// ---------------------------------------------------------------------------
// Genuine complexity preservation (the correction must NOT flatten the world)
// ---------------------------------------------------------------------------

describe('LIVE-SMOKE-FIX-05 — genuine complexity preservation', () => {
  it('§16 true dependency growth ladder: 0 LOW / 1 MEDIUM / 2 HIGH / 3 HIGH / 4+ VERY_HIGH', () => {
    const at = (count: number) =>
      deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(
        pkgOf({dependencies: Array.from({length: count}, (_, index) => dependencyOf(`s${String(index + 1)}`))}),
      ));
    expect(at(0)).toBe('LOW');
    expect(at(1)).toBe('MEDIUM');
    expect(at(2)).toBe('HIGH');
    expect(at(3)).toBe('HIGH');
    expect(at(4)).toBe('VERY_HIGH');
    expect(at(16)).toBe('VERY_HIGH'); // the Work Package predecessor bound keeps the class reachable
  });

  it('§18 HIGH reachable: integrating two genuine producer stages is structurally HIGH and floors at BALANCED (FIX-07 decoupling: breadth != intelligence)', () => {
    const integration = pkgOf({dependencies: [dependencyOf('impl'), dependencyOf('test')]});
    const complexity = deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(integration));
    expect(complexity).toBe('HIGH');
    // LIVE-SMOKE-FIX-07: HIGH no longer implies STRONG — the Smoke-06 `tests` item
    // (2 genuine predecessors) must route a BALANCED profile. STRONG stays reserved
    // for VERY_HIGH and the independent quality filters (below).
    expect(balancedFloorOf(complexity)).toBe('BALANCED');
  });

  it('§18 VERY_HIGH reachable: release assembly over four producers demands STRONG', () => {
    const assembly = pkgOf({dependencies: ['impl', 'test', 'docs', 'pkg'].map((id) => dependencyOf(id))});
    const complexity = deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(assembly));
    expect(complexity).toBe('VERY_HIGH');
    expect(balancedFloorOf(complexity)).toBe('STRONG');
  });

  it('§17 capability growth raises routing demand through the CANONICAL hard filter — complexity unchanged', () => {
    const simple = pkgOf({criteria: criteria(5)}); // verbose presentation, zero prerequisites
    expect(deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(simple))).toBe('LOW');
    const pool = new ModelPool();
    pool.register({
      modelProfileId: 'balanced-local', providerId: 'prov-local', modelId: 'm1', displayName: 'balanced-local',
      endpointURL: 'http://127.0.0.1:9/v1', credentialRef: '', authentication: 'NONE', enabled: true,
      capabilities: new Set(['tool-calling', 'structured-output', 'streaming'] as const),
      contextWindowTokens: 8192, maxOutputTokens: 4096,
      supportsTools: true, supportsStructuredOutput: true, supportsStreaming: true,
      routingTraits: {qualityTier: 'BALANCED', costTier: 'MEDIUM', latencyTier: 'BALANCED', reliabilityClass: 'STANDARD'},
    });
    const base = {attemptId: 'att_1', taskId: 'tsk_1', roleId: 'drole_seat', runId: 'run_1', companyId: 'company_fixture', workPackage: simple};
    // Without the capability demand: the single BALANCED profile routes fine.
    const plain = routeRuntimeAttempt({pool, catalog: new RoleCatalog(), ...base});
    expect(plain.ok).toBe(true);
    // With a genuinely stronger capability demand the profile does not satisfy: the
    // router's OWN hard filter rejects it — routing demand rose, complexity did not.
    const demanding = routeRuntimeAttempt({
      pool, catalog: new RoleCatalog(), ...base,
      pinnedResponsibility: {responsibilityIntent: 'Long-context archival analysis.', requiredCapabilities: ['long-context']},
    });
    expect(demanding.ok).toBe(false);
    if (!demanding.ok) {
      expect(String((demanding.error as {details?: Record<string, unknown>}).details?.['reason'] ?? '')).toBe('MODEL_CAPABILITY_MISMATCH');
      const rejected = (demanding.error as {details?: Record<string, unknown>}).details?.['rejectedCandidates'] as {reason: string}[] | undefined;
      expect(rejected?.[0]?.reason).toBe('MISSING_REQUIRED_CAPABILITY');
    }
    expect(deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(simple))).toBe('LOW'); // still LOW — no double punishment
  });
});

// ---------------------------------------------------------------------------
// Router end-to-end eligibility (single-profile production-shaped pool)
// ---------------------------------------------------------------------------

const singleProfilePool = (qualityTier: 'BALANCED' | 'STRONG' = 'BALANCED'): ModelPool => {
  const pool = new ModelPool();
  pool.register({
    modelProfileId: 'env:fixture-model', providerId: 'prov-env', modelId: 'fixture-model', displayName: 'fixture',
    endpointURL: 'http://127.0.0.1:9/v1', credentialRef: '', authentication: 'NONE', enabled: true,
    capabilities: new Set(['tool-calling', 'structured-output', 'streaming'] as const),
    contextWindowTokens: 8192, maxOutputTokens: 4096,
    supportsTools: true, supportsStructuredOutput: true, supportsStreaming: true,
    routingTraits: {qualityTier, costTier: 'MEDIUM', latencyTier: 'BALANCED', reliabilityClass: 'STANDARD'},
  });
  return pool;
};

describe('LIVE-SMOKE-FIX-05 — Smart Router eligibility (router/policies/traits unchanged)', () => {
  it('a semantically SIMPLE verbose task (five criteria, extra inputs, multi-ref artifacts) routes BALANCED-eligible through the real router', () => {
    // The exact Smoke-04 PRESENTATION shape: no longer a false rejection.
    const verboseSimple = pkgOf({
      criteria: criteria(5),
      taskInputs: {alpha: 1, beta: 2},
      dependencies: [dependencyOf('s1', ['a1', 'a2', 'a3'])],
    });
    const routed = routeRuntimeAttempt({
      pool: singleProfilePool('BALANCED'),
      catalog: new RoleCatalog(),
      attemptId: 'att_eligible', taskId: 'tsk_eligible', roleId: 'drole_seat',
      runId: 'run_eligible', companyId: 'company_fixture',
      workPackage: verboseSimple,
    });
    expect(routed.ok).toBe(true);
    if (routed.ok) {
      expect(routed.value.decision.taskComplexity).toBe('MEDIUM'); // 1 genuine prerequisite
      expect(routed.value.decision.eligibleCandidates).toEqual(['env:fixture-model']);
      expect(routed.value.decision.rejectedCandidates).toEqual([]);
      expect(routed.value.decision.selectedModelProfileId).toBe('env:fixture-model');
      expect(routed.value.decision.decisionPolicy).toBe('hard-filter-and-weighted-score'); // no deterministic bypass
    }
  });

  it('a genuinely broad integration (four predecessors) with a BALANCED-only pool fails TYPED at the complexity floor — the guard is preserved', () => {
    const assembly = pkgOf({dependencies: ['impl', 'test', 'docs', 'pkg'].map((id) => dependencyOf(id))});
    const routed = routeRuntimeAttempt({
      pool: singleProfilePool('BALANCED'),
      catalog: new RoleCatalog(),
      attemptId: 'att_rejected', taskId: 'tsk_rejected', roleId: 'drole_seat',
      runId: 'run_rejected', companyId: 'company_fixture',
      workPackage: assembly,
    });
    expect(routed.ok).toBe(false);
    if (!routed.ok) {
      expect(String((routed.error as {details?: Record<string, unknown>}).details?.['reason'] ?? '')).toBe('MODEL_CAPABILITY_MISMATCH');
      const rejected = (routed.error as {details?: Record<string, unknown>}).details?.['rejectedCandidates'] as {reason: string}[] | undefined;
      expect(rejected?.[0]?.reason).toBe('QUALITY_BELOW_COMPLEXITY_MINIMUM'); // the honest, genuine floor rejection
    }
  });
});

// ---------------------------------------------------------------------------
// Production path regression — Smoke-03/04 deterministic planner shapes
// ---------------------------------------------------------------------------

const COMPANY = 'company_default';
const CAPTURE_KEY = 'capture.pshape';
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

/**
 * The two canonical smoke planner shapes, same semantic Goal:
 *  - 'smoke04': ONE work item with FIVE acceptance criterion refs (the exact
 *    Smoke-04 presentation that used to derive VERY_HIGH and false-reject BALANCED).
 *  - 'smoke03': the concise two-item chain (one criterion each) — the Smoke-03-style
 *    planner representation of the same semantic work.
 */
type SmokeShape = 'smoke04' | 'smoke03';
const startFixture = async (shape: SmokeShape) => {
  const observation = observeLoopback(expect.getState().currentTestName ?? 'PLAN_SHAPE_TEST_NOT_OBSERVED');
  observation.emit('fixture-start', {shape, worker: process.env['VITEST_POOL_ID'] ?? 'NOT_OBSERVED'});
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
        const plan = shape === 'smoke04'
          ? {
              schema: 'companyos/plan-proposal/1',
              planItems: [{planItemId: 'p1', objective: 'Deliver the CLI.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['c1', 'c2', 'c3', 'c4', 'c5']}],
              acceptanceCriteria: ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({criterionId: id, requirement: `${id} met.`})),
            }
          : {
              schema: 'companyos/plan-proposal/1',
              planItems: [
                {planItemId: 'build', objective: 'Deliver the CLI.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['b1']},
                {planItemId: 'check', objective: 'Verify the delivered CLI.', dependencyPlanItemIds: ['build'], acceptanceCriterionRefs: ['k1']},
              ],
              acceptanceCriteria: [
                {criterionId: 'b1', requirement: 'b1 met.'},
                {criterionId: 'k1', requirement: 'k1 met.'},
              ],
            };
        content = JSON.stringify(plan);
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({object: 'chat.completion', choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}], usage: {prompt_tokens: 9, completion_tokens: 9}}));
    });
  });
  observation.attach(server);
  const owner = trackOwnedServer(server, observation.emit);
  fixtures.push({close: async () => {
    const errors: unknown[] = [];
    try { await owner.close(); } catch (error) { errors.push(error); }
    observation.dispose();
    try { assertObservationComplete(observation.directory); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Plan shape Server close/evidence failed');
  }});
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no fixture address');
  return {url: `http://127.0.0.1:${String(address.port)}`, observation};
};

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;
const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
const fixtures: {close: () => Promise<void>}[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(fixtures.splice(0).map(fixture => fixture.close()));
  const errors = results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason);
  // Hook errors are additional failures, never replacements for the body failure.
  if (!errors.length) {
    while (openDatabases.length > 0) { try { openDatabases.pop()?.close(); } catch (error) { errors.push(error); } }
    if (!errors.length) while (createdDirs.length > 0) {
      try { rmSync(createdDirs.pop() as string, {recursive: true, force: true}); } catch (error) { errors.push(error); }
    }
  }
  for (const key of LIVE_ENV_KEYS) delete process.env[key];
  if (errors.length) throw new AggregateError(errors, 'Plan shape fixture cleanup failed; uncertain resources retained');
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-pshape-'));
  createdDirs.push(dir);
  return dir;
};

const composeWith = async (
  shape: SmokeShape,
): Promise<{core: Core; captures: {readonly request: ExecutorExecutionRequest}[]; dataDir: string}> => {
  const fixture = await startFixture(shape);
  const dataDir = tempDir();
  const workspaceRoot = join(dataDir, 'ws');
  mkdirSync(workspaceRoot, {recursive: true});
  const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
  openDatabases.push(db);
  createdDirs.push(`${dataDir}-cas`);
  const foundation = await openArtifactFoundation({casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never});
  if (!foundation.ok) throw new Error('foundation failed');
  const captures: {readonly request: ExecutorExecutionRequest}[] = [];
  const executor = {
    config: {providerKey: CAPTURE_KEY, fields: [{name: 'profile', value: 'pshape', source: 'composition'}], fingerprint: `scfg_pshape${'0'.repeat(20)}`} satisfies TypedExecutorConfig,
    provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
      descriptor: {providerKey: CAPTURE_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
      async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
        captures.push({request});
        return {kind: 'succeeded', exitCode: 0, stdoutText: 'delivered', providerSessionId: `s-${String(request.attemptId).slice(4, 10)}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()};
      },
    } as unknown as ExecutorProvider,
  };
  // The LIVE-equivalent operator contract: SMART routing, BALANCED traits — the
  // exact configuration Smoke-04 ran when the false rejection fired.
  const envForCompose: Record<string, string | undefined> = {
    COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'fixture-model', COMPANYOS_MODEL_API_KEY: 'pshape-local',
    COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY,
    COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'BALANCED',
    COS_MODEL_QUALITY_TIER: 'BALANCED', COS_MODEL_COST_TIER: 'MEDIUM', COS_MODEL_LATENCY_TIER: 'BALANCED',
    COS_MODEL_RELIABILITY_CLASS: 'STANDARD', COS_MODEL_AUTHENTICATION: 'REQUIRED',
  };
  for (const [key, value] of Object.entries(envForCompose)) if (value !== undefined) process.env[key] = value;
  const evidence = compositionEvidence(fixture.observation.emit, ['pshape-local']);
  evidence.record('compose-enter', {phase: 'core-services', modelEndpoint: fixture.url});
  const core = await composeCoreServices(evidence.database(db), evidence.logger as never, {
    artifactFoundation: foundation as never,
    ...productionCompositionOptions(envForCompose),
    executionSafety: offlineExecutionSafety,
    executorProviderImplementations: [executor as never],
  } as never);
  evidence.record('compose-return', {result: core === null ? 'NULL' : 'SERVICES', unobservedStages: 'NOT_OBSERVED'});
  if (core === null) {
    evidence.record('compose-failed', {error: safeError(lastCoreCompositionError() ?? 'composition failed', ['pshape-local']), boundaries: evidence.records.slice(-16)});
    throw new Error(lastCoreCompositionError() ?? 'composition failed');
  }
  const opened = await core.repositoryRuntime.openWorkspace({root: workspaceRoot, commandProfile: {}});
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
  const registered = await core.models.registerFromProvider({providerId: 'model.openai-compatible', providerModelId: 'fixture-model', modelKey: 'pshape.model', actorId: actor});
  if (!registered.ok) throw new Error(registered.error.message);
  const savedPolicy = await core.policies.savePolicy({id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'pshape.model', actorId: actor} as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  return {core, captures, dataDir};
};

const driveGoal = async (core: Core, commandId: string, maxTurns = 12): Promise<string> => {
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

const routingEvidenceRows = (core: Core): {attempt_id: string; routing_decision_json: string}[] =>
  core.database.db.prepare('SELECT attempt_id, routing_decision_json FROM provider_dispatches WHERE routing_decision_json IS NOT NULL ORDER BY attempt_id').all() as {attempt_id: string; routing_decision_json: string}[];

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

describe('LIVE-SMOKE-FIX-05 — production path (Smoke-03/04 deterministic shapes, BALANCED traits)', () => {
  it('Smoke-04 shape: five acceptance criteria ALONE no longer reject BALANCED — full Goal→dispatch→receipt through the real path', {timeout: 180_000}, async () => {
    const f = await composeWith('smoke04');
    const executionRunId = await driveGoal(f.core, 'pshape-s4-1');
    expect(executionRunId).toMatch(/^run_/);
    // The work COMPLETES: the presentation shape routed BALANCED-eligible.
    const states = f.core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as {state: string}[];
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states.every((row) => row.state === 'DONE')).toBe(true);
    expect(f.captures.length).toBeGreaterThanOrEqual(1);
    // §21: the NORMAL production path reached SmartRouter → RoutingDecision → dispatch (no deterministic bypass).
    const evidenceRows = routingEvidenceRows(f.core);
    expect(evidenceRows.length).toBe(f.captures.length);
    const evidence = JSON.parse(evidenceRows[0]!.routing_decision_json) as Record<string, unknown>;
    expect(evidence['policyId']).toBe('BALANCED');
    expect(evidence['selectedProfileId']).toBe('env:fixture-model');
    expect(evidence['taskComplexity']).toBe('LOW'); // false inflation removed: criteria are validation detail
    // Success earns its receipt.
    const effects = receiptEffectsOf(f.core, `${f.dataDir}-cas`);
    expect(effects.some((effect) => effect.endsWith(':completed'))).toBe(true);
  });

  it('Smoke-03 shape: the concise chain derives LOW/MEDIUM — the SAME semantic floor as the verbose shape', {timeout: 180_000}, async () => {
    const f = await composeWith('smoke03');
    const executionRunId = await driveGoal(f.core, 'pshape-s3-1');
    expect(executionRunId).toMatch(/^run_/);
    const states = f.core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as {state: string}[];
    expect(states.length).toBe(2);
    expect(states.every((row) => row.state === 'DONE')).toBe(true);
    expect(f.captures.length).toBeGreaterThanOrEqual(2);
    const evidenceRows = routingEvidenceRows(f.core);
    expect(evidenceRows.length).toBe(f.captures.length);
    const complexities = evidenceRows.map((row) => String((JSON.parse(row.routing_decision_json) as Record<string, unknown>)['taskComplexity'])).sort();
    // build (0 predecessors) LOW; check (1 predecessor) MEDIUM — both floors at or below BALANCED.
    expect(complexities).toEqual(['LOW', 'MEDIUM']);
    for (const row of evidenceRows) {
      const evidence = JSON.parse(row.routing_decision_json) as Record<string, unknown>;
      expect(evidence['selectedProfileId']).toBe('env:fixture-model');
    }
    const effects = receiptEffectsOf(f.core, `${f.dataDir}-cas`);
    expect(effects.some((effect) => effect.endsWith(':completed'))).toBe(true);
  });

  it('floor equivalence: the verbose Smoke-04 shape and the concise Smoke-03 shape impose the SAME BALANCED policy floor', () => {
    // The pure-mechanics proof behind the two production runs above: every class
    // either shape can derive (LOW/MEDIUM) floors at or below BALANCED.
    expect(balancedFloorOf('LOW')).toBe('ECONOMY');
    expect(balancedFloorOf('MEDIUM')).toBe('BALANCED');
  });
});
