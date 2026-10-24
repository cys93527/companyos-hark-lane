/**
 * Bounded stateless role-context projectors (Sprint 19 / Task-19-04).
 *
 * The review and validation roles are STATE-RECONSTRUCTED: they own NO durable conversational
 * session, so every legal invocation re-reads the canonical state fresh and receives exactly
 * the bounded facts its responsibility needs — nothing else:
 *
 *   review  answers: "Does the current delivered work satisfy the required task?"
 *   validation answers: "Does current work satisfy the configured validation requirements?"
 *
 * Every projected field is classified (AUTHORITATIVE_FACT / CANONICAL_REF / PRESENTATION) and
 * every bound is a COUNT selection with an explicit `truncated` flag — never silent text
 * shortening. Facts that CompanyOS does not canonically hold (acceptance criteria, change-set
 * summaries) are projected as `null` with an explicit marker: absent, never fabricated. There
 * is deliberately NO session-kernel dependency in this module: the role runtimes it serves
 * must be structurally unable to reach any durable session transcript.
 */
import {
  STAGE_OUTPUT_TASK_KEY,
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from '@companyos/core';

import { decideTokenBudget } from '../session/token-budget.js';
import { REQUIRED_QA_EVIDENCE_SLOTS } from '../repository/qa-evidence.js';

/** Count-selection bounds (the supervisor-context convention: caps + visible truncation flags). */
export const BOUNDED_AGENT_CONTEXT_LIMITS = {
  maxRefs: 16,
  maxFindings: 8,
  maxSummaryChars: 400,
  maxOutputPayloadChars: 800,
  maxInputsChars: 4_000,
  /** The provider-neutral reserved output window, identical to the session runtime's. */
  reservedOutputTokens: 1_024,
} as const;

/** The §24 classification vocabulary: presentation strings never become domain truth. */
export type BoundedContextFieldClass =
  | 'AUTHORITATIVE_FACT'
  | 'CANONICAL_REF'
  | 'NON_AUTHORITY_PRESENTATION';

export interface BoundedAgentContextDeps {
  readonly runs: {
    get(runId: string): Promise<{
      readonly id: string;
      readonly companyId: string;
      readonly workflowId: string;
      readonly templateId: string;
      readonly versionId: string;
    } | null>;
  };
  readonly tasks: {
    get(taskId: string): Promise<{
      readonly id: string;
      /** T20-03A: canonical run ownership — a projection may never present a foreign-run task. */
      readonly runId: string;
      readonly stageId: string;
      readonly kind: string;
      readonly state: string;
      readonly inputs: Readonly<Record<string, unknown>>;
      readonly outputs: Readonly<Record<string, unknown>>;
    } | null>;
  };
  /** The canonical run-owned Goal reader (the same seam the session runtime uses). */
  readonly goal: {
    get(input: {
      readonly runId: string;
      readonly companyId: string;
    }): Promise<Result<{ readonly objective: string }, DomainError>>;
  };
  /** The LATEST canonical review report across the run's review anchors (anti-cherry-pick). */
  readonly latestReviewReport: (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly actorId: string;
  }) => Promise<Result<BoundedLatestReview | null, DomainError>>;
  /** Newest-first canonical validation rows of the run (metadata only). */
  readonly latestValidation: {
    listByRun(runId: string): Promise<
      readonly {
        readonly id: string;
        readonly status: string;
        readonly validatorId: string;
        readonly targetRef: string;
      }[]
    >;
  };
  /** The required validator ids of a stage, from the run's PINNED version (never a claim). */
  readonly requiredValidators: (
    runId: string,
    stageId: string,
  ) => Promise<Result<readonly string[], DomainError>>;
  /** The open workspace anchor identity, when a workspace is open (reference only). */
  readonly anchorIdentity: () => Promise<{ readonly workspaceId: string } | null>;
  /**
   * The run's CURRENT delivering work task (the review/validation business subject). Trusted
   * derivation from the pinned graph — never the instrumental review/qa task itself.
   */
  readonly subjectTaskOf: (runId: string) => Promise<string | null>;
  /** The run's canonical goal artifact ref (`artifact:<id>`), when the store holds one. */
  readonly goalArtifactRef: (runId: string) => Promise<string | null>;
  readonly clock: { nowIso(): string };
}

/** The latest canonical review report, as the projectors consume it. */
export interface BoundedLatestReview {
  readonly artifactId: string;
  readonly verdict: string;
  readonly subjectTaskId: string | null;
  readonly createdAt: string;
  readonly findings: readonly {
    readonly code: string;
    readonly summary: string;
    readonly blocking: boolean;
  }[];
}

