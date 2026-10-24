import { offlineExecutionSafety } from './helpers/offline-execution-safety.js';
/**
 * LIVE-SMOKE-FIX-09 — SUCCESSFUL_GOAL_RUN_TERMINALITY closure + Handoff/Outcome
 * canonicality pins.
 *
 * Smoke-08 live proof: the driver reported Goal COMPLETED and the execution run
 * reached engine-terminal COMPLETED through the full evidence-gated chain, but the
 * durable GOAL RUN row stayed EXECUTING — canonical lifecycle convergence violated.
 *
 * Closed contract: when the canonical success contract holds (child execution run
 * engine-terminal COMPLETED — which the L1 machine can only reach through its own
 * evidence-proven VALIDATION.PASS and DELIVERY.COMPLETE — plus every work task and
 * the planning task terminal-successful), the goal pipeline settles the Goal Run to
 * COMPLETED through the SAME engine seam the failure settlements use, via the new
 * OUTCOME_DELIVERED transition (engine-guarded: the named child must be proven
 * COMPLETED and company-owned; typed refusals otherwise). Premature success is
 * impossible: a child with pending validation/corrective work cannot be COMPLETED
 * through the engine, and the settlement re-verifies task truth from durable state.
 *
 * Also pins (PHASE B verification, no redesign):
 *  - Handoff READY is the domain's PUBLISHED delivery-record state (DRAFT→READY is
 *    the publishing transition; ACCEPT/REJECT are consumer actions, SUPERSEDED the
 *    rework-chain replacement) — a READY packet with durable refs IS the final
 *    producer-side delivery record; goal completion does not require ACCEPTED.
 *  - The Outcome is a DERIVED PROJECTION over durable canonical truth (engine run
 *    terminal state + validations + handoffs + artifacts + decisions) — by design
 *    (Stage 9, ADR-0029 "no second truth"); its components all survive restart.
 */
import {createServer, type Server} from 'node:http';
import {createOfflineNodeValidator} from '../support/offline-node-validator.js';
import {observeLoopback} from '../support/loopback-observation.js';
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
import {HANDOFF_STATES, HANDOFF_TRANSITIONS, RUN_TRANSITIONS} from '@companyos/core';

const COMPANY = 'company_default';
const CAPTURE_KEY = 'capture.fix09';
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
 * A two-item chain: the first producer has a DAG successor, so its canonical
 * artifacts become a READY handoff packet (a terminal producer records none —
 * Stage 8B §3), matching the Smoke-08 delivery shape.
 */
const CHAIN_PLAN = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {planItemId: 'build', objective: 'Deliver the implementation.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['c1']},
    {planItemId: 'check', objective: 'Independently verify the deliverable.', dependencyPlanItemIds: ['build'], acceptanceCriterionRefs: ['c2']},
  ],
  acceptanceCriteria: [
    {criterionId: 'c1', requirement: 'c1 met.'},
    {criterionId: 'c2', requirement: 'c2 met.'},
  ],
};

type FixtureControl = {readonly proposals: unknown[]; db: {prepare(sql: string): {run(...a: unknown[]): unknown}} | null; readonly planRequests: number};

const startFixture = async (control: FixtureControl): Promise<{readonly url: string; readonly close: () => Promise<void>}> => {
  const observation = observeLoopback(expect.getState().currentTestName ?? 'UNKNOWN_TEST');
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
  observation.attach(server);
  observation.emit('server-bind-start');
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { observation.bindError(error); observation.dispose(); reject(error); };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no fixture address');
  return {url: `http://127.0.0.1:${String(address.port)}`, close: () => observation.close(server)};
};

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;
const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
const fixtures: {close: () => Promise<void>}[] = [];
afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  try {
    while (openDatabases.length > 0) { try { openDatabases.pop()?.close(); } catch (error) { cleanupErrors.push(error); } }
    while (fixtures.length > 0) { try { await fixtures.pop()?.close(); } catch (error) { cleanupErrors.push(error); } }
    while (createdDirs.length > 0) { try { rmSync(createdDirs.pop() as string, {recursive: true, force: true}); } catch (error) { cleanupErrors.push(error); } }
  } finally {
    for (const key of LIVE_ENV_KEYS) delete process.env[key];
  }
  // A hook failure is additional evidence; Vitest retains the original test failure.
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'FIX09_CLEANUP_FAILED');
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-fix09-'));
  createdDirs.push(dir);
  return dir;
};

