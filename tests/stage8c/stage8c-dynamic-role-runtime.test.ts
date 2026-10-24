/**
 * STAGE 8C — DYNAMIC ROLE RUNTIME + SECURITY BASELINE RECONCILIATION (Boss §1-§29).
 *
 * BLOCKER A: the normal Goal pipeline resolves EVERY plan item through the
 * deterministic Stage 7 RoleResolver (declared professional responsibility →
 * catalog match or DETERMINISTIC_DYNAMIC_ROLE_SPEC → the seat pinned into the
 * task profile). Proofs here run the REAL application path (goal.create →
 * goal.advance → plan → compile → materialize → dispatch → settle); the only
 * CONTROLLED FIXTURES are the deterministic model answers and the deterministic
 * ExecutorProvider (the frozen harness policy).
 *
 * BLOCKER B: the security 31→24 question is settled with git-backed evidence —
 * the three Standard V1 suites (claims 7 + broker 7 + attack 17) ALL still run
 * in the main gate; the earlier "24" was an undercount.
 *
 * HANDOFF: READY suffices for internal consumer progress (no human acceptance).
 */
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';

import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {AUTHORITIES, SystemClock, UlidFactory, ok, type DomainError, type ModelProviderPort, type Result} from '@companyos/core';
import {
  type ExecutorExecutionRequest,
  type ExecutorProvider,
  type ExecutorProviderOutcome,
  type TypedExecutorConfig,
  createAuthorizationService,
  executorConfigFingerprint,
} from '@companyos/engine';
import {openDurableDatabase, type DurableDatabase} from '@companyos/persistence';
import {nullLogger} from '@companyos/observability';

import {composeCoreServices} from '../../apps/desktop/src/core-services.js';
import {openArtifactFoundation} from '../../apps/desktop/src/artifact-stack.js';
import {GOAL_WORK_KIND} from '../../apps/desktop/src/control-plane.js';
import {ModelPool, type ModelProfile} from '../../apps/desktop/src/executor/model-pool.js';
import {
  dynamicProfessionalSeatIdOf,
  professionalResponsibilityOfPlanItem,
  resolveProfessionalSeat,
} from '../../apps/desktop/src/executor/runtime-routing.js';
import {RoleCatalog} from '../../apps/desktop/src/executor/role-orchestration.js';


/** The deterministic test credential the fixture vault namespace resolves (test-only sentinel). */
const S8C_TEST_CREDENTIAL = 's8c-test-credential-sentinel';
const hadS8cCredential = process.env['COMPANYOS_S8C_CREDENTIAL'];
beforeAll(() => { process.env['COMPANYOS_S8C_CREDENTIAL'] = S8C_TEST_CREDENTIAL; });
afterAll(() => {
  if (hadS8cCredential === undefined) delete process.env['COMPANYOS_S8C_CREDENTIAL'];
  else process.env['COMPANYOS_S8C_CREDENTIAL'] = hadS8cCredential;
});

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 's8c.planner';

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, {recursive: true, force: true});
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s8c-'));
  createdDirs.push(dir);
  return dir;
};

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

const routableProfile = (id: string, qualityTier: 'ECONOMY' | 'BALANCED' | 'STRONG'): Omit<ModelProfile, 'configurationVersion'> => ({
  modelProfileId: id,
  providerId: `prov-${id}`,
  modelId: `model-${id}`,
  displayName: id,
  endpointURL: 'http://127.0.0.1:9/v1',
  /*
   * CREDENTIAL RESOLUTION CLOSURE (PROD-01B): the fixture declares a real test-vault
   * entry (COMPANYOS_S8C_CREDENTIAL, test-only sentinel set in beforeAll) —
   * production semantics are NOT relaxed for the fixture.
   */
  credentialRef: 'vault://COMPANYOS_S8C_CREDENTIAL/key',
  enabled: true,
  capabilities: new Set(['tool-calling', 'structured-output', 'streaming'] as const),
  contextWindowTokens: 8192,
  maxOutputTokens: 4096,
  supportsTools: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  routingTraits: {qualityTier, costTier: qualityTier === 'ECONOMY' ? 'LOW' : 'HIGH', latencyTier: 'BALANCED', reliabilityClass: qualityTier === 'STRONG' ? 'HIGH' : 'STANDARD'},
});

const buildPool = (): ModelPool => {
  const pool = new ModelPool();
  pool.register(routableProfile('cheap-model', 'ECONOMY'));
  pool.register(routableProfile('strong-model', 'STRONG'));
  return pool;
};

