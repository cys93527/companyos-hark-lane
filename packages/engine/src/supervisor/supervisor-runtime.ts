/**
 * Supervisor decision runtime (Sprint 18 / Task-18-06).
 *
 * ONE bounded Supervisor decision turn:
 *
 *   load trusted Run → load canonical Goal → verify RunSnapshot → resolve the pinned binding
 *   → build a bounded SupervisorContext → create a durable AgentExecution → invoke the model
 *   ONCE with a structured contract → strictly parse → validate the proposal semantically →
 *   record the Decision through the T18-03 sink → complete the AgentExecution.
 *
 * Frozen rulings this file implements (ADR-0029 + T18-06 spec):
 *   - it DOES NOT execute the Decision: no provisioning, no engine advance, no approval, no
 *     completion, no notification (T18-07 owns execution semantics);
 *   - it is NOT a second Decision writer: every Decision goes through the T18-03 sink;
 *   - it is generic and pack-neutral: no pack id, role name or task kind is ever inspected;
 *   - the model comes ONLY from the RunSnapshot-pinned binding, named by trusted configuration;
 *     there is no default, no latest, no fallback and no caller-supplied model identity;
 *   - the Supervisor model sees NO tools and can spawn NOTHING: no tool descriptors are
 *     declared, no tool round is run, no repository tool is reachable and this module holds no
 *     tool dependency at all (structural, not a prompt rule — ZCode constraint #2);
 *   - the whole turn is bounded and cancellable: one AbortSignal and one deadline cover
 *     loading, verification, context assembly, binding resolution, execution setup, the model
 *     call, parsing, validation and the Decision write (ZCode constraint #1);
 *   - the context is an ephemeral deterministic projection of durable state with refs, never
 *     chat history, never unbounded.
 *
 * What this file deliberately does NOT contain: no loop (`while`, `for` over turns), no
 * `maxCorrectiveRounds` policy (T18-07), no escalation runtime beyond recording an ESCALATE
 * Decision, no approval/human state, no IPC surface, no shell access and no hook system.
 */
import {
  CORRECTIVE_TASK_CAUSES,
  RUN_GOAL_MAX_OBJECTIVE_CHARS,
  UNPINNABLE_AVAILABILITY,
  DomainError,
  canonicalJson,
  domainError,
  err,
  FaultCrashError,
  normalizeExecutionError,
  ok,
  type Clock,
  type DecisionRecord,
  type EntityStore,
  type IdFactory,
  type Result,
  type Task,
  type Validation,
  type WorkflowRun,
  FAULT_CHECKPOINTS,
  type FaultCheckpointPort,
  ID_PREFIX,
} from '@companyos/core';

import type { AgentRuntimeService, AgentRunOutcome } from '../runtime/agent-runtime.js';
import type { RunGoalReader } from '../goal/run-goal-service.js';
import type {
  RunModelBindingReader,
  RunModelBindingResolver,
} from '../lifecycle/run-model-bindings.js';
import type { RunSnapshotVerifier } from '../lifecycle/run-snapshot-verifier.js';
import {
  SUPERVISOR_DECISION_ACTIONS,
  SUPERVISOR_DECISION_COMMAND_PREFIX,
  SUPERVISOR_DECISION_REASONS,
  SUPERVISOR_DECISION_SCHEMA,
  type SupervisorDecisionAction,
  type SupervisorDecisionReason,
  type SupervisorDecisionSink,
} from './decision-sink.js';

/* ------------------------------------------------------------------ context bounds */

export const SUPERVISOR_CONTEXT_LIMITS = {
  maxDecisions: 20,
  maxFindingsPerReview: 20,
  maxEvidenceRefs: 32,
  maxSummaryChars: 400,
  maxObjectiveChars: RUN_GOAL_MAX_OBJECTIVE_CHARS,
  /**
   * The rendered context rides the prompt's `memoryView` seat, whose Core limit is 20 000
   * characters. 16 KiB of UTF-8 is at most 16 384 characters, so a context this runtime
   * accepted can never be rejected by the seat it is placed in: the bound is derived from the
   * seat, never chosen independently.
   */
  maxContextBytes: 16 * 1024,
  maxLineageDepth: 16,
  /** The bounded prompt pieces the runtime assembles around the context projection. */
  maxInstructions: 8,
  maxConstraints: 16,
  maxDecisionViewEntries: 24,
} as const;

/**
 * The default whole-turn deadline. A bound exists so a hung provider cannot hang a caller
 * forever; the caller may tighten it, never widen it (see `maxTimeoutMs`).
 */
export const SUPERVISOR_TURN_TIMEOUT_MS = 120_000;

/** The versioned proposal envelope the model must return (strict, no repair). */
export const SUPERVISOR_PROPOSAL_SCHEMA = 'companyos/supervisor-proposal/1';

export const SUPERVISOR_PROPOSAL_KEYS = [
  'action',
  'reasonCode',
  'summary',
  'evidenceRefs',
  'subject',
] as const;

/**
 * The supervisor ACTION turn's structured-output contract — the CONSTRAINED GENERATION
 * mirror of `decodeSupervisorProposal` (BB-WATCH-001 closeout). Built from the SAME
 * exported authority constants the strict decoder enforces (`SUPERVISOR_DECISION_ACTIONS`,
 * `SUPERVISOR_DECISION_REASONS`, `SUPERVISOR_PROPOSAL_KEYS`, `SUPERVISOR_CONTEXT_LIMITS`):
 * closed action/reason enums, bounded summary, evidenceRefs as an ARRAY of strings, and
 * subject as the nullable { taskId } object the decoder accepts. The decoder REMAINS the
 * authority; this schema only prevents a faithful backend from being told the wrong shape
 * (the previous generic string-keyed derivation typed evidenceRefs/subject as strings).
 */
/**
 * F1 closure - the lifecycle-SCOPED proposal contract: constrained generation offers ONLY
 * the actions the current canonical window legalizes (allowedActions derived from the
 * blocking/completion state in buildContext). The strict decodeSupervisorProposal and
 * validateProposal REMAIN the authority - this only stops presenting obviously illegal
 * actions as candidates. The base (unscoped) schema is returned for a full window.
 */
const proposalSchemaFor = (allowedActions: readonly SupervisorDecisionAction[]): Readonly<Record<string, unknown>> => {
  if (allowedActions.length === 0 || allowedActions.length === SUPERVISOR_DECISION_ACTIONS.length) {
    return SUPERVISOR_ACTION_JSON_SCHEMA;
  }
  const scoped: Record<string, unknown> = JSON.parse(JSON.stringify(SUPERVISOR_ACTION_JSON_SCHEMA));
  const props = scoped['properties'] as Record<string, unknown>;
  props['action'] = { type: 'string', enum: [...allowedActions] };
  return scoped;
};

export const SUPERVISOR_ACTION_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  required: [...SUPERVISOR_PROPOSAL_KEYS, 'schema'],
  additionalProperties: false,
  properties: {
    schema: { type: 'string', const: SUPERVISOR_PROPOSAL_SCHEMA },
    action: { type: 'string', enum: [...SUPERVISOR_DECISION_ACTIONS] },
    reasonCode: { type: 'string', enum: [...SUPERVISOR_DECISION_REASONS] },
    summary: { type: 'string', minLength: 1, maxLength: SUPERVISOR_CONTEXT_LIMITS.maxSummaryChars },
    evidenceRefs: {
      type: 'array',
      maxItems: SUPERVISOR_CONTEXT_LIMITS.maxEvidenceRefs,
      // The canonical durable-reference grammar (single source: ID_PREFIX; the
      // resolver accepts `art_<id>` / `val_<id>` / `artifact:art_<id>` and refuses
      // everything else — BB-WATCH-001 live evidence: a real model invents freeform
      // refs unless the generation contract carries the grammar).
      items: {
        type: 'string',
        description:
          'A durable reference that appears VERBATIM in the context (art_<id> / val_<id>). If the context shows no art_/val_ refs, return an empty array — an empty array is correct for CONTINUE.',
        // F1 closure — the grammar matches EXACTLY what the canonical durable-reference
        // resolver accepts (art_<id> / val_<id> / artifact:art_<id>): the previous
        // alternation was `art_val_|artifact:art_`, which accepted neither bare form.
        pattern: `^(${ID_PREFIX.artifact}_|${ID_PREFIX.validation}_|artifact:${ID_PREFIX.artifact}_)`,
      },
    },
    subject: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['taskId'],
          additionalProperties: false,
          properties: { taskId: { type: 'string', minLength: 1 } },
        },
      ],
    },
  },
};



/**
 * The closed action → reason pairing. A pairing outside this table is a semantic refusal, not
 * a warning: a decision whose reason does not explain its action cannot be audited later.
 * `REQUEST_CORRECTIVE` accepts exactly the causes with a machine-verifiable V1 contract
 * (`CORRECTIVE_TASK_CAUSES`, T18-05); every other cause is refused rather than recorded as a
 * corrective intent nothing could ever provision.
 */
const ACTION_REASONS: Readonly<
  Record<SupervisorDecisionAction, readonly SupervisorDecisionReason[]>
> = {
  CONTINUE: ['GOAL_SATISFIED', 'TASK_FAILED', 'TOOL_FAILED'],
  REQUEST_CORRECTIVE: [...CORRECTIVE_TASK_CAUSES],
  ESCALATE: [
    'HUMAN_REQUIRED',
    'NO_LEGAL_ACTION',
    'TASK_FAILED',
    'TOOL_FAILED',
    ...CORRECTIVE_TASK_CAUSES,
  ],
  COMPLETE: ['GOAL_SATISFIED'],
};

/** Blocking conditions the context can project. A closed vocabulary, machine-checkable. */
export const SUPERVISOR_BLOCKING_CONDITIONS = [
  'LATEST_REVIEW_CHANGES_REQUESTED',
  'LATEST_REVIEW_BLOCKED',
  'LATEST_VALIDATION_FAILED',
  'SUBJECT_TASK_BLOCKED',
] as const;
export type SupervisorBlockingCondition = (typeof SUPERVISOR_BLOCKING_CONDITIONS)[number];

/* ------------------------------------------------------------------------- types */

export interface SupervisorContextRef {
  readonly kind:
    | 'run'
    | 'goal'
    | 'snapshot'
    | 'task'
    | 'review'
    | 'validation'
    | 'decision'
    | 'lineage'
    | 'binding';
  readonly id: string;
  readonly note?: string;
}

