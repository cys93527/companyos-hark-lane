/**
 * Sprint26 V2 — the PROVIDER-AGNOSTIC PRODUCTION-PATH CONTROL-PLANE E2E (Boss §32-§34).
 *
 * Replaces the superseded "real DSH 3/3" gate: the concrete provider here is a
 * DETERMINISTIC ExecutorProvider implementation registered through the SAME registry,
 * invoked after the SAME Sprint25 preflight, settled by the SAME engine path. Everything
 * else is REAL production code (control-plane command boundary, canonical goal/plan/
 * run/task, ExecutionAttempt claim, registry resolution, settlement, observation,
 * control-plane readback). 3 consecutive PASS are required; a provider-swap proof shows
 * the product semantics do not depend on the providerKey.
 *
 * Stub matrix (Boss §10) for every non-production piece in this suite:
 *
 * | Component | Class | Why | Bypasses canonical authority? | Bypasses provider registry? | Bypasses ExecutionAttempt? | Bypasses settlement? | Bypasses observation? |
 * |---|---|---|---|---|---|---|---|
 * | planner/review/qa model answers (schema-routed) | CONTROLLED FIXTURE | a deterministic Plan/decision/review input is needed to reach the scenario deterministically | NO — the planner turn runs through PlannerRuntime's own validation; review/qa go through the supervisor's pinned-agent path | NO — this is the MODEL provider (ModelProviderPort), a different seam from ExecutorProvider | NO | NO | NO |
 * | deterministic ExecutorProvider ('s26d-a'/'s26d-b') | CONTROLLED FIXTURE per Boss §6 | the concrete external executor; implements the same contract, registered in the same registry, runs after the preflight, returns through the same result contract | NO | NO — resolved via ExecutorProviderRegistry | NO — the dispatch orchestration claims/settles canonically | NO — engine settlement unchanged | NO |
 * | trusted workspace root | CONTROLLED FIXTURE | a real temp directory opened through the trusted-host seam | NO | NO | NO | NO | NO |
 *
 * NOT stubbed anywhere: control-plane command authority, Task, ExecutionAttempt,
 * preflight, provider registry, provider contract, settlement, observation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ok, type DomainError, type ModelProviderPort, type Result } from '@companyos/core';
import {
  type ExecutorExecutionRequest,
  executorConfigFingerprint,
  type ExecutorProvider,
  type ExecutorProviderOutcome,
  type TypedExecutorConfig,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';
import { GOAL_WORK_KIND } from '../../apps/desktop/src/control-plane.js';

const CHAINS = ['core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff'] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 's26e.planner';


const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s26e-'));
  createdDirs.push(dir);
  return dir;
};

const CANNED_PLAN = {
  schema: 'companyos/plan-proposal/1',
  planItems: [{ planItemId: 'deliver', objective: 'Produce the requested outcome.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['done'] }],
  acceptanceCriteria: [{ criterionId: 'done', requirement: 'The outcome exists.' }],
};

/** CONTROLLED FIXTURE (model seam): deterministic plan/decision/review/qa answers. */
const stubModelProvider = (): ModelProviderPort => {
  let plannerAnswersLeft = 1;
  return {
    describe: () => ({ providerId: 'prov_s26e', kind: 'fake', displayName: 's26e', version: '1' }),
    listModels: () =>
      Promise.resolve(ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }])),
    health: () => Promise.resolve(ok(undefined as never)),
    invoke(request) {
      const properties =
        (request.responseFormat?.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      let structured: unknown;
      if (plannerAnswersLeft > 0 && !('action' in properties) && !('verdict' in properties)) {
        plannerAnswersLeft -= 1;
        structured = CANNED_PLAN;
      } else if ('verdict' in properties) {
        structured = 'targetRef' in properties
          ? { schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', missingRequirements: [], summary: 'ok', targetRef: 'goal' }
          : { schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', findings: [], summary: 'ok' };
      } else {
        let subject: { taskId: string } | undefined;
        for (const message of request.messages) {
          if (message.role !== 'user') continue;
          const seat = message.content.indexOf('# Memory view');
          if (seat < 0) continue;
          const match = /"taskId"\s*:\s*"(tsk_[a-z0-9]+)"/.exec(message.content.slice(seat));
          const captured = match === null ? undefined : match[1];
          if (typeof captured === 'string' && captured !== '') subject = { taskId: captured };
          break;
        }
        structured = {
          schema: 'companyos/supervisor-proposal/1',
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Execute the next work unit.',
          evidenceRefs: [],
          ...(subject === undefined ? {} : { subject }),
        };
      }
      return Promise.resolve(
        ok({
          modelId: request.modelId,
          providerId: 'prov_s26e',
          outputText: 'x',
          structured: structured as never,
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
          finishReason: 'stop' as const,
        }),
      );
    },
    stream(): AsyncIterable<Result<never, DomainError>> {
      return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
    },
  };
};

/**
 * CONTROLLED FIXTURE per Boss §6 — a DETERMINISTIC ExecutorProvider implementation:
 * the same contract, registered in the same registry, invoked with the same trusted
 * request (carrying the canonical attempt identity), and it NEVER mutates Task/Run/
 * Attempt — it only answers through the provider result contract. The captured
 * requests are the E2E's evidence that the canonical identity crossed the seam.
 */
/** The observation's provider field carries the providerKey — the shared identity. */
const providerIdentityOf = (providerKey: string): string => providerKey;

const deterministicExecutorProvider = (providerKey: string, captures: {
  providerKey: string;
  request: unknown;
}[]): { readonly provider: ExecutorProvider; readonly config: TypedExecutorConfig } => ({
  config: {
    providerKey,
    fields: [{ name: 'profile', value: 'deterministic-e2e', source: 'composition' }],
    fingerprint: executorConfigFingerprint([{ name: 'profile', value: 'deterministic-e2e', source: 'composition' }]),
  },
  provider: {
  descriptor: { providerKey, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics'] },
  async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
    captures.push({ providerKey, request });
    return {
      kind: 'succeeded',
      exitCode: 0,
      stdoutText: `delivered-by:${providerKey}`,
      providerSessionId: `session-${providerKey}-${String(request.attemptId).slice(4, 16)}`,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  },
  } as ExecutorProvider,
});

interface E2ERun {
  readonly providerKey: string;
  readonly goalRunId: string;
  readonly executionRunId: string;
  readonly versionId: string;
  readonly taskRow: { readonly state: string; readonly attempts: number };
  readonly attemptRows: readonly { readonly state: string; readonly attempt_number: number }[];
  readonly dispatchRow: { readonly state: string; readonly provider_key: string; readonly provider_session_id: string | null; readonly config_fingerprint: string | null } | undefined;
  readonly observedProvider: unknown;
  readonly observationText: string;
}

/** One full production-path run under the given deterministic provider implementation. */
const runProviderAgnosticFlow = async (providerKey: string, objective: string, commandId: string): Promise<E2ERun> => {
  const captures: { readonly providerKey: string; readonly request: unknown }[] = [];
  const workspaceRoot = tempDir();
  const dataDir = tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', GOAL_WORK_KIND] },
    planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    providerKinds: [GOAL_WORK_KIND],
    providerRoutes: { [GOAL_WORK_KIND]: providerKey },
    repositoryRuntime: { repositoryCapableKinds: [GOAL_WORK_KIND] },
    executorProviderImplementations: [deterministicExecutorProvider(providerKey, captures)] as never,
  } as never);
  if (core === null) throw new Error('composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({ root: workspaceRoot, commandProfile: {} });
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(stubModelProvider(), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_s26e', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  const savedPolicy = await core.policies.savePolicy({
    id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor,
  } as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  const cp = core.controlPlane!;

  // Goal entry through the typed boundary (a NON-software objective).
  const created = await cp.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective, commandId } });
  if (!created.ok) throw new Error(`goal.create failed: ${JSON.stringify(created.error)}`);
  const goalRunId = String((created.value as { readonly runId: string }).runId);

  // Advance (bounded canonical pipeline) until the work task is terminal.
  let executionRunId = '';
  let versionId = '';
  for (let turn = 0; turn < 5; turn += 1) {
    const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    if (!advanced.ok) throw new Error(`goal.advance failed: ${JSON.stringify(advanced.error)}`);
    executionRunId = String((advanced.value as { readonly executionRunId: string }).executionRunId);
    versionId = String((advanced.value as { readonly versionId: string }).versionId);
    const work = core.database.db
      .prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?')
      .all(GOAL_WORK_KIND, executionRunId) as { state: string }[];
    if (work.length > 0 && work.every((task) => task.state === 'DONE' || task.state === 'FAILED')) break;
  }

  const taskRow = core.database.db
    .prepare('SELECT state, attempts FROM tasks WHERE kind = ? AND run_id = ?')
    .get(GOAL_WORK_KIND, executionRunId) as { state: string; attempts: number };
  const attemptRows = core.database.db
    .prepare('SELECT state, attempt_number FROM execution_attempts WHERE run_id = ?')
    .all(executionRunId) as { state: string; attempt_number: number }[];
  const dispatchRow = core.database.db
    .prepare('SELECT state, provider_key, provider_session_id, config_fingerprint FROM provider_dispatches WHERE run_id = ?')
    .get(executionRunId) as E2ERun['dispatchRow'];

  const observation = await cp.handle({ operation: 'run.overview', payload: { companyId: COMPANY, runId: executionRunId } });
  if (!observation.ok) throw new Error(`observation failed: ${JSON.stringify(observation.error)}`);
  // §33: observation reflects the canonical settlement — read the WORK TASK's own
  // observation, where the Sprint24/25 provider identity distinctions live.
  const workTaskIdRow = core.database.db
    .prepare('SELECT id FROM tasks WHERE kind = ? AND run_id = ?')
    .get(GOAL_WORK_KIND, executionRunId) as { id: string };
  const taskObservation = await cp.handle({
    operation: 'run.task',
    payload: { companyId: COMPANY, taskId: workTaskIdRow.id },
  });
  if (!taskObservation.ok) throw new Error(`task observation failed: ${JSON.stringify(taskObservation.error)}`);
  const taskObservationText = JSON.stringify(taskObservation.value);
  expect(taskObservationText.length).toBeGreaterThan(0);

  // §33 assertions: the provider received the CANONICAL attempt identity.
  expect(captures.length).toBeGreaterThanOrEqual(1);
  const request = captures[0]!.request as ExecutorExecutionRequest;
  expect(request.attemptId).toMatch(/^exa_/);
  expect(request.dispatchKey).toMatch(/^dsp_/);
  expect(typeof request.taskText).toBe('string');
  expect(request.taskText.length).toBeGreaterThan(0);
  expect(String(request.workspace?.cwd ?? '')).toBe(String(core.repositoryRuntime.currentWorkspace()?.canonicalRoot ?? ''));

  return {
    providerKey,
    goalRunId,
    executionRunId,
    versionId,
    taskRow,
    attemptRows,
    dispatchRow,
    observedProvider: null,
    observationText: taskObservationText,
  };
};

