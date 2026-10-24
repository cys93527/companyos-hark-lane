/**
 * Task-18-08 shared test fixture: the REAL production composition (`composeCoreServices`)
 * with the deterministic fault-injection seam threaded through, plus the same legal validator
 * and routing-model construction the T18-07 E2Es use. Shared by the simulated-checkpoint
 * matrix, the chaos scenarios and the real-process child harness.
 *
 * Nothing here injects state: the only difference from production is the `faultCheckpoints`
 * option a test arms, and the fake provider is registered through the real provider registry
 * exactly like the mock adapter (no live model API).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTask,
  createToolRecord,
  ok,
  runGoalCommandId,
  TOOL_CAPABILITY_VALIDATOR,
  TOOL_ID_PATTERN,
  type DomainError,
  type FaultCheckpointPort,
  type ModelProviderPort,
  type Result,
  type ToolPort,
} from '@companyos/core';
import { SUPERVISOR_PROPOSAL_SCHEMA } from '@companyos/engine';
import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';

import { composeCoreServices } from '../../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../../apps/desktop/src/artifact-stack.js';

export const COMPANY = 'company_default';
export const SUPERVISOR_BINDING = 'supervisor';
export const PROVIDER_ID = 'prov_e2e7';
export const MODEL_KEY = 'e2e7.supervisor';
export const PROVIDER_MODEL_ID = 'e2e7-model-1';
export const CATALOGUE = [
  {
    modelId: PROVIDER_MODEL_ID,
    displayName: PROVIDER_MODEL_ID,
    contextWindow: 8_192,
    capabilities: { streaming: false, structuredOutput: true },
  },
];

export const VALIDATOR_ID = 'e2e7.unit_validator';
export const VALIDATOR_VERSION = '1.0.0';
export const VALIDATOR_REPORT_KIND = 'companyos:validator-report';

export type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];

export const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t18f-'));
  createdDirs.push(dir);
  return dir;
};

export const closeFixtureArtifacts = (): void => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
};

export const trackDatabase = (db: DurableDatabase): void => {
  openDatabases.push(db);
};
export const untrackDatabase = (db: DurableDatabase): void => {
  const tracked = openDatabases.indexOf(db);
  if (tracked >= 0) openDatabases.splice(tracked, 1);
};

let seq = 0;
export const nowIso = (): string =>
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

/** The mutable verdict script of the validator adapter (deterministic per call). */
export const validatorScript: { verdicts: ('pass' | 'fail')[] } = { verdicts: ['pass'] };

