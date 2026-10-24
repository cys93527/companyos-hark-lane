/**
 * Provider-neutral token budget gate (Sprint 19 / Task-19-02 §25-§27, hardened by the
 * T19-02 corrective ruling A/A2/A4).
 *
 * KERNEL ONLY — deliberately NOT wired into AgentRuntime or any provider invocation; that
 * integration belongs to T19-03.
 *
 * TOKEN ESTIMATOR CONTRACT (corrective ruling A): this is a PROVIDER-NEUTRAL CONSERVATIVE
 * FALLBACK ESTIMATE — NOT exact provider tokenization. It may OVERESTIMATE (false rejection
 * is acceptable); it must never UNDERESTIMATE (false acceptance is not). The generic fallback
 * is deliberately pessimistic: one UTF-8 byte counts as one token. Every mainstream tokenizer
 * — including byte-level BPE, which is the worst case — produces AT MOST one token per input
 * byte, so a per-byte count can never underestimate under this contract. (The previous
 * bytes÷3 rule was withdrawn: a CJK character is 3 bytes but can tokenize to more than one
 * token, and punctuation runs can explode to one token per byte.)
 *
 * FRAMING CONTRACT (ruling A2): the estimator sees ONE string. The runtime that integrates
 * this kernel in T19-03 MUST pass the COMPLETE rendered request — message texts, role labels,
 * tool descriptors, responseFormat schemas and any other framing — or supply the equivalent
 * as `additionalFramingTokens`. No known request component may be silently ignored.
 */
import { domainError, err, ok, type DomainError, type Result } from '@companyos/core';
import { utf8ByteLength } from '@companyos/core';

/** The fixed safety margin subtracted from the window before any reservation (§27). */
export const FIXED_SAFETY_MARGIN_TOKENS = 256;

/**
 * The generic provider-neutral fallback: one UTF-8 byte = one token, deliberately
 * pessimistic. Deterministic; documented as NOT exact provider tokenization.
 */
export const estimateInputTokensUpperBound = (
  renderedText: string,
  additionalFramingTokens = 0,
): number => utf8ByteLength(renderedText) + Math.max(0, Math.floor(additionalFramingTokens));

export interface TokenBudgetInput {
  /** The pinned model's catalogue context window, in tokens. */
  readonly contextWindowTokens: number;
  /** Output tokens the caller wants to reserve (must be ≥ 0). */
  readonly reservedOutputTokens: number;
  /**
   * The COMPLETE rendered request text whose input cost is being budgeted (see the framing
   * contract above), or its text body plus `additionalFramingTokens` for the rest.
   */
  readonly renderedText: string;
  /**
   * Explicit extra input tokens for request framing the caller rendered separately (tool
   * descriptors, responseFormat schema, role labels). Never negative; rounded down.
   */
  readonly additionalFramingTokens?: number;
}

export interface TokenBudgetDecision {
  /** The deterministic conservative fallback estimate of the rendered input. */
  readonly estimatedInputTokens: number;
  /** contextWindow − reservedOutput − fixedSafetyMargin; never negative (impossible ⇒ error). */
  readonly allowedInputTokens: number;
  readonly withinBudget: boolean;
}

/** Reject impossible configurations (§27): non-positive window, negative reservation, or a
 *  reservation larger than the window minus the safety margin. */
export const validateBudgetConfiguration = (input: {
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
}): Result<true, DomainError> => {
  if (!Number.isFinite(input.contextWindowTokens) || input.contextWindowTokens <= 0) {
    return err(
      domainError('VALIDATION_FAILED', 'The model context window must be a positive number.', {
        reason: 'SESSION_TOKEN_WINDOW_INVALID',
        contextWindowTokens: input.contextWindowTokens,
      }),
    );
  }
  if (input.reservedOutputTokens < 0) {
    return err(
      domainError('VALIDATION_FAILED', 'The reserved output tokens cannot be negative.', {
        reason: 'SESSION_TOKEN_RESERVATION_INVALID',
        reservedOutputTokens: input.reservedOutputTokens,
      }),
    );
  }
  if (
    input.contextWindowTokens - input.reservedOutputTokens - FIXED_SAFETY_MARGIN_TOKENS <=
    0
  ) {
    return err(
      domainError(
        'VALIDATION_FAILED',
        'The token budget is impossible: the window cannot cover the reservation and the safety margin.',
        {
          reason: 'SESSION_TOKEN_BUDGET_IMPOSSIBLE',
          contextWindowTokens: input.contextWindowTokens,
          reservedOutputTokens: input.reservedOutputTokens,
          safetyMargin: FIXED_SAFETY_MARGIN_TOKENS,
        },
      ),
    );
  }
  return ok(true);
};

/**
 * The V1 fail-closed rule (§25/§28): if the conservative estimate exceeds the allowed input
 * budget, the decision is REFUSED — never truncated, never silently dropped, never retried.
 */
export const decideTokenBudget = (
  input: TokenBudgetInput,
): Result<TokenBudgetDecision, DomainError> => {
  const configured = validateBudgetConfiguration({
    contextWindowTokens: input.contextWindowTokens,
    reservedOutputTokens: input.reservedOutputTokens,
  });
  if (!configured.ok) return configured;
  const estimatedInputTokens = estimateInputTokensUpperBound(
    input.renderedText,
    input.additionalFramingTokens ?? 0,
  );
  const allowedInputTokens =
    input.contextWindowTokens - input.reservedOutputTokens - FIXED_SAFETY_MARGIN_TOKENS;
  const withinBudget = estimatedInputTokens <= allowedInputTokens;
  if (!withinBudget) {
    return err(
      domainError(
        'VALIDATION_FAILED',
        'The rendered request exceeds the allowed input token budget; refusing before any provider invocation.',
        {
          reason: 'SESSION_TOKEN_BUDGET_EXCEEDED',
          estimatedInputTokens,
          allowedInputTokens,
          contextWindowTokens: input.contextWindowTokens,
          reservedOutputTokens: input.reservedOutputTokens,
          safetyMargin: FIXED_SAFETY_MARGIN_TOKENS,
        },
      ),
    );
  }
  return ok({ estimatedInputTokens, allowedInputTokens, withinBudget: true });
};
