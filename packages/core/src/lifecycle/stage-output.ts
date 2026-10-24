/**
 * Stage output envelope (Sprint 18 / Task-18-07) — the durable carrier between a stage
 * handler's result and the canonical Review/Validation sinks.
 *
 * Before this, `StageHandler.execute` returned a bare three-value string, so a handler's
 * structured result had nowhere to go: the engine kept the status and discarded everything
 * else (`step(task, 'COMPLETE')` with no outputs). That is `HANDLER_OUTPUT_CARRIER_GAP`.
 *
 * The envelope follows the SAME convention as the other Sprint-18 payloads
 * (`companyos/corrective-task/1`, `companyos/review-findings/1`): a namespaced `schemaVersion`,
 * a bounded `validate*` / `encode*` / `decode*` triple, and a deliberately small field set.
 * It is REFERENCE-ONLY: runId, taskId and executionId are identities, artifact/validation refs
 * are refs, and `payload` is bounded structured data the handler produced. It never carries a
 * transcript, a raw stdout blob, or prose that anything downstream would have to parse.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';

/** Envelope version of a stage handler's structured output. */
export const STAGE_OUTPUT_SCHEMA = 'companyos/stage-output/1';

/** The one status vocabulary a handler may report (unchanged from Sprint 2). */
export const STAGE_HANDLER_STATUSES = ['succeeded', 'failed', 'blocked'] as const;
export type StageHandlerStatus = (typeof STAGE_HANDLER_STATUSES)[number];

/**
 * Bounds chosen so one handler output can never become a context-window or row accident.
 * The payload is the only free-form part, and it is capped and depth-limited.
 */
export const STAGE_OUTPUT_LIMITS = {
  maxKindChars: 120,
  maxArtifactRefs: 32,
  maxValidationRefs: 32,
  maxPayloadBytes: 8 * 1024,
  maxPayloadDepth: 6,
  maxRefChars: 200,
} as const;

/** The bounded, versioned structured output a handler may attach to its outcome. */
export interface StageHandlerOutput {
  readonly schemaVersion: typeof STAGE_OUTPUT_SCHEMA;
  /** Namespaced kind of the structured result (e.g. `companyos:review-findings-candidate`). */
  readonly kind: string;
  /**
   * The AgentExecution that produced this output. DERIVED from the runtime that ran it — a
   * handler may state it, but the trusted carrier verifies it against the durable execution row
   * before any sink write, so it cannot be spoofed.
   */
  readonly executionId: string | null;
  /** Artifact refs produced by the attempt (`artifact:art_…` / `art_…`). */
  readonly artifactRefs: readonly string[];
  /** Validation refs produced by the attempt (`val_…`). */
  readonly validationRefs: readonly string[];
  /** Bounded structured payload (review verdict + findings, QA plan, …). Never prose. */
  readonly payload: Readonly<Record<string, unknown>> | null;
}

/**
 * The canonical stage handler outcome: the status plus an OPTIONAL structured output.
 *
 * A bare status string stays legal (`normalizeStageHandlerResult` lifts it), so no existing
 * handler breaks; after normalization the engine operates on this one form only.
 */
export interface StageHandlerResult {
  readonly status: StageHandlerStatus;
  readonly output?: StageHandlerOutput;
  /**
   * LIVE-SMOKE-FIX-04 — the TYPED failure a handler may attach to a `failed` result:
   * the durable pre-dispatch/post-dispatch failure contract (failureCode from the frozen
   * taxonomy, optional lifecycle stage, retryability). The engine persists it on the
   * attempt settlement so a terminal FAILED claim can never lose its cause. Sanitized
   * by shape: codes/stages are bounded identifier strings — never payloads, secrets or
   * free-form model text.
   */
  readonly failure?: StageHandlerFailure;
}

