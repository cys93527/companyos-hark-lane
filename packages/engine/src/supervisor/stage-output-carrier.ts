/**
 * Stage output carrier (Sprint 18 / Task-18-07) — the trusted seam that routes a handler's
 * structured output into the canonical sinks.
 *
 * The authority chain the Boss froze for this corrective:
 *
 *   AgentExecution → StageHandler structured output → Task.outputs → canonical sink
 *   → trusted evidence applicator → canonical Run lifecycle → Supervisor next turn
 *
 * This module is the `Task.outputs → canonical sink` link. It is deliberately NOT a model path:
 * it reads the DURABLE envelope the engine persisted, verifies the execution identity against
 * the durable execution row, and calls exactly ONE canonical writer:
 *   - a `companyos:review-findings-candidate` output → `ReviewFindingsSink.record` (T18-04),
 *     which is the ONLY writer of `companyos:review-findings` artifacts;
 *   - a `companyos:validation-candidate` output → `ValidationService.run` (T17 path),
 *     which is the ONLY writer of `Validation` rows.
 *
 * There is no second writer for either domain, no prose parsing, no `"PASS"` grep, and no
 * JSON-looking-text extraction: the payload was parsed and validated BEFORE it was persisted.
 */
import {
  STAGE_OUTPUT_SCHEMA,
  STAGE_OUTPUT_TASK_KEY,
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
  type StageHandlerOutput,
  type Task,
} from '@companyos/core';

import { WORK_ROLE_OUTPUT_KIND } from '../session/work-session-runtime.js';

/** Kind of a reviewer candidate the carrier routes to the T18-04 sink. */
export const REVIEW_CANDIDATE_KIND = 'companyos:review-findings-candidate';

/** Kind of a QA candidate the carrier routes to the canonical validation path. */
export const VALIDATION_CANDIDATE_KIND = 'companyos:validation-candidate';

/** The pinned review task the reviewer execution ran under (durable identity). */
export interface StageOutputCarrierReviewSink {
  record(command: {
    readonly companyId: string;
    readonly runId: string;
    readonly reviewStageId: string;
    readonly reviewTaskId: string;
    readonly subjectTaskId: string;
    readonly executionId: string;
    readonly verdict: 'PASS' | 'CHANGES_REQUESTED' | 'BLOCKED';
    readonly findings: readonly {
      readonly code: string;
      readonly summary: string;
      readonly detail: string;
      readonly blocking: boolean;
      readonly locator?: {
        readonly path: string;
        readonly line?: number;
        readonly symbol?: string;
      } | null;
      readonly evidenceRefs?: readonly string[];
    }[];
    readonly modelBindingKey?: string | null;
    readonly evidenceRefs?: readonly string[];
    readonly decidedBy: string;
    readonly traceId?: string;
  }): Promise<Result<{ readonly artifactId: string }, DomainError>>;
}

/** The canonical validation path (T17): one writer for Validation rows. */
export interface StageOutputCarrierValidationService {
  run(command: {
    readonly commandId: string;
    readonly actorId: string;
    readonly runId: string;
    readonly stageId?: string | null;
    readonly taskId?: string | null;
    readonly targetRef: string;
    readonly validators: readonly { readonly validatorId: string; readonly blocking: boolean }[];
    readonly traceId: string;
  }): Promise<Result<readonly { readonly id: string; readonly status: string }[], DomainError>>;
}

/** The durable execution reader: the identity the carrier verifies before any sink write. */
export interface StageOutputCarrierExecutions {
  get(executionId: string): Promise<{
    readonly executionId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly status: string;
    readonly modelKey: string;
    readonly providerId: string;
    readonly providerModelId: string;
  } | null>;
}

export interface StageOutputCarrierDeps {
  readonly tasks: { get(taskId: string): Promise<Task | null> };
  readonly executions: StageOutputCarrierExecutions;
  readonly reviewSink: StageOutputCarrierReviewSink;
  readonly validationService: StageOutputCarrierValidationService;
  readonly clock: { nowIso: () => string };
  readonly ids: { id: (prefix?: string) => string };
}

export interface RoutedStageOutput {
  readonly taskId: string;
  readonly kind: string;
  /** What the canonical sink produced (artifact id or validation ids). */
  readonly refs: readonly string[];
  /** True when the canonical output already existed for this identity (replay). */
  readonly replayed: boolean;
}

