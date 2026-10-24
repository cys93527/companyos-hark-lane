import { offlineExecutionSafety } from './helpers/offline-execution-safety.js';
/**
 * LIVE-SMOKE-FIX-06 — Planner proposal repair (PLAN_PROPOSAL_REPAIR_V1) + planning
 * failure run terminality.
 *
 * Smoke-05 root cause (mechanically reproduced here): the LIVE planner emitted a plan
 * whose item "plan-02-core" depended on the nonexistent "plan-01"; the canonical
 * validator correctly fail-closed (PLAN_DEPENDENCY_UNKNOWN) — but the FIRST invalid
 * proposal immediately killed the Goal, and the durable Goal Run stayed EXECUTING
 * while the driver said NON_RECOVERABLE_FAILURE.
 *
 * Closed contract (deterministic fixtures, zero live API):
 *  - ONE logical planning operation (same run/task/command/planId) may run at most
 *    3 TOTAL proposal attempts (1 initial + 2 repairs); each is a REAL model call
 *    with its own AgentExecution row (attempt = proposal number);
 *  - repair feeds the canonical validator's TYPED issues back to the planner
 *    (safe codes + identifier-bearing messages; never CoT, never secrets); CompanyOS
 *    NEVER mutates semantic references itself;
 *  - every attempt passes the SAME canonical validator — an invalid proposal never
 *    becomes canonical Plan truth; a repaired valid plan persists exactly once and
 *    the Goal continues (workflow materialized, work proceeds under the unchanged
 *    558283e complexity derivation);
 *  - network retry stays INSIDE one invocation (not a proposal repair); provider/
 *    credential failures are NOT repairable output; cancellation between attempts
 *    stops immediately;
 *  - exhaustion (3 invalid) fails TYPED (PLANNER_INVALID_OUTPUT + per-attempt codes)
 *    AND settles the Goal Run through the existing EXECUTION.FAIL seam — never a
 *    durable EXECUTING run after a terminal planning failure; restart preserves it.
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
const CAPTURE_KEY = 'capture.prepair';
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

/* ------------------------------------------------------------------ plans --- */

/** The exact Smoke-05 invalid shape: plan-02-core depends on the NONEXISTENT plan-01. */
const DANGLING = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {planItemId: 'plan-02-core', objective: 'Deliver the CLI core.', dependencyPlanItemIds: ['plan-01'], acceptanceCriterionRefs: ['c1']},
  ],
  acceptanceCriteria: [{criterionId: 'c1', requirement: 'c1 met.'}],
};

/** The corrected COMPLETE proposal: plan-01 now exists; same semantic work. */
const VALID_CORRECTED = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {planItemId: 'plan-01', objective: 'Implement the CLI core.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['c1']},
    {planItemId: 'plan-02-core', objective: 'Wire the CLI core into the deliverable.', dependencyPlanItemIds: ['plan-01'], acceptanceCriterionRefs: ['c2']},
  ],
  acceptanceCriteria: [
    {criterionId: 'c1', requirement: 'c1 met.'},
    {criterionId: 'c2', requirement: 'c2 met.'},
  ],
};

const DUPLICATE_ID = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {planItemId: 'plan-01', objective: 'First item.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['c1']},
    {planItemId: 'plan-01', objective: 'Duplicate id item.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['c1']},
  ],
  acceptanceCriteria: [{criterionId: 'c1', requirement: 'c1 met.'}],
};

const CRITERION_UNKNOWN = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {planItemId: 'plan-01', objective: 'Implement.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['cX']},
  ],
  acceptanceCriteria: [{criterionId: 'c1', requirement: 'c1 met.'}],
};

/* ------------------------------------------------------- fixture server --- */

interface PlanRequestCapture {
  /** 1-based plan-proposal request number. */
  readonly index: number;
  /** Whether the request context carried the typed repair feedback. */
  readonly repairFeedback: string | null;
}

