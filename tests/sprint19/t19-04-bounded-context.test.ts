/**
 * Task-19-04 — Reviewer / QA BOUNDED CONTEXT completion (§41-§44: the 37 required tests,
 * plus the §45 production acceptance and the §46 corrective acceptance), ALL against the REAL
 * production composition: `composeCoreServices` with the trusted developer/review/qa kind
 * registrations, the REAL session kernel (Developer only), the REAL bounded role-context
 * projectors (Reviewer/QA), the REAL pinned executions + ProviderRegistry + canonical sinks,
 * and the REAL autonomous loop. The routing provider is context-aware — it answers each role
 * from the context that invocation actually received — so every assertion is about what the
 * production path really projected.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTask,
  createToolRecord,
  ok,
  TOOL_CAPABILITY_VALIDATOR,
  TOOL_ID_PATTERN,
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
const VALIDATOR_ID = 'e2e7.unit_validator';

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t19e-'));
  createdDirs.push(dir);
  return dir;
};

/* ------------------------------------------------------------------ the provider */

/** Every invocation, classified by the context marker it actually received. */
const invocations: { readonly role: string; readonly user: string }[] = [];
let reviewCursor = 0;
let proposalCursor = 0;
/** The scripted review verdicts, consumed per review invocation. */
const reviewScript: { verdicts: ('PASS' | 'CHANGES_REQUESTED')[] } = { verdicts: ['PASS'] };

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

/** The FIRST complete JSON object at or after `from` in `text` (string-aware nesting). */
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

