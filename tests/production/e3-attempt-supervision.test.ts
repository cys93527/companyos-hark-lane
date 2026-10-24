import { offlineExecutionSafety } from './helpers/offline-execution-safety.js';
/**
 * V1 EFFICIENCY STAGE E3 — attempt resilience & execution supervision tests.
 *
 * E3-A: supervision policy ownership lives in execution/attempt supervision (a pure
 *       module); no termination authority exists anywhere in it.
 * E3-B: typed observational classifications; unsupported labels (MODEL_STUCK /
 *       PROVIDER_STUCK / NO_PROGRESS) do not exist; silence never terminates.
 * E3-C: retry continuation envelope — derived, bounded, workspace-reuse-aware, never
 *       trusting the failed attempt; new attempt identity; restart-stable.
 *
 * The deterministic fixture runs the REAL goal pipeline (production composition +
 * capture executor): attempt 1 fails retryably with real tool activity events, then
 * attempt 2 is dispatched — the captured request must carry the retry envelope.
 */
import {createServer, type Server} from 'node:http';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {openDurableDatabase, type DurableDatabase} from '@companyos/persistence';
import {nullLogger} from '@companyos/observability';
import { observeLoopback } from '../support/loopback-observation.js';
import { compositionEvidence, trackOwnedServer, safeError } from '../support/e3-broker-evidence.js';
import type {ExecutorProvider, ExecutorExecutionRequest, TypedExecutorConfig} from '@companyos/engine';

import {composeCoreServices} from '../../apps/desktop/src/core-services.js';
import {openArtifactFoundation} from '../../apps/desktop/src/artifact-stack.js';
import {GOAL_WORK_KIND} from '../../apps/desktop/src/control-plane.js';
import {productionCompositionOptions, resolveExecutionAttemptTimeoutMs, DEFAULT_EXECUTION_ATTEMPT_TIMEOUT_MS} from '../../apps/desktop/src/production-composition.js';
import {
  ATTEMPT_SUPERVISION_CLASSIFICATIONS,
  ATTEMPT_SUPERVISION_POLICY_OWNER,
  SILENT_OBSERVED_WINDOW_MS,
  classifyAttemptOutcome,
  classifyObservedActivity,
  deriveRetryContinuationEnvelope,
  renderRetryDirective,
} from '../../apps/desktop/src/executor/attempt-supervision.js';

const COMPANY = 'company_default';
const CAPTURE_KEY = 'capture.e3';
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

/* ------------------------------------------------------- E3-A / E3-B units */

describe('E3-A/B — supervision policy owner + typed classification', () => {
  it('policy ownership is the execution supervision module; no termination surface exists', async () => {
    expect(ATTEMPT_SUPERVISION_POLICY_OWNER).toBe('execution:attempt-supervision');
    // the module exposes classification/derivation/rendering only — structural guard:
    const module = await import('../../apps/desktop/src/executor/attempt-supervision.js');
    for (const key of Object.keys(module)) {
      expect(/kill|terminate|abort|cancel|timeoutNow|earlyStop/i.test(key)).toBe(false);
    }
  });

  it('classifications are the closed evidence-bound set — no stuck/progress labels', () => {
    expect(ATTEMPT_SUPERVISION_CLASSIFICATIONS).toEqual([
      'ACTIVE_OBSERVED', 'SILENT_OBSERVED_WINDOW', 'PROVIDER_FAILURE_CONFIRMED',
      'EXECUTOR_FAILURE_CONFIRMED', 'PROCESS_EXIT_CONFIRMED', 'TIMEOUT_CAP_REACHED', 'UNKNOWN',
    ]);
    const all = ATTEMPT_SUPERVISION_CLASSIFICATIONS.join(' ');
    expect(all).not.toContain('MODEL_STUCK');
    expect(all).not.toContain('PROVIDER_STUCK');
    expect(all).not.toContain('NO_PROGRESS');
  });

  it('outcome classification: confirmed signals typed; unknown stays unknown', () => {
    expect(classifyAttemptOutcome({outcomeKind: 'provider-failed'})).toBe('PROVIDER_FAILURE_CONFIRMED');
    expect(classifyAttemptOutcome({failureCode: 'TIMEOUT'})).toBe('TIMEOUT_CAP_REACHED');
    expect(classifyAttemptOutcome({outcomeKind: 'transport-failed'})).toBe('EXECUTOR_FAILURE_CONFIRMED');
    expect(classifyAttemptOutcome({failureCode: 'EXECUTOR_CRASH'})).toBe('EXECUTOR_FAILURE_CONFIRMED');
    expect(classifyAttemptOutcome({})).toBe('UNKNOWN');
    expect(classifyAttemptOutcome({outcomeKind: 'uncertain'})).toBe('UNKNOWN');
  });

  it('observed-activity classification labels windows WITHOUT terminating anything', () => {
    const now = '2026-10-04T12:00:00.000Z';
    expect(classifyObservedActivity({lastObservedActivityAt: '2026-10-04T11:59:30.000Z', now})).toBe('ACTIVE_OBSERVED');
    expect(classifyObservedActivity({lastObservedActivityAt: new Date(Date.parse(now) - SILENT_OBSERVED_WINDOW_MS - 1).toISOString(), now})).toBe('SILENT_OBSERVED_WINDOW');
    expect(classifyObservedActivity({lastObservedActivityAt: null, now})).toBe('UNKNOWN');
    // a SILENT_OBSERVED_WINDOW is a LABEL: no function consumes it for termination (module guard above)
  });

  it('the 600000ms production cap and resolution precedence are unchanged', () => {
    expect(DEFAULT_EXECUTION_ATTEMPT_TIMEOUT_MS).toBe(600_000);
    expect(resolveExecutionAttemptTimeoutMs({})).toBe(600_000);
    expect(resolveExecutionAttemptTimeoutMs({COS_EXECUTION_ATTEMPT_TIMEOUT_MS: '30000'})).toBe(30_000);
  });
});

