/**
 * Provider error normalization and secret redaction (Sprint 6).
 *
 * Two jobs, both pure:
 *   1. map any provider failure onto ONE `NormalizedProviderError` so callers never parse
 *      vendor dialects (rate limit / quota / timeout / context limit / ...);
 *   2. make sure a secret can never leave the process through a message, an event, a log
 *      line or an error detail - `redactSecrets` is applied by the registry to every
 *      outbound string, and `assertNoSecrets` is the assertion the tests use.
 */
import { domainError, type DomainError, type ErrorCode } from '../kernel/errors.js';
import { ok, type Result } from '../kernel/result.js';
import type { NormalizedProviderError, ProviderErrorKind } from '../ports/model-provider.js';

/** Which Core error code a provider failure maps onto. */
export const ERROR_CODE_BY_KIND: Readonly<Record<ProviderErrorKind, ErrorCode>> = {
  rate_limited: 'LIMIT_EXCEEDED',
  quota_exhausted: 'LIMIT_EXCEEDED',
  timeout: 'TIMEOUT',
  context_limit: 'VALIDATION_FAILED',
  auth_failed: 'PERMISSION_DENIED',
  invalid_request: 'INVALID_ARGUMENT',
  tool_unsupported: 'CAPABILITY_MISSING',
  structured_output_unsupported: 'CAPABILITY_MISSING',
  streaming_unsupported: 'CAPABILITY_MISSING',
  unavailable: 'AGENT_UNAVAILABLE',
  content_filtered: 'POLICY_DENIED',
  unknown: 'AGENT_UNAVAILABLE',
};

/** Kinds worth retrying (the caller decides; Core only classifies). */
export const RETRYABLE_KINDS: readonly ProviderErrorKind[] = ['rate_limited', 'timeout', 'unavailable'];

/** The placeholder that replaces every secret occurrence. */
export const REDACTED = '[redacted]';

export interface NormalizeProviderErrorInput {
  readonly kind: ProviderErrorKind;
  readonly message: string;
  readonly providerId?: string | null;
  readonly retryAfterMs?: number | null;
  readonly upstreamCode?: string | null;
  /** Exact secret values known to the caller; every occurrence is masked. */
  readonly secrets?: readonly string[];
}

export function normalizeProviderError(input: NormalizeProviderErrorInput): NormalizedProviderError {
  return {
    kind: input.kind,
    message: redactSecrets(input.message, input.secrets ?? []),
    retryAfterMs: input.retryAfterMs ?? null,
    upstreamCode: input.upstreamCode ?? null,
    retryable: RETRYABLE_KINDS.includes(input.kind),
    providerId: input.providerId ?? null,
  };
}

/** A single provider failure as a Core domain error (safe `details`, no secret). */
export function providerErrorToDomainError(
  error: NormalizedProviderError,
  extra: Readonly<Record<string, unknown>> = {},
): DomainError {
  return domainError(ERROR_CODE_BY_KIND[error.kind], error.message, {
    kind: error.kind,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    upstreamCode: error.upstreamCode,
    ...(error.providerId === null ? {} : { providerId: error.providerId }),
    ...extra,
  });
}

/**
 * Mask every occurrence of the known secret values.
 *
 * Works on any string (message, JSON blob, stack trace). Short values are ignored to
 * avoid masking ordinary words; anything under 6 characters is treated as "not a secret"
 * by the caller's own choice - `assertNoSecrets` still catches it if it reappears.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length < 6) continue;
    output = output.split(secret).join(REDACTED);
  }
  return output;
}

/** Deep-redact a JSON-ish value (objects/arrays/strings) before logging or emitting it. */
export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        redactSecrets(key, secrets),
        redactValue(entry, secrets),
      ]),
    );
  }
  return value;
}

/** Test/assertion helper: does this payload still contain any known secret? */
export function containsSecret(payload: unknown, secrets: readonly string[]): boolean {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  return secrets.some((secret) => secret.length > 0 && serialized.includes(secret));
}

/** Guard used by the registry before a payload leaves the process. */
export function assertNoSecrets(
  payload: unknown,
  secrets: readonly string[],
  context: string,
): Result<true, DomainError> {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  const leaked = secrets.find((secret) => secret.length > 0 && serialized.includes(secret));
  if (leaked === undefined) return ok(true);
  return {
    ok: false,
    error: domainError('PERMISSION_DENIED', `Secret material detected in ${context}; payload refused.`, {
      context,
      // Marks this as OUR guard so the provider layer does not re-classify it.
      guard: 'secret-material',
      // Never echo the secret itself, only its length bucket.
      leakedLength: leaked.length,
    }),
  };
}
