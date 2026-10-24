/**
 * Sprint 18 / Task-18-07 corrective — production E2E through `composeCoreServices`
 * (§52: full happy path and full corrective path with ZERO manual review/validation
 * transition injection).
 *
 * The chain runs on the REAL production composition entry: Run + Goal + Snapshot + pinned
 * bindings, the real engine, the real T18-06 supervisor turn, the real decision sink, the real
 * carrier (Task.outputs → canonical Review/Validation sink), the real evidence applicator and
 * the real corrective provisioner. The model is the deterministic in-process fake registered
 * through the real provider registry — there is NO live model API.
 *
 * What makes these paths REAL rather than scripted: the review and QA stages are executed by
 * agent-backed handlers that resolve their model from the run's pinned snapshot, produce a
 * bounded structured outcome, and let the trusted carrier route it into the canonical sink.
 * The Run lifecycle then advances on that canonical evidence — never on a test-issued command.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/*
 * E1 GATE FIX — hermetic fixture (P3 TEST_ENV_HERMETICITY): this machine may carry a
 * user-level live model env; composeCoreServices self-registers the OpenAI-compatible
 * adapter whenever COS_MODEL_BASE_URL + COS_MODEL_ID resolve (core-services, Boss V1
 * Product Reachability BB-002 seam). Without the scrub that unrelated live provider
 * registers inside THIS fixture (and registration performs a real listModels call),
 * which both breaks the provider-count invariants and leaks the user's configuration.
 * Same canonical LIVE_ENV_KEYS scrub the production/FIX-09-pattern tests use.
 */
const LIVE_ENV_KEYS = [
  'COS_MODEL_BASE_URL', 'COS_MODEL_ID', 'COS_MODEL_PROVIDER_ID', 'COS_MODEL_TIMEOUT_MS', 'COMPANYOS_MODEL_API_KEY',
  'COS_MODEL_ROUTING_MODE', 'COS_MODEL_ROUTING_POLICY',
  'COS_MODEL_QUALITY_TIER', 'COS_MODEL_COST_TIER', 'COS_MODEL_LATENCY_TIER', 'COS_MODEL_RELIABILITY_CLASS',
  'COS_MODEL_AUTHENTICATION',
  'COMPANYOS_EXECUTOR_PROVIDER',
] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => { for (const key of LIVE_ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; } });
afterAll(() => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });


import {
  createTask,
  createToolRecord,
  descendantReassessmentTaskIdOf,
  ok,
  reassessmentTaskIdOf,
  runGoalCommandId,
  TOOL_CAPABILITY_VALIDATOR,
  TOOL_ID_PATTERN,
  type DomainError,
  type ModelProviderPort,
  type Result,
  type ToolPort,
} from '@companyos/core';
import { SUPERVISOR_PROPOSAL_SCHEMA } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';

const created: string[] = [];
const openDatabases: DurableDatabase[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18e2e7b-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

let seq = 0;
const nowIso = (): string =>
  new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
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
] as const;
const COMPANY = 'company_default';
const SUPERVISOR_BINDING = 'supervisor';
const PROVIDER_ID = 'prov_e2e7';
const MODEL_KEY = 'e2e7.supervisor';
const PROVIDER_MODEL_ID = 'e2e7-model-1';
const CATALOGUE = [
  {
    modelId: PROVIDER_MODEL_ID,
    displayName: PROVIDER_MODEL_ID,
    contextWindow: 8_192,
    capabilities: { streaming: false, structuredOutput: true }
  },
];

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

/**
 * A REAL legal validator, constructed and registered through the SAME production seam
 * CompanyOS uses: the composition's trusted tool-port binding (exactly how the repository
 * runtime's tools enter) plus the production tool registry's own registration. Nothing here
 * fabricates a validation row or a verdict — the canonical ValidationService resolves this
 * record, invokes this adapter through the Tool Registry, and materializes the report this
 * adapter returns. The adapter is scriptable ONLY in its verdict, like any deterministic
 * in-process tool.
 */
const VALIDATOR_ID = 'e2e7.unit_validator';
const VALIDATOR_VERSION = '1.0.0';
const VALIDATOR_REPORT_KIND = 'companyos:validator-report';

/** The mutable verdict script of the validator adapter (a tool may be deterministic per call). */
const validatorScript: { verdicts: ('pass' | 'fail')[] } = { verdicts: ['pass'] };

const createValidatorPort = (): ToolPort => ({
  describe: () => ({
    toolId: VALIDATOR_ID,
    name: 'unit validator',
    description: 'Deterministic in-process unit validator (E2E fixture).',
    version: VALIDATOR_VERSION,
    capabilities: [TOOL_CAPABILITY_VALIDATOR],
    riskLevel: 'LOW',
    parameters: { type: 'object', additionalProperties: true },
  }),
  async invoke(request) {
    const verdict = validatorScript.verdicts[0] ?? 'pass';
    const finishedAt = nowIso();
    return ok({
      status: 'ok' as const,
      output: {
        verdict,
        evidenceRefs: [`command:${VALIDATOR_ID}:${request.idempotencyKey ?? 'once'}`],
        report: {
          kind: VALIDATOR_REPORT_KIND,
          label: `${VALIDATOR_ID} report`,
          content: JSON.stringify({ validatorId: VALIDATOR_ID, verdict }),
        },
      },
      artifactRefs: [],
      startedAt: finishedAt,
      finishedAt,
      latencyMs: 1,
    });
  },
});

const registerValidator = async (core: Core, actor: string): Promise<void> => {
  const record = createToolRecord({
    toolId: VALIDATOR_ID,
    name: 'unit validator',
    description: 'Deterministic in-process unit validator (E2E fixture).',
    version: VALIDATOR_VERSION,
    capabilities: [TOOL_CAPABILITY_VALIDATOR],
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true },
    riskLevel: 'LOW',
    requiredAuthorities: ['tool.invoke'],
    idempotencyMode: 'IDEMPOTENT_KEY',
    adapterRef: VALIDATOR_ID,
    now: nowIso(),
  });
  if (!record.ok) throw new Error(record.error.message);
  if (!TOOL_ID_PATTERN.test(VALIDATOR_ID)) throw new Error('the fixture validator id is illegal');
  const registered = await core.tools.register(record.value, { actorId: actor });
  if (!registered.ok && registered.error.code !== 'CONFLICT') {
    throw new Error(registered.error.message);
  }
};

const compose = async (paths?: {
  readonly dataDir: string;
  readonly casRoot: string;
}): Promise<Core> => {
  const dataDir = paths?.dataDir ?? tempDir();
  const casRoot = paths?.casRoot ?? tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({
    casRoot,
    database: db,
    logger: nullLogger as never,
  });
  if (!foundation.ok) throw new Error(`artifact foundation failed: ${foundation.error.message}`);
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    // Trusted configuration: which task kinds the agent-backed review/QA handlers serve.
    stageHandlers: { reviewKinds: ['e2e7:review'], qaKinds: ['e2e7:qa'] },
    // Trusted configuration: the validator's adapter binding, through the production seam.
    toolPorts: new Map<string, ToolPort>([[VALIDATOR_ID, createValidatorPort()]]),
  });
  if (core === null) throw new Error('production composition failed');
  return core;
};

const sessionActorOf = async (core: Core): Promise<string> => {
  const assignments = (await core.database.roleAssignments.list({ limit: 10 })).items;
  const actor = assignments[0]?.actorId;
  if (actor === undefined) throw new Error('the production composition provisioned no owner');
  return actor;
};

/**
 * The FIRST JSON object at or after `from` in `text`, with string awareness (a brace inside a
 * string is not a nesting level). Returns null when the text carries none.
 */
const firstJsonObjectAt = (text: string, from: number): Readonly<Record<string, unknown>> | null => {
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

/**
 * The Supervisor context this invocation was given, read from the invocation's own memory view
 * exactly the way a real model reads it. A scripted answer therefore never has to name the
 * subject task: the model derives it from its context, and cites the evidence refs that context
 * carries. That is what keeps these paths real when the supervisor's subject changes with the
 * work unit (a review turn, a corrective turn) instead of being fixed at the run's start.
 */
const supervisorContextOf = (
  request: Parameters<NonNullable<ModelProviderPort['invoke']>>[0],
): Readonly<Record<string, unknown>> | null => {
  for (const message of request.messages) {
    if (message.role !== 'user') continue;
    const seat = message.content.indexOf('# Memory view');
    if (seat < 0) continue;
    return firstJsonObjectAt(message.content, seat);
  }
  return null;
};

const stringAt = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

/** The context refs of one kind, as the canonical ref strings a proposal may cite. */
const contextRefsOf = (
  context: Readonly<Record<string, unknown>>,
  kind: string,
): readonly string[] => {
  const refs = context['refs'];
  if (!Array.isArray(refs)) return [];
  return refs
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null))
    .filter((entry): entry is Readonly<Record<string, unknown>> => entry !== null)
    .filter((entry) => entry['kind'] === kind)
    .map((entry) => stringAt(entry['id']))
    .filter((id): id is string => id !== null)
    .map((id) => (kind === 'review' ? `artifact:${id}` : id));
};

/**
 * A deterministic fake provider whose answer depends on WHICH structured contract was asked,
 * so the ordering of supervisor turns and agent-backed handler rounds cannot desynchronize the
 * script. NO live model API: this is an in-process adapter registered through the real
 * provider registry, exactly like the mock adapter.
 */
/** The mutable script of the routing model (filled in after the run's tasks exist). */
const routingScript: {
  proposals: readonly Readonly<Record<string, unknown>>[];
  /** One entry per review round, consumed in order (the last repeats): a corrective round's
   * second review may legitimately PASS after the first requested changes. */
  reviewOutcomes: readonly Readonly<Record<string, unknown>>[];
  qaOutcome: Readonly<Record<string, unknown>>;
  /** Consumption cursors, RESET by installScript: a newly scripted dialogue starts at its
   * first proposal regardless of what earlier dialogues consumed. */
  proposalIndex: number;
  reviewIndex: number;
  /** The subject the LAST proposal turn anchored on — the review of the unit that ran after
   *  it targets the durable work (Sprint21: the subject advances to each new corrective). */
  lastSubjectTaskId: string | null;
} = { proposals: [], reviewOutcomes: [], qaOutcome: {}, proposalIndex: 0, reviewIndex: 0, lastSubjectTaskId: null };