/* --------------------------------------------------- E3-C envelope units */

describe('E3-C — retry continuation envelope derivation', () => {
  const priorAttempts = [
    {id: 'exa_aaaaaaaaaaaaaaaaaaaa1', attemptNumber: 1, state: 'FAILED', failureCode: 'TIMEOUT', failureRetryable: true, createdAt: '2026-10-04T10:00:00.000Z', settledAt: '2026-10-04T10:10:06.000Z'},
  ];
  const events = [
    {type: 'executor.tool_invocation_requested', occurredAt: '2026-10-04T10:00:05.000Z', payload: {tool: 'pwsh', argsSha256: 'x'}},
    {type: 'executor.attempt_activity', occurredAt: '2026-10-04T10:00:30.000Z', payload: {activityType: 'KERNEL_STATUS'}},
    {type: 'executor.tool_invocation_requested', occurredAt: '2026-10-04T10:00:45.000Z', payload: {tool: 'pwsh'}},
  ];

  it('first attempts get NO retry context (never fabricated)', () => {
    expect(deriveRetryContinuationEnvelope({taskId: 'tsk_x', attemptNumber: 1, priorAttempts: [], previousAttemptEvents: []})).toBeNull();
  });

  it('retries derive a bounded envelope from durable truth', () => {
    const envelope = deriveRetryContinuationEnvelope({taskId: 'tsk_x', attemptNumber: 2, priorAttempts, previousAttemptEvents: events});
    expect(envelope).not.toBeNull();
    expect(envelope!.taskId).toBe('tsk_x');
    expect(envelope!.previousAttemptId).toBe('exa_aaaaaaaaaaaaaaaaaaaa1');
    expect(envelope!.retryOrdinal).toBe(1);
    expect(envelope!.previousFailureCode).toBe('TIMEOUT');
    expect(envelope!.previousFailureRetryable).toBe(true);
    expect(envelope!.previousAttemptDurationS).toBe(606);
    expect(envelope!.workspaceReuse).toBe(true);
    expect(envelope!.priorActivity.toolCallCount).toBe(2);
    expect(envelope!.priorActivity.activityEventCount).toBe(1);
    expect(envelope!.priorActivity.lastToolKinds).toEqual(['pwsh']);
    expect(envelope!.priorActivity.lastObservedActivityAt).toBe('2026-10-04T10:00:45.000Z');
    // bounded: no raw args, no transcripts anywhere in the envelope
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('argsSha256');
    expect(serialized.length).toBeLessThan(2_000);
  });

  it('derivation is deterministic (restart-stable): same truth, same envelope', () => {
    const a = deriveRetryContinuationEnvelope({taskId: 'tsk_x', attemptNumber: 2, priorAttempts, previousAttemptEvents: events});
    const b = deriveRetryContinuationEnvelope({taskId: 'tsk_x', attemptNumber: 2, priorAttempts: [...priorAttempts].reverse(), previousAttemptEvents: [...events].reverse()});
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('the directive is verification-first and never trusts the failed attempt', () => {
    const envelope = deriveRetryContinuationEnvelope({taskId: 'tsk_x', attemptNumber: 2, priorAttempts, previousAttemptEvents: events})!;
    const directive = renderRetryDirective(envelope);
    expect(directive).toContain('retry of the same canonical task');
    expect(directive).toContain('partial work');
    expect(directive).toContain('Do not assume that partial work is correct');
    expect(directive).toContain('not authoritative');
    expect(directive).toContain('verify it against the task acceptance criteria');
    expect(directive).toContain('continue from valid existing state');
    expect(directive).not.toContain('tests pass');
    expect(directive).not.toMatch(/validated and correct/i);
  });
});

/* ------------------------------------------ deterministic retry fixture */

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
const fixtures: {close: () => Promise<void>}[] = [];
const scrubEnv = () => { for (const key of LIVE_ENV_KEYS) delete process.env[key]; };
afterEach(async () => {
  const closed = await Promise.allSettled(fixtures.splice(0).map(fixture => fixture.close()));
  // Preserve the body failure; hook failures are separately reported by Vitest.
  const errors = closed.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason);
  if (errors.length) { scrubEnv(); throw new AggregateError(errors, 'E3 fixture cleanup failed; directories retained'); }
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) { try { rmSync(createdDirs.pop() as string, {recursive: true, force: true}); } catch { /* disposable */ } }
  scrubEnv();
});
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'companyos-e3-')); createdDirs.push(dir); return dir; };

