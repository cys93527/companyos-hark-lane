import { offlineExecutionSafety } from './helpers/offline-execution-safety.js';
/**
 * V1 EFFICIENCY E1 — measurement-foundation tests (E1-A derived trace, E1-B
 * bounded activity tap, E1-C truthful usage coverage).
 *
 * Invariants under test:
 *  - the derived trace is a READ-ONLY projection: identical durable truth ⇒
 *    identical document (deterministic, restart-stable), zero canonical writes;
 *  - the wall-clock partition never double-counts (attempts disjoint);
 *  - failed-attempt cost, retry gaps and validation durations stay visible;
 *    UNKNOWN survives wherever evidence cannot distinguish;
 *  - activity telemetry is bounded, coalesced, secret-safe, attributed to the
 *    right attempt, and NEVER carries progress semantics;
 *  - usage semantics are KNOWN / ESTIMATED / UNKNOWN with missing ≠ zero and
 *    no manufactured goal total while any dispatch is UNKNOWN;
 *  - execution behavior is unchanged (600 000 ms cap, retry, routing,
 *    settlement untouched — also pinned by the affected regression batch).
 */
import {createServer, type Server} from 'node:http';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {openDurableDatabase, type DurableDatabase} from '@companyos/persistence';
import {nullLogger} from '@companyos/observability';
import type {ExecutorProvider, ExecutorExecutionRequest, TypedExecutorConfig} from '@companyos/engine';

import {composeCoreServices} from '../../apps/desktop/src/core-services.js';
import {openArtifactFoundation} from '../../apps/desktop/src/artifact-stack.js';
import {GOAL_WORK_KIND} from '../../apps/desktop/src/control-plane.js';
import {productionCompositionOptions, resolveExecutionAttemptTimeoutMs, DEFAULT_EXECUTION_ATTEMPT_TIMEOUT_MS} from '../../apps/desktop/src/production-composition.js';
import {buildLatencyTrace, createSqliteLatencyTraceReader} from '../../apps/desktop/src/efficiency/latency-trace.js';
import {classifyUsageRecord, summarizeGoalUsage} from '../../apps/desktop/src/efficiency/usage-coverage.js';
import {dshAttemptActivityTapOf, DSH_ATTEMPT_ACTIVITY_WINDOW_MS} from '../../apps/desktop/src/executor/dsh-executor-provider.js';

const COMPANY = 'company_default';
const CAPTURE_KEY = 'capture.e1';
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

/* --------------------------------------------------------- scenario fixture */

const CHAIN_PLAN = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {planItemId: 'build', objective: 'Deliver the deliverable.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['c1']},
  ],
  acceptanceCriteria: [{criterionId: 'c1', requirement: 'c1 met.'}],
};

