/**
 * The REAL CompanyOS-native ModelProviderPort adapter (Boss V1 Product Reachability,
 * BB-002). Speaks the OpenAI-compatible HTTP chat-completions dialect as an ADAPTER
 * PROTOCOL — a protocol choice, NOT a vendor dependency: baseUrl, model id, timeout
 * and credentials are deployment configuration, so compatible backends include any
 * remote provider, self-hosted endpoint or local gateway that implements the dialect.
 *
 * Frozen-contract fidelity (docs/bug-bash/BB002_REAL_MODEL_PROVIDER_RECON.md):
 *   - reasoning-only: `tools` is NEVER sent; a caller declaring any gets a typed
 *     `tool_unsupported` refusal BEFORE any network call (no tool side effects);
 *   - stateless: one HTTP request per invoke; no conversation/session handle is
 *     created or surfaced; upstream ids live in `providerMeta` (diagnostic) only;
 *   - structured output fail-loud: a requested responseFormat must yield parseable
 *     JSON or the invocation fails typed — never repaired, never mocked;
 *   - credentials: a SecretRef POINTER (env) declared via `secretRefs()`; the value
 *     is resolved in memory by the composition-injected resolver and never persists;
 *   - cancellation/timeout: the caller's signal is honored (`CANCELLED`), the
 *     configured timeout bounds every request (`timeout`), HTTP statuses map to the
 *     frozen error taxonomy (401/403→auth_failed, 429→rate_limited, 5xx→unavailable,
 *     400→invalid_request).
 */
import {
  DomainError,
  domainError,
  err,
  normalizeProviderError,
  ok,
  providerErrorToDomainError,
  type HealthReport,
  type InvocationRequest,
  type InvocationResult,
  type ModelProviderDescriptor,
  type ModelProviderPort,
  type ProviderMessage,
  type RawModelInfo,
  type Result,
  type SecretRef,
  type StreamChunk,
} from '@companyos/core';
import { canRunGoals, classifyUpstreamModel } from './model-modality.js';
import { reportedCachedInputTokens } from './provider-usage.js';

/** The typed deployment configuration of this adapter (validated, non-secret fields only). */
export interface OpenAiCompatibleConfig {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly apiKeyEnv: string;
  /**
   * H15c-fix10 — the deployment's declared per-request output ceiling (max_tokens) for
   * the env profile and the embedded kernel route. Optional env COS_MODEL_MAX_OUTPUT_TOKENS
   * (integer 256..32768; absent = 8192). The financial admission bound is priced from it,
   * (32768 stays well inside the documented deepseek-flash maximum output of 384K tokens,
   * https://api-docs.deepseek.com/quick_start/pricing — the bound is CompanyOS's, not the model's),
   * so an operator with a small budget can declare a smaller ceiling instead of a call
   * count that cannot finish a real task.
   */
  readonly maxOutputTokens?: number;
  /**
   * H10b — the endpoint's EXPLICIT structured-output contract (deployment value, never
   * guessed from the URL). 'json_schema' (default) sends OpenAI json_schema; 'json_object'
   * is for endpoints that only accept {type:'json_object'} (e.g. DeepSeek): the schema then
   * rides as a system instruction and the caller still validates the parsed output.
   */
  readonly structuredOutput?: 'json_schema' | 'json_object';
  /**
   * LIVE-CONTRACT-FILL (hark-live-goal 42085454360) — the deployment's EXPLICIT thinking
   * control for the control-plane calls (planner / supervisor), env COS_MODEL_THINKING.
   * A reasoning model with thinking on by default spends its reasoning out of the SAME
   * max_tokens as the answer: the planner of a real goal reasoned through the whole
   * 4096-token ceiling and returned no answer at all. 'disabled' sends
   * {thinking:{type:'disabled'}} (the whole ceiling is the JSON answer); 'low' / 'high'
   * send thinking enabled with that reasoning_effort. Absent = nothing is sent (the
   * endpoint's own default) — never guessed from the URL.
   */
  readonly thinking?: 'disabled' | 'low' | 'high';
  /**
   * SMART-ROUTER-PROD-01 — the deployment's EXPLICIT product routing configuration.
   * `routingMode`/`routingPolicy` are optional (absent = the product default
   * DETERMINISTIC_V1 / BALANCED). `routingTraits` is all-or-nothing: the operator
   * declares the live profile's ordinal tiers or leaves them absent (legal only
   * under DETERMINISTIC_V1 — the composition fails closed otherwise). Never guessed.
   */
  readonly routingMode?: 'DETERMINISTIC_V1' | 'SMART_ROUTER_V1';
  /**
   * PROD-01C — the endpoint's EXPLICIT authentication contract (never guessed from
   * the URL; localhost is NOT implicitly no-auth). REQUIRED is the default and keeps
   * COMPANYOS_MODEL_API_KEY mandatory; NONE declares a no-auth endpoint (a
   * COMPANYOS_MODEL_API_KEY then present alongside NONE is a typed invalid config —
   * a configured secret is never silently ignored).
   */
  readonly authentication?: 'REQUIRED' | 'NONE';
  readonly routingPolicy?: 'QUALITY_FIRST' | 'BALANCED' | 'COST_AWARE';
  readonly routingTraits?: {
    readonly qualityTier: 'ECONOMY' | 'BALANCED' | 'STRONG' | 'PREMIUM';
    readonly costTier: 'LOW' | 'MEDIUM' | 'HIGH';
    readonly latencyTier: 'FAST' | 'BALANCED' | 'SLOW';
    readonly reliabilityClass: 'STANDARD' | 'HIGH' | 'CRITICAL';
  };
  readonly source: Readonly<Record<string, 'composition' | 'environment' | 'default'>>;
}