export interface StageOutputCarrier {
  /**
   * Read the durable carrier of ONE task and route it to its canonical sink. The task's own
   * `outputs` is updated with the produced refs, so a restart can identify the exact canonical
   * output without re-deriving anything (§15).
   */
  routeTask(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly actorId: string;
    readonly traceId?: string;
  }): Promise<Result<RoutedStageOutput | null, DomainError>>;
  /**
   * Route the SAME envelope a handler just produced, while the task is still not DONE. This is
   * the live path: the canonical sink becomes durable FIRST, and only then is the task completed
   * with the output. A crash in between leaves a canonical output without a DONE task —
   * recoverable and idempotent through `routeTask` — and never the inverse.
   */
  routeOutput(input: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly output: StageHandlerOutput;
    readonly actorId: string;
    readonly traceId?: string;
  }): Promise<Result<RoutedStageOutput | null, DomainError>>;
}

/** Read and validate the durable envelope a task carries. */
export const stageOutputOf = (task: Task): Result<StageHandlerOutput | null, DomainError> => {
  const raw = task.outputs[STAGE_OUTPUT_TASK_KEY];
  if (raw === undefined || raw === null) return ok(null);
  // The engine persists the envelope as a structured value; a string form (a caller that
  // wrote it by hand) is decoded strictly, never guessed at.
  if (typeof raw === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return err(
        domainError(
          'VALIDATION_FAILED',
          'The task carries an unreadable stage output envelope.',
          {},
        ),
      );
    }
    return validateEnvelope(parsed);
  }
  return validateEnvelope(raw);
};

/** Local validator so the carrier does not depend on the caller's import order. */
const validateEnvelope = (value: unknown): Result<StageHandlerOutput, DomainError> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(
      domainError('VALIDATION_FAILED', 'The stage output envelope must be an object.', {}),
    );
  }
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== STAGE_OUTPUT_SCHEMA) {
    return err(
      domainError(
        'VALIDATION_FAILED',
        `Unsupported stage output schema "${String(record['schemaVersion'])}".`,
        {
          reason: 'STAGE_OUTPUT_SCHEMA_UNSUPPORTED',
        },
      ),
    );
  }
  return ok({
    schemaVersion: STAGE_OUTPUT_SCHEMA,
    kind: String(record['kind'] ?? ''),
    executionId: typeof record['executionId'] === 'string' ? record['executionId'] : null,
    artifactRefs: Array.isArray(record['artifactRefs']) ? (record['artifactRefs'] as string[]) : [],
    validationRefs: Array.isArray(record['validationRefs'])
      ? (record['validationRefs'] as string[])
      : [],
    payload:
      typeof record['payload'] === 'object' && record['payload'] !== null
        ? (record['payload'] as Record<string, unknown>)
        : null,
  });
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