export interface SupervisorContext {
  readonly runId: string;
  readonly companyId: string;
  readonly goal: { readonly objective: string; readonly source: Readonly<Record<string, unknown>> };
  readonly run: {
    readonly templateId: string;
    readonly workflowVersionId: string;
    readonly state: string;
    readonly revision: number;
  };
  readonly subject: {
    readonly taskId: string;
    readonly stageId: string;
    readonly state: string;
    readonly kind: string;
    readonly attempts: number;
    readonly maxAttempts: number;
  };
  readonly lineage: Readonly<Record<string, unknown>> | null;
  readonly review: Readonly<Record<string, unknown>> | null;
  readonly validation: Readonly<Record<string, unknown>> | null;
  /**
   * F1 closure — the failed blocking validations of the run (newest first, bounded) with
   * their validator identity and target/evidence anchors: the corrective proposal cites
   * THESE durable rows, never an arbitrary latest-row projection.
   */
  readonly blockingValidations: readonly {
    readonly validationId: string;
    readonly validatorId: string;
    readonly status: string;
    readonly targetRef: string | null;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly decisions: readonly Readonly<Record<string, unknown>>[];
  readonly binding: { readonly bindingKey: string; readonly modelKey: string };
  readonly blockingConditions: readonly SupervisorBlockingCondition[];
  readonly allowedActions: readonly SupervisorDecisionAction[];
  readonly refs: readonly SupervisorContextRef[];
  readonly truncated: readonly string[];
}

export interface SupervisorProposal {
  readonly action: SupervisorDecisionAction;
  readonly reasonCode: SupervisorDecisionReason;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly subjectTaskId: string | null;
}

export interface SupervisorDecisionTurnResult {
  readonly decisionId: string;
  readonly executionId: string;
  readonly action: SupervisorDecisionAction;
  readonly reasonCode: SupervisorDecisionReason;
  /** True when a durable Decision already existed for this turn identity: zero model calls. */
  readonly replayed: boolean;
  readonly contextRefs: readonly SupervisorContextRef[];
}

export interface RunSupervisorDecisionTurnCommand {
  readonly companyId: string;
  readonly runId: string;
  /**
   * The one durable task this turn is about. Required: an AgentExecution must be anchored to a
   * real task of the run's pinned graph, and a Decision anchored to a task that does not exist
   * is refused by the sink. A run-level turn with no subject has no V1 form.
   */
  readonly taskId: string;
  /**
   * The review task whose LATEST report this turn evaluates. Defaults to `taskId`. Kept
   * separate because the review task and the task under review are different durable rows
   * (T18-04), and the latest actionable report is addressed by review task.
   */
  readonly reviewTaskId?: string | null;
  /** Trusted identity performing the turn; it is also the Decision's decision maker. */
  readonly actorId: string;
  /** Trusted idempotency identity of the turn (`supervisor-decision:<runId>:<identity>`). */
  readonly commandId: string;
  readonly traceId?: string;
  /** Caller-supplied cancellation for the WHOLE turn. */
  readonly signal?: AbortSignal;
  /** Whole-turn deadline. Defaults to `SUPERVISOR_TURN_TIMEOUT_MS`; never widened. */
  readonly timeoutMs?: number;
}

/** The latest actionable review report, projected for the context and for precondition checks. */
export interface SupervisorReviewReader {
  getLatestReviewReport(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly reviewTaskId: string;
    readonly actorId: string;
  }): Promise<
    Result<
      {
        readonly artifactId: string;
        readonly verdict: string;
        readonly subjectTaskId: string;
        readonly findings: readonly Readonly<Record<string, unknown>>[];
      } | null,
      DomainError
    >
  >;
}

/** The run's durable validation rows, newest first (the existing append-only store). */
export interface SupervisorValidationReader {
  listByRun(runId: string): Promise<readonly Validation[]>;
}

/**
 * The decision history reader (T18-03). It returns the durable `DecisionRecord`s; this runtime
 * projects the supervisor envelope out of each, so a non-supervisor decision of the same run is
 * visible as absent rather than misread.
 */
export interface SupervisorDecisionHistoryReader {
  listRunDecisionHistory(input: {
    readonly runId: string;
    readonly companyId: string;
    readonly actorId: string;
  }): Promise<Result<readonly DecisionRecord[], DomainError>>;
}

/** One supervisor decision, projected from its durable envelope (never from free text). */
export interface SupervisorDecisionHistoryEntry {
  readonly decisionId: string;
  readonly action: string;
  readonly reasonCode: string;
  readonly summary: string;
  readonly decidedAt: string;
  readonly version: number;
}

/** The decision's action plus the durable evidence refs it cited, from the same envelope. */
export interface SupervisorDecisionEvidence {
  readonly action: string;
  readonly evidenceRefs: readonly string[];
}

const supervisorEnvelopeOf = (
  record: DecisionRecord,
): Readonly<Record<string, unknown>> | null => {
  const metadata = record.metadata;
  if (!isRecord(metadata)) return null;
  const envelope = metadata['supervisor'];
  if (!isRecord(envelope) || envelope['schema'] !== SUPERVISOR_DECISION_SCHEMA) return null;
  return envelope;
};

const supervisorHistoryEntryOf = (
  record: DecisionRecord,
): SupervisorDecisionHistoryEntry | null => {
  const envelope = supervisorEnvelopeOf(record);
  if (envelope === null) return null;
  const action = envelope['action'];
  const reasonCode = envelope['reasonCode'];
  const summary = envelope['summary'];
  if (typeof action !== 'string' || typeof reasonCode !== 'string' || typeof summary !== 'string')
    return null;
  return {
    decisionId: record.decisionId,
    action,
    reasonCode,
    summary,
    decidedAt: record.decidedAt,
    version: record.version,
  };
};

/**
 * A review verdict is CONSUMED when a REQUEST_CORRECTIVE decision already cited its report: the
 * run has acted on that verdict, so it no longer blocks a CONTINUE and the evidence applicator
 * no longer re-applies it after the corrective work. This ONE predicate serves both seams — the
 * turn context's blocking conditions and the lifecycle applicator — so the rule can never fork.
 */
export const reviewVerdictConsumedBy = (
  history: readonly { readonly action: string; readonly evidenceRefs: readonly string[] }[],
  reviewArtifactId: string,
): boolean => {
  const cited = [`artifact:${reviewArtifactId}`, reviewArtifactId];
  return history.some(
    (decision) =>
      decision.action === 'REQUEST_CORRECTIVE' &&
      decision.evidenceRefs.some((ref) => cited.includes(ref)),
  );
};

/**
 * F1 closure (release-blocker re-audit) — the cause ids every CORRECTIVE CHILD of the run
 * already cites (durable task truth: `task.inputs.corrective.causeEvidenceRefs`). A failing
 * validation named here was ACTED ON: its corrective round is durable, so the verdict is
 * CONSUMED — it neither blocks a CONTINUE nor re-triggers a second corrective, and the
 * evidence applicator must not re-apply it (the run's only legal path is the re-validation
 * of the corrected work). ONE rule serves every seam.
 */
export const correctiveCauseIdsOf = (
  tasks: readonly { readonly inputs: Readonly<Record<string, unknown>> }[],
): readonly string[] => {
  const ids = new Set<string>();
  for (const task of tasks) {
    const lineage = task.inputs['corrective'];
    if (typeof lineage !== 'object' || lineage === null) continue;
    const causes = (lineage as Record<string, unknown>)['causeEvidenceRefs'];
    if (!Array.isArray(causes)) continue;
    for (const cause of causes) {
      if (typeof cause === 'string' && cause !== '') ids.add(cause);
    }
  }
  return [...ids];
};

/**
 * F1 closure — the run's LATEST validation row per validator (input newest-first, so the
 * first row seen per validator wins). This is the SAME set the evidence applicator's gate
 * decision is computed from, which keeps the context projection, the corrective legality and
 * the applicator on ONE derivation — never `rows[0]`, which may be another validator's row
 * of the same batch (a grounding PASS hiding a failing software check, or vice versa).
 */
export const latestValidationPerValidator = <T extends { readonly validatorId: string }>(
  rowsNewestFirst: readonly T[],
): readonly T[] => {
  const latest = new Map<string, T>();
  for (const row of rowsNewestFirst) {
    if (!latest.has(row.validatorId)) latest.set(row.validatorId, row);
  }
  return [...latest.values()];
};

/**
 * A decision's action and evidence refs, read from the SAME durable envelope the context
 * projection reads — so a caller can tell whether a given report was already the cause of a
 * REQUEST_CORRECTIVE without parsing any free text.
 */
export const supervisorDecisionEvidenceOf = (
  record: DecisionRecord,
): SupervisorDecisionEvidence | null => {
  const envelope = supervisorEnvelopeOf(record);
  if (envelope === null) return null;
  const action = envelope['action'];
  if (typeof action !== 'string') return null;
  const raw = envelope['evidenceRefs'];
  const evidenceRefs = Array.isArray(raw)
    ? raw
        .map((entry) => (isRecord(entry) ? entry['ref'] : entry))
        .filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { action, evidenceRefs };
};

export interface SupervisorDecisionRuntimeDeps {
  readonly runs: EntityStore<WorkflowRun>;
  readonly tasks: EntityStore<Task> & {
    /** Sprint21 final (D1): run-scoped read for ALL-ANCHOR finding aggregation. */
    listByRun?(runId: string): Promise<readonly Task[]>;
  };
  readonly runGoal: RunGoalReader;
  readonly runSnapshotVerifier: RunSnapshotVerifier;
  readonly modelBindings: RunModelBindingReader;
  readonly modelRegistry: RunModelBindingResolver;
  readonly reviewReports: SupervisorReviewReader;
  readonly validations: SupervisorValidationReader;
  readonly decisionHistory: SupervisorDecisionHistoryReader;
  readonly decisionSink: SupervisorDecisionSink;
  readonly agentRuntime: AgentRuntimeService;
  /** Injected timer: the engine and this runtime never install timers themselves. */
  readonly timer: (ms: number, onTimeout: () => void) => () => void;
  readonly clock: Clock;
  readonly ids: IdFactory;
  /** Trusted configuration: which pinned binding of the run the Supervisor runs under. */
  readonly supervisorBindingKey: string;
  /** Generic runtime identity for the Supervisor's AgentExecution. No role, no pack noun. */
  readonly supervisorAgentId?: string;
  readonly supervisorRoleId?: string;
  /** Upper bound for `timeoutMs`; a caller may neither remove nor widen the bound. */
  readonly maxTimeoutMs?: number;
  /**
   * Task-18-08 deterministic fault-injection seam: absent in production (zero overhead),
   * armed by a test harness to prove the decision/execution settlement windows.
   */
  readonly faultCheckpoints?: FaultCheckpointPort;
}

export interface SupervisorDecisionRuntime {
  /** Build the bounded context (read-only; useful for tests and diagnostics). */
  buildContext(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly reviewTaskId?: string | null;
    readonly actorId: string;
  }): Promise<Result<SupervisorContext, DomainError>>;
  runOneSupervisorDecisionTurn(
    command: RunSupervisorDecisionTurnCommand,
  ): Promise<Result<SupervisorDecisionTurnResult, DomainError>>;
}

/* --------------------------------------------------------------------- utilities */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const boundedText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
};

const VALIDATION_FAILED_STATUSES: readonly string[] = ['fail', 'error'];

/**
 * `artifact:art_x` / `art_x` both denote one artifact identity.
 *
 * There is deliberately NO similar reader for validations: the frozen evidence grammar
 * (Sprint 13, `durable-references.ts`) says a Validation reference IS the bare branded
 * ValidationId — `val_<ulid>` — so a validation citation must equal the row's own id exactly.
 * Inventing a second spelling (`val:<id>`, or `val_` prepended to an already-prefixed id)
 * would create a ref the durable resolver refuses.
 */
const artifactIdOfRef = (ref: string): string | null =>
  ref.startsWith('artifact:') ? ref.slice('artifact:'.length) : ref.startsWith('art_') ? ref : null;

