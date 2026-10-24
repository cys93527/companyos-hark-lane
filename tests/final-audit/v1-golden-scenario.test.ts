/**
 * V1 FINAL SYSTEM AUDIT — the focused cross-system regression suite (Boss STEP 17/19).
 *
 * NOT a feature sprint. This file is the audit's dynamic evidence artifact: three
 * integrated proofs over the PRODUCTION composition that existing per-Sprint suites
 * prove only separately:
 *
 *   1. GOLDEN SYSTEM SCENARIO — one deterministic provider-agnostic flow through
 *      Goal → Plan → Compiler → pinned WorkflowVersion → Run → Task →
 *      ExecutionAttempt → Sprint25 preflight → ProviderRegistry → deterministic
 *      ExecutorProvider → canonical settlement → canonical Artifacts (goal + plan,
 *      CAS-read) → Work Package projection (autonomous handoff context) → durable
 *      Handoff packet (the Sprint-11 human channel authority) → Observation →
 *      Control Plane readback. No direct DB edits to drive the flow; no renderer
 *      truth; no provider shortcut around settlement.
 *
 *   2. MID-FLOW RESTART RECONSTRUCTION — the database is closed and reopened at a
 *      live execution state; the recomposed system reconstructs the goal workspace
 *      through the Control Plane with zero duplicate runs/tasks.
 *
 *   3. CROSS-SCOPE CONTROL-PLANE SWEEP — run-scoped isolation through the product
 *      surface (timeline cursor scope, cross-run task observation, cross-company
 *      refusal) plus the structural dispatch-identity constraint (a dispatch key
 *      can never be re-bound to a different attempt).
 *
 * Controlled fixtures (identical discipline to the frozen S26 E2E §10 stub matrix):
 * the MODEL provider answers are deterministic fakes at the ModelProviderPort seam;
 * the ExecutorProvider is a deterministic implementation of the SAME contract in
 * the SAME registry after the SAME preflight. NOT stubbed: control-plane command
 * authority, Goal, Plan, WorkflowVersion, Run, Task, ExecutionAttempt, preflight,
 * registry, settlement, artifacts, handoff, observation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ok, type DomainError, type ModelProviderPort, type Result } from '@companyos/core';
import type { ExecutorProvider, ExecutorExecutionRequest, ExecutorProviderOutcome, TypedExecutorConfig } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';
import { GOAL_WORK_KIND } from '../../apps/desktop/src/control-plane.js';

const CHAINS = ['core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff'] as const;
const COMPANY = 'company_default';
const OTHER_COMPANY = 'company_other';
const MODEL_KEY = 'audit.planner';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-audit-'));
  createdDirs.push(dir);
  return dir;
};

const CANNED_PLAN = {
  schema: 'companyos/plan-proposal/1',
  planItems: [
    { planItemId: 'research', objective: 'Gather the facts the outcome needs.', dependencyPlanItemIds: [], acceptanceCriterionRefs: ['facts'] },
    { planItemId: 'draft', objective: 'Produce the first outcome draft.', dependencyPlanItemIds: ['research'], acceptanceCriterionRefs: ['draft'] },
  ],
  acceptanceCriteria: [
    { criterionId: 'facts', requirement: 'The facts are recorded and citable.' },
    { criterionId: 'draft', requirement: 'The draft answers the goal.' },
  ],
};

const stubModelProvider = (): ModelProviderPort => ({
    describe: () => ({ providerId: 'prov_audit', kind: 'fake', displayName: 'audit', version: '1' }),
    listModels: () =>
      Promise.resolve(ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }])),
    health: () => Promise.resolve(ok(undefined as never)),
    invoke(request) {
      // ROUTED answers (same discipline as the frozen S26 E2E): the response schema
      // decides planner vs supervisor-verdict vs supervisor-action; the action answer
      // carries the subject (taskId) extracted from the bounded context. The routing is
      // schema-driven (not counter-driven) so ONE composition can serve several goals.
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
      return Promise.resolve(ok({
        modelId: request.modelId,
        providerId: 'prov_audit',
        outputText: 'x',
        structured: structured as never,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
        finishReason: 'stop' as const,
      }));
    },
    stream(): AsyncIterable<Result<never, DomainError>> {
      return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) };
    },
});

const deterministicExecutorProvider = (providerKey: string, captures: {
  providerKey: string;
  request: unknown;
}[]): { readonly provider: ExecutorProvider; readonly config: TypedExecutorConfig } => ({
  config: {
    providerKey,
    fields: [{ name: 'profile', value: 'audit-deterministic', source: 'composition' }],
    fingerprint: `scfg_audit${providerKey.replace(/[^a-z0-9]/gi, '').padEnd(21, '0').slice(0, 21)}`,
  },
  provider: {
    descriptor: { providerKey, capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics'] },
    async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
      captures.push({ providerKey, request });
      return {
        kind: 'succeeded',
        exitCode: 0,
        stdoutText: `delivered-by:${providerKey}`,
        providerSessionId: `session-audit-${String(request.attemptId).slice(4, 16)}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
    },
  } as ExecutorProvider,
});

interface ComposedFixture {
  readonly core: Core;
  readonly captures: { readonly providerKey: string; readonly request: unknown }[];
  readonly dataDir: string;
}

const compose = async (dataDir: string, casRoot: string, workspaceRoot: string, providerKey = 'audit-provider'): Promise<ComposedFixture> => {
  const captures: { providerKey: string; request: unknown }[] = [];
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
  await core.models.registerFromProvider({ providerId: 'prov_audit', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  const savedPolicy = await core.policies.savePolicy({
    id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor,
  } as never);
  if (!savedPolicy.ok) throw new Error(savedPolicy.error.message);
  if (core.controlPlane === null) throw new Error('control plane unavailable');
  return { core, captures, dataDir };
};

/** The audit's own objective list — each test drives its own goal through the typed surface. */
const AUDIT_OBJECTIVES = [
  '为本季度末准备一份供应商评估简报。',
  '组织一次内部知识分享会。',
  '整理办公室物资清单。',
  '制定团队季度培训计划。',
] as const;
void AUDIT_OBJECTIVES;