const createRoutingProvider = (): ModelProviderPort => {
  return {
    describe: () => ({
      providerId: PROVIDER_ID,
      kind: 'fake',
      displayName: 'Routing model',
      version: '1.0.0',
    }),
    listModels: () => Promise.resolve(ok(CATALOGUE)),
    health: () => Promise.resolve(ok(undefined as never)),
    invoke(request) {
      const properties =
        (request.responseFormat?.schema as { properties?: Record<string, unknown> } | undefined)
          ?.properties ?? {};
      let structured: unknown;
      if ('verdict' in properties) {
        const reviewOutcome =
          routingScript.reviewOutcomes[
            Math.min(routingScript.reviewIndex, routingScript.reviewOutcomes.length - 1)
          ] ?? {};
        routingScript.reviewIndex += 1;
        // The review targets the durable work the last turn anchored on (the immediate
        // corrective advances the subject); an explicitly pinned subjectTaskId still wins.
        const pinned = reviewOutcome['subjectTaskId'];
        structured = {
          schema: SUPERVISOR_PROPOSAL_SCHEMA,
          ...reviewOutcome,
          ...(pinned === undefined && routingScript.lastSubjectTaskId !== null
            ? { subjectTaskId: routingScript.lastSubjectTaskId }
            : {}),
        };
      } else if ('targetRef' in properties) {
        structured = { schema: SUPERVISOR_PROPOSAL_SCHEMA, ...routingScript.qaOutcome };
      } else {
        const scripted =
          routingScript.proposals[
            Math.min(routingScript.proposalIndex, routingScript.proposals.length - 1)
          ] ?? {};
        routingScript.proposalIndex += 1;
        // The supervisor script carries WHAT is decided; the subject and the cited evidence come
        // from the context this invocation actually received, like any model that read it.
        const context = supervisorContextOf(request);
        const subjectTaskId =
          context === null ? null : stringAt((context['subject'] as Record<string, unknown>)['taskId']);
        // The next executed unit reviews the subject THIS turn anchored on.
        if (subjectTaskId !== null) routingScript.lastSubjectTaskId = subjectTaskId;
        const evidenceRefs =
          Array.isArray(scripted['evidenceRefs']) && scripted['evidenceRefs'].length > 0
            ? scripted['evidenceRefs']
            : context === null
              ? []
              : scripted['action'] === 'COMPLETE' || scripted['reasonCode'] === 'VALIDATION_FAILED'
                ? contextRefsOf(context, 'validation')
                : contextRefsOf(context, 'review');
        structured = {
          schema: SUPERVISOR_PROPOSAL_SCHEMA,
          ...scripted,
          ...(subjectTaskId === null ? {} : { subject: { taskId: subjectTaskId } }),
          evidenceRefs,
        };
      }
      return Promise.resolve(
        ok({
          modelId: request.modelId,
          providerId: PROVIDER_ID,
          outputText: 'routed',
          structured,
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
  };
};

/**
 * Register the deterministic routing model and install its script. Called BEFORE the run is
 * created (so the run can pin it) — the script itself is installed after the tasks exist.
 */
const seedRoutingModel = async (core: Core, actor: string): Promise<void> => {
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

/**
 * Register the routing provider/model and report HOW the provider landed: `registered` (first
 * time in this storage) or `rebound` (an idempotent restart re-attachment of the same
 * descriptor).
 */
const seedRoutingModelReturning = async (
  core: Core,
  actor: string,
): Promise<'registered' | 'rebound'> => {
  // A provider that is not bound in THIS process but answers registration successfully can
  // only have come back through the restart path: first registration binds eagerly, and an
  // incompatible adapter is refused.
  const boundBefore = core.providers.get(PROVIDER_ID) !== null;
  const provider = await core.providers.register(createRoutingProvider(), { actorId: actor });
  if (!provider.ok) throw new Error(provider.error.message);
  const model = await core.models.registerFromProvider({
    providerId: PROVIDER_ID,
    providerModelId: PROVIDER_MODEL_ID,
    modelKey: MODEL_KEY,
    actorId: actor,
  });
  if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
  return boundBefore ? 'registered' : 'rebound';
};

/** Install the routing script once the run's task identities are known. */
const installScript = (input: {
  readonly proposals: readonly Readonly<Record<string, unknown>>[];
  readonly reviewOutcomes: readonly Readonly<Record<string, unknown>>[];
  readonly qaOutcome?: Readonly<Record<string, unknown>>;
}): void => {
  routingScript.proposals = input.proposals;
  routingScript.reviewOutcomes = input.reviewOutcomes;
  routingScript.qaOutcome = input.qaOutcome ?? {};
  routingScript.proposalIndex = 0;
  routingScript.reviewIndex = 0;
  routingScript.lastSubjectTaskId = null;
};

interface Started {
  readonly runId: string;
  readonly workTaskId: string;
  readonly reviewTaskId: string;
  /** Null for graphs without a QA node (the gate graphs the T18-07 batch tests park in). */
  readonly qaTaskId: string | null;
}

/**
 * The graph variants the T18-07 family exercises:
 *  - 'qa' (default): work → review → qa, the QA node declares the gate's required validators.
 *  - 'review-validated': work → review, the REVIEW node declares the required validators — the
 *    S21 parking shape for the latest-batch rule: the run reaches VALIDATING canonically (every
 *    stage terminal) and stops there with the test's own batches as the only durable rows.
 *  - 'plain': work → review with no declared validator requirements anywhere — the run parks in
 *    VALIDATING on the frozen gate's refusal to fake a PASS (a safe human stop, zero rows).
 */
type GraphVariant = 'qa' | 'review-validated' | 'plain';

const startRun = async (
  core: Core,
  actor: string,
  label: string,
  variant: GraphVariant = 'qa',
): Promise<Started> => {
  const template = await core.lifecycle.createTemplate({
    orgId: COMPANY,
    name: `E2E ${label}`,
    actorId: actor,
    traceId: `t18e7b_tpl_${label}`,
  });
  if (!template.ok) throw new Error(template.error.message);
  /*
   * The validator requirement is a GRAPH FACT, never a stage class: whichever node declares
   * `validatorIds` in its PINNED config is the one the frozen evidence gate reads its required
   * validators from — the evidence applicator's read and the engine's own gate policy then
   * agree on one authority (R1-B).
   */
  const reviewConfig = variant === 'review-validated' ? { validatorIds: [VALIDATOR_ID] } : {};
  const graph = {
    nodes: [
      { id: 'work', kind: 'work' as const, title: 'work', config: {} },
      { id: 'review', kind: 'review' as const, title: 'review', config: reviewConfig },
      ...(variant === 'qa'
        ? [
            {
              id: 'qa',
              kind: 'qa' as const,
              title: 'qa',
              config: { validatorIds: [VALIDATOR_ID] },
            },
          ]
        : []),
    ],
    edges: [
      { from: 'work', to: 'review' },
      ...(variant === 'qa' ? [{ from: 'review', to: 'qa' }] : []),
    ],
  };
  const saved = await core.lifecycle.saveDraftGraph({
    templateId: template.value.id,
    graph,
    actorId: actor,
    traceId: `t18e7b_graph_${label}`,
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({
    templateId: template.value.id,
    actorId: actor,
    traceId: `t18e7b_pub_${label}`,
  });
  if (!published.ok) throw new Error(published.error.message);
  const run = await core.lifecycle.createRun({
    templateId: template.value.id,
    companyId: COMPANY,
    workflowId: `wf_${label}`,
    actorId: actor,
    modelBindings: { [SUPERVISOR_BINDING]: MODEL_KEY },
    goal: { objective: `Deliver the ${label} slice.`, source: { type: 'human' } },
  });
  if (!run.ok) throw new Error(run.error.message);
  const driven = await core.sprint13.engine.drive(run.value.run.id, { maxSteps: 8 });
  if (!driven.ok) throw new Error(driven.error.message);
  if (driven.value.run.state !== 'EXECUTING')
    throw new Error(`the engine left the run in ${driven.value.run.state}`);

  const work = await createTask({
    runId: run.value.run.id as never,
    stageId: 'work' as never,
    roleId: 'rol_dev' as never,
    kind: 'e2e7:build',
    now: nowIso(),
    ids: core.ids,
  });
  const review = await createTask({
    runId: run.value.run.id as never,
    stageId: 'review' as never,
    roleId: 'rol_reviewer' as never,
    kind: 'e2e7:review',
    now: nowIso(),
    ids: core.ids,
  });
  /*
   * Sprint21: there is NO second seeded review task. The post-corrective re-review is the
   * provisioner's deterministic DESCENDANT REASSESSMENT for the review stage (causal lineage,
   * causally ineligible until the corrective is DONE) — the S21 replacement for the ad-hoc
   * round-two seed, which under the pinned-DAG unit rule would otherwise run in the SAME stage
   * unit as the round-one review and clear its finding before the model can act on it.
   */
  const qa =
    variant === 'qa'
      ? await createTask({
          runId: run.value.run.id as never,
          stageId: 'qa' as never,
          roleId: 'rol_qa' as never,
          kind: 'e2e7:qa',
          now: nowIso(),
          ids: core.ids,
        })
      : null;
  if (!work.ok || !review.ok || (variant === 'qa' && !qa?.ok)) throw new Error('task seeding failed');
  await core.database.tasks.put(work.value);
  await core.database.tasks.put(review.value);
  if (qa?.ok === true) await core.database.tasks.put(qa.value);
  return {
    runId: run.value.run.id,
    workTaskId: work.value.id,
    reviewTaskId: review.value.id,
    qaTaskId: qa?.ok === true ? qa.value.id : null,
  };
};

const taskState = async (core: Core, taskId: string): Promise<string> => {
  const task = await core.database.tasks.get(taskId as never);
  return task?.state ?? 'MISSING';
};

/**
 * The run's own durable goal artifact, by the command that created it. The QA candidate names a
 * REAL artifact of this run as its validation target (the canonical target ref grammar admits
 * nothing else) — never a placeholder id.
 */
const goalArtifactRefOf = async (core: Core, runId: string): Promise<string> => {
  const store = core.database.artifactStore;
  if (store === null) throw new Error('the production composition has no artifact store');
  const found = await store.getByCreationCommand(runGoalCommandId(runId));
  if (found === null) throw new Error(`run "${runId}" pins no goal artifact`);
  return `artifact:${found.artifact.id}`;
};

describe('T18-07 corrective — production happy path (§21)', () => {
  it('Goal → work → review PASS → VALIDATING → QA PASS → FINALIZING → COMPLETE → COMPLETED', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    // A REAL legal validator enters through the production seam (§14): the composition's
    // trusted tool-port binding plus the production tool registry's own registration.
    await registerValidator(core, actor);
    validatorScript.verdicts.length = 0;
    validatorScript.verdicts.push('pass');
    const started = await startRun(core, actor, 'happy8');
    const { runId, workTaskId } = started;
    const QA_TARGET = await goalArtifactRefOf(core, runId);
    installScript({
      proposals: [
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review.' },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the QA.' },
        { action: 'COMPLETE', reasonCode: 'GOAL_SATISFIED', summary: 'The objective is delivered.' }
      ],
      reviewOutcomes: [{
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'Reviewer pass.',
        verdict: 'PASS',
        subjectTaskId: workTaskId,
        findings: []
      }],
      qaOutcome: {
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'QA pass.',
        targetRef: QA_TARGET,
        validators: [{ validatorId: VALIDATOR_ID, blocking: true }]
      },
    });

    const result = await core.autonomousSupervisor?.run({
      companyId: COMPANY,
      runId,
      taskId: workTaskId,
      reviewTaskId: started.reviewTaskId,
      actorId: actor,
      runIdentity: 'happy8',
    });
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;

    // The chain is REAL end to end: the engine executed the work unit, the pinned review agent
    // produced the canonical findings, the pinned QA agent produced the canonical validation,
    // and the run closed on the supervisor's OWN COMPLETE — no manual lifecycle dispatch, no
    // manual validation insertion, no synthetic PASS anywhere in this file.
    expect(result.value.stopReason).toBe('completed');
    expect(result.value.applied[0]?.effect.startsWith('stage:work:')).toBe(true);
    expect(result.value.applied.some((entry) => entry.effect.startsWith('stage:review:'))).toBe(true);
    expect(result.value.applied.some((entry) => entry.effect.startsWith('stage:qa:'))).toBe(true);
    expect(result.value.applied.at(-1)?.action).toBe('COMPLETE');
    expect(await taskState(core, workTaskId)).toBe('DONE');
    expect(await taskState(core, started.reviewTaskId)).toBe('DONE');
    expect(await taskState(core, started.qaTaskId!)).toBe('DONE');
    const run = await core.database.runs.get(runId as never);
    expect(run?.state).toBe('COMPLETED');

    /* ---- §25: the durable QA evidence carries the REAL identities, nothing synthetic ---- */
    const rows = await core.database.validationStore!.listByRun(runId as never);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    expect(row.runId).toBe(runId);
    expect(row.taskId).toBe(started.qaTaskId);
    expect(row.stageId).toBe('qa');
    expect(row.validatorId).toBe(VALIDATOR_ID);
    expect(row.validatorVersion).toBe(VALIDATOR_VERSION);
    expect(row.status).toBe('pass');
    expect(row.targetRef).toBe(QA_TARGET);
    expect(row.blocking).toBe(true);
    // The validator's canonical REPORT materialized through the real ArtifactService, and its
    // provenance is the validator identity — never the session user (§15).
    const reports = (await core.database.artifactStore!.listByRun(runId as never)).filter(
      (artifact) => artifact.kind === VALIDATOR_REPORT_KIND,
    );
    expect(reports.length).toBe(1);
    expect(reports[0]!.producedBy).toBe(`validator:${VALIDATOR_ID}@${VALIDATOR_VERSION}`);
    // The invocation that ran the validator was authorized as the SESSION actor: provenance and
    // authorization stayed two different concepts on one operation.
    const invocation = await core.database.toolInvocations!.get(
      (core.database.db
        .prepare('SELECT id FROM tool_invocations WHERE tool_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(VALIDATOR_ID) as { id: string }).id as never,
    );
    expect(invocation?.actorId).toBe(actor);
  });
});

describe('T18-07 corrective — production corrective path (§52/42)', () => {
  it('Reviewer CHANGES_REQUESTED → canonical artifact → automatic REWORK → REQUEST_CORRECTIVE → one T1 → COMPLETE', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    validatorScript.verdicts.length = 0;
    validatorScript.verdicts.push('pass');
    const started = await startRun(core, actor, 'corrective8');
    const { runId, workTaskId } = started;
    const QA_TARGET = await goalArtifactRefOf(core, runId);
    installScript({
      proposals: [
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review.' },
        {
          action: 'REQUEST_CORRECTIVE',
          reasonCode: 'REVIEW_FINDING',
          summary: 'The reviewer requires corrective work.'
        },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the round-two review.' },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the QA.' },
        { action: 'COMPLETE', reasonCode: 'GOAL_SATISFIED', summary: 'Delivered.' },
      ],
      // Round one requests changes; the round-two review (after the corrective work) passes.
      reviewOutcomes: [
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Reviewer requests changes.',
          verdict: 'CHANGES_REQUESTED',
          subjectTaskId: workTaskId,
          findings: [
            {
              code: 'semantic.boundary',
              summary: 'Crosses a frozen boundary.',
              detail: 'detail',
              blocking: true
            },
          ]
        },
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Reviewer pass after the corrective round.',
          verdict: 'PASS',
          subjectTaskId: workTaskId,
          findings: []
        },
      ],
      qaOutcome: {
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'QA pass.',
        targetRef: QA_TARGET,
        validators: [{ validatorId: VALIDATOR_ID, blocking: true }]
      },
    });

    const result = await core.autonomousSupervisor?.run({
      companyId: COMPANY,
      runId,
      taskId: workTaskId,
      reviewTaskId: started.reviewTaskId,
      actorId: actor,
      runIdentity: 'corrective8',
    });
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;

    // The full corrective path closed on its own COMPLETE (§22).
    expect(result.value.stopReason).toBe('completed');
    expect(result.value.applied.some((entry) => entry.action === 'REQUEST_CORRECTIVE')).toBe(true);
    expect(result.value.applied.at(-1)?.action).toBe('COMPLETE');

    // Exactly one CORRECTIVE task was created, with the durable lineage; the round-two review
    // is the provisioner's deterministic DESCENDANT REASSESSMENT of the review stage — its
    // identity is derived (descendantReassessmentTaskIdOf), so the same run replays it forever
    // and a second ad-hoc seed could not exist under the S21 model anyway.
    const seeded = new Set([started.workTaskId, started.reviewTaskId, started.qaTaskId]);
    const rows = core.database.db.prepare('SELECT id, inputs_json, state FROM tasks').all() as {
      id: string;
      inputs_json: string;
      state: string;
    }[];
    const derived = rows.filter((row) => !seeded.has(row.id));
    const correctiveRows = derived.filter(
      (row) =>
        JSON.parse(String(row.inputs_json))['companyos:reassessment'] === undefined &&
        JSON.parse(String(row.inputs_json))['corrective'] !== undefined,
    );
    expect(correctiveRows).toHaveLength(1);
    const child = correctiveRows[0]!;
    const lineage = JSON.parse(String(child.inputs_json))['corrective'] as Record<string, unknown>;
    expect(lineage['round']).toBe(1);
    expect(lineage['parentTaskId']).toBe(workTaskId);
    expect(lineage['rootTaskId']).toBe(workTaskId);
    expect(child.state).toBe('DONE');
    // The descendant reassessment of the review stage: SAME stage, deterministic id, its own
    // causal marker, settled DONE so the stage-subject authority replaced the stale result.
    const reassessment = derived.find(
      (row) => JSON.parse(String(row.inputs_json))['companyos:reassessment'] !== undefined,
    );
    expect(reassessment).toBeDefined();
    expect(reassessment?.state).toBe('DONE');
    // Three canonical review artifacts, and only three: the round-one review (exactly one
    // CHANGES_REQUESTED — the run never closed on it) plus the TWO deterministic post-corrective
    // reassessments the provisioner minted for the review stage — the producer-stage
    // reassessment of the finding's own producer and the stale-descendant reassessment that
    // replaces the review stage's superseded canonical result. Both settled PASS, and the run
    // closed COMPLETED through those PASSes and the QA PASS, never through the first verdict.
    const findings = (await core.database.artifactStore!.listByRun(runId as never)).filter(
      (artifact) => artifact.kind === 'companyos:review-findings',
    );
    expect(findings).toHaveLength(3);
    const reviewStageDerived = derived.filter((row) => {
      const inputs = JSON.parse(String(row.inputs_json));
      return inputs['companyos:reassessment'] !== undefined;
    });
    expect(reviewStageDerived).toHaveLength(2);
    const reassessmentIds = new Set(reviewStageDerived.map((row) => row.id));
    expect(reassessmentIds.has(reassessmentTaskIdOf({
      companyId: COMPANY,
      runId: runId as never,
      correctiveTaskId: child.id as never,
    }) as string)).toBe(true);
    expect(reassessmentIds.has(descendantReassessmentTaskIdOf({
      companyId: COMPANY,
      runId: runId as never,
      correctiveTaskId: child.id as never,
      descendantStageId: 'review',
    }) as string)).toBe(true);
    const verdicts: string[] = [];
    for (const reviewTaskId of [started.reviewTaskId, ...reviewStageDerived.map((r) => r.id)]) {
      const history = await core.reviewFindingsSink!.listReviewHistory({
        companyId: COMPANY,
        runId,
        reviewTaskId,
        actorId: actor,
      });
      if (!history.ok) throw new Error(history.error.message);
      verdicts.push(...history.value.map((report) => report.payload.verdict));
    }
    expect(verdicts.filter((entry) => entry === 'CHANGES_REQUESTED')).toHaveLength(1);
    expect(verdicts.filter((entry) => entry === 'PASS')).toHaveLength(2);
    const run = await core.database.runs.get(runId as never);
    expect(run?.state).toBe('COMPLETED');
  });
});

describe('T18-07 corrective — production restart E2E (§52/43–45)', () => {
  // REMAINING WORK (not yet green): same root cause as §52/42 above — the chain cannot reach
  // the reviewer stage because the second supervisor turn stops in the production composition.
  it('restart after the reviewer output keeps the canonical artifact and applies its evidence once', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const first = await compose(paths);
    const actor = await sessionActorOf(first);
    await seedRoutingModel(first, actor);
    const started = await startRun(first, actor, 'restart7');
    const { runId, workTaskId } = started;
    const QA_TARGET = await goalArtifactRefOf(first, runId);
    installScript({
      proposals: [
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Execute the next work unit.'
        },
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Keep going.'
        },
        {
          action: 'COMPLETE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Delivered.'
        },
      ],
      reviewOutcomes: [{
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'Reviewer pass.',
        verdict: 'PASS',
        subjectTaskId: workTaskId,
        findings: []
      }],
      qaOutcome: {
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'QA pass.',
        targetRef: QA_TARGET,
        validators: [{ validatorId: VALIDATOR_ID, blocking: true }]
      },
    });

    // A carrier that stops before the lifecycle step, so the restart has something to resume.
    // The LIVE path (`routeOutput`) is the one an agent unit takes, so it is the one that must
    // die here; the replay path (`routeTask`) is patched too, so no second writer can slip in.
    const carrier = first.stageOutputCarrier;
    if (carrier === null) throw new Error('the production carrier is not wired');
    const realRouteTask = carrier.routeTask.bind(carrier);
    const realRouteOutput = carrier.routeOutput.bind(carrier);
    let routedOnce = false;
    // The routed value is deliberately discarded: the crash is about the ORDER (canonical sink
    // durable, lifecycle not yet applied), not about what the sink produced. Sprint21: the
    // carrier reconciles EVERY settled task, so the die is scoped to the REVIEW task — the
    // work output must route normally for the loop to reach the review round at all.
    const dieAfterRouted = async <T>(taskId: string, routed: T): Promise<T> => {
      if (taskId !== started.reviewTaskId) return routed;
      routedOnce = true;
      // Simulate the crash right after the canonical output is durable.
      throw new Error('process died after the reviewer output, before the lifecycle application');
    };
    carrier.routeTask = (input) => realRouteTask(input).then((routed) => dieAfterRouted(input.taskId, routed));
    carrier.routeOutput = (input) => realRouteOutput(input).then((routed) => dieAfterRouted(input.taskId, routed));

    await first.autonomousSupervisor
      ?.run({
        companyId: COMPANY,
        runId,
        taskId: workTaskId,
        reviewTaskId: started.reviewTaskId,
        actorId: actor,
        runIdentity: 'restart7',
      })
      .catch(() => undefined);

    // The canonical review artifact IS durable (the carrier committed before the crash).
    const findings = (await first.database.artifactStore!.listByRun(runId as never)).filter(
      (row) => row.kind === 'companyos:review-findings',
    );
    expect(findings.length).toBe(1);
    first.database.close();
    const tracked = openDatabases.indexOf(first.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);

    // A fresh composition over the SAME files resumes: the canonical evidence implies the
    // lifecycle event, and no second review artifact is produced.
    const second = await compose(paths);
    const actorAgain = await sessionActorOf(second);
    expect(actorAgain).toBe(actor);
    await seedRoutingModel(second, actorAgain);
    await registerValidator(second, actorAgain);
    validatorScript.verdicts.length = 0;
    validatorScript.verdicts.push('pass');
    const QA_TARGET_SECOND = await goalArtifactRefOf(second, runId);
    installScript({
      // The head reconciliation carries the settled review through the ONE carrier; the QA
      // stage runs on this CONTINUE; the durable evidence then drives the gates at the loop
      // head and the run is FINALIZING — the only legal terminal step is COMPLETE.
      proposals: [
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Execute the next work unit.'
        },
        {
          action: 'COMPLETE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Delivered.'
        },
      ],
      reviewOutcomes: [{
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'Reviewer pass.',
        verdict: 'PASS',
        subjectTaskId: workTaskId,
        findings: []
      }],
      qaOutcome: {
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'QA pass.',
        targetRef: QA_TARGET_SECOND,
        validators: [{ validatorId: VALIDATOR_ID, blocking: true }]
      },
    });

    const before = (await second.database.artifactStore!.listByRun(runId as never)).filter(
      (row) => row.kind === 'companyos:review-findings',
    ).length;
    /*
     * Sprint21: the restarted loop reconciles the settled review task through the ONE carrier
     * FIRST (idempotent by permanent command identity — no second artifact), then applies the
     * durable evidence exactly once at the REVIEWING gate (REVIEW.PASS), runs the QA gate and
     * closes. The review task is never re-executed: its attempt count is what the crashed
     * attempt left behind.
     */
    const resumed = await second.autonomousSupervisor?.run({
      companyId: COMPANY,
      runId,
      taskId: workTaskId,
      reviewTaskId: started.reviewTaskId,
      actorId: actorAgain,
      runIdentity: 'restart7b',
    });
    expect(resumed?.ok).toBe(true);
    if (resumed?.ok !== true) return;
    expect(resumed.value.stopReason).toBe('completed');
    const reviewAfter = await second.database.tasks.get(started.reviewTaskId as never);
    expect(Number(reviewAfter?.attempts)).toBe(1); // never re-executed
    const run = await second.database.runs.get(runId as never);
    expect(run?.state).toBe('COMPLETED');
    const after = (await second.database.artifactStore!.listByRun(runId as never)).filter(
      (row) => row.kind === 'companyos:review-findings',
    ).length;
    expect(after).toBe(before);
    expect(routedOnce).toBe(true);

    // Idempotent convergence: a second full run over the SAME completed run changes nothing.
    const again = await second.autonomousSupervisor?.run({
      companyId: COMPANY,
      runId,
      taskId: workTaskId,
      reviewTaskId: started.reviewTaskId,
      actorId: actorAgain,
      runIdentity: 'restart7c',
    });
    expect(again?.ok).toBe(true);
    if (again?.ok !== true) return;
    // A terminal run is terminal for automation too: zero turns, the durable state is the
    // answer, and nothing re-runs (idempotent convergence).
    expect(again.value.stopReason).toBe('completed');
    expect(again.value.turns).toBe(0);
    expect(
      (await second.database.artifactStore!.listByRun(runId as never)).filter(
        (row) => row.kind === 'companyos:review-findings',
      ).length,
    ).toBe(before);
  });
});

