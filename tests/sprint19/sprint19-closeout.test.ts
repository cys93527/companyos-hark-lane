import { registerOfflineGitWorkspace } from '../support/offline-fixtures.js';
/**
 * Sprint 19 FINAL CLOSEOUT proofs (closeout §20 routing classification, §21 opened-workspace
 * anchor projection, §22 anchor freshness) — all against the REAL production composition
 * (`composeCoreServices`): the real carrier (`core.stageOutputCarrier`), the real repository
 * runtime workspace seam (`core.repositoryRuntime.openWorkspace`, a REAL Git workspace), the
 * real session/projector paths, and the real autonomous loop.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTask,
  createToolRecord,
  ok,
  TOOL_CAPABILITY_VALIDATOR,
  TOOL_ID_PATTERN,
  STAGE_OUTPUT_TASK_KEY,
  type DomainError,
  type ModelProviderPort,
  type Result,
  type ToolPort,
} from '@companyos/core';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const CHAINS = [
  'core',
  'engine',
  'lifecycle',
  'provider',
  'registry',
  'selection',
  'agent',
  'tools',
  'artifact',
  'pack',
  'memory',
  'session',
] as const;
const COMPANY = 'company_default';
const PROVIDER_ID = 'prov_e2e7';
const MODEL_KEY = 'e2e7.supervisor';
const PROVIDER_MODEL_ID = 'e2e7-model-1';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s19c-'));
  createdDirs.push(dir);
  return dir;
};

/** A REAL Git workspace root (the trusted host seam opens real repositories only). */
const makeGitRoot = (): string => {
  const root = tempDir();
  registerOfflineGitWorkspace(root);
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  git(['init']);
  git(['config','user.email','closeout@companyos.test']);
  git(['config','user.name','closeout']);
  writeFileSync(join(root, 'README.md'), 'Sprint 19 closeout workspace.\n');
  git(['add','README.md']);
  git(['commit','-m','init']);
  return root;
};

const VALIDATOR_ID = 'e2e7.unit_validator';

const createValidatorPort = (): ToolPort => ({
  describe: () => ({
    toolId: VALIDATOR_ID,
    name: 'unit validator',
    description: 'Deterministic in-process unit validator (E2E fixture).',
    version: '1.0.0',
    capabilities: [TOOL_CAPABILITY_VALIDATOR],
    riskLevel: 'LOW',
    parameters: { type: 'object', additionalProperties: true },
  }),
  async invoke(request) {
    const finishedAt = new Date().toISOString();
    return ok({
      status: 'ok' as const,
      output: {
        verdict: 'pass',
        evidenceRefs: [`command:${VALIDATOR_ID}:${request.idempotencyKey ?? 'once'}`],
        report: {
          kind: 'companyos:validator-report',
          label: `${VALIDATOR_ID} report`,
          content: JSON.stringify({ validatorId: VALIDATOR_ID, verdict: 'pass' }),
        },
      },
      artifactRefs: [],
      startedAt: finishedAt,
      finishedAt,
      latencyMs: 1,
    });
  },
});