const boundedText = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;

/** The corrective lineage of a task row, when it carries one (the T18-05 canonical shape). */
const lineageOf = (
  inputs: Readonly<Record<string, unknown>>,
): { readonly parentTaskId: string; readonly round: number } | null => {
  const raw = inputs['corrective'];
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const parent = typeof record['parentTaskId'] === 'string' ? record['parentTaskId'] : null;
  const round = typeof record['round'] === 'number' ? record['round'] : null;
  if (parent === null || round === null) return null;
  return { parentTaskId: parent, round };
};

/** A bounded JSON rendering of a structured value (truncation is flagged by the caller). */
const boundedJson = (value: unknown, maxChars: number): { text: string; truncated: boolean } => {
  const full = JSON.stringify(value) ?? 'null';
  return full.length <= maxChars
    ? { text: full, truncated: false }
    : { text: `${full.slice(0, maxChars)}…`, truncated: true };
};

/** The refs a task's durable stage-output envelope carries, when it carries one. */
const deliveredOutputsOf = (
  task: {
    readonly outputs: Readonly<Record<string, unknown>>;
  },
  limits: typeof BOUNDED_AGENT_CONTEXT_LIMITS,
): BoundedDeliveredOutputs | null => {
  const raw = task.outputs[STAGE_OUTPUT_TASK_KEY];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const refs = Array.isArray(record['artifactRefs'])
    ? (record['artifactRefs'] as unknown[]).filter(
        (ref): ref is string => typeof ref === 'string',
      )
    : [];
  const payload =
    typeof record['payload'] === 'object' && record['payload'] !== null
      ? boundedJson(record['payload'], limits.maxOutputPayloadChars)
      : null;
  return {
    refs: refs.slice(0, limits.maxRefs),
    payload: payload === null ? null : payload.text,
    payloadTruncated: payload === null ? false : payload.truncated,
  };
};

/** The canonical facts one delivered task carries (bounded, refs-only payload rendering). */
export interface BoundedDeliveredOutputs {
  readonly refs: readonly string[];
  readonly payload: string | null;
  readonly payloadTruncated: boolean;
}

/** The shared canonical subject the review/validation roles evaluate. */
export interface BoundedSubject {
  readonly taskId: string;
  readonly kind: string;
  readonly state: string;
  /** Bounded canonical Task inputs (scope/constraints the task row carries), JSON-rendered. */
  readonly inputsJson: string | null;
  readonly inputsTruncated: boolean;
  readonly lineage: { readonly parentTaskId: string; readonly round: number } | null;
  readonly lineageJson: string | null;
  readonly lineageTruncated: boolean;
  readonly delivered: BoundedDeliveredOutputs | null;
}

/** The shared canonical spine every role projection starts from. */
export interface BoundedSpine {
  readonly run: {
    readonly id: string;
    readonly companyId: string;
    readonly workflowId: string;
    readonly templateId: string;
    readonly versionId: string;
  };  readonly goal: { readonly objective: string } | null;
  /** The run's canonical goal artifact ref (`artifact:<id>`), when the store holds one. */
  readonly goalArtifactRef: string | null;
  readonly anchor: { readonly workspaceId: string } | null;
  readonly subject: BoundedSubject | null;
}

/** The shared canonical spine every role projection starts from (read FRESH each invocation). */
const readSpine = async (
  deps: BoundedAgentContextDeps,
  input: { readonly companyId: string; readonly runId: string },
): Promise<Result<BoundedSpine, DomainError>> => {
  const run = await deps.runs.get(input.runId);
  if (run === null || run.companyId !== input.companyId) {
    return err(
      domainError('NOT_FOUND', `Run "${input.runId}" does not exist for this company.`, {
        reason: 'RUN_MISSING',
        runId: input.runId,
      }),
    );
  }
  const goal = await deps.goal.get({ runId: input.runId, companyId: input.companyId });
  if (!goal.ok) return goal;
  const goalArtifactRef = await deps.goalArtifactRef(input.runId);
  const anchor = await deps.anchorIdentity();
  const subjectTaskId = await deps.subjectTaskOf(input.runId);
  let subject: BoundedSubject | null = null;
  if (subjectTaskId !== null) {
    const row = await deps.tasks.get(subjectTaskId);
    if (row !== null) {
      const lineage = lineageOf(row.inputs);
      const lineageJson =
        lineage === null ? null : boundedJson(lineage, BOUNDED_AGENT_CONTEXT_LIMITS.maxInputsChars);
      const inputsJson =
        Object.keys(row.inputs).length === 0
          ? null
          : boundedJson(row.inputs, BOUNDED_AGENT_CONTEXT_LIMITS.maxInputsChars);
      subject = {
        taskId: row.id,
        kind: row.kind,
        state: row.state,
        inputsJson: inputsJson === null ? null : inputsJson.text,
        inputsTruncated: inputsJson === null ? false : inputsJson.truncated,
        lineage,
        lineageJson: lineageJson === null ? null : lineageJson.text,
        lineageTruncated: lineageJson === null ? false : lineageJson.truncated,
        delivered: deliveredOutputsOf(row, BOUNDED_AGENT_CONTEXT_LIMITS),
      };
    }
  }
  return ok({ run, goal: goal.value, goalArtifactRef, anchor, subject });
};