/**
 * Deployment env names. NON-secret fields use the COS_MODEL_ prefix (the DSH
 * adapter's non-secret DSH_NODE/DSH_RUNTIME precedent): the COMPANYOS_ prefix is
 * the SecretVault's namespace, so ONLY the api key lives there — a non-secret
 * value in the vault namespace would be classified as secret material and trip
 * the registry's secret-hygiene guard wherever it legitimately appears.
 */
export const MODEL_PROVIDER_ENV = {
  providerId: 'COS_MODEL_PROVIDER_ID',
  baseUrl: 'COS_MODEL_BASE_URL',
  modelId: 'COS_MODEL_ID',
  apiKey: 'COMPANYOS_MODEL_API_KEY',
  timeoutMs: 'COS_MODEL_TIMEOUT_MS',
  maxOutputTokens: 'COS_MODEL_MAX_OUTPUT_TOKENS',
  routingMode: 'COS_MODEL_ROUTING_MODE',
  authentication: 'COS_MODEL_AUTHENTICATION',
  routingPolicy: 'COS_MODEL_ROUTING_POLICY',
  qualityTier: 'COS_MODEL_QUALITY_TIER',
  costTier: 'COS_MODEL_COST_TIER',
  latencyTier: 'COS_MODEL_LATENCY_TIER',
  reliabilityClass: 'COS_MODEL_RELIABILITY_CLASS',
  structuredOutput: 'COS_MODEL_STRUCTURED_OUTPUT',
  thinking: 'COS_MODEL_THINKING',
} as const;

const ROUTING_MODES = ['DETERMINISTIC_V1', 'SMART_ROUTER_V1'] as const;
const AUTHENTICATION_MODES = ['REQUIRED', 'NONE'] as const;
const ROUTING_POLICIES = ['QUALITY_FIRST', 'BALANCED', 'COST_AWARE'] as const;
const QUALITY_TIERS = ['ECONOMY', 'BALANCED', 'STRONG', 'PREMIUM'] as const;
const COST_TIERS = ['LOW', 'MEDIUM', 'HIGH'] as const;
const LATENCY_TIERS = ['FAST', 'BALANCED', 'SLOW'] as const;
const RELIABILITY_CLASSES = ['STANDARD', 'HIGH', 'CRITICAL'] as const;