describe('T18-07 authority corrective — production QA failure path (§23)', () => {
  it('canonical QA FAIL → VALIDATION.FAIL → REWORK; it never FINALIZEs', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    validatorScript.verdicts.length = 0;
    validatorScript.verdicts.push('fail');
    const started = await startRun(core, actor, 'qafail8');
    const { runId, workTaskId } = started;
    const QA_TARGET = await goalArtifactRefOf(core, runId);
    installScript({
      proposals: [
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review.' },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the QA.' },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Keep going.' },
      ],
      reviewOutcomes: [{
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'Reviewer pass.',
        verdict: 'PASS',
        subjectTaskId: workTaskId,
        findings: []
      }],
      qaOutcome: {
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'QA run.',
        targetRef: QA_TARGET,
        validators: [{ validatorId: VALIDATOR_ID, blocking: true }]
      },
    });

    const result = await core.autonomousSupervisor?.run({
      companyId: COMPANY,
      runId,
      taskId: workTaskId,
      reviewTaskId: started.reviewTaskId,
      actorId: actor,
      runIdentity: 'qafail8',
    });
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) return;
    /*
     * The supervisor SAW the latest failure: its next CONTINUE was REFUSED by the trusted
     * runtime (a blocking LATEST_VALIDATION_FAILED stands), so that proposal never became a
     * Decision — the durable decision history ends with the QA turn. It did not finalize, it
     * did not fabricate a pass, and it did not continue past a failed gate.
     */
    expect(result.value.stopReason).toBe('invariant_failure');
    const decisions = (
      core.database.db.prepare('SELECT decision_id FROM decisions').all() as {
        decision_id: string;
      }[]
    ).length;
    expect(decisions).toBe(3);
    const rows = await core.database.validationStore!.listByRun(runId as never);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.status).toBe('fail');
    expect(await taskState(core, started.qaTaskId!)).toBe('DONE');
    const run = await core.database.runs.get(runId as never);
    expect(run?.state).toBe('REWORK');
    expect(run?.state).not.toBe('FINALIZING');
    expect(run?.state).not.toBe('COMPLETED');
  });
});