/** The projected bounded REVIEW context (T19-04 §7/§8). */
export interface BoundedReviewContext {
  readonly schema: 'companyos/review-context/1';
  readonly classification: Readonly<Record<string, BoundedContextFieldClass>>;
  readonly goal: { readonly objective: string } | null;
  /** The run's canonical goal artifact (a citable ref, never copied content). */
  readonly goalArtifactRef: string | null;
  readonly run: {
    readonly id: string;
    readonly companyId: string;
    readonly workflowId: string;
    readonly templateId: string;
    readonly versionId: string;
  };
  readonly review: { readonly taskId: string; readonly stageId: string };
  readonly subject: {
    readonly taskId: string;
    readonly kind: string;
    readonly state: string;
    readonly inputsJson: string | null;
    readonly inputsTruncated: boolean;
    readonly lineage: { readonly parentTaskId: string; readonly round: number } | null;
    readonly delivered: {
      readonly refs: readonly string[];
      readonly payload: string | null;
      readonly payloadTruncated: boolean;
    } | null;
  } | null;
  /** The latest canonical review finding (for a corrective review: what previously failed). */
  readonly priorFinding: {
    readonly artifactId: string;
    readonly verdict: string;
    readonly subjectTaskId: string | null;
    readonly blockingFindings: readonly {
      readonly code: string;
      readonly summary: string;
      readonly blocking: boolean;
    }[];
  } | null;
  readonly anchor: { readonly workspaceId: string } | null;
  /** Honest absence: acceptance criteria are NOT canonically held (T19-04 §25). */
  readonly acceptanceCriteria: null;
  readonly truncated: readonly string[];
}

/** The projected bounded VALIDATION context (T19-04 §15/§16). */
export interface BoundedValidationContext {
  readonly schema: 'companyos/validation-context/1';
  readonly classification: Readonly<Record<string, BoundedContextFieldClass>>;
  readonly goal: { readonly objective: string } | null;
  /** The run's canonical goal artifact (the legitimate validation target candidate). */
  readonly goalArtifactRef: string | null;
  readonly run: {
    readonly id: string;
    readonly companyId: string;
    readonly workflowId: string;
    readonly templateId: string;
    readonly versionId: string;
  };
  readonly validation: { readonly taskId: string; readonly stageId: string };
  readonly target: {
    readonly taskId: string;
    readonly kind: string;
    readonly state: string;
    readonly inputsJson: string | null;
    readonly inputsTruncated: boolean;
    readonly lineage: { readonly parentTaskId: string; readonly round: number } | null;
    readonly delivered: {
      readonly refs: readonly string[];
      readonly payload: string | null;
      readonly payloadTruncated: boolean;
    } | null;
  } | null;
  readonly latestReview: { readonly verdict: string; readonly artifactId: string } | null;
  readonly anchor: { readonly workspaceId: string } | null;
  /** The trusted validator configuration: the PINNED stage policy, never a model claim. */
  readonly validators: readonly string[];
  /** The frozen six-slot evidence vocabulary the canonical QA gate verifies. */
  readonly evidenceSlots: readonly { readonly slot: string; readonly toolId: string }[];
  /** Newest canonical batch metadata (anti-cherry-pick), when any exists. */
  readonly latestValidationBatch: {
    readonly id: string;
    readonly status: string;
    readonly validatorId: string;
    readonly targetRef: string;
  } | null;
  readonly truncated: readonly string[];
}