/** Every provider message is captured so the tests can SEE what each role received. */
const invocationLog: { readonly role: string; readonly user: string }[] = [];
let reviewCursor = 0;
let proposalCursor = 0;
const reviewScript: { verdicts: ('PASS' | 'CHANGES_REQUESTED')[] } = { verdicts: ['PASS'] };
const PROPOSALS_HAPPY = [
  { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
  { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review.' },
  { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the QA.' },
  { action: 'COMPLETE', reasonCode: 'GOAL_SATISFIED', summary: 'The objective is delivered.' },
];

const firstJsonObjectAt = (
  text: string,
  from: number,
): Readonly<Record<string, unknown>> | null => {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, index + 1));
          return typeof parsed === 'object' && parsed !== null
            ? (parsed as Readonly<Record<string, unknown>>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

const createRoutingProvider = (): ModelProviderPort => ({
  describe: () => ({
    providerId: PROVIDER_ID,
    kind: 'fake',
    displayName: 'Routing model',
    version: '1.0.0',
  }),
  listModels: () =>
    Promise.resolve(
      ok([
        {
          modelId: PROVIDER_MODEL_ID,
          displayName: PROVIDER_MODEL_ID,
          contextWindow: 8_192,
          capabilities: { streaming: false, structuredOutput: true },
        },
      ]),
    ),
  health: () => Promise.resolve(ok(undefined as never)),
  invoke(request) {
    const user =
      request.messages.map((m) => ({ role: m.role, content: m.content })).find((m) => m.role === 'user')
        ?.content ?? '';
    let role = 'supervisor';
    if (user.includes('companyos/work-role-context/1')) role = 'developer';
    else if (user.includes('companyos/review-context/1')) role = 'review';
    else if (user.includes('companyos/validation-context/1')) role = 'qa';
    invocationLog.push({ role, user });
    const structuredFor = (payload: Record<string, unknown>): Record<string, unknown> => payload;
    if (role === 'developer') {
      return Promise.resolve(
        ok({
          modelId: request.modelId,
          providerId: PROVIDER_ID,
          outputText: `developer note ${String(invocationLog.length)}`,
          structured: structuredFor({ objective: 'Build the slice.', summary: 'work note' }),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
          finishReason: 'stop' as const,
        }),
      );
    }
    if (role === 'review') {
      const context = firstJsonObjectAt(user, user.indexOf('companyos/review-context/1') - 400);
      const subject = context?.['subject'] as Record<string, unknown> | undefined;
      const verdict = reviewScript.verdicts[Math.min(reviewCursor, reviewScript.verdicts.length - 1)];
      reviewCursor += 1;
      return Promise.resolve(
        ok({
          modelId: request.modelId,
          providerId: PROVIDER_ID,
          outputText: 'review note',
          structured: {
            verdict,
            subjectTaskId: subject === undefined ? '' : String(subject['taskId'] ?? ''),
            findings: [],
          },
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
          finishReason: 'stop' as const,
        }),
      );
    }
    if (role === 'qa') {
      const context = firstJsonObjectAt(user, user.indexOf('companyos/validation-context/1') - 400);
      const targetRef = String(context?.['goalArtifactRef'] ?? '');
      return Promise.resolve(
        ok({
          modelId: request.modelId,
          providerId: PROVIDER_ID,
          outputText: 'qa note',
          structured: {
            targetRef,
            validators: [{ validatorId: 'e2e7.unit_validator', blocking: true }],
          },
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
          finishReason: 'stop' as const,
        }),
      );
    }
    const seat = user.indexOf('# Memory view');
    const context = seat >= 0 ? firstJsonObjectAt(user, seat) : null;
    const script = PROPOSALS_HAPPY[Math.min(proposalCursor, PROPOSALS_HAPPY.length - 1)]!;
    proposalCursor += 1;
    const subject = context?.['subject'] as Record<string, unknown> | undefined;
    const validation = context?.['validation'] as Record<string, unknown> | undefined;
    return Promise.resolve(
      ok({
        modelId: request.modelId,
        providerId: PROVIDER_ID,
        outputText: 'supervisor note',
        structured: {
          schema: 'companyos/supervisor-proposal/1',
          action: script.action,
          reasonCode: script.reasonCode,
          summary: script.summary,
          evidenceRefs:
            script.action === 'COMPLETE' && validation !== undefined
              ? [String(validation['validationId'] ?? '')]
              : [],
          ...(subject === undefined ? {} : { subject: { taskId: String(subject['taskId'] ?? '') } }),
        },
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
        finishReason: 'stop' as const,
      }),
    );
  },
  stream(): AsyncIterable<Result<never, DomainError>> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<Result<never, DomainError>>> =>
          Promise.resolve({ done: true, value: undefined }),
      }),
    };
  },
});