describe('T18-07 authority corrective — production latest-batch rule (§24)', () => {
  /*
   * Batches through the REAL ValidationService on a run parked in VALIDATING; only the newest
   * legal batch may decide. Sprint21 parking: the graph is work → review with the REVIEW node
   * declaring the gate's required validators. The run reaches VALIDATING canonically (every
   * stage terminal-successful) and the supervisor ESCALATEs there — so the only durable
   * validation rows are the ones this test writes. The applicator's rule is unchanged: the
   * LATEST row per required validator decides, so an old PASS can never finalize over a newer
   * FAIL and a newer PASS clears an old FAIL.
   */
  /** One run parked in VALIDATING with the test's own batches as its only durable evidence. */
  const parkedBatchableRun = async (
    core: Core,
    actor: string,
    label: string,
  ): Promise<{ runId: string; reviewTaskId: string }> => {
    const started = await startRun(core, actor, label, 'review-validated');
    installScript({
      proposals: [
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review.' },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Keep going.' },
      ],
      reviewOutcomes: [{
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'Reviewer pass.',
        verdict: 'PASS',
        subjectTaskId: started.workTaskId,
        findings: []
      }],
    });
    const parked = await core.autonomousSupervisor?.run({
      companyId: COMPANY,
      runId: started.runId,
      taskId: started.workTaskId,
      reviewTaskId: started.reviewTaskId,
      actorId: actor,
      runIdentity: label,
    });
    expect(parked?.ok).toBe(true);
    if (parked?.ok !== true) throw new Error('the park run failed');
    // The gate has no runnable evidence (the pinned validator stage has no anchor yet), so
    // automation cannot prove it: the loop parks at its ceiling as a HUMAN-REQUIRED stop in
    // VALIDATING (§45) — never a faked PASS, never an invented batch.
    expect(parked.value.stopReason).toBe('human_required');
    expect((await core.database.runs.get(started.runId as never))?.state).toBe('VALIDATING');
    expect((await core.database.validationStore!.listByRun(started.runId as never)).length).toBe(0);
    return { runId: started.runId, reviewTaskId: started.reviewTaskId };
  };

  const batch = async (
    core: Core,
    actor: string,
    runId: string,
    reviewTaskId: string,
    suffix: string,
    verdict: 'pass' | 'fail',
  ) => {
    validatorScript.verdicts.length = 0;
    validatorScript.verdicts.push(verdict);
    const TARGET = await goalArtifactRefOf(core, runId);
    const made = await core.sprint13.validationService.run({
      commandId: `e2e7-latest-${suffix}`,
      actorId: actor,
      runId: runId as never,
      stageId: 'review' as never,
      taskId: reviewTaskId as never,
      targetRef: TARGET as never,
      validators: [{ validatorId: VALIDATOR_ID, blocking: true }],
      traceId: `t18e7b_latest_${suffix}`,
    });
    if (!made.ok) throw new Error(made.error.message);
  };

  it('an old PASS cannot finalize over a newer FAIL', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    const parked = await parkedBatchableRun(core, actor, 'latest8a');
    await batch(core, actor, parked.runId, parked.reviewTaskId, 'old', 'pass');
    await batch(core, actor, parked.runId, parked.reviewTaskId, 'new', 'fail');
    const failed = await core.evidenceApplicator?.applyEvidence({
      companyId: COMPANY,
      runId: parked.runId,
      reviewTaskId: parked.reviewTaskId,
      actorId: actor,
    });
    expect(failed?.ok).toBe(true);
    if (failed?.ok !== true) return;
    expect(failed.value?.event).toBe('VALIDATION.FAIL');
    expect((await core.database.runs.get(parked.runId as never))?.state).toBe('REWORK');
  });

  it('a newer PASS clears an old FAIL', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    const parked = await parkedBatchableRun(core, actor, 'latest8b');
    await batch(core, actor, parked.runId, parked.reviewTaskId, 'old', 'fail');
    await batch(core, actor, parked.runId, parked.reviewTaskId, 'new', 'pass');
    const cleared = await core.evidenceApplicator?.applyEvidence({
      companyId: COMPANY,
      runId: parked.runId,
      reviewTaskId: parked.reviewTaskId,
      actorId: actor,
    });
    expect(cleared?.ok).toBe(true);
    if (cleared?.ok !== true) return;
    // The LATEST batch decided — the newest PASS clears the older FAIL and the run advances.
    expect(cleared.value?.event).toBe('VALIDATION.PASS');
    expect((await core.database.runs.get(parked.runId as never))?.state).toBe('FINALIZING');
  });
});