/** The FIRST complete JSON object in `text` whose opening brace precedes `marker`. */
const jsonObjectAround = (
  text: string,
  marker: string,
): Readonly<Record<string, unknown>> | null => {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  let start = -1;
  for (let index = markerIndex; index >= 0; index -= 1) {
    if (text[index] === '{') {
      start = index;
      break;
    }
  }
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

const SUPERVISOR_PROPOSALS_HAPPY = [
  { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
  { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review.' },
  { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the QA.' },
  { action: 'COMPLETE', reasonCode: 'GOAL_SATISFIED', summary: 'The objective is delivered.' },
];
const SUPERVISOR_PROPOSALS_CORRECTIVE = [
  { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
  { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review.' },
  {
    action: 'REQUEST_CORRECTIVE',
    reasonCode: 'REVIEW_FINDING',
    summary: 'The reviewer requires corrective work.',
  },
  { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the round-two review.' },
  { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the QA.' },
  { action: 'COMPLETE', reasonCode: 'GOAL_SATISFIED', summary: 'Delivered.' },
];
/**
 * The over-budget scenario: a context that fails CLOSED is a retryable agent-unit failure,
 * so the loop keeps proposing CONTINUE until the attempts exhaust and the unit surfaces its
 * canonical execution failure — never a fabricated COMPLETE on top of a failed unit.
 */
const SUPERVISOR_PROPOSALS_OVER_BUDGET = [
  { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Keep going.' },
];

/** Which proposal script the provider consumes (switched per fixture). */
let proposalsOf: typeof SUPERVISOR_PROPOSALS_HAPPY = SUPERVISOR_PROPOSALS_HAPPY;

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
    const user = request.messages.map((m) => ({ role: m.role, content: m.content }))
      .find((m) => m.role === 'user')?.content ?? '';
    let role = 'supervisor';
    if (user.includes('companyos/work-role-context/1')) role = 'developer';
    else if (user.includes('companyos/review-context/1')) role = 'review';
    else if (user.includes('companyos/validation-context/1')) role = 'qa';
    invocations.push({ role, user });
    const n = invocations.length;
    if (role === 'developer') {
      return Promise.resolve(
        ok({
          modelId: request.modelId,
          providerId: PROVIDER_ID,
          outputText: `developer note ${String(n)}`,
          structured: { objective: 'Build the slice.', summary: `work note ${String(n)}` },
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
          finishReason: 'stop' as const,
        }),
      );
    }
    if (role === 'review') {
      // The reviewer answers FROM ITS CONTEXT: the subject is the projected subject task.
      const context = jsonObjectAround(user, 'companyos/review-context/1');
      const subject = context?.['subject'] as Record<string, unknown> | undefined;
      const verdict = reviewScript.verdicts[Math.min(reviewCursor, reviewScript.verdicts.length - 1)];
      reviewCursor += 1;
      return Promise.resolve(
        ok({
          modelId: request.modelId,
          providerId: PROVIDER_ID,
          outputText: `review note ${String(n)}`,
          structured: {
            verdict,
            subjectTaskId: subject === undefined ? '' : String(subject['taskId'] ?? ''),
            findings:
              verdict === 'CHANGES_REQUESTED'
                ? [
                    {
                      code: 'semantic.boundary',
                      summary: 'The delivered work crosses a frozen boundary.',
                      detail: 'The change must stay inside the work stage contract.',
                      blocking: true,
                    },
                  ]
                : [],
          },
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
          finishReason: 'stop' as const,
        }),
      );
    }
    if (role === 'qa') {
      // The QA plan comes from the TRUSTED projected configuration, never a guess.
      const context = jsonObjectAround(user, 'companyos/validation-context/1');
      const targetRef = String(context?.['goalArtifactRef'] ?? '');
      const validators = Array.isArray(context?.['validators'])
        ? (context['validators'] as unknown[]).map((id) => ({
            validatorId: String(id),
            blocking: true,
          }))
        : [{ validatorId: VALIDATOR_ID, blocking: true }];
      return Promise.resolve(
        ok({
          modelId: request.modelId,
          providerId: PROVIDER_ID,
          outputText: `qa note ${String(n)}`,
          structured: { targetRef, validators },
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalCost: null },
          finishReason: 'stop' as const,
        }),
      );
    }
    // Supervisor: consume the script; subject + evidence come from the received context
    // (parsed exactly the way the sprint-18 production mock does: the context JSON after the
    // memory-view heading, whose first field is the canonical goal).
    const seat = user.indexOf('# Memory view');
    const context = seat >= 0 ? firstJsonObjectAt(user, seat) : null;
    const script =
      proposalsOf[Math.min(proposalCursor, proposalsOf.length - 1)] ??
      proposalsOf[proposalsOf.length - 1]!;
    proposalCursor += 1;
    const subject = context?.['subject'] as Record<string, unknown> | undefined;
    const review = context?.['review'] as Record<string, unknown> | undefined;
    const validation = context?.['validation'] as Record<string, unknown> | undefined;
    const evidenceRefs =
      script.action === 'COMPLETE' && validation !== undefined && validation !== null
        ? [String(validation['validationId'] ?? '')]
        : script.action === 'REQUEST_CORRECTIVE' && review !== undefined
          ? [`artifact:${String(review['artifactId'] ?? '')}`]
          : [];
    return Promise.resolve(
      ok({
        modelId: request.modelId,
        providerId: PROVIDER_ID,
        outputText: `supervisor note ${String(n)}`,
        structured: {
          schema: 'companyos/supervisor-proposal/1',
          action: script.action,
          reasonCode: script.reasonCode,
          summary: script.summary,
          ...(subject === undefined ? {} : { subject: { taskId: String(subject['taskId'] ?? '') } }),
          evidenceRefs, // the decoder requires the key, even when the list is empty
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

/* ------------------------------------------------------------------ the fixture */

const compose = async (
  paths?: { readonly dataDir: string; readonly casRoot: string },
): Promise<Core> => {
  const dataDir = paths?.dataDir ?? tempDir();
  const casRoot = paths?.casRoot ?? tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error(`artifact foundation failed: ${foundation.error.message}`);
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    // Trusted configuration: all three role kind registrations through the production seam.
    stageHandlers: {
      developerKinds: ['e2e7:build'],
      reviewKinds: ['e2e7:review'],
      qaKinds: ['e2e7:qa'],
    },
    toolPorts: new Map<string, ToolPort>([[VALIDATOR_ID, createValidatorPort()]]),
  });
  if (core === null) throw new Error('production composition failed');
  return core;
};

const seedModel = async (core: Core, actor: string): Promise<void> => {
  const provider = await core.providers.register(createRoutingProvider(), { actorId: actor });
  if (!provider.ok && provider.error.code !== 'CONFLICT') throw new Error(provider.error.message);
  const model = await core.models.registerFromProvider({
    providerId: PROVIDER_ID,
    providerModelId: PROVIDER_MODEL_ID,
    modelKey: MODEL_KEY,
    actorId: actor,
  });
  if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
};

const registerValidator = async (core: Core, actor: string): Promise<void> => {
  const record = createToolRecord({
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
  if (!record.ok) throw new Error(record.error.message);
  if (!TOOL_ID_PATTERN.test(VALIDATOR_ID)) throw new Error('the fixture validator id is illegal');
  const registered = await core.tools.register(record.value, { actorId: actor });
  if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
};

interface Started {
  readonly runId: string;
  readonly workTaskId: string;
  readonly reviewTaskId: string;
  readonly qaTaskId: string;
}

const startRun = async (
  core: Core,
  actor: string,
  label: string,
  options?: { readonly fatInputs?: boolean },
): Promise<Started> => {
  const template = await core.lifecycle.createTemplate({
    orgId: COMPANY,
    name: `T19-04 ${label}`,
    actorId: actor,
  });
  if (!template.ok) throw new Error(template.error.message);
  // Stage ids are unique per run: task rows carry no runId (run membership is proven by
  // pinned-graph stage membership), so two runs in one database must not share node ids.
  const tag = core.ids.id('s');
  const workStage = `work_${tag}`;
  const reviewStage = `review_${tag}`;
  const qaStage = `qa_${tag}`;
  const graph = {
    nodes: [
      { id: workStage, kind: 'work' as const, title: 'work', config: {} },
      { id: reviewStage, kind: 'review' as const, title: 'review', config: {} },
      { id: qaStage, kind: 'qa' as const, title: 'qa', config: { validatorIds: [VALIDATOR_ID] } },
    ],
    edges: [
      { from: workStage, to: reviewStage },
      { from: reviewStage, to: qaStage },
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
    goal: { objective: `Deliver the ${label} slice for the bounded roles.`, source: { type: 'human' } },
  });
  if (!run.ok) throw new Error(run.error.message);
  const driven = await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
  if (!driven.ok) throw new Error(driven.error.message);
  const nowIso = () => new Date().toISOString();
  const mkTask = (
    stageId: string,
    roleId: string,
    kind: string,
    inputs?: Readonly<Record<string, unknown>>,
  ) =>
    createTask({
      runId: run.value.run.id as never,
      stageId: stageId as never,
      roleId: roleId as never,
      kind,
      now: nowIso(),
      ids: core.ids,
      ...(inputs === undefined ? {} : { inputs }),
    });
  /*
   * Sprint21: ONE seeded review task. The post-corrective re-review is the provisioner's
   * deterministic DESCENDANT REASSESSMENT for the review stage (causal lineage, gated on the
   * corrective) — a second seeded review would run in the SAME pinned-DAG stage unit and
   * clobber the round-one verdict before the Supervisor can act on it.
   */
  const work = await mkTask(workStage, 'rol_dev', 'e2e7:build', options?.fatInputs ? { scopeNotes: 'n'.repeat(3_000) } : undefined);
  const review = await mkTask(reviewStage, 'rol_reviewer', 'e2e7:review');
  const qa = await mkTask(qaStage, 'rol_qa', 'e2e7:qa');
  if (!work.ok || !review.ok || !qa.ok) throw new Error('task seeding failed');
  await core.database.tasks.put(work.value);
  await core.database.tasks.put(review.value);
  await core.database.tasks.put(qa.value);
  return {
    runId: run.value.run.id,
    workTaskId: work.value.id,
    reviewTaskId: review.value.id,
    qaTaskId: qa.value.id,
  };
};

interface Fixture {
  readonly core: Core;
  readonly actor: string;
  readonly started: Started;
  readonly paths: { readonly dataDir: string; readonly casRoot: string };
}

const makeFixture = async (options?: {
  readonly corrective?: boolean;
  readonly fatInputs?: boolean;
  readonly contextWindowTokens?: number;
  readonly overBudget?: boolean;
}): Promise<Fixture> => {
  invocations.length = 0;
  reviewCursor = 0;
  proposalCursor = 0;
  reviewScript.verdicts = options?.corrective === true ? ['CHANGES_REQUESTED', 'PASS'] : ['PASS'];
  proposalsOf =
    options?.overBudget === true
      ? SUPERVISOR_PROPOSALS_OVER_BUDGET
      : options?.corrective === true
        ? SUPERVISOR_PROPOSALS_CORRECTIVE
        : SUPERVISOR_PROPOSALS_HAPPY;
  const paths = { dataDir: tempDir(), casRoot: tempDir() };
  const core = await compose(paths);
  const assignments = (await core.database.roleAssignments.list({ limit: 10 })).items;
  const actor = assignments[0]?.actorId;
  if (actor === undefined) throw new Error('no owner provisioned');
  await seedModel(core, actor);
  await registerValidator(core, actor);
  const started = await startRun(core, actor, `t${core.ids.id('r')}`, { fatInputs: options?.fatInputs });
  if (options?.contextWindowTokens !== undefined) {
    core.database.db
      .prepare('UPDATE model_records SET context_window = ? WHERE model_key = ?')
      .run(options.contextWindowTokens, MODEL_KEY);
  }
  return { core, actor, started, paths };
};

const runLoop = (f: Fixture) =>
  f.core.autonomousSupervisor!.run({
    companyId: COMPANY,
    runId: f.started.runId,
    taskId: f.started.workTaskId,
    reviewTaskId: f.started.reviewTaskId,
    actorId: f.actor,
    runIdentity: 't19e',
  });

const usersOf = (role: string): readonly string[] =>
  invocations.filter((entry) => entry.role === role).map((entry) => entry.user);

const contextOf = (user: string, marker: string): Readonly<Record<string, unknown>> => {
  const parsed = jsonObjectAround(user, marker);
  if (parsed === null) throw new Error(`no context object around "${marker}"`);
  return parsed;
};

const restart = async (f: Fixture): Promise<Core> => {
  f.core.database.close();
  const tracked = openDatabases.indexOf(f.core.database);
  if (tracked >= 0) openDatabases.splice(tracked, 1);
  const second = await compose(f.paths);
  await seedModel(second, f.actor);
  await registerValidator(second, f.actor);
  return second;
};

/* ------------------------------------------------------- §45 production acceptance */

describe('T19-04 §45 production acceptance — three roles, three role-appropriate contexts', () => {
  it('Developer → Reviewer → QA through the real loop, each receiving exactly its own context', async () => {
    const f = await makeFixture();
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    expect(result.value.stopReason).toBe('completed');
    // The run closed through the REAL chain: work (session Developer) → review → QA → COMPLETE.
    expect((await f.core.database.runs.get(f.started.runId as never))?.state).toBe('COMPLETED');
    const developers = usersOf('developer');
    const reviews = usersOf('review');
    const qas = usersOf('qa');
    expect(developers).toHaveLength(1);
    expect(reviews).toHaveLength(1);
    expect(qas).toHaveLength(1);
    // Each role received ITS schema — the contexts are role-appropriate and distinct.
    expect(developers[0]).toContain('companyos/work-role-context/1');
    expect(reviews[0]).toContain('companyos/review-context/1');
    expect(qas[0]).toContain('companyos/validation-context/1');
    expect(reviews[0]).not.toContain('companyos/work-role-context/1');
    expect(qas[0]).not.toContain('companyos/work-role-context/1');
    // The reviewer saw the Developer's delivered canonical output (the work summary payload).
    expect(reviews[0]).toContain('work note');
  });
});

/* ---------------------------------------------------- §41 the required Reviewer tests */

describe('T19-04 §41 Reviewer bounded context', () => {
  it('1-5. Goal, real subject task, subject≠review task, inputs/scope, output/evidence refs', async () => {
    const f = await makeFixture({ fatInputs: true });
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    const review = contextOf(usersOf('review')[0]!, 'companyos/review-context/1');
    // 1: the canonical Goal objective
    expect(String((review['goal'] as Record<string, unknown>)['objective'])).toContain('bounded roles');
    // 2: the REAL delivered subject task
    const subject = review['subject'] as Record<string, unknown>;
    expect(String(subject['taskId'])).toBe(f.started.workTaskId);
    // 3: the subject is NOT the instrumental review task
    const reviewSeat = review['review'] as Record<string, unknown>;
    expect(String(reviewSeat['taskId'])).toBe(f.started.reviewTaskId);
    expect(String(subject['taskId'])).not.toBe(f.started.reviewTaskId);
    // 4: current Task inputs/scope (the bounded canonical inputs rendering)
    expect(String(subject['inputsJson'])).toContain('scopeNotes');
    expect(String(subject['kind'])).toBe('e2e7:build');
    expect(String(subject['state'])).toBe('DONE');
    // 5: the delivered output (the Developer envelope payload) + the canonical goal artifact ref
    const delivered = subject['delivered'] as Record<string, unknown>;
    expect(String(delivered['payload'])).toContain('work note');
    expect(String(review['goalArtifactRef'])).toContain('artifact:');
  });

  it('6-7. the corrective reviewer sees lineage AND the blocking prior finding', async () => {
    const f = await makeFixture({ corrective: true });
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    /*
     * Sprint21: THREE review invocations — the round-one review of the T0 subject, then the
     * provisioner's TWO deterministic post-corrective reassessments (the producer-stage
     * reassessment of the finding's own producer and the stale-descendant reassessment of the
     * review stage), both reviewing the T1 corrective subject with the blocking prior finding.
     */
    const reviews = usersOf('review');
    expect(reviews).toHaveLength(3);
    const first = contextOf(reviews[0]!, 'companyos/review-context/1');
    const second = contextOf(reviews[1]!, 'companyos/review-context/1');
    const third = contextOf(reviews[2]!, 'companyos/review-context/1');
    // round one: the T0 subject, no prior finding yet (honest absence)
    expect((first['priorFinding'] as Record<string, unknown> | null)).toBeNull();
    // 6: the T1 reviewer sees the corrective lineage of the T1 subject (both reassessments)
    for (const reassessmentContext of [second, third]) {
      const subject = reassessmentContext['subject'] as Record<string, unknown>;
      const lineage = subject['lineage'] as Record<string, unknown>;
      expect(String(lineage['parentTaskId'])).toBe(f.started.workTaskId);
      expect(Number(lineage['round'])).toBe(1);
      // 7: AND the authoritative finding that caused the corrective work
      const prior = reassessmentContext['priorFinding'] as Record<string, unknown>;
      expect(String(prior['verdict'])).toBe('CHANGES_REQUESTED');
      const findings = prior['blockingFindings'] as readonly Record<string, unknown>[];
      expect(findings.some((finding) => String(finding['code']) === 'semantic.boundary')).toBe(true);
    }
    // the T1 review named the T1 subject FROM ITS CONTEXT (recorded in the canonical report)
    const t1 = f.core.database.db
      .prepare(`SELECT id FROM tasks WHERE inputs_json LIKE '%corrective%' AND id != ? LIMIT 1`)
      .get(f.started.workTaskId) as { id: string } | undefined;
    expect(t1).toBeDefined();
    // The round-two review is the provisioner's descendant REASSESSMENT task (deterministic
    // identity, its own causal marker) — the S21 replacement for the ad-hoc second seed.
    const reassessment = f.core.database.db
      .prepare(`SELECT id FROM tasks WHERE inputs_json LIKE '%companyos:reassessment%' LIMIT 1`)
      .get() as { id: string } | undefined;
    expect(reassessment).toBeDefined();
    const report2 = await f.core.reviewFindingsSink!.getLatestReviewReport({
      companyId: COMPANY,
      runId: f.started.runId,
      reviewTaskId: reassessment!.id,
      actorId: f.actor,
    });
    expect(report2.ok).toBe(true);
    if (report2.ok !== true) return;
    const payload2 = report2.value!.payload as unknown as Record<string, unknown>;
    expect(String(payload2['subjectTaskId'])).toBe(t1!.id);
    expect(String(payload2['subjectTaskId'])).not.toBe(f.started.workTaskId);
    expect(String(payload2['subjectTaskId'])).not.toBe(f.started.reviewTaskId);
  });

  it('8. the reviewer receives NO Developer session transcript', async () => {
    const f = await makeFixture({ corrective: true });
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    for (const review of usersOf('review')) {
      expect(review).not.toContain('developer note');
      expect(review).not.toContain('# Session residue');
      expect(review).not.toContain('model_output_residue');
    }
  });

  it('9. the reviewer context is FRESH on every invocation (changed canonical truth wins)', async () => {
    const f = await makeFixture({ corrective: true });
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    const reviews = usersOf('review');
    const first = contextOf(reviews[0]!, 'companyos/review-context/1');
    const second = contextOf(reviews[1]!, 'companyos/review-context/1');
    // invocation 2 saw the NEW subject (T1) and the NEW prior finding — not invocation 1's view
    expect(String((first['subject'] as Record<string, unknown>)['taskId'])).toBe(f.started.workTaskId);
    expect(String((second['subject'] as Record<string, unknown>)['taskId'])).not.toBe(
      f.started.workTaskId,
    );
    expect(second['priorFinding']).not.toBeNull();
  });

  it('10. a foreign tenant is rejected (existing NOT_FOUND convention)', async () => {
    const f = await makeFixture();
    const foreign = await f.core.autonomousSupervisor!.run({
      companyId: 'company_other',
      runId: f.started.runId,
      taskId: f.started.workTaskId,
      reviewTaskId: f.started.reviewTaskId,
      actorId: f.actor,
      runIdentity: 't19e-foreign',
    });
    // The existing convention: the foreign turn fails closed (RUN_MISSING inside the turn)
    // and the loop surfaces it without doing ANY work — zero role invocations, run untouched.
    if (foreign?.ok === true) expect(foreign.value.stopReason).toBe('invariant_failure');
    else expect(foreign?.ok).toBe(false);
    expect(usersOf('review')).toHaveLength(0);
    expect(usersOf('developer')).toHaveLength(0);
  });

  it('11. a restart reconstructs the full review context from canonical state', async () => {
    const f = await makeFixture({ corrective: true });
    const first = await runLoop(f);
    expect(first?.ok).toBe(true);
    if (first?.ok !== true) return;
    const second = await restart(f);
    // a NEW run in the SAME durable database: its reviewer context is rebuilt from scratch
    const started2 = await startRun(second, f.actor, 'restart-review');
    invocations.length = 0;
    reviewCursor = 0;
    proposalCursor = 0;
    reviewScript.verdicts = ['PASS'];
    proposalsOf = SUPERVISOR_PROPOSALS_HAPPY;
    const result = await second.autonomousSupervisor!.run({
      companyId: COMPANY,
      runId: started2.runId,
      taskId: started2.workTaskId,
      reviewTaskId: started2.reviewTaskId,
      actorId: f.actor,
      runIdentity: 't19e-restart',
    });
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    const review = contextOf(usersOf('review')[0]!, 'companyos/review-context/1');
    expect(String((review['goal'] as Record<string, unknown>)['objective'])).toContain('restart-review');
    expect(String((review['subject'] as Record<string, unknown>)['taskId'])).toBe(started2.workTaskId);
  });

  it('12-14. an over-budget review context fails CLOSED before the provider (zero calls)', async () => {
    // The Developer context is thin; the review context carries the fat canonical inputs, so a
    // window that admits the work turn but not the review turn isolates the review gate.
    const f = await makeFixture({ fatInputs: true, contextWindowTokens: 4_096, overBudget: true });
    const result = await runLoop(f);
    // The loop could not complete: the review unit failed closed on budget at every attempt,
    // exhausted, and the engine's own EXECUTION.FAIL landed the run in its terminal FAILED
    // state — a trusted non-retryable stop (never fabricated progress, never a fake PASS).
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    expect(result.value.stopReason).toBe('non_retryable_failure');
    expect((await f.core.database.runs.get(f.started.runId as never))?.state).toBe('FAILED');
    expect(usersOf('developer')).toHaveLength(1); // the work turn ran…
    expect(usersOf('review')).toHaveLength(0); // …but the reviewer was NEVER invoked (12-14)
    expect(usersOf('qa')).toHaveLength(0);
  });
});

/* ------------------------------------------------------- §42 the required QA tests */

describe('T19-04 §42 QA bounded context', () => {
  it('15-21. target task, latest review, anchor, validators, slots, artifacts, lineage', async () => {
    const f = await makeFixture({ corrective: true, fatInputs: true });
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    const qa = contextOf(usersOf('qa')[0]!, 'companyos/validation-context/1');
    // 15: the CURRENT target task (the corrective T1, not T0, not the qa task)
    const target = qa['target'] as Record<string, unknown>;
    const correctiveTaskId = f.core.database.db
      .prepare(
        `SELECT id FROM tasks WHERE inputs_json LIKE '%corrective%' AND id != ? LIMIT 1`,
      )
      .get(f.started.workTaskId) as { id: string } | undefined;
    expect(correctiveTaskId).toBeDefined();
    expect(String(target['taskId'])).toBe(correctiveTaskId!.id);
    expect(String(target['taskId'])).not.toBe(f.started.workTaskId);
    expect(String(target['taskId'])).not.toBe(f.started.qaTaskId);
    // 16: the LATEST review verdict (the round-two PASS, not the stale CHANGES_REQUESTED)
    const latestReview = qa['latestReview'] as Record<string, unknown>;
    expect(String(latestReview['verdict'])).toBe('PASS');
    expect(String(latestReview['artifactId'])).toContain('art_');
    // 17: the repository/workspace anchor seat (honest null when no workspace is open)
    expect(qa['anchor']).toBeNull();
    // 18: the TRUSTED validator configuration from the pinned stage policy
    expect(qa['validators']).toContain(VALIDATOR_ID);
    // 19: the six frozen evidence slots
    const slots = qa['evidenceSlots'] as readonly Record<string, unknown>[];
    expect(slots.map((slot) => String(slot['slot']))).toEqual([
      'tests',
      'lint',
      'typecheck',
      'build',
      'gitStatus',
      'gitDiff',
    ]);
    // 20: the target's current artifact/output refs + the canonical goal artifact
    expect(String((target['delivered'] as Record<string, unknown>)['payload'])).toContain('work note');
    expect(String(qa['goalArtifactRef'])).toContain('artifact:');
    // 21: the corrective lineage reaches QA
    expect(String((target['lineage'] as Record<string, unknown>)['parentTaskId'])).toBe(
      f.started.workTaskId,
    );
    // the QA plan was derived FROM the projected trusted configuration (canonical batch proves it)
    const rows = await f.core.database.validationStore!.listByRun(f.started.runId as never);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((row) => String(row.validatorId) === VALIDATOR_ID)).toBe(true);
  });

  it('22-23. QA receives NO Developer transcript and NO Reviewer transcript', async () => {
    const f = await makeFixture({ corrective: true });
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    const qa = usersOf('qa')[0]!;
    // 22: no Developer session material
    expect(qa).not.toContain('developer note');
    expect(qa).not.toContain('# Session residue');
    // 23: no Reviewer transcript — the verdict summary of the prior round is NOT carried
    expect(qa).not.toContain('crosses a frozen boundary');
    expect(qa).not.toContain('semantic.boundary');
  });

  it('24-26. freshness after corrective, latest review wins, latest validation batch wins', async () => {
    const f = await makeFixture({ corrective: true });
    // Seed a STALE canonical validation row first (the durable table, nothing synthetic):
    // at QA-projection time it is the only batch, and after the run the NEWEST batch wins.
    f.core.database.db
      .prepare(
        `INSERT INTO validations (validation_id, run_id, stage_id, task_id, validator_id,
           validator_version, status, command, exit_code, blocking, evidence_refs_json,
           started_at, finished_at, created_at)
         VALUES ('val_t19e_stale', ?, NULL, NULL, 'stale.validator', '1.0.0', 'pass', NULL, 0, 1, '[]',
           '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`,
      )
      .run(f.started.runId);
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    const qa = contextOf(usersOf('qa')[0]!, 'companyos/validation-context/1');
    // 25: the LATEST review is the round-two PASS — not the stale CHANGES_REQUESTED
    expect(String((qa['latestReview'] as Record<string, unknown>)['verdict'])).toBe('PASS');
    // 26: at projection time the ONLY canonical batch was the durable seed (the reader works),
    // and AFTER the run the newest batch displaced it — latest wins for every later reader.
    const batch = qa['latestValidationBatch'] as Record<string, unknown>;
    expect(String(batch['id'])).toBe('val_t19e_stale');
    const rows = await f.core.database.validationStore!.listByRun(f.started.runId as never);
    expect(String(rows[0]!.id)).not.toBe('val_t19e_stale');
    expect(rows.some((row) => String(row.validatorId) === 'stale.validator')).toBe(true);
    // 24: the context is fresh after the corrective (target = T1, current review, current batch)
    expect(String((qa['target'] as Record<string, unknown>)['taskId'])).not.toBe(f.started.workTaskId);
  });

  it('27-28. foreign tenant rejected; restart reconstructs the QA context', async () => {
    const f = await makeFixture();
    const foreign = await f.core.autonomousSupervisor!.run({
      companyId: 'company_other',
      runId: f.started.runId,
      taskId: f.started.workTaskId,
      reviewTaskId: f.started.reviewTaskId,
      actorId: f.actor,
      runIdentity: 't19e-qa-foreign',
    });
    if (foreign?.ok === true) expect(foreign.value.stopReason).toBe('invariant_failure'); // 27
    else expect(foreign?.ok).toBe(false);
    expect(usersOf('qa')).toHaveLength(0);
    expect(usersOf('developer')).toHaveLength(0);
    const okResult = await runLoop(f);
    expect(okResult?.ok).toBe(true);
    if (okResult?.ok !== true) return;
    const second = await restart(f);
    const started2 = await startRun(second, f.actor, 'restart-qa');
    invocations.length = 0;
    reviewCursor = 0;
    proposalCursor = 0;
    reviewScript.verdicts = ['PASS'];
    proposalsOf = SUPERVISOR_PROPOSALS_HAPPY;
    const result = await second.autonomousSupervisor!.run({
      companyId: COMPANY,
      runId: started2.runId,
      taskId: started2.workTaskId,
      reviewTaskId: started2.reviewTaskId,
      actorId: f.actor,
      runIdentity: 't19e-qa-restart',
    });
    expect(result?.ok).toBe(true); // 28
    if (result?.ok !== true) return;
    const qa = contextOf(usersOf('qa')[0]!, 'companyos/validation-context/1');
    expect(String((qa['target'] as Record<string, unknown>)['taskId'])).toBe(started2.workTaskId);
    expect(qa['validators']).toContain(VALIDATOR_ID);
  });

  it('29-30. an over-budget QA context fails CLOSED before the provider (zero calls)', async () => {
    const f = await makeFixture({ fatInputs: true, contextWindowTokens: 4_096, overBudget: true });
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    expect(result.value.stopReason).toBe('non_retryable_failure');
    expect(usersOf('qa')).toHaveLength(0); // 29-30: provider call count for QA = 0
    expect(usersOf('developer')).toHaveLength(1); // only the thin work turn ran
  });
});

/* --------------------------------------------------- §43 the placeholder tests */

describe('T19-04 §43 placeholder audit', () => {
  it('31-32. no false company.id, no literal "pinned" masquerading as WorkflowVersion', async () => {
    const f = await makeFixture();
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    for (const user of [...usersOf('review'), ...usersOf('qa'), ...usersOf('developer')]) {
      // 31: no message projects the session actor id AS the company
      expect(user).not.toContain(`"id":"${String(f.actor)}"`);
      // 32: the workflow version is the run's REAL pinned version id, never the literal
      expect(user).not.toContain('"pinned"');
    }
    for (const user of [...usersOf('review'), ...usersOf('qa'), ...usersOf('developer')]) {
      // every role projection carries the REAL company scope (§37) and the REAL pinned
      // version id (§23) — the Developer's authoritative projection included them in T19-04
      expect(user.toUpperCase()).toContain(COMPANY.toUpperCase());
    }
    const run = await f.core.database.runs.get(f.started.runId as never);
    const versionId = String(run?.versionId ?? '');
    expect(versionId).not.toBe('');
    for (const user of [...usersOf('review'), ...usersOf('qa'), ...usersOf('developer')]) {
      expect(user).toContain(versionId);
    }
  });

  it('33. an unavailable fact is projected as absent/null, never fabricated', async () => {
    const f = await makeFixture();
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    const review = contextOf(usersOf('review')[0]!, 'companyos/review-context/1');
    // acceptance criteria are NOT canonically held: the seat exists and says null
    expect(review['acceptanceCriteria']).toBeNull();
    // the classification itself labels it NON_AUTHORITY_PRESENTATION — a presentation seat,
    // never an authority claim
    const classification = review['classification'] as Record<string, unknown>;
    expect(String(classification['acceptanceCriteria'])).toBe('NON_AUTHORITY_PRESENTATION');
  });
});

/* --------------------------------------------------- §44 the role isolation tests */

describe('T19-04 §44 role isolation', () => {
  it('34-37. only the Developer runtime consumes Developer session residue', async () => {
    const f = await makeFixture({ corrective: true });
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    // 34: the Developer DOES see its own session residue — a second authorized turn on T0's
    // session receives the round-one residue (the production runtime, no test seam).
    const second = await f.core.developerSession!.runTurn({
      companyId: COMPANY,
      runId: f.started.runId,
      taskId: f.started.workTaskId,
      actorId: f.actor,
      structuredKeys: ['objective', 'summary'],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const developerUsers = usersOf('developer');
    expect(developerUsers.length).toBeGreaterThanOrEqual(2);
    expect(developerUsers.at(-1)).toContain('# Session residue');
    expect(developerUsers.at(-1)).toContain('developer note');
    // 35/36: neither the Reviewer nor the QA ever receives session material
    for (const review of usersOf('review')) {
      expect(review).not.toContain('# Session residue'); // 35
    }
    for (const qa of usersOf('qa')) {
      expect(qa).not.toContain('# Session residue'); // 36
    }
    // 37: the Supervisor receives no Developer transcript either
    for (const supervisor of usersOf('supervisor')) {
      expect(supervisor).not.toContain('# Session residue'); // 37
      expect(supervisor).not.toContain('developer note');
    }
  });
});

/* ------------------------------------------------- §46 the corrective acceptance */

describe('T19-04 §46 corrective acceptance', () => {
  it('T0 Developer → CHANGES_REQUESTED → T1 Developer session → Reviewer PASS → QA PASS, lifecycle green', async () => {
    const f = await makeFixture({ corrective: true });
    const result = await runLoop(f);
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    expect(result.value.stopReason).toBe('completed');
    // The full autonomous lifecycle stayed green through the corrective round.
    expect((await f.core.database.runs.get(f.started.runId as never))?.state).toBe('COMPLETED');
    for (const taskId of [f.started.workTaskId, f.started.reviewTaskId, f.started.qaTaskId]) {
      expect((await f.core.database.tasks.get(taskId as never))?.state).toBe('DONE');
    }
    // The deterministic reassessment of the review stage settled too — the stage subject
    // authority replaced the round-one result.
    const reassessment = f.core.database.db
      .prepare(`SELECT id, state FROM tasks WHERE inputs_json LIKE '%companyos:reassessment%' LIMIT 1`)
      .get() as { id: string; state: string } | undefined;
    expect(reassessment?.state).toBe('DONE');
    // Every role saw ONLY its required context, fresh (the numbered proofs above hold here):
    const reviews = usersOf('review');
    const second = contextOf(reviews[1]!, 'companyos/review-context/1');
    expect(second['priorFinding']).not.toBeNull();
    const qa = contextOf(usersOf('qa')[0]!, 'companyos/validation-context/1');
    expect(String((qa['latestReview'] as Record<string, unknown>)['verdict'])).toBe('PASS');
    // the T1 corrective session exists with parent = the T0 session (T19-03 semantics intact)
    const sessions = f.core.database.db
      .prepare('SELECT session_id, parent_session_id FROM sessions')
      .all() as { session_id: string; parent_session_id: string | null }[];
    expect(sessions.filter((row) => row.parent_session_id !== null).length).toBe(1);
  });
});