interface FixtureControl {
  /** The scripted plan proposals, in order (last entry repeats if exhausted). */
  proposals: unknown[];
  /** Chat-completions that fail with 401 BEFORE any success (credential class, non-retryable). */
  authFailuresFirst?: number;
  /** Chat-completions that fail with 500 BEFORE any success (transient class — network retry territory). */
  transientFailuresFirst?: number;
  /** Runs (with the harness db) when plan request N arrives — cancellation injection. */
  onPlanRequest?: (index: number, db: {prepare(sql: string): {run(...a: unknown[]): unknown}}) => void;
  readonly planRequests: PlanRequestCapture[];
  db: {prepare(sql: string): {run(...a: unknown[]): unknown}} | null;
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
      const isPlanRequest = !rfText.includes('"action"') && !rfText.includes('"targetRef"') && !rfText.includes('"verdict"');
      if (isPlanRequest) {
        // The failure gates are positioned INSIDE the plan-request accounting so an
        // injected 401/500 still counts as the proposal call it interrupted.
        if ((control.authFailuresFirst ?? 0) > 0) {
          control.authFailuresFirst = (control.authFailuresFirst ?? 0) - 1;
          control.planRequests.push({index: control.planRequests.length + 1, repairFeedback: null});
          res.writeHead(401, {'content-type': 'application/json'});
          res.end(JSON.stringify({error: {message: 'fixture: invalid api key', type: 'invalid_request_error'}}));
          return;
        }
        if ((control.transientFailuresFirst ?? 0) > 0) {
          control.transientFailuresFirst = (control.transientFailuresFirst ?? 0) - 1;
          res.writeHead(500, {'content-type': 'application/json'});
          res.end(JSON.stringify({error: {message: 'fixture: transient upstream', type: 'server_error'}}));
          return;
        }
      }
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
        // The PLANNER proposal branch — scripted, one per plan request.
        const index = control.planRequests.length + 1;
        let repairFeedback: string | null = null;
        for (const message of Array.isArray(body['messages']) ? (body['messages'] as readonly {readonly role?: unknown; readonly content?: unknown}[]) : []) {
          if (message?.role !== 'user') continue;
          const text = String(message?.content ?? '');
          if (text.includes('companyos/planner-repair-feedback/1')) repairFeedback = text.slice(text.indexOf('companyos/planner-repair-feedback/1'));
        }
        control.planRequests.push({index, repairFeedback});
        control.onPlanRequest?.(index, control.db as never);
        const proposal = control.proposals[Math.min(index, control.proposals.length) - 1] ?? control.proposals[control.proposals.length - 1];
        content = JSON.stringify(proposal);
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
  const dir = mkdtempSync(join(tmpdir(), 'companyos-prepair-'));
  createdDirs.push(dir);
  return dir;
};

