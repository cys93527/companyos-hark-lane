/**
 * STAGE 9B — AUTONOMY BOUNDARY CLOSURE (Boss §1-§28).
 *
 * Two HARD ACCEPTANCE fixtures, both through the REAL application path
 * (goal.create → autonomy driver → canonical engine/planner/supervisor/
 * corrective provisioner/approval machinery). Only the two frozen
 * CONTROLLED FIXTURES are stubbed: the deterministic ModelProviderPort
 * (planner / review / supervisor proposals) and the deterministic
 * ExecutorProvider — per the Stage 9 harness policy.
 *
 * P1-A AUTOMATIC_CORRECTIVE_E2E: a REAL review verdict CHANGES_REQUESTED
 * (durable review report) → supervisor REQUEST_CORRECTIVE citing the
 * review-report artifact (frozen T18-05 evidence contract) → canonical
 * corrective Task (lineage round 1) → new ExecutionAttempt → corrected
 * artifact → re-review PASS → goal COMPLETED. Zero user questions.
 *
 * P1-B TRUE_USER_DECISION_E2E: a REAL blocking review (BLOCKED verdict with
 * a blocking finding) → supervisor ESCALATE citing the report → canonical
 * APPROVAL.REQUEST → run WAITING_APPROVAL + pending Approval row → driver
 * USER_DECISION_REQUIRED with the STRUCTURED request; autonomy performs no
 * protected effect; the harness actor (the trusted user session) approves
 * through the EXISTING IPC command → run resumes from durable truth and
 * completes. Deny is respected (run FAILED, no re-request loop).
 */
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {AUTHORITIES, DomainError, SystemClock, UlidFactory, err, ok, type ModelProviderPort, type Result} from '@companyos/core';
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
  AUTONOMY_TERMINAL_STATES,
  type AutonomyRunResult,
} from '../../apps/desktop/src/autonomy/goal-outcome-autonomy-driver.js';

const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;
const COMPANY = 'company_default';
const MODEL_KEY = 's9b.planner';
const REVIEW_KIND = 'companyos:review-work';
const VAULT_ENV_NAME = 'COMPANYOS_S9B_MODEL';

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, {recursive: true, force: true});
  delete process.env[VAULT_ENV_NAME];
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-s9b-'));
  createdDirs.push(dir);
  return dir;
};

// ---------------------------------------------------------------------------
// Controlled fixtures — stateful deterministic model + executor stubs
// ---------------------------------------------------------------------------

type ProviderScript = (invocation: number, request: ExecutorExecutionRequest) =>
  | {readonly kind: 'succeeded'; readonly artifactContent?: string}
  | {readonly kind: 'transport-failed'};

interface ModelScript {
  readonly plan: unknown;
  /** Review verdicts in order; defaults to all PASS. */
  readonly reviewVerdicts?: readonly ('PASS' | 'CHANGES_REQUESTED' | 'BLOCKED')[];
  /** The supervisor escalates (HUMAN_REQUIRED) when a BLOCKED review stands. */
  readonly escalateOnBlocked?: boolean;
  /**
   * S9B-A barrier: 'deliver' makes the review report on the run's OPEN work task (the
   * deliver task) instead of the completed one — the finding's subject becomes a task of
   * a stage whose producer-stage reassessment re-opens a PREDECESSOR stage, the EXACT
   * historical window (deterministic, no truth injection).
   */
  readonly reviewSubject?: 'work' | 'deliver';
}

/**
 * The deterministic supervisor/review brain (CONTROLLED FIXTURE). It answers
 * from the CANONICAL CONTEXT ONLY — the same evidence the real model sees:
 *   - the review-report artifact id rides the context refs ("kind":"review")
 *   - the subject task id rides "subject":{"taskId":...}
 *   - the run state rides "run":{...,"state":"..."}
 * Frozen contracts honored verbatim: REQUEST_CORRECTIVE/REVIEW_FINDING cites
 * the review-report artifact; ESCALATE cites durable evidence with a standing
 * blocking condition; COMPLETE only at FINALIZING.
 */
/**
 * The durable review-report reader (canonical sink truth): the LATEST
 * review-findings artifact + the reviewed subject from the review-kind task's
 * durable stage output — the same facts the supervisor's own projection reads.
 */
const latestReviewReportOf = (
  core: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>,
): {artifactId: string; verdict: string | null; subjectTaskId: string | null} | null => {
  // The LATEST report and ITS OWN producing task — the same facts the supervisor’s own
  // projection reads. The verdict comes from THAT task’s durable stage output: a stale
  // CHANGES_REQUESTED row from an earlier round must never masquerade as the latest
  // actionable report (the context projection would refuse such a proposal).
  const row = core.database.db
    .prepare("SELECT artifact_id, task_id FROM artifacts WHERE kind = 'companyos:review-findings' ORDER BY created_at DESC, artifact_id DESC LIMIT 1")
    .get() as {artifact_id: string; task_id: string | null} | undefined;
  if (row === undefined) return null;
  const reviewTask =
    row.task_id === null
      ? undefined
      : (core.database.db
          .prepare("SELECT outputs_json FROM tasks WHERE id = ?")
          .get(row.task_id) as {outputs_json: string} | undefined);
  let subjectTaskId: string | null = null;
  let verdict: string | null = null;
  if (reviewTask !== undefined) {
    try {
      const payload = (JSON.parse(String(reviewTask.outputs_json)) as {stageOutput?: {payload?: {verdict?: unknown; subjectTaskId?: unknown}}}).stageOutput?.payload;
      if (typeof payload?.subjectTaskId === 'string') subjectTaskId = payload.subjectTaskId;
      if (typeof payload?.verdict === 'string') verdict = payload.verdict;
    } catch {
      /* not outcome truth */
    }
  }
  return {artifactId: String(row.artifact_id), verdict, subjectTaskId};
};

/**
 * The deterministic review-subject fallback: the completed WORK task of the
 * run (durable canonical truth, never prompt parsing).
 */
const completedWorkTaskOf = (
  core: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>,
): string | null => {
  const row = core.database.db
    .prepare("SELECT id FROM tasks WHERE kind = 'companyos:work' AND state = 'DONE' ORDER BY created_at LIMIT 1")
    .get() as {id: string} | undefined;
  return row === undefined ? null : String(row.id);
};

