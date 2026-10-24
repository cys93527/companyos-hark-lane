/**
 * STAGE 4 — the embedded-kernel E2E fixture (research-lab posture: every real
 * agent run happens inside an ISOLATED, DISPOSABLE, NON-PRODUCTION workspace).
 *
 * Provides:
 *  - the scenario model server (deterministic loopback OpenAI-compatible seam);
 *  - the disposable git fixture repo (path WITH SPACES + UNICODE — the Windows
 *    proof runs on the real filesystem, not a Linux CI claim);
 *  - the full production composition wired to the CompanyOS-MANAGED EMBEDDED dsh
 *    runtime (managed-root manifest + explicit model route; no external DSH).
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok, type DomainError, type ModelProviderPort, type Result } from '@companyos/core';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../../apps/desktop/src/artifact-stack.js';
import { GOAL_WORK_KIND } from '../../../apps/desktop/src/control-plane.js';
import { DSH_PROVIDER_KEY } from '../../../apps/desktop/src/executor/dsh-executor-provider.js';
import { NATIVE_PROCESS_PROVIDER_KEY } from '../../../apps/desktop/src/executor/native-process-provider.js';

export const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;
export const COMPANY = 'company_default';
export const MODEL_KEY = 'kernel-e2e.planner';
export const VERIFY_KIND = 'companyos:verify';
export const EMBEDDED_ROOT = join(process.cwd(), '.companyos-embedded', 'dsh-runtime');

/** The disposable fixture repo: a small calculator with a REAL test the agent must satisfy. */
export interface FixtureRepo {
  readonly root: string;
  readonly testPath: string;
  readonly srcPath: string;
}

export const buildFixtureRepo = (prefix: string): FixtureRepo => {
  // Spaces + unicode on purpose (Windows §26): the real path shapes users have.
  const root = mkdtempSync(join(tmpdir(), `companyos kernel ${prefix} 実験-`));
  mkdirSync(join(root, 'src'), { recursive: true });
  const srcPath = join(root, 'src', 'calc.js');
  const testPath = join(root, 'test.js');
  writeFileSync(srcPath, 'export const double = (n) => n + 1;\n', 'utf8');
  writeFileSync(
    testPath,
    [
      "import assert from 'node:assert/strict';",
      "import { double } from './src/calc.js';",
      'assert.equal(double(2), 4);',
      "console.log(JSON.stringify({ result: 'TESTS PASSED' }));",
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-repo', type: 'module', private: true }, null, 2), 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=fixture@companyos.local', '-c', 'user.name=fixture', 'commit', '-qm', 'initial'], { cwd: root });
  return { root, srcPath, testPath };
};

/** The broken implementation the FAIL scenario writes (agent claims success anyway). */
export const BROKEN_IMPL = 'export const double = (n) => n + 1;\n';
/** The correct implementation the PASS scenario writes. */
export const FIXED_IMPL = 'export const double = (n) => n * 2;\n';

export interface ScenarioServer {
  readonly port: number;
  readonly stop: () => void;
}

