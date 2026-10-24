/**
 * MockProvider (Sprint 6) - a deterministic, vendor-free adapter used by tests and by the
 * UI until a real adapter exists.
 *
 * Deterministic by construction: scripted by call index, no randomness, no timers, no
 * IO. It can also FAIL on demand with a specific normalized error kind, which is how the
 * error-mapping tests (J/K/L/M) exercise the registry without inventing network faults.
 */
import {
  DomainError,
  domainError,
  err,
  ok,
  type HealthReport,
  type InvocationRequest,
  type InvocationResult,
  type ModelProviderDescriptor,
  type ModelProviderPort,
  type ProviderErrorKind,
  type RawModelInfo,
  type Result,
  type StreamChunk,
  type TokenUsage,
} from '@companyos/core';

/** Marker the registry reads to keep the provider's own failure kind. */
export const PROVIDER_KIND_MARKER = 'companyos.provider.kind';

export interface MockInvocationOutcome {
  readonly outputText: string;
  readonly structured?: unknown | null;
  readonly toolCalls?: readonly {
    readonly callId: string;
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }[];
  readonly usage?: Partial<TokenUsage>;
  readonly finishReason?: InvocationResult['finishReason'];
}

export interface MockProviderScript {
  readonly models?: readonly RawModelInfo[];
  readonly health?: HealthReport;
  /** One entry per call; the last entry repeats once the script is exhausted. */
  readonly outcomes?: readonly (MockInvocationOutcome | ProviderErrorKind)[];
  /** Deltas used by `stream`, then a final chunk with usage. */
  readonly streamDeltas?: readonly string[];
  readonly streamUsage?: Partial<TokenUsage>;
  /** When set, `stream` fails with this kind before yielding anything. */
  readonly streamError?: ProviderErrorKind;
  /**
   * How long `invoke` stays pending before answering. This is the seam that makes a REAL
   * in-flight cancellation testable: the invocation is genuinely still running when the
   * caller's signal fires, so the adapter must actually stop it. Zero/absent = answer at once.
   */
  readonly pendingMs?: number;
  /**
   * How many times `invoke` retries after a scripted provider failure. Present so the
   * cancellation contract can be proven against a retrying adapter: an aborted invocation must
   * stop retrying instead of scheduling another attempt.
   */
  readonly retries?: number;
  /** Delay before each retry, so the "abort during backoff" window exists. */
  readonly retryDelayMs?: number;
}

export interface MockProviderInput {
  readonly providerId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly version?: string;
  readonly script?: MockProviderScript;
  readonly now?: () => string;
  /**
   * How the adapter waits (the `pendingMs` / `retryDelayMs` windows). INJECTED, exactly like
   * `now`: the engine may not install timers itself (boundary gate), so a caller that wants a
   * genuinely in-flight invocation supplies one, and the default stays immediate — a caller
   * that supplies nothing observes exactly the behavior it had before.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface MockProvider extends ModelProviderPort {
  /** Every request it has seen, in order (assertions never need to guess). */
  readonly calls: readonly InvocationRequest[];
  /** How many times `health()` was called - lets tests prove a path does NOT probe. */
  readonly healthCalls: number;
  /** How many invocations were handed an AbortSignal (proof the caller forwarded one). */
  readonly signalObservations: number;
  /** How many invocations actually OBSERVED their signal firing (proof it was honored). */
  readonly abortObservations: number;
  /** How many invocations ended as cancellations (the canonical `CANCELLED` result). */
  readonly cancellations: number;
  /** How many retry attempts were started in total (proof a retry stopped early). */
  readonly retryAttempts: number;
  /** Replace the script at runtime (test Q: substitute behaviour without touching callers). */
  setScript(script: MockProviderScript): void;
}

const DEFAULT_MODEL: RawModelInfo = {
  modelId: 'mock-standard',
  displayName: 'Mock Standard',
  contextWindow: 8_000,
  maxOutputTokens: 1_000,
  capabilities: { streaming: true, structuredOutput: true, toolCalling: true },
  pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'CREDIT' },
};

