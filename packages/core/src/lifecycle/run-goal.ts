/**
 * Run Goal — the ONE canonical durable objective of a Run (Sprint 18 / Task-18-02).
 *
 * A Run answers two different questions and they must never be confused:
 *   - the Goal is WHAT this Run wants to achieve (human/application input);
 *   - the pinned WorkflowVersion is HOW this class of work is allowed to execute.
 *
 * The Goal is carried by the existing run-owned immutable Artifact primitive — no Goal
 * table, no schema change, no new pin field. One Run owns exactly one goal artifact:
 * the creation command identity is derived from the run id, so a second goal for the
 * same run is refused by the artifact's own fingerprint, and a duplicate creation with
 * the same content replays the very same artifact (ADR-0015 idempotency, not a bespoke
 * mechanism).
 *
 * What this module deliberately does NOT do: it never reads a conversation, a prompt, an
 * agent message or the process environment. The objective and the optional structured
 * constraints are explicit caller input; everything else on the record (runId, timestamps,
 * actor) is derived from the run the caller just created. There is no update path at all.
 */
import { domainError } from '../kernel/errors.js';
import { canonicalJson } from '../kernel/hash.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { DomainError } from '../kernel/errors.js';

/** Reserved artifact kind. Core never interprets a kind; this one is ours by convention. */
export const RUN_GOAL_ARTIFACT_KIND = 'companyos:run-goal';

/** Canonical goal envelope version, carried inside the durable bytes. */
export const RUN_GOAL_SCHEMA = 'companyos/run-goal/1';

/** Hard caps: a goal is an objective, not a document store. */
export const RUN_GOAL_MAX_OBJECTIVE_CHARS = 8_000;
export const RUN_GOAL_MAX_STRUCTURED_BYTES = 16_384;

export type RunGoalSourceType = 'human' | 'application';

export interface RunGoalSource {
  readonly type: RunGoalSourceType;
  /** Opaque provenance handle (e.g. the request/command that carried the goal). */
  readonly ref?: string;
}

export interface RunGoalInput {
  /** The objective, in the requester's own words. Trimmed; never auto-completed. */
  readonly objective: string;
  /** Optional structured constraints (acceptance criteria, scope, exclusions). */
  readonly structured?: Readonly<Record<string, unknown>> | null;
  /** Who authored it. Defaults to `application` — never inferred from a model. */
  readonly source?: RunGoalSource;
}

export interface RunGoal extends RunGoalInput {
  readonly schema: typeof RUN_GOAL_SCHEMA;
  readonly runId: string;
  readonly objective: string;
  readonly structured: Readonly<Record<string, unknown>> | null;
  readonly source: RunGoalSource;
  /**
   * Creation instant and author, read back from the immutable artifact row — the artifact is
   * the single durable source for both, so the envelope deliberately does not repeat them.
   */
  readonly createdAt: string;
  readonly createdBy: string;
}

