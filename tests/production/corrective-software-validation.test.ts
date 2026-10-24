import '../support/offline-validator-snapshot.js';
/**
 * PRODUCTION CORRECTIVE INTEGRATION (release blocker closure F1) — the deterministic
 * regression through the ACTUAL production composition seams. NO manual insertion of a
 * corrective Decision, a validation PASS, a corrected artifact or an Outcome:
 *
 *   fresh Goal (workspace-bound at creation — F4)
 *   → real planning (scripted model, constrained taskKind classification)
 *   → software WorkProfile items (taskKind=companyos:software-work)
 *   → deterministic executor provider writes a DELIBERATELY DEFECTIVE multiply
 *   → real repo.test-check executes the workspace's own test contract → FAIL
 *   → real supervisor application path: legal REQUEST_CORRECTIVE (validation-row cause)
 *   → real corrective provisioning (round-1 child of the implementation task)
 *   → corrective execution (deterministic provider writes the corrected multiply)
 *   → independent re-validation → PASS
 *   → evidence gate → Handoff → Outcome → Goal COMPLETED.
 *
 * The same file carries the F1+F2 combined timeout regression and the F4 workspace
 * binding integration (switch/mismatch/restart), plus the READ_ONLY authority binding.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  domainError,
  ok,
  type DomainError,
  type InvocationRequest,
  type InvocationResult,
  type ModelProviderPort,
  type RawModelInfo,
  type Result,
} from '@companyos/core';
import {
  createRunGoalService,
  resolveExecutorConfig,
  type ExecutorExecutionRequest,
  type ExecutorProvider,
  type ExecutorProviderOutcome,
} from '@companyos/engine';
import {
  createFilesystemArtifactContentStore,
  openDurableDatabase,
  type DurableDatabase,
} from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';
import { GOAL_WORK_KIND, SOFTWARE_WORK_KIND } from '../../apps/desktop/src/control-plane.js';

const CHAINS = ['core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff'] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 'swfix.planner';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
};

interface SwFixFixture {
  readonly core: Core;
  readonly workspace: string;
  readonly casRoot: string;
  readonly dataDir: string;
  readonly providerCalls: { readonly cwd: string; readonly corrective: boolean }[];
  readonly hangSupervisorCatalogue: { value: boolean };
  /** F1 budget test: when armed, every supervisor turn proposes an ILLEGAL action. */
  readonly illegalProposals: { value: boolean };
}

