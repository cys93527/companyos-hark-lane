/**
 * AGENTIC WORK PACKAGE CONTRACT E2E — the canonical Work Envelope proof.
 *
 * The claim this file must earn (Agentic Work Package Contract closeout):
 *
 *   Goal → Plan → pinned WorkflowVersion → Task → WorkPackage projection →
 *   Work Envelope → ExecutorProvider
 *
 * delivers REAL canonical business semantics to an executor that implements ONLY the
 * ExecutorProvider contract:
 *
 *   - work.objective            = the byte-exact compiled plan-item objective (NOT a
 *                                 taskKind label, NOT provider-invented, NOT renderer
 *                                 or model text)
 *   - work.acceptanceCriteria   = the pinned criteria (self-check references — the
 *                                 verdict stays with CompanyOS Validation/Settlement)
 *   - work.taskInputs           = the canonical immutable Task.inputs
 *   - work.memoryView           = a bounded deterministic render (goal + criteria +
 *                                 read-only input references)
 *   - work.artifactRefs         = read-only predecessor artifact references
 *   - roleId                    = the TASK's canonical pinned role (the same seat the
 *                                 ExecutionAttempt records), never a pseudo provider role
 *   - workspace                 = the preflight-proven trusted cwd/root
 *
 * Everything except the two controlled fixtures below is REAL production code; nothing
 * is handed to the provider through test-only parameters.
 *
 * | Component | Class | Why | Bypasses canonical authority? |
 * |---|---|---|---|
 * | planner/supervisor model answers (schema-routed) | CONTROLLED FIXTURE | a deterministic Plan with REAL business semantics is needed to reach the scenario deterministically | NO — the planner turn still runs PlannerRuntime's own validation |
 * | MockAgentExecutorProvider / deterministic provider | CONTROLLED FIXTURE (the SUBJECT under test) | agentic and deterministic implementations entering through the SAME registry, SAME preflight, SAME result contract | NO — they receive canonical identities read-only and return outcomes |
 * | trusted workspace root | CONTROLLED FIXTURE | a real temp directory opened through the trusted-host seam | NO |
 *
 * NOT stubbed anywhere: control-plane command authority, Goal, Plan, WorkflowVersion,
 * Run, Task, ExecutionAttempt claim, WorkPackage projection, preflight, registry,
 * settlement, artifacts, work package, handoff, observation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ok, type DomainError, type ModelProviderPort, type Result } from '@companyos/core';
import {
  executorConfigFingerprint,
  type ExecutorExecutionRequest,
  type ExecutorProvider,
  type ExecutorProviderOutcome,
  type TypedExecutorConfig,
} from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';
import { GOAL_WORK_KIND } from '../../apps/desktop/src/control-plane.js';
import { createMockAgentExecutorProvider } from '../../apps/desktop/tests/support/mock-agent-executor-provider.js';

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'agent-e2e.planner';
const AGENT_KEY = 'agent.mock-e2e';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-agent-e2e-'));
  createdDirs.push(dir);
  return dir;
};

/** A REAL non-trivial business goal — not a toy string. */
const GOAL_OBJECTIVE = '读取本季度客户反馈数据，归类主要投诉主题，并生成可验证的汇总结果。';

/**
 * The goal's CANONICAL structured constraints (human-supplied at goal ingress): the
 * machine-readable input resources, classification rules and output requirements a
 * real executor needs programmatically — NOT natural-language guessing from the
 * objective. This rides the run-goal artifact (16 KiB bounded) and reaches the
 * provider byte-exact as `work.goalStructured`.
 */
const GOAL_STRUCTURED = {
  inputResources: [
    { kind: 'file', ref: 'feedback/2026-Q3-customers.csv' },
    { kind: 'file', ref: 'feedback/2026-Q3-returns.csv' },
  ],
  classificationRules: {
    themes: ['billing', 'shipping', 'quality', 'support'],
    language: 'zh',
    minOccurrencesPerTheme: 3,
  },
  outputRequirements: { format: 'json', fields: ['theme', 'count', 'sourceCitations'], verifiable: true },
} as const;