/** Start the deterministic scenario model server (loopback; zero credentials). */
export const startScenarioServer = (scenario: readonly unknown[]): ScenarioServer => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-kernel-model-'));
  const scenarioFile = join(dir, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8');
  const port = 8700 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [join(process.cwd(), 'tests', 'kernel', 'support', 'scenario-model-server.mjs')], {
    env: { ...process.env, PORT: String(port), SCENARIO_FILE: scenarioFile },
    stdio: 'ignore',
    shell: false,
  });
  return {
    port,
    stop: () => {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const CANNED_PLAN = (objectiveImplement: string): unknown => ({
  schema: 'companyos/plan-proposal/1',
  planItems: [
    {
      planItemId: 'implement',
      objective: objectiveImplement,
      dependencyPlanItemIds: [],
      acceptanceCriterionRefs: ['impl'],
    },
    {
      planItemId: 'verify',
      objective: 'Run the repository test suite and report the real exit result.',
      dependencyPlanItemIds: ['implement'],
      acceptanceCriterionRefs: ['verified'],
      taskKind: VERIFY_KIND,
    },
  ],
  acceptanceCriteria: [
    { criterionId: 'impl', requirement: 'src/calc.js doubles its input.' },
    { criterionId: 'verified', requirement: 'The repository test suite exits zero.' },
  ],
});

export interface KernelFixture {
  readonly core: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;
  readonly repo: FixtureRepo;
  readonly model: ScenarioServer;
  readonly dispose: () => void;
}

/**
 * Compose the FULL production chain against the embedded kernel: canonical Goal →
 * Plan (deterministic legal planning input) → pinned Run → Tasks → the dsh-headless
 * provider (EMBEDDED managed runtime) + native verify operation → settlement.
 */
export const composeKernelFixture = async (input: {
  readonly prefix: string;
  readonly scenario: readonly unknown[];
  readonly apiKeyValue: string;
  readonly scenarioObjective?: string;
  readonly extraComposition?: Readonly<Record<string, unknown>>;
}): Promise<KernelFixture> => {
  const repo = buildFixtureRepo(input.prefix);
  const model = startScenarioServer(input.scenario);
  const dbs: DurableDatabase[] = [];
  const dirs: string[] = [repo.root];
  const db = openDurableDatabase({ dataDir: mkdtempSync(join(tmpdir(), 'companyos-kernel-db-')), appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  dbs.push(db);
  const foundation = await openArtifactFoundation({ casRoot: mkdtempSync(join(tmpdir(), 'companyos-kernel-cas-')), database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning', GOAL_WORK_KIND] },
    planExecutionBindings: { planner: MODEL_KEY, supervisor: MODEL_KEY },
    providerKinds: [GOAL_WORK_KIND, VERIFY_KIND],
    providerRoutes: { [GOAL_WORK_KIND]: DSH_PROVIDER_KEY, [VERIFY_KIND]: NATIVE_PROCESS_PROVIDER_KEY },
    repositoryRuntime: { repositoryCapableKinds: [GOAL_WORK_KIND, VERIFY_KIND] },
    nativeOperations: {
      [VERIFY_KIND]: { operationId: 'verify-tests', executable: process.execPath, args: [repo.testPath] },
    },
    embeddedDshRuntimeRoot: EMBEDDED_ROOT,
    embeddedDshModelRoute: {
      providerId: 'companyos-explicit',
      modelId: 'scenario-model',
      baseURL: `http://127.0.0.1:${model.port}/v1`,
      apiKeyEnv: 'COMPANYOS_KERNEL_MODEL_KEY',
      apiKeyValue: input.apiKeyValue,
    },
    goalWorkProfile: { stageKind: 'work', taskKind: GOAL_WORK_KIND, maxAttempts: 3, operationKinds: [VERIFY_KIND] },
    ...(input.extraComposition ?? {}),
  } as never);
  if (core === null) throw new Error('composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({ root: repo.root, commandProfile: {} });
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  await core.providers.register(
    stubPlannerProvider(CANNED_PLAN(input.scenarioObjective ?? 'Fix src/calc.js so that the repository test suite passes, then verify by running the tests.')),
    { actorId: actor },
  );
  await core.models.registerFromProvider({ providerId: 'prov_kernel_e2e', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  await core.policies.savePolicy({
    id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor,
  } as never);
  return {
    core,
    repo,
    model,
    dispose: () => {
      model.stop();
      while (dbs.length > 0) dbs.pop()?.close();
      while (dirs.length > 0) {
        // Best-effort cleanup: a locked temp dir (AV scan) must never fail the run.
        try { rmSync(dirs.pop() as string, { recursive: true, force: true }); } catch { /* disposable */ }
      }
    },
  };
};

/** CONTROLLED FIXTURE at the MODEL seam (planner/supervisor answers, schema-routed). */
const stubPlannerProvider = (cannedPlan: unknown): ModelProviderPort => ({
  describe: () => ({ providerId: 'prov_kernel_e2e', kind: 'fake', displayName: 'kernel-e2e', version: '1' }),
  listModels: () =>
    Promise.resolve(ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: { streaming: false, structuredOutput: true } }])),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    const properties =
      (request.responseFormat?.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    let structured: unknown;
    if (!('action' in properties) && !('verdict' in properties)) {
      structured = cannedPlan;
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
        providerId: 'prov_kernel_e2e',
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

/** Drive one goal to terminal through the typed surface; returns the execution run id. */
export const driveKernelGoal = async (
  core: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>,
  objective: string,
  commandId: string,
  maxTurns = 8,
): Promise<string> => {
  const cp = core.controlPlane!;
  const created = await cp.handle({ operation: 'goal.create', payload: { companyId: COMPANY, objective, commandId } });
  if (!created.ok) throw new Error(`goal.create failed: ${String(created.error?.message ?? 'unknown')}`);
  const goalRunId = String((created.value as { readonly runId: string }).runId);
  let executionRunId = '';
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    if (!advanced.ok) throw new Error(`goal.advance failed: ${String(advanced.error?.message ?? 'unknown')}`);
    executionRunId = String((advanced.value as { readonly executionRunId: string }).executionRunId);
    const states = core.database.db
      .prepare('SELECT state FROM tasks WHERE kind IN (?, ?) AND run_id = ?')
      .all(GOAL_WORK_KIND, VERIFY_KIND, executionRunId) as { state: string }[];
    if (states.length >= 2 && states.every((row) => row.state === 'DONE' || row.state === 'FAILED')) break;
  }
  return executionRunId;
};