const usageOf = (partial?: Partial<TokenUsage>, request?: InvocationRequest): TokenUsage => ({
  inputTokens:
    partial?.inputTokens ??
    request?.messages.reduce((total, message) => total + message.content.length, 0) ??
    0,
  outputTokens: partial?.outputTokens ?? 0,
  totalCost: partial?.totalCost ?? 0,
});

const isKind = (value: MockInvocationOutcome | ProviderErrorKind): value is ProviderErrorKind =>
  typeof value === 'string';

/**
 * Read the caller's signal. A helper rather than an inline check so TypeScript's control-flow
 * narrowing cannot conclude "it was not aborted at loop entry, so it never can be" — the whole
 * point of a retry loop is that the state CHANGES between attempts.
 */
const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && signal.aborted;

export function createMockProvider(input: MockProviderInput): MockProvider {
  const descriptor: ModelProviderDescriptor = {
    providerId: input.providerId,
    kind: input.kind,
    displayName: input.displayName,
    version: input.version ?? '1.0.0',
  };
  const nowIso = input.now ?? ((): string => new Date(0).toISOString());
  const sleep = input.sleep ?? ((): Promise<void> => Promise.resolve());

  let script: MockProviderScript = input.script ?? {};
  const calls: InvocationRequest[] = [];
  let healthCalls = 0;
  let signalObservations = 0;
  let abortObservations = 0;
  let cancellations = 0;
  let retryAttempts = 0;

  const failWith = (kind: ProviderErrorKind): DomainError =>
    new DomainError(
      'AGENT_UNAVAILABLE',
      `Mock provider "${input.providerId}" failed with ${kind}.`,
      {
        details: { [PROVIDER_KIND_MARKER]: kind, upstreamCode: `mock.${kind}` },
      },
    );

  const outcomeFor = (index: number, request: InvocationRequest): MockInvocationOutcome => {
    const outcomes = script.outcomes ?? [];
    if (outcomes.length === 0) {
      return { outputText: `mock:${String(request.messages.length)}` };
    }
    const entry = outcomes[Math.min(index, outcomes.length - 1)];
    if (entry === undefined) return { outputText: 'mock:empty' };
    if (isKind(entry)) throw failWith(entry);
    return entry;
  };

  /** The canonical cancelled-invocation result: not retryable, not a provider failure. */
  const cancelled = (): DomainError =>
    domainError('CANCELLED', `The invocation on "${input.providerId}" was cancelled.`, {
      kind: 'CANCELLED',
      providerId: input.providerId,
      retryable: false,
    });

  /**
   * Wait out `pendingMs` while listening for the caller's signal. Rejects the moment the signal
   * fires — this is the adapter honoring the contract, not a caller-side race.
   */
  const stayPending = async (signal: AbortSignal | undefined, pendingMs: number): Promise<void> => {
    if (signal === undefined) {
      await sleep(pendingMs);
      return;
    }
    if (signal.aborted) {
      abortObservations += 1;
      cancellations += 1;
      throw cancelled();
    }
    let settled = false;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        sleep(pendingMs).then(() => {
          settled = true;
        }),
        new Promise<void>((_resolve, reject) => {
          onAbort = (): void => reject(cancelled());
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } catch (error) {
      if (!settled) {
        abortObservations += 1;
        cancellations += 1;
      }
      throw error;
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
  };

  /** The adapter's own retry loop, so "abort stops the next attempt" is a real assertion. */
  const withRetries = async (
    request: InvocationRequest,
    attempt: () => Promise<Result<InvocationResult, DomainError>>,
  ): Promise<Result<InvocationResult, DomainError>> => {
    const retries = script.retries ?? 0;
    const delay = script.retryDelayMs ?? 0;
    for (let index = 0; ; index += 1) {
      if (isAborted(request.signal)) {
        abortObservations += 1;
        cancellations += 1;
        return err(cancelled());
      }
      retryAttempts += 1;
      try {
        return await attempt();
      } catch (error) {
        if (isAborted(request.signal)) {
          abortObservations += 1;
          cancellations += 1;
          return err(cancelled());
        }
        const isProviderFailure =
          error instanceof DomainError && typeof error.details[PROVIDER_KIND_MARKER] === 'string';
        if (!isProviderFailure || index >= retries) throw error;
        if (delay > 0) await stayPending(request.signal, delay);
      }
    }
  };

  const provider: MockProvider = {
    get calls() {
      return [...calls];
    },
    get healthCalls() {
      return healthCalls;
    },
    get signalObservations() {
      return signalObservations;
    },
    get abortObservations() {
      return abortObservations;
    },
    get cancellations() {
      return cancellations;
    },
    get retryAttempts() {
      return retryAttempts;
    },
    setScript(next: MockProviderScript): void {
      script = next;
    },
    describe: () => descriptor,

    async listModels(signal?: AbortSignal): Promise<Result<readonly RawModelInfo[], DomainError>> {
      if (signal?.aborted) return err(domainError('CANCELLED', 'cancelled'));
      return ok(script.models ?? [DEFAULT_MODEL]);
    },

    async health(): Promise<Result<HealthReport, DomainError>> {
      healthCalls += 1;
      return ok(
        script.health ?? {
          status: 'healthy',
          checkedAt: nowIso(),
          latencyMs: 1,
          detail: null,
        },
      );
    },

    async invoke(request: InvocationRequest): Promise<Result<InvocationResult, DomainError>> {
      calls.push(request);
      if (request.signal !== undefined) signalObservations += 1;
      if (isAborted(request.signal)) {
        abortObservations += 1;
        cancellations += 1;
        return err(cancelled());
      }
      try {
        if ((script.pendingMs ?? 0) > 0) {
          await stayPending(request.signal, script.pendingMs as number);
        }
        return await withRetries(request, () => {
          const outcome = outcomeFor(calls.length - 1, request);
          const usage = usageOf(outcome.usage, request);
          const result: InvocationResult = {
            modelId: request.modelId,
            providerId: descriptor.providerId,
            outputText: outcome.outputText,
            structured: outcome.structured ?? null,
            toolCalls: outcome.toolCalls ?? [],
            usage,
            finishReason:
              outcome.finishReason ?? (outcome.toolCalls !== undefined ? 'tool_calls' : 'stop'),
          };
          return Promise.resolve(ok(result));
        });
      } catch (error) {
        if (error instanceof DomainError && error.code === 'CANCELLED') return err(error);
        throw error;
      }
    },

    stream(request: InvocationRequest): AsyncIterable<Result<StreamChunk, DomainError>> {
      calls.push(request);
      if (request.signal !== undefined) signalObservations += 1;
      const deltas = script.streamDeltas ?? [];
      const failure = script.streamError;
      const usage = usageOf(script.streamUsage, request);
      return {
        [Symbol.asyncIterator]: () => {
          let index = 0;
          return {
            async next(): Promise<IteratorResult<Result<StreamChunk, DomainError>, undefined>> {
              // The same cancellation contract applies to streaming: an aborted stream ends
              // without another chunk, rather than silently continuing to a provider.
              if (request.signal?.aborted === true) {
                abortObservations += 1;
                cancellations += 1;
                return { done: true, value: undefined };
              }
              if (failure !== undefined) {
                return { done: true, value: undefined };
              }
              if (index < deltas.length) {
                const deltaText = deltas[index] ?? '';
                index += 1;
                return {
                  done: false,
                  value: ok({ deltaText, toolCallDelta: null, done: false, usage: null }),
                };
              }
              if (index === deltas.length) {
                index += 1;
                return {
                  done: false,
                  value: ok({ deltaText: '', toolCallDelta: null, done: true, usage }),
                };
              }
              return { done: true, value: undefined };
            },
            async return(): Promise<IteratorResult<Result<StreamChunk, DomainError>, undefined>> {
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };

  // A failing stream must surface as an error chunk, not a silent empty stream.
  if (input.script?.streamError !== undefined) {
    const failing: ProviderErrorKind = input.script.streamError;
    provider.stream = (
      _request: InvocationRequest,
    ): AsyncIterable<Result<StreamChunk, DomainError>> => ({
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<Result<StreamChunk, DomainError>, undefined>> {
          return { done: false, value: err(failWith(failing)) };
        },
        async return(): Promise<IteratorResult<Result<StreamChunk, DomainError>, undefined>> {
          return { done: true, value: undefined };
        },
      }),
    });
  }

  void domainError;
  return provider;
}
