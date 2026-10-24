/**
 * Closeout-10A tests: RouterPolicyView (STEP 3), the frozen v1 numeric policy (STEP 2) and the
 * contract freeze (STEP 4).
 *
 * Still design-only: nothing here selects a model. These tests lock the *shape* of the frozen
 * contract and the numbers an implementation must use.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BENCHMARK_WEIGHT_CAP,
  HISTORICAL_MIN_SAMPLE,
  ROUTER_POLICY_VIEW_ORIGIN,
  ROUTER_V1_RANKING,
  ROUTER_V1_WEIGHTS,
  ROUTER_VERSION,
  applyHardFilters,
  assertDerivedPolicyView,
  createPolicy,
  decideFallback,
  deriveRouterPolicyView,
  routerV1Policy,
  type HardFilterOutcome,
  type ModelRecord,
  type ModelSelectionPolicy,
  type RouterPolicyView,
  type RouterRequest,
} from '@companyos/core';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const source = (path: string): string => readFileSync(repo(path), 'utf8');

const MODEL = (modelKey: string): ModelRecord => ({
  id: modelKey,
  modelKey,
  providerId: 'provider-a',
  providerModelId: modelKey,
  displayName: modelKey,
  description: '',
  capabilities: {
    streaming: true,
    structuredOutput: true,
    toolCalling: false,
    vision: false,
    reasoning: false,
    audio: false,
  },
  contextWindow: 8_000,
  maxOutputTokens: 1_000,
  pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
  enabled: true,
  availability: 'available',
  metadata: {},
  registeredAt: '2027-01-01T00:00:00.000Z',
  updatedAt: '2027-01-01T00:00:00.000Z',
  registeredBy: 'user_owner',
});

const policy = (fields: Record<string, unknown> = {}): ModelSelectionPolicy => {
  const built = createPolicy({
    id: 'COMPANY:*',
    scopeType: 'COMPANY',
    scopeId: '*',
    mode: 'AUTO',
    createdBy: 'user_owner',
    now: '2027-01-01T00:00:00.000Z',
    ...fields,
  } as never);
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
};

/** Unwrap a hard-filter Result (refusals are asserted explicitly where they matter). */
const filterOrThrow = (req: RouterRequest): HardFilterOutcome => {
  const outcome = applyHardFilters(req);
  if (!outcome.ok) throw new Error(`unexpected hard-filter refusal: ${outcome.error.message}`);
  return outcome.value;
};

const requestWith = (view: RouterPolicyView): RouterRequest => ({
  requestId: 'req_view',
  companyId: 'company_default',
  taskId: 'tsk_1',
  roleId: 'role_developer',
  selectionMode: 'AUTO',
  policyView: view,
  estimatedInputTokens: 100,
  candidateModels: [MODEL('model-a'), MODEL('model-b')],
  traceId: 'trace_view',
});