const composeWith = async (
  control: FixtureControl,
  legacyRetryUnit = false,
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
    config: {providerKey: CAPTURE_KEY, fields: [{name: 'profile', value: 'prepair', source: 'composition'}], fingerprint: `scfg_prepair${'0'.repeat(19)}`} satisfies TypedExecutorConfig,
    provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
      descriptor: {providerKey: CAPTURE_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
      async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
        captures.push({request});
        return {kind: 'succeeded', exitCode: 0, stdoutText: 'delivered', providerSessionId: `s-${String(request.attemptId).slice(4, 10)}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()};
      },
    } as unknown as ExecutorProvider,
  };
  const envForCompose: Record<string, string | undefined> = {
    COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'fixture-model', COMPANYOS_MODEL_API_KEY: 'prepair-local',
    COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY,
    COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'BALANCED',
    COS_MODEL_QUALITY_TIER: 'BALANCED', COS_MODEL_COST_TIER: 'MEDIUM', COS_MODEL_LATENCY_TIER: 'BALANCED',
    COS_MODEL_RELIABILITY_CLASS: 'STANDARD', COS_MODEL_AUTHENTICATION: 'REQUIRED',
  };
  for (const [key, value] of Object.entries(envForCompose)) if (value !== undefined) process.env[key] = value;
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    ...productionCompositionOptions(envForCompose),
    // The one legacy retry unit retains its original assertions. All production
    // Goal tests use durable admission; the paired regression below proves UNKNOWN
    // HTTP outcomes forbid the legacy retry in that production composition.
    executionSafety: legacyRetryUnit ? undefined : offlineExecutionSafety,
    executorProviderImplementations: [executor as never],
  } as never);
  if (core === null) throw new Error(lastCoreCompositionError() ?? 'composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({root: workspaceRoot, commandProfile: {}});
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
  const registered = await core.models.registerFromProvider({providerId: 'model.openai-compatible', providerModelId: 'fixture-model', modelKey: 'prepair.model', actorId: actor});
  if (!registered.ok) throw new Error(registered.error.message);
  const savedPolicy = await core.policies.savePolicy({id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'prepair.model', actorId: actor} as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  return {core, captures, dataDir};
};

interface AdvanceOutcome {
  readonly goalRunId: string;
  readonly executionRunId: string;
  readonly error: {code: string; message: string; details?: Record<string, unknown>} | null;
}

/** One goal + advance loop tolerant of a terminal planning failure (the SUT path). */
const driveGoal = async (core: Core, commandId: string, maxTurns = 12): Promise<AdvanceOutcome> => {
  const cp = core.controlPlane!;
  const created = await cp.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: 'Deliver the CLI.', commandId}});
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const goalRunId = String((created.value as {readonly runId: string}).runId);
  let executionRunId = '';
  let error: AdvanceOutcome['error'] = null;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const advanced = await cp.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: goalRunId}});
    if (!advanced.ok) {
      error = advanced.error as never;
      break;
    }
    executionRunId = String((advanced.value as {readonly executionRunId: string}).executionRunId);
    if (executionRunId === '') continue;
    const states = core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, executionRunId) as {state: string}[];
    if (states.length > 0 && states.every((row) => row.state === 'DONE' || row.state === 'FAILED' || row.state === 'BLOCKED')) break;
  }
  return {goalRunId, executionRunId, error};
};

const plannerExecutions = (core: Core): {attempt: number; status: string; error_code: string | null; input_usage: string; output_usage: string}[] =>
  core.database.db.prepare("SELECT attempt, status, error_code, input_usage, output_usage FROM agent_executions WHERE agent_id = 'agent.planner' ORDER BY attempt, rowid").all() as never;

const goalRunState = (core: Core, runId: string): string =>
  String((core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as {state: string}).state);

const planningTaskRow = (core: Core, runId: string): {id: string; state: string} =>
  core.database.db.prepare("SELECT id, state FROM tasks WHERE run_id = ? AND kind = 'companyos:planning'").get(runId) as never;

const planArtifactCount = (core: Core): number =>
  Number((core.database.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'companyos:plan'").get() as {n: number}).n);

const executionRunCount = (core: Core): number =>
  Number((core.database.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE id LIKE 'run_%'").get() as {n: number}).n);

/* ------------------------------------------------------------------ tests --- */

describe('LIVE-SMOKE-FIX-06 — PLAN_PROPOSAL_REPAIR_V1 (bounded, CompanyOS-owned)', () => {
  it('§C Smoke-05 repro: dangling dependency → TYPED feedback → corrected proposal → valid plan persists ONCE, workflow continues, 0 user decisions', {timeout: 180_000}, async () => {
    const control: FixtureControl = {proposals: [DANGLING, VALID_CORRECTED], planRequests: [], db: null};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'pr-repro-1');
    // TWO planner proposal calls — the second carried the TYPED repair feedback.
    expect(control.planRequests).toHaveLength(2);
    expect(control.planRequests[1]!.repairFeedback).toContain('companyos/planner-repair-feedback/1');
    expect(control.planRequests[1]!.repairFeedback).toContain('PLAN_DEPENDENCY_UNKNOWN');
    expect(control.planRequests[1]!.repairFeedback).toContain('plan-02-core');
    expect(control.planRequests[1]!.repairFeedback).toContain('plan-01');
    expect(control.planRequests[0]!.repairFeedback).toBeNull();
    // The invalid attempt settled FAILED with its typed cause AND its real usage; the
    // corrected attempt COMPLETED (§14: real calls stay real — no merged fiction).
    const plannerRows = plannerExecutions(f.core);
    expect(plannerRows).toHaveLength(2);
    expect(plannerRows[0]!.attempt).toBe(1);
    expect(plannerRows[0]!.status).toBe('FAILED');
    expect(plannerRows[0]!.error_code).toBe('PLANNER_INVALID_OUTPUT');
    expect(Number((JSON.parse(plannerRows[0]!.output_usage) as {inputTokens: number}).inputTokens)).toBeGreaterThan(0);
    expect(plannerRows[1]!.attempt).toBe(2);
    expect(plannerRows[1]!.status).toBe('COMPLETED');
    // Exactly ONE canonical plan; it is the CORRECTED proposal.
    expect(planArtifactCount(f.core)).toBe(1);
    // The goal continued: execution run materialized, BOTH work items completed under
    // the UNCHANGED 558283e complexity derivation (0 deps → LOW, 1 dep → MEDIUM).
    expect(driven.error).toBeNull();
    expect(driven.executionRunId).toMatch(/^run_/);
    const states = f.core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, driven.executionRunId) as {state: string}[];
    expect(states).toHaveLength(2);
    expect(states.every((row) => row.state === 'DONE')).toBe(true);
    expect(f.captures.length).toBeGreaterThanOrEqual(2);
    const routing = f.core.database.db.prepare('SELECT routing_decision_json FROM provider_dispatches WHERE routing_decision_json IS NOT NULL').all() as {routing_decision_json: string}[];
    expect(routing.length).toBe(f.captures.length);
    const complexities = routing.map((row) => String((JSON.parse(row.routing_decision_json) as Record<string, unknown>)['taskComplexity'])).sort();
    expect(complexities).toEqual(['LOW', 'MEDIUM']);
    // The planning task settled DONE exactly once (one logical operation).
    const planning = planningTaskRow(f.core, driven.goalRunId);
    expect(planning.state).toBe('DONE');
  });

  it('§16 two invalid (unknown dependency, duplicate id) → third valid: 3 TOTAL proposal attempts, PASS', {timeout: 180_000}, async () => {
    const control: FixtureControl = {proposals: [DANGLING, DUPLICATE_ID, VALID_CORRECTED], planRequests: [], db: null};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'pr-multi-1');
    expect(control.planRequests).toHaveLength(3);
    // Repair feedback accumulated BOTH typed codes on the third attempt.
    expect(control.planRequests[2]!.repairFeedback).toContain('PLAN_DEPENDENCY_UNKNOWN');
    expect(control.planRequests[2]!.repairFeedback).toContain('PLAN_ITEM_ID_DUPLICATE');
    expect(planArtifactCount(f.core)).toBe(1);
    expect(driven.error).toBeNull();
    expect(driven.executionRunId).toMatch(/^run_/);
    const plannerRows = plannerExecutions(f.core);
    expect(plannerRows.map((row) => row.status)).toEqual(['FAILED', 'FAILED', 'COMPLETED']);
  });

  it('§17 exhaustion: exactly 3 attempts, NO fourth call, NO canonical plan, typed PLANNER_INVALID_OUTPUT, planning task FAILED, goal run settled FAILED', {timeout: 180_000}, async () => {
    const control: FixtureControl = {proposals: [DANGLING, DUPLICATE_ID, CRITERION_UNKNOWN], planRequests: [], db: null};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'pr-exhaust-1');
    // Exactly THREE proposal calls — no fourth, ever.
    expect(control.planRequests).toHaveLength(3);
    expect(planArtifactCount(f.core)).toBe(0);
    // Typed terminal failure with the per-attempt validation codes.
    expect(driven.error).not.toBeNull();
    expect(String(driven.error!.details?.['reason'] ?? '')).toBe('PLANNER_INVALID_OUTPUT');
    expect(Number(driven.error!.details?.['proposalAttempts'])).toBe(3);
    const attemptFailures = driven.error!.details?.['attemptFailures'] as {attempt: number; code: string}[];
    expect(attemptFailures.map((failure) => failure.code)).toEqual(['PLAN_DEPENDENCY_UNKNOWN', 'PLAN_ITEM_ID_DUPLICATE', 'PLAN_CRITERION_REF_UNKNOWN']);
    // Every attempt's execution settled FAILED with the typed cause.
    const plannerRows = plannerExecutions(f.core);
    expect(plannerRows).toHaveLength(3);
    expect(plannerRows.every((row) => row.status === 'FAILED' && row.error_code === 'PLANNER_INVALID_OUTPUT')).toBe(true);
    // The planning task FAILED once — one logical operation, no per-repair task truth.
    const planning = planningTaskRow(f.core, driven.goalRunId);
    expect(planning.state).toBe('FAILED');
    // P1-2: the goal run reached the EXISTING terminal failure state (not EXECUTING).
    expect(goalRunState(f.core, driven.goalRunId)).toBe('FAILED');
    // No phantom execution run or work tasks were created.
    expect(executionRunCount(f.core)).toBe(1); // the goal (planning) run only
    expect(f.captures).toHaveLength(0);
  });

  it('§18 credential failure is NOT repairable output: ONE call, ZERO proposal repairs, no plan, typed auth failure', {timeout: 180_000}, async () => {
    const control: FixtureControl = {proposals: [VALID_CORRECTED], authFailuresFirst: 1, planRequests: [], db: null};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'pr-auth-1');
    // The provider rejected the credential ONCE (non-retryable class → no network retry,
    // no proposal repair): exactly one chat call, zero accepted proposals.
    expect(control.planRequests).toHaveLength(1);
    expect(planArtifactCount(f.core)).toBe(0);
    expect(driven.error).not.toBeNull();
    const plannerRows = plannerExecutions(f.core);
    expect(plannerRows).toHaveLength(1);
    expect(plannerRows[0]!.status).toBe('FAILED');
    // The provider's OWN typed credential class (401 → PERMISSION_DENIED) settles the
    // execution directly at the invocation seam — the honest class, never a repair loop.
    expect(plannerRows[0]!.error_code).toBe('PERMISSION_DENIED');
    const planning = planningTaskRow(f.core, driven.goalRunId);
    expect(planning.state).toBe('FAILED');
    expect(goalRunState(f.core, driven.goalRunId)).toBe('FAILED');
  });

  it('§cancel-before-repair: a terminal planning task between attempts stops the loop immediately (no second call)', {timeout: 180_000}, async () => {
    const control: FixtureControl = {
      proposals: [DANGLING, VALID_CORRECTED],
      onPlanRequest: (index, db) => {
        if (index === 1) {
          // Cancel the planning task BEFORE the invalid first proposal is even returned.
          db.prepare("UPDATE tasks SET state = 'CANCELLED' WHERE kind = 'companyos:planning'").run();
        }
      },
      planRequests: [],
      db: null,
    };
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'pr-cancel-1');
    // Attempt 1's response arrived, the loop's between-attempts check saw the terminal
    // task and stopped — the scripted valid proposal was NEVER requested.
    expect(control.planRequests).toHaveLength(1);
    expect(planArtifactCount(f.core)).toBe(0);
    expect(driven.error).not.toBeNull();
    expect(String(driven.error!.details?.['reason'] ?? '')).toBe('PLANNER_CANCELLED_BETWEEN_PROPOSALS');
    // A cancelled task is NOT a terminal planning FAILURE: the run was not force-failed.
    expect(goalRunState(f.core, driven.goalRunId)).not.toBe('FAILED');
  });

  it('legacy network retry unit (without Goal admission): two 500s remain proposal attempt ONE, not a repair', {timeout: 180_000}, async () => {
    const control: FixtureControl = {proposals: [VALID_CORRECTED], transientFailuresFirst: 2, planRequests: [], db: null};
    const f = await composeWith(control, true);
    const driven = await driveGoal(f.core, 'pr-transient-1');
    // The first two chat calls failed 500 (transient class): the control-plane network
    // retry re-issued the SAME invocation; the third call delivered the proposal.
    expect(control.planRequests).toHaveLength(1);
    // ONE AgentExecution for the planner (attempt 1, COMPLETED) — network retries never
    // created proposal-repair attempts.
    const plannerRows = plannerExecutions(f.core);
    expect(plannerRows).toHaveLength(1);
    expect(plannerRows[0]!.attempt).toBe(1);
    expect(plannerRows[0]!.status).toBe('COMPLETED');
    expect(planArtifactCount(f.core)).toBe(1);
    expect(driven.error).toBeNull();
    expect(driven.executionRunId).toMatch(/^run_/);
  });
  it('durable Goal admission stops after an HTTP 500 with UNKNOWN usage; no network retry or repaired proposal', async () => {
    const control: FixtureControl = {proposals: [VALID_CORRECTED], transientFailuresFirst: 2, planRequests: [], db: null};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'pr-unknown-no-retry');
    expect(control.planRequests).toHaveLength(0);
    expect(plannerExecutions(f.core)).toHaveLength(1);
    expect(planArtifactCount(f.core)).toBe(0);
    expect(driven.error).not.toBeNull();
    const row = f.core.database.db.prepare('SELECT execution_budget_json FROM runs WHERE id = ?').get(driven.goalRunId) as {execution_budget_json: string};
    const state = JSON.parse(row.execution_budget_json) as {reservations: {status: string; usage: unknown}[]};
    expect(state.reservations).toHaveLength(1);
    expect(state.reservations[0]).toMatchObject({status: 'UNKNOWN', usage: null});
  });
});

describe('LIVE-SMOKE-FIX-06 — planning failure run terminality (restart + consistency)', () => {
  it('§22 restart: a FRESH connection reads run FAILED, planning task FAILED, typed causes, no phantom execution run, no plan', {timeout: 180_000}, async () => {
    const control: FixtureControl = {proposals: [DANGLING, DUPLICATE_ID, CRITERION_UNKNOWN], planRequests: [], db: null};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'pr-restart-1');
    expect(driven.error).not.toBeNull();
    const dataDir = f.dataDir;
    const goalRunId = driven.goalRunId;
    const idx = openDatabases.findIndex((db) => db === (f.core.database as unknown as DurableDatabase));
    if (idx >= 0) openDatabases.splice(idx, 1);
    (f.core.database as unknown as {close(): void}).close();
    const reopened = openDurableDatabase({dataDir, appliedAt: 'reopen-prepair', chains: [...CHAINS]});
    openDatabases.push(reopened);
    expect(String((reopened.db.prepare('SELECT state FROM runs WHERE id = ?').get(goalRunId) as {state: string}).state)).toBe('FAILED');
    const planning = reopened.db.prepare("SELECT state FROM tasks WHERE kind = 'companyos:planning'").get() as {state: string};
    expect(planning.state).toBe('FAILED');
    const plannerRows = reopened.db.prepare("SELECT status, error_code FROM agent_executions WHERE agent_id = 'agent.planner'").all() as {status: string; error_code: string}[];
    expect(plannerRows).toHaveLength(3);
    expect(plannerRows.every((row) => row.status === 'FAILED' && row.error_code === 'PLANNER_INVALID_OUTPUT')).toBe(true);
    expect(Number((reopened.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'companyos:plan'").get() as {n: number}).n)).toBe(0);
    expect(Number((reopened.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches').get() as {n: number}).n)).toBe(0);
  });

  it('§24 driver/run consistency: after terminal planning failure the driver classifies failure AND the durable run is FAILED — never EXECUTING', {timeout: 180_000}, async () => {
    const control: FixtureControl = {proposals: [DANGLING, DUPLICATE_ID, CRITERION_UNKNOWN], planRequests: [], db: null};
    const f = await composeWith(control);
    const created = await f.core.controlPlane!.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: 'Deliver the CLI.', commandId: 'pr-consistency-1'}});
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const goalRunId = String((created.value as {readonly runId: string}).runId);
    const driver = f.core.autonomyDriver!;
    const driven = await driver.run({companyId: COMPANY, runId: goalRunId});
    expect(driven.ok).toBe(true);
    if (driven.ok) {
      expect(driven.value.terminal).toBe('NON_RECOVERABLE_FAILURE');
    }
    // The SAME durable database shows the run terminal — the two truths agree.
    expect(goalRunState(f.core, goalRunId)).toBe('FAILED');
  });

  it('§23 successful repair does NOT prematurely fail the run (the goal run only settles after the execution run completes)', {timeout: 180_000}, async () => {
    const control: FixtureControl = {proposals: [DANGLING, VALID_CORRECTED], planRequests: [], db: null};
    const f = await composeWith(control);
    const driven = await driveGoal(f.core, 'pr-success-1');
    expect(driven.error).toBeNull();
    // The goal (planning) run itself settled COMPLETED; the execution run completed too.
    expect(['COMPLETED', 'EXECUTING'].includes(goalRunState(f.core, driven.goalRunId))).toBe(true);
    const workStates = f.core.database.db.prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?').all(GOAL_WORK_KIND, driven.executionRunId) as {state: string}[];
    expect(workStates.every((row) => row.state === 'DONE')).toBe(true);
  });
});