export function createStageOutputCarrier(deps: StageOutputCarrierDeps): StageOutputCarrier {
  /**
   * Verify the execution identity the envelope claims (§7): the row must exist, belong to this
   * run and this task, and be terminal-successful. A handler cannot spoof it.
   */
  const verifyExecution = async (
    envelope: StageHandlerOutput,
    input: { readonly runId: string; readonly taskId: string },
  ): Promise<Result<{ readonly executionId: string; readonly modelKey: string }, DomainError>> => {
    if (envelope.executionId === null) {
      return err(
        domainError(
          'NOT_FOUND',
          'The stage output names no execution; the carrier refuses unverifiable provenance.',
          {
            reason: 'STAGE_OUTPUT_EXECUTION_MISSING',
            taskId: input.taskId,
          },
        ),
      );
    }
    const row = await deps.executions.get(envelope.executionId);
    if (row === null || row.executionId !== envelope.executionId) {
      return err(
        domainError(
          'NOT_FOUND',
          `Execution "${envelope.executionId}" does not exist; the carrier refuses unverifiable provenance.`,
          {
            reason: 'STAGE_OUTPUT_EXECUTION_MISSING',
            executionId: envelope.executionId,
          },
        ),
      );
    }
    if (row.runId !== input.runId) {
      return err(
        domainError('VALIDATION_FAILED', 'The execution belongs to another run.', {
          reason: 'STAGE_OUTPUT_EXECUTION_RUN_MISMATCH',
          executionId: row.executionId,
          runId: row.runId,
          expectedRunId: input.runId,
        }),
      );
    }
    if (row.taskId !== input.taskId) {
      return err(
        domainError('VALIDATION_FAILED', 'The execution belongs to another task.', {
          reason: 'STAGE_OUTPUT_EXECUTION_TASK_MISMATCH',
          executionId: row.executionId,
          taskId: row.taskId,
          expectedTaskId: input.taskId,
        }),
      );
    }
    if (row.status !== 'COMPLETED') {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `The execution is ${row.status}; only a COMPLETED execution may carry output.`,
          {
            reason: 'STAGE_OUTPUT_EXECUTION_NOT_COMPLETED',
            executionId: row.executionId,
            status: row.status,
          },
        ),
      );
    }
    return ok({ executionId: row.executionId, modelKey: row.modelKey });
  };

  const routeReview = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly task: Task;
    readonly envelope: StageHandlerOutput;
    readonly actorId: string;
    readonly traceId: string;
  }): Promise<Result<RoutedStageOutput, DomainError>> => {
    const payload = asRecord(input.envelope.payload);
    if (payload === null) {
      return err(
        domainError('VALIDATION_FAILED', 'A review candidate needs a structured payload.', {
          reason: 'REVIEW_CANDIDATE_PAYLOAD_MISSING',
        }),
      );
    }
    const verdict = str(payload['verdict']);
    if (verdict !== 'PASS' && verdict !== 'CHANGES_REQUESTED' && verdict !== 'BLOCKED') {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Unknown review verdict "${String(payload['verdict'])}".`,
          {
            reason: 'REVIEW_CANDIDATE_VERDICT_INVALID',
          },
        ),
      );
    }
    const subjectTaskId = str(payload['subjectTaskId']) ?? input.taskId;
    const rawFindings = Array.isArray(payload['findings']) ? payload['findings'] : [];
    const findings = rawFindings.map((entry) => {
      const finding = asRecord(entry) ?? {};
      const locator = asRecord(finding['locator']);
      return {
        code: str(finding['code']) ?? 'review.finding',
        summary: str(finding['summary']) ?? 'A reviewer finding.',
        detail: str(finding['detail']) ?? 'detail',
        blocking: finding['blocking'] === true,
        ...(locator === null || str(locator['path']) === null
          ? {}
          : {
              locator: {
                path: String(locator['path']),
                ...(typeof locator['line'] === 'number' ? { line: locator['line'] } : {}),
                ...(typeof locator['symbol'] === 'string' ? { symbol: locator['symbol'] } : {}),
              },
            }),
        ...(Array.isArray(finding['evidenceRefs'])
          ? {
              evidenceRefs: (finding['evidenceRefs'] as unknown[]).filter(
                (ref): ref is string => typeof ref === 'string',
              ),
            }
          : {}),
      };
    });
    const recorded = await deps.reviewSink.record({
      companyId: input.companyId,
      runId: input.runId,
      reviewStageId: input.task.stageId as never,
      reviewTaskId: input.taskId,
      subjectTaskId,
      executionId: input.envelope.executionId as string,
      verdict,
      findings,
      ...(typeof payload['modelBindingKey'] === 'string'
        ? { modelBindingKey: payload['modelBindingKey'] }
        : {}),
      ...(Array.isArray(payload['evidenceRefs'])
        ? {
            evidenceRefs: (payload['evidenceRefs'] as unknown[]).filter(
              (ref): ref is string => typeof ref === 'string',
            ),
          }
        : {}),
      decidedBy: input.actorId,
      traceId: input.traceId,
    });
    if (!recorded.ok) return recorded;
    return ok({
      taskId: input.taskId,
      kind: REVIEW_CANDIDATE_KIND,
      refs: [`artifact:${recorded.value.artifactId}`],
      replayed: false,
    });
  };

  const routeValidation = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly task: Task;
    readonly envelope: StageHandlerOutput;
    readonly actorId: string;
    readonly traceId: string;
  }): Promise<Result<RoutedStageOutput, DomainError>> => {
    const payload = asRecord(input.envelope.payload);
    if (payload === null) {
      return err(
        domainError('VALIDATION_FAILED', 'A QA candidate needs a structured payload.', {
          reason: 'VALIDATION_CANDIDATE_PAYLOAD_MISSING',
        }),
      );
    }
    const targetRef = str(payload['targetRef']);
    if (targetRef === null) {
      return err(
        domainError('VALIDATION_FAILED', 'A QA candidate must name its target artifact.', {
          reason: 'VALIDATION_CANDIDATE_TARGET_MISSING',
        }),
      );
    }
    const rawValidators = Array.isArray(payload['validators']) ? payload['validators'] : [];
    const validators = rawValidators.map((entry) => {
      const validator = asRecord(entry) ?? {};
      return {
        validatorId: str(validator['validatorId']) ?? '',
        blocking: validator['blocking'] !== false,
      };
    });
    if (validators.length === 0 || validators.some((validator) => validator.validatorId === '')) {
      return err(
        domainError('VALIDATION_FAILED', 'A QA candidate must name at least one validator.', {
          reason: 'VALIDATION_CANDIDATE_PLAN_INVALID',
        }),
      );
    }
    /*
     * The command identity is the QA TASK, not the execution: a crash that landed after this
     * canonical batch was durable but before the task became DONE leaves the task open, and the
     * resumed attempt re-runs the agent under a NEW execution — the permanent identity must then
     * replay the SAME batch (same plan ⇒ same fingerprint) instead of appending a duplicate.
     * A genuinely different plan on the same task fails closed with a fingerprint CONFLICT.
     */
    const recorded = await deps.validationService.run({
      commandId: `validation-carrier:${input.runId}:${input.taskId}`,
      actorId: input.actorId,
      runId: input.runId,
      stageId: input.task.stageId as never,
      taskId: input.taskId as never,
      targetRef,
      validators,
      traceId: input.traceId,
    });
    if (!recorded.ok) return recorded;
    return ok({
      taskId: input.taskId,
      kind: VALIDATION_CANDIDATE_KIND,
      refs: recorded.value.map((row) => row.id),
      replayed: false,
    });
  };

  /**
   * Route ONE verified envelope to its canonical sink. Both entry points (`routeTask`, which
   * reads the durable envelope, and `routeOutput`, which carries the handler's own) converge
   * here, so there is exactly one routing decision in the system.
   */
  const routeEnvelope = async (input: {
    readonly companyId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly task: Task;
    readonly envelope: StageHandlerOutput;
    readonly actorId: string;
    readonly traceId: string;
  }): Promise<Result<RoutedStageOutput, DomainError>> => {
    // T20-03A (§23): recovery routing is run-scoped — a foreign-run task row fails closed
    // before any sink is consulted (the Sprint-19 unknown-carrier rule is unchanged).
    if (String(input.task.runId) !== String(input.runId)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `Task "${input.taskId}" belongs to another run; the carrier refuses to route it.`,
          {
            reason: 'STAGE_OUTPUT_TASK_RUN_MISMATCH',
            runId: input.runId,
            taskId: input.taskId,
            taskRunId: String(input.task.runId),
          },
        ),
      );
    }
    const verified = await verifyExecution(input.envelope, {
      runId: input.runId,
      taskId: input.taskId,
    });
    if (!verified.ok) return verified;

    if (input.envelope.kind === REVIEW_CANDIDATE_KIND) {
      return routeReview({
        companyId: input.companyId,
        runId: input.runId,
        taskId: input.taskId,
        task: input.task,
        envelope: input.envelope,
        actorId: input.actorId,
        traceId: input.traceId,
      });
    }
    if (input.envelope.kind === VALIDATION_CANDIDATE_KIND) {
      return routeValidation({
        companyId: input.companyId,
        runId: input.runId,
        taskId: input.taskId,
        task: input.task,
        envelope: input.envelope,
        actorId: input.actorId,
        traceId: input.traceId,
      });
    }
    return err(
      domainError(
        'VALIDATION_FAILED',
        `No canonical sink accepts output kind "${input.envelope.kind}".`,
        {
          reason: 'STAGE_OUTPUT_KIND_UNROUTABLE',
          kind: input.envelope.kind,
        },
      ),
    );
  };

  const loadTask = async (
    taskId: string,
  ): Promise<Result<Task, DomainError>> => {
    const task = await deps.tasks.get(taskId);
    if (task === null) {
      return err(
        domainError('NOT_FOUND', `Task "${taskId}" does not exist.`, {
          reason: 'STAGE_OUTPUT_TASK_MISSING',
          taskId,
        }),
      );
    }
    return ok(task);
  };

  return {
    async routeTask(input) {
      const loaded = await loadTask(input.taskId);
      if (!loaded.ok) return loaded;
      const envelope = stageOutputOf(loaded.value);
      if (!envelope.ok) return envelope;
      if (envelope.value === null) return ok(null);
      /*
       * T19-04 closeout §19: the RECOVERY router classifies envelopes EXPLICITLY (option A),
       * never by "no sink was found" (option B is forbidden). Exactly ONE kind is classified
       * as having no canonical sink — the Work-role turn envelope (WORK_ROLE_OUTPUT_KIND):
       * a work turn's canonical evidence arrives through the review/validation roles, so
       * recovery skips it by design. Every other kind — including any UNKNOWN kind — falls
       * through to the sink lookup, which FAILS CLOSED (`STAGE_OUTPUT_KIND_UNROUTABLE`) when
       * no canonical sink accepts it. The LIVE path (`routeOutput`) is unchanged and strict.
       */
      if (envelope.value.kind === WORK_ROLE_OUTPUT_KIND) {
        return ok(null);
      }
      return routeEnvelope({
        companyId: input.companyId,
        runId: input.runId,
        taskId: input.taskId,
        task: loaded.value,
        envelope: envelope.value,
        actorId: input.actorId,
        traceId: input.traceId ?? deps.ids.id('trace'),
      });
    },
    async routeOutput(input) {
      const loaded = await loadTask(input.taskId);
      if (!loaded.ok) return loaded;
      return routeEnvelope({
        companyId: input.companyId,
        runId: input.runId,
        taskId: input.taskId,
        task: loaded.value,
        envelope: input.output,
        actorId: input.actorId,
        traceId: input.traceId ?? deps.ids.id('trace'),
      });
    },
  };
}