describe('STEP 3. RouterPolicyView is derived, never hand-assembled', () => {
  it('derives every filter list from the resolved policy, deterministically', () => {
    const resolved = policy({
      mode: 'HYBRID',
      allowedModels: ['model-b', 'model-a'],
      blockedModels: ['model-z'],
      allowedProviders: ['provider-a'],
      preferredModels: ['model-b'],
      requiredCapabilities: ['structuredOutput'],
      maxCost: 5,
      maxLatency: 1_000,
      allowFallback: 'AUTO_WITHIN_POLICY',
    });
    const first = deriveRouterPolicyView({ policy: resolved, snapshotVersion: 'v1' });
    const second = deriveRouterPolicyView({ policy: resolved, snapshotVersion: 'v1' });

    expect(first).toEqual(second);
    expect(first.derivedBy).toBe(ROUTER_POLICY_VIEW_ORIGIN);
    // Sorted for stability; the user's preference ORDER is preserved in preferredModels.
    expect(first.allowedModels).toEqual(['model-a', 'model-b']);
    expect(first.allowedProviders).toEqual(['provider-a']);
    expect(first.blockedModels).toEqual(['model-z']);
    expect(first.preferredModels).toEqual(['model-b']);
    expect(first.requiredCapabilities).toEqual(['structuredOutput']);
    expect(first.maxCost).toBe(5);
    expect(first.maxLatency).toBe(1_000);
    expect(first.source.mode).toBe('HYBRID');
    expect(first.fallback).toBe('AUTO_WITHIN_POLICY');
    expect(first.scopeType).toBe('COMPANY');
    expect(first.source.snapshotVersion.endsWith(first.digest)).toBe(true);
    expect(assertDerivedPolicyView(first).ok).toBe(true);
  });

  it('refuses a hand-assembled or tampered view', () => {
    const view = deriveRouterPolicyView({ policy: policy(), snapshotVersion: 'v1' });
    const tampered: RouterPolicyView = { ...view, blockedModels: ['model-a'] };
    const verdict = assertDerivedPolicyView(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.message).toContain('modified after it was derived');

    const forged = { ...view, derivedBy: 'caller-made-this' } as unknown as RouterPolicyView;
    const forgedVerdict = assertDerivedPolicyView(forged);
    expect(forgedVerdict.ok).toBe(false);
    if (!forgedVerdict.ok) expect(forgedVerdict.error.message).toContain('must be derived');
  });

  it('a derived view with no policy at all is still usable (no policy is not an error)', () => {
    const view = deriveRouterPolicyView({ policy: null, snapshotVersion: 'none' });
    expect(view.allowedModels).toEqual([]);
    expect(view.blockedModels).toEqual([]);
    expect(view.source).toMatchObject({ policyId: null, mode: null });
    expect(view.fallback).toBe('NEVER');
    expect(view.scopeType).toBeNull();
    const outcome = filterOrThrow(requestWith(view));
    expect(outcome.candidates.map((model) => model.modelKey)).toEqual(['model-a', 'model-b']);
    expect(outcome.rejected).toEqual([]);
  });

  it('requirements declared at the call site merge with policy requirements', () => {
    const view = deriveRouterPolicyView({
      policy: policy({ requiredCapabilities: ['streaming'] }),
      requiredCapabilities: ['structuredOutput', 'streaming'],
      snapshotVersion: 'merged',
    });
    expect(view.requiredCapabilities).toEqual(['streaming', 'structuredOutput']);
  });

  it('neither the Runtime nor the UI assembles policy lists (STEP 3 boundary)', () => {
    const runtime = source('packages/engine/src/runtime/agent-runtime.ts');
    const tools = source('packages/engine/src/tools/registry.ts');
    for (const code of [runtime, tools]) {
      expect(code).not.toMatch(/RouterPolicyView/);
      expect(code).not.toMatch(/deriveRouterPolicyView/);
    }
    // The only producer lives in Core (pure) and is re-exposed by the policy service.
    expect(source('packages/engine/src/registry/selection-policy.ts')).toMatch(/deriveRouterPolicyView\(/);
    expect(source('packages/core/src/domain/model-router.ts')).toMatch(/export function deriveRouterPolicyView/);
  });
});

describe('STEP 2. the frozen v1 numeric policy', () => {
  it('declares all six facts for every signal and no signal may break a hard filter', () => {
    expect(ROUTER_V1_RANKING.length).toBeGreaterThanOrEqual(6);
    for (const signal of ROUTER_V1_RANKING) {
      expect(signal.key.length).toBeGreaterThan(0);
      expect(signal.source.length).toBeGreaterThan(0);
      expect(signal.normalization.length).toBeGreaterThan(0);
      expect(signal.missing).toBe('SKIP_AND_RENORMALISE');
      expect(signal.weight).toBeGreaterThan(0);
      expect(signal.weight).toBeLessThanOrEqual(signal.maxWeight);
      expect(typeof signal.tieBreak).toBe('boolean');
      // FROZEN: ranking can never overcome a hard filter.
      expect(signal.canBreakHardFilter).toBe(false);
    }
  });

  it('weights sum to 1, benchmark stays within its cap, and the order matches the ADR', () => {
    const total = Object.values(ROUTER_V1_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(Number(total.toFixed(10))).toBe(1);
    expect(ROUTER_V1_WEIGHTS['benchmarkMetadata']).toBeLessThanOrEqual(BENCHMARK_WEIGHT_CAP);
    expect(ROUTER_V1_RANKING.map((signal) => signal.key)).toEqual([
      'preferredModelsPosition',
      'providerHealth',
      'contextHeadroom',
      'estimatedCost',
      'estimatedLatency',
      'historicalSuccessRate',
      'benchmarkMetadata',
    ]);
    const frozen = routerV1Policy();
    expect(frozen.version).toBe(ROUTER_VERSION);
    expect(frozen.benchmarkWeightCap).toBe(BENCHMARK_WEIGHT_CAP);
    expect(frozen.historicalMinSample).toBe(HISTORICAL_MIN_SAMPLE);
    expect(frozen.stageOrder).toEqual([
      'HARD_FILTERS',
      'USER_PREFERENCE',
      'PROVIDER_HEALTH',
      'CONTEXT_HEADROOM',
      'COST',
      'LATENCY',
      'HISTORICAL_PERFORMANCE',
      'BENCHMARK',
      'STABLE_TIE_BREAK',
    ]);
  });

  it('tie-break participation is declared per signal, and missing data never scores zero', () => {
    const tieBreakKeys = ROUTER_V1_RANKING.filter((signal) => signal.tieBreak).map((signal) => signal.key);
    // Exactly the documented tie-break group participates.
    expect(tieBreakKeys).toEqual([
      'preferredModelsPosition',
      'providerHealth',
      'estimatedCost',
      'estimatedLatency',
    ]);
    for (const signal of ROUTER_V1_RANKING) {
      // Missing -> skip + renormalise (the contract states it explicitly, so no default value
      // can silently become a score).
      expect(signal.missing).toBe('SKIP_AND_RENORMALISE');
    }
  });

  it('the router still works when every optional signal is absent', () => {
    const view = deriveRouterPolicyView({ policy: policy(), snapshotVersion: 'no-data' });
    const outcome = filterOrThrow(requestWith(view));
    expect(outcome.candidates).toHaveLength(2);
    // With no cost/latency/benchmark/historical data the caller still gets a deterministic
    // ordering contract (tie-break), not an error.
    const decision = decideFallback({ fallbackPolicy: 'NEVER', candidates: outcome.candidates });
    expect(decision.action).toBe('STOP');
  });
});

describe('STEP 4. contract freeze', () => {
  it('locks routerVersion at model-router/v1 and exports the frozen names', () => {
    expect(ROUTER_VERSION).toBe('model-router/v1');
    const coreIndex = source('packages/core/src/index.ts');
    for (const name of [
      'RouterRequest',
      'RouterPolicyView',
      'ModelRecommendation',
      'CandidateEvaluation',
      'RejectedCandidate',
      'RouterProvenance',
      'OverrideRecord',
      'FallbackDecision',
      'ModelDiversityConstraint',
      'RouterRiskConstraint',
      'RouterDecision',
      'RouterRejectionReason',
      'RouterPositiveReason',
      'deriveRouterPolicyView',
      'routerV1Policy',
    ]) {
      expect(coreIndex, `${name} must stay exported`).toContain(name);
    }
  });

  it('declares the freeze and the version policy in the ADR and the reference doc', () => {
    const adr = source('docs/adr/0014-model-router-architecture.md');
    expect(adr).toMatch(/Router v1/);
    expect(adr).toMatch(/RouterPolicyView/);
    expect(adr).toMatch(/model-router\/v1/);
    const reference = source('docs/MODEL_ROUTER.md');
    expect(reference).toMatch(/RouterPolicyView/);
    expect(reference).toMatch(/model-router\/v1/);
  });
});
