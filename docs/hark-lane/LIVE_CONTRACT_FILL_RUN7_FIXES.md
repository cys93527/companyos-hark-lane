# Live contract-fill run 7 — prompt-cache pricing fix

Run: hark-live-goal 42401450992 (2026-11-08). Outcome: INCOMPLETE, `GOAL_STEP_SPEND_CAP_REACHED`
after 57 calls (ledger CNY 2.318) while step 1 was still writing the engine core.

## Root cause
Settlement priced every input token at the cache-miss rate. DeepSeek reports the cached share of
each request (`prompt_cache_hit_tokens`) and bills it at 0.04 CNY per million tokens (peak) instead
of 2 CNY (https://api-docs.deepseek.com/zh-cn/quick_start/pricing). An agent loop resends a growing
prefix on every call, so most input is cached; the ledger over-charged several times and the
per-step spend cap (35 %) stopped a productive step.

## Fix
- `TokenUsage.cachedInputTokens` (optional, provider-reported, validated by
  `reportedCachedInputTokens` (adapter layer, `apps/desktop/src/models/provider-usage.ts`): DeepSeek `prompt_cache_hit_tokens` or OpenAI
  `prompt_tokens_details.cached_tokens`, 0..prompt_tokens, conflicting values refused).
- Read by the loopback model broker (`observeResponseUsage`), the openai-compatible provider and
  `observedUsageOf` (answered-but-unusable calls).
- Trusted budget proof: optional attested `pricing.cacheHitInputRate` (integer, never above
  `inputRate`). Used only when settling a call; admission bounds remain all cache-miss (worst case).
  No reported share, or no attested rate, means the call is priced as cache-miss input.
- Shipped `scripts/hark/setup/provider-profile.json` and the deepseek-flash approval templates
  attest 40 000 micros per million.

Regression test: `tests/hark/live-contract-fill-run7.test.ts`.

## CI follow-up (734c426)

hark-ubuntu / hark-windows failed the architecture guard (ARCH-037): the usage parser named
vendor wire fields inside `packages/core`. Root fix: the parser moved to the adapter layer
`apps/desktop/src/models/provider-usage.ts`; Core keeps only the vendor-neutral
`TokenUsage.cachedInputTokens`. Regression: `tests/hark/live-contract-fill-run7.test.ts`
runs `scripts/check-architecture.mjs` and asserts Core no longer exports the parser.