const startFixture = async () => {
  const observation = observeLoopback('E3-C retry continuation');
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { body = {}; }
      if ((req.url ?? '').includes('/models')) {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({object: 'list', data: [{id: 'e3-fixture-model'}]}));
        return;
      }
      const rfText = JSON.stringify(body['response_format'] ?? {});
      let content: string;
      if (rfText.includes('"action"')) {
        content = JSON.stringify({schema: 'companyos/supervisor-proposal/1', action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'go', evidenceRefs: [], subject: null});
      } else if (rfText.includes('"targetRef"')) {
        content = JSON.stringify({schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', missingRequirements: [], summary: 'ok', targetRef: 'goal'});
      } else {
        content = JSON.stringify({
          schema: 'companyos/plan-proposal/1',
          planItems: [
            {planItemId: 'build', objective: 'Deliver the analysis deliverable.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['c1']},
            {planItemId: 'validate', objective: 'Independently validate the deliverable.', dependencyPlanItemIds: ['build'], acceptanceCriterionRefs: ['c2']},
          ],
          acceptanceCriteria: [{criterionId: 'c1', requirement: 'c1 met.'}, {criterionId: 'c2', requirement: 'c2 met.'}],
        });
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({object: 'chat.completion', choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 5}}));
    });
  });
  observation.attach(server);
  const owned = trackOwnedServer(server, observation.emit);
  fixtures.push({ close: async () => { try { await owned.close(); } finally { observation.dispose(); } } });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no fixture address');
  return {url: `http://127.0.0.1:${String(address.port)}`, observation};
};