/** The structured, secret-free failure evidence one failed handler result carries. */
export interface StageHandlerFailure {
  /** Frozen typed failure code (e.g. MODEL_CAPABILITY_MISMATCH, EXECUTION_WORKSPACE_UNTRUSTED). */
  readonly code: string;
  /** The lifecycle phase the failure occurred in, when known (e.g. 'workspace-trusted'). */
  readonly stage?: string | null;
  /**
   * false = deterministic (config/invariant/routing/credential): the engine settles the
   * task FAILED without the automatic RETRY (fail fast, one attempt). true (or absent)
   * = existing retry semantics unchanged.
   */
  readonly retryable?: boolean;
}

const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;
const FAILURE_STAGE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

const isStageHandlerFailure = (value: unknown): value is StageHandlerFailure => {
  if (!isRecord(value)) return false;
  const code = value['code'];
  if (typeof code !== 'string' || !FAILURE_CODE_PATTERN.test(code)) return false;
  const stage = value['stage'];
  if (stage !== undefined && stage !== null && (typeof stage !== 'string' || !FAILURE_STAGE_PATTERN.test(stage))) return false;
  const retryable = value['retryable'];
  if (retryable !== undefined && typeof retryable !== 'boolean') return false;
  return true;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStatus = (value: unknown): value is StageHandlerStatus =>
  typeof value === 'string' && (STAGE_HANDLER_STATUSES as readonly string[]).includes(value);

/** Reject anything that is not a plain, JSON-shaped value (no object graphs, no cycles). */
const isJsonValue = (value: unknown, depth: number): boolean => {
  if (depth > STAGE_OUTPUT_LIMITS.maxPayloadDepth) return false;
  if (value === null) return true;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return true;
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
};

const isRef = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= STAGE_OUTPUT_LIMITS.maxRefChars &&
  (value.startsWith('artifact:') || value.startsWith('art_') || value.startsWith('val_'));

/** Validate an already-decoded envelope (used by both decode and the carrier). */
export function validateStageHandlerOutput(
  value: unknown,
): Result<StageHandlerOutput, DomainError> {
  if (!isRecord(value)) {
    return err(domainError('VALIDATION_FAILED', 'A stage output envelope must be an object.', {}));
  }
  if (value['schemaVersion'] !== STAGE_OUTPUT_SCHEMA) {
    return err(
      domainError(
        'VALIDATION_FAILED',
        `Unsupported stage output schema "${String(value['schemaVersion'])}".`,
        {
          reason: 'STAGE_OUTPUT_SCHEMA_UNSUPPORTED',
        },
      ),
    );
  }
  const kind = value['kind'];
  if (
    typeof kind !== 'string' ||
    kind.trim() === '' ||
    kind.length > STAGE_OUTPUT_LIMITS.maxKindChars
  ) {
    return err(
      domainError('VALIDATION_FAILED', 'A stage output needs a non-empty kind within its bound.', {
        reason: 'STAGE_OUTPUT_KIND_INVALID',
      }),
    );
  }
  for (const field of ['artifactRefs', 'validationRefs'] as const) {
    const refs = value[field];
    if (!Array.isArray(refs)) {
      return err(
        domainError('VALIDATION_FAILED', `Stage output "${field}" must be an array.`, {
          reason: 'STAGE_OUTPUT_REFS_INVALID',
          field,
        }),
      );
    }
    if (refs.length > STAGE_OUTPUT_LIMITS.maxArtifactRefs) {
      return err(
        domainError('VALIDATION_FAILED', `Stage output "${field}" carries too many refs.`, {
          reason: 'STAGE_OUTPUT_REFS_TOO_MANY',
          field,
          limit: STAGE_OUTPUT_LIMITS.maxArtifactRefs,
        }),
      );
    }
    for (const ref of refs) {
      if (!isRef(ref)) {
        return err(
          domainError(
            'VALIDATION_FAILED',
            `Stage output "${field}" carries an illegal ref shape.`,
            {
              reason: 'STAGE_OUTPUT_REF_SHAPE_INVALID',
              field,
            },
          ),
        );
      }
    }
  }
  const executionId = value['executionId'];
  if (executionId !== null && executionId !== undefined && typeof executionId !== 'string') {
    return err(
      domainError(
        'VALIDATION_FAILED',
        'Stage output "executionId" must be a string when present.',
        {},
      ),
    );
  }
  const payload = value['payload'];
  if (payload !== null && payload !== undefined) {
    if (!isRecord(payload) || !isJsonValue(payload, 0)) {
      return err(
        domainError(
          'VALIDATION_FAILED',
          'Stage output payload must be a bounded, plain JSON object.',
          {
            reason: 'STAGE_OUTPUT_PAYLOAD_INVALID',
          },
        ),
      );
    }
    if (
      new TextEncoder().encode(JSON.stringify(payload)).byteLength >
      STAGE_OUTPUT_LIMITS.maxPayloadBytes
    ) {
      return err(
        domainError('VALIDATION_FAILED', 'Stage output payload exceeds its byte bound.', {
          reason: 'STAGE_OUTPUT_PAYLOAD_TOO_LARGE',
          limit: STAGE_OUTPUT_LIMITS.maxPayloadBytes,
        }),
      );
    }
  }
  return ok({
    schemaVersion: STAGE_OUTPUT_SCHEMA,
    kind: kind.trim(),
    executionId: typeof executionId === 'string' && executionId.length > 0 ? executionId : null,
    artifactRefs: [...(value['artifactRefs'] as readonly string[])],
    validationRefs: [...(value['validationRefs'] as readonly string[])],
    payload: isRecord(payload) ? payload : null,
  });
}

/** Deterministic bytes for the durable carrier (Task.outputs). */
export const encodeStageHandlerOutput = (output: StageHandlerOutput): string =>
  JSON.stringify(output);

/** Strict decode: no substring extraction, no repair. */
export function decodeStageHandlerOutput(text: string): Result<StageHandlerOutput, DomainError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(
      domainError('VALIDATION_FAILED', 'The stage output envelope is not valid JSON.', {}),
    );
  }
  return validateStageHandlerOutput(parsed);
}