/** The deterministic legal planning input: a plan with REAL business semantics. */
const CANNED_PLAN = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {
      planItemId: 'extract',
      objective: 'Read the quarter customer feedback records and extract each complaint entry with its raw source reference and category.',
      dependencyPlanItemIds: [],
      acceptanceCriterionRefs: ['sources'],
    },
    {
      planItemId: 'summarize',
      objective: 'Group the extracted complaints into major themes, count occurrences per theme, and generate the verifiable summary with source citations.',
      dependencyPlanItemIds: ['extract'],
      acceptanceCriterionRefs: ['summary'],
    },
  ],
  acceptanceCriteria: [
    { criterionId: 'sources', requirement: 'Every complaint entry carries its raw source reference and category.' },
    { criterionId: 'summary', requirement: 'The summary lists each theme with its occurrence count and at least one verifiable source citation.' },
  ],
};

/** CONTROLLED FIXTURE at the MODEL seam (a different seam from ExecutorProvider). */
const stubModelProvider = (): ModelProviderPort => ({
  describe: () => ({ providerId: 'prov_agent_e2e', kind: 'fake', displayName: 'agent-e2e', version: '1' }),
  listModels: () =>
    Promise.resolve(ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }])),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    const properties =
      (request.responseFormat?.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    let structured: unknown;
    if (!('action' in properties) && !('verdict' in properties)) {
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
        providerId: 'prov_agent_e2e',
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
});

/**
 * The composition-armed deadline (the engine boundary bans engine-held timers), the
 * SAME seam production uses — so the agent's advertised timeout capability is real
 * rather than declared and unenforced.
 */
const armedTimer = (ms: number, onTimeout: () => void): (() => void) => {
  const handle = setTimeout(onTimeout, ms);
  return () => clearTimeout(handle);
};

interface ProviderCapture {
  readonly request: ExecutorExecutionRequest;
  readonly outcome: ExecutorProviderOutcome;
}

/**
 * Wrap a provider so the test can observe what crossed the seam — the request it
 * RECEIVED and the outcome it RETURNED. This wrapper holds no authority: it forwards
 * both directions untouched. The same wrapper shape serves the mock agent and the
 * deterministic comparison provider, so the swap proof compares like with like.
 */
const observing = (
  providerKey: string,
  captures: ProviderCapture[],
  inner: ExecutorProvider,
): { readonly provider: ExecutorProvider; readonly config: TypedExecutorConfig } => {
  const fields = [{ name: 'profile', value: 'agent-e2e', source: 'composition' as const }];
  return {
    config: { providerKey, fields, fingerprint: executorConfigFingerprint(fields) },
    provider: {
      descriptor: inner.descriptor,
      async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
        const outcome = await inner.start(request);
        captures.push({ request, outcome });
        return outcome;
      },
    },
  };
};

const observingAgent = (providerKey: string, captures: ProviderCapture[]) =>
  observing(providerKey, captures, createMockAgentExecutorProvider({ providerKey, timer: armedTimer }));

/** A second, deterministic implementation of the SAME contract (the swap counterpart). */
const observingDeterministic = (providerKey: string, captures: ProviderCapture[]): {
  readonly provider: ExecutorProvider;
  readonly config: TypedExecutorConfig;
} =>
  observing(
    providerKey,
    captures,
    {
      descriptor: { providerKey, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory'] },
      async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
        return {
          kind: 'succeeded',
          exitCode: 0,
          stdoutText: `delivered-by:${providerKey}`,
          // PRODUCTION PARITY with the agent: the same frozen declaration convention
          // (`artifactContent`) so both flows canonicalize an output and the downstream
          // envelope shapes match. The content itself is a provider implementation
          // detail — exactly the difference a swap is allowed to make.
          structured: { artifactContent: `delivered-by:${providerKey}:${request.taskId}` },
          providerSessionId: `session-${providerKey}-${String(request.attemptId).slice(4, 16)}`,
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:01.000Z',
        };
      },
    },
  );

interface AgentE2E {
  readonly core: Core;
  readonly captures: ProviderCapture[];
  readonly workspaceRoot: string;
}

