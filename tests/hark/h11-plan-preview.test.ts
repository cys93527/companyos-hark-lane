// H10b/H11 — plan-only preview + run.budget through the REAL composition (no executor wired).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ok, type DomainError, type ModelProviderPort, type Result } from '@companyos/core';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';
import { GOAL_WORK_KIND } from '../../apps/desktop/src/control-plane.js';
import { productionCompositionOptions } from '../../apps/desktop/src/production-composition.js';

const CHAINS = ['core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff'] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'audit.planner';
const openDatabases: DurableDatabase[] = [];
const createdDirs: string[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'companyos-h11-')); createdDirs.push(dir); return dir; };
let invocations = 0;

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
      invocations += 1;
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

const compose = async (planPreview: boolean) => {
  const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot: tempDir(), database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', GOAL_WORK_KIND] },
    planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    providerKinds: [GOAL_WORK_KIND],
    // The work kind routes to a provider that is NOT registered (the DSH-missing shape).
    providerRoutes: { [GOAL_WORK_KIND]: 'dsh-headless' },
    repositoryRuntime: { repositoryCapableKinds: [GOAL_WORK_KIND] },
    ...(planPreview ? { planPreviewWithoutExecutor: true } : {}),
  } as never);
  if (core === null) throw new Error('composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({ root: tempDir(), commandProfile: {} });
  if (!opened.ok) throw new Error(opened.error.message);
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(stubModelProvider(), { actorId: actor });
  await core.models.registerFromProvider({ providerId: 'prov_audit', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  const saved = await core.policies.savePolicy({ id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor } as never);
  if (!saved.ok) throw new Error(saved.error.message);
  return core;
};

const workTasks = (core: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>): number =>
  (core.database.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE kind = ?').get(GOAL_WORK_KIND) as { n: number }).n;

describe('H10b plan-only preview', () => {
  it('P1 without the opt-in, the missing executor blocks BEFORE planning (no model call)', async () => {
    invocations = 0;
    const core = await compose(false);
    const created = await core.controlPlane!.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '整理办公室物资清单。', commandId: 'h11-p1' } });
    expect(created.ok).toBe(true);
    const runId = String((created.value as { runId: string }).runId);
    const result = await core.autonomyDriver!.run({ companyId: COMPANY, runId });
    expect(result.ok && result.value.terminal).toBe('EXTERNAL_PRECONDITION_BLOCKED');
    expect(result.ok && result.value.terminalReason).toBe('EXECUTOR_PROVIDER_UNKNOWN');
    expect(invocations).toBe(0);
  });

  it('P2 with the opt-in, the plan is made, then compile/dispatch is refused (typed), replay-stable', async () => {
    invocations = 0;
    const core = await compose(true);
    const created = await core.controlPlane!.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective: '整理办公室物资清单。', commandId: 'h11-p2' } });
    const runId = String((created.value as { runId: string }).runId);
    const result = await core.autonomyDriver!.run({ companyId: COMPANY, runId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.terminal).toBe('EXTERNAL_PRECONDITION_BLOCKED');
    expect(result.value.terminalReason).toBe('EXECUTOR_PROVIDER_UNKNOWN');
    expect(result.value.doctor.find((c) => c.checkId === 'executor-provider')?.requiredForGoal).toBe(false);
    expect(invocations).toBe(1);
    expect(workTasks(core)).toBe(0);

    const again = await core.controlPlane!.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId } });
    expect(again.ok).toBe(false);
    expect((again.error?.details as { reason?: string; planReady?: boolean }).reason).toBe('EXECUTOR_PROVIDER_UNKNOWN');
    expect((again.error?.details as { planReady?: boolean }).planReady).toBe(true);
    expect(invocations).toBe(1); // the planning turn replays; no second model call
    expect(workTasks(core)).toBe(0);

    const budget = await core.controlPlane!.handle({ operation: 'run.budget', payload: { companyId: COMPANY, runId } });
    expect(budget.ok).toBe(true);
    const value = budget.value as { budget: { state: string }; plan: { items: { planItemId: string }[]; criteria: unknown[] } | null };
    expect(value.plan?.items.map((i) => i.planItemId)).toEqual(['research', 'draft']);
    expect(value.plan?.criteria).toHaveLength(2);
    expect(['NO_BUDGET', 'ZERO_COST_POLICY', 'ACTIVE']).toContain(value.budget.state);
  });

  it('P3 run.budget refuses a run of another company / unknown run', async () => {
    const core = await compose(true);
    const missing = await core.controlPlane!.handle({ operation: 'run.budget', payload: { companyId: COMPANY, runId: 'run_does_not_exist' } });
    expect(missing.ok).toBe(false);
    const foreign = await core.controlPlane!.handle({ operation: 'run.budget', payload: { companyId: 'company_other', runId: 'run_x' } });
    expect(foreign.ok).toBe(false);
  });

  it('P4 production composition: preview is an explicit operator opt-in, off by default', () => {
    expect(productionCompositionOptions({}).planPreviewWithoutExecutor).toBeUndefined();
    expect(productionCompositionOptions({ COS_PLAN_PREVIEW_WITHOUT_EXECUTOR: 'true' }).planPreviewWithoutExecutor).toBeUndefined();
    expect(productionCompositionOptions({ COS_PLAN_PREVIEW_WITHOUT_EXECUTOR: '1' }).planPreviewWithoutExecutor).toBe(true);
  });
});