const oneOf = <T extends string>(allowed: readonly T[]): ((raw: string) => T | undefined) =>
  (raw: string): T | undefined => (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_API_KEY_ENV = MODEL_PROVIDER_ENV.apiKey;

/** Resolve the adapter configuration (composition → environment → absent). Absent = NOT configured (the caller decides fail-loud semantics). */
/** LIVE-CONTRACT-FILL — stable leading text of the two output-ceiling failures (read back by the goal workspace). */
export const PROVIDER_OUTPUT_TRUNCATED_MESSAGE = 'The model output reached the declared max_tokens before the answer was complete';
export const PROVIDER_REASONING_EXHAUSTED_MESSAGE = 'The model spent the declared max_tokens on reasoning and returned no answer';

export const resolveOpenAiCompatibleConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<OpenAiCompatibleConfig | null, DomainError> => {
  const baseUrl = env[MODEL_PROVIDER_ENV.baseUrl]?.trim() ?? '';
  const modelId = env[MODEL_PROVIDER_ENV.modelId]?.trim() ?? '';
  if (baseUrl === '' && modelId === '') return ok(null); // not configured — legal absence
  if (baseUrl === '' || modelId === '') {
    return err(
      domainError('VALIDATION_FAILED', 'The model adapter configuration is incomplete: COS_MODEL_BASE_URL and COS_MODEL_ID must be set together.', {
        reason: 'MODEL_CONFIG_INCOMPLETE',
      }),
    );
  }
  if (!/^https?:\/\//u.test(baseUrl)) {
    return err(
      domainError('VALIDATION_FAILED', 'COS_MODEL_BASE_URL must be an http(s) URL.', {
        reason: 'MODEL_CONFIG_INVALID',
      }),
    );
  }
  const timeoutRaw = env[MODEL_PROVIDER_ENV.timeoutMs]?.trim() ?? '';
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutRaw !== '') {
    const parsed = Number(timeoutRaw);
    if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 3_600_000) {
      return err(
        domainError('VALIDATION_FAILED', 'COS_MODEL_TIMEOUT_MS must be an integer between 1000 and 3600000.', {
          reason: 'MODEL_CONFIG_INVALID',
        }),
      );
    }
    timeoutMs = parsed;
  }
  const maxOutRaw = env[MODEL_PROVIDER_ENV.maxOutputTokens]?.trim() ?? '';
  let maxOutputTokens: number | undefined;
  if (maxOutRaw !== '') {
    const parsed = Number(maxOutRaw);
    if (!Number.isInteger(parsed) || parsed < 256 || parsed > 32_768) {
      return err(domainError('VALIDATION_FAILED', 'COS_MODEL_MAX_OUTPUT_TOKENS must be an integer between 256 and 32768.', { reason: 'MODEL_CONFIG_INVALID' }));
    }
    maxOutputTokens = parsed;
  }
  const structuredRaw = env[MODEL_PROVIDER_ENV.structuredOutput]?.trim() ?? '';
  const structuredOutput = structuredRaw === '' ? undefined : oneOf(['json_schema', 'json_object'] as const)(structuredRaw);
  if (structuredRaw !== '' && structuredOutput === undefined) {
    return err(domainError('VALIDATION_FAILED', 'COS_MODEL_STRUCTURED_OUTPUT must be json_schema or json_object.', { reason: 'MODEL_CONFIG_INVALID' }));
  }
  const thinkingRaw = env[MODEL_PROVIDER_ENV.thinking]?.trim() ?? '';
  const thinking = thinkingRaw === '' ? undefined : oneOf(['disabled', 'low', 'high'] as const)(thinkingRaw);
  if (thinkingRaw !== '' && thinking === undefined) {
    return err(domainError('VALIDATION_FAILED', 'COS_MODEL_THINKING must be disabled, low or high.', { reason: 'MODEL_CONFIG_INVALID' }));
  }
  // SMART-ROUTER-PROD-01: the explicit routing configuration. Every value is
  // validated loudly — an invalid or PARTIAL configuration is a config error,
  // never a silently guessed default (no invisible behavior).
  const modeRaw = env[MODEL_PROVIDER_ENV.routingMode]?.trim() ?? '';
  let routingMode: OpenAiCompatibleConfig['routingMode'];
  if (modeRaw !== '') {
    routingMode = oneOf(ROUTING_MODES)(modeRaw);
    if (routingMode === undefined) {
      return err(
        domainError('VALIDATION_FAILED', `COS_MODEL_ROUTING_MODE must be one of ${ROUTING_MODES.join(', ')} (got "${modeRaw}").`, {
          reason: 'MODEL_CONFIG_INVALID',
        }),
      );
    }
  }
  const authRaw = env[MODEL_PROVIDER_ENV.authentication]?.trim() ?? '';
  let authentication: OpenAiCompatibleConfig['authentication'];
  if (authRaw !== '') {
    authentication = oneOf(AUTHENTICATION_MODES)(authRaw);
    if (authentication === undefined) {
      return err(
        domainError('VALIDATION_FAILED', `COS_MODEL_AUTHENTICATION must be one of ${AUTHENTICATION_MODES.join(', ')} (got "${authRaw}").`, {
          reason: 'MODEL_CONFIG_INVALID',
        }),
      );
    }
    if (authentication === 'NONE' && (env[MODEL_PROVIDER_ENV.apiKey] ?? '').trim() !== '') {
      return err(
        domainError('VALIDATION_FAILED', 'COS_MODEL_AUTHENTICATION=NONE is incompatible with a configured COMPANYOS_MODEL_API_KEY: remove the key or declare REQUIRED.', {
          reason: 'MODEL_CONFIG_INVALID',
        }),
      );
    }
  }
  const policyRaw = env[MODEL_PROVIDER_ENV.routingPolicy]?.trim() ?? '';
  let routingPolicy: OpenAiCompatibleConfig['routingPolicy'];
  if (policyRaw !== '') {
    routingPolicy = oneOf(ROUTING_POLICIES)(policyRaw);
    if (routingPolicy === undefined) {
      return err(
        domainError('VALIDATION_FAILED', `COS_MODEL_ROUTING_POLICY must be one of ${ROUTING_POLICIES.join(', ')} (got "${policyRaw}").`, {
          reason: 'MODEL_CONFIG_INVALID',
        }),
      );
    }
  }
  const traitRaw = {
    qualityTier: env[MODEL_PROVIDER_ENV.qualityTier]?.trim() ?? '',
    costTier: env[MODEL_PROVIDER_ENV.costTier]?.trim() ?? '',
    latencyTier: env[MODEL_PROVIDER_ENV.latencyTier]?.trim() ?? '',
    reliabilityClass: env[MODEL_PROVIDER_ENV.reliabilityClass]?.trim() ?? '',
  };
  const traitCount = Object.values(traitRaw).filter((value) => value !== '').length;
  if (traitCount > 0 && traitCount < 4) {
    return err(
      domainError(
        'VALIDATION_FAILED',
        'Routing traits are all-or-nothing: set all of COS_MODEL_QUALITY_TIER, COS_MODEL_COST_TIER, COS_MODEL_LATENCY_TIER and COS_MODEL_RELIABILITY_CLASS, or none.',
        {reason: 'MODEL_ROUTING_PROFILE_INCOMPLETE', present: traitCount},
      ),
    );
  }
  let routingTraits: OpenAiCompatibleConfig['routingTraits'];
  if (traitCount === 4) {
    const qualityTier = oneOf(QUALITY_TIERS)(traitRaw.qualityTier);
    const costTier = oneOf(COST_TIERS)(traitRaw.costTier);
    const latencyTier = oneOf(LATENCY_TIERS)(traitRaw.latencyTier);
    const reliabilityClass = oneOf(RELIABILITY_CLASSES)(traitRaw.reliabilityClass);
    if (qualityTier === undefined || costTier === undefined || latencyTier === undefined || reliabilityClass === undefined) {
      return err(
        domainError('VALIDATION_FAILED', 'A routing trait is not a legal tier value (see COS_MODEL_QUALITY_TIER / COST / LATENCY / RELIABILITY contracts).', {
          reason: 'MODEL_CONFIG_INVALID',
        }),
      );
    }
    routingTraits = {qualityTier, costTier, latencyTier, reliabilityClass};
  }
  return ok({
    providerId: env[MODEL_PROVIDER_ENV.providerId]?.trim() || 'model.openai-compatible',
    baseUrl: baseUrl.replace(/\/+$/u, ''),
    modelId,
    timeoutMs,
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    ...(maxOutputTokens === undefined ? {} : {maxOutputTokens}),
    ...(routingMode === undefined ? {} : {routingMode}),
    ...(structuredOutput === undefined ? {} : {structuredOutput}),
    ...(thinking === undefined ? {} : {thinking}),
    ...(authentication === undefined ? {} : {authentication}),
    ...(routingPolicy === undefined ? {} : {routingPolicy}),
    ...(routingTraits === undefined ? {} : {routingTraits}),
    source: {
      baseUrl: env[MODEL_PROVIDER_ENV.baseUrl] === undefined ? 'default' : 'environment',
      modelId: env[MODEL_PROVIDER_ENV.modelId] === undefined ? 'default' : 'environment',
    },
  });
};

