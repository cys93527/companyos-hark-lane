/**
 * Providers, the vendor-neutral way (Sprint 6).
 *
 * This module defines WHAT a model provider must be able to do. It never names a
 * vendor: an adapter in the outer ring maps a real HTTP/JSON dialect onto these types,
 * and Core/Engine stay ignorant of who is on the other side.
 *
 * Two layers, deliberately separate:
 *   - `ModelGateway` (Sprint 1) = "which logical capability should serve this work"
 *     (the Router's seam, ADR-0002);
 *   - `ModelProviderPort` (this file) = "how do I talk to ONE provider" - the executable
 *     boundary. A registry selects a provider ONLY by explicit id; routing/selection is
 *     Sprint 7+ and is not implemented here.
 */
import type { DomainError } from '../kernel/errors.js';
import type { Result } from '../kernel/result.js';
import type { SecretRef } from './secrets.js';

/* ------------------------------------------------------------- capabilities --- */

/** Declared abilities of a model. Absent fields are normalized to `false`. */
export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly vision: boolean;
  readonly audio: boolean;
  readonly reasoning: boolean;
}

export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  streaming: false,
  structuredOutput: false,
  toolCalling: false,
  vision: false,
  audio: false,
  reasoning: false,
};

/** Partial declaration accepted from adapters; Core normalizes it (test D). */
export type PartialModelCapabilities = Partial<ModelCapabilities>;

export interface ModelPricing {
  /** Cost per 1M input tokens. `null` when the provider does not publish prices. */
  readonly inputPerMillion: number | null;
  readonly outputPerMillion: number | null;
  readonly currency: 'USD' | 'CNY' | 'EUR' | 'CREDIT';
}

