/**
 * Port: model access — CONTRACT ONLY.
 *
 * Sprint 0 intentionally ships no implementation, no router and no provider
 * adapter (the execution directive forbids 提前开发 Model Router / 多模型调度).
 * The concrete router and provider adapters arrive in Sprint 7 (P2) and live in
 * the outer ring, behind this port. `packages/core/tests/sprint0-guardrails.test.ts`
 * fails the build if an implementation is ever added here.
 */

export type ModelCapability =
  | 'text.reasoning'
  | 'text.fast'
  | 'code.generation'
  | 'image.generation'
  | 'speech.synthesis'
  | 'embedding';

export interface ModelRequest {
  readonly capability: ModelCapability;
  readonly messages: readonly ModelMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: 'text' | 'json';
}

export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
}

export interface ModelResponse {
  readonly providerId: string;
  readonly modelId: string;
  readonly text: string;
  readonly usage: { readonly tokensIn: number; readonly tokensOut: number };
  readonly costUsd: number;
  readonly latencyMs: number;
}

export interface ModelGateway {
  readonly providers: readonly ProviderDescriptor[];
  complete(request: ModelRequest, options?: { readonly traceId?: string }): Promise<ModelResponse>;
}

export interface ProviderDescriptor {
  readonly providerId: string;
  readonly capabilities: readonly ModelCapability[];
  readonly local: boolean;
}