/**
 * The normalized typed error for this adapter — ALWAYS through the Core
 * normalization path (frozen code mapping, redaction, retryable classification).
 */
const providerFailure = (
  kind: Parameters<typeof normalizeProviderError>[0]['kind'],
  message: string,
  over: Partial<{ readonly retryAfterMs: number | null; readonly upstreamCode: string | null; readonly providerId: string | null }> = {},
): DomainError =>
  providerErrorToDomainError(
    normalizeProviderError({
      kind,
      message,
      providerId: over.providerId ?? null,
      retryAfterMs: over.retryAfterMs ?? null,
      upstreamCode: over.upstreamCode ?? null,
    }),
  );

export interface OpenAiCompatibleDeps {
  readonly config: OpenAiCompatibleConfig;
  /** In-memory secret resolution (the composition's vault); never a raw value in config. */
  readonly resolveSecret: (ref: SecretRef) => Promise<string | null>;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const toWireMessages = (messages: readonly ProviderMessage[]): readonly { readonly role: string; readonly content: string }[] =>
  messages.map((message) => ({ role: message.role, content: message.content }));

export const createOpenAiCompatibleProvider = (deps: OpenAiCompatibleDeps): ModelProviderPort => {
  const { config } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const secretRef: SecretRef = {
    id: `${config.providerId}:api-key`,
    providerId: config.providerId,
    purpose: 'api-key',
    source: 'env',
    envName: config.apiKeyEnv,
  };
  const descriptor: ModelProviderDescriptor = {
    providerId: config.providerId,
    kind: 'openai-compatible',
    displayName: 'OpenAI-compatible endpoint',
    version: '1',
  };

  const request = async (
    path: string,
    init: { readonly method: 'GET' | 'POST'; readonly body?: unknown; readonly signal?: AbortSignal },
  ): Promise<{ readonly status: number; readonly json: unknown; readonly retryAfterMs: number | null }> => {
    const apiKey = await deps.resolveSecret(secretRef);
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const signal = init.signal === undefined ? timeoutSignal : AbortSignal.any([init.signal, timeoutSignal]);
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, {
        method: init.method,
        headers: {
          'content-type': 'application/json',
          ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        if (init.signal !== undefined && init.signal.aborted) {
          // The CALLER cancelled — the port contract's exact canonical result.
          throw domainError('CANCELLED', 'The model invocation was cancelled.', { kind: 'CANCELLED' });
        }
        throw providerFailure('timeout', `The model endpoint did not answer within ${String(config.timeoutMs)}ms.`);
      }
      throw providerFailure('unavailable', 'The model endpoint could not be reached.');
    }
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader === null ? null : (Number(retryAfterHeader) * 1000 || null);
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json, retryAfterMs };
  };