/** Structural, strict decode of the proposal envelope. No substring extraction, no repair. */
export function decodeSupervisorProposal(
  payload: unknown,
): Result<SupervisorProposal, DomainError> {
  if (!isRecord(payload)) {
    return err(
      domainError('VALIDATION_FAILED', 'The model did not return a structured proposal envelope.', {
        reason: 'SUPERVISOR_PROPOSAL_INVALID',
      }),
    );
  }
  if (payload['schema'] !== SUPERVISOR_PROPOSAL_SCHEMA) {
    return err(
      domainError(
        'VALIDATION_FAILED',
        `Unsupported supervisor proposal schema "${String(payload['schema'])}".`,
        {
          reason: 'SUPERVISOR_PROPOSAL_SCHEMA_UNSUPPORTED',
        },
      ),
    );
  }
  for (const key of SUPERVISOR_PROPOSAL_KEYS) {
    if (payload[key] === undefined) {
      return err(
        domainError('VALIDATION_FAILED', `The proposal is missing "${key}".`, {
          reason: 'SUPERVISOR_PROPOSAL_FIELD_MISSING',
          key,
        }),
      );
    }
  }
  const action = payload['action'];
  if (
    typeof action !== 'string' ||
    !(SUPERVISOR_DECISION_ACTIONS as readonly string[]).includes(action)
  ) {
    return err(
      domainError('VALIDATION_FAILED', `Unknown proposal action "${String(action)}".`, {
        reason: 'SUPERVISOR_PROPOSAL_ACTION_INVALID',
        action: String(action),
      }),
    );
  }
  const reasonCode = payload['reasonCode'];
  if (
    typeof reasonCode !== 'string' ||
    !(SUPERVISOR_DECISION_REASONS as readonly string[]).includes(reasonCode)
  ) {
    return err(
      domainError('VALIDATION_FAILED', `Unknown proposal reason "${String(reasonCode)}".`, {
        reason: 'SUPERVISOR_PROPOSAL_REASON_INVALID',
        reasonCode: String(reasonCode),
      }),
    );
  }
  const summary = boundedText(payload['summary'], SUPERVISOR_CONTEXT_LIMITS.maxSummaryChars);
  if (summary === null) {
    return err(
      domainError('VALIDATION_FAILED', 'The proposal needs a non-empty summary.', {
        reason: 'SUPERVISOR_PROPOSAL_SUMMARY_INVALID',
      }),
    );
  }
  const rawRefs = payload['evidenceRefs'];
  if (!Array.isArray(rawRefs) || rawRefs.length > SUPERVISOR_CONTEXT_LIMITS.maxEvidenceRefs) {
    return err(
      domainError(
        'VALIDATION_FAILED',
        `A proposal may carry at most ${SUPERVISOR_CONTEXT_LIMITS.maxEvidenceRefs} evidence refs.`,
        { reason: 'SUPERVISOR_PROPOSAL_EVIDENCE_INVALID' },
      ),
    );
  }
  const evidenceRefs: string[] = [];
  for (const ref of rawRefs) {
    if (typeof ref !== 'string' || ref.trim() === '') {
      return err(
        domainError('VALIDATION_FAILED', 'Proposal evidence refs must be non-empty strings.', {
          reason: 'SUPERVISOR_PROPOSAL_EVIDENCE_INVALID',
        }),
      );
    }
    evidenceRefs.push(ref.trim());
  }
  const rawSubject = payload['subject'];
  let subjectTaskId: string | null = null;
  if (rawSubject !== undefined && rawSubject !== null) {
    if (
      !isRecord(rawSubject) ||
      typeof rawSubject['taskId'] !== 'string' ||
      rawSubject['taskId'].trim() === ''
    ) {
      return err(
        domainError('VALIDATION_FAILED', 'The proposal subject must be { taskId } when present.', {
          reason: 'SUPERVISOR_PROPOSAL_SUBJECT_INVALID',
        }),
      );
    }
    subjectTaskId = rawSubject['taskId'].trim();
  }
  return ok({ action, reasonCode, summary, evidenceRefs, subjectTaskId } as SupervisorProposal);
}

/** Deterministic, bounded serialization of the context for the prompt. */
export const renderSupervisorContext = (context: SupervisorContext): string =>
  canonicalJson(context);

/** The system contract: describe the task, forbid execution, demand the exact envelope. */
export const supervisorSystemPrompt = (allowedActions?: readonly SupervisorDecisionAction[]): string =>
  [
    'You are the Supervisor of a CompanyOS workflow run.',
    'You produce exactly ONE decision proposal for the current state. You do NOT execute anything:',
    'you cannot create work, change state, approve, complete, or contact any external system.',
    'Answer with a single JSON object and nothing else:',
    JSON.stringify({
      schema: SUPERVISOR_PROPOSAL_SCHEMA,
      action: SUPERVISOR_DECISION_ACTIONS,
      reasonCode: SUPERVISOR_DECISION_REASONS,
      summary: 'one sentence',
      evidenceRefs: ['only refs that appear in the context'],
      subject: { taskId: 'the task your proposal concerns, when applicable' },
    }),
    // F1 closure: the CURRENT legal action window is stated verbatim — the same closed set
    // the constrained schema enumerates; the validator remains the authority.
    allowedActions !== undefined
      ? `The ONLY legal actions for THIS decision are: ${allowedActions.join(', ')}. Choose one of these.`
      : '',
    'Rules: CONTINUE means legal next work exists with no blocking condition; REQUEST_CORRECTIVE',
    'requires a durable actionable cause that appears in the context; ESCALATE means no legal',
    'action remains without a human; COMPLETE requires durable completion provenance and a',
    'passing validation.',
  ].join('\n');

/** The bounded constraint list handed to the model alongside the context. */
export const supervisorConstraints = (): readonly string[] => [
  `Valid pairings: ${Object.entries(ACTION_REASONS)
    .map(([action, reasons]) => `${action} ← ${reasons.join('|')}`)
    .join('; ')}.`,
  'CONTINUE requires no blocking condition. ESCALATE requires at least one. COMPLETE requires the',
  'subject task to be COMPLETED, no blocking condition, and the latest validation to pass.',
  'REQUEST_CORRECTIVE with REVIEW_FINDING requires the latest review report to be',
  'CHANGES_REQUESTED and cited; with VALIDATION_FAILED it requires the latest validation to fail',
  'and to be cited (or an artifact that validation itself cites).',
  'Cite only evidence refs that appear verbatim in the context (canonical form art_<id> or val_<id>); when the context contains NO art_/val_ refs, evidenceRefs MUST be an empty array — never invent an identifier. For CONTINUE on ordinary work, an empty evidenceRefs array is the normal, correct answer.',
  'When the subject task is still PENDING or RUNNING and the context shows no blocking condition, CONTINUE is the expected action — do not ESCALATE merely because no evidence refs exist.',
  'Never propose an action for a task other than the subject.',
];