export interface ModelInfo {
  readonly modelId: string;
  readonly displayName: string;
  /** Hard context limit in tokens (test M). */
  readonly contextWindow: number;
  readonly maxOutputTokens: number | null;
  readonly capabilities: ModelCapabilities;
  readonly pricing: ModelPricing | null;
  /** Opaque provider metadata; never interpreted by Core. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Shape an adapter returns; `normalizeModelInfo` fills the gaps deterministically. */
export interface RawModelInfo {
  readonly modelId: string;
  readonly displayName?: string;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number | null;
  readonly capabilities?: PartialModelCapabilities;
  readonly pricing?: ModelPricing | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/* ------------------------------------------------------------------- messages --- */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ProviderMessage {
  readonly role: MessageRole;
  readonly content: string;
  /** Set when `role === 'tool'`. */
  readonly toolCallId?: string;
  readonly name?: string;
}

/** How the caller wants structured output; Core validates the *contract*, not the schema. */
export interface StructuredOutputContract {
  readonly mode: 'json_object' | 'json_schema';
  /** Required when `mode === 'json_schema'`: a JSON Schema, stored verbatim. */
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly schemaName?: string;
}

/* ---------------------------------------------------------------------- tools --- */

export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/* ------------------------------------------------------------------ invocation --- */

export interface InvocationRequest {
  readonly modelId: string;
  readonly messages: readonly ProviderMessage[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly responseFormat?: StructuredOutputContract;
  readonly tools?: readonly ToolDeclaration[];
  /** Correlation only; never sent to a provider unless an adapter chooses to. */
  readonly traceId?: string;
  /**
   * Cancellation for THIS invocation. Optional by design: a caller that supplies none gets
   * exactly the behavior it had before, so no existing caller changes.
   *
   * When supplied, an adapter MUST propagate it to the underlying model call and MUST end the
   * invocation when it fires — a cancelled invocation is over, whatever the provider thinks.
   * The canonical result of a cancelled invocation is
   * `err(DomainError('CANCELLED', …, { kind: 'CANCELLED' }))`: never a retryable provider
   * error (the caller must not retry it), never a thrown exception, and never a second attempt
   * on another provider or model. An adapter that ignores this signal leaves a ghost
   * execution behind: the caller's record says CANCELLED while the provider still runs.
   */
  readonly signal?: AbortSignal;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Provider-reported cost when available; otherwise `null`. */
  readonly totalCost: number | null;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';

export interface InvocationResult {
  readonly modelId: string;
  readonly providerId: string;
  readonly outputText: string;
  /** Parsed structured output when a contract was requested and satisfied. */
  readonly structured: unknown | null;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: TokenUsage;
  readonly finishReason: FinishReason;
  readonly providerMeta?: Readonly<Record<string, unknown>>;
}

/** One streaming chunk. `done: true` closes the stream and carries the usage. */
export interface StreamChunk {
  readonly deltaText: string;
  readonly toolCallDelta: ToolCall | null;
  readonly done: boolean;
  readonly usage: TokenUsage | null;
}

/* -------------------------------------------------------------------- health --- */

export type HealthStatus = 'healthy' | 'degraded' | 'unavailable';

export interface HealthReport {
  readonly status: HealthStatus;
  readonly checkedAt: string;
  readonly latencyMs: number | null;
  readonly detail: string | null;
}

/* --------------------------------------------------------------------- errors --- */

export const PROVIDER_ERROR_KINDS = [
  'rate_limited',
  'quota_exhausted',
  'timeout',
  'context_limit',
  'auth_failed',
  'invalid_request',
  'tool_unsupported',
  'structured_output_unsupported',
  'streaming_unsupported',
  'unavailable',
  'content_filtered',
  'unknown',
] as const;

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/** Providers throw their own shapes; this is the only shape the rest of the app sees. */
export interface NormalizedProviderError {
  readonly kind: ProviderErrorKind;
  /** Redacted, human-readable message - safe for logs, events and error details. */
  readonly message: string;
  /** Milliseconds the caller should wait, when the provider said so. */
  readonly retryAfterMs: number | null;
  /** Provider's own code, when it exposes one (never a secret). */
  readonly upstreamCode: string | null;
  readonly retryable: boolean;
  readonly providerId: string | null;
}

/* ------------------------------------------------------------------- registry --- */

export interface ModelProviderDescriptor {
  readonly providerId: string;
  /** Adapter family chosen by the composition root (never rendered in Core logic). */
  readonly kind: string;
  readonly displayName: string;
  readonly version: string;
}

/** What the registry persists so a restart can rebind the same provider ids (test O). */
export interface ProviderRegistration {
  /** `EntityStore` key - identical to `providerId`, kept explicit for the store contract. */
  readonly id: string;
  readonly providerId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly lastHealth: HealthReport | null;
  readonly registeredAt: string;
  readonly updatedAt: string;
}

/** A persisted model-catalogue row (so the UI can list models without a live call). */
export interface ProviderModelRecord {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number | null;
  readonly capabilities: ModelCapabilities;
  readonly pricing: ModelPricing | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

/** A provider adapter: one object per concrete implementation, holding no global state. */
export interface ModelProviderPort {
  describe(): ModelProviderDescriptor;
  /**
   * F2 closure: the catalogue call accepts the CALLER cancellation. An invocation
   * deadline must be able to terminate a hung /models preflight — a provider that
   * ignores the signal keeps its own default (no deadline), so honoring it is part
   * of this contract. Optional so existing adapters keep compiling.
   */
  listModels(signal?: AbortSignal): Promise<Result<readonly RawModelInfo[], DomainError>>;
  health(): Promise<Result<HealthReport, DomainError>>;
  /**
   * Invoke a model ONCE. `request.signal` (see `InvocationRequest`) is the cancellation the
   * caller supplied: honoring it is part of this contract, not an optional courtesy.
   */
  invoke(request: InvocationRequest): Promise<Result<InvocationResult, DomainError>>;
  /** Streaming capability is declared per model; callers must check `capabilities.streaming`. */
  stream(request: InvocationRequest): AsyncIterable<Result<StreamChunk, DomainError>>;
  /** Secret references this adapter needs resolved before use. */
  secretRefs?(): readonly SecretRef[];
}

export interface ProviderSelection {
  readonly providerId: string;
  /** Who is asking. Required once an authorization policy is wired (Sprint 7). */
  readonly actorId?: string;
}

/** The registry contract: explicit ids only - no ranking, no routing, no fallback. */
export interface ProviderRegistryPort {
  register(
    provider: ModelProviderPort,
    options?: { readonly enabled?: boolean; readonly actorId?: string },
  ): Promise<Result<ProviderRegistration, DomainError>>;
  unregister(
    providerId: string,
    options?: { readonly actorId?: string },
  ): Promise<Result<boolean, DomainError>>;
  get(providerId: string): ModelProviderPort | null;
  list(): Promise<readonly ProviderRegistration[]>;
  models(providerId: string, options?: { readonly signal?: AbortSignal }): Promise<Result<readonly ModelInfo[], DomainError>>;
  health(
    providerId: string,
    options?: { readonly actorId?: string },
  ): Promise<Result<HealthReport, DomainError>>;
  invoke(
    selection: ProviderSelection,
    request: InvocationRequest,
  ): Promise<Result<InvocationResult, DomainError>>;
  stream(
    selection: ProviderSelection,
    request: InvocationRequest,
  ): AsyncIterable<Result<StreamChunk, DomainError>>;
}