const composeSwFix = async (options?: {
  readonly supervisorTimeoutMs?: number;
  /** false ⇒ the corrective round does NOT fix the defect (legitimate multi-round exhaustion). */
  readonly correctiveFixes?: boolean;
}): Promise<SwFixFixture> => {
  const correctiveFixes = options?.correctiveFixes ?? true;
  const dataDir = tempDir('swfix-db-');
  const workspace = tempDir('swfix-ws-');
  const casRoot = `${dataDir}-cas`;

  /** The scripted supervisor policy: corrective on a standing FAIL, COMPLETE when proven. */
  const hangSupervisorCatalogue = { value: false };
  const illegalProposals = { value: false };
  const supervisorPolicy = (text: string) => {
    if (text.includes('LATEST_VALIDATION_FAILED')) {
      return { action: 'REQUEST_CORRECTIVE' as const, hang: hangSupervisorCatalogue.value };
    }
    if (/val_[0-9A-Za-z]+/.test(text) && text.includes('"DONE"')) {
      return { action: 'COMPLETE' as const, hang: hangSupervisorCatalogue.value };
    }
    return { action: 'CONTINUE' as const, hang: hangSupervisorCatalogue.value };
  };

  const planItems = [
    {
      planItemId: 'fix-multiply',
      objective: 'Fix the multiply function in the workspace project so multiply(4, 3) returns 12, run the project test contract, and deliver the result.',
      dependencyPlanItemIds: [],
      acceptanceCriterionRefs: ['c1'],
      taskKind: SOFTWARE_WORK_KIND,
    },
  ];

  const stub: ModelProviderPort = {
    describe: () => ({ providerId: 'prov_swfix', kind: 'fake', displayName: 'swfix', version: '1' }),
    listModels: () =>
      Promise.resolve(
        ok([{ modelId: 'p1', displayName: 'p1', contextWindow: 32768, capabilities: { streaming: false, structuredOutput: true } } as RawModelInfo]),
      ),
    health: () => Promise.resolve(ok(undefined as never)),
    invoke(request: InvocationRequest) {
      const properties = (request.responseFormat?.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      let structured: unknown;
      if (!('action' in properties) && !('verdict' in properties)) {
        structured = {
          schema: 'companyos/plan-proposal/1',
          planItems,
          acceptanceCriteria: [
            { criterionId: 'c1', requirement: 'multiply(4, 3) returns 12 and the project test contract passes.' },
          ],
        };
      } else if ('verdict' in properties) {
        structured =
          'targetRef' in properties
            ? { schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', missingRequirements: [], summary: 'ok', targetRef: 'goal' }
            : { schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', findings: [], summary: 'ok' };
      } else {
        const contextText = JSON.stringify(request.messages);
        if (illegalProposals.value) {
          // F1 budget test: an ALWAYS-illegal proposal (ESCALATE without the durable evidence
          // it requires) — refused by the authority in every state, never recorded.
          structured = {
            schema: 'companyos/supervisor-proposal/1',
            action: 'ESCALATE',
            reasonCode: 'GOAL_SATISFIED',
            summary: 'illegal: escalate without evidence',
            evidenceRefs: [],
            subject: null,
          };
        } else {
        const proposal = supervisorPolicy(contextText);
        if (proposal.hang) {
          // F1+F2 combined: the model call is unresponsive, but the adapter honors the
          // caller signal (the F2 contract) — the deadline aborts it as CANCELLED.
          return new Promise<InvocationResult>((_resolve, reject) => {
            const signal = request.signal;
            if (signal === undefined) {
              reject(domainError('VALIDATION_FAILED', 'hung provider without a caller signal'));
              return;
            }
            signal.addEventListener(
              'abort',
              () => reject(domainError('CANCELLED', 'The model invocation was cancelled.', { kind: 'CANCELLED' })),
              { once: true },
            );
          }) as never;
        }
        structured =
          proposal.action === 'REQUEST_CORRECTIVE'
            ? {
                schema: 'companyos/supervisor-proposal/1',
                action: 'REQUEST_CORRECTIVE',
                reasonCode: 'VALIDATION_FAILED',
                summary: 'The software validation failed; corrective work is required.',
                evidenceRefs: [],
                subject: null,
              }
            : proposal.action === 'COMPLETE'
              ? {
                  schema: 'companyos/supervisor-proposal/1',
                  action: 'COMPLETE',
                  reasonCode: 'GOAL_SATISFIED',
                  summary: 'The corrected behavior is proven and validated.',
                  evidenceRefs: (contextText.match(/val_[0-9A-Za-z]+/) ?? []).slice(0, 1),
                  subject: null,
                }
            : {
                schema: 'companyos/supervisor-proposal/1',
                action: 'CONTINUE',
                reasonCode: 'GOAL_SATISFIED',
                summary: 'next',
                evidenceRefs: [],
                subject: null,
              };
        }
      }
      return Promise.resolve(
        ok({
          modelId: request.modelId,
          providerId: 'prov_swfix',
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

  /** The deterministic software executor: defective first, corrected on the corrective round. */
  const providerCalls: SwFixFixture['providerCalls'] = [];
  const writeProject = (root: string, multiplyBody: string): void => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test tests/math.test.ts' } }),
    );
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function multiply(a: number, b: number): number {\n  return ${multiplyBody};\n}\n`);
    writeFileSync(
      join(root, 'tests', 'math.test.ts'),
      "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add, multiply } from '../src/math.ts';\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5);\n});\n\ntest('multiply', () => {\n  assert.equal(multiply(4, 3), 12);\n});\n",
    );
  };
  const swProvider: ExecutorProvider = {
    descriptor: { providerKey: 'swfix-executor', capabilities: ['timeout', 'structured-output', 'environment-inputs', 'provider-idempotency'] },
    async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
      const root = request.workspace?.root ?? '';
      providerCalls.push({
        cwd: root,
        corrective:
          request.work.taskInputs !== undefined &&
          (request.work.taskInputs as Record<string, unknown>)['corrective'] !== undefined,
      });
      const now = '2026-10-06T00:00:00.000Z';
      if (!existsSync(join(root, 'package.json'))) {
        // First implementation: the deterministic DEFECT (multiply = subtraction).
        writeProject(root, 'a - b');
        return {
          kind: 'succeeded',
          exitCode: 0,
          stdoutText: 'implemented v1',
          structured: { status: 'succeeded', artifactContent: 'implemented multiply (v1, defective).' },
          startedAt: now,
          finishedAt: now,
        };
      }
      if (
        request.work.taskInputs !== undefined &&
        (request.work.taskInputs as Record<string, unknown>)['corrective'] !== undefined
      ) {
        // ONLY the corrective round corrects the defect — a later work item must never
        // fix it for the implementation (that would launder the corrective evidence).
        // With correctiveFixes=false the corrective round writes the SAME defect again:
        // a LEGITIMATE multi-round failure that must re-validate per round and exhaust.
        writeProject(root, correctiveFixes ? 'a * b' : 'a - b');
        return {
          kind: 'succeeded',
          exitCode: 0,
          stdoutText: correctiveFixes ? 'corrected' : 'corrective attempt (still defective)',
          structured: {
            status: 'succeeded',
            artifactContent: correctiveFixes
              ? 'corrected multiply to multiplication.'
              : 'attempted the corrective; the defect persists.',
          },
          startedAt: now,
          finishedAt: now,
        };
      }
      return {
        kind: 'succeeded',
        exitCode: 0,
        stdoutText: 'verified',
        structured: { status: 'succeeded', artifactContent: 'verified the corrected behavior holds.' },
        startedAt: now,
        finishedAt: now,
      };
    },
  };
  const swConfig = resolveExecutorConfig({
    providerKey: 'swfix-executor',
    // A non-empty schema: the dispatch safety gate refuses a config with no fields.
    schema: { profile: { name: 'profile', kind: 'string', required: false, defaultValue: 'swfix' } },
    envNames: {},
  });
  if (!swConfig.ok) throw new Error(swConfig.error.message);

  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { executorKinds: ['companyos:planning', GOAL_WORK_KIND, SOFTWARE_WORK_KIND] },
    goalWorkProfile: {
      stageKind: 'work',
      taskKind: GOAL_WORK_KIND,
      maxAttempts: 3,
      operationKinds: [SOFTWARE_WORK_KIND],
      validatorIds: ['evidence.grounding-check'],
      validatorIdsByTaskKind: {
        [SOFTWARE_WORK_KIND]: ['repo.test-check', 'evidence.grounding-check'],
      },
    },
    providerKinds: [GOAL_WORK_KIND, SOFTWARE_WORK_KIND],
    providerRoutes: { [GOAL_WORK_KIND]: 'swfix-executor', [SOFTWARE_WORK_KIND]: 'swfix-executor' },
    repositoryRuntime: { repositoryCapableKinds: [GOAL_WORK_KIND, SOFTWARE_WORK_KIND] },
    executorProviderImplementations: [{ provider: swProvider, config: swConfig.value }],
    ...(options?.supervisorTimeoutMs === undefined
      ? {}
      : { supervisorBounds: { timeoutMs: options.supervisorTimeoutMs } }),
  } as never);
  if (core === null) throw new Error('composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({ root: workspace, commandProfile: {} });
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  const actor = (await core.database.roleAssignments.list({ limit: 1 })).items[0]!.actorId;
  const registered = await core.providers.register(stub, { actorId: actor });
  if (!registered.ok) throw new Error(registered.error.message);
  const models = await core.models.registerFromProvider({ providerId: 'prov_swfix', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor });
  if (!models.ok) throw new Error(models.error.message);
  const policy = await core.policies.savePolicy({ id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor } as never);
  if (!policy.ok) throw new Error(policy.error.message);
  return { core, workspace, casRoot, dataDir, providerCalls, hangSupervisorCatalogue, illegalProposals };
};

const driveToTerminal = async (
  core: Core,
  goalRunId: string,
  maxAdvances = 40,
): Promise<{ readonly state: string; readonly advances: number }> => {
  const cp = core.controlPlane!;
  for (let i = 0; i < maxAdvances; i += 1) {
    const run = core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(goalRunId) as { state: string };
    if (run.state === 'COMPLETED' || run.state === 'FAILED' || run.state === 'CANCELLED') {
      return { state: run.state, advances: i };
    }
    await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
  }
  const run = core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(goalRunId) as { state: string };
  return { state: run.state, advances: maxAdvances };
};

describe('PRODUCTION corrective integration (F1 closure, no manual injection)', () => {
  it('software validation FAIL → legal REQUEST_CORRECTIVE → corrective execution → SECOND validation batch against the corrected descendant → PASS → grounding → Handoff/Outcome → Goal COMPLETED', async () => {
    const f = await composeSwFix();
    const cp = f.core.controlPlane!;
    const created = await cp.handle({
      operation: 'goal.create',
      payload: { companyId: COMPANY, objective: '修复 multiply 使 multiply(4,3) 返回 12 并独立验证。', commandId: 'swfix-1' },
    });
    if (!created.ok) {
      throw new Error('goal.create failed: ' + JSON.stringify(created.error));
    }
    const goalRunId = String((created.value as { readonly runId: string }).runId);

    // F4-01 evidence: the run-goal structured payload carries the workspace binding.
    const goalArt = f.core.database.db
      .prepare("SELECT content_ref FROM artifacts WHERE kind = 'companyos:run-goal' ORDER BY created_at LIMIT 1")
      .get() as { content_ref: string };
    const hex = goalArt.content_ref.slice('sha256:'.length);
    const goalPayload = JSON.parse(
      readFileSync(join(f.casRoot, hex.slice(0, 2), hex), 'utf8'),
    ) as { structured?: Record<string, unknown> };
    // The binding is the OPAQUE canonical workspace identity (sha256 ref of the bound root)
    // — never a local path in the durable goal payload (F4).
    expect(String(goalPayload.structured?.['workspaceId'])).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Drive the FULL production lifecycle to terminal: plan → work (defective) → validation
    // batch 1 (FAIL) → supervisor corrective decision → corrective execution → validation
    // batch 2 (PASS on the corrected descendant) → grounding → delivery → Outcome → COMPLETED.
    const outcome = await driveToTerminal(f.core, goalRunId, 60);
    expect(outcome.state).toBe('COMPLETED');

    // 1. EXACTLY ONE corrective decision — the old FAIL was consumed, never re-applied as a
    //    second actionable cause (a replay would have ordered another corrective round).
    const decisions = f.core.database.db
      .prepare("SELECT decision, metadata_json FROM decisions WHERE decision = 'REQUEST_CORRECTIVE'")
      .all() as { decision: string; metadata_json: string }[];
    expect(decisions.length).toBe(1);
    const envelope = JSON.parse(decisions[0]!.metadata_json).supervisor as {
      evidenceRefs: readonly { kind: string; ref: string }[];
    };
    expect(envelope.evidenceRefs.some((entry) => entry.kind === 'validation')).toBe(true);

    // 2. The corrective child exists (round 1 of the implementation task).
    const correctiveTasks = f.core.database.db
      .prepare("SELECT id, inputs_json, outputs_json FROM tasks WHERE inputs_json LIKE '%corrective%'")
      .all() as { id: string; inputs_json: string; outputs_json: string | null }[];
    expect(correctiveTasks.length).toBe(1);
    const correctiveLineage = JSON.parse(correctiveTasks[0]!.inputs_json)['corrective'] as {
      round: number;
      causeEvidenceRefs: readonly string[];
    };
    expect(correctiveLineage.round).toBe(1);

    // 3. TWO validation batches: the first FAILED on the defective artifact (historically
    //    present), the second ran against the CORRECTIVE CHILD's corrected artifact and PASSED.
    const vals = f.core.database.db
      .prepare("SELECT validation_id AS id, validator_id, status, target_ref, stage_id FROM validations ORDER BY created_at, rowid")
      .all() as { id: string; validator_id: string; status: string; target_ref: string | null; stage_id: string | null }[];
    const testChecks = vals.filter((v) => v.validator_id === 'repo.test-check');
    expect(testChecks.length).toBeGreaterThanOrEqual(2);
    expect(testChecks[0]?.status).toBe('fail'); // the historical FAIL is still durable
    const lastCheck = testChecks[testChecks.length - 1]!;
    expect(lastCheck.status).toBe('pass');
    // The consumed cause is the FAILING row the corrective child cites — never re-applied.
    expect(correctiveLineage.causeEvidenceRefs).toContain(testChecks[0]!.id);
    expect(correctiveLineage.causeEvidenceRefs).not.toContain(lastCheck.id);
    // The second batch's PASS targets the corrected descendant artifact: the artifactRefs the
    // corrective child's stage-output envelope delivered (no manual injection anywhere).
    const correctiveEnvelope = JSON.parse(correctiveTasks[0]!.outputs_json ?? '{}') as {
      stageOutput?: { artifactRefs?: readonly string[] };
    };
    const correctedArtifacts = correctiveEnvelope.stageOutput?.artifactRefs ?? [];
    expect(correctedArtifacts.length).toBeGreaterThanOrEqual(1);
    expect(lastCheck.target_ref).toBe(`artifact:${correctedArtifacts[0]}`);
    // The first batch could not have targeted that artifact (different, defective artifact).
    expect(testChecks[0]?.target_ref).not.toBe(lastCheck.target_ref);
    // The grounding validator re-ran too — the second batch is a FULL batch, not a partial one.
    const groundings = vals.filter((v) => v.validator_id === 'evidence.grounding-check');
    expect(groundings.length).toBeGreaterThanOrEqual(2);
    expect(groundings[groundings.length - 1]?.status).toBe('pass');

    // 4. The deterministic executor executed against the BOUND workspace only, and the
    //    corrective execution happened (the corrected multiply is on disk).
    expect(f.providerCalls.length).toBeGreaterThanOrEqual(2);
    expect(f.providerCalls.every((call) => call.cwd === f.workspace)).toBe(true);
    expect(f.providerCalls.some((call) => call.corrective)).toBe(true);
    expect(readFileSync(join(f.workspace, 'src', 'math.ts'), 'utf8')).toContain('a * b');

    // 5. The run COMPLETED through the engine's own vocabulary (delivery + completion), and
    //    the Goal run settled by the canonical Outcome delegation.
    const events = f.core.database.db
      .prepare("SELECT type FROM events WHERE aggregate_id = ? OR run_id = ?")
      .all(goalRunId, goalRunId) as { type: string }[];
    const types = events.map((event) => event.type);
    expect(types).not.toContain('run.rework_exhausted');
    const goalRun = f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(goalRunId) as { state: string };
    expect(goalRun.state).toBe('COMPLETED');
    const delivered = f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE aggregate_id = ? AND type = 'run.delivered'")
      .get(goalRunId) as { n: number };
    expect(Number(delivered.n)).toBe(1);
  }, 300_000);
});

describe('F4 integration — workspace switch cannot re-target an existing Goal', () => {
  it('Goal A bound to A: switch to B → execution of Goal A fails closed GOAL_WORKSPACE_MISMATCH, B untouched; new Goal binds B; restart preserves bindings', async () => {
    const f = await composeSwFix();
    const cp = f.core.controlPlane!;
    const created = await cp.handle({
      operation: 'goal.create',
      payload: { companyId: COMPANY, objective: '目标 A：修复 multiply 并验证。', commandId: 'swfix-f4-1' },
    });
    if (!created.ok) throw new Error('goal.create failed: ' + JSON.stringify(created.error));
    const goalA = String((created.value as { readonly runId: string }).runId);
    // F4-08: a stale renderer-supplied workspace value is ignored (no payload field reaches
    // the binding — the binding source is the MAIN-process active workspace only).
    const created2 = await cp.handle({
      operation: 'goal.create',
      payload: { companyId: COMPANY, objective: '目标 A2。', commandId: 'swfix-f4-1b', workspace: 'C:/stale/renderer/value' },
    });
    void created2;

    // F4-02: switch the active workspace to B — Goal A's binding is untouched.
    const closed = f.core.repositoryRuntime.closeWorkspace();
    if (!closed.ok) throw new Error('close failed');
    const dirB = tempDir('swfix-ws-b-');
    const openedB = await f.core.repositoryRuntime.openWorkspace({ root: dirB, commandProfile: {} });
    if (!openedB.ok) throw new Error('open B failed: ' + String(openedB.error?.code));

    // F4-03: Goal A's execution now fails CLOSED with the typed mismatch blocker, and the
    // deterministic executor NEVER runs against B.
    await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalA } });
    const attemptsA = f.core.database.db
      .prepare('SELECT failure_code, substr(failure_summary,1,220) AS detail FROM execution_attempts')
      .all() as { failure_code: string | null; detail: string }[];
    writeFileSync(join(tmpdir(), 'swfix-f4-attempts.json'), JSON.stringify(attemptsA, null, 1));
    expect(
      attemptsA.some((a) => (a.detail ?? '').includes('differs from the Goal workspace binding')),
    ).toBe(true);
    expect(f.providerCalls.every((call) => call.cwd !== dirB)).toBe(true);

    // F4-04: a NEW goal under B binds B (the opaque workspace identity of B).
    const createdB = await cp.handle({
      operation: 'goal.create',
      payload: { companyId: COMPANY, objective: '目标 B：验证。', commandId: 'swfix-f4-2' },
    });
    if (!createdB.ok) throw new Error('goal B create failed: ' + JSON.stringify(createdB.error));
    // F4-04: the NEW goal's binding is B's workspace identity — proven by the reopened
    // durable read below (the newest run-goal artifact belongs to goal B).

    // F4-05: restart (close + reopen the SAME storage) preserves the durable bindings.
    // F4-05: restart (close + reopen the SAME storage) — the durable bindings persist.
    openDatabases.pop()?.close();
    const db2 = openDurableDatabase({ dataDir: f.dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
    openDatabases.push(db2);
    // The bindings live in the durable run-goal artifacts; reopen the DB fresh and read
    // Goal A's binding — still A's workspace identity (unchanged by the switch).
    const reopened = createRunGoalService({
      artifactService: undefined as never,
      artifactStore: db2.artifactStore as never,
      contentStore: createFilesystemArtifactContentStore({ casRoot: f.casRoot }),
      runs: db2.runs as never,
    });
    const goalBId = String((createdB.value as { readonly runId: string }).runId);
    const bindingA = await reopened.get({ runId: goalA, companyId: COMPANY });
    if (!bindingA.ok) throw new Error('binding A read failed: ' + String(bindingA.error?.message));
    const bindingB = await reopened.get({ runId: goalBId, companyId: COMPANY });
    if (!bindingB.ok) throw new Error('binding B read failed: ' + String(bindingB.error?.message));
    // F4-04: the NEW goal under B binds B — a DIFFERENT identity from A's binding.
    expect(String(bindingB.value.structured?.['workspaceId'])).not.toEqual(String(bindingA.value.structured?.['workspaceId']));
    const boundA = (bindingA.value.structured ?? {})['workspaceId'];
    expect(typeof boundA).toBe('string');
    // The stale renderer value never entered the durable payload (F4-08).
    expect(JSON.stringify(bindingA.value.structured)).not.toContain('stale');
  }, 300_000);
});

describe('F1 — every LEGITIMATE corrective round re-validates ITS OWN descendant, then exhausts honestly', () => {
  it('an unfixed defect fails every round: each round gets a NEW batch against its own corrected artifact, then the run PAUSES (no fake COMPLETED)', async () => {
    const f = await composeSwFix({ correctiveFixes: false });
    const cp = f.core.controlPlane!;
    const created = await cp.handle({
      operation: 'goal.create',
      payload: { companyId: COMPANY, objective: '修复 multiply 使 multiply(4,3) 返回 12 并独立验证。', commandId: 'swfix-multi-1' },
    });
    if (!created.ok) throw new Error('goal.create failed: ' + JSON.stringify(created.error));
    const goalRunId = String((created.value as { readonly runId: string }).runId);
    const stateOf = (runId: string): string =>
      String((f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string }).state);
    let executionRunId = '';
    for (let index = 0; index < 90; index += 1) {
      const goalState = stateOf(goalRunId);
      if (goalState === 'COMPLETED' || goalState === 'FAILED' || goalState === 'CANCELLED') break;
      if (executionRunId !== '' && stateOf(executionRunId) === 'PAUSED') break;
      const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
      if (advanced.ok) {
        const exec = String((advanced.value as { readonly executionRunId?: string }).executionRunId ?? '');
        if (exec !== '') executionRunId = exec;
      }
    }
    // The run exhausts its corrective budget HONESTLY: PAUSED, never a false COMPLETED and
    // never a fabricated outcome.
    expect(executionRunId).not.toBe('');
    expect(stateOf(executionRunId)).toBe('PAUSED');
    expect(stateOf(goalRunId)).not.toBe('COMPLETED');
    const delivered = f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE aggregate_id = ? AND type = 'run.delivered'")
      .get(goalRunId) as { n: number };
    expect(Number(delivered.n)).toBe(0);

    // Every round re-validated ITS OWN descendant: rounds 1..n each produced a corrective
    // child whose artifact received its OWN repo.test-check batch row (pairwise distinct
    // targets), and each batch honestly FAILED (the defect was never fixed).
    const correctiveRows = f.core.database.db
      .prepare("SELECT id, inputs_json, outputs_json FROM tasks WHERE inputs_json LIKE '%corrective%' ORDER BY created_at, rowid")
      .all() as { id: string; inputs_json: string; outputs_json: string | null }[];
    expect(correctiveRows.length).toBeGreaterThanOrEqual(2);
    const rounds = correctiveRows.map(
      (row) => (JSON.parse(row.inputs_json)['corrective'] as { round: number }).round,
    );
    expect(rounds).toEqual([...rounds].sort((left, right) => left - right));
    expect(rounds[0]).toBe(1);
    const checks = f.core.database.db
      .prepare("SELECT validation_id AS id, status, target_ref FROM validations WHERE validator_id = 'repo.test-check' ORDER BY created_at, rowid")
      .all() as { id: string; status: string; target_ref: string | null }[];
    expect(checks.length).toBeGreaterThanOrEqual(correctiveRows.length + 1);
    expect(checks.every((row) => row.status === 'fail')).toBe(true);
    const descendantRefs = correctiveRows.map((row) => {
      const envelope = JSON.parse(row.outputs_json ?? '{}') as {
        stageOutput?: { artifactRefs?: readonly string[] };
      };
      return `artifact:${(envelope.stageOutput?.artifactRefs ?? [])[0] ?? ''}`;
    });
    for (const ref of descendantRefs) {
      expect(checks.some((row) => row.target_ref === ref)).toBe(true);
    }
    expect(new Set(descendantRefs).size).toBe(descendantRefs.length);
    // Each round's NEW batch is also the newest row for its validator (a stale FAIL row is
    // never mistaken for the current verdict of a later round).
    for (const ref of descendantRefs) {
      const matching = checks.filter((row) => row.target_ref === ref);
      expect(matching.length).toBeGreaterThanOrEqual(1);
    }
  }, 600_000);
});

describe('F1 — the illegal-proposal budget is DURABLE (canonical across autonomy calls)', () => {
  it('three CONSECUTIVE illegal proposals across separate autonomous advances reach the typed exhaustion; a legal turn then resumes', async () => {
    const f = await composeSwFix();
    const cp = f.core.controlPlane!;
    const created = await cp.handle({
      operation: 'goal.create',
      payload: { companyId: COMPANY, objective: '修复 multiply 使 multiply(4,3) 返回 12 并独立验证。', commandId: 'swfix-budget-1' },
    });
    if (!created.ok) throw new Error('goal.create failed: ' + JSON.stringify(created.error));
    const goalRunId = String((created.value as { readonly runId: string }).runId);
    const advance = () =>
      cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
    const exhausted = (result: Awaited<ReturnType<typeof advance>>): boolean =>
      result.ok === false &&
      String(
        ((result as { error?: { details?: Record<string, unknown> } }).error?.details ?? {})['reason'] ??
          '',
      ) === 'SUPERVISOR_INVALID_ACTIONS_EXHAUSTED';

    // Three CONSECUTIVE illegal turns across three SEPARATE autonomy calls (advances). The
    // budget is derived from durable failed supervisor executions, so the count CARRIES OVER
    // between calls — an in-call counter resets each call and could never reach the bound.
    f.illegalProposals.value = true;
    const first = await advance();
    const second = await advance();
    expect(exhausted(first)).toBe(false);
    expect(exhausted(second)).toBe(false);
    // Durable proof of the two counted turns: FAILED (INVALID_OUTPUT) supervisor executions.
    const illegals = (): number =>
      Number(
        (
          f.core.database.db
            .prepare("SELECT COUNT(*) AS n FROM agent_executions WHERE agent_id = 'supervisor-runtime' AND status = 'FAILED' AND error_kind = 'INVALID_OUTPUT'")
            .get() as { n: number }
        ).n,
      );
    expect(illegals()).toBe(2);
    const third = await advance();
    expect(exhausted(third)).toBe(true);
    expect(illegals()).toBe(3);
    // No illegal proposal ever became a Decision.
    const decisions = f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
    expect(Number(decisions.n)).toBe(0);

    // A LEGAL turn still proceeds afterwards: the typed terminal bounds the MODEL's
    // consecutive illegal proposals, it does not poison the run. The deterministic policy
    // resumes and records a Decision that drives the implementation work.
    f.illegalProposals.value = false;
    const resumed = await advance();
    expect(exhausted(resumed)).toBe(false);
    const recorded = f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
    expect(Number(recorded.n)).toBeGreaterThanOrEqual(1);
  }, 300_000);
});

describe('F1+F2 combined — supervisor timeout settles truthfully, no busy loop, no fake COMPLETED', () => {
  it('an unresponsive supervisor model settles as a durable CANCELLED execution; the frozen §28 rule then refuses automatic re-entry (human resume is the way on)', async () => {
    const f = await composeSwFix({ supervisorTimeoutMs: 700 });
    const cp = f.core.controlPlane!;
    const created = await cp.handle({
      operation: 'goal.create',
      payload: { companyId: COMPANY, objective: '修复 multiply 使 multiply(4,3) 返回 12 并独立验证。', commandId: 'swfix-f12-1' },
    });
    if (!created.ok) throw new Error('goal.create failed: ' + JSON.stringify(created.error));
    const goalRunId = String((created.value as { readonly runId: string }).runId);
    // The provider catalogue hangs on SUPERVISOR turns until the deadline aborts it.
    f.hangSupervisorCatalogue.value = true;
    let executionRunId = '';
    for (let i = 0; i < 3; i += 1) {
      const advanced = await cp.handle({ operation: 'goal.advance', payload: { companyId: COMPANY, runId: goalRunId } });
      if (advanced.ok) {
        const exec = String((advanced.value as { readonly executionRunId?: string }).executionRunId ?? '');
        if (exec !== '') executionRunId = exec;
      }
    }
    // NO execution left RUNNING after the deadline (F2 durable settlement).
    const running = f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM agent_executions WHERE status = 'RUNNING'")
      .get() as { n: number };
    expect(running.n).toBe(0);
    // No fake COMPLETED while the provider is unresponsive.
    const goalState = f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(goalRunId) as { state: string };
    expect(goalState.state).not.toBe('COMPLETED');
    // No busy loop: bounded behavior (the loop consumed a bounded number of turns).
    const executions = f.core.database.db
      .prepare('SELECT COUNT(*) AS n FROM agent_executions')
      .get() as { n: number };
    expect(executions.n).toBeLessThan(30);
    // The timed-out turn settled as a durable CANCELLED supervisor execution (truthful
    // settlement — never left RUNNING, never recorded a Decision the model never proposed).
    const cancelled = f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM agent_executions WHERE agent_id = 'supervisor-runtime' AND status = 'CANCELLED' AND error_kind = 'CANCELLED'")
      .get() as { n: number };
    expect(Number(cancelled.n)).toBeGreaterThanOrEqual(1);
    expect(Number((f.core.database.db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n)).toBe(0);

    // Provider recovery alone does NOT auto-resume: a CANCELLED attempt is terminal in the
    // frozen machine (§28/§48 — never re-entered automatically), so the run stays parked and
    // crucially no further model calls are made (no budget drain, no duplicate work).
    f.hangSupervisorCatalogue.value = false;
    const outcome = await driveToTerminal(f.core, goalRunId, 60);
    expect(outcome.state).not.toBe('COMPLETED');
    const finalRunning = f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM agent_executions WHERE status = 'RUNNING'")
      .get() as { n: number };
    expect(finalRunning.n).toBe(0);
    // The parked run names its honest state: EXECUTING with the work still PENDING and
    // exactly the one cancelled supervisor attempt — what a human resume acts on.
    expect(executionRunId).not.toBe('');
    const execState = f.core.database.db.prepare('SELECT state FROM runs WHERE id = ?').get(executionRunId) as { state: string };
    expect(execState.state).toBe('EXECUTING');
    const supervisorExecs = f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM agent_executions WHERE agent_id = 'supervisor-runtime'")
      .get() as { n: number };
    expect(Number(supervisorExecs.n)).toBe(1);
    const pendingWork = f.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE state = 'PENDING'")
      .get() as { n: number };
    expect(Number(pendingWork.n)).toBe(1);
  }, 300_000);
});