  /*
   * AUDIT-E3 (desktop half): an ANSWERED client-error refusal (400/401/403/404/429) is a
   * request the endpoint rejected before doing model work — nothing was generated, so the
   * consumed usage is KNOWN to be zero. Carrying `usageStatus: 'KNOWN'` + zero
   * `observedUsage` lets the Goal budget settle the reservation KNOWN instead of
   * UNKNOWN-at-bound (which blocked every later attempt, including the retry policy's own
   * 429 retries). 5xx/408, timeouts and transport failures stay UNKNOWN: the remote side
   * may have done (and billed) work before failing.
   */
  const knownZeroUsage = (error: DomainError): DomainError =>
    domainError(error.code, error.message, {
      ...error.details,
      usageStatus: 'KNOWN',
      observedUsage: { inputTokens: 0, outputTokens: 0 },
    });
  const mapHttpFailure = (status: number, retryAfterMs: number | null): DomainError => {
    if (status === 401 || status === 403) {
      return knownZeroUsage(providerFailure('auth_failed', 'The model endpoint rejected the credential.', { upstreamCode: String(status) }));
    }
    if (status === 429) {
      return knownZeroUsage(providerFailure('rate_limited', 'The model endpoint is rate limiting requests.', { retryAfterMs, upstreamCode: '429' }));
    }
    if (status === 400) {
      return knownZeroUsage(providerFailure('invalid_request', 'The model endpoint rejected the request.', { upstreamCode: '400' }));
    }
    if (status === 404) {
      return knownZeroUsage(providerFailure('invalid_request', 'The model endpoint or model was not found.', { upstreamCode: '404' }));
    }
    return providerFailure('unavailable', `The model endpoint answered HTTP ${String(status)}.`, { upstreamCode: String(status) });
  };