const compose = async (): Promise<Core> => {
  const db = openDurableDatabase({
    dataDir: tempDir(),
    appliedAt: new Date().toISOString(),
    chains: [...CHAINS],
  });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({
    casRoot: tempDir(),
    database: db,
    logger: nullLogger as never,
  });
  if (!foundation.ok) throw new Error(`artifact foundation failed: ${foundation.error.message}`);
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: {
      developerKinds: ['e2e7:build'],
      reviewKinds: ['e2e7:review'],
      qaKinds: ['e2e7:qa'],
    },
    toolPorts: new Map<string, ToolPort>([[VALIDATOR_ID, createValidatorPort()]]),
  });
  if (core === null) throw new Error('production composition failed');
  const actor = (await core.database.roleAssignments.list({ limit: 10 })).items[0]?.actorId;
  if (actor === undefined) throw new Error('no owner provisioned');
  const validatorRecord = createToolRecord({
    toolId: VALIDATOR_ID,
    name: 'unit validator',
    description: 'Deterministic in-process unit validator (E2E fixture).',
    version: '1.0.0',
    capabilities: [TOOL_CAPABILITY_VALIDATOR],
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true },
    riskLevel: 'LOW',
    requiredAuthorities: ['tool.invoke'],
    idempotencyMode: 'IDEMPOTENT_KEY',
    adapterRef: VALIDATOR_ID,
    now: new Date().toISOString(),
  });
  if (!validatorRecord.ok) throw new Error(validatorRecord.error.message);
  if (!TOOL_ID_PATTERN.test(VALIDATOR_ID)) throw new Error('the fixture validator id is illegal');
  const registered = await core.tools.register(validatorRecord.value, { actorId: actor });
  if (!registered.ok && registered.error.code !== 'CONFLICT') {
    throw new Error(registered.error.message);
  }
  const provider = await core.providers.register(createRoutingProvider(), { actorId: actor });
  if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
  const model = await core.models.registerFromProvider({
    providerId: PROVIDER_ID,
    providerModelId: PROVIDER_MODEL_ID,
    modelKey: MODEL_KEY,
    actorId: actor,
  });
  if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
  return core;
};

interface Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly runId: string;
  readonly workTaskId: string;
  readonly reviewTaskId: string;
  readonly qaTaskId: string;
}

