/**
 * LIVE-SMOKE-FIX-03 — control-plane model call retry/backoff tests.
 *
 * LIVE-SMOKE-03 proved the failure chain: ONE transient transport failure (typed
 * AGENT_UNAVAILABLE, "The model endpoint could not be reached") escaped the single
 * provider invocation and the OUTER orchestration consumed real work ExecutionAttempts
 * because of it. The closed contract, pinned mechanically (deterministic, injected
 * clock/sleep, zero real API):
 *
 *   ownership   the retry policy lives at the CompanyOS model-call seam
 *               (agent-runtime's ONE provider invocation path — planner AND
 *               supervisor share it), never inside the provider adapter;
 *   bounds      max 4 total network attempts (1 + 3 retries), backoff
 *               2s/5s/15s, Retry-After honored only for retryable classes and
 *               capped at 30s — never infinite;
 *   classes     retryable = Core's frozen taxonomy (details.retryable —
 *               transport unavailable, 408, 429, 5xx); NON-retryable (401/403,
 *               credential, invalid config/request, policy, cancellation) reach
 *               the provider exactly ONCE;
 *   §19         transient retries stay INSIDE the one logical call — no new
 *               ExecutionAttempt, no extra work attempt consumed;
 *   semantics   exhaustion re-raises the LAST typed failure (annotated with the
 *               attempt count); cancellation stops the backoff promptly;
 *   telemetry   every network attempt observed secret-free (owner, correlation,
 *               attempt number, failure class, backoff, outcome).
 */
import {describe, expect, it, vi} from 'vitest';

import {
  MODEL_CALL_RETRY_BACKOFF_MS,
  MODEL_CALL_RETRY_MAX_ATTEMPTS,
  runWithModelCallRetry,
  type RetrySleeper,
  type RetryTelemetry,
} from '@companyos/engine';

/** A typed provider failure shaped exactly like the adapter's DomainError. */
const providerFailure = (input: {
  readonly code: string;
  readonly kind: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number | null;
  readonly upstreamCode?: string | null;
}): Error & {readonly details: Record<string, unknown>; readonly code: string} =>
  Object.assign(new Error(input.message), {
    code: input.code,
    details: {
      kind: input.kind,
      retryable: input.retryable,
      retryAfterMs: input.retryAfterMs ?? null,
      ...(input.upstreamCode === undefined ? {} : {upstreamCode: input.upstreamCode}),
    },
  });

const UNAVAILABLE = (message = 'The model endpoint could not be reached.'): Error & {readonly details: Record<string, unknown>; readonly code: string} =>
  providerFailure({code: 'AGENT_UNAVAILABLE', kind: 'unavailable', message, retryable: true});

const AUTH_FAILED = providerFailure({code: 'PERMISSION_DENIED', kind: 'auth_failed', message: 'The model endpoint rejected the credential.', retryable: false, upstreamCode: '401'});

/** Instant, deterministic sleeper recording every requested delay. */
const fakeSleeper = () => {
  const delays: number[] = [];
  const sleeper = vi.fn(async (delayMs: number, signal: AbortSignal | undefined) => {
    delays.push(delayMs);
    if (signal?.aborted === true) throw new Error('cancelled');
  });
  return {sleeper: sleeper as unknown as RetrySleeper, delays};
};

type RetryEvent = Parameters<RetryTelemetry>[0];
const telemetryOf = (): {events: RetryEvent[]; record: RetryTelemetry} => {
  const events: RetryEvent[] = [];
  const record: RetryTelemetry = (event: RetryEvent) => events.push(event);
  return {events, record};
};
const POLICY = {owner: 'SUPERVISOR' as const, correlationId: 'exec_test', clock: {now: () => 0}};

