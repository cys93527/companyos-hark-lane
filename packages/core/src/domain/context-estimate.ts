/**
 * Context estimation (Sprint 7, closing the Sprint 6 debt).
 *
 * `chars / 4` is an English-prose heuristic: it underestimates CJK by roughly 4x and
 * emoji/Hangul by more, which made the pre-flight context check bypassable with a long
 * Chinese prompt. This module counts by character class and is deliberately
 * **conservative** (it rounds each class up), so the check errs on the side of refusing.
 *
 * It is still an estimate: there is no vendor tokenizer in Core (and there never will be).
 * Adapters MUST re-check against the provider's own limit; `conservative: true` is how a
 * caller knows the number is an upper bound, not a measurement.
 */
import { ok, type Result } from '../kernel/result.js';
import { domainError, type DomainError } from '../kernel/errors.js';

export interface ContextBreakdown {
  readonly ascii: number;
  readonly cjk: number;
  readonly emoji: number;
  readonly code: number;
  readonly other: number;
}

export interface ContextEstimate {
  /** Upper-bound token estimate for the whole input. */
  readonly tokens: number;
  readonly breakdown: ContextBreakdown;
  readonly characters: number;
  /** Always true today: the value is a bound, not a measurement. */
  readonly conservative: boolean;
  /** Where the input came from, for diagnostics. */
  readonly source: 'text' | 'messages';
}

/** Token cost per character, by class. Rounded UP per class (conservative). */
export const TOKEN_RATIO = {
  /** Latin prose: ~4 characters per token. */
  ascii: 1 / 4,
  /** CJK/Hangul/Kana: ~1 token per character (sometimes more). */
  cjk: 1,
  /** Emoji / astral-plane symbols: several tokens each. */
  emoji: 2,
  /** Fenced code: denser than prose. */
  code: 1 / 2,
  /** Punctuation, symbols, whitespace runs. */
  other: 1 / 2,
} as const;

const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3040, 0x30ff], // kana
  [0x3400, 0x4dbf], // CJK ext A
  [0x4e00, 0x9fff], // CJK unified
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility
];

const EMOJI_RANGES: readonly (readonly [number, number])[] = [
  [0x2600, 0x27bf], // misc symbols / dingbats
  [0x1f300, 0x1f5ff], // pictographs
  [0x1f600, 0x1f64f], // emoticons
  [0x1f680, 0x1f6ff], // transport
  [0x1f900, 0x1f9ff], // supplemental
  [0x1f1e6, 0x1f1ff], // regional indicators
];

const inRanges = (code: number, ranges: readonly (readonly [number, number])[]): boolean =>
  ranges.some(([from, to]) => code >= from && code <= to);

const isAsciiLetterOrDigit = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

const isWhitespace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/** Classify one string: fenced code is measured separately from prose. */
export function estimateText(text: string): ContextEstimate {
  // Mutable counters; the public `ContextBreakdown` stays readonly.
  const counts = { ascii: 0, cjk: 0, emoji: 0, code: 0, other: 0 };
  let characters = 0;
  let inFence = false;
  let index = 0;

  while (index < text.length) {
    // Fenced code blocks are counted as `code` regardless of the characters inside.
    if (text.startsWith('```', index)) {
      inFence = !inFence;
      index += 3;
      continue;
    }
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    characters += 1;

    if (inFence) {
      counts.code += width;
    } else if (inRanges(codePoint, EMOJI_RANGES) || codePoint > 0xffff) {
      counts.emoji += width;
    } else if (inRanges(codePoint, CJK_RANGES)) {
      counts.cjk += width;
    } else if (isAsciiLetterOrDigit(codePoint) || isWhitespace(codePoint)) {
      counts.ascii += width;
    } else {
      counts.other += width;
    }
    index += width;
  }

  const tokens = Math.ceil(counts.ascii * TOKEN_RATIO.ascii)
    + Math.ceil(counts.cjk * TOKEN_RATIO.cjk)
    + Math.ceil(counts.emoji * TOKEN_RATIO.emoji)
    + Math.ceil(counts.code * TOKEN_RATIO.code)
    + Math.ceil(counts.other * TOKEN_RATIO.other);

  return { tokens, breakdown: counts, characters, conservative: true, source: 'text' };
}

/** Estimate a whole conversation (system + user + assistant + tool messages). */
export function estimateContext(texts: readonly string[]): ContextEstimate {
  const totals = { ascii: 0, cjk: 0, emoji: 0, code: 0, other: 0 };
  let tokens = 0;
  let characters = 0;
  for (const text of texts) {
    const estimate = estimateText(text);
    tokens += estimate.tokens;
    characters += estimate.characters;
    totals.ascii += estimate.breakdown.ascii;
    totals.cjk += estimate.breakdown.cjk;
    totals.emoji += estimate.breakdown.emoji;
    totals.code += estimate.breakdown.code;
    totals.other += estimate.breakdown.other;
  }
  return { tokens, breakdown: totals, characters, conservative: true, source: 'messages' };
}

/**
 * The pre-flight gate: refuse when the conservative estimate exceeds the window, and say
 * which class dominated so the caller can act on it.
 */
export function assertWithinContextWindow(
  estimate: ContextEstimate,
  contextWindow: number,
): Result<ContextEstimate, DomainError> {
  if (contextWindow <= 0) {
    return {
      ok: false,
      error: domainError('VALIDATION_FAILED', 'A context window must be positive.', { contextWindow }),
    };
  }
  if (estimate.tokens <= contextWindow) return ok(estimate);
  return {
    ok: false,
    error: domainError('VALIDATION_FAILED', 'The estimated input exceeds the context window.', {
      kind: 'context_limit',
      estimatedTokens: estimate.tokens,
      contextWindow,
      breakdown: estimate.breakdown,
      conservative: estimate.conservative,
    }),
  };
}