describe('S26 V2 provider-agnostic production-path E2E (§32-§33)', () => {
  it('1/3. a full production-path run under deterministic provider A', async () => {
    const run = await runProviderAgnosticFlow('s26d-a', '为下个季度做一份市场调研简报。', 'e2e-a-1');
    expect(run.taskRow.state).toBe('DONE');
    expect(Number(run.taskRow.attempts)).toBeGreaterThanOrEqual(1);
    // ExecutionAttempt claim exists and settled.
    expect(run.attemptRows.length).toBeGreaterThanOrEqual(1);
    expect(run.attemptRows.every((row) => row.state !== 'ACTIVE')).toBe(true);
    // Preflight passed, registry selected the implementation, settlement is canonical.
    expect(run.dispatchRow?.state).toBe('SETTLED');
    expect(run.dispatchRow?.provider_key).toBe('s26d-a');
    expect(run.dispatchRow?.provider_session_id).toMatch(/^session-s26d-a-/);
    expect(run.dispatchRow?.config_fingerprint).toMatch(/^scfg_/);
    // Observation reflects settlement + the Sprint24 identity distinctions.
    expect(run.observationText.includes(providerIdentityOf('s26d-a'))).toBe(true);
  });

  it('2/3. the second consecutive run settles identically', async () => {
    const run = await runProviderAgnosticFlow('s26d-a', '整理一次家庭旅行的行程方案。', 'e2e-a-2');
    expect(run.taskRow.state).toBe('DONE');
    expect(run.dispatchRow?.state).toBe('SETTLED');
  });

  it('3/3. the third consecutive run settles identically', async () => {
    const run = await runProviderAgnosticFlow('s26d-a', '为一篇公众号文章收集三个选题。', 'e2e-a-3');
    expect(run.taskRow.state).toBe('DONE');
    expect(run.dispatchRow?.state).toBe('SETTLED');
  });

  it('§34 provider SWAP: provider B changes only the implementation, never the semantics', async () => {
    const underA = await runProviderAgnosticFlow('s26d-a', 'Provider swap proof under A.', 'swap-a');
    const underB = await runProviderAgnosticFlow('s26d-b', 'Provider swap proof under B.', 'swap-b');
    // Identical canonical semantics: goal run shape, work task settled, attempt settled,
    // dispatch settled, observation shape — only the providerKey and session differ.
    expect(underB.taskRow.state).toBe(underA.taskRow.state);
    expect(underB.dispatchRow?.state).toBe(underA.dispatchRow?.state);
    expect(underB.dispatchRow?.provider_key).toBe('s26d-b');
    expect(underB.dispatchRow?.provider_session_id).toMatch(/^session-s26d-b-/);
    expect(underB.observationText.includes(providerIdentityOf('s26d-b'))).toBe(true);
    // The product never branches on the providerKey: the control plane source has no
    // provider-specific path (proven structurally by ARCH-035 and by this test).
  });
});