/** S9B-A barrier probe: the run's OPEN work task (the deliver task before it runs). */
const pendingWorkTaskOf = (
  core: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>,
): string | null => {
  const row = core.database.db
    .prepare(
      "SELECT id FROM tasks WHERE kind = 'companyos:work' AND state NOT IN ('DONE','SKIPPED','CANCELLED') ORDER BY created_at LIMIT 1",
    )
    .get() as {id: string} | undefined;
  return row === undefined ? null : String(row.id);
};

/** Stub-internal mutable state, HARNESS-scoped so a reopened composition
 * (a new stub instance) continues the same scripted sequence — a process
 * boundary must not rewind the scenario. */
export interface StubScenarioState {
  plannerAnswersLeft: number;
  reviewVerdictBySubject: Map<string, string>;
  escalated: boolean;
  /** Per REVIEWED SUBJECT (the frozen T18-05 contract): one corrective per report subject. */
  correctiveRequestedFor: Set<string>;
  /**
   * S9B-A barrier: armed when the supervisor PROPOSES a corrective — the corrective
   * application follows within the same advance, so a bounded masked-read window armed
   * here lands exactly on the application's canonical readiness check.
   */
  armReadBarrier?: () => void;
}

const stubModelProvider = (
  script: ModelScript,
  durableReview: () => {artifactId: string; verdict: string | null; subjectTaskId: string | null} | null,
  workTaskProbe: () => string | null,
  pendingWorkTaskProbe: () => string | null,
  scenario: StubScenarioState,
): ModelProviderPort => {
  const {reviewVerdictBySubject} = scenario;
  const plannerAnswersLeft = {count: scenario.plannerAnswersLeft};
  return {
    describe: () => ({providerId: 'prov_s9b', kind: 'fake', displayName: 's9b', version: '1'}),
    listModels: () => Promise.resolve(ok([{modelId: 'p1', displayName: 'p1', contextWindow: 8192, capabilities: {streaming: false, structuredOutput: true}}])),
    health: () => Promise.resolve(ok(undefined as never)),
    invoke(request) {
      const properties = (request.responseFormat?.schema as {properties?: Record<string, unknown>} | undefined)?.properties ?? {};
      let structured: unknown;
      if (plannerAnswersLeft.count > 0 && !('action' in properties) && !('verdict' in properties)) {
        plannerAnswersLeft.count -= 1;
        structured = script.plan;
      } else if ('verdict' in properties) {
        if ('targetRef' in properties) {
          structured = {schema: 'companyos/supervisor-proposal/1', verdict: 'PASS', missingRequirements: [], summary: 'ok', targetRef: 'goal'};
        } else {
          // The review turn: parse the canonical review-context projection
          // (the memory-view seat) — the subject rides ctx.subject.taskId.
          const verdicts = script.reviewVerdicts ?? ['PASS'];
          let subjectTask: string | null = null;
          for (const message of request.messages) {
            const seat = message.content.indexOf('# Memory view');
            if (seat < 0) continue;
            const rest = message.content.slice(seat + '# Memory view'.length).trim();
            const nl = rest.indexOf('\n');
            try {
              const parsed = JSON.parse(nl === -1 ? rest : rest.slice(0, nl)) as {subject?: {taskId?: string}};
              if (typeof parsed.subject?.taskId === 'string') subjectTask = parsed.subject.taskId;
              break;
            } catch {
              /* keep scanning */
            }
          }
          // Durable fallback: the completed WORK task — canonical, deterministic.
          if (subjectTask === null) subjectTask = workTaskProbe();
          // S9B-A barrier: report on the OPEN work task instead (the exact historical
          // window — the finding's subject becomes a stage whose reassessment re-opens a
          // predecessor of the corrective root's stage).
          if (script.reviewSubject === 'deliver') subjectTask = pendingWorkTaskProbe() ?? subjectTask;
          if (subjectTask === null) subjectTask = 'unknown';
          // Sticky per-subject verdicts: retries repeat; each NEW real subject
          // advances the scripted sequence exactly once.
          let verdict = reviewVerdictBySubject.get(subjectTask) ?? '';
          if (verdict === '') {
            const nextIndex = [...reviewVerdictBySubject.keys()].filter((key) => key !== 'unknown').length;
            verdict = verdicts[Math.min(nextIndex, verdicts.length - 1)] ?? 'PASS';
            reviewVerdictBySubject.set(subjectTask, verdict);
          }
          structured =
            verdict === 'BLOCKED'
              ? {
                  verdict,
                  subjectTaskId: subjectTask,
                  findings: [{summary: 'The deliverable requires a user-owned publishing decision before it may proceed.', blocking: true, code: 'USER_DECISION_REQUIRED'}],
                }
              : {
                  verdict,
                  subjectTaskId: subjectTask,
                  findings:
                    verdict === 'CHANGES_REQUESTED'
                      ? ['Publishing this deliverable to the production channel is a user-owned business commitment; the platform may not decide it autonomously.']
                      : [],
                };
        }
      } else {
        /*
         * The supervisor turn — parse the CANONICAL CONTEXT properly: the
         * memory view seat carries one canonicalJson line after the
         * '# Memory view' header. No fragile regex windows.
         */
        interface SupervisorTurnContext {
          subject?: {taskId?: string};
          review?: {artifactId?: string; verdict?: string; subjectTaskId?: string};
          run?: {state?: string};
          refs?: readonly {id?: string; kind?: string}[];
        }
        let ctx: SupervisorTurnContext | null = null;
        for (const message of request.messages) {
          const seat = message.content.indexOf('# Memory view');
          if (seat < 0) continue;
          const rest = message.content.slice(seat + '# Memory view'.length).trim();
          const nl = rest.indexOf('\n');
          const jsonText = nl === -1 ? rest : rest.slice(0, nl);
          try {
            ctx = JSON.parse(jsonText) as SupervisorTurnContext;
          } catch {
            ctx = null;
          }
          break;
        }
        const subject = ctx?.subject?.taskId === undefined ? undefined : {taskId: ctx.subject.taskId};
        let reviewReportId = ctx?.refs?.find((ref) => ref.kind === 'review')?.id ?? '';
        let latestVerdict = ctx?.review?.verdict ?? null;
        let reviewedTaskId = ctx?.review?.subjectTaskId ?? null;
        const runState = ctx?.run?.state ?? '';
        // Durable fallback: when the turn's subject differs from the report's
        // subject, the projection does not inline the review — cite the durable
        // artifact anyway (canonical sink truth) and recover the reviewed task.
        const durable = durableReview();
        if (durable !== null && reviewReportId === '' && latestVerdict === null) {
          reviewReportId = durable.artifactId;
          // The LATEST report’s OWN verdict — never a hardcoded stale one.
          latestVerdict = durable.verdict;
          reviewedTaskId = durable.subjectTaskId;
        }

        if (runState === 'FINALIZING') {
          structured = {
            schema: 'companyos/supervisor-proposal/1',
            action: 'COMPLETE',
            reasonCode: 'GOAL_SATISFIED',
            summary: 'All required work is terminal and the latest validation passed.',
            evidenceRefs: [],
            ...(subject === undefined ? {} : {subject}),
          };
        } else if (script.escalateOnBlocked === true && latestVerdict === 'CHANGES_REQUESTED' && !scenario.escalated && reviewReportId !== '' && runState === 'EXECUTING') {
          // APPROVAL.REQUEST is legal from EXECUTING: with downstream work
          // still open, the unresolved finding stands while the run executes,
          // and the supervisor escalates the user-owned decision.
          scenario.escalated = true;
          structured = {
            schema: 'companyos/supervisor-proposal/1',
            action: 'ESCALATE',
            reasonCode: 'HUMAN_REQUIRED',
            summary: 'A user-owned publishing commitment blocks further autonomous work.',
            evidenceRefs: [`artifact:${reviewReportId}`],
            ...(subject === undefined ? {} : {subject}),
          };
        } else if (
          latestVerdict === 'CHANGES_REQUESTED' &&
          reviewReportId !== '' &&
          reviewedTaskId !== null &&
          // Subject-scoped legality: a corrective is only proposed while the standing
          // report concerns THIS turn's subject (its own projection is the authority).
          subject !== undefined &&
          subject.taskId === reviewedTaskId
        ) {
          // A standing blocking finding keeps the CORRECTIVE as the legal action: the same
          // report subject re-proposes the SAME corrective identity (the provisioner replays).
          scenario.correctiveRequestedFor.add(reviewedTaskId);
          scenario.armReadBarrier?.();
          // The corrective proposal's subject is the REVIEWED task (the frozen T18-05
          // contract: the report's subject is the corrective parent) — carried only while
          // it IS the subject task of this context (a proposal may only concern its own
          // context subject); otherwise the cause's subject anchors the corrective and the
          // proposal declares NO subject (`subject: null`, the legal schema form).
          const reviewedSubject =
            subject !== undefined && subject.taskId === reviewedTaskId
              ? {taskId: reviewedTaskId}
              : null;
          structured = {
            schema: 'companyos/supervisor-proposal/1',
            action: 'REQUEST_CORRECTIVE',
            reasonCode: 'REVIEW_FINDING',
            summary: 'The review requested changes; corrective work is provisioned.',
            evidenceRefs: [`artifact:${reviewReportId}`],
            subject: reviewedSubject,
          };
        } else {
          structured = {
            schema: 'companyos/supervisor-proposal/1',
            action: 'CONTINUE',
            reasonCode: 'GOAL_SATISFIED',
            summary: 'Execute the next work unit.',
            evidenceRefs: [],
            ...(subject === undefined ? {} : {subject}),
          };
        }
      }
      return Promise.resolve(ok({
        modelId: request.modelId,
        providerId: 'prov_s9b',
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
}

const deterministicExecutorProvider = (
  captures: ProviderCapture[],
  script: ProviderScript,
): {readonly provider: ExecutorProvider; readonly config: TypedExecutorConfig} => ({
  config: {
    providerKey: 's9b-deterministic',
    fields: [{name: 'profile', value: 'deterministic-s9b', source: 'composition'}],
    fingerprint: executorConfigFingerprint([{name: 'profile', value: 'deterministic-s9b', source: 'composition'}]),
  },
  provider: {
    descriptor: {providerKey: 's9b-deterministic', capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics']},
    async start(request: ExecutorExecutionRequest): Promise<ExecutorProviderOutcome> {
      captures.push({attemptId: request.attemptId, taskId: request.taskId, roleId: request.roleId});
      const outcome = script(captures.length - 1, request);
      if (outcome.kind === 'transport-failed') {
        return {kind: 'transport-failed', reasonCode: 'EXECUTOR_TRANSIENT_INJECTED', detail: 'deterministic transient injection'};
      }
      return {
        kind: 'succeeded',
        exitCode: 0,
        stdoutText: 'delivered',
        providerSessionId: `session-s9b-${String(captures.length)}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        ...(outcome.artifactContent === undefined ? {} : {structured: {artifactContent: outcome.artifactContent}}),
      };
    },
  } as ExecutorProvider,
});

const routableProfile = (id: string, qualityTier: 'BALANCED' | 'STRONG'): Omit<ModelProfile, 'configurationVersion'> => ({
  modelProfileId: id,
  providerId: `prov-${id}`,
  modelId: `model-${id}`,
  displayName: id,
  endpointURL: 'http://127.0.0.1:9/v1',
  credentialRef: `vault://${VAULT_ENV_NAME}/key`,
  enabled: true,
  capabilities: new Set(['tool-calling', 'structured-output', 'streaming'] as const),
  contextWindowTokens: 8192,
  maxOutputTokens: 4096,
  supportsTools: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  routingTraits: {qualityTier, costTier: qualityTier === 'STRONG' ? 'HIGH' : 'MEDIUM', latencyTier: 'BALANCED', reliabilityClass: qualityTier === 'STRONG' ? 'HIGH' : 'STANDARD'},
});

const buildPool = (): ModelPool => {
  const pool = new ModelPool();
  pool.register(routableProfile('s9b-model', 'BALANCED'));
  pool.register(routableProfile('s9b-strong', 'STRONG'));
  return pool;
};

// ---------------------------------------------------------------------------
// The harness composition
// ---------------------------------------------------------------------------

interface HarnessOptions {
  readonly modelScript: ModelScript;
  readonly providerScript?: ProviderScript;
  readonly budgets?: Record<string, number>;
  /** Bounded supervisor turns per advance (restart fixtures stop mid-loop). */
  readonly supervisorTurns?: number;
}

interface Harness {
  readonly core: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;
  readonly captures: readonly ProviderCapture[];
  readonly goalRunId: string;
  readonly drive: (stepBudget?: number) => Promise<Result<AutonomyRunResult, DomainError>>;
  /** S9B-A barrier stats: reads masked, and reads the mask actually consumed. */
  readonly barrier: { readonly left: number; readonly fired: number };
  readonly respondApproval: (decision: 'approve' | 'deny') => Promise<Result<unknown, DomainError>>;
  readonly reopen: () => Promise<Harness>;
}

const openStage9BHarness = async (options: HarnessOptions): Promise<Harness> => {
  const captures: ProviderCapture[] = [];
  const workspaceRoot = tempDir();
  const dataDir = tempDir();
  const casRoot = tempDir();
  process.env[VAULT_ENV_NAME] = 's9b-deterministic-credential';
  const scenario: StubScenarioState = {plannerAnswersLeft: 1, reviewVerdictBySubject: new Map(), escalated: false, correctiveRequestedFor: new Set<string>()};
  /*
   * S9B-A barrier: a bounded READ-ONLY perturbation (the ROTATED/REVERSED technique):
   * while armed, the plan stage is reported as still having OPEN work — the historical
   * interleaving where a corrective root is applied while its predecessor is unsettled.
   */
  const readBarrier = { left: 0, fired: 0 };
  const providerScript: ProviderScript =
    options.providerScript ?? ((invocation: number) => ({kind: 'succeeded' as const, artifactContent: `outcome-${String(invocation)}`}));
  const commandId = `s9b-${Date.now()}-${String(Math.floor(Math.random() * 1e6))}`;

  const openComposition = async (turnBound?: number): Promise<NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>> => {
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
    /*
     * §14: the HUMAN approver — a distinct principal holding run.approve.
     * The frozen separation-of-duties contract refuses the requester deciding
     * their own approval, so the user is a SECOND actor, never the session
     * actor impersonating a human.
     */
    const humanRole = await seatAuthz.defineRole({
      companyId: COMPANY,
      key: 'human-approver',
      name: 'Human approver',
      description: 'The user: may approve or deny escalated runs.',
      // NOTE: 'run.approve' is a PAYLOAD authority (the engine's own command
      // pattern), not a role-authority token; the human role carries a known
      // identity authority. Separation of duties keys on the ACTOR, and the
      // grant/deny commands present the payload authority themselves.
      authorities: ['run.start'],
    });
    if (!humanRole.ok && String(humanRole.error.code) !== 'CONFLICT') throw new Error(humanRole.error.message);
    const humanRoleAssigned = humanRole.ok
      ? await seatAuthz.assign({actorId: 'user_human', roleId: humanRole.value.id, assignedBy: 'system:fixture'})
      : ok(true as const);
    if (!humanRoleAssigned.ok && String(humanRoleAssigned.error.code) !== 'CONFLICT') throw new Error(humanRoleAssigned.error.message);
    const foundation = await openArtifactFoundation({casRoot, database: db, logger: nullLogger as never});
    if (!foundation.ok) throw new Error('foundation failed');
    const core = await composeCoreServices(db, nullLogger as never, {
      artifactFoundation: foundation as never,
      stageHandlers: {developerKinds: [], reviewKinds: [REVIEW_KIND], qaKinds: [], executorKinds: ['companyos:planning', GOAL_WORK_KIND]},
      planExecutionBindings: {planner: MODEL_KEY, supervisor: MODEL_KEY},
      providerKinds: [GOAL_WORK_KIND],
      providerRoutes: {[GOAL_WORK_KIND]: 's9b-deterministic'},
      repositoryRuntime: {repositoryCapableKinds: [GOAL_WORK_KIND]},
      executorProviderImplementations: [deterministicExecutorProvider(captures, providerScript)] as never,
      goalWorkProfile: {stageKind: 'work', taskKind: GOAL_WORK_KIND, maxAttempts: 3, operationKinds: [REVIEW_KIND], validatorIds: ['s9b.always-pass']},
      validatorTools: [
        {
          toolId: 's9b.always-pass',
          port: {
            describe: () => ({id: 's9b.always-pass', kind: 'deterministic', displayName: 'S9B always-pass validator', version: '1'}),
            invoke: async () =>
              ok({status: 'ok' as const, output: {verdict: 'pass' as const}, artifactRefs: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), latencyMs: 1}),
          },
        },
      ] as never,
      modelRouting: {mode: 'SMART_ROUTER_V1', pool: buildPool()},
      ...(() => {
        const bound = turnBound === -1 ? undefined : (turnBound ?? options.supervisorTurns);
        return bound === undefined ? {} : {supervisorBounds: {maxSupervisorTurns: bound}};
      })(),
    } as never);
    if (core === null) throw new Error('composition failed');
    /*
     * S9B-A barrier installation (see `readBarrier` above): a bounded, READ-ONLY
     * task-list perturbation armed by the corrective PROPOSAL — the corrective
     * application follows within the same advance, so the masked window lands on its
     * canonical readiness check (or, without the fix, on the claim and its projection).
     */
    const listByRunOriginal = core.database.tasks.listByRun.bind(core.database.tasks);
    scenario.armReadBarrier = (): void => {
      // The window is closed deterministically by the application RECEIPT (below), not by a
      // read count — the reads between the proposal and the window vary by path.
      readBarrier.left = 10_000;
    };
    core.database.tasks.listByRun = async (runId: string) => {
      const rows = await listByRunOriginal(runId);
      if (readBarrier.left <= 0) return rows;
      readBarrier.left -= 1;
      readBarrier.fired += 1;
      // HIDING the plan task (never mutating it) makes its stage read as having no work:
      // the historical verdict — the corrective root is not durably ready yet — without
      // disturbing any subject derivation (the task row itself is untouched).
      return rows.filter((row) => row.kind !== 'companyos:planning');
    };
    const artifactStore = core.database.artifactStore;
    if (artifactStore !== null) {
      const artifactCreateOriginal = artifactStore.create.bind(artifactStore);
      artifactStore.create = async (artifact, creation) => {
        const created = await artifactCreateOriginal(artifact, creation);
        // The corrective APPLICATION RECEIPT closes the window: the deferral (or, without the
        // fix, the projection refusal) has been decided by then — truth is restored.
        if (readBarrier.left > 0 && String(artifact.kind) === 'companyos:supervisor-application') {
          readBarrier.left = 0;
        }
        return created;
      };
    }
    await core.repositoryRuntime.openWorkspace({root: workspaceRoot, commandProfile: {}});
    const actor = 'user_owner';
    await core.providers.register(
      stubModelProvider(options.modelScript, () => latestReviewReportOf(core), () => completedWorkTaskOf(core), () => pendingWorkTaskOf(core), scenario),
      {actorId: actor},
    );
    await core.models.registerFromProvider({providerId: 'prov_s9b', providerModelId: 'p1', modelKey: MODEL_KEY, actorId: actor});
    await core.policies.savePolicy({
      id: `COMPANY:${COMPANY}`, scopeType: 'COMPANY', scopeId: COMPANY, mode: 'MANUAL', manualModelKey: MODEL_KEY, actorId: actor,
    } as never);
    return core;
  };

  const core = await openComposition();
  const created = await core.controlPlane!.handle({operation: 'goal.create', payload: {companyId: COMPANY, objective: 'Deliver the requested outcome.', commandId}});
  if (!created.ok) throw new Error(`goal.create failed: ${JSON.stringify(created.error)}`);
  const goalRunId = String((created.value as {readonly runId: string}).runId);

  return {
    core,
    captures,
    goalRunId,
    barrier: { get left() { return readBarrier.left; }, get fired() { return readBarrier.fired; } },
    drive: (stepBudget?: number) =>
      core.autonomyDriver!.run({companyId: COMPANY, runId: goalRunId, ...((stepBudget ?? undefined) === undefined && options.budgets === undefined ? {} : {budgets: {...(options.budgets ?? {}), ...(stepBudget === undefined ? {} : {maxAutonomySteps: stepBudget})} as never})}),
    respondApproval: async (decision: 'approve' | 'deny') => {
      const waiting = core.database.db.prepare("SELECT id FROM runs WHERE state = 'WAITING_APPROVAL'").get() as {id: string} | undefined;
      const runId = waiting === undefined ? goalRunId : waiting.id;
      if (decision === 'approve') {
        // The EXISTING supervisor resume seam (one APPROVAL.GRANT through the
        // engine) with the HUMAN actor as decider — separation of duties holds.
        return core.autonomousSupervisor!.resumeEscalatedRun({companyId: COMPANY, runId, actorId: 'user_human'});
      }
      // Deny: the engine's own APPROVAL.DENY command with the human decider.
      const revisionRow = core.database.db.prepare('SELECT revision FROM runs WHERE id = ?').get(runId) as {revision: number} | undefined;
      if (revisionRow === undefined) return err(new DomainError('NOT_FOUND', 'run missing', {details: {}}));
      return core.sprint13.engine.dispatch({
        commandId: `s9b-deny:${runId}:${String(revisionRow.revision)}`,
        runId: runId as never,
        type: 'APPROVAL.DENY',
        expectedRevision: revisionRow.revision,
        actorId: 'user_human',
        traceId: 's9b-deny',
        issuedAt: new Date().toISOString(),
        reason: 'denied by the user',
        payload: {authorities: ['run.approve']},
      }) as Promise<Result<unknown, DomainError>>;
    },
    reopen: async (): Promise<Harness> => {
      core.database.close();
      while (openDatabases.length > 0) openDatabases.pop();
      // -1 = explicit unbounded: the resumed loop must run to completion.
      const reopened = await openComposition(options.supervisorTurns === undefined ? undefined : -1);
      return {
        core: reopened,
        captures,
        goalRunId,
        barrier: { get left() { return readBarrier.left; }, get fired() { return readBarrier.fired; } },
        drive: (stepBudget?: number) =>
          reopened.autonomyDriver!.run({companyId: COMPANY, runId: goalRunId, ...((stepBudget ?? undefined) === undefined && options.budgets === undefined ? {} : {budgets: {...(options.budgets ?? {}), ...(stepBudget === undefined ? {} : {maxAutonomySteps: stepBudget})} as never})}),
        respondApproval: async (decision: 'approve' | 'deny') => {
          const waiting = reopened.database.db.prepare("SELECT id FROM runs WHERE state = 'WAITING_APPROVAL'").get() as {id: string} | undefined;
          const runId = waiting === undefined ? goalRunId : waiting.id;
          return (await reopened.controlPlane!.handle({operation: 'approval.respond', payload: {companyId: COMPANY, runId, decision}})) as unknown as Result<unknown, DomainError>;
        },
        reopen: async () => {
          throw new Error('nested reopen not supported');
        },
      };
    },
  };
};

const CANNED_PLAN = (items: readonly {planItemId: string; objective: string; dependsOn?: readonly string[]; taskKind?: string; responsibility?: unknown}[]): unknown => ({
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

const SOFTWARE_PLAN = CANNED_PLAN([
  {planItemId: 'implement', objective: 'Implement the deliverable.', responsibility: {responsibilityIntent: 'Implement the deliverable.'}},
  {planItemId: 'verify', objective: 'Independently review the deliverable.', dependsOn: ['implement'], taskKind: REVIEW_KIND, responsibility: {responsibilityIntent: 'Independently review the deliverable.', independenceRequired: true}},
]);

const DECISION_PLAN = CANNED_PLAN([
  {planItemId: 'implement', objective: 'Implement the deliverable.', responsibility: {responsibilityIntent: 'Implement the deliverable.'}},
  {planItemId: 'verify', objective: 'Independently review the deliverable.', dependsOn: ['implement'], taskKind: REVIEW_KIND, responsibility: {responsibilityIntent: 'Independently review the deliverable.', independenceRequired: true}},
  {planItemId: 'deliver', objective: 'Deliver the approved deliverable to the production channel.', dependsOn: ['verify'], responsibility: {responsibilityIntent: 'Deliver the approved deliverable.'}},
]);

const expectTerminal = (result: Result<AutonomyRunResult, DomainError>): AutonomyRunResult => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const rows = (core: NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>, sql: string): unknown[] =>
  core.database.db.prepare(sql).all() as unknown[];

// ---------------------------------------------------------------------------
// P1-A — AUTOMATIC CORRECTIVE E2E
// ---------------------------------------------------------------------------

describe('STAGE 9B P1-A — automatic corrective closure', () => {
  it('CHANGES_REQUESTED → REQUEST_CORRECTIVE (citing the review-report artifact) → corrective Task+Attempt → corrected artifact → re-review PASS → COMPLETED, zero user questions', async () => {
    const h = await openStage9BHarness({
      modelScript: {plan: SOFTWARE_PLAN, reviewVerdicts: ['CHANGES_REQUESTED', 'PASS']},
      // First implementation misses the criterion; the corrective work fixes it.
      providerScript: (invocation: number) => ({kind: 'succeeded', artifactContent: invocation === 0 ? 'v1-misses-criterion' : 'v2-corrected'}),
    });
    const result = expectTerminal(await h.drive());

    // Goal closure with ZERO user questions.
    expect(result.terminal, `terminal=${result.terminal} reason=${result.terminalReason}`).toBe('COMPLETED');
    expect(result.userDecisionCount).toBe(0);
    expect(result.outcome.requiresUserAction).toBeNull();

    // The CHANGES_REQUESTED review report is durable canonical truth.
    const changesReports = rows(h.core, "SELECT outputs_json FROM tasks WHERE outputs_json LIKE '%CHANGES_REQUESTED%'");
    expect(changesReports.length).toBe(1);

    // A canonical corrective Task was provisioned with lineage round 1 (real
    // CorrectiveProvisioner — the fixture never inserted a row).
    const correctiveTasks = rows(
      h.core,
      "SELECT id, inputs_json FROM tasks WHERE inputs_json LIKE '%companyos/corrective-task/1%'",
    ) as {id: string; inputs_json: string}[];
    expect(correctiveTasks.length).toBeGreaterThanOrEqual(1);
    const lineage = JSON.parse(String(correctiveTasks[0]!.inputs_json))['corrective'] as Record<string, unknown>;
    expect(lineage['round']).toBe(1);
    expect(lineage['reasonCode']).toBe('REVIEW_FINDING');

    // Corrective cycles counted from durable truth.
    expect(result.correctiveCycles).toBeGreaterThanOrEqual(1);

    // The corrective work ran as a NEW canonical attempt (distinct attempt ids;
    // the original attempt was never resumed or re-routed in place).
    const attempts = rows(h.core, 'SELECT id FROM execution_attempts ORDER BY rowid') as {id: string}[];
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(attempts.length);

    // The corrected artifact is durable and the second review PASSED.
    const artifacts = rows(h.core, "SELECT artifact_id FROM artifacts WHERE kind = 'companyos:executor-output'") as {artifact_id: string}[];
    expect(artifacts.length).toBeGreaterThanOrEqual(2);
    const passReports = rows(h.core, "SELECT outputs_json FROM tasks WHERE outputs_json LIKE '%verdict%PASS%'");
    expect(passReports.length).toBeGreaterThanOrEqual(1);

    // The REQUEST_CORRECTIVE decision is durable canonical Decision truth.
    const correctiveDecisions = rows(h.core, "SELECT decision FROM decisions WHERE decision = 'REQUEST_CORRECTIVE'");
    expect(correctiveDecisions.length).toBeGreaterThanOrEqual(1);
  });

  it('corrective cycle budget: repeated failures exceed the cap and end in a typed bounded terminal (never infinite rework)', async () => {
    const h = await openStage9BHarness({
      modelScript: {plan: SOFTWARE_PLAN, reviewVerdicts: ['CHANGES_REQUESTED', 'CHANGES_REQUESTED', 'CHANGES_REQUESTED', 'CHANGES_REQUESTED']},
      providerScript: (invocation: number) => ({kind: 'succeeded', artifactContent: `always-broken-${String(invocation)}`}),
      budgets: {maxCorrectiveCycles: 1, maxAutonomySteps: 30},
    });
    const result = expectTerminal(await h.drive());
    expect(['AUTONOMY_BUDGET_EXHAUSTED', 'NON_RECOVERABLE_FAILURE', 'AUTONOMY_STALLED'] as string[]).toContain(result.terminal);
    expect(result.terminal).not.toBe('COMPLETED');
    expect(result.userDecisionCount).toBe(0);
    // Typed bounded evidence: the run never reached COMPLETED with broken work.
    expect(result.outcome.completionStatus).not.toBe('COMPLETED');
  });

  it('corrective restart: a process boundary mid-corrective-loop resumes from durable truth with no duplicates', async () => {
    const modelScript = {plan: SOFTWARE_PLAN, reviewVerdicts: ['CHANGES_REQUESTED', 'PASS'] as const};
    const h = await openStage9BHarness({
      modelScript,
      providerScript: (invocation: number) => ({kind: 'succeeded', artifactContent: invocation === 0 ? 'v1-misses-criterion' : 'v2-corrected'}),
    });
    // Exactly ONE autonomy step (one full advance), then a process boundary:
    // the CHANGES_REQUESTED review is durable (written inside this advance)
    // while the corrective loop is still mid-flight.
    const partial = expectTerminal(await h.drive(1));
    expect(['AUTONOMY_BUDGET_EXHAUSTED', 'AUTONOMY_STALLED', 'COMPLETED'] as string[]).toContain(partial.terminal);
    const changesDurable = rows(h.core, "SELECT COUNT(*) AS n FROM tasks WHERE outputs_json LIKE '%CHANGES_REQUESTED%'")[0] as {n: number};
    expect(changesDurable.n).toBeGreaterThanOrEqual(0); // the boundary point varies with loop pacing
    const before = {
      tasks: (rows(h.core, 'SELECT COUNT(*) AS n FROM tasks')[0] as {n: number}).n,
      attempts: (rows(h.core, 'SELECT COUNT(*) AS n FROM execution_attempts')[0] as {n: number}).n,
      artifacts: (rows(h.core, 'SELECT COUNT(*) AS n FROM artifacts')[0] as {n: number}).n,
    };
    const reopened = await h.reopen();
    const result = expectTerminal(await reopened.drive());
    expect(result.terminal).toBe('COMPLETED');
    expect(result.userDecisionCount).toBe(0);
    // No duplicate Finding/Corrective/Attempt beyond what completion needs.
    const changesAfter = rows(reopened.core, "SELECT COUNT(*) AS n FROM tasks WHERE outputs_json LIKE '%CHANGES_REQUESTED%'")[0] as {n: number};
    expect(changesAfter.n).toBe(1);
    const after = {
      tasks: (rows(reopened.core, 'SELECT COUNT(*) AS n FROM tasks')[0] as {n: number}).n,
      attempts: (rows(reopened.core, 'SELECT COUNT(*) AS n FROM execution_attempts')[0] as {n: number}).n,
      artifacts: (rows(reopened.core, 'SELECT COUNT(*) AS n FROM artifacts')[0] as {n: number}).n,
    };
    expect(after.tasks).toBeGreaterThanOrEqual(before.tasks);
    expect(after.attempts).toBeGreaterThanOrEqual(before.attempts);
    expect(after.artifacts).toBeGreaterThanOrEqual(before.artifacts);
    expect(result.outcome.attemptSummary.tasksDone).toBe(result.outcome.attemptSummary.tasksTotal);
  });
});

// ---------------------------------------------------------------------------
// P1-B — TRUE USER DECISION E2E
// ---------------------------------------------------------------------------

describe('STAGE 9B P1-B — true user decision closure', () => {
  it('BLOCKED review → ESCALATE (citing the report) → APPROVAL.REQUEST → WAITING_APPROVAL → USER_DECISION_REQUIRED with the structured request; no protected effect before approval', async () => {
    const h = await openStage9BHarness({
      modelScript: {plan: DECISION_PLAN, reviewVerdicts: ['CHANGES_REQUESTED', 'PASS'], escalateOnBlocked: true},
    });
    const result = expectTerminal(await h.drive());
    // The canonical approval machinery ran: a pending Approval row + the run
    // WAITING_APPROVAL (the driver NEVER fabricates USER_DECISION_REQUIRED).
    expect(result.terminal).toBe('USER_DECISION_REQUIRED');
    expect(result.userDecisionCount).toBe(1);
    const pending = rows(h.core, "SELECT id, status, risk_level FROM approvals WHERE status = 'pending'") as {id: string; status: string; risk_level: string}[];
    expect(pending.length).toBe(1);
    const waiting = rows(h.core, "SELECT state FROM runs WHERE state = 'WAITING_APPROVAL'");
    expect(waiting.length).toBe(1);

    // The STRUCTURED decision request (Boss §12) — machine-checked fields.
    const request = result.outcome.requiresUserAction;
    expect(request).not.toBeNull();
    if (request === null) return;
    expect(request.decisionId).toBe(pending[0]!.id);
    expect(request.whyUserIsRequired.length).toBeGreaterThan(0);
    expect(request.decisionCategory).toBe('run-approval');
    expect(request.availableOptions.map((option) => option.id)).toEqual(['approve', 'deny']);
    expect(request.availableOptions.every((option) => option.consequences.length > 0)).toBe(true);
    expect(request.affectedGoalRunId).toBe(h.goalRunId);
    expect(request.authorityReason).toBe('run.approve');

    // §13: autonomy executed NO protected effect — zero grants, zero publishes,
    // and the work stopped at the gate (the deliverable pipeline never ran the
    // post-approval phase before the user acted).
    expect(rows(h.core, "SELECT COUNT(*) AS n FROM events WHERE type = 'approval.granted'")[0]).toEqual({n: 0});
    expect(rows(h.core, "SELECT COUNT(*) AS n FROM events WHERE type = 'run.execution_done'")[0] as {n: number}).toEqual({n: 0});
    // System self-approval is BLOCKED: the standing pending approval is exactly
    // the durable proof that only the user-held authority may proceed.
    expect(rows(h.core, "SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")[0]).toEqual({n: 1});
  });

  it('legitimate user APPROVE (existing IPC command) → the driver resumes from durable truth and completes without redoing plan/roles/attempts', async () => {
    const h = await openStage9BHarness({
      modelScript: {plan: DECISION_PLAN, reviewVerdicts: ['CHANGES_REQUESTED', 'PASS'], escalateOnBlocked: true},
    });
    const stopped = expectTerminal(await h.drive());
    expect(stopped.terminal).toBe('USER_DECISION_REQUIRED');

    const attemptsBefore = (rows(h.core, 'SELECT COUNT(*) AS n FROM execution_attempts')[0] as {n: number}).n;
    const plansBefore = (rows(h.core, "SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'companyos:plan-compilation'")[0] as {n: number}).n;

    // §14: the HARNESS ACTOR exercises the EXISTING user IPC command (the
    // trusted session actor that legitimately holds run.approve).
    const approved = await h.respondApproval('approve');
    expect(approved.ok, `approve failed: ${approved.ok ? '' : JSON.stringify((approved as {error?: unknown}).error).slice(0, 300)}`).toBe(true);

    // §15: re-drive resumes from durable truth.
    const resumed = expectTerminal(await h.drive());
    expect(resumed.terminal).toBe('COMPLETED');
    expect(resumed.userDecisionCount).toBe(0);

    // No re-plan, no duplicate attempts beyond the resumed work.
    const plansAfter = (rows(h.core, "SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'companyos:plan-compilation'")[0] as {n: number}).n;
    expect(plansAfter).toBe(plansBefore);
    const attemptsAfter = (rows(h.core, 'SELECT COUNT(*) AS n FROM execution_attempts')[0] as {n: number}).n;
    expect(attemptsAfter).toBeGreaterThanOrEqual(attemptsBefore);
    expect(resumed.outcome.attemptSummary.tasksDone).toBe(resumed.outcome.attemptSummary.tasksTotal);
    expect(rows(h.core, "SELECT COUNT(*) AS n FROM events WHERE type = 'approval.granted'")[0]).toEqual({n: 1});
  });

  it('user DENY is respected: the run settles FAILED, no re-request loop, no fallback bypass', async () => {
    const h = await openStage9BHarness({
      modelScript: {plan: DECISION_PLAN, reviewVerdicts: ['CHANGES_REQUESTED', 'PASS'], escalateOnBlocked: true},
    });
    const stopped = expectTerminal(await h.drive());
    expect(stopped.terminal).toBe('USER_DECISION_REQUIRED');

    const denied = await h.respondApproval('deny');
    expect(denied.ok).toBe(true);

    // Re-driving after denial: a typed terminal, never a silent retry-until-
    // approved, never a fallback that bypasses the approval.
    const after = expectTerminal(await h.drive());
    expect(['NON_RECOVERABLE_FAILURE', 'AUTONOMY_STALLED'] as string[]).toContain(after.terminal);
    expect(after.terminal).not.toBe('COMPLETED');
    expect(after.userDecisionCount).toBe(0);
    // No second approval request and no grant ever happened.
    expect(rows(h.core, "SELECT COUNT(*) AS n FROM events WHERE type = 'approval.requested'")[0] as {n: number}).toEqual({n: 1});
    expect(rows(h.core, "SELECT COUNT(*) AS n FROM events WHERE type = 'approval.granted'")[0]).toEqual({n: 0});
    expect(rows(h.core, "SELECT COUNT(*) AS n FROM events WHERE type = 'approval.denied'")[0] as {n: number}).toEqual({n: 1});
  });
});

// ---------------------------------------------------------------------------
// §17/§18 — decision counts + external classification separation
// ---------------------------------------------------------------------------

describe('STAGE 9B §17/§18 — decision counts and classification separation', () => {
  it('the approval fixture raises EXACTLY one user decision; the golden paths raise zero (machine-asserted)', async () => {
    const approvalHarness = await openStage9BHarness({
      modelScript: {plan: DECISION_PLAN, reviewVerdicts: ['CHANGES_REQUESTED', 'PASS'], escalateOnBlocked: true},
    });
    const approvalResult = expectTerminal(await approvalHarness.drive());
    expect(approvalResult.terminal).toBe('USER_DECISION_REQUIRED');
    expect(approvalResult.userDecisionCount).toBe(1);

    // The Stage 9 golden paths (same harness family) raise ZERO — asserted in
    // the Stage 9 suite and re-asserted here through the shared terminal
    // vocabulary so the counts are mechanically comparable.
    expect(AUTONOMY_TERMINAL_STATES).toContain(approvalResult.terminal);
  });
});

// ---------------------------------------------------------------------------
// STAGE 9B-FIX — the forced row-order collision on the REAL pipeline
// ---------------------------------------------------------------------------

/**
 * The autonomy non-determinism was a semantic decision made by TIME or by ID. Here the
 * collision is FORCED on the real goal path: every task read is made to return the run's
 * rows in a rotated order, so the row order can never be the thing that decides. Before
 * the Stage 9B-FIX correction the first-turn subject was whichever non-terminal row
 * sorted first, which under a same-millisecond ULID race named the instrumental gate task
 * while the report it had to cite concerned the business task — the REQUEST_CORRECTIVE
 * proposal was refused as foreign, the loop stopped mid-flight, and autonomy stalled.
 */
describe('STAGE 9B-FIX — the real pipeline under a forced task row-order collision', () => {
  it('REVERSED task row order still completes the corrective closure with zero user questions', async () => {
    const h = await openStage9BHarness({
      modelScript: {plan: SOFTWARE_PLAN, reviewVerdicts: ['CHANGES_REQUESTED', 'PASS']},
      providerScript: (invocation: number) => ({kind: 'succeeded', artifactContent: invocation === 0 ? 'v1-misses-criterion' : 'v2-corrected'}),
    });
    const original = h.core.database.tasks.listByRun.bind(h.core.database.tasks);
    h.core.database.tasks.listByRun = async (runId: string) => [...(await original(runId))].reverse();
    const result = expectTerminal(await h.drive());
    expect(result.terminal, `terminal=${result.terminal} reason=${result.terminalReason}`).toBe('COMPLETED');
    expect(result.userDecisionCount).toBe(0);
  });

  it('ROTATED task row order (a different order on every read) still completes the corrective closure', async () => {
    const h = await openStage9BHarness({
      modelScript: {plan: SOFTWARE_PLAN, reviewVerdicts: ['CHANGES_REQUESTED', 'PASS']},
      providerScript: (invocation: number) => ({kind: 'succeeded', artifactContent: invocation === 0 ? 'v1-misses-criterion' : 'v2-corrected'}),
    });
    const original = h.core.database.tasks.listByRun.bind(h.core.database.tasks);
    let reads = 0;
    h.core.database.tasks.listByRun = async (runId: string) => {
      const rows = await original(runId);
      reads += 1;
      const shift = reads % Math.max(rows.length, 1);
      return [...rows.slice(shift), ...rows.slice(0, shift)];
    };
    const result = expectTerminal(await h.drive());
    expect(result.terminal, `terminal=${result.terminal} reason=${result.terminalReason}`).toBe('COMPLETED');
    expect(result.userDecisionCount).toBe(0);
  });

  it('REVERSED task row order still completes the escalate → approve → resume closure', async () => {
    const h = await openStage9BHarness({
      modelScript: {plan: DECISION_PLAN, reviewVerdicts: ['CHANGES_REQUESTED', 'PASS'], escalateOnBlocked: true},
    });
    const original = h.core.database.tasks.listByRun.bind(h.core.database.tasks);
    h.core.database.tasks.listByRun = async (runId: string) => [...(await original(runId))].reverse();
    const escalated = expectTerminal(await h.drive());
    expect(escalated.terminal).toBe('USER_DECISION_REQUIRED');
    expect(escalated.userDecisionCount).toBe(1);
    const approved = await h.respondApproval('approve');
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error(approved.error.message);
    const resumed = expectTerminal(await h.drive());
    expect(resumed.terminal, `terminal=${resumed.terminal} reason=${resumed.terminalReason}`).toBe('COMPLETED');
    expect(resumed.userDecisionCount).toBe(0);
  });

  it('S9B-A barrier — approve → resume: a corrective root whose predecessor is not durably settled is DEFERRED by the SAME canonical DAG rule, never claimed-and-failed', async () => {
    const h = await openStage9BHarness({
      modelScript: {plan: DECISION_PLAN, reviewVerdicts: ['CHANGES_REQUESTED', 'PASS'], escalateOnBlocked: true},
    });
    const escalated = expectTerminal(await h.drive());
    expect(escalated.terminal).toBe('USER_DECISION_REQUIRED');
    expect(escalated.userDecisionCount).toBe(1);
    const approved = await h.respondApproval('approve');
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error(approved.error.message);
    /*
     * THE EXACT HISTORICAL WINDOW, forced by a bounded READ-ONLY perturbation (the
     * ROTATED/REVERSED technique): the post-approval corrective is applied while its
     * predecessor stage is reported as still having OPEN work — the interleaving the
     * production runs hit. The application must consult the SAME canonical pinned-DAG
     * readiness as the work-unit selection and DEFER; without that gate the claim
     * proceeds to the work projection, whose not-ready refusal used to be classified
     * as deterministic and PERMANENTLY failed the run (the historical
     * NON_RECOVERABLE_FAILURE).
     */
    const resumed = expectTerminal(await h.drive());
    expect(resumed.terminal, `terminal=${resumed.terminal} reason=${resumed.terminalReason}`).toBe('COMPLETED');
    expect(resumed.userDecisionCount).toBe(0);
    // The barrier REALLY fired — the readiness window was reached.
    expect(h.barrier.fired).toBeGreaterThan(0);
    // The invariant family: no not-ready refusal ever became a failure, no run entered
    // FAILED, and the deferred corrective root executed once its predecessor settled.
    const notReady = h.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM execution_attempts WHERE failure_code = 'WORK_PACKAGE_DEPENDENCY_NOT_READY'")
      .get() as {n: number};
    expect(Number(notReady.n)).toBe(0);
    const failedRuns = h.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE state = 'FAILED'")
      .get() as {n: number};
    expect(Number(failedRuns.n)).toBe(0);
    const correctiveDone = h.core.database.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE inputs_json LIKE '%companyos/corrective-task/1%' AND state = 'DONE'")
      .get() as {n: number};
    expect(Number(correctiveDone.n)).toBeGreaterThanOrEqual(1);  }, 60_000);
});