/**
 * The ONE normalization boundary. A bare status string (every existing handler, and every
 * repository stub) lifts to `{ status }`; an object must be a legal structured result. After
 * this the engine sees one canonical form.
 */
export function normalizeStageHandlerResult(
  value: StageHandlerStatus | StageHandlerResult,
): Result<StageHandlerResult, DomainError> {
  if (isStatus(value)) return ok({ status: value });
  if (!isRecord(value)) {
    return err(
      domainError(
        'VALIDATION_FAILED',
        'A stage handler result must be a status or a structured result.',
        {},
      ),
    );
  }
  if (!isStatus(value['status'])) {
    return err(
      domainError('VALIDATION_FAILED', 'A stage handler result needs a legal status.', {
        reason: 'STAGE_HANDLER_STATUS_INVALID',
        status: String(value['status']),
      }),
    );
  }
  const output = value['output'];
  if (output === undefined || output === null) {
    const failure = failureOf(value);
    if (!failure.ok) return failure;
    return ok({ status: value['status'], ...failure.value });
  }
  const validated = validateStageHandlerOutput(output);
  if (!validated.ok) return validated;
  const failure = failureOf(value);
  if (!failure.ok) return failure;
  return ok({ status: value['status'], output: validated.value, ...failure.value });
}

/** Extract + validate the optional typed failure envelope (absent stays absent). */
const failureOf = (
  value: Record<string, unknown>,
): Result<{readonly failure?: StageHandlerFailure}, DomainError> => {
  const failure = value['failure'];
  if (failure === undefined || failure === null) return ok({});
  if (!isStageHandlerFailure(failure)) {
    return err(
      domainError('VALIDATION_FAILED', 'A stage handler failure envelope must carry a bounded typed code.', {
        reason: 'STAGE_HANDLER_FAILURE_INVALID',
      }),
    );
  }
  return ok({failure});
};

/** The key the envelope occupies inside `Task.outputs` (the durable carrier seam). */
export const STAGE_OUTPUT_TASK_KEY = 'stageOutput';
