/**
 * LIVE-SMOKE-FIX-03 — CompanyOS-owned bounded retry/backoff policy for CONTROL-PLANE
 * model calls (the Planner and Supervisor logical model invocations).
 *
 * The live smoke proved the failure chain: one transient transport failure
 * (typed AGENT_UNAVAILABLE, "The model endpoint could not be reached") escaped the
 * single provider invocation immediately, and the OUTER orchestration consumed real
 * work ExecutionAttempts because of it. The missing piece was a CompanyOS retry
 * POLICY around the existing logical model call.
 *
 * Ownership rules (Boss §1/§7):
 *   - this policy lives at the CompanyOS orchestration/model-call layer — NEVER inside
 *     the provider adapter, the HTTP client, the broker or the kernel (one provider
 *     network invocation per orchestration attempt; CompanyOS decides whether another
 *     is permitted);
 *   - ONE logical model call may contain up to N network attempts but stays ONE
 *     Planner/Supervisor operation — no new ExecutionAttempt, no new durable truth
 *     (retry telemetry is observational evidence only);
 *   - classification is TYPED, never string matching: a provider failure is retryable
 *     exactly when Core's frozen taxonomy marked it so (`details.retryable`, from
 *     RETRYABLE_KINDS: rate_limited / timeout / unavailable — transport failures,
 *     408, 429, 5xx);
 *   - NON-retryable: auth/permission, credential failures, invalid request/config,
 *     policy, cancellation, and every class Core did not mark retryable — exactly
 *     ONE network attempt, no backoff;
 *   - a valid upstream Retry-After is honored only for retryable classes and bounded
 *     (V1 max 30_000 ms — an upstream server can never force hours of sleep);
 *   - backoff is CANCELABLE: an aborted signal stops the wait and the operation
 *     promptly with the typed cancellation semantics;
 *   - exhaustion re-throws the LAST typed failure annotated with the attempt count
 *     — the outer orchestration keeps its existing semantics, nothing is hidden.
 */

/** V1 bounds (Boss §3/§4). */
export const MODEL_CALL_RETRY_MAX_ATTEMPTS = 4; // 1 initial + up to 3 retries
export const MODEL_CALL_RETRY_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000];
export const MODEL_CALL_RETRY_AFTER_MAX_MS = 30_000;

export interface RetryPolicyClock {
  /** Milliseconds since the Unix epoch. */
  readonly now: () => number;
}

export interface RetrySleeper {
  /**
   * Cancelable backoff wait. Resolves when the delay elapses or rejects with the
   * abort reason once `signal` fires — never sleeps past cancellation.
   */
  (delayMs: number, signal: AbortSignal | undefined): Promise<void>;
}

export interface RetryTelemetry {
  /** Structured, secret-free observation of every network attempt. */
  (event: {
    readonly owner: 'PLANNER' | 'SUPERVISOR';
    readonly correlationId: string;
    readonly networkAttempt: number;
    readonly maxAttempts: number;
    readonly failureClass: string;
    readonly retryable: boolean;
    readonly backoffMs: number | null;
    readonly outcome: 'NONE' | 'RECOVERED' | 'EXHAUSTED' | 'NON_RETRYABLE' | 'CANCELLED';
    readonly httpStatus: string | null;
  }): void;
}

export interface ModelCallRetryOptions {
  readonly owner: 'PLANNER' | 'SUPERVISOR';
  readonly correlationId: string;
  readonly clock: RetryPolicyClock;
  readonly sleep: RetrySleeper;
  readonly telemetry?: RetryTelemetry;
  /** Abort signal forwarded from the logical call (cancellation stops backoff). */
  readonly signal?: AbortSignal;
}

export interface RetryInvocationResult<T> {
  readonly value: T;
  /** Network attempts actually made for this ONE logical call (1..MAX). */
  readonly networkAttempts: number;
  /** True when at least one transient retry happened before recovery. */
  readonly recovered: boolean;
}

const backoffFor = (failureNumber: number): number =>
  MODEL_CALL_RETRY_BACKOFF_MS[Math.min(failureNumber - 1, MODEL_CALL_RETRY_BACKOFF_MS.length - 1)] ?? 0;