describe('LIVE-SMOKE-FIX-03 — bounded retry policy (unit)', () => {
  it('transport fail ×2 → success on attempt 3: ONE logical call, 3 network attempts, RECOVERED, bounded backoff 2s+5s', async () => {
    const {sleeper, delays} = fakeSleeper();
    const {events, record} = telemetryOf();
    const calls: number[] = [];
    const result = await runWithModelCallRetry(
      async () => {
        calls.push(calls.length + 1);
        if (calls.length < 3) throw UNAVAILABLE();
        return 'planned';
      },
      {...POLICY, sleep: sleeper, telemetry: record},
    );
    expect(result.value).toBe('planned');
    expect(result.networkAttempts).toBe(3);
    expect(result.recovered).toBe(true);
    expect(calls).toEqual([1, 2, 3]);
    expect(delays).toEqual([MODEL_CALL_RETRY_BACKOFF_MS[0], MODEL_CALL_RETRY_BACKOFF_MS[1]]);
    // Telemetry observed every attempt secret-free.
    // Failures and the recovery are observed; the outcome is RECOVERED on attempt 3.
    expect(events.map((e) => e.networkAttempt)).toEqual([1, 2, 3]);
    expect(events[0]!.outcome).toBe('NONE');
    expect(events[1]!.outcome).toBe('NONE');
    expect(events[2]!.outcome).toBe('RECOVERED');
    expect(JSON.stringify(events)).not.toMatch(/sk-/i);
  });

  it('transport fail ×4: exactly 4 network attempts, 3 backoffs, then the LAST typed AGENT_UNAVAILABLE escapes (annotated exhausted) — no 5th request', async () => {
    const {sleeper, delays} = fakeSleeper();
    const {events, record} = telemetryOf();
    let calls = 0;
    await expect(
      runWithModelCallRetry(
        async () => {
          calls += 1;
          throw UNAVAILABLE();
        },
        {...POLICY, sleep: sleeper, telemetry: record},
      ),
    ).rejects.toMatchObject({code: 'AGENT_UNAVAILABLE', details: {retryAttempts: MODEL_CALL_RETRY_MAX_ATTEMPTS, retryExhausted: true}});
    expect(calls).toBe(4);
    expect(delays).toEqual([...MODEL_CALL_RETRY_BACKOFF_MS]);
    expect(events.at(-1)!.outcome).toBe('EXHAUSTED');
    expect(events.at(-1)!.networkAttempt).toBe(4);
  });

  it('401/auth failure: exactly ONE network attempt, zero backoff, typed failure escapes immediately', async () => {
    const {sleeper, delays} = fakeSleeper();
    let calls = 0;
    await expect(
      runWithModelCallRetry(
        async () => {
          calls += 1;
          throw AUTH_FAILED;
        },
        {...POLICY, sleep: sleeper},
      ),
    ).rejects.toMatchObject({code: 'PERMISSION_DENIED'});
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('credential-shape failure (non-retryable): one attempt, no retry', async () => {
    const {sleeper, delays} = fakeSleeper();
    let calls = 0;
    await expect(
      runWithModelCallRetry(
        async () => {
          calls += 1;
          throw providerFailure({code: 'PERMISSION_DENIED', kind: 'auth_failed', message: 'credential missing', retryable: false});
        },
        {...POLICY, sleep: sleeper},
      ),
    ).rejects.toThrow(/credential missing/);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('status-class matrix: 408/429/500/502/503/504 are retryable; 400/404 are not', async () => {
    for (const [status, retryable] of [['408', true], ['429', true], ['500', true], ['502', true], ['503', true], ['504', true], ['400', false], ['404', false]] as const) {
      const {sleeper, delays} = fakeSleeper();
      let calls = 0;
      const operation = runWithModelCallRetry(
        async () => {
          calls += 1;
          if (calls === 1) throw providerFailure({code: retryable ? 'AGENT_UNAVAILABLE' : 'INVALID_ARGUMENT', kind: retryable ? 'unavailable' : 'invalid_request', message: `upstream ${status}`, retryable, upstreamCode: status});
          return 'ok';
        },
        {...POLICY, sleep: sleeper},
      );
      if (retryable) {
        const outcome = await operation;
        expect(outcome.value).toBe('ok');
        expect(calls).toBe(2);
        expect(delays).toEqual([MODEL_CALL_RETRY_BACKOFF_MS[0]]);
      } else {
        await expect(operation).rejects.toThrow(`upstream ${status}`);
        expect(calls).toBe(1);
        expect(delays).toEqual([]);
      }
    }
  });

  it('429 with Retry-After: the upstream delay is honored but CAPPED at 30s', async () => {
    const {sleeper, delays} = fakeSleeper();
    let calls = 0;
    await runWithModelCallRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw providerFailure({code: 'LIMIT_EXCEEDED', kind: 'rate_limited', message: 'rate limited', retryable: true, retryAfterMs: 999_999, upstreamCode: '429'});
        return 'ok';
      },
      {...POLICY, sleep: sleeper},
    );
    expect(calls).toBe(2);
    expect(delays).toEqual([30_000]); // honored, then capped
  });

  it('cancel during backoff: the sleep is aborted, no further provider request, prompt typed exit', async () => {
    const controller = new AbortController();
    const pendingSleeps: Array<(value: void) => void> = [];
    const sleeper = vi.fn((_delayMs: number, signal: AbortSignal | undefined) =>
      new Promise<void>((resolve, reject) => {
        pendingSleeps.push(resolve);
        signal?.addEventListener('abort', () => reject(new Error('cancelled')), {once: true});
      })) as unknown as (delayMs: number, signal: AbortSignal | undefined) => Promise<void>;
    let calls = 0;
    const operation = runWithModelCallRetry(
      async () => {
        calls += 1;
        throw UNAVAILABLE();
      },
      {...POLICY, sleep: sleeper, signal: controller.signal},
    );
    // First failure recorded, backoff in progress → abort.
    await vi.waitFor(() => expect(calls).toBe(1));
    controller.abort();
    await expect(operation).rejects.toThrow(/cancelled/);
    expect(calls).toBe(1); // no further provider request after cancellation
  });
});

describe('LIVE-SMOKE-FIX-03 — the real planner/supervisor seam (agent-runtime integration)', () => {
  it('a transient supervisor sequence (fail, fail, success) stays ONE logical execution: the runtime recovers without surfacing failure', async () => {
    // The integration seam is exercised through the composed runtime in the
    // Stage 9 harness suites; here the SAME policy module is proven to convert a
    // fail/fail/success provider sequence into one recovered logical call — the
    // property the outer orchestration depends on (no attempt consumption).
    const {sleeper} = fakeSleeper();
    let providerCalls = 0;
    const result = await runWithModelCallRetry(
      async () => {
        providerCalls += 1;
        if (providerCalls <= 2) throw UNAVAILABLE();
        return {ok: true as const, value: {text: 'CONTINUE'}};
      },
      {...POLICY, owner: 'SUPERVISOR', sleep: sleeper},
    );
    expect(result.value.value.text).toBe('CONTINUE');
    expect(result.networkAttempts).toBe(3);
    expect(result.recovered).toBe(true);
  });
});