export function createBoundedAgentContext(deps: BoundedAgentContextDeps) {
  /** Project the bounded review context: canonical facts only, fresh reads, no transcript. */
  const projectReview = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly reviewTaskId: string;
    readonly actorId: string;
  }): Promise<Result<BoundedReviewContext, DomainError>> => {
    const spine = await readSpine(deps, input);
    if (!spine.ok) return spine;
    const reviewTask = await deps.tasks.get(input.reviewTaskId);
    if (reviewTask === null) {
      return err(
        domainError('NOT_FOUND', `Task "${input.reviewTaskId}" does not exist.`, {
          reason: 'TASK_MISSING',
        }),
      );
    }
    // T20-03A (§25): a projection may never present a foreign-run task — same stage, same
    // version and same company are insufficient; ownership is exact runId equality.
    if (String(reviewTask.runId) !== String(input.runId)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Task "${input.reviewTaskId}" belongs to another run.`,
          {
            reason: 'BOUNDED_CONTEXT_TASK_RUN_MISMATCH',
            runId: input.runId,
            taskId: input.reviewTaskId,
            taskRunId: String(reviewTask.runId),
          },
        ),
      );
    }
    const truncated: string[] = [];
    const report = await deps.latestReviewReport({
      companyId: input.companyId,
      runId: input.runId,
      actorId: input.actorId,
    });
    if (!report.ok) return report;
    let priorFinding: BoundedReviewContext['priorFinding'] = null;
    if (report.value !== null) {
      const blocking = report.value.findings
        .filter((finding) => finding.blocking)
        .slice(0, BOUNDED_AGENT_CONTEXT_LIMITS.maxFindings);
      if (report.value.findings.length > blocking.length) truncated.push('priorFinding.findings');
      priorFinding = {
        artifactId: report.value.artifactId,
        verdict: report.value.verdict,
        subjectTaskId: report.value.subjectTaskId,
        blockingFindings: blocking.map((finding) => ({
          code: finding.code,
          summary: boundedText(finding.summary, BOUNDED_AGENT_CONTEXT_LIMITS.maxSummaryChars),
          blocking: finding.blocking,
        })),
      };
    }
    const subject = spine.value.subject;
    if (subject !== null && subject.lineageTruncated) truncated.push('subject.lineage');
    if (subject !== null && subject.inputsTruncated) truncated.push('subject.inputs');
    if (subject !== null && subject.delivered?.payloadTruncated === true) {
      truncated.push('subject.delivered.payload');
    }
    return ok({
      schema: 'companyos/review-context/1',
      classification: {
        goal: 'AUTHORITATIVE_FACT',
        goalArtifactRef: 'CANONICAL_REF',
        run: 'AUTHORITATIVE_FACT',
        review: 'AUTHORITATIVE_FACT',
        subject: 'AUTHORITATIVE_FACT',
        'subject.delivered': 'CANONICAL_REF',
        priorFinding: 'AUTHORITATIVE_FACT',
        'priorFinding.artifactId': 'CANONICAL_REF',
        anchor: 'CANONICAL_REF',
        acceptanceCriteria: 'NON_AUTHORITY_PRESENTATION',
      },
      goal: spine.value.goal,
      goalArtifactRef: spine.value.goalArtifactRef,
      run: {
        id: spine.value.run.id,
        companyId: spine.value.run.companyId,
        workflowId: spine.value.run.workflowId,
        templateId: spine.value.run.templateId,
        versionId: spine.value.run.versionId,
      },
      review: { taskId: reviewTask.id, stageId: reviewTask.stageId },
      subject:
        subject === null
          ? null
          : {
              taskId: subject.taskId,
              kind: subject.kind,
              state: subject.state,
              inputsJson: subject.inputsJson,
              inputsTruncated: subject.inputsTruncated,
              lineage: subject.lineage,
              delivered:
                subject.delivered === null
                  ? null
                  : {
                      refs: subject.delivered.refs,
                      payload: subject.delivered.payload,
                      payloadTruncated: subject.delivered.payloadTruncated,
                    },
            },
      priorFinding,
      anchor: spine.value.anchor,
      acceptanceCriteria: null,
      truncated,
    });
  };

  /** Project the bounded validation context: configuration + target + latest state, no transcripts. */
  const projectValidation = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly qaTaskId: string;
    readonly actorId: string;
  }): Promise<Result<BoundedValidationContext, DomainError>> => {
    const spine = await readSpine(deps, input);
    if (!spine.ok) return spine;
    const qaTask = await deps.tasks.get(input.qaTaskId);
    if (qaTask === null) {
      return err(
        domainError('NOT_FOUND', `Task "${input.qaTaskId}" does not exist.`, {
          reason: 'TASK_MISSING',
        }),
      );
    }
    // T20-03A (§25): same ownership rule for the validation seat.
    if (String(qaTask.runId) !== String(input.runId)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Task "${input.qaTaskId}" belongs to another run.`,
          {
            reason: 'BOUNDED_CONTEXT_TASK_RUN_MISMATCH',
            runId: input.runId,
            taskId: input.qaTaskId,
            taskRunId: String(qaTask.runId),
          },
        ),
      );
    }
    const truncated: string[] = [];
    const report = await deps.latestReviewReport({
      companyId: input.companyId,
      runId: input.runId,
      actorId: input.actorId,
    });
    if (!report.ok) return report;
    const validators = await deps.requiredValidators(input.runId, String(qaTask.stageId));
    if (!validators.ok) return validators;
    const rows = await deps.latestValidation.listByRun(input.runId);
    const subject = spine.value.subject;
    if (subject !== null && subject.lineageTruncated) truncated.push('target.lineage');
    if (subject !== null && subject.inputsTruncated) truncated.push('target.inputs');
    if (subject !== null && subject.delivered?.payloadTruncated === true) {
      truncated.push('target.delivered.payload');
    }
    return ok({
      schema: 'companyos/validation-context/1',
      classification: {
        goal: 'AUTHORITATIVE_FACT',
        goalArtifactRef: 'CANONICAL_REF',
        run: 'AUTHORITATIVE_FACT',
        validation: 'AUTHORITATIVE_FACT',
        target: 'AUTHORITATIVE_FACT',
        'target.delivered': 'CANONICAL_REF',
        latestReview: 'AUTHORITATIVE_FACT',
        'latestReview.artifactId': 'CANONICAL_REF',
        anchor: 'CANONICAL_REF',
        validators: 'AUTHORITATIVE_FACT',
        evidenceSlots: 'AUTHORITATIVE_FACT',
        latestValidationBatch: 'AUTHORITATIVE_FACT',
      },
      goal: spine.value.goal,
      goalArtifactRef: spine.value.goalArtifactRef,
      run: {
        id: spine.value.run.id,
        companyId: spine.value.run.companyId,
        workflowId: spine.value.run.workflowId,
        templateId: spine.value.run.templateId,
        versionId: spine.value.run.versionId,
      },
      validation: { taskId: qaTask.id, stageId: qaTask.stageId },
      target:
        subject === null
          ? null
          : {
              taskId: subject.taskId,
              kind: subject.kind,
              state: subject.state,
              inputsJson: subject.inputsJson,
              inputsTruncated: subject.inputsTruncated,
              lineage: subject.lineage,
              delivered:
                subject.delivered === null
                  ? null
                  : {
                      refs: subject.delivered.refs,
                      payload: subject.delivered.payload,
                      payloadTruncated: subject.delivered.payloadTruncated,
                    },
            },
      latestReview:
        report.value === null
          ? null
          : { verdict: report.value.verdict, artifactId: report.value.artifactId },
      anchor: spine.value.anchor,
      validators: validators.value,
      evidenceSlots: REQUIRED_QA_EVIDENCE_SLOTS.map((entry) => ({
        slot: entry.slot,
        toolId: entry.toolId,
      })),
      latestValidationBatch:
        rows.length === 0
          ? null
          : {
              id: rows[0]!.id,
              status: rows[0]!.status,
              validatorId: rows[0]!.validatorId,
              targetRef: rows[0]!.targetRef,
            },
      truncated,
    });
  };

  return { projectReview, projectValidation };
}

/**
 * The provider-neutral PRE-INVOCATION budget gate for the stateless role contexts (§14/§20):
 * the SAME token-budget kernel the session runtime uses, in stateless projection mode. A
 * context window that cannot be proven trusted fails closed exactly like the session path.
 */
export const decideBoundedContextBudget = (input: {
  readonly contextWindowTokens: number | null;
  readonly renderedContext: string;
  readonly structuredKeys: readonly string[];
}): Result<{ readonly estimatedInputTokens: number }, DomainError> => {
  if (input.contextWindowTokens === null) {
    return err(
      domainError('NOT_FOUND', 'The pinned model has no trusted context window; refusing.', {
        reason: 'BOUNDED_CONTEXT_WINDOW_UNKNOWN',
      }),
    );
  }
  return decideTokenBudget({
    contextWindowTokens: input.contextWindowTokens,
    reservedOutputTokens: BOUNDED_AGENT_CONTEXT_LIMITS.reservedOutputTokens,
    renderedText: `${input.renderedContext}\n${input.structuredKeys.join(',')}`,
  });
};
