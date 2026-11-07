/**
 * Live contract-fill run 7 (hark-live-goal 42401450992) regression: every kernel call was
 * charged as all cache-miss input (2 CNY / M) although DeepSeek reports most of an agent
 * loop's resent prefix as prompt-cache hits (0.04 CNY / M). The over-charge made the per-step
 * spend cap (35%) refuse admission ("403 budget admission refused") while step 1 was still
 * productively writing code. Settlement now prices the provider-REPORTED cache-hit share at
 * the attested cache-hit rate; admission bounds stay worst case (all cache-miss).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reportedCachedInputTokens } from '../../apps/desktop/src/models/provider-usage.js';
import { observedUsageOf } from '../../packages/engine/src/runtime/agent-runtime.js';
import { observeResponseUsage } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';
import { pinnedBudgetCost, readTrustedBudgetProof, type TrustedBudgetProof, type TrustedBudgetProofSource, type VerifiedBudgetIdentity } from '../../apps/desktop/src/trusted-budget-proof.js';
import { parseProviderSetupProfile } from '../../apps/desktop/src/provider-setup-write.js';

const identity: VerifiedBudgetIdentity = {
  providerId: 'TEST_ONLY:provider', modelId: 'TEST_ONLY:model', upstreamModelIdentity: 'TEST_ONLY:attested-model',
  endpoint: 'http://127.0.0.1:1/v1', routingIdentity: 'TEST_ONLY:route-v1', credentialRef: 'vault://TEST_ONLY/account/key',
  billingAccount: 'TEST_ONLY:account', billingOrganization: null, attestationRef: 'TEST_ONLY:identity-approval',
};
const proofOf = (pricing: Partial<TrustedBudgetProof['pricing']> & Record<string, unknown> = {}): TrustedBudgetProof => ({
  schema: 'companyos:trusted-budget-proof:1', scope: 'TEST_ONLY', identity,
  pricing: { source: 'TEST_ONLY:tariff', version: 'v1', currency: 'CNY', units: 'MICROS_PER_MILLION_TOKENS',
    rounding: 'CEIL_TOTAL_PER_REQUEST_MICROS', inputRate: 2_000_000, outputRate: 8_000_000, ...pricing } as TrustedBudgetProof['pricing'],
  tokens: { inputUpperBound: 192_000, outputUpperBound: 16_384, evidenceRef: 'TEST_ONLY:bound' },
  validFromMs: 0, validUntilMs: 9_999_999_999_999,
});
const sourceFor = (proof: unknown): { source: TrustedBudgetProofSource; ref: string } => {
  const bytes = Buffer.from(JSON.stringify(proof), 'utf8');
  const ref = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return {
    ref,
    source: {
      scope: 'TEST_ONLY', policyId: 'TEST_ONLY/CNY/run7', currency: 'CNY',
      billingScope: { providerId: identity.providerId, account: identity.billingAccount, organization: null },
      store: { get: async (r: string) => { if (r !== ref) throw new Error('missing'); return new Uint8Array(bytes); } },
      identify: async () => identity, approved: async (r) => r === ref, select: async () => ref,
    } as TrustedBudgetProofSource,
  };
};
const reservationFor = (proof: TrustedBudgetProof, ref: string) => ({
  runId: 'goal', callId: 'c', ownerId: 'o', status: 'RESERVED',
  bound: { modelKey: 'k', inputTokens: proof.tokens.inputUpperBound, outputTokens: proof.tokens.outputUpperBound,
    costMicros: Math.ceil((proof.tokens.inputUpperBound * proof.pricing.inputRate + proof.tokens.outputUpperBound * proof.pricing.outputRate) / 1_000_000),
    evidenceRef: ref, validUntilMs: proof.validUntilMs },
}) as never;

let previous: string | undefined;
beforeEach(() => { previous = process.env['COMPANYOS_TEST_MODE']; process.env['COMPANYOS_TEST_MODE'] = 'OFFLINE'; });
afterEach(() => { if (previous === undefined) delete process.env['COMPANYOS_TEST_MODE']; else process.env['COMPANYOS_TEST_MODE'] = previous; });

describe('run 7: provider-reported prompt-cache hits are priced at the attested cache-hit rate', () => {
  it('reads DeepSeek and OpenAI cache-hit fields and refuses anything inconsistent', () => {
    expect(reportedCachedInputTokens({ prompt_tokens: 100, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 10 }, 100)).toBe(90);
    expect(reportedCachedInputTokens({ prompt_tokens_details: { cached_tokens: 64 } }, 100)).toBe(64);
    expect(reportedCachedInputTokens({ prompt_cache_hit_tokens: 64, prompt_tokens_details: { cached_tokens: 64 } }, 100)).toBe(64);
    expect(reportedCachedInputTokens({ prompt_cache_hit_tokens: 64, prompt_tokens_details: { cached_tokens: 10 } }, 100)).toBeNull();
    expect(reportedCachedInputTokens({ prompt_cache_hit_tokens: 101 }, 100)).toBeNull();
    expect(reportedCachedInputTokens({ prompt_cache_hit_tokens: -1 }, 100)).toBeNull();
    expect(reportedCachedInputTokens({ prompt_cache_hit_tokens: 1.5 }, 100)).toBeNull();
    expect(reportedCachedInputTokens({}, 100)).toBeNull();
  });

  it('the broker observes the cache-hit share from a DeepSeek stream', () => {
    const body = ': keep-alive\n\ndata: {"choices":[],"usage":null}\n\ndata: {"choices":[],"usage":{"prompt_tokens":24000,"completion_tokens":800,"prompt_cache_hit_tokens":22000,"prompt_cache_miss_tokens":2000}}\n\ndata: [DONE]\n';
    expect(observeResponseUsage(body, 'text/event-stream').usage).toEqual({ inputTokens: 24000, outputTokens: 800, totalCost: null, cachedInputTokens: 22000 });
    const none = 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":6}}\n\ndata: [DONE]\n';
    expect(observeResponseUsage(none, 'text/event-stream').usage).toEqual({ inputTokens: 5, outputTokens: 6, totalCost: null });
  });

  it('an answered-but-unusable call keeps its valid cache-hit share', () => {
    const err = (observed: unknown) => ({ details: { usageStatus: 'KNOWN', observedUsage: observed } });
    expect(observedUsageOf(err({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 8 }))).toEqual({ inputTokens: 10, outputTokens: 2, totalCost: null, cachedInputTokens: 8 });
    expect(observedUsageOf(err({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 11 }))).toEqual({ inputTokens: 10, outputTokens: 2, totalCost: null });
  });

  it('settles a cached call at the cache-hit rate, and stays all cache-miss without an attested rate', async () => {
    const usage = { inputTokens: 24_000, outputTokens: 800, totalCost: null, cachedInputTokens: 22_000 };
    const cached = proofOf({ cacheHitInputRate: 40_000 });
    const a = sourceFor(cached);
    // 2 000 x 2 CNY + 22 000 x 0.04 CNY + 800 x 8 CNY per million = 4 000 + 880 + 6 400 micros
    expect(await pinnedBudgetCost(a.source, reservationFor(cached, a.ref), usage)).toBe(11_280);
    const plain = proofOf();
    const b = sourceFor(plain);
    expect(await pinnedBudgetCost(b.source, reservationFor(plain, b.ref), usage)).toBe(54_400);
    // no reported share -> priced as cache-miss even with an attested rate
    expect(await pinnedBudgetCost(a.source, reservationFor(cached, a.ref), { inputTokens: 24_000, outputTokens: 800, totalCost: null })).toBe(54_400);
  });

  it('refuses a proof whose cache-hit rate is above the cache-miss rate or not an integer', async () => {
    for (const rate of [2_000_001, 1.5, -1, '40000']) {
      const p = sourceFor(proofOf({ cacheHitInputRate: rate as number }));
      expect(await readTrustedBudgetProof(p.source, p.ref)).toBeNull();
    }
    const ok = sourceFor(proofOf({ cacheHitInputRate: 40_000 }));
    expect(await readTrustedBudgetProof(ok.source, ok.ref)).not.toBeNull();
  });

  it('shipped deepseek-flash profile and approval templates attest the published cache-hit rate', () => {
    const profile = JSON.parse(readFileSync('scripts/hark/setup/provider-profile.json', 'utf8'));
    expect(profile.pricing.cacheHitInputRate).toBe(40_000);
    expect(parseProviderSetupProfile(profile)).not.toBeNull();
    expect(parseProviderSetupProfile({ ...profile, pricing: { ...profile.pricing, cacheHitInputRate: 3_000_000 } })).toBeNull();
    for (const t of ['', '.contract-fill', '.h15c', '.h15d']) {
      const template = JSON.parse(readFileSync(`installer/budget/deepseek-flash${t}.approval-template.json`, 'utf8'));
      expect(template.proof.pricing).toMatchObject({ inputRate: 2_000_000, outputRate: 8_000_000, cacheHitInputRate: 40_000 });
    }
  });
});

describe('run-7 CI regression: vendor wire fields stay out of the inner ring (ARCH-037)', () => {
  it('core does not export the vendor usage parser and inner-ring code names no vendor wire field', async () => {
    const core = await import('@companyos/core');
    expect('reportedCachedInputTokens' in core).toBe(false);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const f = join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(?:ts|mts|tsx)$/.test(e.name)) {
          readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
            const code = t.replace(/\/\/.*$/, '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
            if (/\b(?:deepseek|openai)\b/i.test(code)) offenders.push(`${f}:${i + 1}`);
          });
        }
      }
    };
    walk('packages/core/src');
    walk('packages/engine/src');
    expect(offenders).toEqual([]);
  });
});