describe('T18-07 authority corrective — production validation restart (§19/§20/§21)', () => {
  const scriptFor = (workTaskId: string, QA_TARGET: string) => ({
    proposals: [
      { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
      { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review.' },
      { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the QA.' },
      { action: 'COMPLETE', reasonCode: 'GOAL_SATISFIED', summary: 'The objective is delivered.' },
    ],
    reviewOutcomes: [{
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'Reviewer pass.',
      verdict: 'PASS',
      subjectTaskId: workTaskId,
      findings: []
    }],
    qaOutcome: {
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'QA pass.',
      targetRef: QA_TARGET,
      validators: [{ validatorId: VALIDATOR_ID, blocking: true }]
    },
  });

  it('§19 crash after the validation sink, before the lifecycle: the restart applies it once and never reruns QA', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const first = await compose(paths);
    const actor = await sessionActorOf(first);
    await seedRoutingModel(first, actor);
    await registerValidator(first, actor);
    validatorScript.verdicts.length = 0;
    validatorScript.verdicts.push('pass');
    const started = await startRun(first, actor, 'vrestart19');
    const { runId, workTaskId } = started;
    const QA_TARGET = await goalArtifactRefOf(first, runId);
    installScript(scriptFor(workTaskId, QA_TARGET));
    // Die exactly when the applicator tries to land VALIDATION.PASS: the canonical validation
    // is durable and the QA task is DONE, but the lifecycle event never happened.
    const engine = first.sprint13.engine;
    const realDispatch = engine.dispatch.bind(engine);
    let died = false;
    engine.dispatch = ((command: { readonly type: string }) => {
      if (command.type === 'VALIDATION.PASS' && !died) {
        died = true;
        return Promise.reject(new Error('process died before the lifecycle event'));
      }
      return realDispatch(command as never);
    }) as never;

    await first.autonomousSupervisor
      ?.run({
        companyId: COMPANY,
        runId,
        taskId: workTaskId,
        reviewTaskId: started.reviewTaskId,
        actorId: actor,
        runIdentity: 'vr19',
      })
      .catch(() => undefined);
    expect(died).toBe(true);
    const rowsBefore = (await first.database.validationStore!.listByRun(runId as never)).length;
    expect(rowsBefore).toBeGreaterThanOrEqual(1);
    expect(await taskState(first, started.qaTaskId!)).toBe('DONE');
    expect((await first.database.runs.get(runId as never))?.state).toBe('VALIDATING');
    first.database.close();
    const tracked = openDatabases.indexOf(first.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);

    const second = await compose(paths);
    const actorAgain = await sessionActorOf(second);
    expect(actorAgain).toBe(actor);
    // The restart's FIRST act is the canonical one: apply what the durable evidence implies.
    // (A restart cannot mint a fresh supervisor turn here: the provider registry binds
    // in-process adapters only at first registration — a durable provider row cannot be
    // re-bound by a later compose. That restart limitation is reported, not worked around.)
    const applied = await second.evidenceApplicator?.applyEvidence({
      companyId: COMPANY,
      runId,
      reviewTaskId: started.reviewTaskId,
      actorId: actorAgain,
    });
    expect(applied?.ok).toBe(true);
    if (applied?.ok !== true) return;
    expect(applied.value?.event).toBe('VALIDATION.PASS');
    expect((await second.database.runs.get(runId as never))?.state).toBe('FINALIZING');
    // The restart reran NO QA and duplicated NO batch: the row count is exactly what the
    // crashed attempt left durable, and a second application is a durable no-op replay.
    const rowsAfter = (await second.database.validationStore!.listByRun(runId as never)).length;
    expect(rowsAfter).toBe(rowsBefore);
    const again = await second.evidenceApplicator?.applyEvidence({
      companyId: COMPANY,
      runId,
      reviewTaskId: started.reviewTaskId,
      actorId: actorAgain,
    });
    expect(again?.ok).toBe(true);
    if (again?.ok !== true) return;
    expect(again.value).toBeNull();
    expect((await second.database.runs.get(runId as never))?.state).toBe('FINALIZING');
  });

  it('§20/§21 crash after the validation sink, before Task DONE: the restart replays the SAME batch and the provenance survives', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const first = await compose(paths);
    const actor = await sessionActorOf(first);
    await seedRoutingModel(first, actor);
    await registerValidator(first, actor);
    validatorScript.verdicts.length = 0;
    validatorScript.verdicts.push('pass');
    const started = await startRun(first, actor, 'vrestart20');
    const { runId, workTaskId } = started;
    const QA_TARGET = await goalArtifactRefOf(first, runId);
    installScript(scriptFor(workTaskId, QA_TARGET));
    // Die after the canonical validation is durable but before the QA task completes: the
    // resumed attempt re-runs the agent under a NEW execution, so only the canonical command's
    // permanent identity can keep the batch singular.
    const carrier = first.stageOutputCarrier;
    if (carrier === null) throw new Error('the production carrier is not wired');
    const realRouteOutput = carrier.routeOutput.bind(carrier);
    const realRouteTask = carrier.routeTask.bind(carrier);
    let routedOnce = false;
    // Only the QA task's routing dies: the review round must complete normally so the crash
    // lands exactly in the validation sink's window. Sprint21: the autonomous loop routes
    // through routeTask (the post-settlement carrier reconciliation), so BOTH seams die —
    // the restart's idempotent replay goes through routeTask as well.
    const dieAfterValidation = async <T>(taskId: string, routed: T): Promise<T> => {
      if (taskId !== started.qaTaskId) return routed;
      routedOnce = true;
      void routed;
      throw new Error('process died after the validation sink, before the task completed');
    };
    carrier.routeOutput = (input) => realRouteOutput(input).then((routed) => dieAfterValidation(input.taskId, routed));
    carrier.routeTask = (input) => realRouteTask(input).then((routed) => dieAfterValidation(input.taskId, routed));

    await first.autonomousSupervisor
      ?.run({
        companyId: COMPANY,
        runId,
        taskId: workTaskId,
        reviewTaskId: started.reviewTaskId,
        actorId: actor,
        runIdentity: 'vr20',
      })
      .catch(() => undefined);
    expect(routedOnce).toBe(true);
    const rowsBefore = await first.database.validationStore!.listByRun(runId as never);
    expect(rowsBefore.length).toBe(1);
    // Sprint21: the crash window is Task + attempt SETTLED, carrier NOT routed (checkpoint C).
    // The durable Task state is the authority on restart — the QA task is never re-run.
    expect(await taskState(first, started.qaTaskId!)).toBe('DONE');
    first.database.close();
    const tracked = openDatabases.indexOf(first.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);

    const second = await compose(paths);
    const actorAgain = await sessionActorOf(second);
    expect(actorAgain).toBe(actor);
    await registerValidator(second, actorAgain);
    // The resumed attempt re-runs the QA agent under a NEW execution. The provider-registry
    // restart limitation (see §19) keeps a fresh model turn out of reach here, so the re-run's
    // envelope is what a fresh pinned round produced: a new COMPLETED execution of the same QA
    // task, carrying the same plan. Only the canonical command's permanent identity can then
    // keep the batch singular — which is exactly what this test proves.
    const runRow = await second.database.runs.get(runId as never);
    if (runRow === null) throw new Error('the run vanished');
    const retryExecutionId = `exec_${String(runRow.id).slice(4)}retry0`;
    second.database.db
      .prepare(
        `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
           provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
           input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
           created_at, updated_at)
         VALUES (?, 'agent.qa', 'rol_qa', ?, ?, ?, ?, ?, 'COMPLETED', ?, NULL, 't18e7b_vr20', 1,
           '{}', '{}', 1, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        retryExecutionId,
        started.qaTaskId,
        runId,
        MODEL_KEY,
        PROVIDER_ID,
        PROVIDER_MODEL_ID,
        nowIso(),
        nowIso(),
        nowIso(),
      );
    const routed = await second.stageOutputCarrier?.routeOutput({
      companyId: COMPANY,
      runId,
      taskId: started.qaTaskId!,
      actorId: actorAgain,
      traceId: 't18e7b_vr20_retry',
      output: {
        schemaVersion: 'companyos/stage-output/1',
        kind: 'companyos:validation-candidate',
        executionId: retryExecutionId,
        artifactRefs: [],
        validationRefs: [],
        payload: { targetRef: QA_TARGET, validators: [{ validatorId: VALIDATOR_ID, blocking: true }] },
      },
    });
    expect(routed?.ok).toBe(true);
    if (!routed?.ok) return;
    expect(routed.value?.kind).toBe('companyos:validation-candidate');
    // Exactly ONE canonical batch — the re-run REPLAYED it, it did not append a duplicate.
    const rowsAfter = await second.database.validationStore!.listByRun(runId as never);
    expect(rowsAfter.length).toBe(1);
    expect(rowsAfter[0]!.id).toBe(rowsBefore[0]!.id);
    // §21: the validator provenance survived the restart untouched.
    const reports = (await second.database.artifactStore!.listByRun(runId as never)).filter(
      (artifact) => artifact.kind === VALIDATOR_REPORT_KIND,
    );
    expect(reports.length).toBe(1);
    expect(reports[0]!.producedBy).toBe(`validator:${VALIDATOR_ID}@${VALIDATOR_VERSION}`);
    // And the replayed evidence still carries the run to FINALIZING exactly once. Sprint21:
    // the durable chain walks one event per application (the review verdict first, then the
    // validation gate) — each applies at most once and the run never skips a gate.
    let applied = await second.evidenceApplicator?.applyEvidence({
      companyId: COMPANY,
      runId,
      reviewTaskId: started.reviewTaskId,
      actorId: actorAgain,
    });
    expect(applied?.ok).toBe(true);
    if (applied?.ok !== true) return;
    expect(applied.value?.event).toBe('REVIEW.PASS');
    applied = await second.evidenceApplicator?.applyEvidence({
      companyId: COMPANY,
      runId,
      reviewTaskId: started.reviewTaskId,
      actorId: actorAgain,
    });
    expect(applied?.ok).toBe(true);
    if (applied?.ok !== true) return;
    expect(applied.value?.event).toBe('VALIDATION.PASS');
    expect((await second.database.runs.get(runId as never))?.state).toBe('FINALIZING');
    // A second application is a durable no-op replay — the batch is never re-applied.
    const final = await second.evidenceApplicator?.applyEvidence({
      companyId: COMPANY,
      runId,
      reviewTaskId: started.reviewTaskId,
      actorId: actorAgain,
    });
    expect(final?.ok).toBe(true);
    if (final?.ok !== true) return;
    expect(final.value).toBeNull();
    expect((await second.database.runs.get(runId as never))?.state).toBe('FINALIZING');
  });
});

describe('T18-07 authority corrective — validation authority vs provenance (§16/§17/§26)', () => {
  // One composition per test group: the REAL session policy (only the session actor may act),
  // the REAL ArtifactService, the REAL ValidationService and the REAL Tool Registry, plus the
  // same legal validator the happy path registers through the production seam.
  const prepare = async (label: string) => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    validatorScript.verdicts.length = 0;
    validatorScript.verdicts.push('pass');
    const started = await startRun(core, actor, label);
    const target = await goalArtifactRefOf(core, started.runId);
    return { core, actor, started, target };
  };

  const runValidation = (
    core: Core,
    input: {
      readonly actorId: string;
      readonly runId: string;
      readonly targetRef: string;
      readonly commandId?: string;
      readonly validatorId?: string;
    },
  ) =>
    core.sprint13.validationService.run({
      commandId: input.commandId ?? `e2e7-sec-${core.ids.id('cmd')}`,
      actorId: input.actorId,
      runId: input.runId as never,
      stageId: 'qa' as never,
      taskId: null,
      targetRef: input.targetRef as never,
      validators: [{ validatorId: input.validatorId ?? VALIDATOR_ID, blocking: true }],
      traceId: `t18e7b_sec_${core.ids.id('trace')}`,
    });

  it('1/2/3. materialization succeeds; producedBy stays the validator; the session actor stays the principal', async () => {
    const { core, actor, started, target } = await prepare('sec123');
    const made = await runValidation(core, {
      actorId: actor,
      runId: started.runId,
      targetRef: target,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value[0]!.status).toBe('pass');
    // (2) provenance is the validator identity, never the session user (§15).
    const reports = (await core.database.artifactStore!.listByRun(started.runId as never)).filter(
      (artifact) => artifact.kind === VALIDATOR_REPORT_KIND,
    );
    expect(reports.length).toBe(1);
    expect(reports[0]!.producedBy).toBe(`validator:${VALIDATOR_ID}@${VALIDATOR_VERSION}`);
    // (3) the principal stayed the SESSION actor: this composition admits no other, and the
    // producer is provably not the session actor — the operation could only have been
    // authorized as the session actor. The durable invocation agrees.
    expect(reports[0]!.producedBy).not.toBe(actor);
    const invocation = core.database.db
      .prepare('SELECT actor_id FROM tool_invocations WHERE tool_id = ?')
      .get(VALIDATOR_ID) as { actor_id: string };
    expect(invocation.actor_id).toBe(actor);
  });

  it('4. a direct validator-producedBy spoof gains nothing (§16)', async () => {
    const { core, started } = await prepare('sec4');
    const spoof = await core.sprint13.artifactService.create({
      commandId: `e2e7-spoof-${core.ids.id('cmd')}`,
      runId: started.runId as never,
      taskId: null,
      kind: VALIDATOR_REPORT_KIND,
      content: new TextEncoder().encode('{"spoof":true}'),
      producedBy: `validator:${VALIDATOR_ID}@${VALIDATOR_VERSION}`,
      traceId: `t18e7b_spoof_${core.ids.id('trace')}`,
    });
    expect(spoof.ok).toBe(false);
    if (spoof.ok) return;
    expect(spoof.error.code).toBe('POLICY_DENIED');
    const artifacts = await core.database.artifactStore!.listByRun(started.runId as never);
    expect(artifacts.filter((artifact) => artifact.kind === VALIDATOR_REPORT_KIND)).toHaveLength(0);
  });

  it('5. a validator identity is not a session/login identity (§17)', async () => {
    const { core, started, target } = await prepare('sec5');
    const impersonated = await runValidation(core, {
      actorId: `validator:${VALIDATOR_ID}@${VALIDATOR_VERSION}`,
      runId: started.runId,
      targetRef: target,
    });
    expect(impersonated.ok).toBe(false);
    if (impersonated.ok) return;
    expect(impersonated.error.code).toBe('POLICY_DENIED');
    expect((await core.database.validationStore!.listByRun(started.runId as never)).length).toBe(0);
  });

  it('6. an unknown validator is rejected before any execution', async () => {
    const { core, actor, started, target } = await prepare('sec6');
    const made = await runValidation(core, {
      actorId: actor,
      runId: started.runId,
      targetRef: target,
      validatorId: 'nope.missing_validator',
    });
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(String(made.error.details['reason'] ?? '')).toBe('VALIDATOR_NOT_FOUND');
    expect((await core.database.validationStore!.listByRun(started.runId as never)).length).toBe(0);
  });

  it('7. registry version drift cannot rewrite a materialized report provenance', async () => {
    const { core, actor, started, target } = await prepare('sec7');
    const commandId = `e2e7-sec7-${core.ids.id('cmd')}`;
    const first = await runValidation(core, {
      actorId: actor,
      runId: started.runId,
      targetRef: target,
      commandId,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // A newer tool version is registered; the SAME command replays and the durable report
    // keeps the version that actually executed (ADR-0019 §12).
    const upgraded = createToolRecord({
      toolId: VALIDATOR_ID,
      name: 'unit validator',
      description: 'Deterministic in-process unit validator (E2E fixture).',
      version: '2.0.0',
      capabilities: [TOOL_CAPABILITY_VALIDATOR],
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      outputSchema: { type: 'object', properties: {}, additionalProperties: true },
      riskLevel: 'LOW',
      requiredAuthorities: ['tool.invoke'],
      idempotencyMode: 'IDEMPOTENT_KEY',
      adapterRef: VALIDATOR_ID,
      now: nowIso(),
    });
    if (!upgraded.ok) throw new Error(upgraded.error.message);
    const registered = await core.tools.register(upgraded.value, { actorId: actor });
    if (!registered.ok && registered.error.code !== 'CONFLICT') {
      throw new Error(registered.error.message);
    }
    const replay = await runValidation(core, {
      actorId: actor,
      runId: started.runId,
      targetRef: target,
      commandId,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value[0]!.id).toBe(first.value[0]!.id);
    const reports = (await core.database.artifactStore!.listByRun(started.runId as never)).filter(
      (artifact) => artifact.kind === VALIDATOR_REPORT_KIND,
    );
    expect(reports.length).toBe(1);
    expect(reports[0]!.producedBy).toBe(`validator:${VALIDATOR_ID}@${VALIDATOR_VERSION}`);
  });

  it('8. a foreign actor is refused at the gate (the tenant boundary of this composition)', async () => {
    const { core, started, target } = await prepare('sec8');
    const made = await runValidation(core, {
      actorId: 'user_someone_else',
      runId: started.runId,
      targetRef: target,
    });
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.error.code).toBe('POLICY_DENIED');
  });

  it('9. a target artifact of another run is rejected before any execution', async () => {
    const first = await prepare('sec9a');
    const second = await prepare('sec9b');
    const made = await runValidation(first.core, {
      actorId: first.actor,
      runId: second.started.runId,
      targetRef: first.target,
    });
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(String(made.error.details['reason'] ?? '')).toBe('VALIDATION_TARGET_WRONG_RUN');
    expect(
      (await second.core.database.validationStore!.listByRun(second.started.runId as never))
        .length,
    ).toBe(0);
  });

  it('10. an envelope whose execution belongs to another task is refused by the carrier', async () => {
    const { core, actor, started, target } = await prepare('sec10');
    const runRow = await core.database.runs.get(started.runId as never);
    if (runRow === null) throw new Error('the run vanished');
    const foreignExecutionId = `exec_${String(runRow.id).slice(4)}sec10`;
    core.database.db
      .prepare(
        `INSERT INTO agent_executions (execution_id, agent_id, role_id, task_id, run_id, model_key,
           provider_id, provider_model_id, status, started_at, finished_at, trace_id, attempt,
           input_usage, output_usage, latency_ms, result_ref, error_code, error_kind, error_message,
           created_at, updated_at)
         VALUES (?, 'agent.qa', 'rol_qa', ?, ?, ?, ?, ?, 'COMPLETED', ?, NULL, 't18e7b_sec10', 1,
           '{}', '{}', 1, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        foreignExecutionId,
        started.workTaskId,
        started.runId,
        MODEL_KEY,
        PROVIDER_ID,
        PROVIDER_MODEL_ID,
        nowIso(),
        nowIso(),
        nowIso(),
      );
    const routed = await core.stageOutputCarrier?.routeOutput({
      companyId: COMPANY,
      runId: started.runId,
      taskId: started.qaTaskId!,
      actorId: actor,
      traceId: 't18e7b_sec10_route',
      output: {
        schemaVersion: 'companyos/stage-output/1',
        kind: 'companyos:validation-candidate',
        executionId: foreignExecutionId,
        artifactRefs: [],
        validationRefs: [],
        payload: { targetRef: target, validators: [{ validatorId: VALIDATOR_ID, blocking: true }] },
      },
    });
    expect(routed?.ok).toBe(false);
    if (!routed || routed.ok) return;
    expect(String(routed.error.details['reason'] ?? '')).toBe(
      'STAGE_OUTPUT_EXECUTION_TASK_MISMATCH',
    );
    expect((await core.database.validationStore!.listByRun(started.runId as never)).length).toBe(0);
  });

  it('11/12. the verifier-only repo validator still fails closed: a stale anchor and a missing evidence slot can never pass', async () => {
    const { core, actor, started, target } = await prepare('sec1112');
    // The production composition registers repo.validation-evidence (T17-06): verifier-only,
    // deciding from durable repository evidence. With no workspace open there is no current
    // anchor and no evidence slot satisfied, so its verdict must be a FAILURE — under the new
    // authority path exactly as before it.
    const registered = await core.tools.get('repo.validation-evidence', actor);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.value).not.toBeNull();
    const made = await runValidation(core, {
      actorId: actor,
      runId: started.runId,
      targetRef: target,
      validatorId: 'repo.validation-evidence',
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.length).toBeGreaterThanOrEqual(1);
    for (const row of made.value) {
      expect(row.status).not.toBe('pass');
    }
  });

  it('14. the same canonical command replays with zero duplicates (§18)', async () => {
    const { core, actor, started, target } = await prepare('sec14');
    const commandId = `e2e7-sec14-${core.ids.id('cmd')}`;
    const first = await runValidation(core, {
      actorId: actor,
      runId: started.runId,
      targetRef: target,
      commandId,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = await runValidation(core, {
      actorId: actor,
      runId: started.runId,
      targetRef: target,
      commandId,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    const rows = await core.database.validationStore!.listByRun(started.runId as never);
    expect(rows.length).toBe(1);
    expect(replay.value[0]!.id).toBe(first.value[0]!.id);
    const reports = (await core.database.artifactStore!.listByRun(started.runId as never)).filter(
      (artifact) => artifact.kind === VALIDATOR_REPORT_KIND,
    );
    expect(reports.length).toBe(1);
  });

  it('15. concurrent materialization of the same command creates ONE canonical result', async () => {
    const { core, actor, started, target } = await prepare('sec15');
    const commandId = `e2e7-sec15-${core.ids.id('cmd')}`;
    const [a, b] = await Promise.all([
      runValidation(core, { actorId: actor, runId: started.runId, targetRef: target, commandId }),
      runValidation(core, { actorId: actor, runId: started.runId, targetRef: target, commandId }),
    ]);
    expect(a.ok || b.ok).toBe(true);
    const rows = await core.database.validationStore!.listByRun(started.runId as never);
    expect(rows.length).toBe(1);
    const reports = (await core.database.artifactStore!.listByRun(started.runId as never)).filter(
      (artifact) => artifact.kind === VALIDATOR_REPORT_KIND,
    );
    expect(reports.length).toBe(1);
  });
});

describe('T18-07 closeout audit A — artifact provenance spoof (A2/A4)', () => {
  /*
   * The DANGEROUS case, exactly as specified: a REAL legitimate session actor supplies its own
   * authorizedBy AND a protected validator producedBy, WITHOUT ValidationService, without the
   * ValidatorResolver and without the canonical QA carrier. What must hold: the artifact layer
   * may record the descriptive provenance (creation is a legitimate operation for the
   * principal), but NOTHING canonical can grow from it — no Validation row, no gate
   * acceptance, and no supervisor QA evidence.
   */
  it('A2. real session actor + validator producedBy: descriptive artifact, never canonical evidence', async () => {
    const core = await compose();
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    validatorScript.verdicts.length = 0;
    validatorScript.verdicts.push('pass');
    const started = await startRun(core, actor, 'auditA2', 'plain');
    const { runId, workTaskId } = started;
    const QA_TARGET = await goalArtifactRefOf(core, runId);

    /*
     * Park the run in VALIDATING with NO canonical QA. Sprint21: the graph declares no
     * validator requirements anywhere, so the run reaches the frozen evidence gate
     * canonically (every stage terminal-successful) and the gate REFUSES to fake a PASS —
     * a safe human stop in VALIDATING with zero validation rows. The ONLY "QA evidence" in
     * existence will be the spoofed artifact this test creates.
     */
    installScript({
      proposals: [
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review.' },
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Keep going.' },
      ],
      reviewOutcomes: [
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Reviewer pass.',
          verdict: 'PASS',
          subjectTaskId: workTaskId,
          findings: []
        },
      ],
    });
    const parked = await core.autonomousSupervisor?.run({
      companyId: COMPANY,
      runId,
      taskId: workTaskId,
      reviewTaskId: started.reviewTaskId,
      actorId: actor,
      runIdentity: 'auditA2',
    });
    expect(parked?.ok).toBe(true);
    if (parked?.ok !== true) return;
    expect(parked.value.stopReason).toBe('validation_requirements_missing');
    expect((await core.database.runs.get(runId as never))?.state).toBe('VALIDATING');
    expect((await core.database.validationStore!.listByRun(runId as never)).length).toBe(0);

    // The spoof: the session actor authorizes the creation; the producer claims the REAL
    // validator identity at its REAL version. No ValidationService anywhere in this path.
    const spoof = await core.sprint13.artifactService.create({
      commandId: `e2e7-a2-spoof-${core.ids.id('cmd')}`,
      runId: runId as never,
      taskId: started.qaTaskId as never,
      kind: 'companyos:validator-report',
      content: new TextEncoder().encode(
        JSON.stringify({ validatorId: VALIDATOR_ID, verdict: 'pass', spoofed: true }),
      ),
      producedBy: `validator:${VALIDATOR_ID}@${VALIDATOR_VERSION}`,
      authorizedBy: actor,
      traceId: `t18e7b_a2_${core.ids.id('trace')}`,
    });
    // Artifact creation: ALLOWED — the principal may create artifacts; the producer field is
    // descriptive provenance the generic layer does not (and must not) adjudicate.
    expect(spoof.ok).toBe(true);
    if (!spoof.ok) return;
    expect(spoof.value.producedBy).toBe(`validator:${VALIDATOR_ID}@${VALIDATOR_VERSION}`);

    // Canonical Validation created: NO — the ValidationService is the ONE writer of Validation
    // rows, and it only writes through resolver + registry tool execution. Zero rows exist.
    expect((await core.database.validationStore!.listByRun(runId as never)).length).toBe(0);

    // EvidenceGuard accepts it: NO — the gate consults durable VALIDATION rows, so the
    // applicator finds nothing to apply and the run cannot advance on this artifact.
    const applied = await core.evidenceApplicator?.applyEvidence({
      companyId: COMPANY,
      runId,
      reviewTaskId: started.reviewTaskId,
      actorId: actor,
    });
    expect(applied?.ok).toBe(true);
    if (applied?.ok !== true) return;
    expect(applied.value).toBeNull();
    expect((await core.database.runs.get(runId as never))?.state).toBe('VALIDATING');

    // Supervisor can treat it as QA evidence: NO — a COMPLETE turn is refused because no
    // passing Validation row exists to cite; an artifact ref is not a validation identity.
    installScript({
      proposals: [
        { action: 'COMPLETE', reasonCode: 'GOAL_SATISFIED', summary: 'Claim delivery on the spoofed evidence.' },
      ],
      reviewOutcomes: [
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Reviewer pass.',
          verdict: 'PASS',
          subjectTaskId: workTaskId,
          findings: []
        },
      ],
      qaOutcome: {
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'QA run.',
        targetRef: QA_TARGET,
        validators: [{ validatorId: VALIDATOR_ID, blocking: true }]
      },
    });
    const turn = await core.supervisorDecisionRuntime?.runOneSupervisorDecisionTurn({
      companyId: COMPANY,
      runId,
      taskId: workTaskId,
      reviewTaskId: started.reviewTaskId,
      actorId: actor,
      commandId: `supervisor-decision:${runId}:auditA2:spoof`,
      traceId: 't18e7b_a2_turn',
    });
    expect(turn?.ok).toBe(false);
    if (!turn || turn.ok) return;
    expect(String(turn.error.details['reason'] ?? '')).toBe(
      'SUPERVISOR_PROPOSAL_COMPLETION_UNPROVEN',
    );
    expect((await core.database.runs.get(runId as never))?.state).toBe('VALIDATING');
  });
});

describe('T18-07 closeout audit B — provider runtime rebind (B1/B6)', () => {
  /*
   * B1 reproduction: a fresh composition over the same persistent storage must re-bind the
   * configured provider adapter and run a NEW supervisor model turn — a real provider
   * invocation after restart, not a Decision replay.
   */
  it('B1. a fresh composition rebinds the provider and performs a NEW supervisor turn', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const first = await compose(paths);
    const actor = await sessionActorOf(first);
    await seedRoutingModel(first, actor);
    await registerValidator(first, actor);
    validatorScript.verdicts.length = 0;
    validatorScript.verdicts.push('pass');
    const started = await startRun(first, actor, 'rebind1');
    const QA_TARGET = await goalArtifactRefOf(first, started.runId);
    installScript({
      proposals: [
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
      ],
      reviewOutcomes: [
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Reviewer pass.',
          verdict: 'PASS',
          subjectTaskId: started.workTaskId,
          findings: []
        },
      ],
      qaOutcome: {
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'QA pass.',
        targetRef: QA_TARGET,
        validators: [{ validatorId: VALIDATOR_ID, blocking: true }]
      },
    });
    const before = await first.autonomousSupervisor?.run({
      companyId: COMPANY,
      runId: started.runId,
      taskId: started.workTaskId,
      reviewTaskId: started.reviewTaskId,
      actorId: actor,
      runIdentity: 'rebind1',
    });
    expect(before?.ok).toBe(true);
    if (before?.ok !== true) return;
    expect(before.value.applied.length).toBeGreaterThanOrEqual(1);
    const snapshotBefore = (await first.database.runs.get(started.runId as never))?.snapshotId;
    first.database.close();
    const tracked = openDatabases.indexOf(first.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);

    const second = await compose(paths);
    const actorAgain = await sessionActorOf(second);
    expect(actorAgain).toBe(actor);
    // (1) the same trusted provider re-binds: registration is idempotent restart semantics.
    const rebound = await seedRoutingModelReturning(second, actorAgain);
    expect(rebound).toBe('rebound');
    expect(second.providers.boundProviderIds()).toContain(PROVIDER_ID);
    // (3) the pinned identity is unchanged: same snapshot, same resolved model key.
    expect((await second.database.runs.get(started.runId as never))?.snapshotId).toBe(
      snapshotBefore,
    );
    const binding = await second.pinnedAgentExecution?.resolveBinding({
      companyId: COMPANY,
      runId: started.runId,
    });
    expect(binding?.ok).toBe(true);
    if (binding?.ok === true) expect(binding.value.modelKey).toBe(MODEL_KEY);
    // (2) a NEW supervisor turn after restart invokes the provider on a NEW run.
    await registerValidator(second, actorAgain);
    const fresh = await startRun(second, actorAgain, 'rebind2');
    installScript({
      proposals: [
        { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
      ],
      reviewOutcomes: [
        {
          action: 'CONTINUE',
          reasonCode: 'GOAL_SATISFIED',
          summary: 'Reviewer pass.',
          verdict: 'PASS',
          subjectTaskId: fresh.workTaskId,
          findings: []
        },
      ],
      qaOutcome: {
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'QA pass.',
        targetRef: await goalArtifactRefOf(second, fresh.runId),
        validators: [{ validatorId: VALIDATOR_ID, blocking: true }]
      },
    });
    const after = await second.autonomousSupervisor?.run({
      companyId: COMPANY,
      runId: fresh.runId,
      taskId: fresh.workTaskId,
      reviewTaskId: fresh.reviewTaskId,
      actorId: actorAgain,
      runIdentity: 'rebind2',
    });
    expect(after?.ok).toBe(true);
    if (after?.ok !== true) return;
    expect(after.value.applied[0]?.effect.startsWith('stage:work:')).toBe(true);
    // (7) no duplicate durable provider descriptor.
    const rows = second.database.db
      .prepare('SELECT COUNT(*) AS c FROM providers')
      .get() as { c: number | bigint };
    expect(Number(rows.c)).toBe(1);
  });

  it('B6/4. an incompatible adapter is rejected fail-closed, with the mismatch named', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const first = await compose(paths);
    const actor = await sessionActorOf(first);
    await seedRoutingModel(first, actor);
    first.database.close();
    const tracked = openDatabases.indexOf(first.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);

    const second = await compose(paths);
    const actorAgain = await sessionActorOf(second);
    // Same providerId, DIFFERENT descriptor (displayName): no silent replacement.
    const impostor: ModelProviderPort = {
      describe: () => ({
        providerId: PROVIDER_ID,
        kind: 'fake',
        displayName: 'A different adapter',
        version: '9.9.9',
      }),
      listModels: () => Promise.resolve(ok(CATALOGUE)),
      health: () => Promise.resolve(ok(undefined as never)),
      invoke: () => {
        throw new Error('must never be invoked');
      },
      stream(): AsyncIterable<Result<never, DomainError>> {
        return {
          [Symbol.asyncIterator]: () => ({
            next: (): Promise<IteratorResult<Result<never, DomainError>>> =>
              Promise.resolve({ done: true, value: undefined }),
          }),
        };
      },
    };
    const refused = await second.providers.register(impostor, { actorId: actorAgain });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('CONFLICT');
    expect(JSON.stringify(refused.error.details)).toContain('displayName');
    // (8) no dynamic fallback: the mismatched adapter is not bound, and nothing answers for it.
    expect(second.providers.boundProviderIds()).not.toContain(PROVIDER_ID);
    expect(second.providers.get(PROVIDER_ID)).toBeNull();
    // (6) an unknown provider stays rejected.
    expect(second.providers.get('prov_missing')).toBeNull();
  });

  it('B6/5. a disabled provider stays disabled across the rebind', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const first = await compose(paths);
    const actor = await sessionActorOf(first);
    const registered = await first.providers.register(createRoutingProvider(), {
      actorId: actor,
      enabled: false,
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.value.enabled).toBe(false);
    first.database.close();
    const tracked = openDatabases.indexOf(first.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);

    const second = await compose(paths);
    const actorAgain = await sessionActorOf(second);
    const rebound = await second.providers.register(createRoutingProvider(), {
      actorId: actorAgain,
    });
    expect(rebound.ok).toBe(true);
    if (!rebound.ok) return;
    // The persisted enabled state survives: the rebind attaches capability, never policy.
    expect(rebound.value.enabled).toBe(false);
    expect(second.providers.boundProviderIds()).toContain(PROVIDER_ID);
  });
});

describe('T18-07 closeout audit C — REWORK human escalation (C1/C5)', () => {
  const roundScript = (input: {
    readonly reviewTaskKind: 'changes';
    readonly withWorkUnit?: boolean;
  }) => ({
    /*
     * Sprint21 immediate corrective: ONE invocation drives the cycle. Each CONTINUE executes
     * the next DAG unit (a review round / its reassessment — a durable finding); each
     * REQUEST_CORRECTIVE cites that round's corpus evidence and lands the next round. The
     * review outcome carries NO pinned subject — the fake follows the subject the last turn
     * anchored on, so each round reviews ITS OWN durable corrective work.
     */
    proposals: [
      ...(input.withWorkUnit === true
        ? [
            {
              action: 'CONTINUE',
              reasonCode: 'GOAL_SATISFIED',
              summary: 'Execute the work unit.',
            },
          ]
        : []),
      { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review round.' },
      {
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'The reviewer requires corrective work.',
      },
      { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Settle the round.' },
      {
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'The reviewer requires corrective work.',
      },
      { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Settle the round.' },
      {
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'The reviewer requires corrective work.',
      },
      { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Settle the round.' },
      {
        action: 'REQUEST_CORRECTIVE',
        reasonCode: 'REVIEW_FINDING',
        summary: 'The reviewer requires corrective work.',
      },
    ],
    reviewOutcomes: [
      {
        action: 'CONTINUE',
        reasonCode: 'GOAL_SATISFIED',
        summary: 'Reviewer requests changes.',
        verdict: 'CHANGES_REQUESTED',
        findings: [
          {
            code: 'semantic.boundary',
            summary: 'Crosses a frozen boundary.',
            detail: 'detail',
            blocking: true,
          },
        ],
      },
    ],
    qaOutcome: {
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'QA run.',
      targetRef: 'artifact:none',
      validators: [{ validatorId: VALIDATOR_ID, blocking: true }],
    },
  });

  /** The newest corrective task of the run (round N), read from durable lineage. */
  const newestCorrective = (core: Core): { id: string; round: number } => {
    const rows = core.database.db
      .prepare('SELECT id, inputs_json FROM tasks')
      .all() as { id: string; inputs_json: string }[];
    let best: { id: string; round: number } | null = null;
    for (const row of rows) {
      const lineage = JSON.parse(String(row.inputs_json))['corrective'] as
        | { round?: unknown }
        | undefined;
      if (lineage === undefined || typeof lineage['round'] !== 'number') continue;
      const round = Number(lineage['round']);
      if (best === null || round > best.round) best = { id: row.id, round };
    }
    if (best === null) throw new Error('no corrective task found');
    return best;
  };

  it('C1/C5. three rounds exhaust, round 4 is refused, and the durable PAUSED stop survives restart', async () => {
    const paths = { dataDir: tempDir(), casRoot: tempDir() };
    const core = await compose(paths);
    const actor = await sessionActorOf(core);
    await seedRoutingModel(core, actor);
    await registerValidator(core, actor);
    const started = await startRun(core, actor, 'exhaust8');
    const { runId, workTaskId } = started;

    // Two more review rounds beyond the fixture's two: four review tasks for four rounds.
    for (let index = 0; index < 2; index += 1) {
      const task = await createTask({
        runId: runId as never,
        stageId: 'review' as never,
        roleId: 'rol_reviewer' as never,
        kind: 'e2e7:review',
        now: nowIso(),
        ids: core.ids,
      });
      if (!task.ok) throw new Error(task.error.message);
      await core.database.tasks.put(task.value);
    }

    /*
     * Sprint21: the immediate-corrective cycle runs inside ONE invocation — rounds 1-3 apply
     * (each corrective executed inside its apply), and the round-4 refusal lands the durable
     * PAUSED human stop mid-invocation (the corrective cycle runs inside EXECUTING; the frozen
     * machine records it through its legal PAUSE event there).
     */
    installScript(roundScript({ reviewTaskKind: 'changes', withWorkUnit: true }));
    const rounds = await core.autonomousSupervisor?.run({
      companyId: COMPANY,
      runId,
      taskId: workTaskId,
      reviewTaskId: started.reviewTaskId,
      actorId: actor,
      runIdentity: 'ex8',
    });
    expect(rounds?.ok).toBe(true);
    if (rounds?.ok !== true) return;
    // Rounds 1-3 are DURABLY there; the cap refuses round 4 without ever creating the task.
    expect(newestCorrective(core).round).toBe(3);
    const tasksBefore = Number(
      (core.database.db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number | bigint })
        .c,
    );
    const t3 = newestCorrective(core).id;
    expect(rounds.value.stopReason).toBe('round_limit');
    const tasksAfter = Number(
      (core.database.db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number | bigint })
        .c,
    );
    expect(tasksAfter).toBe(tasksBefore);
    // The durable human-required stop: the machine's own REWORK_EXHAUSTED landed the run in
    // PAUSED — machine-readable, and nothing else claims otherwise.
    expect((await core.database.runs.get(runId as never))?.state).toBe('PAUSED');
    const decisionsBefore = (
      core.database.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as {
        c: number | bigint;
      }
    ).c;
    core.database.close();
    const tracked = openDatabases.indexOf(core.database);
    if (tracked >= 0) openDatabases.splice(tracked, 1);

    // Restart: the PAUSED stop survives, and automation makes NO model call at all.
    const second = await compose(paths);
    const actorAgain = await sessionActorOf(second);
    expect(actorAgain).toBe(actor);
    await seedRoutingModel(second, actorAgain);
    await registerValidator(second, actorAgain);
    expect((await second.database.runs.get(runId as never))?.state).toBe('PAUSED');
    installScript(roundScript({ reviewTaskKind: 'changes' }));
    const restarted = await second.autonomousSupervisor?.run({
      companyId: COMPANY,
      runId,
      taskId: t3,
      reviewTaskId: started.reviewTaskId,
      actorId: actorAgain,
      runIdentity: 'ex8-restart',
    });
    expect(restarted?.ok).toBe(true);
    if (restarted?.ok !== true) return;
    expect(restarted.value.stopReason).toBe('human_required');
    expect(restarted.value.turns).toBe(0);
    const decisionsAfter = (
      second.database.db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as {
        c: number | bigint;
      }
    ).c;
    expect(Number(decisionsAfter)).toBe(Number(decisionsBefore));
    expect((await second.database.runs.get(runId as never))?.state).toBe('PAUSED');

    // Trusted resume: the machine's own RESUME — the one and only way on, issued by the
    // trusted host exactly as the machine's contract prescribes ("never automatic").
    const pausedRun = await second.database.runs.get(runId as never);
    if (pausedRun === null) throw new Error('the run vanished');
    const resumed = await second.sprint13.engine.dispatch({
      commandId: `t18e7-resume:${runId}`,
      runId,
      type: 'RUN.RESUME',
      expectedRevision: pausedRun.revision,
      actorId: actorAgain,
      traceId: 't18e7b_resume',
      issuedAt: nowIso(),
      reason: 'human re-decision after corrective exhaustion',
    });
    expect(resumed.ok).toBe(true);
    const stateAfterResume = (await second.database.runs.get(runId as never))?.state;
    expect(stateAfterResume).not.toBe('PAUSED');
    // Exactly ONE continuation: a second RESUME is refused by the machine from the new state.
    const runNow = await second.database.runs.get(runId as never);
    if (runNow === null) throw new Error('the run vanished');
    const secondResume = await second.sprint13.engine.dispatch({
      commandId: `t18e7-resume-2:${runId}`,
      runId,
      type: 'RUN.RESUME',
      expectedRevision: runNow.revision,
      actorId: actorAgain,
      traceId: 't18e7b_resume2',
      issuedAt: nowIso(),
      reason: 'a second continuation attempt',
    });
    expect(secondResume.ok).toBe(false);
    // And the continued run still has no fourth corrective round in it.
    expect(newestCorrective(second).round).toBe(3);
  });
});