const retryAfterFor = (error: {readonly details?: Readonly<Record<string, unknown>>} | null): number | null => {
  const raw = error?.details?.['retryAfterMs'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.min(Math.floor(raw), MODEL_CALL_RETRY_AFTER_MAX_MS);
};

const isRetryableFailure = (error: {readonly details?: Readonly<Record<string, unknown>>} | null): boolean =>
  error?.details?.['retryable'] === true;

/**
 * Execute ONE logical control-plane model call under the CompanyOS bounded retry
 * policy. `invoke` performs exactly one provider network attempt per call.
 *
 * Outcomes:
 *   - success            → `{value, networkAttempts, recovered}`;
 *   - non-retryable      → the typed failure escapes after attempt 1 (NON_RETRYABLE);
 *   - exhaustion         → the LAST typed failure escapes annotated
 *                          (`details.retryAttempts`, `details.retryExhausted`)
 *                          after MAX attempts (EXHAUSTED);
 *   - cancellation       → the abort reason escapes promptly (CANCELLED).
 */
export const runWithModelCallRetry = async <T>(
  invoke: () => Promise<T>,
  options: ModelCallRetryOptions,
): Promise<RetryInvocationResult<T>> => {
  const observe: RetryTelemetry =
    options.telemetry ??
    (() => {
      /* telemetry is optional; silence is still bounded and typed */
    });
  let lastError: (Error & {readonly details?: Readonly<Record<string, unknown>>}) | null = null;
  for (let attempt = 1; attempt <= MODEL_CALL_RETRY_MAX_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted === true) {
      observe({owner: options.owner, correlationId: options.correlationId, networkAttempt: attempt - 1, maxAttempts: MODEL_CALL_RETRY_MAX_ATTEMPTS, failureClass: 'CANCELLED', retryable: false, backoffMs: null, outcome: 'CANCELLED', httpStatus: null});
      throw new Error('cancelled');
    }
    try {
      const value = await invoke();
      // A first-attempt success is not a retry observation — stay silent (no noise).
      if (attempt > 1) {
        observe({owner: options.owner, correlationId: options.correlationId, networkAttempt: attempt, maxAttempts: MODEL_CALL_RETRY_MAX_ATTEMPTS, failureClass: 'NONE', retryable: false, backoffMs: null, outcome: 'RECOVERED', httpStatus: null});
      }
      return {value, networkAttempts: attempt, recovered: attempt > 1};
    } catch (error) {
      const caught = error as Error & {readonly details?: Readonly<Record<string, unknown>>};
      lastError = caught;
      const details: Readonly<Record<string, unknown>> = caught.details ?? {};
      const retryable = isRetryableFailure(caught);
      const signal = options.signal;
      const cancelled = (signal !== undefined && signal.aborted) || details['kind'] === 'CANCELLED';
      const httpStatus = typeof details['upstreamCode'] === 'string' ? String(details['upstreamCode']) : null;
      if (cancelled) {
        observe({owner: options.owner, correlationId: options.correlationId, networkAttempt: attempt, maxAttempts: MODEL_CALL_RETRY_MAX_ATTEMPTS, failureClass: 'CANCELLED', retryable: false, backoffMs: null, outcome: 'CANCELLED', httpStatus});
        throw caught;
      }
      if (!retryable || attempt === MODEL_CALL_RETRY_MAX_ATTEMPTS) {
        const failureClass = String(details['kind'] ?? caught.message);
        observe({owner: options.owner, correlationId: options.correlationId, networkAttempt: attempt, maxAttempts: MODEL_CALL_RETRY_MAX_ATTEMPTS, failureClass, retryable, backoffMs: null, outcome: retryable ? 'EXHAUSTED' : 'NON_RETRYABLE', httpStatus});
        if (retryable) {
          // Exhaustion: re-throw the LAST typed failure, annotated — outer semantics unchanged.
          const annotated = Object.assign(caught, {
            details: {...details, retryAttempts: attempt, retryExhausted: true},
          });
          throw annotated;
        }
        throw caught;
      }
      const waited = retryAfterFor(caught) ?? backoffFor(attempt);
      const failureClass = String(details['kind'] ?? caught.message);
      observe({owner: options.owner, correlationId: options.correlationId, networkAttempt: attempt, maxAttempts: MODEL_CALL_RETRY_MAX_ATTEMPTS, failureClass, retryable: true, backoffMs: waited, outcome: 'NONE', httpStatus});
      await options.sleep(waited, signal);
    }
  }
  // Unreachable (the loop always returns or throws), kept for the type checker.
  throw lastError ?? new Error('model call retry loop exited without a result');
};