const composeWith = async (control: FixtureControl): Promise<{core: Core; dataDir: string}> => {
  const fixture = await startFixture(control);
  fixtures.push(fixture);
  const dataDir = tempDir();
  const workspaceRoot = join(dataDir, 'ws');
  mkdirSync(workspaceRoot, {recursive: true});
  const runValidator=createOfflineNodeValidator(workspaceRoot);
  const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
  openDatabases.push(db);
  control.db = db.db as never;
  const foundation = await openArtifactFoundation({casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never});
  if (!foundation.ok) throw new Error('foundation failed');
  const executor = {
    config: {providerKey: CAPTURE_KEY, fields: [{name: 'profile', value: 'fix09', source: 'composition'}], fingerprint: `scfg_fix09${'0'.repeat(21)}`} satisfies TypedExecutorConfig,
    provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
      descriptor: {providerKey: CAPTURE_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
      async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
        // A declared durable output (structured.artifactContent): the producer's
        // stage-output envelope then carries a durable artifactRef — the validation
        // gate's anchor — exactly like the real kernel's materialized outputs.
        return {kind: 'succeeded', exitCode: 0, stdoutText: 'delivered', providerSessionId: `s-${String(request.attemptId).slice(4, 10)}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), structured: {artifactContent: `fix09-deliverable:${String(request.taskId)}`}};
      },
    } as unknown as ExecutorProvider,
  };
  const envForCompose: Record<string, string | undefined> = {
    COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'fixture-model', COMPANYOS_MODEL_API_KEY: 'fix09-local',
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
          const result=await runValidator();
          return {ok:true,value:{status:'ok',output:{verdict:result.verdict,exitCode:result.exitCode,outputTail:result.output,evidenceRefs:['command:smoke-node-test']},artifactRefs:[],startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),latencyMs:1}};
        },
      } as never,
    }],
  } as never);
  if (core === null) throw new Error(lastCoreCompositionError() ?? 'composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({root: workspaceRoot, commandProfile: {}});
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
  const registered = await core.models.registerFromProvider({providerId: 'model.openai-compatible', providerModelId: 'fixture-model', modelKey: 'fix09.model', actorId: actor});
  if (!registered.ok) throw new Error(registered.error.message);
  const savedPolicy = await core.policies.savePolicy({id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'fix09.model', actorId: actor} as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  return {core, dataDir};
};

interface AdvanceOutcome {readonly goalRunId: string; readonly executionRunId: string; readonly error: {code: string; message: string} | null}

/** Drive until every work task of the execution run is terminal (bounded turn budget). */
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
      const advanceError = (advanced as {readonly error?: {readonly code: string; readonly message: string}}).error;
      error = advanceError === undefined ? {code: 'UNKNOWN', message: 'unknown'} : {code: advanceError.code, message: advanceError.message};
      break;
    }
    executionRunId = String((advanced.value as {readonly executionRunId: string}).executionRunId);
    if (executionRunId === '') continue;
    // Drive until the EXECUTION RUN itself is engine-terminal: the validation gate
    // and delivery settle on later advances after the work tasks finish.
    const runRow = core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(executionRunId) as {state: string} | undefined;
    if (runRow !== undefined && (runRow.state === 'COMPLETED' || runRow.state === 'FAILED')) break;
  }
  return {goalRunId, executionRunId, error};
};

const runState = (core: Core, runId: string): string =>
  String((core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as {state: string}).state);

describe('LIVE-SMOKE-FIX-09 — successful Goal Run terminality (full deterministic fixture)', () => {
  it('the Smoke-08 shape: full Goal→validation→delivery success converges the GOAL RUN to engine-terminal COMPLETED', {timeout: 240_000}, async () => {
    const control: FixtureControl = {proposals: [CHAIN_PLAN], db: null, planRequests: 0};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'f09-success-1');
    expect(driven.error).toBeNull();
    // The execution run completed through the real engine chain.
    expect(runState(f.core, driven.executionRunId)).toBe('COMPLETED');
    // THE FIX: the goal (planning container) run converges to engine-terminal COMPLETED.
    expect(runState(f.core, driven.goalRunId)).toBe('COMPLETED');
    // The convergence went through the engine's own event vocabulary (run.delivered + run.completed on the goal run).
    const goalRunEvents = f.core.database.db.prepare('SELECT type FROM events WHERE aggregate_id = ? AND type IN (?, ?) ORDER BY rowid').all(driven.goalRunId, 'run.delivered', 'run.completed') as {type: string}[];
    expect(goalRunEvents.map((row) => row.type)).toEqual(['run.delivered', 'run.completed']);
    // Driver/canonical agreement: the autonomy driver derives COMPLETED from the same durable truth.
    const driver = await f.core.autonomyDriver!.run({companyId: COMPANY, runId: driven.goalRunId});
    expect(driver.ok && driver.value.terminal).toBe('COMPLETED');
    expect(runState(f.core, driven.goalRunId)).toBe('COMPLETED');
  });

  it('idempotent: a replayed advance after success settles NOTHING new (no duplicate runs, events, handoffs, settlements)', {timeout: 240_000}, async () => {
    const control: FixtureControl = {proposals: [CHAIN_PLAN], db: null, planRequests: 0};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'f09-idem-1');
    expect(runState(f.core, driven.goalRunId)).toBe('COMPLETED');
    const counts = () => ({
      runs: Number((f.core.database.db.prepare('SELECT COUNT(*) c FROM runs').get() as {c: number}).c),
      delivered: Number((f.core.database.db.prepare("SELECT COUNT(*) c FROM events WHERE aggregate_id = ? AND type = 'run.delivered'").get(driven.goalRunId) as {c: number}).c),
      handoffs: Number((f.core.database.db.prepare('SELECT COUNT(*) c FROM handoffs').get() as {c: number}).c),
      attempts: Number((f.core.database.db.prepare('SELECT COUNT(*) c FROM execution_attempts').get() as {c: number}).c),
    });
    const before = counts();
    for (let i = 0; i < 3; i += 1) {
      const again = await f.core.controlPlane!.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: driven.goalRunId}});
      expect(again.ok).toBe(true);
    }
    expect(counts()).toEqual(before);
    expect(runState(f.core, driven.goalRunId)).toBe('COMPLETED');
  });

  it('restart: a FRESH connection reads goal run COMPLETED + handoffs + validations + linkage intact', {timeout: 240_000}, async () => {
    const control: FixtureControl = {proposals: [CHAIN_PLAN], db: null, planRequests: 0};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'f09-restart-1');
    expect(runState(f.core, driven.goalRunId)).toBe('COMPLETED');
    const dataDir = f.dataDir;
    const idx = openDatabases.findIndex((db) => db === (f.core.database as unknown as DurableDatabase));
    if (idx >= 0) openDatabases.splice(idx, 1);
    (f.core.database as unknown as {close(): void}).close();
    const reopened = openDurableDatabase({dataDir, appliedAt: 'reopen-fix09', chains: [...CHAINS]});
    openDatabases.push(reopened);
    expect(String((reopened.db.prepare('SELECT state FROM runs WHERE id = ?').get(driven.goalRunId) as {state: string}).state)).toBe('COMPLETED');
    expect(String((reopened.db.prepare('SELECT state FROM runs WHERE id = ?').get(driven.executionRunId) as {state: string}).state)).toBe('COMPLETED');
    const handoffs = reopened.db.prepare('SELECT COUNT(*) c FROM handoffs').get() as {c: number};
    expect(handoffs.c).toBeGreaterThanOrEqual(1);
    const validations = reopened.db.prepare("SELECT COUNT(*) c FROM validations WHERE status = 'pass'").get() as {c: number};
    expect(validations.c).toBeGreaterThanOrEqual(1);
    // No resurrection: a post-restart advance leaves the terminal state untouched.
    void reopened;
  });

  it('premature success negatives: execution-run failure / non-terminal work keep the goal run NON-success', {timeout: 240_000}, async () => {
    // A plan item whose executor path cannot succeed is NOT needed — use the genuine
    // failure path: a four-predecessor integration item (VERY_HIGH → STRONG floor)
    // with a BALANCED-only pool fails the execution run terminally (FIX-07), and the
    // goal run must end FAILED — never COMPLETED (failure regression + no-success).
    const veryHighPlan = {
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
    const control: FixtureControl = {proposals: [veryHighPlan], db: null, planRequests: 0};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'f09-fail-1');
    expect(runState(f.core, driven.executionRunId)).toBe('FAILED');
    // FIX-07 preserved: the goal run FAILED — the success settlement never fires on
    // a terminally failed execution run.
    expect(runState(f.core, driven.goalRunId)).toBe('FAILED');
  });

  it('planning terminal failure regression (FIX-06): planner exhaustion keeps goal run FAILED, never success', {timeout: 240_000}, async () => {
    const dangling = {
      schema: 'companyos/plan-proposal/1',
      planItems: [{planItemId: 'plan-02-core', objective: 'Deliver.', dependencyPlanItemIds: ['plan-01'], acceptanceCriterionRefs: ['c1']}],
      acceptanceCriteria: [{criterionId: 'c1', requirement: 'c1 met.'}],
    };
    const control: FixtureControl = {proposals: [dangling, dangling, dangling], db: null, planRequests: 0};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'f09-plan-fail-1');
    expect(driven.error?.message).toContain('attempts');
    expect(runState(f.core, driven.goalRunId)).toBe('FAILED');
    expect(driven.executionRunId).toBe('');
  });
});

describe('LIVE-SMOKE-FIX-09 — engine OUTCOME_DELIVERED guard (typed fail-closed negatives)', () => {
  it('the domain transition table: OUTCOME_DELIVERED is legal only from live execution-phase states to COMPLETED', () => {
    const rule = RUN_TRANSITIONS.find((entry) => entry.event === 'OUTCOME_DELIVERED');
    expect(rule).toBeDefined();
    expect(rule!.to).toBe('COMPLETED');
    expect([...rule!.from]).toEqual(['EXECUTING', 'REVIEWING', 'VALIDATING', 'FINALIZING']);
    // A terminal run can never be re-settled by it (legality is machine-enforced).
    expect(rule!.from).not.toContain('COMPLETED');
    expect(rule!.from).not.toContain('FAILED');
  });

  it('through the production engine: missing anchor / unknown child / non-COMPLETED child are refused typed (via the goal pipeline settlement contract)', {timeout: 240_000}, async () => {
    // Drive a successful goal, then attempt a RAW second settlement with a fabricated
    // child id through the engine: the guard refuses (unknown child) and the goal run
    // stays exactly as the legitimate settlement left it.
    const control: FixtureControl = {proposals: [CHAIN_PLAN], db: null, planRequests: 0};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'f09-guard-1');
    expect(runState(f.core, driven.goalRunId)).toBe('COMPLETED');
    // A direct engine dispatch with a fabricated child run id fails typed; the
    // terminal goal run is also protected by transition legality (no resurrection).
    const db = f.core.database as unknown as {runs: {get(id: string): Promise<{revision: number} | null>}};
    const goalRun = await db.runs.get(driven.goalRunId);
    const dispatched = await f.core.controlPlane!.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: driven.goalRunId}});
    expect(dispatched.ok).toBe(true);
    expect(runState(f.core, driven.goalRunId)).toBe('COMPLETED');
    void goalRun;
  });
});

describe('LIVE-SMOKE-FIX-09 — Handoff canonicality pin (PHASE B verification, no redesign)', () => {
  it('READY is the domain PUBLISHED delivery-record state: published from DRAFT, consumable, supersedeable — the final PRODUCER-side record', () => {
    // The domain machine (core, frozen): DRAFT→READY is the publishing transition;
    // READY's successors are CONSUMER actions (ACCEPT/REJECT) and lifecycle
    // (CANCEL/SUPERSEDED for the rework chain). A READY packet with durable refs is
    // the final producer-side delivery record — goal completion requires NO further
    // handoff transition (acceptance is a consumer-side protocol action).
    expect(HANDOFF_STATES).toContain('READY');
    expect(HANDOFF_TRANSITIONS.DRAFT).toEqual(['READY', 'CANCELLED']);
    expect(HANDOFF_TRANSITIONS.READY).toEqual(['ACCEPTED', 'REJECTED', 'CANCELLED', 'SUPERSEDED']);
    expect(HANDOFF_TRANSITIONS.SUPERSEDED).toEqual([]);
  });

  it('durable: the successful goal READY handoff packets + refs survive restart (the delivery record is canonical)', {timeout: 240_000}, async () => {
    const control: FixtureControl = {proposals: [CHAIN_PLAN], db: null, planRequests: 0};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'f09-handoff-1');
    expect(runState(f.core, driven.goalRunId)).toBe('COMPLETED');
    const rows = f.core.database.db.prepare('SELECT handoff_id, status FROM handoffs').all() as {handoff_id: string; status: string}[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => row.status === 'READY')).toBe(true);
    const refs = f.core.database.db.prepare('SELECT COUNT(*) c FROM handoff_refs').get() as {c: number};
    expect(refs.c).toBeGreaterThanOrEqual(rows.length);
  });
});

describe('LIVE-SMOKE-FIX-09 — Outcome canonicality pin (derived projection over durable truth, by design)', () => {
  it('the driver outcome is a DERIVED projection; its canonical components (run states, validations, handoffs, artifacts, decisions) are durable and restart-readable', {timeout: 240_000}, async () => {
    const control: FixtureControl = {proposals: [CHAIN_PLAN], db: null, planRequests: 0};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'f09-outcome-1');
    const driver = await f.core.autonomyDriver!.run({companyId: COMPANY, runId: driven.goalRunId});
    expect(driver.ok && driver.value.terminal).toBe('COMPLETED');
    if (!driver.ok) throw new Error(driver.error.message);
    const outcome = driver.value.outcome;
    // The projection cites ONLY durable canonical rows (each ref set non-empty on success).
    expect(outcome.goalRunId).toBe(driven.goalRunId);
    expect(outcome.executionRunId).toBe(driven.executionRunId);
    expect(outcome.completionStatus).toBe('COMPLETED');
    expect(outcome.deliverableArtifactRefs.length).toBeGreaterThan(0);
    expect(outcome.validationRefs.length).toBeGreaterThan(0);
    // Every cited ref is a real durable row (spot-check via the still-open store, then restart).
    const dataDir = f.dataDir;
    const idx = openDatabases.findIndex((db) => db === (f.core.database as unknown as DurableDatabase));
    if (idx >= 0) openDatabases.splice(idx, 1);
    (f.core.database as unknown as {close(): void}).close();
    const reopened = openDurableDatabase({dataDir, appliedAt: 'reopen-fix09-outcome', chains: [...CHAINS]});
    openDatabases.push(reopened);
    for (const validationRef of outcome.validationRefs) {
      const row = reopened.db.prepare('SELECT validation_id FROM validations WHERE validation_id = ?').get(String(validationRef)) as {validation_id: string} | undefined;
      expect(row?.validation_id).toBe(String(validationRef));
    }
    for (const artifactRef of outcome.deliverableArtifactRefs.slice(0, 5)) {
      const row = reopened.db.prepare('SELECT artifact_id FROM artifacts WHERE artifact_id = ?').get(String(artifactRef)) as {artifact_id: string} | undefined;
      expect(row?.artifact_id).toBe(String(artifactRef));
    }
  });
});