describe('E3-C — the real dispatch path carries retry context to the NEW attempt', () => {
  it('attempt 1 (fail retryably with activity) → attempt 2 request carries the envelope + directive; identity/rules intact', {timeout: 240_000}, async () => {
    const fixture = await startFixture();
    const dataDir = tempDir();
    mkdirSync(join(dataDir, 'ws'), {recursive: true});
    const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
    openDatabases.push(db);
    const foundation = await openArtifactFoundation({casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never});
    if (!foundation.ok) { fixture.observation.emit('artifact-foundation-error', { error: safeError(foundation.error, ['e3-local']) }); throw new Error('foundation failed'); }

    const requests: ExecutorExecutionRequest[] = [];
    let workCalls = 0;
    const executor = {
      config: {providerKey: CAPTURE_KEY, fields: [{name: 'profile', value: 'e3', source: 'composition'}], fingerprint: `scfg_e3${'0'.repeat(22)}`} satisfies TypedExecutorConfig,
      provider: {
    supportsCallAdmission: true, // Deterministic local adapter: no hidden external calls.
        descriptor: {providerKey: CAPTURE_KEY, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
        async start(request: ExecutorExecutionRequest) {
          requests.push(request);
          workCalls += 1;
          if (workCalls === 1) {
            // attempt 1: real E1 activity evidence, then a retryable provider failure
            await db.db.prepare(
              "INSERT INTO events (event_id, type, version, occurred_at, aggregate_id, aggregate_type, actor_id, trace_id, run_id, org_id, payload, global_position) VALUES (?, 'executor.tool_invocation_requested', 1, ?, ?, 'ExecutionAttempt', 'system:dsh-executor-provider', ?, '', '', ?, NULL)",
            ).run(`evt_e3_t1_${request.attemptId}`, new Date().toISOString(), request.attemptId, `trace_attempt_${request.attemptId}`, JSON.stringify({attemptId: request.attemptId, taskId: request.taskId, runId: request.runId, sequence: 1, tool: 'pwsh', argsSha256: 'deadbeef', argsLength: 42, argsHead: 'Get-Content orders.csv', cwd: 'ws'}));
            return {kind: 'provider-failed' as const, exitCode: 1, stdoutText: 'e3-forced-retryable-failure', stderrText: '', reasonCode: 'E3_TEST_RETRYABLE', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()};
          }
          return {kind: 'succeeded' as const, exitCode: 0, stdoutText: 'delivered', providerSessionId: `s-${String(request.attemptId).slice(4, 10)}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), structured: {artifactContent: `e3-deliverable:${String(request.taskId)}`}};
        },
      } as unknown as ExecutorProvider,
    };
    const envForCompose: Record<string, string | undefined> = {
      COS_MODEL_BASE_URL: fixture.url, COS_MODEL_ID: 'e3-fixture-model', COMPANYOS_MODEL_API_KEY: 'e3-local',
      COMPANYOS_EXECUTOR_PROVIDER: CAPTURE_KEY,
      COS_MODEL_ROUTING_MODE: 'SMART_ROUTER_V1', COS_MODEL_ROUTING_POLICY: 'BALANCED',
      COS_MODEL_QUALITY_TIER: 'BALANCED', COS_MODEL_COST_TIER: 'MEDIUM', COS_MODEL_LATENCY_TIER: 'BALANCED',
      COS_MODEL_RELIABILITY_CLASS: 'STANDARD', COS_MODEL_AUTHENTICATION: 'REQUIRED',
    };
    for (const [key, value] of Object.entries(envForCompose)) process.env[key] = value;
    const evidence = compositionEvidence(fixture.observation.emit, ['e3-local']);
    evidence.record('compose-enter', { worker: process.env['VITEST_POOL_ID'] ?? 'NOT_OBSERVED' });
    const core = await composeCoreServices(evidence.database(db), evidence.logger, {
      artifactFoundation: foundation as never,
      ...productionCompositionOptions(envForCompose),
    executionSafety: offlineExecutionSafety,
      executorProviderImplementations: [executor as never],
      goalWorkProfile: {stageKind: 'work', taskKind: GOAL_WORK_KIND, maxAttempts: 3, validatorIds: ['e3.validator']},
      validatorTools: [{
        toolId: 'e3.validator',
        port: {
          describe: () => ({id: 'e3.validator', kind: 'deterministic', displayName: 'E3 validator', version: '1'}),
          invoke: async () => ({ok: true, value: {status: 'ok', output: {verdict: 'pass', evidenceRefs: ['command:e3-validator']}, artifactRefs: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), latencyMs: 1}}),
        } as never,
      }],
    } as never);
    evidence.record('compose-return', { result: core === null ? 'NULL' : 'SERVICES', unobservedStages: 'NOT_OBSERVED', boundaries: evidence.records.slice(-16) });
    if (core === null) throw evidence.failure();
    const opened = await core.repositoryRuntime.openWorkspace({root: join(dataDir, 'ws'), commandProfile: {}});
    if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
    const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
    const registered = await core.models.registerFromProvider({providerId: 'model.openai-compatible', providerModelId: 'e3-fixture-model', modelKey: 'e3.model', actorId: actor});
    if (!registered.ok) throw new Error(registered.error.message);
    const savedPolicy = await core.policies.savePolicy({id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: 'e3.model', actorId: actor} as never);
    if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);

    const controlPlane = core.controlPlane;
    if (controlPlane === null) throw new Error('control plane not wired');
    const created = await controlPlane.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: 'Deliver the E3 retry fixture deliverable.', commandId: `e3-retry-${String(Date.now())}`}});
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const goalRunId = String((created.value as {readonly runId: string}).runId);
    let executionRunId = '';
    for (let turn = 0; turn < 14; turn += 1) {
      const advanced = await controlPlane.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: goalRunId}});
      if (!advanced.ok) throw new Error(JSON.stringify(advanced.error));
      executionRunId = String((advanced.value as {readonly executionRunId: string}).executionRunId);
      if (executionRunId === '') continue;
      const state = String((core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(executionRunId) as {state: string}).state);
      if (state === 'COMPLETED' || state === 'FAILED') break;
    }
    const goalState = String((core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(goalRunId) as {state: string}).state);
    expect(goalState).toBe('COMPLETED'); // attempt 1 failed retryably; attempt 2 delivered

    expect(requests.length).toBeGreaterThanOrEqual(2);
    const first = requests.find((request) => request.attemptNumber === 1)!;
    const second = requests.find((request) => request.attemptNumber === 2)!;

    // identity rules: NEW attempt id, SAME canonical task
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.taskId).toBe(first.taskId);

    // first attempt: NO retry context
    expect((first.work as {retry?: unknown}).retry).toBeUndefined();
    expect(first.work.objective).not.toContain('RETRY CONTEXT');

    // second attempt: the envelope + directive arrive
    const retry = (second.work as {retry?: {schemaVersion: string; previousAttemptId: string; retryOrdinal: number; previousFailureCode: string | null; priorActivity: {toolCallCount: number; lastToolKinds: readonly string[]}; workspaceReuse: boolean}}).retry;
    expect(retry).toBeDefined();
    expect(retry!.schemaVersion).toBe('companyos/retry-continuation/1');
    expect(retry!.previousAttemptId).toBe(first.attemptId);
    expect(retry!.retryOrdinal).toBe(1);
    // the canonical attempt row carries the ENGINE-normalized code; the provider reasonCode is detail
    expect(retry!.previousFailureCode).toBe('PROVIDER_FAILED');
    expect(retry!.priorActivity.toolCallCount).toBe(1);
    expect(retry!.priorActivity.lastToolKinds).toEqual(['pwsh']);
    expect(retry!.workspaceReuse).toBe(true);
    expect(second.work.objective).toContain('RETRY CONTEXT');
    expect(second.work.objective).toContain('verify it against the task acceptance criteria');
    expect(second.work.objective).toContain('not authoritative');
    // bounded + secret-safe: no raw transcript, no credential-shaped data
    const serialized = JSON.stringify(retry) + second.work.objective;
    expect(serialized).not.toContain('argsSha256');
    expect(serialized).not.toContain('e3-local');
    expect(serialized.length).toBeLessThan(6_000);

    // reuse-safety: the directive requires verification; nothing auto-promotes the failed attempt
    const attempts = core.database.db.prepare('SELECT id, state FROM execution_attempts WHERE task_id = ? ORDER BY attempt_number').all(second.taskId) as {id: string; state: string}[];
    expect(attempts[0]!.state).toBe('FAILED'); // the failed attempt was NOT mutated/reopened
    expect(attempts[1]!.id).toBe(second.attemptId);

    // budget/rules unchanged: task max_attempts never grew; retry count = engine semantics
    const taskRow = core.database.db.prepare('SELECT max_attempts, attempts FROM tasks WHERE id = ?').get(second.taskId) as {max_attempts: number; attempts: number};
    expect(taskRow.max_attempts).toBe(3);
    expect(taskRow.attempts).toBe(2);

    // restart determinism: a fresh derivation from the same durable truth equals the delivered envelope
    const reopen = openDurableDatabase({dataDir, appliedAt: 'e3-reopen', chains: [...CHAINS]});
    openDatabases.push(reopen);
    const prior = reopen.db.prepare('SELECT id, attempt_number, state, failure_code, failure_retryable, created_at, settled_at FROM execution_attempts WHERE task_id = ? AND attempt_number < 2 ORDER BY attempt_number, id').all(second.taskId) as never;
    const events = reopen.db.prepare("SELECT type, occurred_at, payload FROM events WHERE aggregate_id = ? AND type IN ('executor.tool_invocation_requested','executor.attempt_activity') ORDER BY rowid LIMIT 200").all(first.attemptId) as never;
    const derived = deriveRetryContinuationEnvelope({
      taskId: second.taskId,
      attemptNumber: 2,
      priorAttempts: (prior as readonly {id: string; attempt_number: number; state: string; failure_code: string | null; failure_retryable: number | null; created_at: string; settled_at: string | null}[]).map((row) => ({
        id: row.id, attemptNumber: row.attempt_number, state: row.state,
        failureCode: row.failure_code, failureRetryable: row.failure_retryable === null ? null : row.failure_retryable === 1,
        createdAt: row.created_at, settledAt: row.settled_at,
      })),
      previousAttemptEvents: (events as readonly {type: string; occurred_at: string; payload: string}[]).map((row) => ({type: row.type, occurredAt: row.occurred_at, payload: JSON.parse(row.payload)})),
    });
    expect(JSON.stringify(derived)).toBe(JSON.stringify(retry));
  });
});