export function createSupervisorDecisionRuntime(
  deps: SupervisorDecisionRuntimeDeps,
): SupervisorDecisionRuntime {
  const agentId = deps.supervisorAgentId ?? 'supervisor-runtime';
  const roleId = deps.supervisorRoleId ?? 'supervisor-runtime';

  const turnCancelled = (): DomainError =>
    domainError('CANCELLED', 'The supervisor decision turn was cancelled.', {
      reason: 'SUPERVISOR_TURN_CANCELLED',
      kind: 'CANCELLED',
    });

  const turnTimedOut = (timeoutMs: number): DomainError =>
    domainError(
      'TIMEOUT',
      `The supervisor decision turn exceeded its ${String(timeoutMs)}ms bound.`,
      {
        reason: 'SUPERVISOR_TURN_TIMEOUT',
        timeoutMs,
        kind: 'TIMEOUT',
      },
    );

  /** The abort reason carried on the signal, or the default cancellation when there is none. */
  const abortReasonOf = (signal: AbortSignal): DomainError => {
    const reason = signal.reason;
    return reason instanceof DomainError ? reason : turnCancelled();
  };

  /* --------------------------------------------------------------- context build */

  const buildContext = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly reviewTaskId?: string | null;
    readonly actorId: string;
  }): Promise<Result<SupervisorContext, DomainError>> => {
    const run = await deps.runs.get(input.runId as never);
    if (run === null || run.companyId !== input.companyId) {
      return err(
        domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, {
          reason: 'RUN_MISSING',
          runId: input.runId,
        }),
      );
    }
    // No Goal or no provable pin means no context, and therefore no turn.
    const goal = await deps.runGoal.get({ runId: input.runId, companyId: input.companyId });
    if (!goal.ok) return goal;
    const pinned = await deps.runSnapshotVerifier.verify({
      runId: run.id,
      snapshotId: run.snapshotId,
    });
    if (!pinned.ok) return pinned;

    const binding = await deps.modelBindings.resolve(
      { runId: run.id, companyId: input.companyId, bindingName: deps.supervisorBindingKey },
      deps.modelRegistry,
    );
    if (!binding.ok) return binding;
    // The run may only ever have pinned a usable model; a disabled or provider-less model is
    // refused here, before anything is written.
    if (
      binding.value.enabled !== true ||
      UNPINNABLE_AVAILABILITY.includes(binding.value.availability)
    ) {
      return err(
        domainError(
          'NOT_FOUND',
          `The pinned binding "${deps.supervisorBindingKey}" is not usable (${binding.value.availability}).`,
          {
            reason: 'RUN_BINDING_UNUSABLE',
            bindingName: deps.supervisorBindingKey,
            modelKey: binding.value.modelKey,
            availability: binding.value.availability,
          },
        ),
      );
    }

    const subject = await deps.tasks.get(input.taskId as never);
    if (subject === null) {
      return err(
        domainError('NOT_FOUND', `Task "${input.taskId}" does not exist.`, {
          reason: 'SUPERVISOR_TASK_MISSING',
          taskId: input.taskId,
        }),
      );
    }
    const reviewTaskId = input.reviewTaskId ?? input.taskId;

    const refs: SupervisorContextRef[] = [
      { kind: 'run', id: run.id },
      { kind: 'goal', id: run.id, note: 'run-goal' },
      { kind: 'snapshot', id: run.snapshotId },
      { kind: 'binding', id: binding.value.modelKey, note: deps.supervisorBindingKey },
      { kind: 'task', id: subject.id },
    ];
    const truncated: string[] = [];

    // Corrective lineage (T18-05): the runtime projects it; it never mints it.
    let lineage: Readonly<Record<string, unknown>> | null = null;
    const rawLineage = subject.inputs['corrective'];
    if (isRecord(rawLineage)) {
      const causeRefs = Array.isArray(rawLineage['causeEvidenceRefs'])
        ? (rawLineage['causeEvidenceRefs'] as unknown[]).filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : [];
      lineage = {
        parentTaskId:
          typeof rawLineage['parentTaskId'] === 'string' ? rawLineage['parentTaskId'] : null,
        rootTaskId: typeof rawLineage['rootTaskId'] === 'string' ? rawLineage['rootTaskId'] : null,
        round: typeof rawLineage['round'] === 'number' ? rawLineage['round'] : null,
        originDecisionId:
          typeof rawLineage['originDecisionId'] === 'string'
            ? rawLineage['originDecisionId']
            : null,
        reasonCode: typeof rawLineage['reasonCode'] === 'string' ? rawLineage['reasonCode'] : null,
        causeEvidenceRefs: causeRefs.slice(0, SUPERVISOR_CONTEXT_LIMITS.maxEvidenceRefs),
      };
      if (causeRefs.length > SUPERVISOR_CONTEXT_LIMITS.maxEvidenceRefs)
        truncated.push('lineage.causeEvidenceRefs');
      refs.push({ kind: 'lineage', id: String(lineage['originDecisionId'] ?? '') });
    }

    // Latest actionable review projection (T18-04): latest, never an older PASS.
    // D1: the decision history's evidence citations decide finding consumption.
    const historyRead = await deps.decisionHistory.listRunDecisionHistory({
      runId: run.id,
      companyId: input.companyId,
      actorId: input.actorId,
    });
    if (!historyRead.ok) return historyRead;
    const decisionHistoryEvidence = historyRead.value.map(
      (record) => supervisorDecisionEvidenceOf(record) ?? { action: '', evidenceRefs: [] },
    );
    /*
     * Sprint21 final (D1, Boss §1-§5): the review projection aggregates canonical
     * reports across ALL legitimate run-scoped anchors — the caller's anchor plus every
     * run task — because ANY unresolved actionable finding blocks execution, regardless
     * of which legitimate task produced it. A newer clean report on another anchor NEVER
     * erases an older unresolved finding (no global newest-wins); the presentation pick
     * is deterministic (unresolved-actionable first, then the anchor's newest) while
     * existence of unresolved findings — the blocking decision — is order-independent.
     */
    let review: Readonly<Record<string, unknown>> | null = null;
    let foreignBlocking = false;
    const latestReview = await deps.reviewReports.getLatestReviewReport({
      companyId: input.companyId,
      runId: run.id,
      reviewTaskId,
      actorId: input.actorId,
    });
    if (!latestReview.ok) return latestReview;
    const anchorReport = latestReview.value;
    const consumedEvidence = (): readonly { action: string; evidenceRefs: readonly string[] }[] => [];
    void consumedEvidence; // (kept for symmetry; consumption resolved below via decision history)
    const isUnresolvedActionable = (report: {
      artifactId: string;
      verdict: string;
    } | null): boolean =>
      report !== null &&
      report.verdict === 'CHANGES_REQUESTED' &&
      !reviewVerdictConsumedBy(
        decisionHistoryEvidence,
        report.artifactId,
      );
    let anchorSubjectMatched = true;
    if (anchorReport !== null) {
      anchorSubjectMatched = String(anchorReport.subjectTaskId) === String(subject.id);
      if (anchorSubjectMatched) {
        const findings = anchorReport.findings.slice(
          0,
          SUPERVISOR_CONTEXT_LIMITS.maxFindingsPerReview,
        );
        if (anchorReport.findings.length > findings.length) truncated.push('review.findings');
        review = {
          artifactId: anchorReport.artifactId,
          verdict: anchorReport.verdict,
          subjectTaskId: anchorReport.subjectTaskId,
          findings: findings.map((finding) => ({
            findingId: finding['findingId'] ?? null,
            code: finding['code'] ?? null,
            summary: boundedText(finding['summary'], SUPERVISOR_CONTEXT_LIMITS.maxSummaryChars),
            blocking: finding['blocking'] === true,
          })),
        };
        refs.push({ kind: 'review', id: anchorReport.artifactId });
      } else if (isUnresolvedActionable(anchorReport)) {
        // D1 final scoping: even the ANCHOR report never populates the subject-scoped
        // proposal projection when its subject differs — it contributes run-scoped
        // blocking only (its correction belongs to its own subject's turn).
        foreignBlocking = true;
      }
    }
    let unresolvedForeignFinding: Readonly<Record<string, unknown>> | null = null;
    let foreignSubjectMismatch = false;
    /*
     * F1 closure (release-blocker re-audit): ONE durable task read serves the review-anchor
     * scan, the corrective-cause consumption and the validation derivation below.
     */
    const runTasks =
      deps.tasks.listByRun === undefined ? [] : await deps.tasks.listByRun(run.id as never);
    if (deps.tasks.listByRun !== undefined) {
      let firstUnresolved: Readonly<Record<string, unknown>> | null = null;
      let subjectMatched: Readonly<Record<string, unknown>> | null = null;
      for (const task of runTasks) {
        if (String(task.id) === String(reviewTaskId)) continue; // anchor already projected
        const report = await deps.reviewReports.getLatestReviewReport({
          companyId: input.companyId,
          runId: run.id,
          reviewTaskId: String(task.id),
          actorId: input.actorId,
        });
        if (!report.ok) return report;
        if (report.value === null) continue;
        if (!isUnresolvedActionable(report.value)) continue;
        const projected = {
          artifactId: report.value.artifactId,
          verdict: report.value.verdict,
          subjectTaskId: report.value.subjectTaskId,
          findings: report.value.findings
            .slice(0, SUPERVISOR_CONTEXT_LIMITS.maxFindingsPerReview)
            .map((finding) => ({
              findingId: finding['findingId'] ?? null,
              code: finding['code'] ?? null,
              summary: boundedText(finding['summary'], SUPERVISOR_CONTEXT_LIMITS.maxSummaryChars),
              blocking: finding['blocking'] === true,
            })),
        };
        if (firstUnresolved === null) firstUnresolved = projected;
        if (
          subjectMatched === null &&
          String(report.value.subjectTaskId) === String(subject.id)
        ) {
          subjectMatched = projected;
        }
      }
      // D1 final scoping (Boss ruling): the proposal/cause projection is SUBJECT-SCOPED —
      // ONLY a report whose subject is this turn's subject may populate it; a foreign
      // report NEVER fills an empty subject-local projection. Foreign findings contribute
      // RUN-SCOPED blocking only.
      unresolvedForeignFinding = subjectMatched;
      foreignSubjectMismatch = firstUnresolved !== null && subjectMatched === null;
    }
    if (unresolvedForeignFinding !== null) {
      // A subject-MATCHED foreign report may legitimately become the proposal projection
      // (its subject IS this turn's subject); a foreign-subject report only BLOCKS.
      review = unresolvedForeignFinding;
      refs.push({ kind: 'review', id: String(unresolvedForeignFinding['artifactId']) });
    }
    if (foreignSubjectMismatch) {
      foreignBlocking = true;
    }

    // Latest QA/validation projection: the LATEST row per validator of the run (append-only
    // store, newest first), with failures a corrective child already consumed excluded.
    const validationRows = await deps.validations.listByRun(run.id);
    const latestValidationRows = latestValidationPerValidator(validationRows);
    /*
     * F1 closure (release-blocker re-audit): the validation truth of this context is derived
     * from the SAME durable set the evidence applicator's gate decision acts on. `rows[0]`
     * was never that: it could be another validator's PASS row of the same batch, and it
     * could be a failure the corrective round already acted on (CONSUMED — the corrective
     * child cites the row as its cause), which must not block or justify another corrective.
     */
    const consumedValidationIds = new Set(correctiveCauseIdsOf(runTasks));
    const actionableValidationFailures = latestValidationRows.filter(
      (row) =>
        VALIDATION_FAILED_STATUSES.includes(String(row.status)) &&
        !consumedValidationIds.has(String(row.id)),
    );
    const latestValidation = actionableValidationFailures[0] ?? latestValidationRows[0] ?? null;
    let validation: Readonly<Record<string, unknown>> | null = null;
    if (latestValidation !== null && latestValidation !== undefined) {
      validation = {
        validationId: latestValidation.id,
        status: latestValidation.status,
        validatorId: latestValidation.validatorId,
        ...(latestValidation.exitCode === null ? {} : { exitCode: latestValidation.exitCode }),
        targetRef: latestValidation.targetRef,
        evidenceRefs: latestValidation.evidenceRefs.slice(
          0,
          SUPERVISOR_CONTEXT_LIMITS.maxEvidenceRefs,
        ),
        finishedAt: latestValidation.finishedAt,
      };
      if (latestValidation.evidenceRefs.length > SUPERVISOR_CONTEXT_LIMITS.maxEvidenceRefs) {
        truncated.push('validation.evidenceRefs');
      }
      refs.push({ kind: 'validation', id: latestValidation.id });
    }

    // Bounded decision history (T18-03 reader), newest first. Only supervisor decisions are
    // projected: a foreign decision of the same run is absent from the context, not misread.
    const history = await deps.decisionHistory.listRunDecisionHistory({
      runId: run.id,
      companyId: input.companyId,
      actorId: input.actorId,
    });
    if (!history.ok) return history;
    const supervisorHistory = history.value
      .map((record) => supervisorHistoryEntryOf(record))
      .filter((entry): entry is SupervisorDecisionHistoryEntry => entry !== null);
    const decisions = supervisorHistory.slice(0, SUPERVISOR_CONTEXT_LIMITS.maxDecisions);
    if (supervisorHistory.length > decisions.length) truncated.push('decisions');
    for (const decision of decisions) refs.push({ kind: 'decision', id: decision.decisionId });

    const blockingConditions: SupervisorBlockingCondition[] = [];
    /*
     * A verdict a REQUEST_CORRECTIVE already cited is CONSUMED: the run acted on it, the
     * corrective work is durable, and the next review round will produce the verdict that
     * counts. It therefore no longer blocks a CONTINUE — otherwise the run could never run the
     * round-two review that is the only legal way to clear the finding.
     */
    const consumed =
      review !== null &&
      reviewVerdictConsumedBy(
        history.value.map((record) => supervisorDecisionEvidenceOf(record) ?? { action: '', evidenceRefs: [] }),
        String(review['artifactId']),
      );
    if (review !== null && review['verdict'] === 'CHANGES_REQUESTED' && !consumed) {
      blockingConditions.push('LATEST_REVIEW_CHANGES_REQUESTED');
    }
    if (foreignBlocking) {
      // An unresolved actionable finding on a foreign producer whose subject differs from
      // this turn's subject: it blocks THIS turn's continuation (conservative V1 safety
      // policy) even though its correction belongs to a different subject's turn.
      blockingConditions.push('LATEST_REVIEW_CHANGES_REQUESTED');
    }
    if (review !== null && review['verdict'] === 'BLOCKED' && !consumed)
      blockingConditions.push('LATEST_REVIEW_BLOCKED');

    if (subject.state === 'BLOCKED') blockingConditions.push('SUBJECT_TASK_BLOCKED');
    /*
     * F1 closure - a failing validation whose corrective round is ALREADY durable (a
     * corrective child of this run cites the failing row as its cause) is CONSUMED: the
     * run acted on it, and the only legal path is the engine's re-validation of the
     * corrected work. The stale FAIL no longer blocks - otherwise every turn would
     * provision another corrective round forever and re-validation could never run.
     */
    if (actionableValidationFailures.length > 0) blockingConditions.push('LATEST_VALIDATION_FAILED');

    /*
     * F1 closure — the LEGAL ACTION WINDOW is derived from the canonical lifecycle state,
     * never offered unconditionally. The application remains the legality authority
     * (validateProposal is unchanged); this narrows what the model is OFFERED so an
     * obviously illegal action is not presented as a candidate:
     *   - a standing blocking condition makes CONTINUE illegal (validateProposal refuses
     *     it) → the corrective/governance window is [REQUEST_CORRECTIVE, ESCALATE];
     *   - COMPLETE stays a candidate only with durable completion provenance (subject
     *     DONE + passing validation + no blocking condition);
     *   - otherwise the ordinary window applies.
     */
    const subjectDone = subject.state === 'DONE';
    // F1: "passing" is the same latest-per-validator truth the evidence gate computes — a
    // consumed failure is NOT passing (the re-validation is still owed), and another
    // validator's row can neither hide nor fake it.
    const validationPassing =
      latestValidationRows.length > 0 &&
      latestValidationRows.every((row) => String(row.status) === 'pass');
    const allowedActions: SupervisorDecisionAction[] = blockingConditions.length
      ? (['REQUEST_CORRECTIVE', 'ESCALATE'] as const).slice()
      : subjectDone && validationPassing
        ? // F1: a FINALIZING run with durable completion provenance has exactly ONE legal
          // action left — CONTINUE has no work unit there and its application hard-stops.
          // The window states the truth the application enforces.
          (run.state === 'FINALIZING'
            ? (['COMPLETE'] as const)
            : (['CONTINUE', 'COMPLETE'] as const)
          ).slice()
        : (['CONTINUE', 'REQUEST_CORRECTIVE', 'ESCALATE'] as const).slice();

    /*
     * F1 closure — the corrective-cause truth: the run's ACTIONABLE failing validations
     * (latest row per validator, consumed failures excluded). The projection above, the
     * blocking condition, the corrective legality (validateProposal) and this list are ONE
     * derivation, so the model can only ever cite a row the authority would accept.
     */
    const blockingValidations = actionableValidationFailures
      .slice(0, SUPERVISOR_CONTEXT_LIMITS.maxEvidenceRefs)
      .map((row) => ({
        validationId: String(row.id),
        validatorId: String(row.validatorId),
        status: String(row.status),
        targetRef: row.targetRef,
        evidenceRefs: row.evidenceRefs.slice(0, SUPERVISOR_CONTEXT_LIMITS.maxEvidenceRefs),
      }));

    const context: SupervisorContext = {
      runId: run.id,
      companyId: input.companyId,
      goal: {
        objective: goal.value.objective.slice(0, SUPERVISOR_CONTEXT_LIMITS.maxObjectiveChars),
        source: goal.value.source as unknown as Readonly<Record<string, unknown>>,
      },
      run: {
        templateId: String(run.templateId),
        workflowVersionId: String(run.versionId),
        state: run.state,
        revision: run.revision,
      },
      subject: {
        taskId: subject.id,
        stageId: String(subject.stageId),
        state: subject.state,
        kind: subject.kind,
        attempts: subject.attempts,
        maxAttempts: subject.maxAttempts,
      },
      lineage,
      review,
      validation,
      decisions: decisions.map((decision) => ({
        decisionId: decision.decisionId,
        action: decision.action,
        reasonCode: decision.reasonCode,
        summary: boundedText(decision.summary, SUPERVISOR_CONTEXT_LIMITS.maxSummaryChars),
        decidedAt: decision.decidedAt,
      })),
      binding: { bindingKey: deps.supervisorBindingKey, modelKey: binding.value.modelKey },
      blockingConditions,
      blockingValidations,
      allowedActions,
      refs,
      truncated,
    };

    // A context over the bound is refused, never silently truncated into meaninglessness.
    const rendered = renderSupervisorContext(context);
    if (new TextEncoder().encode(rendered).byteLength > SUPERVISOR_CONTEXT_LIMITS.maxContextBytes) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          'The supervisor context exceeds its bounded size; refuse the turn rather than truncating silently.',
          {
            reason: 'SUPERVISOR_CONTEXT_TOO_LARGE',
            maxBytes: SUPERVISOR_CONTEXT_LIMITS.maxContextBytes,
          },
        ),
      );
    }
    return ok(context);
  };

  /* ------------------------------------------------------- semantic precondition */

  /**
   * The machine-checkable half of the proposal contract. The prompt states the rules; this is
   * what makes them real. A proposal that fails here is NEVER recorded as a Decision.
   */
  const validateProposal = (
    proposal: SupervisorProposal,
    context: SupervisorContext,
  ): Result<true, DomainError> => {
    const allowedReasons = ACTION_REASONS[proposal.action];
    if (allowedReasons === undefined || !allowedReasons.includes(proposal.reasonCode)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `A "${proposal.action}" proposal may not carry reason "${proposal.reasonCode}".`,
          {
            reason: 'SUPERVISOR_PROPOSAL_PAIRING_INVALID',
            action: proposal.action,
            reasonCode: proposal.reasonCode,
            allowedReasons,
          },
        ),
      );
    }

    const blocking = context.blockingConditions;
    const subject = context.subject;
    const review = context.review;
    const validation = context.validation;

    if (proposal.subjectTaskId !== null && proposal.subjectTaskId !== subject.taskId) {
      // The model may not decide about a task the context never gave it.
      return err(
        domainError(
          'VALIDATION_FAILED',
          'A proposal may only concern the subject task of its context.',
          {
            reason: 'SUPERVISOR_PROPOSAL_SUBJECT_FOREIGN',
            subjectTaskId: proposal.subjectTaskId,
            contextSubjectTaskId: subject.taskId,
          },
        ),
      );
    }

    if (proposal.action === 'CONTINUE' && blocking.length > 0) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          'CONTINUE is not legal while a blocking condition stands.',
          {
            reason: 'SUPERVISOR_PROPOSAL_CONTINUE_BLOCKED',
            blockingConditions: [...blocking],
          },
        ),
      );
    }

    if (proposal.action === 'ESCALATE') {
      if (proposal.evidenceRefs.length === 0) {
        return err(
          domainError('VALIDATION_FAILED', 'An ESCALATE proposal must cite durable evidence.', {
            reason: 'SUPERVISOR_PROPOSAL_EVIDENCE_REQUIRED',
          }),
        );
      }
      if (blocking.length === 0) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'ESCALATE is not legal without a blocking condition to escalate.',
            {
              reason: 'SUPERVISOR_PROPOSAL_ESCALATE_UNJUSTIFIED',
            },
          ),
        );
      }
    }

    if (proposal.action === 'REQUEST_CORRECTIVE') {
      if (proposal.evidenceRefs.length === 0) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'A REQUEST_CORRECTIVE proposal must cite its durable cause.',
            {
              reason: 'SUPERVISOR_PROPOSAL_EVIDENCE_REQUIRED',
            },
          ),
        );
      }
      if (proposal.reasonCode === 'REVIEW_FINDING') {
        if (review === null || review['verdict'] !== 'CHANGES_REQUESTED') {
          return err(
            domainError(
              'VALIDATION_FAILED',
              'The latest review report does not request changes; no REVIEW_FINDING cause exists.',
              {
                reason: 'SUPERVISOR_PROPOSAL_CAUSE_NOT_ACTIONABLE',
                verdict: review === null ? null : String(review['verdict']),
              },
            ),
          );
        }
        const reportId = String(review['artifactId']);
        const cited = proposal.evidenceRefs.some((ref) => artifactIdOfRef(ref) === reportId);
        if (!cited) {
          return err(
            domainError(
              'VALIDATION_FAILED',
              'A REVIEW_FINDING proposal must cite the latest review report itself.',
              {
                reason: 'SUPERVISOR_PROPOSAL_CAUSE_EVIDENCE_MISSING',
                reviewArtifactId: reportId,
              },
            ),
          );
        }
        const reviewed = String(review['subjectTaskId']);
        if (reviewed !== subject.taskId) {
          // The report concerns another task: the supervisor may not borrow its cause.
          return err(
            domainError(
              'VALIDATION_FAILED',
              'The latest review report concerns a task other than the subject.',
              {
                reason: 'SUPERVISOR_PROPOSAL_CAUSE_SUBJECT_MISMATCH',
                reviewSubjectTaskId: reviewed,
                subjectTaskId: subject.taskId,
              },
            ),
          );
        }
      }
      if (proposal.reasonCode === 'VALIDATION_FAILED') {
        // F1 closure (release-blocker re-audit): the cause must be one of the ACTIONABLE
        // blocking validations — the same durable set the blocking condition and the
        // evidence applicator derive from. A failure a corrective round already consumed is
        // NOT a legal cause: ordering a second corrective for it would discard the durable
        // corrected work and could never clear the run.
        const actionable = context.blockingValidations[0];
        if (actionable === undefined) {
          return err(
            domainError(
              'VALIDATION_FAILED',
              'The run has no actionable failing validation; no VALIDATION_FAILED cause exists.',
              {
                reason: 'SUPERVISOR_PROPOSAL_CAUSE_NOT_ACTIONABLE',
                status: validation === null ? null : String(validation['status']),
              },
            ),
          );
        }
        // The failing validation itself (its branded id IS its ref), or an artifact that
        // validation cites as its own evidence.
        const actionableCited = proposal.evidenceRefs.some((ref) => {
          if (ref === actionable.validationId) return true;
          const asArtifact = artifactIdOfRef(ref);
          if (asArtifact === null) return false;
          return actionable.evidenceRefs.some((rowRef) => artifactIdOfRef(rowRef) === asArtifact);
        });
        if (!actionableCited) {
          return err(
            domainError(
              'VALIDATION_FAILED',
              'A VALIDATION_FAILED proposal must cite the failing validation or its evidence.',
              {
                reason: 'SUPERVISOR_PROPOSAL_CAUSE_EVIDENCE_MISSING',
                validationId: actionable.validationId,
              },
            ),
          );
        }
      }
    }

    if (proposal.action === 'COMPLETE') {
      if (blocking.length > 0) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'COMPLETE is not legal while a blocking condition stands.',
            {
              reason: 'SUPERVISOR_PROPOSAL_COMPLETE_BLOCKED',
              blockingConditions: [...blocking],
            },
          ),
        );
      }
      // `DONE` is the Task domain's completed state (Sprint 1 vocabulary, not an execution state).
      if (subject.state !== 'DONE') {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'COMPLETE requires durable completion provenance: the subject task must be DONE.',
            {
              reason: 'SUPERVISOR_PROPOSAL_COMPLETION_MISSING',
              taskState: subject.state,
            },
          ),
        );
      }
      if (validation === null || String(validation['status']) !== 'pass') {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'COMPLETE requires durable quality proof: the latest validation must pass.',
            {
              reason: 'SUPERVISOR_PROPOSAL_COMPLETION_UNPROVEN',
              validationStatus: validation === null ? null : String(validation['status']),
            },
          ),
        );
      }
      const validationId = String(validation['validationId']);
      if (!proposal.evidenceRefs.some((ref) => ref === validationId)) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            'A COMPLETE proposal must cite the passing validation it relies on.',
            {
              reason: 'SUPERVISOR_PROPOSAL_COMPLETION_EVIDENCE_MISSING',
              validationId,
            },
          ),
        );
      }
    }

    return ok(true);
  };

  /* ------------------------------------------------------------------- one turn */

  const runOneSupervisorDecisionTurn = async (
    command: RunSupervisorDecisionTurnCommand,
  ): Promise<Result<SupervisorDecisionTurnResult, DomainError>> => {
    /* ---- shape ------------------------------------------------------------- */
    if (!command.commandId.startsWith(`${SUPERVISOR_DECISION_COMMAND_PREFIX}:`)) {
      return err(
        domainError(
          'INVALID_ARGUMENT',
          'A supervisor turn needs a trusted supervisor-decision command identity.',
          {
            reason: 'SUPERVISOR_TURN_COMMAND_ID_INVALID',
          },
        ),
      );
    }
    if (typeof command.taskId !== 'string' || command.taskId.trim() === '') {
      return err(
        domainError(
          'INVALID_ARGUMENT',
          'A supervisor decision turn must name the durable task it is about.',
          {
            reason: 'SUPERVISOR_TURN_TASK_REQUIRED',
          },
        ),
      );
    }
    const timeoutCeiling = deps.maxTimeoutMs ?? SUPERVISOR_TURN_TIMEOUT_MS;
    const requested = command.timeoutMs ?? SUPERVISOR_TURN_TIMEOUT_MS;
    const timeoutMs = Math.min(requested, timeoutCeiling);
    /*
     * 25b98d1/N9-B1 — ONE IMMUTABLE WHOLE-TURN DEADLINE. The absolute instant is fixed
     * HERE, at admission, from the canonical clock, and governs pre-read/context,
     * execution preparation, the provider call, parse, validation, the sink, settlement
     * and the DURABLE decision-authority expiry — no subsystem recomputes now+timeout
     * for the same turn, so a slow pre-context phase can never silently grant a second
     * timeout window.
     */
    const absoluteDeadlineIso = new Date(Date.parse(deps.clock.nowIso()) + timeoutMs).toISOString();

    /* ---- whole-turn cancellation + one deadline (ZCode constraint #1) ------- */
    const controller = new AbortController();
    const abortTurn = (reason: DomainError): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const releaseTimer = deps.timer(timeoutMs, () => abortTurn(turnTimedOut(timeoutMs)));
    const caller = command.signal;
    const onCallerAbort = (): void => abortTurn(turnCancelled());
    if (caller !== undefined) {
      if (caller.aborted) onCallerAbort();
      else caller.addEventListener('abort', onCallerAbort, { once: true });
    }
    const guard = (): Result<true, DomainError> => {
      if (!controller.signal.aborted) return ok(true);
      const reason = controller.signal.reason;
      return err(reason instanceof DomainError ? reason : turnCancelled());
    };
    /*
     * F5 — SETTLEMENT OWNERSHIP. From `prepare` until a terminal settlement this turn
     * OWNS its deferred execution: the AgentRuntime returns the provider result
     * unsettled (deferCompletion), so EVERY exit after that point must leave the row
     * terminal. The execution state machine is the sole arbitration — a row already
     * settled by an earlier winner (the runtime's own failure path, the deadline
     * settler, restart recovery) refuses the second transition, so exactly one
     * settlement ever lands. Without this, a refused Decision (a sink evidence
     * validation, a guard abort) used to return and leave the row RUNNING forever:
     * the observed production burst.
     */
    let inflightExecutionId: string | null = null;
    /** The bounded settlement window: attempts within THIS operation before failing typed. */
    const SETTLEMENT_ATTEMPTS = 4;
    /**
     * F5-B-R1 — BOUNDED SETTLEMENT OWNERSHIP. The turn OWNS its deferred execution from
     * `prepare` until a durable settlement lands; no NORMAL return may leave it RUNNING
     * without an explicit, typed statement of that fact. Every attempt goes through the
     * canonical arbiter against FRESH durable truth:
     *
     *   - the settlement lands, or loses to an already-terminal row (durable truth wins —
     *     settled either way);
     *   - the row carries a durably COMMITTED outcome (F5-C-R1): a failure/cancel may not
     *     reinterpret it — the committed state is CONVERGED (COMPLETED) instead;
     *   - a transient write throw is retried within this bounded operation (if storage
     *     recovers here, the row is settled before the turn returns);
     *   - beyond the bound, the caller receives a TYPED SETTLEMENT/PERSISTENCE failure
     *     (never a fabricated timeout/cancel result) and the durable RUNNING row stays
     *     owned by the EXISTING restart recovery — the sanctioned higher-level failure
     *     path, documented at its return site.
     */
    const settleOwnedExecution = async (input: {
      readonly error: DomainError;
      readonly kindOverride?: 'INVALID_OUTPUT';
      readonly usage?: Parameters<typeof deps.agentRuntime.completeExecution>[0]['usage'];
    }): Promise<{ readonly settled: boolean; readonly error: DomainError | null }> => {
      const owned = inflightExecutionId;
      if (owned === null) return { settled: true, error: null };
      const details = (input.error.details ?? {}) as Record<string, unknown>;
      const kindFromDetails = typeof details['kind'] === 'string' ? details['kind'] : undefined;
      const executionError = normalizeExecutionError({
        ...((input.kindOverride ?? kindFromDetails) === undefined
          ? {}
          : { kind: (input.kindOverride ?? kindFromDetails) as never }),
        code: input.error.code,
        message: input.error.message,
        details,
      });
      let lastFailure: DomainError | null = null;
      for (let attempt = 0; attempt < SETTLEMENT_ATTEMPTS; attempt += 1) {
        try {
          const failed = await deps.agentRuntime.failExecution({
            executionId: owned,
            actorId: command.actorId,
            error: executionError,
          });
          const refusal =
            failed.ok
              ? ''
              : String(((failed.error.details ?? {}) as Record<string, unknown>)['reason'] ?? '');
          if (refusal === 'EXECUTION_OUTCOME_COMMITTED') {
            // F5-C-R1 convergence: the outcome is COMMITTED — settle the committed
            // terminal state (COMPLETED) instead of reinterpreting the turn.
            await deps.agentRuntime.completeExecution({
              executionId: owned,
              actorId: command.actorId,
              resultRef: null,
              artifacts: [],
              ...(input.usage === undefined ? {} : { usage: input.usage }),
            });
          }
          inflightExecutionId = null;
          return { settled: true, error: null };
        } catch (error) {
          lastFailure =
            error instanceof DomainError
              ? error
              : domainError('PERSISTENCE_FAILED', error instanceof Error ? error.message : String(error));
          if (attempt + 1 < SETTLEMENT_ATTEMPTS) {
            await new Promise<void>((resolve) => {
              deps.timer(10 * (attempt + 1), () => resolve());
            });
          }
        }
      }
      return {
        settled: false,
        error: domainError(
          'PERSISTENCE_FAILED',
          `The owned execution "${owned}" could not be settled durably within this operation; the durable RUNNING row stays owned by the existing restart recovery.`,
          {
            reason: 'SUPERVISOR_SETTLEMENT_PERSISTENCE_FAILED',
            executionId: owned,
            attempts: SETTLEMENT_ATTEMPTS,
            cause: lastFailure?.message ?? null,
          },
        ),
      };
    };
    /*
     * F5 — the model invocation races THIS turn's deadline/cancellation. The loser (a
     * provider promise that resolves late or never) cannot reach any writer afterwards:
     * once the race has resolved, the turn returns and its late completion only settles
     * an already-settled promise. UNKNOWN stays honest — no proposal is invented for a
     * result nobody waited for.
     */
    const awaitModelOrDeadline = <T>(pending: Promise<T>): Promise<Result<T, DomainError>> =>
      new Promise((resolve) => {
        if (controller.signal.aborted) {
          resolve(err(abortReasonOf(controller.signal)));
          return;
        }
        const onAbort = (): void => {
          controller.signal.removeEventListener('abort', onAbort);
          resolve(err(abortReasonOf(controller.signal)));
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        pending.then(
          (value) => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve(ok(value));
          },
          (error: unknown) => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve(
              err(
                error instanceof DomainError
                  ? error
                  : domainError('PERSISTENCE_FAILED', error instanceof Error ? error.message : String(error)),
              ),
            );
          },
        );
      });
    try {
      /* ---- load trusted Run ------------------------------------------------ */
      const run = await deps.runs.get(command.runId as never);
      if (run === null || run.companyId !== command.companyId) {
        return err(
          domainError('NOT_FOUND', `Run "${command.runId}" does not exist for this company.`, {
            reason: 'RUN_MISSING',
            runId: command.runId,
          }),
        );
      }
      const afterRun = guard();
      if (!afterRun.ok) return afterRun;

      /* ---- load canonical Goal + verify the pin (zero model call, zero decision) */
      const goal = await deps.runGoal.get({ runId: run.id, companyId: command.companyId });
      if (!goal.ok) return goal;
      const afterGoal = guard();
      if (!afterGoal.ok) return afterGoal;
      const pinned = await deps.runSnapshotVerifier.verify({
        runId: run.id,
        snapshotId: run.snapshotId,
      });
      if (!pinned.ok) return pinned;
      const afterPin = guard();
      if (!afterPin.ok) return afterPin;

      /* ---- an existing durable Decision for this identity ends the turn ------ */
      const decisionId = deps.decisionSink.decisionIdOf(command.companyId, command.commandId);
      /*
       * 25b98d1 — ONE replay projection for every replay path (turn-start replay and the
       * admission-claim loss): replayed=true and the EXACT producing execution identity,
       * so a loser can never pretend the Decision belongs to itself.
       */
      const replayOf = async (
        decision: DecisionRecord,
      ): Promise<Result<SupervisorDecisionTurnResult, DomainError>> => {
        const envelope = decision.metadata as Record<string, unknown> | null;
        const supervisor =
          envelope !== null && isRecord(envelope['supervisor']) ? envelope['supervisor'] : {};
        const provenanceExecutionId = supervisor['executionId'];
        const executions = await deps.agentRuntime.list({ runId: run.id }, command.actorId);
        const origin =
          executions.ok === true
            ? (executions.value.find(
                (execution: { readonly executionId: string; readonly traceId?: string | null }) =>
                  typeof provenanceExecutionId === 'string' && provenanceExecutionId !== ''
                    ? execution.executionId === provenanceExecutionId
                    : execution.traceId === decision.traceId,
              ) ?? null)
            : null;
        return ok({
          decisionId: decision.decisionId,
          executionId: origin?.executionId ?? '',
          action: String(decision.decision) as SupervisorDecisionAction,
          reasonCode: String(supervisor['reasonCode'] ?? '') as SupervisorDecisionReason,
          replayed: true,
          contextRefs: [],
        });
      };
      const existing = await deps.decisionSink.getDecision({
        decisionId,
        companyId: command.companyId,
        actorId: command.actorId,
      });
      // The reader reports ABSENCE as `NOT_FOUND` (a foreign tenant is indistinguishable from
      // absent, by the same ruling). Any other failure is a real error and fails the turn.
      if (!existing.ok && existing.error.code !== 'NOT_FOUND') return existing;
      if (existing.ok === true && existing.value !== null) {
        // Idempotent replay: no model call, no second execution, no second Decision.
        return replayOf(existing.value);
      }
      const afterReplay = guard();
      if (!afterReplay.ok) return afterReplay;

      /* ---- bounded context + pinned binding --------------------------------- */
      const built = await buildContext({
        companyId: command.companyId,
        runId: run.id,
        taskId: command.taskId,
        ...(command.reviewTaskId === undefined ? {} : { reviewTaskId: command.reviewTaskId }),
        actorId: command.actorId,
      });
      if (!built.ok) return built;
      const context = built.value;
      const afterContext = guard();
      if (!afterContext.ok) return afterContext;

      const binding = await deps.modelBindings.resolve(
        { runId: run.id, companyId: command.companyId, bindingName: deps.supervisorBindingKey },
        deps.modelRegistry,
      );
      if (!binding.ok) return binding;
      if (
        binding.value.enabled !== true ||
        UNPINNABLE_AVAILABILITY.includes(binding.value.availability)
      ) {
        return err(
          domainError(
            'NOT_FOUND',
            `The pinned binding "${deps.supervisorBindingKey}" is not usable (${binding.value.availability}).`,
            {
              reason: 'RUN_BINDING_UNUSABLE',
              bindingName: deps.supervisorBindingKey,
              modelKey: binding.value.modelKey,
              availability: binding.value.availability,
            },
          ),
        );
      }
      const afterBinding = guard();
      if (!afterBinding.ok) return afterBinding;

      /* ---- durable AgentExecution, generic supervisor identity --------------- */
      const prepared = await deps.agentRuntime.prepare({
        modelKey: binding.value.modelKey,
        explicit: true,
        scopes: [],
        agentId,
        roleId,
        taskId: context.subject.taskId,
        runId: run.id,
        actorId: command.actorId,
        // 25b98d1 — the frozen logical-turn identity: the ATOMIC durable admission
        // claim behind the GLOBAL unique index (one historical owner per turn).
        logicalTurnId: command.commandId,
        // 6ec4d81 — the admission-fixed whole-turn deadline rides the claim transaction
        // (a bounded supervisor claim row never carries a NULL deadline).
        decisionAuthorityExpiresAt: absoluteDeadlineIso,
        ...(command.traceId === undefined ? {} : { traceId: command.traceId }),
      });
      if (!prepared.ok) {
        const claimReason = String(prepared.error.details['reason'] ?? '');
        if (claimReason === 'LOGICAL_TURN_ALREADY_CLAIMED') {
          /*
           * 25b98d1 — the admission claim was lost to a concurrent contender. The
           * canonical Decision is re-checked FIRST: when it committed, the loser
           * REPLAYS IT with exact provenance; otherwise a typed in-flight result
           * leaves — zero provider calls, no second reasoning execution, no budget
           * burn.
           */
          const decided = await deps.decisionSink.getDecision({
            decisionId,
            companyId: command.companyId,
            actorId: command.actorId,
          });
          if (decided.ok === true && decided.value !== null) {
            return replayOf(decided.value);
          }
          /*
           * CASE C — the owner is TERMINAL without a Decision: the logical turn is dead.
           * This contender must NOT create a second reasoning execution under the same
           * identity; the loop advances to the NEXT turn index (a NEW logicalTurnId),
           * leaving the question "is another reasoning cycle needed?" to the canonical
           * workflow progression.
           */
          const ownerStatus = String(prepared.error.details['ownerStatus'] ?? '');
          const ownerTerminal =
            ownerStatus === 'COMPLETED' ||
            ownerStatus === 'FAILED' ||
            ownerStatus === 'CANCELLED' ||
            ownerStatus === 'INTERRUPTED';
          if (ownerTerminal && prepared.error.details['ownerCommitted'] === null) {
            return err(
              domainError(
                'CONFLICT',
                'The logical supervisor turn "' + command.commandId + '" already settled without a Decision.',
                {
                  reason: 'SUPERVISOR_TURN_SETTLED_WITHOUT_DECISION',
                  logicalTurnId: command.commandId,
                  ownerExecutionId: prepared.error.details['ownerExecutionId'] ?? null,
                  ownerStatus: prepared.error.details['ownerStatus'] ?? null,
                },
              ),
            );
          }
          return err(
            domainError(
              'CONFLICT',
              'The logical supervisor turn "' + command.commandId + '" is already owned by a concurrent execution.',
              {
                reason: 'SUPERVISOR_TURN_ALREADY_OWNED',
                logicalTurnId: command.commandId,
                ownerExecutionId: prepared.error.details['ownerExecutionId'] ?? null,
                ownerStatus: prepared.error.details['ownerStatus'] ?? null,
              },
            ),
          );
        }
        return prepared;
      }
      const executionId = prepared.value.executionId;
      inflightExecutionId = executionId;
      await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.supervisorExecutionCreated);
      // The execution's own correlation id: the Decision shares it, so the two durable rows
      // are joined by an existing field rather than by an invented ref namespace.
      const traceId = prepared.value.traceId;
      const afterPrepare = guard();
      if (!afterPrepare.ok) {
        // The turn is over; the durable record must say so rather than dangle READY.
        await deps.agentRuntime.cancel(executionId, command.actorId);
        inflightExecutionId = null;
        return afterPrepare;
      }

      /* ---- ONE model invocation, structurally tool-less ---------------------- */
      // F5 — the invocation races this turn's deadline/cancellation: the durable
      // execution settles at the FIRST of (provider result, deadline, cancellation) and
      // a provider promise that resolves late or never can neither hang the turn nor
      // reach a writer afterwards.
      const raced = await awaitModelOrDeadline(
        runModelOnce(
          context,
          executionId,
          command.actorId,
          controller.signal,
          context.allowedActions,
          // 25b98d1/N9-B1 — the admission-fixed absolute deadline (never recomputed).
          absoluteDeadlineIso,
        ),
      );
      const outcome = raced.ok ? raced.value : err(raced.error);
      // Task-18-08: the provider result exists ONLY in memory here — a crash must not leave a
      // Decision the model never durably proposed.
      if (outcome.ok) {
        await deps.faultCheckpoints?.checkpoint(FAULT_CHECKPOINTS.providerResultBeforeDecision);
      }
      const afterModel = guard();
      if (!afterModel.ok) {
        // Aborted in flight (or before the first byte): no Decision, no completion. The signal
        // reached the provider, so the model call itself terminates; the durable CANCELLED
        // record is what stops a retry from re-using this execution, and
        // `recoverInterrupted` never re-invokes a provider. F5: the deadline path may have
        // raced here — the state machine arbitrates, exactly one settlement lands.
        await deps.agentRuntime.cancel(executionId, command.actorId);
        inflightExecutionId = null;
        return afterModel;
      }
      if (!outcome.ok) {
        // F5 — a runtime failure after the provider call still owns the row: settle it
        // with the typed failure instead of returning a dangling RUNNING execution.
        const settlement = await settleOwnedExecution({ error: outcome.error });
        return settlement.settled ? outcome : err(settlement.error as never);
      }
      const afterProvider = guard();
      if (!afterProvider.ok) {
        await deps.agentRuntime.cancel(executionId, command.actorId);
        inflightExecutionId = null;
        return afterProvider;
      }

      /* ---- strict parse ------------------------------------------------------ */
      const decoded = decodeSupervisorProposal(outcome.value.structured);
      if (!decoded.ok) {
        await deps.agentRuntime.failExecution({
          executionId,
          actorId: command.actorId,
          error: normalizeExecutionError({
            kind: 'INVALID_OUTPUT',
            code: decoded.error.code,
            message: decoded.error.message,
            details: decoded.error.details,
          }),
        });
        return decoded;
      }
      const afterParse = guard();
      if (!afterParse.ok) {
        // F5 — an abort after the parse must still settle the owned row.
        const settlement = await settleOwnedExecution({
          error: afterParse.error,
          usage: outcome.value.usage,
        });
        return settlement.settled ? afterParse : err(settlement.error as never);
      }

      // A VALIDATION_FAILED corrective cause is canonically the failing validation LINE.
      // The proposal may legally cite one of the row's evidence artifacts instead of the
      // row itself, but the recorded Decision must always carry the branded ValidationId
      // (bare `val_<ulid>` — Task-13-09 grammar) so the corrective provisioner resolves
      // the cause from the validation line, never from an executor-output artifact. F1
      // closure: the id comes from the ACTIONABLE blocking row (never a consumed one).
      const proposal = decoded.value;
      const actionableCause =
        proposal.reasonCode === 'VALIDATION_FAILED' ? context.blockingValidations[0] : undefined;
      const correctiveValidationId = actionableCause === undefined ? null : actionableCause.validationId;
      const validatedProposal: SupervisorProposal =
        correctiveValidationId === null || proposal.evidenceRefs.includes(correctiveValidationId)
          ? proposal
          : { ...proposal, evidenceRefs: [...proposal.evidenceRefs, correctiveValidationId] };

      /* ---- semantic validation ---------------------------------------------- */
      const validated = validateProposal(validatedProposal, context);
      if (!validated.ok) {
        await deps.agentRuntime.failExecution({
          executionId,
          actorId: command.actorId,
          error: normalizeExecutionError({
            kind: 'INVALID_OUTPUT',
            code: validated.error.code,
            message: validated.error.message,
            details: validated.error.details,
          }),
        });
        return validated;
      }
      const afterValidation = guard();
      if (!afterValidation.ok) {
        // F5 — an abort after the semantic validation must still settle the owned row.
        const settlement = await settleOwnedExecution({
          error: afterValidation.error,
          usage: outcome.value.usage,
        });
        return settlement.settled ? afterValidation : err(settlement.error as never);
      }

      /* ---- the Decision, through the ONE T18-03 sink ------------------------- */
      /*
       * F5-C — the sink call races THIS turn's deadline/cancellation, and the durable
       * Decision is arbitrated at the canonical boundary:
       *   - the sink commits ONLY while the owning execution is durably RUNNING
       *     (`authorizedExecutionId`); once the abort wins with NO durable Decision,
       *     the still-in-flight sink call has lost its authority — its commit gate
       *     finds a settled row and refuses, so no Decision can appear later;
       *   - an abort that fires AFTER the commit landed cannot erase it: the race
       *     loss is re-read below against the durable row and the execution is
       *     settled with the REAL provider result instead of a fabricated failure.
       */
      const racedRecord = await awaitModelOrDeadline(
        deps.decisionSink.record({
          commandId: command.commandId,
          companyId: command.companyId,
          runId: run.id,
          stageId: context.subject.stageId,
          taskId: context.subject.taskId,
          action: decoded.value.action,
          reasonCode: decoded.value.reasonCode,
          summary: decoded.value.summary,
          evidenceRefs: validatedProposal.evidenceRefs,
          // The pinned binding NAME, resolved through the run's own snapshot by the sink.
          modelBindingKey: deps.supervisorBindingKey,
          decidedBy: command.actorId,
          // The execution's traceId is the correlation between the two durable rows. Both fields
          // already exist on both rows: nothing new is invented for this link (T18-06 corrective
          // §16 — `resultRef` stays an opaque string and is NOT given a new namespace here).
          traceId,
          // F5-C: the commit-authority anchor. The sink refuses to commit this Decision
          // once THIS exact execution is no longer RUNNING — the deadline/cancellation
          // that canonically won leaves a terminal row, and the late commit loses.
          authorizedExecutionId: executionId,
        }),
      );
      if (!racedRecord.ok) {
        // CASE A — the commit may have landed anyway (the abort raced the sink's own
        // post-commit tail). The durable Decision ROW decides which window this is,
        // never the in-memory abort flag: if it exists, the commit WON, the execution
        // is settled with the REAL provider result, and the deadline has no authority
        // to erase it (the Decision replays by its identity, zero model calls).
        const landed = await deps.decisionSink.getDecision({
          decisionId,
          companyId: command.companyId,
          actorId: command.actorId,
        });
        if (landed.ok) {
          await deps.agentRuntime.completeExecution({
            executionId,
            actorId: command.actorId,
            resultRef: null,
            artifacts: [],
            usage: outcome.value.usage,
          });
          inflightExecutionId = null;
          return err(racedRecord.error);
        }
        // CASE B — no durable Decision: the deadline/cancellation WON. The owning row
        // is settled terminally here, and the still-in-flight sink call has no way
        // back in: its durable commit stamp refuses a non-RUNNING owner (no late
        // Decision). F5-B-R1: the settlement is BOUNDED within this operation; if the
        // durable write cannot land at all, the TYPED settlement/persistence failure
        // is reported instead (never a fabricated timeout result) and the RUNNING row
        // stays owned by the existing restart recovery.
        const settlement = await settleOwnedExecution({
          error: racedRecord.error,
          usage: outcome.value.usage,
        });
        return settlement.settled ? err(racedRecord.error) : err(settlement.error as never);
      }
      // The outer race protected the deadline; the inner Result is the sink's own
      // (unchanged) contract: ok ⇒ committed Decision, err ⇒ refused/refused-by-arbitration.
      const recorded = racedRecord.value;
      // F5 — ARBITRATION: the durable Decision ROW, not the in-memory abort flag, decides
      // which window this is. `recorded.ok === true` proves the commit landed even if a
      // cancellation fired inside the sink (the §47 late-cancellation window); the
      // pre-commit branch below is only for a turn that aborted with NO Decision.
      if (recorded.ok) {
        // Task-18-08: the Decision is durable but the execution is not yet settled — restart
        // must preserve this Decision, mint no second one, and not re-call the provider.
        await deps.faultCheckpoints?.checkpoint(
          FAULT_CHECKPOINTS.decisionCommitBeforeExecutionComplete,
        );
      }
      const afterSink = guard();
      if (!afterSink.ok) {
        if (recorded.ok) {
          // F5 — the commit WON and a live cancellation followed: settle the row with the
          // real provider result (best-effort; an already-terminal row — the deadline
          // settler won — stays untouched). UNKNOWN is never fabricated into success: the
          // turn still reports CANCELLED and the Decision replays by its identity.
          await deps.agentRuntime.completeExecution({
            executionId,
            actorId: command.actorId,
            resultRef: null,
            artifacts: [],
            usage: outcome.value.usage,
          });
          inflightExecutionId = null;
        } else {
          // F5 — the pre-commit abort still owns the (unsettled) row: settle it (bounded).
          const settlement = await settleOwnedExecution({
            error: afterSink.error,
            usage: outcome.value.usage,
          });
          if (!settlement.settled) return err(settlement.error as never);
        }
        return afterSink;
      }
      if (!recorded.ok) {
        /*
         * F5 — THE INCIDENT PATH. A Decision the authority REFUSED (an unresolvable
         * evidence citation, a cross-run ref, an unwritable row) used to return here and
         * leave the execution RUNNING forever: the replay lookup then missed (no
         * Decision was recorded), every subsequent autonomy step re-ran the same logical
         * turn as a NEW execution, and the run accumulated dangling supervisor rounds
         * until its step budget died. The refusal is now settled durably and typed
         * INVALID_OUTPUT — the model's proposal could not become a Decision — so the
         * refusal is visible, bounded by the durable illegal-proposal budget, and never
         * requires a restart to clean up.
         */
        // A proposal-quality refusal (the authority rejected the MODEL's proposal — its
        // evidence citations, its anchors) is an ILLEGAL PROPOSAL in the budget's
        // vocabulary: wrap it with the SUPERVISOR_PROPOSAL_ reason so the durable budget
        // counts it. An infrastructure refusal (a persistence failure) is returned as-is
        // and never counted against the model.
        const sinkCode = recorded.error.code;
        const sinkReason = String(recorded.error.details['reason'] ?? '');
        /*
         * F5-C — an ARBITRATION LOSS is not a model fault: the sink refused because the
         * owning execution was already settled by the canonical winner. The refusal is
         * reported as-is and is NOT wrapped as SUPERVISOR_PROPOSAL_SINK_REFUSED, so the
         * durable illegal-proposal budget never counts it against the model.
         */
        const arbitrationLoss = sinkReason === 'SUPERVISOR_DECISION_EXECUTION_TERMINAL';
        const proposalQualityRefusal =
          !arbitrationLoss &&
          (sinkCode === 'VALIDATION_FAILED' ||
            sinkCode === 'NOT_FOUND' ||
            sinkCode === 'INVALID_ARGUMENT' ||
            sinkCode === 'CONFLICT');
        const turnError = proposalQualityRefusal
          ? domainError('VALIDATION_FAILED', recorded.error.message, {
              reason: 'SUPERVISOR_PROPOSAL_SINK_REFUSED',
              sinkCode,
              sinkReason,
            })
          : recorded.error;
        const settlement = await settleOwnedExecution({
          error: turnError,
          kindOverride: proposalQualityRefusal ? 'INVALID_OUTPUT' : undefined,
          usage: outcome.value.usage,
        });
        return settlement.settled ? err(turnError) : err(settlement.error as never);
      }

      const decision = recorded.value;
      // Abort AFTER the commit: the Decision is durable and a retry with the same identity
      // replays it (zero model calls). This call reports the cancellation — it does NOT
      // fabricate anything: the provider result and the Decision are both real, so the
      // execution is settled COMPLETED (best-effort; an already-terminal row — the
      // deadline settler won the race — stays untouched) instead of waiting for a
      // restart to clean up a stale RUNNING row.
      const late = guard();
      if (!late.ok) {
        await deps.agentRuntime.completeExecution({
          executionId,
          actorId: command.actorId,
          resultRef: null,
          artifacts: [],
          usage: outcome.value.usage,
        });
        inflightExecutionId = null;
        return late;
      }

      /* ---- only now may the execution be COMPLETED (§45) --------------------- */
      const completed = await deps.agentRuntime.completeExecution({
        executionId,
        actorId: command.actorId,
        // `resultRef` is an OPAQUE string by the frozen Sprint-13 contract (S13 concept map:
        // "单个不透明字符串"), and there is no canonical Decision-ref grammar in the codebase.
        // Inventing `decision:<id>@<version>` for T18-06 would create a namespace nobody else
        // parses, so the link to the Decision is the traceId correlation above, and resultRef
        // is left null rather than given a bespoke spelling.
        resultRef: null,
        artifacts: [],
        // The usage the provider actually reported for this attempt — never invented here.
        usage: outcome.value.usage,
      });
      inflightExecutionId = null;
      if (!completed.ok) return completed;

      return ok({
        decisionId: decision.decisionId,
        executionId,
        action: decoded.value.action,
        reasonCode: decoded.value.reasonCode,
        replayed: false,
        contextRefs: context.refs,
      });
    } catch (error) {
      /*
       * F5-B — NO EXIT MAY ABANDON THE OWNED ROW. A THROW — a sink/store rejection that
       * escaped every earlier window, or a failure inside the settlement chain itself —
       * is an exit exactly like a return: the owned deferred execution is settled through
       * the ONE canonical arbiter before the error leaves this call. RUNNING can never be
       * abandoned by an exception; a failed settlement write keeps its ownership and is
       * RETRIED here (the arbiter refuses a retry after a landed transition — one event).
       *
       * The `FaultCrashError` sentinel still stands for a KILLED process and is re-thrown
       * WITHOUT settling (a real crash runs no catch): its window belongs to the existing
       * restart recovery, never to this handler.
       */
      if (error instanceof FaultCrashError) throw error;
      const aborted = controller.signal.aborted ? abortReasonOf(controller.signal) : null;
      const domain =
        error instanceof DomainError
          ? error
          : domainError(
              'PERSISTENCE_FAILED',
              error instanceof Error ? error.message : String(error),
            );
      // The canonical reason: a turn that HAD been aborted by its deadline/cancellation
      // settles with that reason — the throw merely interrupted the settlement chain, it is
      // not the semantic cause; otherwise the thrown error itself is the reason.
      const settlementError = aborted ?? domain;
      const settlement = await settleOwnedExecution({ error: settlementError });
      // F5-B-R1: when the durable settlement cannot land within this bounded operation,
      // the caller receives the TYPED settlement/persistence failure — never the aborted
      // reason pretending the row was settled. The durable RUNNING row is then exactly the
      // one the EXISTING restart recovery settles (documented recovery ownership).
      return settlement.settled ? err(settlementError) : err(settlement.error as never);
    } finally {
      releaseTimer();
      if (caller !== undefined) caller.removeEventListener('abort', onCallerAbort);
    }
  };

  /**
   * The one model round of the turn. There is no `toolIds` and no `tools` here, so nothing
   * declares a tool to the model and no tool descriptor can reach the prompt; `runToolCall`
   * is never called and this module holds no tool dependency at all.
   *
   * CANCELLATION IS REAL, NOT A RACE (T18-06 corrective): the turn's AbortSignal is forwarded
   * into the AgentRuntime and from there into the provider invocation, so when it fires the
   * provider terminates the model call itself and the attempt settles as a cancellation. There
   * is deliberately no `Promise.race` here — racing would let this runtime report success while
   * the provider kept running, which is exactly the ghost execution the contract forbids.
   */
  const runModelOnce = async (
    context: SupervisorContext,
    executionId: string,
    actorId: string,
    signal: AbortSignal,
    allowedActions: readonly SupervisorDecisionAction[],
    decisionAuthorityExpiresAt: string,
  ): Promise<Result<AgentRunOutcome, DomainError>> => {
    // Defence in depth: an already-aborted turn never reaches the provider at all.
    if (signal.aborted) return err(abortReasonOf(signal));
    return deps.agentRuntime.runWithOutput({
      executionId,
      actorId,
      context: {
        company: { id: context.companyId, label: context.companyId },
        workflow: { id: context.run.templateId, label: 'workflow' },
        workflowVersion: context.run.workflowVersionId,
        workflowRun: { id: context.runId, label: 'run' },
        stage: { id: context.subject.stageId, label: 'stage' },
        task: { id: context.subject.taskId, label: 'subject task' },
        role: { id: roleId, label: 'supervisor' },
        objective: context.goal.objective,
        // The system contract states the rules; the CONTEXT PROJECTION rides the bounded
        // memory-view seat, and never the instruction seat, so the seat can never reject a
        // context this runtime already accepted.
        instructions: [supervisorSystemPrompt(allowedActions)],
        constraints: supervisorConstraints().slice(0, SUPERVISOR_CONTEXT_LIMITS.maxConstraints),
        acceptanceCriteria: [],
        memoryView: [renderSupervisorContext(context)],
        decisionView: context.decisions
          .slice(0, SUPERVISOR_CONTEXT_LIMITS.maxDecisionViewEntries)
          .map((decision) => canonicalJson(decision)),
        artifactRefs: context.refs
          .filter((ref) => ref.kind === 'review')
          .map((ref) => ({ id: ref.id, label: 'latest review report' })),
      },
      prompt: {
        // The role-correct constrained-generation contract (BB-WATCH-001): the strict
        // decodeSupervisorProposal stays the authority — the schema mirrors its shapes.
        responseFormat: {
          mode: 'json_schema',
          schemaName: 'companyos_supervisor_proposal',
          schema: proposalSchemaFor(allowedActions),
        },
        // No tools, no toolIds: the Supervisor model cannot call a tool by construction.
      },
      deferCompletion: true,
      // 9dc9943: the durable decision-authority expiry rides the start write.
      decisionAuthorityExpiresAt,
      // The turn's own signal: the provider terminates the invocation when it fires.
      signal,
    });
  };

  return { buildContext, runOneSupervisorDecisionTurn };
}