const compose = async (
  providerKey: string,
  makeImplementation: (captures: ProviderCapture[]) => { readonly provider: ExecutorProvider; readonly config: TypedExecutorConfig },
): Promise<AgentE2E> => {
  const captures: ProviderCapture[] = [];
  const workspaceRoot = tempDir();
  const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot: tempDir(), database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', GOAL_WORK_KIND] },
    planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    providerKinds: [GOAL_WORK_KIND],
    providerRoutes: { [GOAL_WORK_KIND]: providerKey },
    repositoryRuntime: { repositoryCapableKinds: [GOAL_WORK_KIND] },
    executorProviderImplementations: [makeImplementation(captures)] as never,
  } as never);
  if (core === null) throw new Error('composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({ root: workspaceRoot, commandProfile: {} });
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(stubModelProvider(), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_agent_e2e', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  const savedPolicy = await core.policies.savePolicy({
    id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor,
  } as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  return { core, captures, workspaceRoot };
};

/** Drive one goal to terminal through the typed surface, and return the canonical ids. */
const driveGoal = async (
  f: AgentE2E,
  objective: string,
  commandId: string,
  structured?: Readonly<Record<string, unknown>>,
) => {
  const cp = f.core.controlPlane!;
  const created = await cp.handle({
    operation: 'goal.create',
    payload: { companyId: COMPANY, objective, commandId, ...(structured === undefined ? {} : { structured }) },
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('goal.create failed');
  const goalRunId = String((created.value as { readonly runId: string }).runId);

  let executionRunId = '';
  let versionId = '';
  for (let turn = 0; turn < 6; turn += 1) {
    const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) throw new Error('goal.advance failed');
    executionRunId = String((advanced.value as { readonly executionRunId: string }).executionRunId);
    versionId = String((advanced.value as { readonly versionId: string }).versionId);
    const states = f.core.database.db
      .prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?')
      .all(GOAL_WORK_KIND, executionRunId) as { state: string }[];
    if (states.length > 0 && states.every((row) => row.state === 'DONE' || row.state === 'FAILED')) break;
  }
  return { cp, goalRunId, executionRunId, versionId };
};

/** The Work Envelope projection of a captured request — the swap comparison key. */
const envelopeOf = (request: ExecutorExecutionRequest): unknown => ({
  objective: request.work.objective,
  // Canonical artifact IDENTITIES are per-run by construction (different runs mint
  // different art_ ids), so the swap compares the reference STRUCTURE: the count and
  // the rendered presence, with ids normalized away.
  memoryView: (request.work.memoryView ?? []).map((line) => line.replace(/art_[a-z0-9]+/gi, 'art_<id>')),
  artifactRefCount: (request.work.artifactRefs ?? []).length,
  taskInputs: request.work.taskInputs ?? null,
  acceptanceCriteria: request.work.acceptanceCriteria ?? null,
  goalStructured: request.work.goalStructured ?? null,
  roleId: request.roleId,
  taskKind: request.taskKind,
  requiredCapabilities: request.requiredCapabilities,
});

describe('AGENTIC WORK PACKAGE CONTRACT E2E — real canonical business semantics reach the ExecutorProvider', () => {
  it('Goal → Plan → pinned Run → Task → WorkPackage → Work Envelope → agent provider → settlement → artifacts → work package → handoff → observation', async () => {
    const f = await compose(AGENT_KEY, (captures) => observingAgent(AGENT_KEY, captures));
    const { cp, goalRunId, executionRunId, versionId } = await driveGoal(
      f,
      GOAL_OBJECTIVE,
      'agent-e2e-1',
      GOAL_STRUCTURED,
    );

    /* ---- the agent was invoked through the registry, once per plan item ---- */
    expect(CANNED_PLAN.planItems.length).toBe(2);
    expect(f.captures.length).toBe(CANNED_PLAN.planItems.length);
    const [first, second] = f.captures as [ProviderCapture, ProviderCapture];
    const request = first.request;

    /* ---- canonical rows the envelope must be consistent with ---- */
    const taskRow = f.core.database.db
      .prepare('SELECT id, state, attempts, run_id, role_id FROM tasks WHERE id = ?')
      .get(
        (f.core.database.db
          .prepare('SELECT task_id FROM execution_attempts WHERE run_id = ? ORDER BY attempt_number')
          .get(executionRunId) as { task_id: string }).task_id,
      ) as { id: string; state: string; attempts: number; run_id: string; role_id: string };
    const attemptRow = f.core.database.db
      .prepare('SELECT id, attempt_number, state, role_id FROM execution_attempts WHERE run_id = ? ORDER BY attempt_number')
      .get(executionRunId) as { id: string; attempt_number: number; state: string; role_id: string };

    /* ---- A. canonical identity (received, never chosen) ---- */
    expect(request.companyId).toBe(COMPANY);
    expect(request.runId).toBe(executionRunId);
    expect(request.taskId).toBe(taskRow.id);
    expect(request.attemptId).toBe(attemptRow.id);
    expect(request.attemptNumber).toBe(attemptRow.attempt_number);
    expect(request.dispatchKey).toMatch(/^dsp_/);

    /* ---- B. objective = the byte-exact compiled plan-item objective ---- */
    expect(request.work.objective).toBe(CANNED_PLAN.planItems[0]!.objective);
    // The real business semantics — NOT the taskKind label, which stays routing identity.
    expect(request.work.objective).not.toContain('Execute task kind');
    expect(request.taskText).toBe(request.work.objective);
    // The SECOND plan item received ITS OWN objective (dependency semantics included).
    expect(second.request.work.objective).toBe(CANNED_PLAN.planItems[1]!.objective);
    expect(second.request.work.objective).not.toBe(request.work.objective);

    /* ---- C. acceptance criteria reach the executor (references, not authority) ---- */
    expect(request.work.acceptanceCriteria).toEqual([
      { criterionId: 'sources', requirement: 'Every complaint entry carries its raw source reference and category.' },
    ]);
    expect(second.request.work.acceptanceCriteria).toEqual([
      { criterionId: 'summary', requirement: 'The summary lists each theme with its occurrence count and at least one verifiable source citation.' },
    ]);

    /* ---- D1. structured inputs: the canonical immutable Task.inputs ---- */
    expect(request.work.taskInputs).toEqual({}); // goal-work tasks carry no typed inputs by design

    /* ---- D2. the goal's structured constraints reach the provider BYTE-EXACT ---- */
    // F4: the durable workspace binding rides the run-goal structured payload (added by
    // the MAIN process at goal.create) — byte-exact WITH the opaque workspace identity.
    expect(request.work.goalStructured).toEqual({ ...GOAL_STRUCTURED, workspaceId: expect.any(String) });
    expect(second.request.work.goalStructured).toEqual({ ...GOAL_STRUCTURED, workspaceId: expect.any(String) });

    /* ---- E. trusted workspace (preflight-proven boundary) ---- */
    expect(request.workspace).not.toBeNull();
    if (request.workspace !== null) {
      expect(request.workspace.cwd).toBe(request.workspace.root ?? request.workspace.cwd);
      expect(typeof request.workspace.cwd).toBe('string');
      expect(request.workspace.cwd.length).toBeGreaterThan(0);
    }

    /* ---- F. role = the task's canonical pinned seat (what the attempt records) ---- */
    expect(request.roleId).toBe(taskRow.role_id);
    expect(request.roleId).toBe(attemptRow.role_id);
    expect(request.roleId).not.toBe('rol.provider'); // no pseudo provider role

    /* ---- G. required capabilities (deployment-static in V1) ---- */
    expect(request.requiredCapabilities).toEqual(['timeout', 'structured-output']);

    /* ---- H/I. memoryView render + input references (bounded, deterministic) ---- */
    const memoryView = request.work.memoryView ?? [];
    expect(memoryView.some((line) => line === `Goal: ${GOAL_OBJECTIVE}`)).toBe(true);
    expect(memoryView.some((line) => line.includes('[sources]') && line.includes('raw source reference'))).toBe(true);
    expect(memoryView.some((line) => line.includes('owns the verdict'))).toBe(true);

    /*
     * CROSS-TASK ARTIFACT PROPAGATION (the Final Readiness Gate proof): plan item 1
     * (extract) declared an output through the frozen `artifactContent` convention →
     * the dispatch materialized it through the ONE Sprint-13 artifact service → the
     * settled envelope carries the canonical reference → the WorkPackage of plan item
     * 2 (its pinned-DAG dependent) projects it → THIS provider receives the reference
     * machine-readably. References only — content never rides the envelope.
     */
    const executorOutputRows = f.core.database.db
      .prepare("SELECT artifact_id, kind, run_id FROM artifacts WHERE kind = 'companyos:executor-output' AND run_id = ?")
      .all(executionRunId) as { artifact_id: string; kind: string; run_id: string }[];
    expect(executorOutputRows.length).toBeGreaterThanOrEqual(1);
    const artifactIds = new Set(executorOutputRows.map((row) => row.artifact_id));
    const downstreamRefs = second.request.work.artifactRefs ?? [];
    expect(downstreamRefs.length).toBeGreaterThanOrEqual(1);
    for (const ref of downstreamRefs) expect(artifactIds.has(ref)).toBe(true);
    expect((second.request.work.memoryView ?? []).some((line) => line.includes(downstreamRefs[0]!))).toBe(true);
    // The FIRST task (no predecessors) received no input references.
    expect(request.work.artifactRefs ?? []).toEqual([]);
    // References only: the request carries no artifact content bytes anywhere.
    expect(JSON.stringify(second.request.work)).not.toContain('Generated result');

    /* ---- the agent returned an outcome, not a verdict ---- */
    expect(first.outcome.kind).toBe('succeeded');
    for (const capture of f.captures) {
      expect(capture.outcome).not.toHaveProperty('taskStatus');
      expect(capture.outcome).not.toHaveProperty('artifacts');
    }

    /* ---- CompanyOS settled canonically ---- */
    expect(taskRow.state).toBe('DONE');
    expect(taskRow.attempts).toBe(1);
    expect(attemptRow.state).toBe('COMPLETED');

    const dispatchRows = f.core.database.db
      .prepare('SELECT dispatch_key, attempt_id, provider_key, state FROM provider_dispatches WHERE run_id = ? ORDER BY attempt_number')
      .all(executionRunId) as { dispatch_key: string; attempt_id: string; provider_key: string; state: string }[];
    expect(dispatchRows).toHaveLength(CANNED_PLAN.planItems.length);
    for (const row of dispatchRows) {
      expect(row.provider_key).toBe(AGENT_KEY);
      expect(row.state).toBe('SETTLED');
    }
    expect(dispatchRows[0]!.dispatch_key).toBe(request.dispatchKey);
    expect(dispatchRows[0]!.attempt_id).toBe(attemptRow.id);

    /* ---- the Run stays PINNED; canonical artifacts unchanged ---- */
    const runRow = f.core.database.db
      .prepare('SELECT version_id, company_id FROM runs WHERE id = ?')
      .get(executionRunId) as { version_id: string; company_id: string };
    expect(runRow.version_id).toBe(versionId);
    expect(runRow.company_id).toBe(COMPANY);
    const goalArtifact = await f.core.database.artifactStore!.getByCreationCommand(`run-goal:${goalRunId}`);
    expect(goalArtifact).not.toBeNull();
    if (goalArtifact !== null) expect(goalArtifact.artifact.kind).toBe('companyos:run-goal');

    /* ---- Work Package projection + Handoff + Observation still canonical ---- */
    const pkg = await f.core.workPackageProjector!.project({ companyId: COMPANY, runId: executionRunId, taskId: taskRow.id });
    expect(pkg.ok).toBe(true);
    const taskObs = await cp.handle({ operation: 'run.task', payload: { companyId: COMPANY, taskId: taskRow.id } });
    expect(taskObs.ok).toBe(true);
    expect(JSON.stringify(taskObs.value)).toContain(AGENT_KEY);
    const workspaceView = await cp.handle({ operation: 'goal.workspace', payload: { companyId: COMPANY, runId: goalRunId } });
    expect(workspaceView.ok).toBe(true);
    if (workspaceView.ok) {
      const ws = workspaceView.value as { readonly goal: { readonly objective: string } | null };
      expect(ws.goal?.objective).toBe(GOAL_OBJECTIVE);
    }

    /* ---- no second truth: one canonical triple per plan item ---- */
    const counts = {
      tasks: (f.core.database.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND kind = ?').get(executionRunId, GOAL_WORK_KIND) as { n: number }).n,
      attempts: (f.core.database.db.prepare('SELECT COUNT(*) AS n FROM execution_attempts WHERE run_id = ?').get(executionRunId) as { n: number }).n,
      dispatches: (f.core.database.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatches WHERE run_id = ?').get(executionRunId) as { n: number }).n,
    };
    expect(counts.tasks).toBe(CANNED_PLAN.planItems.length);
    expect(counts.attempts).toBe(CANNED_PLAN.planItems.length);
    expect(counts.dispatches).toBe(CANNED_PLAN.planItems.length);

    const validationRows = f.core.database.db.prepare('SELECT COUNT(*) AS n FROM validations').get() as { n: number };
    expect(validationRows.n).toBe(0); // zero-validator semantics: nothing pretended to validate
  }, 120_000);

  it('SWAP PROOF: an agent and a deterministic provider receive the IDENTICAL canonical Work Envelope', async () => {
    const SWAP_OBJECTIVE = '整理本季度团队培训记录并生成可核查的覆盖情况汇总。';
    const SWAP_STRUCTURED = {
      inputResources: [{ kind: 'file', ref: 'training/2026-Q3-records.json' }],
      outputRequirements: { format: 'json', fields: ['course', 'attendees', 'coverage'] },
    } as const;
    const agent = await compose('agent.swap-a', (captures) => observingAgent('agent.swap-a', captures));
    const agentRun = await driveGoal(agent, SWAP_OBJECTIVE, 'agent-e2e-swap-a', SWAP_STRUCTURED);

    const deterministic = await compose('deterministic.swap-b', (captures) => observingDeterministic('deterministic.swap-b', captures));
    const deterministicRun = await driveGoal(deterministic, SWAP_OBJECTIVE, 'agent-e2e-swap-b', SWAP_STRUCTURED);

    expect(agent.captures.length).toBe(CANNED_PLAN.planItems.length);
    expect(deterministic.captures.length).toBe(CANNED_PLAN.planItems.length);

    // Same canonical task semantics: the Work Envelope (objective, memoryView,
    // artifactRefs, taskInputs, acceptanceCriteria, roleId, taskKind, required
    // capabilities) is IDENTICAL — only the provider implementation differs.
    for (let index = 0; index < CANNED_PLAN.planItems.length; index += 1) {
      // F4: each fixture's envelope carries ITS OWN run's workspace binding (an opaque
      // per-run identity) — compare everything EXCEPT that per-run binding field.
      const stripBinding = (envelope: { goalStructured?: Record<string, unknown> } | undefined): unknown => {
        if (envelope === undefined) return undefined;
        const { workspaceId: _omitted, ...rest } = envelope.goalStructured ?? {};
        return { ...envelope, goalStructured: rest };
      };
      const agentEnvelope = envelopeOf(agent.captures[index]!.request) as { goalStructured?: Record<string, unknown> } | undefined;
      const detEnvelope = envelopeOf(deterministic.captures[index]!.request) as { goalStructured?: Record<string, unknown> } | undefined;
      expect(stripBinding(agentEnvelope)).toEqual(stripBinding(detEnvelope));
    }

    // And the canonical settlement does not depend on which provider executed.
    const settled = (f: AgentE2E, executionRunId: string) => {
      const task = f.core.database.db
        .prepare('SELECT state, attempts FROM tasks WHERE kind = ? AND run_id = ?')
        .get(GOAL_WORK_KIND, executionRunId) as { state: string; attempts: number };
      const attempt = f.core.database.db
        .prepare('SELECT state FROM execution_attempts WHERE run_id = ?')
        .get(executionRunId) as { state: string };
      return { task, attempt };
    };
    expect(settled(agent, agentRun.executionRunId)).toEqual(settled(deterministic, deterministicRun.executionRunId));

    const dispatchProviderOf = (f: AgentE2E, executionRunId: string): readonly string[] =>
      (f.core.database.db
        .prepare('SELECT provider_key FROM provider_dispatches WHERE run_id = ? ORDER BY attempt_number')
        .all(executionRunId) as { provider_key: string }[]).map((row) => row.provider_key);
    expect(dispatchProviderOf(agent, agentRun.executionRunId)).toEqual(['agent.swap-a', 'agent.swap-a']);
    expect(dispatchProviderOf(deterministic, deterministicRun.executionRunId)).toEqual(['deterministic.swap-b', 'deterministic.swap-b']);
  }, 120_000);
});