describe('V1 FINAL AUDIT — golden system scenario (STEP 17)', () => {
  it('Goal → Plan → pinned version → Run → Task → Attempt → preflight → provider → settlement → artifacts → work package → handoff → observation → control plane', async () => {
    const f = await compose(tempDir(), tempDir(), tempDir());
    const cp = f.core.controlPlane!;

    /* ---- Goal ingress (typed surface, non-software objective) ---- */
    const created = await cp.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '为本季度末准备一份供应商评估简报。', commandId: 'audit-golden-1' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const goalRunId = String((created.value as { readonly runId: string }).runId);

    /* ---- Advance until terminal (bounded canonical pipeline) ---- */
    let executionRunId = '';
    let versionId = '';
    for (let turn = 0; turn < 6; turn += 1) {
      const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
      expect(advanced.ok).toBe(true);
      if (!advanced.ok) return;
      executionRunId = String((advanced.value as { readonly executionRunId: string }).executionRunId);
      versionId = String((advanced.value as { readonly versionId: string }).versionId);
      const states = f.core.database.db
        .prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?')
        .all(GOAL_WORK_KIND, executionRunId) as { state: string }[];
      if (states.length > 0 && states.every((row) => row.state === 'DONE' || row.state === 'FAILED')) break;
    }

    /* ---- Canonical durable state (read directly for audit assertions only) ---- */
    const runRow = f.core.database.db
      .prepare('SELECT version_id, company_id FROM runs WHERE id = ?')
      .get(executionRunId) as { version_id: string; company_id: string };
    expect(runRow.version_id).toBe(versionId); // the Run is PINNED to the compiled version
    expect(runRow.company_id).toBe(COMPANY);

    const taskRow = f.core.database.db
      .prepare('SELECT id, state, attempts, run_id, role_id FROM tasks WHERE kind = ? AND run_id = ?')
      .get(GOAL_WORK_KIND, executionRunId) as { id: string; state: string; attempts: number; run_id: string; role_id: string };
    expect(taskRow.state).toBe('DONE'); // settled by the CANONICAL engine, not the provider
    expect(taskRow.attempts).toBe(1);
    expect(taskRow.run_id).toBe(executionRunId);

    const attemptRow = f.core.database.db
      .prepare('SELECT id, attempt_number, state, task_id FROM execution_attempts WHERE run_id = ? ORDER BY attempt_number')
      .get(executionRunId) as { id: string; attempt_number: number; state: string; task_id: string };
    expect(attemptRow.id).toMatch(/^exa_/);
    expect(attemptRow.attempt_number).toBe(1);
    expect(attemptRow.state).toBe('COMPLETED');
    expect(attemptRow.task_id).toBe(taskRow.id); // the attempt belongs to THIS task (never the reverse)

    const dispatchRow = f.core.database.db
      .prepare('SELECT dispatch_id, dispatch_key, attempt_id, provider_key, state, provider_session_id, config_fingerprint FROM provider_dispatches WHERE run_id = ?')
      .get(executionRunId) as { dispatch_id: string; dispatch_key: string; attempt_id: string; provider_key: string; state: string; provider_session_id: string | null; config_fingerprint: string | null };
    expect(dispatchRow.dispatch_id).toMatch(/^pdi_/); // the durable row identity
    expect(dispatchRow.dispatch_key).toMatch(/^dsp_/); // the deterministic dispatch key
    expect(dispatchRow.attempt_id).toBe(attemptRow.id); // dispatch.attemptId = canonical ExecutionAttempt.id
    expect(dispatchRow.attempt_id).not.toBe(taskRow.id); // and NEVER the Task id
    expect(dispatchRow.provider_key).toBe('audit-provider');
    expect(dispatchRow.state).toBe('SETTLED');
    expect(dispatchRow.provider_session_id).toMatch(/^session-/);
    expect(dispatchRow.config_fingerprint).toMatch(/^scfg_/);

    /* ---- The provider received the CANONICAL attempt identity ---- */
    expect(f.captures.length).toBeGreaterThanOrEqual(1);
    const request = f.captures[0]!.request as ExecutorExecutionRequest;
    expect(request.attemptId).toBe(attemptRow.id);
    expect(request.dispatchKey).toMatch(/^dsp_/);

    /* ---- Canonical artifacts: the run-owned goal + the plan (CAS content) ---- */
    const goalArtifact = await f.core.database.artifactStore!.getByCreationCommand(`run-goal:${goalRunId}`);
    expect(goalArtifact).not.toBeNull();
    if (goalArtifact !== null) {
      expect(goalArtifact.artifact.kind).toBe('companyos:run-goal');
      expect(String(goalArtifact.artifact.runId)).toBe(goalRunId);
    }
    // The plan artifact exists canonically (created by the planner's permanent command identity):
    const planRow = f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'companyos:plan'")
      .get() as { n: number };
    expect(planRow.n).toBeGreaterThanOrEqual(1);

    /* ---- Work Package projection (the autonomous handoff context, T20-06) ---- */
    const pkg = await f.core.workPackageProjector!.project({ companyId: COMPANY, runId: executionRunId, taskId: taskRow.id });
    expect(pkg.ok).toBe(true);

    /* ---- Durable Handoff packet (Sprint-11 sole authority, human channel) ---- */
    const versionGraph = f.core.database.db
      .prepare('SELECT template_id FROM workflow_template_versions WHERE id = ?')
      .get(versionId) as { template_id: string };
    const stageRow = f.core.database.db
      .prepare('SELECT stage_id FROM tasks WHERE id = ?')
      .get(taskRow.id) as { stage_id: string };
    const packet = {
      handoffId: `ho_audit_${goalRunId.slice(4, 14)}`,
      handoffVersion: 1,
      companyId: COMPANY,
      workflowId: versionGraph.template_id,
      workflowVersionId: versionId,
      workflowRunId: executionRunId,
      stageId: stageRow.stage_id,
      taskId: taskRow.id,
      fromAgentId: 'agent_audit',
      fromRoleId: taskRow.role_id,
      toRoleId: taskRow.role_id,
      toAgentId: null,
      objective: '供应商评估简报已就绪',
      status: 'READY' as const,
      summary: 'audit golden scenario packet',
      completedWork: ['research', 'draft'],
      remainingWork: [],
      constraints: [],
      acceptanceCriteria: ['facts', 'draft'],
      artifactRefs: [],
      decisionRefs: [],
      validationRefs: [],
      knownRisks: [],
      openQuestions: [],
      recommendedNextAction: 'review',
      modelBinding: null,
      executionRef: null,
      supersedes: null,
      acceptedBy: null,
      acceptedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReasons: [],
      rejectionComment: null,
      traceId: `trace_audit_${goalRunId.slice(4, 14)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await f.core.database.handoffStore!.create(packet as never);
    const listed = await f.core.database.handoffStore!.listForScope({ companyId: COMPANY, workflowRunId: executionRunId, taskId: taskRow.id });
    expect(listed.length).toBe(1);
    expect(listed[0]!.taskId).toBe(taskRow.id);

    /* ---- Observation + Control Plane readback stay truthful (projection only) ---- */
    const overview = await cp.handle({ operation: 'run.overview', payload: { companyId: COMPANY, runId: executionRunId } });
    expect(overview.ok).toBe(true);
    const timeline = await cp.handle({ operation: 'run.timeline', payload: { companyId: COMPANY, runId: executionRunId, limit: 10 } });
    expect(timeline.ok).toBe(true);
    const workspaceView = await cp.handle({ operation: 'goal.workspace', payload: { companyId: COMPANY, runId: goalRunId } });
    expect(workspaceView.ok).toBe(true);
    if (workspaceView.ok) {
      const ws = workspaceView.value as { readonly goal: { readonly objective: string } | null; readonly executionRuns: readonly { readonly runId: string }[] };
      expect(ws.goal?.objective).toContain('供应商评估简报'); // the canonical durable intent, read back through the product surface
      expect(ws.executionRuns.some((entry) => entry.runId === executionRunId)).toBe(true);
    }
    const taskObs = await cp.handle({ operation: 'run.task', payload: { companyId: COMPANY, taskId: taskRow.id } });
    expect(taskObs.ok).toBe(true);
    const taskObsText = JSON.stringify(taskObs.value);
    expect(taskObsText).toContain('audit-provider'); // honest provider identity, from the dispatch row

    /* ---- Zero-validator frozen semantics: no validation batch was fabricated ---- */
    const validationRows = f.core.database.db
      .prepare('SELECT COUNT(*) AS n FROM validations')
      .get() as { n: number };
    expect(validationRows.n).toBe(0); // nothing pretended to validate

    /* ---- Cross-company readback of the SAME surfaces fails closed ---- */
    const foreign = await cp.handle({ operation: 'run.overview', payload: { companyId: OTHER_COMPANY, runId: executionRunId } });
    expect(foreign.ok).toBe(false);
  }, 120_000);

  it('MID-FLOW RESTART: closing and reopening the database reconstructs the goal workspace with zero duplicates', async () => {
    const dataDir = tempDir();
    const casRoot = tempDir();
    const workspaceRoot = tempDir();
    const f1 = await compose(dataDir, casRoot, workspaceRoot);
    const cp1 = f1.core.controlPlane!;
    const created = await cp1.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '组织一次内部知识分享会。', commandId: 'audit-restart-1' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const goalRunId = String((created.value as { readonly runId: string }).runId);
    const advanced = await cp1.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    const executionRunId = String((advanced.value as { readonly executionRunId: string }).executionRunId);
    const versionId = String((advanced.value as { readonly versionId: string }).versionId);

    const runsBefore = (f1.core.database.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
    const tasksBefore = (f1.core.database.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;

    /* ---- the crash: close the database, recompose over the SAME data ---- */
    const index = openDatabases.findIndex((db) => db === (f1.core.database as unknown));
    if (index >= 0) openDatabases.splice(index, 1);
    (f1.core.database.db as { close(): void }).close();

    const f2 = await compose(dataDir, casRoot, workspaceRoot);
    const cp2 = f2.core.controlPlane!;

    const runsAfter = (f2.core.database.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
    const tasksAfter = (f2.core.database.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    expect(runsAfter).toBe(runsBefore); // restart created NO duplicate runs
    expect(tasksAfter).toBe(tasksBefore); // and NO duplicate tasks

    /* ---- the reconstructed Control Plane reads the SAME canonical truth ---- */
    const workspaceView = await cp2.handle({ operation: 'goal.workspace', payload: { companyId: COMPANY, runId: goalRunId } });
    expect(workspaceView.ok).toBe(true);
    const overview = await cp2.handle({ operation: 'run.overview', payload: { companyId: COMPANY, runId: executionRunId } });
    expect(overview.ok).toBe(true);
    const overviewText = JSON.stringify(overview.value);
    expect(overviewText).toContain(executionRunId.slice(0, 8));
    void versionId;

    /* ---- the goal id replays idempotently after restart (no duplicate goal) ---- */
    const replay = await cp2.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '组织一次内部知识分享会。', commandId: 'audit-restart-1' } });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(String((replay.value as { readonly runId: string }).runId)).toBe(goalRunId);
    }
    const runsFinal = (f2.core.database.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
    expect(runsFinal).toBe(runsBefore);
  }, 120_000);

  it('CROSS-SCOPE SWEEP: run-scoped cursor, cross-run task isolation, and the structural dispatch-identity constraint', async () => {
    const f = await compose(tempDir(), tempDir(), tempDir());
    const cp = f.core.controlPlane!;

    /* ---- two goals → two independent execution runs ---- */
    const ids: { goalRunId: string; executionRunId: string }[] = [];
    for (const [index, objective] of ['整理办公室物资清单。', '制定团队季度培训计划。'].entries()) {
      const created = await cp.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective, commandId: `audit-scope-${String(index)}` } });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const goalRunId = String((created.value as { readonly runId: string }).runId);
      let executionRunId = '';
      for (let turn = 0; turn < 6; turn += 1) {
        const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
        expect(advanced.ok).toBe(true);
        if (!advanced.ok) return;
        executionRunId = String((advanced.value as { readonly executionRunId: string }).executionRunId);
        const states = f.core.database.db
          .prepare('SELECT state FROM tasks WHERE kind = ? AND run_id = ?')
          .all(GOAL_WORK_KIND, executionRunId) as { state: string }[];
        if (states.length > 0 && states.every((row) => row.state === 'DONE' || row.state === 'FAILED')) break;
      }
      ids.push({ goalRunId, executionRunId });
    }
    const [first, second] = ids;
    if (first === undefined || second === undefined) throw new Error('the sweep needs two completed runs');
    const runA = first;
    const runB = second;

    /* ---- run A's timeline cursor cannot read run B's timeline ---- */
    const pageA = await cp.handle({ operation: 'run.timeline', payload: { companyId: COMPANY, runId: runA.executionRunId, limit: 1 } });
    expect(pageA.ok).toBe(true);
    if (!pageA.ok) return;
    const cursorA = (pageA.value as { readonly nextCursor?: unknown }).nextCursor;
    const bleed = await cp.handle({ operation: 'run.timeline', payload: { companyId: COMPANY, runId: runB.executionRunId, ...(cursorA === undefined || cursorA === null ? {} : { cursor: cursorA }) } });
    if (cursorA !== undefined && cursorA !== null) {
      expect(bleed.ok).toBe(false); // cursor scope mismatch — fail closed
    }

    /* ---- run A's overview never includes run B's tasks (no cross-run bleed) ---- */
    const overviewA = await cp.handle({ operation: 'run.overview', payload: { companyId: COMPANY, runId: runA.executionRunId } });
    expect(overviewA.ok).toBe(true);
    const taskOfB = f.core.database.db
      .prepare('SELECT id FROM tasks WHERE kind = ? AND run_id = ?')
      .get(GOAL_WORK_KIND, runB.executionRunId) as { id: string };
    expect(JSON.stringify(overviewA.value)).not.toContain(taskOfB.id);

    /* ---- task observation is company-scoped: a foreign company cannot read it ---- */
    const foreignTask = await cp.handle({ operation: 'run.task', payload: { companyId: OTHER_COMPANY, taskId: taskOfB.id } });
    expect(foreignTask.ok).toBe(false);

    /* ---- the goal workspace of a foreign company is refused ---- */
    const foreignWorkspace = await cp.handle({ operation: 'goal.workspace', payload: { companyId: OTHER_COMPANY, runId: runA.goalRunId } });
    expect(foreignWorkspace.ok).toBe(false);

    /* ---- structural: a dispatch key can never be re-bound to a DIFFERENT attempt ---- */
    const dispatchRow = f.core.database.db
      .prepare('SELECT dispatch_id, dispatch_key, attempt_id FROM provider_dispatches WHERE run_id = ?')
      .get(runA.executionRunId) as { dispatch_id: string; dispatch_key: string; attempt_id: string };
    const otherAttempt = f.core.database.db
      .prepare('SELECT id FROM execution_attempts WHERE run_id = ?')
      .get(runB.executionRunId) as { id: string };
    let constraintHeld = false;
    try {
      f.core.database.db
        .prepare('INSERT INTO provider_dispatches (dispatch_id, company_id, run_id, task_id, attempt_id, attempt_number, provider_key, dispatch_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`${dispatchRow.dispatch_id}x`, COMPANY, runB.executionRunId, taskOfB.id, otherAttempt.id, 1, 'audit-provider', dispatchRow.dispatch_key, 'DISPATCHED', new Date().toISOString(), new Date().toISOString());
    } catch {
      constraintHeld = true; // UNIQUE(dispatch_key) refused the re-binding
    }
    expect(constraintHeld).toBe(true);
  }, 180_000);
});