export const createValidatorPort = (): ToolPort => ({
  describe: () => ({
    toolId: VALIDATOR_ID,
    name: 'unit validator',
    description: 'Deterministic in-process unit validator (T18-08 fixture).',
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

export const registerValidator = async (core: Core, actor: string): Promise<void> => {
  const record = createToolRecord({
    toolId: VALIDATOR_ID,
    name: 'unit validator',
    description: 'Deterministic in-process unit validator (T18-08 fixture).',
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

/** The mutable script of the routing model; cursors RESET on every install. */
export const routingScript: {
  proposals: readonly Readonly<Record<string, unknown>>[];
  reviewOutcomes: readonly Readonly<Record<string, unknown>>[];
  qaOutcome: Readonly<Record<string, unknown>>;
  proposalIndex: number;
  reviewIndex: number;
  /** The subject the LAST proposal turn anchored on — the review of the unit that ran
   *  after it targets the durable work, never a stale pinned id (Sprint21 immediate
   *  corrective: the subject advances to each new corrective task). */
  lastSubjectTaskId: string | null;
} = {
  proposals: [],
  reviewOutcomes: [],
  qaOutcome: {},
  proposalIndex: 0,
  reviewIndex: 0,
  lastSubjectTaskId: null,
};

const stringAt = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

/** The FIRST JSON object at or after `from` in `text`, string-aware. */
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

const contextRefsOf = (
  context: Readonly<Record<string, unknown>>,
  kind: string,
): readonly string[] => {
  const refs = context['refs'];
  if (!Array.isArray(refs)) return [];
  return refs
    .map((entry) =>
      typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null,
    )
    .filter((entry): entry is Readonly<Record<string, unknown>> => entry !== null)
    .filter((entry) => entry['kind'] === kind)
    .map((entry) => stringAt(entry['id']))
    .filter((id): id is string => id !== null)
    .map((id) => (kind === 'review' ? `artifact:${id}` : id));
};

export const createRoutingProvider = (): ModelProviderPort => {
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
        const context = supervisorContextOf(request);
        const subjectTaskId =
          context === null
            ? null
            : stringAt((context['subject'] as Record<string, unknown>)['taskId']);
        // The next executed unit reviews the subject THIS turn anchored on.
        if (subjectTaskId !== null) routingScript.lastSubjectTaskId = subjectTaskId;
        // State-aware, like a model that read its context: when the run is already FINALIZING
        // the only legal terminal step is COMPLETE, so a scripted CONTINUE graduates to it.
        const runState =
          context === null
            ? null
            : stringAt((context['run'] as Record<string, unknown>)['state']);
        const action =
          runState === 'FINALIZING' && scripted['action'] === 'CONTINUE'
            ? 'COMPLETE'
            : scripted['action'];
        const evidenceRefs =
          Array.isArray(scripted['evidenceRefs']) && scripted['evidenceRefs'].length > 0
            ? scripted['evidenceRefs']
            : context === null
              ? []
              : action === 'COMPLETE' || scripted['reasonCode'] === 'VALIDATION_FAILED'
                ? contextRefsOf(context, 'validation')
                : contextRefsOf(context, 'review');
        structured = {
          schema: SUPERVISOR_PROPOSAL_SCHEMA,
          ...scripted,
          action,
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

export const seedRoutingModel = async (core: Core, actor: string): Promise<void> => {
  const provider = await core.providers.register(createRoutingProvider(), { actorId: actor });
  if (!provider.ok) throw new Error(provider.error.message);
  const model = await core.models.registerFromProvider({
    providerId: PROVIDER_ID,
    providerModelId: PROVIDER_MODEL_ID,
    modelKey: MODEL_KEY,
    actorId: actor,
  });
  if (!model.ok && model.error.code !== 'CONFLICT') throw new Error(model.error.message);
};

export interface ScriptInput {
  readonly proposals: readonly Readonly<Record<string, unknown>>[];
  readonly reviewOutcomes: readonly Readonly<Record<string, unknown>>[];
  readonly qaTarget: string;
  readonly qaVerdictValidator?: string;
}

export const installScript = (input: ScriptInput): void => {
  routingScript.proposals = input.proposals;
  routingScript.reviewOutcomes = input.reviewOutcomes;
  routingScript.qaOutcome = {
    action: 'CONTINUE',
    reasonCode: 'GOAL_SATISFIED',
    summary: 'QA run.',
    targetRef: input.qaTarget,
    validators: [{ validatorId: input.qaVerdictValidator ?? VALIDATOR_ID, blocking: true }],
  };
  routingScript.proposalIndex = 0;
  routingScript.reviewIndex = 0;
  routingScript.lastSubjectTaskId = null;
};

export const happyScript = (workTaskId: string, qaTarget: string): ScriptInput => ({
  // CONTINUEs beyond the fresh-chain count are recovery headroom: a restarted run replays
  // its durable turns first, so the model script must still reach COMPLETE after them.
  proposals: [
    { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Execute the work unit.' },
    { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the review.' },
    { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Run the QA.' },
    { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Keep going.' },
    { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Keep going.' },
    { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Keep going.' },
    { action: 'CONTINUE', reasonCode: 'GOAL_SATISFIED', summary: 'Keep going.' },
    { action: 'COMPLETE', reasonCode: 'GOAL_SATISFIED', summary: 'The objective is delivered.' },
  ],
  reviewOutcomes: [
    {
      action: 'CONTINUE',
      reasonCode: 'GOAL_SATISFIED',
      summary: 'Reviewer pass.',
      verdict: 'PASS',
      subjectTaskId: workTaskId,
      findings: [],
    },
  ],
  qaTarget,
});

export const compose = async (
  paths?: { readonly dataDir: string; readonly casRoot: string },
  faultCheckpoints?: FaultCheckpointPort,
): Promise<Core> => {
  const dataDir = paths?.dataDir ?? tempDir();
  const casRoot = paths?.casRoot ?? tempDir();
  const db = openDurableDatabase({ dataDir, appliedAt: nowIso(), chains: [...CHAINS] });
  trackDatabase(db);
  const foundation = await openArtifactFoundation({
    casRoot,
    database: db,
    logger: nullLogger as never,
  });
  if (!foundation.ok) throw new Error(`artifact foundation failed: ${foundation.error.message}`);
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { reviewKinds: ['e2e7:review'], qaKinds: ['e2e7:qa'] },
    toolPorts: new Map<string, ToolPort>([[VALIDATOR_ID, createValidatorPort()]]),
    ...(faultCheckpoints === undefined ? {} : { faultCheckpoints }),
  });
  if (core === null) throw new Error('production composition failed');
  return core;
};

export const sessionActorOf = async (core: Core): Promise<string> => {
  const assignments = (await core.database.roleAssignments.list({ limit: 10 })).items;
  const actor = assignments[0]?.actorId;
  if (actor === undefined) throw new Error('the production composition provisioned no owner');
  return actor;
};

export interface Started {
  readonly runId: string;
  readonly workTaskId: string;
  readonly reviewTaskId: string;
  readonly review2TaskId: string;
  readonly qaTaskId: string;
}

export const startRun = async (core: Core, actor: string, label: string): Promise<Started> => {
  const template = await core.lifecycle.createTemplate({
    orgId: COMPANY,
    name: `T18-08 ${label}`,
    actorId: actor,
    traceId: `t18f_tpl_${label}`,
  });
  if (!template.ok) throw new Error(template.error.message);
  const graph = {
    nodes: [
      { id: 'work', kind: 'work' as const, title: 'work', config: {} },
      { id: 'review', kind: 'review' as const, title: 'review', config: {} },
      {
        id: 'qa',
        kind: 'qa' as const,
        title: 'qa',
        config: { validatorIds: [VALIDATOR_ID] },
      },
    ],
    edges: [
      { from: 'work', to: 'review' },
      { from: 'review', to: 'qa' },
    ],
  };
  const saved = await core.lifecycle.saveDraftGraph({
    templateId: template.value.id,
    graph,
    actorId: actor,
    traceId: `t18f_graph_${label}`,
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const published = await core.lifecycle.publish({
    templateId: template.value.id,
    actorId: actor,
    traceId: `t18f_pub_${label}`,
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
  const review2 = await createTask({
    runId: run.value.run.id as never,
    stageId: 'review' as never,
    roleId: 'rol_reviewer' as never,
    kind: 'e2e7:review',
    now: nowIso(),
    ids: core.ids,
  });
  const qa = await createTask({
    runId: run.value.run.id as never,
    stageId: 'qa' as never,
    roleId: 'rol_qa' as never,
    kind: 'e2e7:qa',
    now: nowIso(),
    ids: core.ids,
  });
  if (!work.ok || !review.ok || !review2.ok || !qa.ok) throw new Error('task seeding failed');
  await core.database.tasks.put(work.value);
  await core.database.tasks.put(review.value);
  await core.database.tasks.put(review2.value);
  await core.database.tasks.put(qa.value);
  return {
    runId: run.value.run.id,
    workTaskId: work.value.id,
    reviewTaskId: review.value.id,
    review2TaskId: review2.value.id,
    qaTaskId: qa.value.id,
  };
};

export const taskState = async (core: Core, taskId: string): Promise<string> => {
  const task = await core.database.tasks.get(taskId as never);
  return task?.state ?? 'MISSING';
};

export const goalArtifactRefOf = async (core: Core, runId: string): Promise<string> => {
  const store = core.database.artifactStore;
  if (store === null) throw new Error('the production composition has no artifact store');
  const found = await store.getByCreationCommand(runGoalCommandId(runId));
  if (found === null) throw new Error(`run "${runId}" pins no goal artifact`);
  return `artifact:${found.artifact.id}`;
};

export const countOf = (core: Core, sql: string): number =>
  Number((core.database.db.prepare(sql).get() as { c: number | bigint }).c);

export const runSupervisor = (
  core: Core,
  started: Started,
  actor: string,
  identity: string,
  taskId?: string,
): Promise<unknown> => {
  const call = core.autonomousSupervisor?.run({
    companyId: COMPANY,
    runId: started.runId,
    taskId: taskId ?? started.workTaskId,
    reviewTaskId: started.reviewTaskId,
    actorId: actor,
    runIdentity: identity,
  });
  return (call ?? Promise.reject(new Error('no autonomous supervisor'))) as Promise<unknown>;
};

export const goalExists = async (core: Core, runId: string): Promise<boolean> =>
  (await core.database.artifactStore!.getByCreationCommand(runGoalCommandId(runId))) !== null;