interface DeclaredPlanItem {
  readonly planItemId: string;
  readonly objective: string;
  readonly dependsOn?: readonly string[];
  readonly taskKind?: string;
  readonly responsibility?: {
    readonly responsibilityIntent: string;
    readonly requiredCapabilities?: readonly string[];
    readonly independenceRequired?: boolean;
    readonly riskLevel?: 'low' | 'medium' | 'high';
  };
}

const CANNED_PLAN = (items: readonly DeclaredPlanItem[]): unknown => ({
  schema: 'companyos/plan-proposal/1',
  planItems: items.map((item) => ({
    planItemId: item.planItemId,
    objective: item.objective,
    dependencyPlanItemIds: item.dependsOn ?? [],
    acceptanceCriterionRefs: [item.planItemId],
    ...(item.taskKind === undefined ? {} : {taskKind: item.taskKind}),
    ...(item.responsibility === undefined ? {} : {professionalResponsibility: item.responsibility}),
  })),
  acceptanceCriteria: items.map((item) => ({criterionId: item.planItemId, requirement: `${item.objective} — verifiable outcome.`})),
});

const stubModelProvider = (plan: unknown): ModelProviderPort => {
  let plannerAnswersLeft = 1;
  return {
    describe: () => ({providerId: 'prov_s8c', kind: 'fake', displayName: 's8c', version: '1'}),
    listModels: () => Promise.resolve(ok([{modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: {streaming: false, structuredOutput: true}}])),
    health: () => Promise.resolve(ok(undefined as never)),
    invoke(request) {
      const properties = (request.responseFormat?.schema as {properties?: Record<string, unknown>} | undefined)?.properties ?? {};
      let structured: unknown;
      if (plannerAnswersLeft > 0 && !('action' in properties) && !('verdict' in properties)) {
        plannerAnswersLeft -= 1;
        structured = plan;
      } else if ('verdict' in properties) {
        structured =
          'targetRef' in properties
            ? {schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', missingRequirements: [], summary: 'ok', targetRef: 'goal'}
            : {schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', findings: [], summary: 'ok'};
      } else {
        let subject: {taskId: string} | undefined;
        for (const message of request.messages) {
          if (message.role !== 'user') continue;
          const seat = message.content.indexOf('# Memory view');
          if (seat < 0) continue;
          const match = /"taskId"\s*:\s*"(tsk_[a-z0-9]+)"/.exec(message.content.slice(seat));
          const captured = match === null ? undefined : match[1];
          if (typeof captured === 'string' && captured !== '') subject = {taskId: captured};
          break;
        }
        structured = {schema: 'companyos/supervisor-proposal/1', action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the next work unit.', evidenceRefs: [], ...(subject === undefined ? {} : {subject})};
      }
      return Promise.resolve(ok({
        modelId: request.modelId,
        providerId: 'prov_s8c',
        outputText: 'x',
        structured: structured as never,
        toolCalls: [],
        usage: {inputTokens: 1, outputTokens: 1, totalCost: null},
        finishReason: 'stop' as const,
      }));
    },
    stream(): AsyncIterable<Result<never, DomainError>> {
      return {[Symbol.asyncIterator]: () => ({next: () => Promise.resolve({done: true, value: undefined})})};
    },
  };
};

interface ProviderCapture {
  readonly attemptId: string;
  readonly taskId: string;
  readonly roleId: string;
  readonly selectedModelProfileId: string | null;
  readonly roleContext: Record<string, unknown> | null;
}

const deterministicExecutorProvider = (captures: ProviderCapture[]): {readonly provider: ExecutorProvider; readonly config: TypedExecutorConfig} => ({
  config: {
    providerKey: 's8c-deterministic',
    fields: [{name: 'profile', value: 'deterministic-s8c', source: 'composition'}],
    fingerprint: executorConfigFingerprint([{name: 'profile', value: 'deterministic-s8c', source: 'composition'}]),
  },
  provider: {
    descriptor: {providerKey: 's8c-deterministic', capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
    async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
      captures.push({
        attemptId: request.attemptId,
        taskId: request.taskId,
        roleId: request.roleId,
        selectedModelProfileId: request.selectedModelRoute?.modelProfileId ?? null,
        roleContext: (request.work.roleContext as Record<string, unknown> | undefined) ?? null,
      });
      return {
        kind: 'succeeded',
        exitCode: 0,
        stdoutText: 'delivered',
        providerSessionId: `session-s8c-${String(captures.length)}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        structured: {artifactContent: `outcome-${String(captures.length)}`},
      };
    },
  } as ExecutorProvider,
});

/** The canonical professional seats the deployment registers (real authorization path). */
const CANONICAL_SEATS: readonly {key: string; name: string; description: string; capabilities: readonly string[]}[] = [
  {key: 'researcher', name: 'Researcher', description: 'Collect and verify domain evidence.', capabilities: ['read', 'research']},
  {key: 'analyst', name: 'Analyst', description: 'Analyze evidence into structured findings.', capabilities: ['read', 'structured-output']},
  {key: 'reviewer', name: 'Reviewer', description: 'Independently review deliverables.', capabilities: ['read', 'review']},
];

interface FlowOptions {
  readonly objective: string;
  readonly commandId: string;
  readonly plan: readonly DeclaredPlanItem[];
  readonly registerCanonicalSeats?: boolean;
  readonly stopMidFlight?: boolean;
}

interface FlowResult {
  readonly goalRunId: string;
  readonly executionRunId: string;
  readonly captures: readonly ProviderCapture[];
  readonly taskRows: readonly {readonly id: string; readonly state: string; readonly role_id: string}[];
  readonly seatByTask: ReadonlyMap<string, string>;
  readonly handoffRows: readonly {readonly handoff_id: string; readonly status: string; readonly from_role_id: string; readonly to_role_id: string}[];
  readonly eventTypes: readonly string[];
  readonly core: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;
  readonly reopen?: () => Promise<FlowResult>;
}

const runStage8CFlow = async (options: FlowOptions): Promise<FlowResult> => {
  const captures: ProviderCapture[] = [];
  const workspaceRoot = tempDir();
  const dataDir = tempDir();
  const casRoot = tempDir();

  const openComposition = async (): Promise<NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>> => {
    const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
    openDatabases.push(db);
    const seatAuthz = createAuthorizationService({
      ids: new UlidFactory(new SystemClock()),
      clock: new SystemClock(),
      roles: db.roles,
      assignments: db.roleAssignments,
    });
    const ownerRole = await seatAuthz.defineRole({
      companyId: COMPANY,
      key: 'owner',
      name: 'Owner (fixture)',
      description: 'Fixture session actor; carries every authority.',
      authorities: [...AUTHORITIES],
    });
    if (!ownerRole.ok && String(ownerRole.error.code) !== 'CONFLICT') throw new Error(ownerRole.error.message);
    const ownerAssigned = ownerRole.ok
      ? await seatAuthz.assign({actorId: 'user_owner', roleId: ownerRole.value.id, assignedBy: 'system:fixture'})
      : ok(true as const);
    if (!ownerAssigned.ok && String(ownerAssigned.error.code) !== 'CONFLICT') throw new Error(ownerAssigned.error.message);
    if (options.registerCanonicalSeats === true) {
      for (const seat of CANONICAL_SEATS) {
        const defined = await seatAuthz.defineRole({
          companyId: COMPANY,
          key: seat.key,
          name: seat.name,
          description: seat.description,
          requiredCapabilities: [...seat.capabilities],
          authorities: ['provider.invoke'],
        });
        if (!defined.ok && String(defined.error.code) !== 'CONFLICT') throw new Error(defined.error.message);
      }
    }
    const foundation = await openArtifactFoundation({casRoot, database: db, logger: nullLogger as never});
    if (!foundation.ok) throw new Error('foundation failed');
    const core = await composeCoreServices(db, nullLogger as never, {
      artifactFoundation: foundation as never,
      stageHandlers: {developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', GOAL_WORK_KIND]},
      planExecutionBindings: {planner: MODEL_KEY, supervisor: MODEL_KEY},
      providerKinds: [GOAL_WORK_KIND],
      providerRoutes: {[GOAL_WORK_KIND]: 's8c-deterministic'},
      repositoryRuntime: {repositoryCapableKinds: [GOAL_WORK_KIND]},
      executorProviderImplementations: [deterministicExecutorProvider(captures)] as never,
      goalWorkProfile: {stageKind: 'work', taskKind: GOAL_WORK_KIND, maxAttempts: 3, operationKinds: []},
      modelRouting: {mode: 'SMART_ROUTER_V1', pool: buildPool()},
    } as never);
    if (core === null) throw new Error('composition failed');
    await core.repositoryRuntime.openWorkspace({root: workspaceRoot, commandProfile: {}});
    const actor = (await core.database.roleAssignments.list({limit: 1})).items[0]!.actorId;
    await core.providers.register(stubModelProvider(CANNED_PLAN(options.plan)), {actorId: actor});
    await core.models.registerFromProvider({providerId: 'prov_s8c', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor});
    await core.policies.savePolicy({
      id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor,
    } as never);
    return core;
  }

  const core = await openComposition();
  const cp = core.controlPlane!;
  const created = await cp.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: options.objective, commandId: options.commandId}});
  if (!created.ok) throw new Error(`goal.create failed: ${JSON.stringify(created.error)}`);
  const goalRunId = String((created.value as {readonly runId: string}).runId);

  let executionRunId = '';
  const drive = async (services: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>): Promise<void> => {
    for (let turn = 0; turn < 12; turn += 1) {
      const work = services.database.db
        .prepare('SELECT state FROM tasks WHERE run_id = ? AND kind = ?')
        .all(executionRunId, GOAL_WORK_KIND) as {state: string}[];
      const settled = work.filter((task) => task.state === 'DONE' || task.state === 'FAILED').length;
      const open = work.length - settled;
      if (options.stopMidFlight === true && settled >= 1 && open >= 1) return;
      if (work.length > 0 && open === 0) return;
      const advanced = await services.controlPlane!.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: goalRunId}});
      if (!advanced.ok) return;
    }
  };
  {
    const advanced = await cp.handle({operation: 'goal.advance', payload: {companyId: COMPANY, runId: goalRunId}});
    if (!advanced.ok) throw new Error(`goal.advance failed: ${JSON.stringify(advanced.error)}`);
    executionRunId = String((advanced.value as {readonly executionRunId: string}).executionRunId);
    await drive(core);
  }

  const readState = (services: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>): FlowResult => {
    const taskRows = services.database.db
      .prepare('SELECT id, state, role_id FROM tasks WHERE run_id = ? AND kind = ? ORDER BY created_at')
      .all(executionRunId, GOAL_WORK_KIND) as FlowResult['taskRows'];
    const handoffRows = services.database.db
      .prepare('SELECT handoff_id, status, from_role_id, to_role_id FROM handoffs ORDER BY created_at')
      .all() as FlowResult['handoffRows'];
    const eventTypes = (services.database.db.prepare('SELECT DISTINCT type FROM events').all() as {type: string}[]).map((row) => row.type);
    return {
      core: services,
      goalRunId,
      executionRunId,
      captures: [...captures],
      taskRows,
      seatByTask: new Map(taskRows.map((row) => [row.id, row.role_id])),
      handoffRows,
      eventTypes,
    };
  };

  if (options.stopMidFlight === true) {
    return {
      ...readState(core),
      reopen: async (): Promise<FlowResult> => {
        core.database.close();
        while (openDatabases.length > 0) openDatabases.pop();
        const reopened = await openComposition();
        await drive(reopened);
        return readState(reopened);
      },
    };
  }
  return readState(core);
};

// ---------------------------------------------------------------------------
// §3 Goal PlanItem → Professional Responsibility (deterministic derivation)
// ---------------------------------------------------------------------------

describe('STAGE 8C §3 — plan item → professional responsibility', () => {
  it('a declared responsibility is used verbatim; the fallback derives from the item semantics', () => {
    const declared = professionalResponsibilityOfPlanItem({
      objective: 'Implement the module.',
      taskKind: GOAL_WORK_KIND,
      workKind: GOAL_WORK_KIND,
      declared: {responsibilityIntent: 'Independently verify the deliverable.', requiredCapabilities: ['read', 'review'], independenceRequired: true, riskLevel: 'high'},
    });
    expect(declared.responsibilityIntent).toBe('Independently verify the deliverable.');
    expect(declared.requiredCapabilities).toEqual(['read', 'review']);
    expect(declared.independenceRequired).toBe(true);
    expect(declared.riskLevel).toBe('high');

    const fallbackWork = professionalResponsibilityOfPlanItem({objective: 'Produce the report.', taskKind: GOAL_WORK_KIND, workKind: GOAL_WORK_KIND});
    expect(fallbackWork.responsibilityIntent).toBe('Produce the report.');
    expect(fallbackWork.independenceRequired).toBe(false);
    expect(fallbackWork.expectedOutputKind).toBe('artifact');

    // An operation/verify kind item (taskKind ≠ the deployment's work kind) is
    // independent evaluator work — deterministic, no keyword matching.
    const fallbackGate = professionalResponsibilityOfPlanItem({objective: 'Run the tests.', taskKind: 'companyos:verify', workKind: GOAL_WORK_KIND});
    expect(fallbackGate.independenceRequired).toBe(true);
    expect(fallbackGate.expectedOutputKind).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// §4 Responsibility → RoleResolver (catalog match / dynamic spec)
// ---------------------------------------------------------------------------

describe('STAGE 8C §4 — responsibility → resolved professional seat', () => {
  it('catalog match: declared capabilities select the canonical seat; the dynamic seat id is deterministic', () => {
    const catalog = new RoleCatalog();
    for (const seat of CANONICAL_SEATS) {
      catalog.register({
        roleDefinitionId: seat.key,
        displayName: seat.name,
        professionalResponsibility: seat.description,
        responsibilityDescription: seat.description,
        requiredCapabilities: [...seat.capabilities],
        preferredCapabilities: [],
        toolNeeds: [],
        contextNeeds: [],
        validationResponsibilities: [],
        independenceClass: seat.key === 'reviewer' ? 'independent-reviewer' : 'implementer',
        defaultExecutionBudget: {maxTurns: 20, maxToolCalls: 50},
        packOwner: 'canonical-roles',
        domain: 'canonical',
      });
    }
    const matched = resolveProfessionalSeat(catalog, professionalResponsibilityOfPlanItem({
      objective: 'Collect evidence.',
      taskKind: GOAL_WORK_KIND,
      workKind: GOAL_WORK_KIND,
      declared: {responsibilityIntent: 'Collect competitor pricing evidence.', requiredCapabilities: ['read', 'research']},
    }));
    expect(matched.seatId).toBe('researcher');
    expect(matched.specification.origin).toBe('catalog-match');

    const unmatched = resolveProfessionalSeat(catalog, professionalResponsibilityOfPlanItem({
      objective: 'Design the schema.',
      taskKind: GOAL_WORK_KIND,
      workKind: GOAL_WORK_KIND,
      declared: {responsibilityIntent: 'Design the storage schema.', requiredCapabilities: ['design', 'structured-output']},
    }));
    expect(unmatched.seatId).toMatch(/^drole_[0-9a-f]{16}$/);
    expect(unmatched.specification.origin).toBe('dynamic-synthesis');
    expect(unmatched.specification.professionalResponsibility).toBe('Design the storage schema.');

    // Deterministic: the SAME responsibility yields the SAME dynamic seat.
    const again = resolveProfessionalSeat(catalog, professionalResponsibilityOfPlanItem({
      objective: 'Design the schema.',
      taskKind: GOAL_WORK_KIND,
      workKind: GOAL_WORK_KIND,
      declared: {responsibilityIntent: 'Design the storage schema.', requiredCapabilities: ['design', 'structured-output']},
    }));
    expect(again.seatId).toBe(unmatched.seatId);
    expect(dynamicProfessionalSeatIdOf(professionalResponsibilityOfPlanItem({
      objective: 'x', taskKind: GOAL_WORK_KIND, workKind: GOAL_WORK_KIND,
      declared: {responsibilityIntent: 'Design the storage schema.', requiredCapabilities: ['design', 'structured-output']},
    }))).toBe(unmatched.seatId);
  });
});

// ---------------------------------------------------------------------------
// §7-§9 runtime: software / non-software / minimal team through the REAL pipeline
// ---------------------------------------------------------------------------

describe('STAGE 8C §7 — software goal forms professional seats from the plan', () => {
  it('distinct responsibilities → distinct resolver-derived seats; never rol.worker', async () => {
    const run = await runStage8CFlow({
      objective: '实现并验证一个小工具函数。',
      commandId: 's8c-sw-1',
      plan: [
        {planItemId: 'design', objective: '设计工具函数契约。', responsibility: {responsibilityIntent: 'Design the function contract.', requiredCapabilities: ['design', 'structured-output']}},
        {planItemId: 'implement', objective: '实现工具函数。', dependsOn: ['design'], responsibility: {responsibilityIntent: 'Implement the function to the contract.', requiredCapabilities: ['tool-calling']}},
        {planItemId: 'verify', objective: '运行测试验证实现。', dependsOn: ['implement'], responsibility: {responsibilityIntent: 'Independently verify the implementation.', requiredCapabilities: ['test', 'review'], independenceRequired: true}},
      ],
    });
    expect(run.taskRows.map((row) => row.state)).toEqual(['DONE', 'DONE', 'DONE']);
    const seats = run.taskRows.map((row) => row.role_id);
    // Three responsibilities → three DISTINCT seats, all resolver-derived.
    expect(new Set(seats).size).toBe(3);
    for (const seat of seats) {
      expect(seat).not.toBe('rol.worker');
      expect(seat).toMatch(/^(drole_[0-9a-f]{16}|[a-z][a-z0-9-]+)$/);
    }
    // The role context the kernel received carries the DECLARED responsibility.
    for (const capture of run.captures) {
      expect(String(capture.roleContext?.['professionalResponsibility'])).toContain('.');
    }
    const verifyCapture = run.captures[2];
    expect(String(verifyCapture?.roleContext?.['professionalResponsibility'])).toBe('Independently verify the implementation.');
  });
});

describe('STAGE 8C §8 — non-software goal forms researcher/analyst/reviewer from canonical seats', () => {
  it('declared capabilities match the deployment-registered canonical seats', async () => {
    const run = await runStage8CFlow({
      objective: '完成一份竞品定价调研简报。',
      commandId: 's8c-nonsw-1',
      registerCanonicalSeats: true,
      plan: [
        {planItemId: 'collect', objective: '收集竞品定价证据。', responsibility: {responsibilityIntent: 'Collect competitor pricing evidence.', requiredCapabilities: ['read', 'research']}},
        {planItemId: 'analyze', objective: '分析证据并产出对比简报。', dependsOn: ['collect'], responsibility: {responsibilityIntent: 'Analyze evidence into the comparison brief.', requiredCapabilities: ['read', 'structured-output']}},
        {planItemId: 'review', objective: '复核简报的准确性与完整性。', dependsOn: ['analyze'], responsibility: {responsibilityIntent: 'Independently review the brief.', requiredCapabilities: ['read', 'review'], independenceRequired: true}},
      ],
    });
    expect(run.taskRows.map((row) => row.state)).toEqual(['DONE', 'DONE', 'DONE']);
    // CATALOG MATCH: the seats are the deployment-registered canonical seats —
    // resolved from the plan's declared capabilities, never hand-pinned.
    expect(run.taskRows[0]!.role_id).toBe('researcher');
    expect(run.taskRows[1]!.role_id).toBe('analyst');
    expect(run.taskRows[2]!.role_id).toBe('reviewer');
    expect(run.captures.every((capture) => capture.roleId !== 'rol.worker')).toBe(true);
    // No software vocabulary leaks into the routed contexts.
    const allText = run.captures.map((capture) => JSON.stringify(capture.roleContext)).join(' ');
    for (const forbidden of ['git', 'build', 'engineer', 'repository']) {
      expect(allText).not.toContain(forbidden);
    }
  });
});

describe('STAGE 8C §9 — minimal sufficient team', () => {
  it('a simple goal resolves exactly ONE professional seat', async () => {
    const run = await runStage8CFlow({
      objective: '整理一份行程清单。',
      commandId: 's8c-min-1',
      plan: [{planItemId: 'list', objective: '产出行程清单。', responsibility: {responsibilityIntent: 'Produce the itinerary list.'}}],
    });
    expect(run.taskRows.length).toBe(1);
    expect(run.captures.length).toBe(1);
    expect(run.taskRows[0]!.role_id).toMatch(/^drole_[0-9a-f]{16}$/);
    expect(run.taskRows[0]!.role_id).not.toBe('rol.worker');
  });

  it('two items with the SAME responsibility share ONE seat (no team inflation)', async () => {
    const run = await runStage8CFlow({
      objective: '分两步整理数据。',
      commandId: 's8c-min-2',
      plan: [
        {planItemId: 'part1', objective: '整理第一批数据。', responsibility: {responsibilityIntent: 'Curate the dataset entries.', requiredCapabilities: ['read', 'write']}},
        {planItemId: 'part2', objective: '整理第二批数据。', dependsOn: ['part1'], responsibility: {responsibilityIntent: 'Curate the dataset entries.', requiredCapabilities: ['read', 'write']}},
      ],
    });
    const seats = new Set(run.taskRows.map((row) => row.role_id));
    expect(seats.size).toBe(1);
    // Same seat, DIFFERENT canonical attempts (Role ≠ Attempt).
    expect(new Set(run.captures.map((capture) => capture.attemptId)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §10-§11 late specialist + role → router
// ---------------------------------------------------------------------------

describe('STAGE 8C §10/§11 — late specialist and role → smart router', () => {
  it('a NEW professional responsibility resolves to a NEW specialist seat, never a fallback seat', async () => {
    const first = await runStage8CFlow({
      objective: '整理数据。',
      commandId: 's8c-late-1',
      plan: [{planItemId: 'curate', objective: '整理数据。', responsibility: {responsibilityIntent: 'Curate the dataset entries.', requiredCapabilities: ['read', 'write']}}],
    });
    const second = await runStage8CFlow({
      objective: '核查安全边界。',
      commandId: 's8c-late-2',
      plan: [{planItemId: 'audit', objective: '核查安全边界。', responsibility: {responsibilityIntent: 'Independently audit the security boundary.', requiredCapabilities: ['security', 'review'], independenceRequired: true, riskLevel: 'high'}}],
    });
    const specialist = second.taskRows[0]!.role_id;
    expect(specialist).not.toBe(first.taskRows[0]!.role_id);
    expect(specialist).not.toBe('rol.worker');
  });

  it('the router consumes the resolved role per attempt (Role ≠ Model; per-attempt decisions)', async () => {
    const run = await runStage8CFlow({
      objective: '实现并验证工具。',
      commandId: 's8c-router-1',
      plan: [
        {planItemId: 'implement', objective: '实现工具。', responsibility: {responsibilityIntent: 'Implement the tool.'}},
        {planItemId: 'verify', objective: '验证工具。', dependsOn: ['implement'], responsibility: {responsibilityIntent: 'Independently verify the tool.', independenceRequired: true, riskLevel: 'high'}},
      ],
    });
    for (const capture of run.captures) {
      // Every attempt received a CompanyOS-selected route (the router ran).
      expect(capture.selectedModelProfileId).not.toBeNull();
      // The envelope carries the selected model as evidence only.
      expect(String(capture.roleContext?.['attemptModelLabel'])).toMatch(/^(cheap|strong)-model@\d+$/);
    }
    // The role context's responsibility matches the DECLARED intent per seat.
    expect(String(run.captures[0]!.roleContext?.['professionalResponsibility'])).toBe('Implement the tool.');
    expect(String(run.captures[1]!.roleContext?.['professionalResponsibility'])).toBe('Independently verify the tool.');
  });
});

// ---------------------------------------------------------------------------
// §22-§23 restart + idempotency
// ---------------------------------------------------------------------------

describe('STAGE 8C §22/§23 — restart reconstruction and idempotency', () => {
  it('after a process boundary the seats are identical and nothing is duplicated', async () => {
    const run = await runStage8CFlow({
      objective: '两步交付。',
      commandId: 's8c-restart-1',
      stopMidFlight: true,
      plan: [
        {planItemId: 'produce', objective: '产出交付物。', responsibility: {responsibilityIntent: 'Produce the deliverable.'}},
        {planItemId: 'check', objective: '检查交付物。', dependsOn: ['produce'], responsibility: {responsibilityIntent: 'Independently check the deliverable.', independenceRequired: true}},
      ],
    });
    const before = {
      seats: run.taskRows.map((row) => `${row.id}:${row.role_id}:${row.state}`),
      handoffs: run.handoffRows.map((row) => `${row.handoff_id}:${row.status}`),
    };
    const after = await run.reopen!();
    // The pinned seats are durable: identical after restart, no duplicates, no rol.worker regression.
    expect(after.taskRows.map((row) => `${row.id}:${row.role_id}:${row.state}`)).toEqual(before.seats);
    expect(after.handoffRows.map((row) => `${row.handoff_id}:${row.status}`)).toEqual(before.handoffs);
    expect(after.taskRows.every((row) => row.role_id !== 'rol.worker')).toBe(true);
    expect(after.taskRows.every((row) => row.state === 'DONE')).toBe(true);
  });

  it('a repeated goal command replays the same run and seats', async () => {
    const run = await runStage8CFlow({
      objective: '整理清单。',
      commandId: 's8c-idem-1',
      plan: [{planItemId: 'list', objective: '产出清单。', responsibility: {responsibilityIntent: 'Produce the list.'}}],
    });
    const repeated = await run.core.controlPlane!.handle({
      operation: 'goal.create',
      payload: {companyId: COMPANY, objective: '整理清单。', commandId: 's8c-idem-1'},
    });
    expect(repeated.ok).toBe(true);
    if (repeated.ok) {
      expect(String((repeated.value as {readonly runId: string}).runId)).toBe(run.goalRunId);
    }
    const seats = run.core.database.db.prepare('SELECT role_id FROM tasks WHERE run_id = ?').all(run.executionRunId) as {role_id: string}[];
    expect(seats.length).toBe(1);
    expect(seats[0]!.role_id).toBe(run.taskRows[0]!.role_id);
  });
});

// ---------------------------------------------------------------------------
// §16-§20 handoff autonomy semantics
// ---------------------------------------------------------------------------

describe('STAGE 8C §16-§20 — ordinary internal handoff autonomy', () => {
  it('READY suffices: the consumer executes with NO human acceptance event (ORDINARY_INTERNAL_HANDOFF_REQUIRES_USER = NO)', async () => {
    const run = await runStage8CFlow({
      objective: '两步交付。',
      commandId: 's8c-handoff-1',
      plan: [
        {planItemId: 'produce', objective: '产出交付物。', responsibility: {responsibilityIntent: 'Produce the deliverable.'}},
        {planItemId: 'check', objective: '检查交付物。', dependsOn: ['produce'], responsibility: {responsibilityIntent: 'Independently check the deliverable.', independenceRequired: true}},
      ],
    });
    // The producer recorded a durable handoff; the consumer COMPLETED.
    expect(run.handoffRows.length).toBe(1);
    expect(run.handoffRows[0]!.status).toBe('READY');
    expect(run.taskRows.every((row) => row.state === 'DONE')).toBe(true);
    // The consumer seat is NOT the producer seat (professional transfer happened).
    expect(run.handoffRows[0]!.from_role_id).not.toBe(run.handoffRows[0]!.to_role_id);
    // NO human acceptance exists — internal progress never waits for one.
    expect(run.eventTypes).not.toContain('handoff.accepted');
    // No fake-human actor: the handoff events carry only the composition's
    // system session actor (audit visible), never a synthetic person.
    expect(run.eventTypes).toContain('handoff.created');
    expect(run.eventTypes).toContain('handoff.ready');
  });
});

// ---------------------------------------------------------------------------
// §12-§15 security 31 baseline reconciliation (git-backed)
// ---------------------------------------------------------------------------

describe('STAGE 8C §12-§15 — Standard V1 security 31 baseline reconciliation', () => {
  it('offline and explicit live gates together preserve claims 7 + broker 7 + attack 17 = 31', () => {
    const files = [
      'tests/security/v1-claims.test.ts',
      'tests/security-broker-security.test.ts',
      'tests/security-agent-attack.test.ts',
    ];
    let claims = 0;
    let broker = 0;
    let attackStatic = 0;
    let attackTables = 0;
    for (const file of files) {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      const staticCount = (text.match(/\bit\(/g) ?? []).length;
      const tableCount = (text.match(/\bit\.each\(/g) ?? []).length;
      if (file.includes('v1-claims')) claims = staticCount;
      else if (file.includes('broker')) broker = staticCount;
      else {
        attackStatic = staticCount;
        attackTables = tableCount;
      }
    }
    expect(claims).toBe(7);
    expect(broker).toBe(7);
    const liveAttack=readFileSync(new URL('../../tests/kernel/security-agent-attack.live.test.ts',import.meta.url),'utf8');
    const liveStatic=(liveAttack.match(/\bit\(/g)??[]).length;
    expect(attackStatic).toBe(3);
    expect(liveStatic).toBe(6);
    expect(attackStatic+liveStatic).toBe(9);
    expect(liveAttack).toContain('requireRealDshApproval()');
    expect([...liveAttack.matchAll(/\bit\('([^']+)'/g)].map(match=>match[1])).toEqual([
      'FILE-TOOL ESCAPE: ../, absolute, drive-relative and UNC-style writes outside the workspace are refused by the fs sandbox',
      'JUNCTION ESCAPE: a junction inside the workspace pointing outside cannot carry writes out (Windows reparse reality check)',
      'ENV ISOLATION: parent canary secrets never reach the kernel child (allowlist boundary)',
      'HOME ISOLATION: the kernel sees the per-attempt scratch home, NOT the real user home (git config probe)',
      'CROSS-TASK ISOLATION: per-attempt homes are disjoint; a hostile A cannot read B scratch by convention',
      'REAL RUNTIME INTEGRITY: the materialized official tree stages and verifies 100% of the execution closure (no sampling)',
    ]);
    expect(attackTables).toBe(1);
    // The one parameterized table drives 8 tamper cases (TAMPER_CASES below).
    const attackText = readFileSync(new URL('../../tests/security-agent-attack.test.ts', import.meta.url), 'utf8');
    const tableBody = attackText.slice(attackText.indexOf('TAMPER_CASES: readonly'), attackText.indexOf('];', attackText.indexOf('TAMPER_CASES: readonly')));
    const tamperCases = (tableBody.match(/\{label:/g) ?? []).length;
    expect(tamperCases).toBe(8);
    // 7 + 7 + (9 + 8) = 31 — the historical frozen baseline is INTACT.
    expect(claims + broker + attackStatic + liveStatic + tamperCases).toBe(31);

    // 25 cases are offline; the six Kernel cases remain in explicit live scope.
    // Reading their source above is coverage inventory, not a live PASS.
    const mainConfig = readFileSync(new URL('../../vitest.config.ts', import.meta.url), 'utf8');
    expect(mainConfig).toContain("'tests/**/*.test.ts'");
    expect(mainConfig).toContain("'tests/kernel/**'");
    const liveConfig=readFileSync(new URL('../../vitest.kernel.config.ts',import.meta.url),'utf8');
    expect(liveConfig).toContain("'tests/kernel/**/*.test.ts'");
    expect(liveConfig).toContain('real-dsh-test-setup.ts');
    const hardenedConfig = readFileSync(new URL('../../vitest.hardened-research.config.ts', import.meta.url), 'utf8');
    for (const file of files) {
      expect(hardenedConfig).not.toContain(file);
    }
    // The hardened gate stays separate (§15) and holds the process-boundary suite.
    expect(hardenedConfig).toContain('security-process-boundary');
  });

  it('the claims suite still enforces the Standard V1 boundary claims (docs + code scan)', () => {
    const text = readFileSync(new URL('../security/v1-claims.test.ts', import.meta.url), 'utf8');
    expect(text).toContain('NEGATIVE CLAIM TESTS');
    expect(text).toContain('docs');
    expect(text).toContain('executor');
  });
});