const makeFixture = async (): Promise<Fixture> => {
  invocationLog.length = 0;
  reviewCursor = 0;
  proposalCursor = 0;
  reviewScript.verdicts = ['PASS'];
  const core = await compose();
  const actor = (await core.database.roleAssignments.list({ limit: 10 })).items[0]!.actorId;
  const template = await core.lifecycle.createTemplate({
    orgId: COMPANY,
    name: `S19C ${core.ids.id('t')}`,
    actorId: actor,
  });
  if (!template.ok) throw new Error(template.error.message);
  const tag = core.ids.id('s');
  const graph = {
    nodes: [
      { id: `work_${tag}`, kind: 'work' as const, title: 'work', config: {} },
      { id: `review_${tag}`, kind: 'review' as const, title: 'review', config: {} },
      {
        id: `qa_${tag}`,
        kind: 'qa' as const,
        title: 'qa',
        config: { validatorIds: ['e2e7.unit_validator'] },
      },
    ],
    edges: [
      { from: `work_${tag}`, to: `review_${tag}` },
      { from: `review_${tag}`, to: `qa_${tag}` },
    ],
  };
  const saved = await core.lifecycle.saveDraftGraph({
    templateId: template.value.id,
    graph,
    actorId: actor,
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({ templateId: template.value.id, actorId: actor });
  if (!published.ok) throw new Error(published.error.message);
  const run = await core.lifecycle.createRun({
    templateId: template.value.id,
    companyId: COMPANY,
    workflowId: `wf_${core.ids.id('w')}`,
    actorId: actor,
    modelBindings: { supervisor: MODEL_KEY },
    goal: {
      objective: 'Prove the opened-workspace anchor reaches every role projection.',
      source: { type: 'human' },
    },
  });
  if (!run.ok) throw new Error(run.error.message);
  const driven = await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
  if (!driven.ok) throw new Error(driven.error.message);
  const mkTask = (stageId: string, roleId: string, kind: string) =>
    createTask({
      runId: run.value.run.id as never,
      stageId: stageId as never,
      roleId: roleId as never,
      kind,
      now: new Date().toISOString(),
      ids: core.ids,
    });
  const work = await mkTask(`work_${tag}`, 'rol_dev', 'e2e7:build');
  const review = await mkTask(`review_${tag}`, 'rol_reviewer', 'e2e7:review');
  const qa = await mkTask(`qa_${tag}`, 'rol_qa', 'e2e7:qa');
  if (!work.ok || !review.ok || !qa.ok) throw new Error('task seeding failed');
  await core.database.tasks.put(work.value);
  await core.database.tasks.put(review.value);
  await core.database.tasks.put(qa.value);
  return {
    core,
    actor,
    runId: run.value.run.id,
    workTaskId: work.value.id,
    reviewTaskId: review.value.id,
    qaTaskId: qa.value.id,
  };
};

const runLoop = (f: Fixture) =>
  f.core.autonomousSupervisor!.run({
    companyId: COMPANY,
    runId: f.runId,
    taskId: f.workTaskId,
    reviewTaskId: f.reviewTaskId,
    actorId: f.actor,
    runIdentity: 's19c',
  });

const usersOf = (role: string): readonly string[] =>
  invocationLog.filter((entry) => entry.role === role).map((entry) => entry.user);

/* ------------------------------------------- closeout §20: routing classification */

describe('Sprint19 closeout §20 — recovery routing classification', () => {
  it('work-role-work skips by explicit classification; unknown kinds FAIL CLOSED; provenance gates hold', async () => {
    const f = await makeFixture();
    const envelopeOf = (kind: string, executionId: string | null) => ({
      schemaVersion: 'companyos/stage-output/1',
      kind,
      executionId,
      artifactRefs: [],
      validationRefs: [],
      payload: {},
    });
    const taskWith = async (
      kind: string,
      seedTrustedExecution: boolean,
    ): Promise<{ readonly taskId: string; readonly executionId: string | null }> => {
      const task = await createTask({
        runId: f.runId as never,
        stageId: 'work' as never,
        roleId: 'rol_dev' as never,
        kind: 'e2e7:build',
        now: new Date().toISOString(),
        ids: f.core.ids,
      });
      if (!task.ok) throw new Error(task.error.message);
      let executionId: string | null = null;
      if (seedTrustedExecution) {
        executionId = `exec_${f.core.ids.id('c')}`;
        const stamp = new Date().toISOString();
        f.core.database.db
          .prepare(
            `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
               provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
               input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
               created_at, updated_at)
             VALUES (?, 'agent.developer', 'rol.developer', ?, ?, 'm', 'p', 'pm', 'COMPLETED', ?, NULL, 'tr', 1,
               '{}', '{}', 1, NULL, NULL, NULL, NULL, ?, ?)`,
          )
          .run(executionId, task.value.id, f.runId, stamp, stamp, stamp);
      }
      // createTask always starts with empty outputs; the durable envelope is added on the row
      // exactly the way the engine's completion writes it.
      await f.core.database.tasks.put({
        ...task.value,
        outputs: { [STAGE_OUTPUT_TASK_KEY]: envelopeOf(kind, executionId) },
      } as never);
      return { taskId: task.value.id, executionId };
    };
    // 1: the ONE explicitly classified no-sink kind — recovery skips exactly as designed.
    const work = await taskWith('companyos:work-role-work', false);
    const skipped = await f.core.stageOutputCarrier!.routeTask({
      companyId: COMPANY,
      runId: f.runId,
      taskId: work.taskId,
      actorId: f.actor,
    });
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;
    expect(skipped.value).toBeNull();
    // 2: an UNKNOWN kind never silently skips — even with FULLY VERIFIABLE provenance (a real
    // COMPLETED execution of this very task), the sink lookup itself fails closed on the kind.
    const unknown = await taskWith('companyos:mystery-output', true);
    const unknownRouted = await f.core.stageOutputCarrier!.routeTask({
      companyId: COMPANY,
      runId: f.runId,
      taskId: unknown.taskId,
      actorId: f.actor,
    });
    expect(unknownRouted.ok).toBe(false);
    if (unknownRouted.ok === true) return;
    expect(String(unknownRouted.error.details['reason'] ?? '')).toBe('STAGE_OUTPUT_KIND_UNROUTABLE');
    // 3: a REVIEW candidate never skips — unverifiable provenance fails closed before any sink.
    const reviewNoExec = await taskWith('companyos:review-findings-candidate', false);
    const reviewNoExecution = await f.core.stageOutputCarrier!.routeTask({
      companyId: COMPANY,
      runId: f.runId,
      taskId: reviewNoExec.taskId,
      actorId: f.actor,
    });
    expect(reviewNoExecution.ok).toBe(false);
    if (reviewNoExecution.ok === true) return;
    expect(String(reviewNoExecution.error.details['reason'] ?? '')).toBe(
      'STAGE_OUTPUT_EXECUTION_MISSING',
    );
    // 4: a VALIDATION candidate without its required target fails closed as well.
    const qaNoExec = await taskWith('companyos:validation-candidate', false);
    const qaMissingTarget = await f.core.stageOutputCarrier!.routeTask({
      companyId: COMPANY,
      runId: f.runId,
      taskId: qaNoExec.taskId,
      actorId: f.actor,
    });
    expect(qaMissingTarget.ok).toBe(false);
    if (qaMissingTarget.ok === true) return;
    expect(String(qaMissingTarget.error.details['reason'] ?? '')).toBe(
      'STAGE_OUTPUT_EXECUTION_MISSING',
    );
  });
});

/* --------------------------- closeout §21/§22: opened-workspace anchor + freshness */

describe('Sprint19 closeout §21/§22 — opened workspace anchor reaches every role projection', () => {
  it('with a REAL opened Git workspace, Developer/Reviewer/QA all receive the anchor identity', async () => {
    const f = await makeFixture();
    const opened = await f.core.repositoryRuntime!.openWorkspace({
      root: makeGitRoot(),
      commandProfile: {},
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const workspaceId = opened.value.workspaceId;
    expect(workspaceId).not.toBe('');
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    expect(result.value.stopReason).toBe('completed');
    // §21: every role projection carries the CURRENT canonical anchor identity — refs only,
    // never repository contents.
    const developer = usersOf('developer')[0]!;
    const review = usersOf('review')[0]!;
    const qa = usersOf('qa')[0]!;
    expect(developer).toContain(`"anchorIdentity":{"workspaceId":"${workspaceId}"`);
    expect(developer).toContain('workspace-anchor');
    expect(review).toContain(`"anchor":{"workspaceId":"${workspaceId}"}`);
    expect(qa).toContain(`"anchor":{"workspaceId":"${workspaceId}"}`);
    // no repository CONTENT leaked into any prompt (identity + refs only)
    for (const user of [developer, review, qa]) {
      expect(user).not.toContain('Sprint 19 closeout workspace.');
    }
  });

  it('§22: a legally changed workspace anchor reaches the NEXT projection; session residue cannot freeze it', async () => {
    const f = await makeFixture();
    const first = await f.core.repositoryRuntime!.openWorkspace({
      root: makeGitRoot(),
      commandProfile: {},
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstId = first.value.workspaceId;
    // turn 1 on the work task: the projection carries the FIRST anchor
    const turn1 = await f.core.developerSession!.runTurn({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.workTaskId,
      actorId: f.actor,
      structuredKeys: ['objective', 'summary'],
    });
    expect(turn1.ok).toBe(true);
    if (!turn1.ok) return;
    expect(usersOf('developer')[0]).toContain(firstId);
    // the anchor changes LEGALLY (close → open a different workspace)
    const closed = f.core.repositoryRuntime!.closeWorkspace();
    expect(closed.ok).toBe(true);
    const second = await f.core.repositoryRuntime!.openWorkspace({
      root: makeGitRoot(),
      commandProfile: {},
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondId = second.value.workspaceId;
    expect(secondId).not.toBe(firstId);
    // turn 2: the SAME durable session (with turn-1 residue) must show the NEW canonical
    // anchor — authoritative freshness wins over any session-copied state.
    const turn2 = await f.core.developerSession!.runTurn({
      companyId: COMPANY,
      runId: f.runId,
      taskId: f.workTaskId,
      actorId: f.actor,
      structuredKeys: ['objective', 'summary'],
    });
    expect(turn2.ok).toBe(true);
    if (!turn2.ok) return;
    const developerUsers = usersOf('developer');
    expect(developerUsers).toHaveLength(2);
    expect(developerUsers[1]).toContain(secondId);
    expect(developerUsers[1]).not.toContain(`"workspaceId":"${firstId}"`);
    // the turn-1 residue itself is still there (durable history untouched)
    expect(developerUsers[1]).toContain('# Session residue');
  });
});