/** Deterministic artifact command identity: one Run → at most one goal artifact. */
export const runGoalCommandId = (runId: string): string => `run-goal:${runId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Content guard: a goal is prose the human typed, so it must not silently smuggle in the
 * things the Task forbids from being auto-appended (absolute local paths, secrets,
 * environment values). This is a REFUSAL, not a redaction — a goal that was silently
 * rewritten would no longer be the goal the human wrote.
 */
/** Control characters other than tab/newline/carriage return: a goal is prose, not a binary blob. */
const hasControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x7f) return true;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
};
const SECRET_ASSIGNMENT =
  /(api[-_]?key|secret|token|password|passwd|credential|private[-_]?key|access[-_]?key|bearer)\s*[:=]\s*\S/i;
const BEARERISH = /\b(sk|pk)-[A-Za-z0-9]{16,}\b/;
const ENV_EXPANSION = /\$\{[^}]*\}|\$\([^)]*\)/;
const ABSOLUTE_PATH = /(^|\s)([A-Za-z]:[\\/]|\\\\|~\/|\/(?!\/)\S)/;

const unsafeText = (value: string): string | null => {
  if (hasControlCharacters(value)) return 'goal text contains control characters';
  if (SECRET_ASSIGNMENT.test(value)) return 'goal text looks like a credential assignment';
  if (BEARERISH.test(value)) return 'goal text looks like a credential literal';
  if (ENV_EXPANSION.test(value)) return 'goal text must not carry shell/environment expansion';
  if (ABSOLUTE_PATH.test(value)) return 'goal text must not carry an absolute local path';
  return null;
};

const collectStrings = (value: unknown, into: string[]): void => {
  if (typeof value === 'string') {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
};

/** The goal as it is written down: every optional field resolved by validation. */
export interface ResolvedRunGoalInput {
  readonly objective: string;
  readonly structured: Readonly<Record<string, unknown>> | null;
  readonly source: RunGoalSource;
}

/** Validate the caller's goal BEFORE anything is written. Pure; no store access. */
export function validateRunGoalInput(input: RunGoalInput): Result<ResolvedRunGoalInput, DomainError> {
  if (!isRecord(input)) {
    return err(domainError('INVALID_ARGUMENT', 'A run goal must be an object with an objective.'));
  }
  if (typeof input.objective !== 'string' || input.objective.trim() === '') {
    return err(
      domainError('INVALID_ARGUMENT', 'A run goal requires a non-empty objective.', {
        reason: 'RUN_GOAL_OBJECTIVE_MISSING',
      }),
    );
  }
  if (input.objective.length > RUN_GOAL_MAX_OBJECTIVE_CHARS) {
    return err(
      domainError('INVALID_ARGUMENT', `A run goal objective is limited to ${RUN_GOAL_MAX_OBJECTIVE_CHARS} characters.`, {
        reason: 'RUN_GOAL_OBJECTIVE_TOO_LARGE',
        size: input.objective.length,
      }),
    );
  }
  const objective = input.objective.trim();
  const objectiveFault = unsafeText(objective);
  if (objectiveFault !== null) {
    return err(
      domainError('INVALID_ARGUMENT', `${objectiveFault}; state the objective without it.`, {
        reason: 'RUN_GOAL_CONTENT_UNSAFE',
      }),
    );
  }

  let structured: Readonly<Record<string, unknown>> | null = null;
  if (input.structured !== undefined && input.structured !== null) {
    if (!isRecord(input.structured)) {
      return err(
        domainError('INVALID_ARGUMENT', 'Structured goal constraints must be an object.', {
          reason: 'RUN_GOAL_STRUCTURED_INVALID',
        }),
      );
    }
    const encoded = new TextEncoder().encode(canonicalJson(input.structured));
    if (encoded.byteLength > RUN_GOAL_MAX_STRUCTURED_BYTES) {
      return err(
        domainError('INVALID_ARGUMENT', `Structured goal constraints are limited to ${RUN_GOAL_MAX_STRUCTURED_BYTES} bytes.`, {
          reason: 'RUN_GOAL_STRUCTURED_TOO_LARGE',
          size: encoded.byteLength,
        }),
      );
    }
    const strings: string[] = [];
    collectStrings(input.structured, strings);
    for (const text of strings) {
      const fault = unsafeText(text);
      if (fault !== null) {
        return err(
          domainError('INVALID_ARGUMENT', `Structured goal constraints: ${fault}.`, {
            reason: 'RUN_GOAL_CONTENT_UNSAFE',
          }),
        );
      }
    }
    structured = input.structured;
  }

  const source: RunGoalSource =
    input.source === undefined
      ? { type: 'application' }
      : input.source.type === 'human'
        ? { type: 'human', ...(input.source.ref === undefined ? {} : { ref: input.source.ref }) }
        : { type: 'application', ...(input.source.ref === undefined ? {} : { ref: input.source.ref }) };

  return ok({ objective, structured: structured ?? null, source });
}

/** Canonical bytes for the durable artifact content. Deterministic key order. */
export function encodeRunGoal(goal: RunGoal): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({
      schema: goal.schema,
      runId: goal.runId,
      objective: goal.objective,
      structured: goal.structured,
      source: goal.source,
      // `createdAt`/`createdBy` are NOT repeated here: the artifact row is the one durable
      // source for both, and duplicating them would create a second truth to disagree with.
    }),
  );
}

/**
 * Decode durable goal bytes. The durable record is re-validated against the SAME rules the
 * writer applied and bound to the artifact it claims to come from, so a tampered or foreign
 * artifact can never be presented as this run's goal.
 */
export function decodeRunGoal(
  bytes: Uint8Array,
  expected: { readonly runId: string; readonly createdBy: string; readonly createdAt: string },
): Result<RunGoal, DomainError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return err(
      domainError('VALIDATION_FAILED', 'The durable run goal is not valid JSON.', {
        reason: 'RUN_GOAL_ARTIFACT_CORRUPT',
      }),
    );
  }
  if (!isRecord(parsed)) {
    return err(
      domainError('VALIDATION_FAILED', 'The durable run goal is not an envelope.', {
        reason: 'RUN_GOAL_ARTIFACT_CORRUPT',
      }),
    );
  }
  if (parsed['schema'] !== RUN_GOAL_SCHEMA) {
    return err(
      domainError('VALIDATION_FAILED', `Unsupported run goal schema "${String(parsed['schema'])}".`, {
        reason: 'RUN_GOAL_SCHEMA_UNSUPPORTED',
      }),
    );
  }
  // Binding: the envelope declares the run it belongs to, and the artifact row supplies the
  // author and the instant. The creation command identity (`run-goal:<runId>`) and the CAS
  // digest already tie the two together, so the author is not duplicated inside the bytes.
  if (parsed['runId'] !== expected.runId) {
    return err(
      domainError('VALIDATION_FAILED', 'The durable run goal is not bound to this run.', {
        reason: 'RUN_GOAL_PROVENANCE_MISMATCH',
      }),
    );
  }
  // The durable record is re-validated through the SAME writer rules, and its own source
  // provenance is carried through the same normalisation — a goal that was authored by a human
  // reads back as human-authored, never as application-authored by accident.
  const durableSource = isRecord(parsed['source']) ? parsed['source'] : {};
  const durableSourceType: RunGoalSourceType = durableSource['type'] === 'human' ? 'human' : 'application';
  const durableSourceRef = typeof durableSource['ref'] === 'string' ? durableSource['ref'] : undefined;
  const checked = validateRunGoalInput({
    objective: String(parsed['objective'] ?? ''),
    ...(parsed['structured'] === null || parsed['structured'] === undefined
      ? {}
      : { structured: parsed['structured'] as Readonly<Record<string, unknown>> }),
    source: {
      type: durableSourceType,
      ...(durableSourceRef === undefined || durableSourceRef.length === 0 ? {} : { ref: durableSourceRef }),
    },
  });
  if (!checked.ok) {
    return err(
      domainError('VALIDATION_FAILED', `The durable run goal fails the goal contract: ${checked.error.message}`, {
        reason: 'RUN_GOAL_ARTIFACT_CONTENT_INVALID',
      }),
    );
  }
  return ok({
    schema: RUN_GOAL_SCHEMA,
    runId: expected.runId,
    objective: checked.value.objective,
    structured: checked.value.structured,
    source: checked.value.source,
    createdAt: expected.createdAt,
    createdBy: expected.createdBy,
  });
}