  return {
    describe: () => descriptor,
    secretRefs: () => [secretRef],

    async listModels(signal?: AbortSignal): Promise<Result<readonly RawModelInfo[], DomainError>> {
      try {
        // F2 closure: the catalogue call carries the CALLER cancellation — a hung /models
        // preflight must die with the invocation deadline as CANCELLED (non-retryable),
        // never as a retryable timeout that multiplies the hang.
        const { status, json } = await request('/models', { method: 'GET', ...(signal === undefined ? {} : { signal }) });
        if (status !== 200) return err(mapHttpFailure(status, null));
        const data = (json as { readonly data?: readonly { readonly id?: unknown }[] } | null)?.data;
        if (!Array.isArray(data)) {
          return err(providerFailure('invalid_request', 'The /models response was malformed (no data array).'));
        }
        const models: RawModelInfo[] = [];
        for (const entry of data) {
          if (typeof entry?.id !== 'string' || entry.id === '') continue;
          // UI-AUDIT-2: an image/video/embedding/speech model cannot answer a structured text
          // request, so it is not declared structured-output (the registry preflight then
          // refuses it typed as CAPABILITY_MISSING) and its kind is recorded for the selector.
          // The configured chat model is always chat (see model-modality.ts).
          const modality = entry.id === config.modelId ? 'chat' : classifyUpstreamModel(entry as Readonly<Record<string, unknown>>, entry.id);
          models.push({
            modelId: entry.id,
            displayName: entry.id,
            contextWindow: 128_000,
            capabilities: { structuredOutput: canRunGoals(modality) },
            metadata: { modality },
          });
        }
        if (models.length === 0) {
          return err(providerFailure('invalid_request', 'The /models response contained no model ids.'));
        }
        return ok(models);
      } catch (error) {
        if (error instanceof DomainError) return err(error);
        return err(providerFailure('unknown', 'The model listing failed unexpectedly.'));
      }
    },

    async health(): Promise<Result<HealthReport, DomainError>> {
      try {
        const started = Date.now();
        const { status } = await request('/models', { method: 'GET' });
        return ok({
          status: status === 200 ? 'healthy' : status === 401 || status === 403 ? 'degraded' : 'unavailable',
          checkedAt: new Date().toISOString(),
          latencyMs: Date.now() - started,
          detail: status === 200 ? null : `HTTP ${String(status)}`,
        });
      } catch (error) {
        if (error instanceof DomainError) {
          return ok({ status: 'unavailable', checkedAt: new Date().toISOString(), latencyMs: null, detail: error.message });
        }
        return err(providerFailure('unknown', 'The health probe failed unexpectedly.'));
      }
    },

    async invoke(request_: InvocationRequest): Promise<Result<InvocationResult, DomainError>> {
      // §12 reasoning-only: tools are NEVER sent; declaring any fails loud BEFORE any call.
      if (request_.tools !== undefined && request_.tools.length > 0) {
        return err(providerFailure('tool_unsupported', 'The production model adapter is reasoning-only: tool declarations are refused.'));
      }
      const wireBody: Record<string, unknown> = {
        model: request_.modelId,
        messages: toWireMessages(request_.messages),
      };
      if (request_.temperature !== undefined) wireBody['temperature'] = request_.temperature;
      if (request_.maxOutputTokens !== undefined) wireBody['max_tokens'] = request_.maxOutputTokens;
      // LIVE-CONTRACT-FILL: the deployment's explicit thinking control (see config.thinking).
      if (config.thinking === 'disabled') wireBody['thinking'] = { type: 'disabled' };
      else if (config.thinking !== undefined) {
        wireBody['thinking'] = { type: 'enabled' };
        wireBody['reasoning_effort'] = config.thinking;
      }
      if (request_.responseFormat !== undefined) {
        if (request_.responseFormat.mode === 'json_schema' && request_.responseFormat.schema !== undefined && config.structuredOutput === 'json_object') {
          wireBody['response_format'] = { type: 'json_object' };
          wireBody['messages'] = [
            { role: 'system', content: `Respond with ONE json object only, valid against this JSON Schema (named ${request_.responseFormat.schemaName ?? 'companyos_output'}):\n${JSON.stringify(request_.responseFormat.schema)}` },
            ...(wireBody['messages'] as unknown[]),
          ];
        } else if (request_.responseFormat.mode === 'json_schema' && request_.responseFormat.schema !== undefined) {
          wireBody['response_format'] = {
            type: 'json_schema',
            json_schema: {
              name: request_.responseFormat.schemaName ?? 'companyos_output',
              schema: request_.responseFormat.schema,
            },
          };
        } else {
          wireBody['response_format'] = { type: 'json_object' };
        }
      }
      let status: number;
      let json: unknown;
      let retryAfterMs: number | null;
      try {
        const answered = await request('/chat/completions', { method: 'POST', body: wireBody, signal: request_.signal });
        status = answered.status;
        json = answered.json;
        retryAfterMs = answered.retryAfterMs;
      } catch (error) {
        if (error instanceof DomainError) return err(error);
        return err(providerFailure('unknown', 'The model invocation failed unexpectedly.'));
      }
      if (status !== 200) return err(mapHttpFailure(status, retryAfterMs));
      const choice = (json as { readonly choices?: readonly { readonly message?: { readonly content?: unknown; readonly reasoning_content?: unknown }; readonly finish_reason?: unknown }[] } | null)?.choices?.[0];
      const content = choice?.message?.content;
      const reasoned = typeof choice?.message?.reasoning_content === 'string' && choice.message.reasoning_content !== '';
      const finishRaw = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'stop';
      const finishReason: InvocationResult['finishReason'] =
        finishRaw === 'length' ? 'length' : finishRaw === 'content_filter' ? 'content_filter' : 'stop';
      const usageRaw = (json as { readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown } } | null)?.usage;
      const inputTokens = usageRaw?.prompt_tokens;
      const outputTokens = usageRaw?.completion_tokens;
      /*
       * H15d (hark-live-goal 40308697073): an answered call whose CONTENT is unusable still
       * reported real usage — the remote charge is known. The failure carries it as
       * `observedUsage` so the budget settles KNOWN instead of UNKNOWN-at-bound, and an
       * answer cut off by the declared max_tokens is typed PROVIDER_OUTPUT_TRUNCATED (the
       * live cause: a 2048-token ceiling truncated the planner's JSON), never "malformed".
       */
      const usageKnown = typeof inputTokens === 'number' && Number.isSafeInteger(inputTokens) && inputTokens >= 0 &&
        typeof outputTokens === 'number' && Number.isSafeInteger(outputTokens) && outputTokens >= 0;
      // Live contract-fill run 7: the provider-reported prompt-cache share (priced at the proof's cache-hit rate).
      const cachedInputTokens = usageKnown ? reportedCachedInputTokens(usageRaw, inputTokens) : null;
      const cachedPart = cachedInputTokens === null ? {} : { cachedInputTokens };
      const contentFailure = (message: string): DomainError => {
        const truncated = finishReason === 'length';
        // LIVE-CONTRACT-FILL (42085454360): an EMPTY answer cut off by max_tokens after the
        // model reasoned is the reasoning eating the whole ceiling — typed apart from a cut JSON.
        const reasoningExhausted = truncated && reasoned && (typeof content !== 'string' || content === '');
        const failure = providerFailure('invalid_request', reasoningExhausted
          ? `${PROVIDER_REASONING_EXHAUSTED_MESSAGE} (${message})`
          : truncated
            ? `${PROVIDER_OUTPUT_TRUNCATED_MESSAGE} (${message})`
            : message);
        return domainError(failure.code, failure.message, {
          ...failure.details,
          ...(truncated ? { reason: reasoningExhausted ? 'PROVIDER_REASONING_EXHAUSTED' : 'PROVIDER_OUTPUT_TRUNCATED', maxOutputTokens: request_.maxOutputTokens ?? null } : {}),
          ...(usageKnown ? { usageStatus: 'KNOWN', observedUsage: { inputTokens, outputTokens, ...cachedPart } } : { usageStatus: 'UNKNOWN' }),
        });
      };
      if (typeof content !== 'string' || content === '') {
        return err(contentFailure('The model response contained no message content.'));
      }
      let structured: unknown = null;
      if (request_.responseFormat !== undefined) {
        try {
          structured = JSON.parse(content);
        } catch {
          // §14 fail-loud: malformed structured output NEVER becomes business truth.
          return err(contentFailure('The model returned malformed structured output (unparseable JSON).'));
        }
      }
      // Preserve output-contract failures above. A valid answer still cannot
      // settle as success with invented usage. This error is non-retryable:
      // the remote invocation may already have incurred a charge.
      if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
          typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
        const failure = providerFailure('invalid_request', 'The model returned missing or invalid token usage; consumed usage remains unknown.');
        return err(domainError(failure.code, failure.message, {
          ...failure.details, reason: 'PROVIDER_USAGE_UNKNOWN', usageStatus: 'UNKNOWN',
        }));
      }
      return ok({
        modelId: request_.modelId,
        providerId: config.providerId,
        outputText: content,
        structured,
        toolCalls: [],
        usage: {
          inputTokens,
          outputTokens,
          totalCost: null,
          ...cachedPart,
        },
        finishReason,
        providerMeta: { protocol: 'openai-compatible' },
      });
    },

    stream(request_: InvocationRequest): AsyncIterable<Result<StreamChunk, DomainError>> {
      // Streaming is not declared by this adapter (capabilities.streaming=false at
      // registration); the port requires the method to exist — it fails loud.
      void request_;
      const failure = providerFailure('streaming_unsupported', 'The production model adapter does not stream in V1.');
      return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: err(failure) as never }) }) };
    },
  };
};
