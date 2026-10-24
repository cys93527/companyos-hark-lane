/**
 * Sprint 10B tests A–AT: the Deterministic Rule-Based Router v1.
 *
 * Every test drives the real `createDeterministicModelRouter` through the frozen pipeline
 * (assertRouterRequestAllowed -> applyHardFilters -> rankCandidates -> selectWinner ->
 * validateRecommendation -> audit). No provider, runtime or network is involved anywhere.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ROUTER_POSITIVE_REASONS,
  ROUTER_REJECTION_REASONS,
  ROUTER_V1_WEIGHTS,
  applyHumanOverride,
  assertDerivedPolicyView,
  assertRankingInput,
  assertRouterRequestAllowed,
  createPolicy,
  decideFallback,
  deriveRouterPolicyView,
  manualOutcome,
  rankCandidates,
  routerUnavailableOutcome,
  validateRecommendation,
  type BenchmarkReference,
  type HistoricalPerformanceSnapshot,
  type ModelRecord,
  type RouterPolicyView,
  type RouterRequest,
} from '@companyos/core';
import {
  createDeterministicModelRouter,
  type RouterAuditPayload,
  type RouterDecisionRecord,
} from '@companyos/engine';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const source = (path: string): string => readFileSync(repo(path), 'utf8');

const MODEL = (modelKey: string, overrides: Partial<ModelRecord> = {}): ModelRecord => ({
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
  maxOutputTokens: 4_000,
  pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' },
  enabled: true,
  availability: 'available',
  metadata: {},
  registeredAt: '2027-01-01T00:00:00.000Z',
  updatedAt: '2027-01-01T00:00:00.000Z',
  registeredBy: 'user_owner',
  ...overrides,
});

const policyOf = (fields: Record<string, unknown> = {}) => {
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

const viewOf = (fields: Record<string, unknown> = {}): RouterPolicyView =>
  deriveRouterPolicyView({ policy: policyOf(fields), generatedAt: '2027-01-01T00:00:00.000Z' });

interface Harness {
  readonly router: ReturnType<typeof createDeterministicModelRouter>;
  readonly events: { readonly type: string; readonly payload: RouterAuditPayload }[];
  readonly saved: RouterDecisionRecord[];
}

const harness = (options: {
  readonly ranking?: Parameters<typeof createDeterministicModelRouter>[0]['rankingContext'];
} = {}): Harness => {
  const events: { type: string; payload: RouterAuditPayload }[] = [];
  const saved: RouterDecisionRecord[] = [];
  let counter = 0;
  const router = createDeterministicModelRouter({
    audit: {
      requested: async (payload) => void events.push({ type: 'router.requested', payload }),
      candidatesBuilt: async (payload) => void events.push({ type: 'router.candidates_built', payload }),
      recommendationCreated: async (payload) => void events.push({ type: 'router.recommendation_created', payload }),
      noCandidate: async (payload) => void events.push({ type: 'router.no_candidate', payload }),
      overrideRequested: async (payload) => void events.push({ type: 'router.override_requested', payload }),
      overrideConfirmed: async (payload) => void events.push({ type: 'router.override_confirmed', payload }),
    },
    clock: { now: () => Date.parse('2027-06-01T10:00:00.000Z'), nowIso: () => '2027-06-01T10:00:00.000Z' },
    ids: { next: (prefix) => `${prefix}_${String((counter += 1))}` },
    modelRegistryRevision: () => 'registry-rev-10b',
    ...(options.ranking === undefined ? {} : { rankingContext: options.ranking }),
    decisions: {
      save: async (record) => void saved.push(record),
    },
  });
  return { router, events, saved };
};

const request = (
  view: RouterPolicyView,
  candidates: readonly ModelRecord[],
  overrides: Partial<RouterRequest> = {},
): RouterRequest => ({
  requestId: 'req_10b',
  companyId: 'company_default',
  taskId: 'tsk_1',
  roleId: 'role_developer',
  selectionMode: 'AUTO',
  policyView: view,
  estimatedInputTokens: 1_000,
  requiredOutputTokens: 500,
  candidateModels: candidates,
  traceId: 'trace_10b',
  ...overrides,
});

const run = async (
  h: Harness,
  view: RouterPolicyView,
  candidates: readonly ModelRecord[],
  overrides: Partial<RouterRequest> = {},
) => {
  const outcome = await h.router.recommend(request(view, candidates, overrides));
  if (!outcome.ok) throw new Error(`unexpected refusal: ${outcome.error.code} ${outcome.error.message}`);
  return outcome.value;
};

describe('A–C. entry semantics: MANUAL refused, AUTO/HYBRID routed', () => {
  it('A: MANUAL is refused with MANUAL_NOT_ROUTED (all three shapes)', async () => {
    const h = harness();
    const view = viewOf();
    for (const request_ of [
      request(view, [MODEL('model-a')], { selectionMode: 'MANUAL' }),
      request(view, [MODEL('model-a')], { selectionMode: 'AUTO', manualModelKey: 'model-a' }),
      request(deriveRouterPolicyView({ policy: policyOf({ mode: 'MANUAL', manualModelKey: 'model-a' }) }), [
        MODEL('model-a'),
      ]),
    ]) {
      const outcome = await h.router.recommend(request_);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe('MANUAL_NOT_ROUTED');
    }
    // The MANUAL path itself still works without the router.
    const manual = manualOutcome({ request: request(view, [MODEL('model-a')], { manualModelKey: 'model-a' }) });
    expect(manual.ok).toBe(true);
    expect(assertRouterRequestAllowed(request(view, [MODEL('model-a')], { selectionMode: 'HYBRID' })).ok).toBe(true);
  });

  it('B: AUTO recommends the best-scoring candidate with explainable reasons', async () => {
    const h = harness({ ranking: () => ({ providerHealth: { 'provider-a': 'healthy' } }) });
    const model = await run(
      h,
      viewOf({ preferredModels: ['model-b'] }),
      [MODEL('model-a'), MODEL('model-b')],
    );
    expect(model.decision).toBe('RECOMMENDED');
    expect(model.selectedModelKey).toBe('model-b');
    expect(model.reasonCodes).toContain('PREFERRED_MODEL');
    expect(model.reasonCodes.every((code) => (ROUTER_POSITIVE_REASONS as readonly string[]).includes(code))).toBe(true);
    expect(validateRecommendation(model).ok).toBe(true);
  });

  it('C: HYBRID recommends only inside the allowed range', async () => {
    const h = harness();
    const model = await run(
      h,
      viewOf({ mode: 'HYBRID', allowedModels: ['model-b'] }),
      [MODEL('model-a'), MODEL('model-b')],
      { selectionMode: 'HYBRID' },
    );
    expect(model.selectedModelKey).toBe('model-b');
    expect(model.candidateEvaluations.map((entry) => entry.modelKey)).toEqual(['model-b']);
  });
});

describe('D–I. hard filters decide before ranking (no resurrection)', () => {
  it('D: a blocked model never reaches ranking', async () => {
    const h = harness();
    const model = await run(h, viewOf({ blockedModels: ['model-b'] }), [MODEL('model-a'), MODEL('model-b')]);
    expect(model.selectedModelKey).toBe('model-a');
    expect(model.candidateEvaluations.map((entry) => entry.modelKey)).not.toContain('model-b');
    expect(model.rejectedCandidates.map((entry) => entry.modelKey)).toContain('model-b');
    const rankedKeys = model.candidateEvaluations.map((entry) => entry.modelKey);
    for (const rejected of model.rejectedCandidates) expect(rankedKeys).not.toContain(rejected.modelKey);
  });

  it('E: a model outside the allowed range is absent from the HYBRID ranking', async () => {
    const h = harness();
    const model = await run(h, viewOf({ mode: 'HYBRID', allowedModels: ['model-a'] }), [
      MODEL('model-a'),
      MODEL('model-b'),
    ], { selectionMode: 'HYBRID' });
    expect(model.candidateEvaluations.map((entry) => entry.modelKey)).toEqual(['model-a']);
    expect(model.rejectedCandidates.find((entry) => entry.modelKey === 'model-b')?.reasons).toContain(
      'NOT_IN_CANDIDATE_SET',
    );
  });

  it('F/G/H/I: capability, availability, cost and context eliminate candidates', async () => {
    const h = harness();
    const capability = await run(h, viewOf({ requiredCapabilities: ['vision'] }), [
      MODEL('model-a'),
      MODEL('model-vision', { capabilities: { ...MODEL('x').capabilities, vision: true } }),
    ]);
    expect(capability.selectedModelKey).toBe('model-vision');

    const availability = await run(h, viewOf(), [MODEL('model-a', { availability: 'unavailable' }), MODEL('model-b')]);
    expect(availability.selectedModelKey).toBe('model-b');

    const cost = await run(h, viewOf({ maxCost: 1 }), [
      MODEL('model-a', { pricing: { inputPerMillion: 1, outputPerMillion: 1, currency: 'USD' } }),
      MODEL('model-pricey', { pricing: { inputPerMillion: 50, outputPerMillion: 50, currency: 'USD' } }),
    ]);
    expect(cost.selectedModelKey).toBe('model-a');
    expect(cost.rejectedCandidates.find((entry) => entry.modelKey === 'model-pricey')?.reasons).toContain(
      'COST_LIMIT_EXCEEDED',
    );

    const context = await run(h, viewOf(), [MODEL('model-small', { contextWindow: 100 }), MODEL('model-b')]);
    expect(context.selectedModelKey).toBe('model-b');
    expect(context.rejectedCandidates.find((entry) => entry.modelKey === 'model-small')?.reasons).toContain(
      'CONTEXT_TOO_SMALL',
    );
  });
});

describe('J–T. the frozen ranking signals', () => {
  it('J: preferred position scores 1.0 / 0.6 / 0.3 / 0', async () => {
    const h = harness();
    const model = await run(h, viewOf({ preferredModels: ['model-b', 'model-c', 'model-d'] }), [
      MODEL('model-a'),
      MODEL('model-b'),
      MODEL('model-c'),
      MODEL('model-d'),
    ]);
    const scores = new Map(
      model.candidateEvaluations.map((entry) => [entry.modelKey, entry]),
    );
    const preference = (key: string) =>
      scores
        .get(key)
        ?.signalScores.find((signal) => signal.key === 'preferredModelsPosition')?.score ?? null;
    expect(preference('model-b')).toBe(1);
    expect(preference('model-c')).toBe(0.6);
    expect(preference('model-d')).toBe(0.3);
    expect(preference('model-a')).toBe(0);
    expect(model.selectedModelKey).toBe('model-b');
  });

  it('K/L/M: health, headroom and cost normalise as frozen', async () => {
    const h = harness({ ranking: () => ({ providerHealth: { 'provider-a': 'healthy', 'provider-b': 'degraded' } }) });
    const model = await run(h, viewOf(), [
      MODEL('model-healthy'),
      MODEL('model-degraded', { providerId: 'provider-b' }),
    ]);
    const healthy = model.candidateEvaluations.find((entry) => entry.modelKey === 'model-healthy');
    const degraded = model.candidateEvaluations.find((entry) => entry.modelKey === 'model-degraded');
    expect(healthy?.signalScores.find((signal) => signal.key === 'providerHealth')?.score).toBe(1);
    expect(degraded?.signalScores.find((signal) => signal.key === 'providerHealth')?.score).toBe(0.5);
    expect(
      model.candidateEvaluations.every(
        (entry) => (entry.signalScores.find((signal) => signal.key === 'contextHeadroom')?.score ?? 0) > 0,
      ),
    ).toBe(true);

    // Cost: cheaper wins inside the set; identical prices -> 0.5 neutral.
    const cheaper = await run(h, viewOf(), [
      MODEL('model-cheap', { pricing: { inputPerMillion: 1, outputPerMillion: 1, currency: 'USD' } }),
      MODEL('model-expensive', { pricing: { inputPerMillion: 9, outputPerMillion: 9, currency: 'USD' } }),
    ]);
    const costScore = (key: string) =>
      cheaper.candidateEvaluations
        .find((entry) => entry.modelKey === key)
        ?.signalScores.find((signal) => signal.key === 'estimatedCost')?.score ?? null;
    expect(costScore('model-cheap')).toBe(1);
    expect(cheaper.selectedModelKey).toBe('model-cheap');

    const samePrice = await run(h, viewOf(), [MODEL('model-a'), MODEL('model-b')]);
    expect(
      samePrice.candidateEvaluations.map(
        (entry) => entry.signalScores.find((signal) => signal.key === 'estimatedCost')?.score,
      ),
    ).toEqual([0.5, 0.5]);
  });

  it('N: missing latency is skipped and the remaining weights renormalise', async () => {
    const h = harness({ ranking: () => ({ providerHealth: { 'provider-a': 'healthy' } }) });
    const model = await run(h, viewOf(), [MODEL('model-a'), MODEL('model-b')]);
    for (const entry of model.candidateEvaluations) {
      const latency = entry.signalScores.find((signal) => signal.key === 'estimatedLatency');
      expect(latency?.score).toBeNull();
      expect(latency?.skipped).toBe('NO_DATA');
      // The available weight excludes the skipped signals (preference 0.25, latency 0.10,
      // historical 0.05, benchmark 0.10) - only health + headroom + cost had data here.
      expect(entry.availableWeights).toBeCloseTo(
        ROUTER_V1_WEIGHTS['providerHealth']! + ROUTER_V1_WEIGHTS['contextHeadroom']! + ROUTER_V1_WEIGHTS['estimatedCost']!,
        6,
      );
      expect(entry.normalisedScore).toBeGreaterThan(0);
      expect(entry.normalisedScore).toBeLessThanOrEqual(1);
      expect(entry.reasonCodes).toContain('LATENCY_DATA_UNAVAILABLE');
    }
  });

  it('O: historical data is down-weighted below 20 samples and full at 20+', async () => {
    const snapshot = (sampleCount: number): HistoricalPerformanceSnapshot => ({
      modelKey: 'model-a',
      successRate: 1,
      reviewPassRate: null,
      reworkRate: null,
      failureRate: null,
      avgLatencyMs: null,
      avgCost: null,
      sampleCount,
    });
    const small = harness({ ranking: () => ({ performanceByModelKey: { 'model-a': snapshot(10) } }) });
    const smallModel = await run(small, viewOf(), [MODEL('model-a'), MODEL('model-b')]);
    const smallEntry = smallModel.candidateEvaluations.find((entry) => entry.modelKey === 'model-a');
    const smallScore = smallEntry?.signalScores.find((signal) => signal.key === 'historicalSuccessRate')?.score;
    expect(smallScore).toBeCloseTo(0.5, 6);
    expect(smallEntry?.reasonCodes).toContain('SMALL_SAMPLE_DOWNWEIGHTED');

    const enough = harness({ ranking: () => ({ performanceByModelKey: { 'model-a': snapshot(20) } }) });
    const enoughModel = await run(enough, viewOf(), [MODEL('model-a'), MODEL('model-b')]);
    expect(
      enoughModel.candidateEvaluations
        .find((entry) => entry.modelKey === 'model-a')
        ?.signalScores.find((signal) => signal.key === 'historicalSuccessRate')?.score,
    ).toBe(1);

    const none = harness({ ranking: () => ({ performanceByModelKey: { 'model-a': snapshot(0) } }) });
    const noneModel = await run(none, viewOf(), [MODEL('model-a'), MODEL('model-b')]);
    expect(
      noneModel.candidateEvaluations
        .find((entry) => entry.modelKey === 'model-a')
        ?.signalScores.find((signal) => signal.key === 'historicalSuccessRate')?.score,
    ).toBeNull();
  });

  it('P/Q/R: benchmark is capped, stale/external are discounted, it can never break a hard filter', async () => {
    const reference = (overrides: Partial<BenchmarkReference> = {}): BenchmarkReference => ({
      modelKey: 'model-b',
      score: 1,
      suiteId: 'suite',
      benchmarkVersion: 'bench/1',
      source: 'harness',
      recordedAt: '2027-01-01T00:00:00.000Z',
      stale: false,
      ...overrides,
    });
    const plain = harness({ ranking: () => ({ benchmarkByModelKey: { 'model-b': reference() } }) });
    const plainModel = await run(plain, viewOf(), [MODEL('model-a'), MODEL('model-b')]);
    const plainScore = plainModel.candidateEvaluations
      .find((entry) => entry.modelKey === 'model-b')
      ?.signalScores.find((signal) => signal.key === 'benchmarkMetadata')?.score;
    // 10B.1 §十: the signal score is the RAW score adjusted for stale/source only; the 0.10
    // weight is applied once in the total, so this value is 1 - not 0.10.
    expect(plainScore).toBeCloseTo(1, 6);
    expect(plainScore!).toBeLessThanOrEqual(1);

    const stale = harness({ ranking: () => ({ benchmarkByModelKey: { 'model-b': reference({ stale: true }) } }) });
    const staleScore = (await run(stale, viewOf(), [MODEL('model-a'), MODEL('model-b')])).candidateEvaluations
      .find((entry) => entry.modelKey === 'model-b')
      ?.signalScores.find((signal) => signal.key === 'benchmarkMetadata')?.score;
    expect(staleScore).toBeCloseTo(plainScore! * 0.5, 6);

    const external = harness({
      ranking: () => ({ benchmarkByModelKey: { 'model-b': reference({ source: 'external' }) } }),
    });
    const externalScore = (await run(external, viewOf(), [MODEL('model-a'), MODEL('model-b')])).candidateEvaluations
      .find((entry) => entry.modelKey === 'model-b')
      ?.signalScores.find((signal) => signal.key === 'benchmarkMetadata')?.score;
    expect(externalScore).toBeCloseTo(plainScore! * 0.75, 6);

    // A benchmark leader that fails a hard filter is still eliminated.
    const blockedLeader = harness({
      ranking: () => ({ benchmarkByModelKey: { 'model-b': reference() } }),
    });
    const blockedModel = await run(blockedLeader, viewOf({ blockedModels: ['model-b'] }), [
      MODEL('model-a'),
      MODEL('model-b'),
    ]);
    expect(blockedModel.selectedModelKey).toBe('model-a');
  });

  it('S/T: with every optional signal missing the result is still deterministic', async () => {
    const h = harness();
    const first = await run(h, viewOf(), [MODEL('model-b'), MODEL('model-a')]);
    const second = await run(h, viewOf(), [MODEL('model-b'), MODEL('model-a')]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.decision).toBe('RECOMMENDED');
    for (const entry of first.candidateEvaluations) {
      const skipped = entry.signalScores.filter((signal) => signal.score === null).map((signal) => signal.key);
      expect(skipped).toEqual(['preferredModelsPosition', 'providerHealth', 'estimatedLatency', 'historicalSuccessRate', 'benchmarkMetadata']);
      expect(entry.availableWeights).toBeCloseTo(
        ROUTER_V1_WEIGHTS['contextHeadroom']! + ROUTER_V1_WEIGHTS['estimatedCost']!,
        6,
      );
    }
  });
});

describe('U–X. tie-break, determinism, no candidate, invariants', () => {
  it('U: equal scores are broken by the frozen tie-break order', async () => {
    const h = harness({ ranking: () => ({ providerHealth: { 'provider-a': 'healthy', 'provider-b': 'degraded' } }) });
    const model = await run(h, viewOf(), [MODEL('model-b'), MODEL('model-a')]);
    expect(model.selectedModelKey).toBe('model-a'); // healthy beats degraded
    expect(model.reasonCodes).toContain('TIE_BREAK_APPLIED');

    const lexical = await run(harness(), viewOf(), [MODEL('model-b'), MODEL('model-a')]);
    expect(lexical.selectedModelKey).toBe('model-a'); // equal score -> lexical modelKey

    const preferenceWins = await run(harness(), viewOf({ preferredModels: ['model-b'] }), [
      MODEL('model-a'),
      MODEL('model-b'),
    ]);
    expect(preferenceWins.selectedModelKey).toBe('model-b');
  });

  it('V: identical input produces an identical recommendation (no clock, no random)', async () => {
    const h = harness({ ranking: () => ({ providerHealth: { 'provider-a': 'healthy' } }) });
    const view = viewOf({ preferredModels: ['model-a'] });
    const candidates = [MODEL('model-a'), MODEL('model-b')];
    const first = await run(h, view, candidates);
    const second = await run(h, view, candidates);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const routerSource = source('packages/engine/src/router/deterministic-router.ts');
    expect(routerSource).not.toMatch(/Math\.random|Date\.now\(/);
  });

  it('W: no eligible candidate is NO_ELIGIBLE_MODEL with a rejection summary', async () => {
    const h = harness();
    const model = await run(h, viewOf(), [MODEL('model-a', { enabled: false }), MODEL('model-b', { availability: 'unavailable' })]);
    expect(model.decision).toBe('NO_ELIGIBLE_MODEL');
    expect(model.selectedModelKey).toBeNull();
    expect(model.candidateEvaluations).toEqual([]);
    expect(model.rejectionSummary).not.toBeNull();
    expect(model.rejectionSummary?.checked).toBe(2);
    expect(validateRecommendation(model).ok).toBe(true);
    expect(h.events.map((event) => event.type)).toContain('router.no_candidate');
  });

  it('X: the produced recommendation always satisfies the invariants', async () => {
    const h = harness();
    for (const model of [
      await run(h, viewOf(), [MODEL('model-a')]),
      await run(h, viewOf({ blockedModels: ['model-a'] }), [MODEL('model-a')]),
    ]) {
      expect(validateRecommendation(model).ok).toBe(true);
      for (const code of model.reasonCodes) {
        expect([...ROUTER_POSITIVE_REASONS, ...ROUTER_REJECTION_REASONS]).toContain(code);
      }
    }
  });
});

describe('Y–AC. provenance and audit', () => {
  it('Y: provenance carries the frozen fields', async () => {
    const h = harness();
    const model = await run(h, viewOf(), [MODEL('model-a')]);
    expect(model.provenance.routerVersion).toBe('model-router/v1');
    expect(model.provenance.policySnapshotVersion).toBe(model.policySource.snapshotVersion);
    expect(model.provenance.modelRegistryRevision).toBe('registry-rev-10b');
    expect(model.provenance.benchmarkVersion).toBeNull();
    expect(model.provenance.performanceSnapshot).toBeNull();
  });

  it('Z/AA/AB/AC: the four audit events fire with a whitelisted payload', async () => {
    const h = harness();
    const model = await run(h, viewOf({ preferredModels: ['model-b'] }), [MODEL('model-a'), MODEL('model-b')]);
    const types = h.events.map((event) => event.type);
    expect(types).toEqual(['router.requested', 'router.candidates_built', 'router.recommendation_created']);
    for (const event of h.events) {
      expect(Object.keys(event.payload).sort()).toEqual(
        [
          'candidateCount',
          'modelRegistryRevision',
          'policySnapshotVersion',
          'reasonCodes',
          'rejectedCount',
          'requestId',
          'roleId',
          'routerVersion',
          'selectedModelKey',
          'selectionMode',
          'taskId',
          'traceId',
        ].sort(),
      );
      expect(JSON.stringify(event.payload)).not.toMatch(/secret|credential|apiKey|prompt/i);
    }
    const created = h.events.at(-1)?.payload;
    expect(created?.selectedModelKey).toBe('model-b');
    expect(created?.reasonCodes).toContain('PREFERRED_MODEL');
    void model;
  });

  it('AC: the no-candidate path audits router.no_candidate and never fabricates a model', async () => {
    const h = harness();
    await run(h, viewOf({ blockedModels: ['model-a', 'model-b'] }), [MODEL('model-a'), MODEL('model-b')]);
    expect(h.events.map((event) => event.type)).toContain('router.no_candidate');
    expect(h.events.every((event) => event.payload.selectedModelKey === null)).toBe(true);
  });
});

describe('AD–AH. override and fallback contract (never executed)', () => {
  it('AD/AE: a legal override is accepted, a blocked override is refused', async () => {
    const h = harness();
    const model = await run(h, viewOf(), [MODEL('model-a'), MODEL('model-b')]);
    const legal = applyHumanOverride({
      recommendation: { selectedModelKey: model.selectedModelKey, traceId: model.traceId, routerVersion: model.routerVersion },
      userModelKey: model.selectedModelKey === 'model-a' ? 'model-b' : 'model-a',
      policyView: viewOf(),
      records: [MODEL('model-a'), MODEL('model-b')],
    });
    expect(legal.accepted).toBe(true);
    expect(legal.agreement).toBe('DIFFERENT_FROM_RECOMMENDATION');
    const refused = applyHumanOverride({
      recommendation: { selectedModelKey: model.selectedModelKey, traceId: model.traceId, routerVersion: model.routerVersion },
      userModelKey: 'model-b',
      policyView: viewOf({ blockedModels: ['model-b'] }),
      records: [MODEL('model-a'), MODEL('model-b')],
    });
    expect(refused.accepted).toBe(false);
  });

  it('AF/AG/AH: the fallback contract is produced but never executed', async () => {
    const candidates = [MODEL('model-a'), MODEL('model-b')];
    expect(decideFallback({ fallbackPolicy: 'NEVER', candidates }).action).toBe('STOP');
    expect(decideFallback({ fallbackPolicy: 'ASK', candidates }).action).toBe('ASK_USER');
    const auto = decideFallback({ fallbackPolicy: 'AUTO_WITHIN_POLICY', candidates });
    expect(auto.action).toBe('AUTOMATIC_WITHIN_CANDIDATES');
    expect(auto.candidateSet).toEqual(['model-a', 'model-b']);

    const h = harness();
    const autoView = viewOf({ allowFallback: 'AUTO_WITHIN_POLICY' });
    const model = await run(h, autoView, candidates);
    const contract = h.router.fallbackContract(request(autoView, candidates), { ok: true, value: model });
    expect(contract?.action).toBe('AUTOMATIC_WITHIN_CANDIDATES');
    // The engine router source never executes a fallback: no runtime/provider reference at all.
    const routerSource = source('packages/engine/src/router/deterministic-router.ts');
    expect(routerSource).not.toMatch(/executeFallback|fallbackAndRun|agentRuntime\.execute/);
  });

  it('AI/AT: the router being unavailable never blocks MANUAL and never silently falls back', () => {
    expect(routerUnavailableOutcome({ selectionMode: 'MANUAL' })).toBe('MANUAL_NOT_ROUTED');
    expect(routerUnavailableOutcome({ selectionMode: 'AUTO' })).toBe('ROUTER_NOT_AVAILABLE');
    expect(routerUnavailableOutcome({ selectionMode: 'HYBRID' })).toBe('ROUTER_NOT_AVAILABLE');
  });
});

describe('AJ–AQ. boundaries: runtime, providers, vendors, ranking input, tampering, closed codes', () => {
  it('AJ/AK/AL: Runtime still does not choose models, and the router calls no provider or runtime', () => {
    const runtime = source('packages/engine/src/runtime/agent-runtime.ts');
    expect(runtime).not.toMatch(/createDeterministicModelRouter|rankCandidates|RouterPolicyView/);
    expect(runtime).toMatch(/MODEL_SELECTION_REQUIRED/);
    const routerSource = source('packages/engine/src/router/deterministic-router.ts');
    expect(routerSource).not.toMatch(/ProviderRegistry|providerRegistry|\.invoke\(/);
    expect(routerSource).not.toMatch(/agent-runtime|AgentRuntime/);
    // The engine entry point exposes the router without pulling in the runtime.
    expect(source('packages/engine/src/index.ts')).toMatch(/deterministic-router/);
  });

  it('AM: no vendor names anywhere in the router implementation', () => {
    for (const file of [
      'packages/engine/src/router/deterministic-router.ts',
      'packages/core/src/domain/model-router-ranking.ts',
    ]) {
      const code = source(file).toLowerCase();
      for (const vendor of ['openai', 'anthropic', 'claude', 'deepseek', 'gemini', 'kimi', 'ollama']) {
        expect(code, `${file} must not mention ${vendor}`).not.toContain(vendor);
      }
    }
  });

  it('AN: benchmark weight is capped well below a dominating share', () => {
    expect(ROUTER_V1_WEIGHTS['benchmarkMetadata']).toBeLessThanOrEqual(0.15);
    const total = Object.values(ROUTER_V1_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(Number(total.toFixed(10))).toBe(1);
  });

  it('AO: ranking takes the branded candidate set only', () => {
    const candidates = [MODEL('model-a')];
    // @ts-expect-error a raw ModelRecord[] is not a FilteredCandidateSet.
    expect(() => rankCandidates(candidates, { estimatedInputTokens: 1, requiredOutputTokens: null, preferredModels: [] })).not.toThrow();
    expect(typeof assertRankingInput).toBe('function');
  });

  it('AP: a tampered policy view is refused before any ranking happens', async () => {
    const h = harness();
    const honest = viewOf({ blockedModels: ['model-b'] });
    const tampered = { ...honest, blockedModels: [] } as RouterPolicyView;
    expect(assertDerivedPolicyView(tampered).ok).toBe(false);
    const outcome = await h.router.recommend(request(tampered, [MODEL('model-a')]));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('VALIDATION_FAILED');
    expect(h.events.map((event) => event.type)).not.toContain('router.recommendation_created');
  });

  it('AQ: reason codes stay inside the closed catalog', async () => {
    const h = harness();
    const model = await run(h, viewOf(), [MODEL('model-a')]);
    const all = [...ROUTER_POSITIVE_REASONS, ...ROUTER_REJECTION_REASONS];
    for (const code of model.reasonCodes) expect(all).toContain(code);
    for (const entry of model.rejectedCandidates) for (const code of entry.reasons) expect(all).toContain(code);
  });
});

describe('AR–AS. persistence and traceability', () => {
  it('AR/AS: the decision is persisted with everything needed to explain it later', async () => {
    const h = harness({ ranking: () => ({ providerHealth: { 'provider-a': 'healthy' } }) });
    const model = await run(h, viewOf({ preferredModels: ['model-b'] }), [MODEL('model-a'), MODEL('model-b')]);
    expect(h.saved).toHaveLength(1);
    const record = h.saved[0];
    expect(record?.selectedModelKey).toBe('model-b');
    expect(record?.routerVersion).toBe('model-router/v1');
    expect(record?.policySnapshotVersion).toBe(model.policySource.snapshotVersion);
    expect(record?.modelRegistryRevision).toBe('registry-rev-10b');
    expect(record?.createdAt).toBe('2027-06-01T10:00:00.000Z');
    expect(record?.traceId).toBe('trace_10b');
    // 10B.1 §十二: the persisted detail is a BOUNDED object (counts + truncation flag), not a list.
    const evaluations = JSON.parse(record?.candidateEvaluationsJson ?? '{}') as {
      readonly totalCandidateCount: number;
      readonly storedEvaluationCount: number;
      readonly truncated: boolean;
      readonly evaluations: readonly {
        readonly modelKey: string;
        readonly normalisedScore: number;
        readonly signalScores: readonly { readonly key: string }[];
      }[];
    };
    expect(evaluations.evaluations[0]?.modelKey).toBe('model-b');
    expect(evaluations.evaluations[0]?.signalScores.length).toBeGreaterThan(0);
    expect(evaluations.totalCandidateCount).toBe(2);
    expect(evaluations.storedEvaluationCount).toBe(2);
    expect(evaluations.truncated).toBe(false);
    // No secrets or prompt text can be persisted (SQL comments are stripped before the check).
    expect(record?.candidateEvaluationsJson).not.toMatch(/secret|prompt|apiKey/i);
    const migrationSql = source('packages/persistence/migrations/router/0001_router_decisions.sql')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(migrationSql).not.toMatch(/secret|prompt|api_key/i);
    expect(migrationSql).toMatch(/CREATE TABLE IF NOT EXISTS router_decisions/);
  });

  it('AR: the router decision store is exposed by the persistence package', () => {
    const persistence = source('packages/persistence/src/durable/index.ts');
    expect(persistence).toMatch(/router/);
    expect(source('packages/persistence/src/durable/sqlite-router-decisions.ts')).toMatch(
      /createSqliteRouterDecisionStore/,
    );
    // 10B.1 §十一: no silent decision_id conflict.
    expect(source('packages/persistence/src/durable/sqlite-router-decisions.ts')).not.toMatch(
      /ON CONFLICT\(decision_id\) DO NOTHING/,
    );
  });
});