const startFixture = async (missingUsage = false): Promise<{readonly url: string; readonly close: () => Promise<void>}> => {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { body = {}; }
      if ((req.url ?? '').includes('/models')) {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({object: 'list', data: [{id: 'e1-fixture-model'}]}));
        return;
      }
      const rfText = JSON.stringify(body['response_format'] ?? {});
      let content: string;
      if (rfText.includes('"action"')) {
        content = JSON.stringify({schema: 'companyos/supervisor-proposal/1', action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'go', evidenceRefs: [], subject: null});
      } else if (rfText.includes('"targetRef"')) {
        content = JSON.stringify({schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', missingRequirements: [], summary: 'ok', targetRef: 'goal'});
      } else {
        content = JSON.stringify(CHAIN_PLAN);
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({object: 'chat.completion', choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}], ...(missingUsage ? {} : {usage: {prompt_tokens: 10, completion_tokens: 5}})}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no fixture address');
  return {url: `http://127.0.0.1:${String(address.port)}`, close: () => new Promise<void>((resolve) => server.close(() => resolve()))};
};

/* ----------------------------------------------------------- test lifecycle */

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;
const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
const fixtures: {close: () => Promise<void>}[] = [];
const scrubEnv = () => { for (const key of LIVE_ENV_KEYS) delete process.env[key]; };
afterEach(async () => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (fixtures.length > 0) await fixtures.pop()?.close();
  while (createdDirs.length > 0) { try { rmSync(createdDirs.pop() as string, {recursive: true, force: true}); } catch { /* disposable */ } }
  scrubEnv();
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-e1-'));
  createdDirs.push(dir);
  return dir;
};

interface Harness {
  readonly core: Core;
  readonly goalRunId: string;
  readonly executionRunId: string;
  readonly failedAttemptId: string;
  readonly dataDir: string;
}

const makeHarness = async (failFirstAttempt: boolean, missingUsage = false): Promise<Harness> => {
  const fixture = await startFixture(missingUsage);
  fixtures.push(fixture);
  const dataDir = tempDir();
  mkdirSync(join(dataDir, 'ws'), {recursive: true});
  const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never});
  if (!foundation.ok) throw new Error('foundation failed');
  let workCalls = 0;
  const executor = {
    config: {providerKey: CAPTURE_KEY, fields: [{name: 'profile', value: 'e1', source: 'composition'}], fingerprint: `scfg_e1${'0'.repeat(22)}`} satisfies TypedExecutorConfig,
    provider: {
      supportsCallAdmission: true, // In-process fixture; no external cost-bearing call.
      descriptor: {providerKey: CAPTURE_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
      async start(request: ExecutorExecutionRequest) {
        workCalls += 1;
        if (failFirstAttempt && workCalls === 1) {
          return {kind: 'provider-failed' as const, exitCode: 1, stdoutText: 'e1-forced-first-failure', stderrText: '', reasonCode: 'E1_TEST_FAIL', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()};
        }
        return {kind: 'succeeded' as const, exitCode: 0, stdoutText: 'delivered', providerSessionId: `s-${String(request.attemptId).slice(4, 10)}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), structured: {artifactContent: `e1-deliverable:${String(request.taskId)}`}};
      },
    } as unknown as ExecutorProvider,
  };
  const envForCompose: Record<string, string | undefined> = {
    COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'e1-fixture-model', COMPANYOS_MODEL_API_KEY: 'e1-local',
    COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY,
    COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'BALANCED',
    COS_MODEL_QUALITY_TIER: 'BALANCED', COS_MODEL_COST_TIER: 'MEDIUM', COS_MODEL_LATENCY_TIER: 'BALANCED',
    COS_MODEL_RELIABILITY_CLASS: 'STANDARD', COS_MODEL_AUTHENTICATION: 'REQUIRED',
  };
  for (const [key, value] of Object.entries(envForCompose)) process.env[key] = value;
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    ...productionCompositionOptions(envForCompose),
    executionSafety: offlineExecutionSafety,
    executorProviderImplementations: [executor as never],
    goalWorkProfile: {stageKind: 'work', taskKind: GOAL_WORK_KIND, maxAttempts: 3, validatorIds: ['e1.validator']},
    validatorTools: [{
      toolId: 'e1.validator',
      port: {
        describe: () => ({id: 'e1.validator', kind: 'deterministic', displayName: 'E1 deterministic validator', version: '1'}),
        invoke: async () => ({ok: true, value: {status: 'ok', output: {verdict: 'pass', evidenceRefs: ['command:e1-validator']}, artifactRefs: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), latencyMs: 1}}),
      } as never,
    }],
  } as never);
  if (core === null) throw new Error('composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({root: join(dataDir, 'ws'), commandProfile: {}});
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
  const registered = await core.models.registerFromProvider({providerId: 'model.openai-compatible', providerModelId: 'e1-fixture-model', modelKey: 'e1.model', actorId: actor});
  if (!registered.ok) throw new Error(registered.error.message);
  const savedPolicy = await core.policies.savePolicy({id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'e1.model', actorId: actor} as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);

  const controlPlane = core.controlPlane;
  if (controlPlane === null) throw new Error('control plane not wired');
  const created = await controlPlane.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: 'Deliver the E1 fixture deliverable.', commandId: `e1-goal-${failFirstAttempt ? 'fail-first' : 'clean'}-${String(Date.now())}`}});
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const goalRunId = String((created.value as {readonly runId: string}).runId);
  let executionRunId = '';
  for (let turn = 0; turn < 14; turn += 1) {
    const advanced = await controlPlane.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: goalRunId}});
    if (missingUsage && (await core.database.executionBudget.read(goalRunId))?.reservations.some((entry) => entry.status === 'UNKNOWN')) break;
    if (!advanced.ok) throw new Error(JSON.stringify(advanced.error));
    executionRunId = String((advanced.value as {readonly executionRunId: string}).executionRunId);
    if (executionRunId === '') continue;
    const state = String((core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(executionRunId) as {state: string}).state);
    if (state === 'COMPLETED' || state === 'FAILED') break;
  }
  const goalState = String((core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(goalRunId) as {state: string}).state);
  const budget = await core.database.executionBudget.read(goalRunId);
  expect(budget).not.toBeNull();
  expect(budget!.reservations.length).toBeGreaterThan(0);
  if (missingUsage) {
    expect(budget!.reservations).toHaveLength(1);
    expect(budget!.reservations[0]).toMatchObject({ status: 'UNKNOWN', usage: null });
    expect(goalState).not.toBe('COMPLETED');
  } else {
    // A local work stub has no modelCallAdmission and no work reservation.
    // Projection UNKNOWN is not settled UNKNOWN financial accounting.
    expect(budget!.reservations.every((entry) => entry.status === 'KNOWN')).toBe(true);
    expect(new Set(budget!.reservations.map((entry) => entry.callId)).size).toBe(budget!.reservations.length);
    expect(budget!.reservations.every((entry) => entry.usage?.tokens === 15 && entry.usage.costMicros === 0)).toBe(true);
    if (goalState !== 'COMPLETED') throw new Error(`E1 harness goal did not complete: ${goalState}`);
  }
  const failed = core.database.db.prepare("SELECT id FROM execution_attempts WHERE run_id = ? AND state != 'COMPLETED' ORDER BY rowid").all(executionRunId) as {id: string}[];
  return {core, goalRunId, executionRunId, failedAttemptId: failed[0]?.id ?? '', dataDir};
};

/** Insert observational activity events for an attempt (the E1-B event shape) straight into the events table. */
const insertActivityEvents = (core: Core, attemptId: string, atTimes: readonly [string, string]): void => {
  const insert = core.database.db.prepare(
    "INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES (?, 'executor.attempt_activity', 1, ?, ?, 'ExecutionAttempt', 'system:dsh-executor-provider', ?, '', '', ?, NULL)",
  );
  let n = 0;
  for (const at of atTimes) {
    n += 1;
    insert.run(`evt_e1_activity_${String(n)}_${attemptId}`, at, attemptId, `trace_attempt_${attemptId}`, JSON.stringify({attemptId, activityType: 'KERNEL_STATUS', activityIsProgress: false, windowStartAt: at, lineCount: 3, lastLineSha256: createHash('sha256').update(`line-${String(n)}`).digest('hex'), lastLineHead: '{"type":"status","phase":"agent"}'}));
  }
};

/* ------------------------------------------------------------- E1-A / E1-C */

describe('E1-A — derived latency trace (read-only, deterministic, honest)', () => {
  it('derives a restart-stable, mutation-free trace with failed-attempt cost, retry gap and validation visible', {timeout: 240_000}, async () => {
    const h = await makeHarness(true);
    expect(h.failedAttemptId).not.toBe('');
    // observational activity events so the successful attempt has interior evidence
    const succeeded = String((h.core.database.db.prepare("SELECT id FROM execution_attempts WHERE run_id = ? AND state = 'COMPLETED' ORDER BY rowid").get(h.executionRunId) as {id: string}).id);
    const attempt = h.core.database.db.prepare('SELECT created_at, settled_at FROM execution_attempts WHERE id = ?').get(succeeded) as {created_at: string; settled_at: string};
    // the capture-executor fixture settles in milliseconds, so anchor both activity
    // events at row-derived ms offsets INSIDE [created, settled]
    const nearEnd = new Date(Date.parse(attempt.settled_at) - 1).toISOString();
    const earlier = new Date(Date.parse(attempt.settled_at) - 2).toISOString();
    insertActivityEvents(h.core, succeeded, [earlier, nearEnd]);

    const countsBefore = tableCounts(h.core);
    const reader = createSqliteLatencyTraceReader(h.core.database.db);
    const now = '2026-10-04T12:00:00.000Z';
    const first = buildLatencyTrace(reader, {goalRunId: h.goalRunId, now});
    const second = buildLatencyTrace(createSqliteLatencyTraceReader(h.core.database.db), {goalRunId: h.goalRunId, now});
    expect(JSON.stringify(second)).toBe(JSON.stringify(first)); // deterministic for same durable truth

    // zero canonical mutation
    expect(tableCounts(h.core)).toEqual(countsBefore);

    // goal shape + partition honesty
    expect(first.goal.goalRunId).toBe(h.goalRunId);
    expect(first.goal.executionRunId).toBe(h.executionRunId);
    expect(first.goal.finalStates).toEqual(['COMPLETED', 'COMPLETED']);
    expect(first.partition.disjointAttested).toBe(true);
    const attemptBucket = first.partition.buckets.find((bucket) => bucket.classification === 'ATTEMPT');
    expect(attemptBucket).toBeDefined();
    const attemptSum = first.attempts.reduce((acc, a) => acc + a.durationS, 0);
    expect(attemptBucket!.durationS).toBe(Math.round(attemptSum * 1000) / 1000); // no double counting (ms precision)
    expect(Math.abs(first.partition.accountedS + first.partition.unaccountedS - first.goal.wallS)).toBeLessThanOrEqual(1);

    // failed attempt + retry gap + validation + activity attribution
    const failed = first.attempts.find((a) => a.attemptId === h.failedAttemptId);
    expect(failed).toBeDefined();
    expect(failed!.state).not.toBe('COMPLETED');
    expect(failed!.durationS).toBeGreaterThan(0);
    expect(failed!.interior.classification).toBe('UNKNOWN'); // no interior evidence for the failed attempt
    expect(failed!.livenessClassification).toBe('NO_OBSERVED_ACTIVITY');
    expect(first.intervals.some((interval) => interval.classification === 'RETRY_GAP' && interval.durationS >= 0)).toBe(true);
    const validation = first.intervals.find((interval) => interval.classification === 'VALIDATION');
    expect(validation).toBeDefined();
    const ok = first.attempts.find((a) => a.attemptId === succeeded)!;
    expect(ok.activityEventCount).toBe(2);

    expect(ok.lastObservedActivityAt).toBe(nearEnd);
    expect(ok.livenessClassification).toBe('ACTIVITY_TO_END');
    expect(ok.interior.classification).toBe('MODEL_OR_KERNEL_ACTIVITY');
    expect(ok.interior.confidence).toBe('LOW'); // kernel-observed only — never claimed as model-internal

    // dependency path basis is honest
    expect(['pinned-graph', 'observed-order']).toContain(first.dependencyPath?.basis ?? 'observed-order');
    expect(first.observationalOnly).toBe(true);
    expect(first.schemaVersion).toBe('companyos/latency-trace/1');

    // restart determinism: a FRESH connection over the same files derives the same document
    const idx = openDatabases.findIndex((open) => open === (h.core.database as unknown as DurableDatabase));
    if (idx >= 0) openDatabases.splice(idx, 1);
    (h.core.database as unknown as {close(): void}).close();
    const reopened = openDurableDatabase({dataDir: h.dataDir, appliedAt: 'e1-reopen', chains: [...CHAINS]});
    openDatabases.push(reopened);
    const third = buildLatencyTrace(createSqliteLatencyTraceReader(reopened.db), {goalRunId: h.goalRunId, now});
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
  });

  it('keeps UNKNOWN classifications where evidence cannot distinguish (clean run, no interior events)', {timeout: 240_000}, async () => {
    const h = await makeHarness(false);
    const trace = buildLatencyTrace(createSqliteLatencyTraceReader(h.core.database.db), {goalRunId: h.goalRunId, now: '2026-10-04T12:00:00.000Z'});
    for (const attempt of trace.attempts) {
      expect(attempt.activityEventCount).toBe(0);
      expect(attempt.toolCalls).toBe(0);
      expect(attempt.livenessClassification).toBe('COMPLETED_UNKNOWN_INTERIOR');
      expect(attempt.interior.classification).toBe('UNKNOWN');
    }
  });
});

describe('RC5 — canonical Goal blocks unknown admitted usage', () => {
  it('a local model response without usage cannot complete the Goal or permit another dispatch', async () => {
    const h = await makeHarness(false, true);
    const budgetBefore = await h.core.database.executionBudget.read(h.goalRunId);
    const executionsBefore = Number((h.core.database.db.prepare('SELECT COUNT(*) c FROM agent_executions').get() as {c: number}).c);
    expect(budgetBefore!.reservations).toHaveLength(1);
    expect(budgetBefore!.reservations[0]).toMatchObject({status: 'UNKNOWN', usage: null});
    const advanced = await h.core.controlPlane!.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: h.goalRunId}});
    // A refused/terminal advance is not successful Goal completion, even if the
    // IPC envelope can be read successfully. Durable state is authoritative.
    if (!advanced.ok) { expect(advanced.error).toBeDefined(); expect(advanced.error?.code).not.toBe(''); }
    expect((h.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(h.goalRunId) as {state: string}).state).not.toBe('COMPLETED');
    expect(await h.core.database.executionBudget.read(h.goalRunId)).toEqual(budgetBefore);
    expect(Number((h.core.database.db.prepare('SELECT COUNT(*) c FROM agent_executions').get() as {c: number}).c)).toBe(executionsBefore);
    expect(h.core.database.db.prepare('SELECT COUNT(*) c FROM execution_attempts').get()).toMatchObject({c: 0});
  });
});

describe('E1-C — truthful usage coverage semantics', () => {
  it('classifyUsageRecord: missing=UNKNOWN, provider numbers=KNOWN, estimate=ESTIMATED, supplied zero stays KNOWN (missing ≠ zero)', () => {
    expect(classifyUsageRecord(null)).toBe('UNKNOWN');
    expect(classifyUsageRecord(undefined)).toBe('UNKNOWN');
    expect(classifyUsageRecord({provenance: 'provider-reported', inputTokens: null, outputTokens: null, totalTokens: null})).toBe('UNKNOWN');
    expect(classifyUsageRecord({provenance: 'provider-reported', inputTokens: 10, outputTokens: 5, totalTokens: 15})).toBe('KNOWN');
    expect(classifyUsageRecord({provenance: 'estimated', inputTokens: 10, outputTokens: 5, totalTokens: 15})).toBe('ESTIMATED');
    // a provider that genuinely reported zero is KNOWN-zero; absence of a record is UNKNOWN — never conflated
    expect(classifyUsageRecord({provenance: 'provider-reported', inputTokens: 0, outputTokens: 0, totalTokens: 0})).toBe('KNOWN');
  });

  it('goal summary preserves unknown coverage and never manufactures a total', () => {
    const summary = summarizeGoalUsage('run_x', [
      {goalRunId: 'run_x', runId: 'r', taskId: null, roleId: null, attemptId: null, seat: 'planner', providerId: null, modelId: null, state: 'KNOWN', record: {provenance: 'provider-reported', inputTokens: 780, outputTokens: 4462, totalTokens: 5242}},
      {goalRunId: 'run_x', runId: 'r', taskId: 't', roleId: null, attemptId: 'a1', seat: 'work', providerId: null, modelId: null, state: 'UNKNOWN', record: null},
      {goalRunId: 'run_x', runId: 'r', taskId: 't', roleId: null, attemptId: 'a2', seat: 'work', providerId: null, modelId: null, state: 'UNKNOWN', record: null},
      {goalRunId: 'run_x', runId: 'r', taskId: null, roleId: null, attemptId: null, seat: 'supervisor', providerId: null, modelId: null, state: 'ESTIMATED', record: {provenance: 'estimated', inputTokens: 1000, outputTokens: 200, totalTokens: 1200}},
    ]);
    expect(summary.knownInputTokens).toBe(780);
    expect(summary.knownOutputTokens).toBe(4462);
    expect(summary.estimatedInputTokens).toBe(1000);
    expect(summary.estimatedOutputTokens).toBe(200);
    expect(summary.unknownDispatchCount).toBe(2);
    expect(summary.totalDispatchCount).toBe(4);
    expect(summary.coverageRatio).toBe(0.5);
    expect(summary.complete).toBe(false);
    // no manufactured combined total exists anywhere in the summary shape
    expect(Object.keys(summary).some((key) => key.toLowerCase().includes('totaltoken'))).toBe(false);
  });

  it('real goal ledger: control-plane rows KNOWN, work dispatches UNKNOWN, coverage < 1', {timeout: 240_000}, async () => {
    const h = await makeHarness(true);
    const trace = buildLatencyTrace(createSqliteLatencyTraceReader(h.core.database.db), {goalRunId: h.goalRunId, now: '2026-10-04T12:00:00.000Z'});
    const summary = trace.usageSummary;
    expect(summary.totalDispatchCount).toBeGreaterThanOrEqual(3); // 2 work dispatches + planner
    expect(summary.unknownDispatchCount).toBe(2); // both work attempts: kernel usage is not surfaced today
    expect(summary.knownInputTokens + summary.knownOutputTokens).toBeGreaterThan(0); // planner/supervisor rows carry real usage
    expect(summary.complete).toBe(false);
    expect(summary.coverageRatio!).toBeLessThan(1);
    // failed work attempt without usage is UNKNOWN — never zero
    const failedEntry = trace.usageSummary;
    expect(failedEntry.unknownDispatchCount).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------- E1-B */

describe('E1-B — bounded observational activity tap', () => {
  const makeAudit = () => {
    const appended: {type: string; payload: Record<string, unknown>}[] = [];
    const failures: unknown[] = [];
    return {
      appended,
      failures,
      audit: {
        append: async (events: readonly {type: string; payload: Record<string, unknown>}[]): Promise<unknown> => {
          for (const event of events) appended.push(event);
          return events.length;
        },
        secrets: () => ['s3cr3t-value'],
        ids: {id: (prefix?: string) => `${String(prefix ?? 'evt')}_1`, ulid: () => 'U'},
        onFailure: (error: unknown) => { failures.push(error); },
      },
    };
  };
  const attribution = {attemptId: 'exa_e1b', taskId: 'tsk_e1b', runId: 'run_e1b', roleId: 'rol_e1b'};
  const payloadOf = (event: {type: string; payload: Record<string, unknown>}) => event.payload;

  it('coalesces to ≤1 record per category per window, never duplicates tool_call lines, and bounds payloads', () => {
    const {audit, appended} = makeAudit();
    let clock = 1_000_000;
    const tap = dshAttemptActivityTapOf(audit as never, attribution, {now: () => clock});
    // tool_call forms belong to the per-call tool tap — never activity events
    tap('{"type":"tool_call","callId":"c1","tool":"pwsh","input":{"cmd":"ls"}}');
    tap('tool_call pwsh {"cmd":"ls"}');
    expect(appended.length).toBe(0);
    // 3 kernel status lines inside one 10s window → ONE coalesced record on window flip
    tap('{"type":"status","phase":"agent","turn":1}');
    tap('{"type":"status","phase":"agent","turn":2}');
    tap('{"type":"session","sessionId":"s-1","cwd":"x"}');
    expect(appended.length).toBe(0); // still open — nothing flushed yet
    clock += DSH_ATTEMPT_ACTIVITY_WINDOW_MS + 1;
    tap('{"type":"status","phase":"agent","turn":3}');
    expect(appended.length).toBe(1); // the closed window flushed exactly one KERNEL_STATUS record
    expect(appended[0]!.type).toBe('executor.attempt_activity');
    const payload = payloadOf(appended[0]!);
    expect(payload['attemptId']).toBe('exa_e1b');
    expect(payload['activityType']).toBe('KERNEL_STATUS');
    expect(payload['activityIsProgress']).toBe(false);
    expect(payload['lineCount']).toBe(3);
    expect(String(payload['lastLineSha256'])).toMatch(/^[0-9a-f]{64}$/);
    // a separate category keeps its own window; windows flush ONLY when a later line
    // in the SAME category flips them (emit-on-flip; the still-open tail window of a
    // category is intentionally not flushed mid-stream — the dispatch settle event is
    // the terminal signal for the attempt)
    clock += 1;
    tap('plain rendered output line');
    expect(appended.length).toBe(1); // STREAM window open, not flushed; KERNEL(turn3) still open too
    clock += DSH_ATTEMPT_ACTIVITY_WINDOW_MS + 1;
    tap('another rendered line');
    expect(appended.length).toBe(2); // the STREAM window flipped and flushed exactly one record
    expect(payloadOf(appended[1]!)['activityType']).toBe('STREAM_ACTIVITY');
    // a 10KB line persists only a bounded redacted head — never raw bulk
    clock += DSH_ATTEMPT_ACTIVITY_WINDOW_MS + 1;
    tap(`{"type":"status","blob":"${'x'.repeat(10_000)}"}`); // 10KB kernel line opens a fresh KERNEL window
    clock += DSH_ATTEMPT_ACTIVITY_WINDOW_MS + 1;
    tap('{"type":"status","flip":true}'); // flips it: the window holds ONLY the big line
    const big = appended.find((event) => payloadOf(event)['lineCount'] === 1 && String(payloadOf(event)['lastLineHead'] ?? '').includes('xxx'));
    expect(big).toBeDefined();
    expect(String(payloadOf(big!)['lastLineHead']).length).toBeLessThanOrEqual(120);
  });

  it('redacts secrets, attributes to the attempt, and stays loud-but-harmless on append failure', async () => {
    const {audit, failures} = makeAudit();
    let clock = 5_000_000;
    (audit.append as unknown) = async (): Promise<unknown> => { throw new Error('append down'); };
    const tap = dshAttemptActivityTapOf(audit as never, attribution, {now: () => clock});
    tap('{"type":"status","note":"contains s3cr3t-value inside"}');
    clock += DSH_ATTEMPT_ACTIVITY_WINDOW_MS + 1;
    expect(() => tap('{"type":"status","note":"next"}')).not.toThrow(); // observation never fails the attempt
    // failure surfaced loudly (onFailure) — FIX-08C contract; the rejection rides a
    // fire-and-forget promise, so let the microtask queue drain before asserting
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(failures.length).toBeGreaterThan(0);

    // secret redaction on the head (separate audit instance)
    const second = makeAudit();
    let clock2 = 9_000_000;
    const tap2 = dshAttemptActivityTapOf(second.audit as never, attribution, {now: () => clock2});
    tap2('{"type":"status","note":"prefix s3cr3t-value suffix"}');
    clock2 += DSH_ATTEMPT_ACTIVITY_WINDOW_MS + 1;
    tap2('{"type":"status","note":"flip"}');
    expect(second.appended.length).toBe(1);
    const head = String(payloadOf(second.appended[0]!)['lastLineHead']);
    expect(head).not.toContain('s3cr3t-value');
  });
});

/* -------------------------------------------------- behavior-invariance pin */

describe('E1 — execution behavior invariance pins', () => {
  it('the 600 000 ms production attempt cap and its resolution precedence are unchanged', () => {
    expect(DEFAULT_EXECUTION_ATTEMPT_TIMEOUT_MS).toBe(600_000);
    expect(resolveExecutionAttemptTimeoutMs({})).toBe(600_000);
    expect(resolveExecutionAttemptTimeoutMs({COS_EXECUTION_ATTEMPT_TIMEOUT_MS: '30000'})).toBe(30_000);
  });
});

/* ------------------------------------------------------------------ helper */

const tableCounts = (core: Core): Record<string, number> => {
  const tables = (core.database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'").all() as {name: string}[]).map((row) => row.name).sort();
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = Number((core.database.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as {c: number}).c);
  }
  return counts;
};
