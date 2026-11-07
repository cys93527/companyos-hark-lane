/**
 * Provider wire-format usage parsing (adapter layer). Vendor field names live here, never in
 * the vendor-neutral inner ring (ARCH-037): Core only knows `TokenUsage.cachedInputTokens`.
 */

/**
 * The cache-hit part of a provider-reported Chat Completions `usage` object, validated
 * against its `prompt_tokens`. Reads DeepSeek `prompt_cache_hit_tokens` or OpenAI
 * `prompt_tokens_details.cached_tokens`. Anything missing, non-integer, negative or larger
 * than `promptTokens` (or two fields that disagree) is `null`: the call is then priced as
 * all cache-miss input (the conservative charge), never an invented discount.
 */
export const reportedCachedInputTokens = (usage: unknown, promptTokens: number): number | null => {
  if (usage === null || typeof usage !== 'object') return null;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= promptTokens;
  const topLevelHit = (usage as { prompt_cache_hit_tokens?: unknown }).prompt_cache_hit_tokens;
  const details = (usage as { prompt_tokens_details?: unknown }).prompt_tokens_details;
  const nestedCached = details !== null && typeof details === 'object' ? (details as { cached_tokens?: unknown }).cached_tokens : undefined;
  const a = topLevelHit === undefined || topLevelHit === null ? undefined : topLevelHit;
  const b = nestedCached === undefined || nestedCached === null ? undefined : nestedCached;
  if (a !== undefined && !ok(a)) return null;
  if (b !== undefined && !ok(b)) return null;
  if (a !== undefined && b !== undefined && a !== b) return null;
  return (a ?? b ?? null) as number | null;
};
