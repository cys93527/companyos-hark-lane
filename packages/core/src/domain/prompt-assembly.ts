/**
 * Deterministic Prompt Assembly (Sprint 8 §六).
 *
 * Same input -> byte-identical output, always. There is no randomness, no clock, no IO, no
 * model lookup, no benchmark lookup and no fallback: the assembler is handed a model binding
 * and turns a context into an `InvocationRequest` for THAT model.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import { contextSummary, type AgentContext } from './agent-context.js';
import type { ToolDescriptor } from './tool.js';

export const PROMPT_TEMPLATE_VERSION = 'agent-prompt/v2';

export interface PromptAssemblyInput {
  readonly context: AgentContext;
  /** Limits the caller allows for this attempt (never chosen by the assembler). */
  readonly maxOutputTokens?: number | null;
  /** Whether the caller wants structured output, and at which top-level keys. */
  readonly structuredKeys?: readonly string[];
  /** Declared tools by NAME (legacy, kept for compatibility). */
  readonly tools?: readonly string[];
  /**
   * Sprint 9.1 §五: the REAL tool descriptors a caller declared. Only the fields a model needs
   * are projected into the plan: an adapter reference, a permission list or a secret never is.
   */
  readonly toolDescriptors?: readonly ToolDescriptor[];
  /**
   * Role-level system preamble. Defaults to a deterministic neutral text so a missing
   * preamble cannot change the request shape.
   */
  readonly rolePreamble?: string | null;
}

/** A defensive, JSON-compatible deep copy. Used so a caller cannot mutate a built plan. */
export function cloneJsonValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => cloneJsonValue(entry)) as unknown as T;
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) copy[key] = cloneJsonValue(source[key]);
  return copy as unknown as T;
}

/**
 * Recursively freeze a JSON-compatible value. Combined with `cloneJsonValue` this gives the
 * PromptPlan an immutable snapshot: later mutation of the caller's schema cannot change a plan
 * that was already produced (Sprint 9.1.2 §二).
 */
export function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreezeJson((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/** What a model is told about a tool: name, purpose, input shape (+ 2 informational fields). */
export interface PromptToolDescriptor {
  readonly toolId: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly capabilities: readonly string[];
  readonly riskLevel: string;
}

export interface PromptPlan {
  readonly templateVersion: string;
  readonly system: string;
  readonly user: string;
  readonly modelKey: string;
  readonly providerId: string;
  readonly providerModelId: string;
  readonly maxOutputTokens: number | null;
  readonly structuredKeys: readonly string[];
  readonly tools: readonly string[];
  /** The structured descriptors behind `tools` (Sprint 9.1). */
  readonly toolDescriptors: readonly PromptToolDescriptor[];
  /** Stable hash of everything above: two identical plans share it (test K/L). */
  readonly promptHash: string;
}

const DEFAULT_PREAMBLE =
  'You are an agent of a workflow system. Produce the deliverable requested by the objective. Follow the constraints exactly.';

/** 64-bit FNV-1a over the canonical string: cheap, stable, dependency-free. */
export function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Canonical rendering: fixed section order, no timestamps, no locale-dependent sorting. */
export function canonicalPromptBody(context: AgentContext): string {
  return contextSummary(context);
}

export function assemblePrompt(input: PromptAssemblyInput): Result<PromptPlan, DomainError> {
  const { context } = input;
  if (context.modelBinding.modelKey.trim().length === 0) {
    // The assembler never picks a model (Sprint 8 §一).
    return err(
      domainError('MODEL_SELECTION_REQUIRED', 'Prompt assembly requires an explicit model binding.', {
        executionId: context.trace.executionId,
      }),
    );
  }
  if (input.maxOutputTokens !== undefined && input.maxOutputTokens !== null && input.maxOutputTokens <= 0) {
    return err(
      domainError('VALIDATION_FAILED', 'maxOutputTokens must be positive when set.', {
        maxOutputTokens: input.maxOutputTokens,
      }),
    );
  }

  const system = input.rolePreamble ?? DEFAULT_PREAMBLE;
  const user = canonicalPromptBody(context);
  const structuredKeys = Object.freeze([...(input.structuredKeys ?? [])]);
  const tools = Object.freeze([...(input.tools ?? [])]);
  const maxOutputTokens = input.maxOutputTokens ?? null;

  /**
   * Projection (Sprint 9.1 §五): ONLY what a model needs. No adapterRef, no
   * requiredAuthorities, no secret, no credential - and sorted by toolId so the plan (and its
   * hash) never depends on input order.
   */
  const toolDescriptors: PromptToolDescriptor[] = [...(input.toolDescriptors ?? [])]
    .map((descriptor) =>
      deepFreezeJson({
        toolId: descriptor.toolId,
        name: descriptor.name,
        description: descriptor.description,
        // Immutable snapshot: the caller keeps ownership of its own schema object.
        parameters: cloneJsonValue(descriptor.parameters),
        capabilities: Object.freeze([...descriptor.capabilities].sort()),
        riskLevel: descriptor.riskLevel,
      }),
    )
    .sort((left, right) => (left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0));

  const promptHash = stableHash(
    [
      PROMPT_TEMPLATE_VERSION,
      context.trace.executionId,
      context.trace.attempt,
      system,
      user,
      maxOutputTokens === null ? 'none' : String(maxOutputTokens),
      structuredKeys.join(','),
      tools.join(','),
      JSON.stringify(toolDescriptors),
    ].join('\u0000'),
  );

  return ok({
    templateVersion: PROMPT_TEMPLATE_VERSION,
    system,
    user,
    modelKey: context.modelBinding.modelKey,
    providerId: context.modelBinding.providerId,
    providerModelId: context.modelBinding.providerModelId,
    maxOutputTokens,
    structuredKeys,
    tools,
    toolDescriptors,
    promptHash,
  });
}

/**
 * The prompt plan as a provider request. Note what is NOT here: nothing chooses the model,
 * nothing consults the registry's catalogue order, and nothing reads benchmark metadata.
 */
export interface PromptMessages {
  readonly messages: readonly { readonly role: 'system' | 'user'; readonly content: string }[];
  readonly responseFormat: {
    readonly mode: 'json_schema';
    readonly schema: Readonly<Record<string, unknown>>;
    readonly schemaName: string;
  } | null;
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  }[];
}

export function toMessages(plan: PromptPlan): PromptMessages {
  return {
    messages: [
      { role: 'system', content: plan.system },
      { role: 'user', content: plan.user },
    ],
    responseFormat:
      plan.structuredKeys.length === 0
        ? null
        : {
            mode: 'json_schema',
            schemaName: 'agent_result',
            schema: {
              type: 'object',
              properties: Object.fromEntries(plan.structuredKeys.map((key) => [key, { type: 'string' }])),
              required: [...plan.structuredKeys],
              additionalProperties: true,
            },
          },
    tools:
      plan.toolDescriptors.length > 0
        ? // Real descriptors: the model sees the true purpose and input schema.
          plan.toolDescriptors.map((descriptor) => ({
            name: descriptor.name,
            description: descriptor.description,
            parameters: descriptor.parameters,
          }))
        : plan.tools.map((name) => ({
            name,
            description: `Tool declared by the caller: ${name}`,
            parameters: { type: 'object', additionalProperties: true },
          })),
  };
}
