/**
 * Canonical error taxonomy for the CompanyOS domain kernel.
 *
 * Every failure that crosses a port boundary is a `DomainError` carrying a
 * machine-readable `code`. The codes below are the frozen Sprint 0 contract;
 * docs/STATE_MACHINE.md lists which state machine raises which code.
 */

export const ERROR_CODES = [
  'ILLEGAL_TRANSITION',
  'LOCKED_TEMPLATE',
  'DEPRECATED_TEMPLATE',
  'ARCHIVED_READONLY',
  'SNAPSHOT_MISMATCH',
  'PROPOSAL_NOT_ACCEPTED',
  'HASH_MISMATCH',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'NOT_IMPLEMENTED',
  // ---- frozen in Sprint 1 (ADR-0002): domain-model failure modes ------------
  'INVALID_ARGUMENT',
  'ALREADY_EXISTS',
  'IMMUTABLE_ENTITY',
  'POLICY_DENIED',
  'APPROVAL_REQUIRED',
  'APPROVAL_DENIED',
  'CAPABILITY_MISSING',
  'AGENT_UNAVAILABLE',
  'LIMIT_EXCEEDED',
  // ---- frozen in Sprint 3: durability failures ------------------------------
  'PERSISTENCE_FAILED',
  // ---- frozen in Sprint 6: provider / authorization failures ----------------
  'TIMEOUT',
  'PERMISSION_DENIED',
  // Sprint 8: the runtime never chooses a model, so "nobody named one" is its own code.
  'MODEL_SELECTION_REQUIRED',
  'ROUTER_NOT_AVAILABLE',
  'CANCELLED',
  /** A process died mid-attempt: not a provider failure, and deliberately not retryable-looking. */
  'INTERRUPTED',
  // ---- Sprint 10A.0.2: router contract hardening ----------------------------
  /** The router must not run for a MANUAL request (HIGH-1). */
  'MANUAL_NOT_ROUTED',
  /** A recommendation failed its own consistency invariants (MEDIUM-4). */
  'RECOMMENDATION_INVALID',
  // ---- Sprint 25: secrets / config / workspace safety --------------------------
  /**
   * A `SecretRef` names a credential that is not configured anywhere reachable. The operator's
   * remedy is to configure it. Deliberately NOT `PERMISSION_DENIED`: "not configured" and
   * "not permitted" are different failures with different remedies, and conflating them is
   * how a missing credential silently becomes a retry loop.
   */
  'SECRET_NOT_FOUND',
  /**
   * The source that should hold the secret (OS keychain, external vault) could not be
   * reached at all. Also fail-closed: an unreachable source is never treated as "no secret
   * needed", because that is indistinguishable from a successful empty answer.
   */
  'SECRET_SOURCE_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface DomainErrorOptions {
  /** Arbitrary structured context. MUST NOT contain secrets (see SECURITY_MODEL). */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** Base class for every expected, recoverable domain failure. */
export class DomainError extends Error {
  public readonly code: ErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(code: ErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = options.details ?? {};
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  public toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Raised by the workflow lifecycle machine when a transition is not legal. */
export class LifecycleError extends DomainError {
  public constructor(
    code: ErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code, message, { details });
    this.name = 'LifecycleError';
  }
}

/** Raised by the capability registry when a pack manifest is malformed. */
export class PackManifestError extends DomainError {
  public constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super('VALIDATION_FAILED', message, { details });
    this.name = 'PackManifestError';
  }
}

/** Raised by Sprint 0 placeholders for capabilities that must not exist yet. */
export class NotImplementedError extends DomainError {
  public constructor(what: string, sprint: string) {
    super('NOT_IMPLEMENTED', `${what} is intentionally not implemented in Sprint 0 — scheduled for ${sprint}.`, {
      details: { what, scheduledFor: sprint },
    });
    this.name = 'NotImplementedError';
  }
}

/**
 * Ergonomic constructor for domain failures: `domainError(code, message, details)`.
 *
 * Exists so domain aggregates never repeat the `{ details: … }` wrapper, and so
 * every failure carries structured context (规划书 §四十四 Audit needs to answer
 * "why was this refused", not just "it failed").
 */
export const domainError = (
  code: ErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): DomainError => new DomainError(code, message, { details });
