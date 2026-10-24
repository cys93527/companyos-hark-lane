/**
 * Sprint 10A.0.2 tests A–R: Router Contract Hardening.
 *
 * Each test targets one invariant the review found to be "documented but not enforced":
 * A–E the MANUAL gate, F–H the single ranking catalog, I the honest latency contract,
 * J–M recommendation invariants, N–O the branded candidate set, P one policy interpretation,
 * Q the reason-code producer catalog, R determinism.
 *
 * Still design-only: nothing here selects a model.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  HARD_FILTER_EMITTED_REASONS,
  LATENCY_FILTER_MODE,
  RANKING_HARD_CONSTRAINTS,
  REASON_CODE_PRODUCERS,
  ROUTER_POSITIVE_REASONS,
  ROUTER_REASON_PRODUCERS,
  ROUTER_REJECTION_REASONS,
  ROUTER_V1_RANKING,
  ROUTER_V1_WEIGHTS,
  ROUTER_VERSION,
  V1_NOT_RANKED_MARKER,
  V1_NOT_RANKED_SIGNALS,
  applyHardFilters,
  assertRankingInput,
  assertRouterRequestAllowed,
  createPolicy,
  deriveRouterPolicyView,
  manualOutcome,
  reasonProducerOf,
  routerV1Policy,
  validateRecommendation,
  type FilteredCandidateSet,
  type ModelRecord,
  type ModelRecommendation,
  type RouterPolicyView,
  type RouterRequest,
} from '@companyos/core';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const source = (path: string): string => readFileSync(repo(path), 'utf8');
/** Strip comments so a comment ABOUT an old rule cannot be mistaken for the rule itself. */
const codeOnly = (value: string): string =>
  value
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");

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

const view = (fields: Record<string, unknown> = {}): RouterPolicyView =>
  deriveRouterPolicyView({
    policy: (() => {
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
    })(),
    snapshotVersion: 'COMPANY:*@digest-1',
    generatedAt: '2027-01-01T00:00:00.000Z',
  });

const request = (overrides: Partial<RouterRequest> = {}): RouterRequest => ({
  requestId: 'req_hard',
  companyId: 'company_default',
  taskId: 'tsk_1',
  roleId: 'role_developer',
  selectionMode: 'AUTO',
  policyView: view(),
  estimatedInputTokens: 100,
  candidateModels: [MODEL('model-a'), MODEL('model-b')],
  traceId: 'trace_hard',
  ...overrides,
});

describe('A–E. the MANUAL gate is enforceable, not a doc promise', () => {
  it('A: selectionMode MANUAL is refused before anything else', () => {
    const verdict = assertRouterRequestAllowed(request({ selectionMode: 'MANUAL' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error.code).toBe('MANUAL_NOT_ROUTED');
      expect(verdict.error.details['decision']).toBe('MANUAL_NOT_ROUTED');
    }
    // …and the hard-filter entry point refuses for the same reason (entrance order).
    const filtered = applyHardFilters(request({ selectionMode: 'MANUAL' }));
    expect(filtered.ok).toBe(false);
    if (!filtered.ok) expect(filtered.error.code).toBe('MANUAL_NOT_ROUTED');
  });

  it('B: a manualModelKey refuses the router even when the mode claims AUTO', () => {
    const verdict = assertRouterRequestAllowed(request({ selectionMode: 'AUTO', manualModelKey: 'model-a' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe('MANUAL_NOT_ROUTED');
    const hybrid = applyHardFilters(request({ selectionMode: 'HYBRID', manualModelKey: 'model-b' }));
    expect(hybrid.ok).toBe(false);
  });

  it('C: a MANUAL policy view refuses routing', () => {
    const manualView = view({ mode: 'MANUAL', manualModelKey: 'model-a' });
    expect(manualView.source.mode).toBe('MANUAL');
    const verdict = assertRouterRequestAllowed(request({ policyView: manualView }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe('MANUAL_NOT_ROUTED');
  });

  it('D/E: AUTO and HYBRID requests are allowed', () => {
    expect(assertRouterRequestAllowed(request({ selectionMode: 'AUTO' })).ok).toBe(true);
    const hybrid = assertRouterRequestAllowed(request({ selectionMode: 'HYBRID' }));
    expect(hybrid.ok).toBe(true);
  });

  it('the ADR freezes the entrance rule, and the port declares it', () => {
    const adr = source('docs/adr/0014-model-router-architecture.md');
    expect(adr).toMatch(/assertRouterRequestAllowed/);
    const port = source('packages/core/src/ports/model-router.ts');
    expect(port).toMatch(/assertRouterRequestAllowed|MANUAL_NOT_ROUTED|MANUAL/);
  });
});

describe('D–E. tampered policy views cannot reach the pipeline', () => {
  const tamperedCases: readonly [string, (v: RouterPolicyView) => RouterPolicyView][] = [
    ['blockedModels', (v) => ({ ...v, blockedModels: [] })],
    ['allowedModels', (v) => ({ ...v, allowedModels: ['model-b'] })],
    ['allowedProviders', (v) => ({ ...v, allowedProviders: ['provider-z'] })],
    ['maxCost', (v) => ({ ...v, maxCost: 99 })],
    ['maxLatency', (v) => ({ ...v, maxLatency: 5 })],
    ['requiredCapabilities', (v) => ({ ...v, requiredCapabilities: [] })],
    ['derivedBy', (v) => ({ ...v, derivedBy: 'caller' }) as unknown as RouterPolicyView],
    ['digest', (v) => ({ ...v, digest: 'forged' })],
  ];

  for (const [label, mutate] of tamperedCases) {
    it(`D: a view with tampered ${label} is refused`, () => {
      const honest = view({
        mode: 'AUTO',
        blockedModels: ['model-b'],
        maxCost: 3,
        maxLatency: 500,
        requiredCapabilities: ['streaming'],
      });
      const result = applyHardFilters(request({ policyView: honest }));
      expect(result.ok).toBe(true);

      const broken = mutate(honest);
      const refused = applyHardFilters(request({ policyView: broken }));
      expect(refused.ok, `tampering ${label} must be refused`).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe('VALIDATION_FAILED');
    });
  }

  it('E: an honest derived view passes and carries the branded candidate set', () => {
    const outcome = applyHardFilters(request({ policyView: view({ blockedModels: ['model-b'] }) }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.candidates.map((model) => model.modelKey)).toEqual(['model-a']);
    expect(assertRankingInput(outcome.value.candidates).map((model) => model.modelKey)).toEqual(['model-a']);
    expect(outcome.value.latencyFilter).toBe(LATENCY_FILTER_MODE);
  });
});

describe('F–H. one authoritative ranking catalog', () => {
  it('F: only ROUTER_V1_RANKING exists, in the frozen order', () => {
    const core = codeOnly(source('packages/core/src/domain/model-router.ts'));
    // The old 10-signal list (with the conflicting NEUTRAL vocabulary) is gone.
    expect(core).not.toMatch(/export const RANKING_SIGNALS\b/);
    expect(core).not.toMatch(/NEUTRAL/);
    expect(ROUTER_V1_RANKING.map((signal) => signal.key)).toEqual([
      'preferredModelsPosition',
      'providerHealth',
      'contextHeadroom',
      'estimatedCost',
      'estimatedLatency',
      'historicalSuccessRate',
      'benchmarkMetadata',
    ]);
    // Signals v1 does not rank are marked, not mixed in.
    expect(V1_NOT_RANKED_SIGNALS.map((entry) => entry.key)).toEqual([
      'requiredCapabilityFit',
      'reviewPassRate',
      'reworkRate',
    ]);
    expect(V1_NOT_RANKED_MARKER).toBe('V1_NOT_RANKED');
    for (const entry of V1_NOT_RANKED_SIGNALS) {
      expect(entry.marker).toBe(V1_NOT_RANKED_MARKER);
      expect(entry.note.length).toBeGreaterThan(0);
    }
    for (const signal of ROUTER_V1_RANKING) {
      expect(V1_NOT_RANKED_SIGNALS.map((entry) => entry.key as string)).not.toContain(signal.key);
    }
    // Hard constraints are stages, not signals.
    expect([...RANKING_HARD_CONSTRAINTS]).toEqual([
      'ENABLED_FILTER',
      'AVAILABILITY_FILTER',
      'PROVIDER_ALLOWED_FILTER',
      'BLOCKED_MODELS_FILTER',
      'REQUIRED_CAPABILITIES_FILTER',
      'CONTEXT_WINDOW_FILTER',
      'MAX_OUTPUT_FILTER',
      'COST_CONSTRAINT',
      'RISK_ROLE_CONSTRAINTS',
    ]);
  });

  it('G: the frozen weights sum to 1.00 with benchmark at its cap', () => {
    expect(ROUTER_V1_WEIGHTS).toEqual({
      preferredModelsPosition: 0.25,
      providerHealth: 0.2,
      contextHeadroom: 0.15,
      estimatedCost: 0.15,
      estimatedLatency: 0.1,
      historicalSuccessRate: 0.05,
      benchmarkMetadata: 0.1,
    });
    const total = Object.values(ROUTER_V1_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(Number(total.toFixed(10))).toBe(1);
    expect(ROUTER_V1_WEIGHTS['benchmarkMetadata']).toBeLessThanOrEqual(routerV1Policy().benchmarkWeightCap);
    for (const signal of ROUTER_V1_RANKING) expect(signal.canBreakHardFilter).toBe(false);
  });

  it('H: the only missing-data policy is SKIP_AND_RENORMALISE', () => {
    for (const signal of ROUTER_V1_RANKING) expect(signal.missing).toBe('SKIP_AND_RENORMALISE');
    const core = codeOnly(source('packages/core/src/domain/model-router.ts'));
    expect(source('packages/core/src/domain/model-router.ts')).toMatch(/SKIP_AND_RENORMALISE/);
    expect(core).not.toMatch(/NEUTRAL/);
  });
});

describe('I. the latency stage is honestly a no-op', () => {
  it('declares NO_DATA_NO_HARD_FILTER and never emits LATENCY_LIMIT_EXCEEDED', () => {
    expect(LATENCY_FILTER_MODE).toBe('NO_DATA_NO_HARD_FILTER');
    const core = source('packages/core/src/domain/model-router.ts');
    // The reason code exists but is declared FUTURE-produced…
    expect(core).toMatch(/LATENCY_LIMIT_EXCEEDED: 'FUTURE'/);
    expect(reasonProducerOf('LATENCY_LIMIT_EXCEEDED')).toBe('FUTURE');
    // …and no rule throws it.
    expect(HARD_FILTER_EMITTED_REASONS as readonly string[]).not.toContain('LATENCY_LIMIT_EXCEEDED');
    // A policy with maxLatency must not reject any candidate in v1.
    const outcome = applyHardFilters(request({ policyView: view({ maxLatency: 1 }) }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.candidates).toHaveLength(2);
      expect(outcome.value.rejected).toEqual([]);
    }
  });
});

describe('J–M. recommendation invariants', () => {
  const base = (overrides: Partial<ModelRecommendation> = {}): ModelRecommendation => ({
    selectedModelKey: null,
    decision: 'RECOMMENDED',
    reasonCodes: [],
    rejectedCandidates: [],
    candidateEvaluations: [],
    rejectionSummary: null,
    policySource: view().source,
    selectionMode: 'AUTO',
    fallbackPolicy: 'NEVER',
    estimatedCost: null,
    estimatedLatency: null,
    confidence: null,
    routerVersion: ROUTER_VERSION,
    traceId: 'trace_hard',
    provenance: {
      routerVersion: ROUTER_VERSION,
      policySnapshotVersion: 'COMPANY:*@digest-1',
      modelRegistryRevision: 'rev-1',
      benchmarkVersion: null,
      performanceSnapshot: null,
    },
    ...overrides,
  });

  it('J/K: RECOMMENDED without a model or without positive reasons is invalid', () => {
    expect(validateRecommendation(base()).ok).toBe(false);
    const noReasons = base({ selectedModelKey: 'model-a', reasonCodes: [] });
    const verdict = validateRecommendation(noReasons);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error.code).toBe('RECOMMENDATION_INVALID');
      expect(verdict.error.details['reason']).toContain('positive reason');
    }
    const good = base({ selectedModelKey: 'model-a', reasonCodes: ['PREFERRED_MODEL'] });
    expect(validateRecommendation(good).ok).toBe(true);
  });

  it('L: NO_ELIGIBLE_MODEL must not carry a selected model and needs a summary', () => {
    const withModel = base({ decision: 'NO_ELIGIBLE_MODEL', selectedModelKey: 'model-a' });
    expect(validateRecommendation(withModel).ok).toBe(false);
    const withoutSummary = base({ decision: 'NO_ELIGIBLE_MODEL' });
    expect(validateRecommendation(withoutSummary).ok).toBe(false);
    const good = base({
      decision: 'NO_ELIGIBLE_MODEL',
      rejectedCandidates: [{ modelKey: 'model-a', reasons: ['MODEL_DISABLED'] }],
    });
    expect(validateRecommendation(good).ok).toBe(true);
  });

  it('M: AWAITING_CONFIRMATION requires ASK, and the manual/unavailable decisions stay clean', () => {
    expect(validateRecommendation(base({ decision: 'AWAITING_CONFIRMATION', fallbackPolicy: 'ASK' })).ok).toBe(true);
    const wrongFallback = base({ decision: 'AWAITING_CONFIRMATION', fallbackPolicy: 'NEVER' });
    expect(validateRecommendation(wrongFallback).ok).toBe(false);

    expect(validateRecommendation(base({ decision: 'MANUAL_NOT_ROUTED' })).ok).toBe(true);
    expect(validateRecommendation(base({ decision: 'MANUAL_NOT_ROUTED', selectedModelKey: 'model-a' })).ok).toBe(false);
    expect(validateRecommendation(base({ decision: 'ROUTER_NOT_AVAILABLE' })).ok).toBe(true);
    expect(
      validateRecommendation(base({ decision: 'ROUTER_NOT_AVAILABLE', selectedModelKey: 'model-a' })).ok,
    ).toBe(false);
    expect(
      validateRecommendation(
        base({ decision: 'REFUSED_HARD_BLOCK', rejectedCandidates: [{ modelKey: 'model-a', reasons: ['MODEL_BLOCKED'] }] }),
      ).ok,
    ).toBe(true);
    expect(validateRecommendation(base({ decision: 'REFUSED_HARD_BLOCK' })).ok).toBe(false);
    // The positive reason catalog is what a caller renders; it must contain the code we used.
    expect(ROUTER_POSITIVE_REASONS).toContain('PREFERRED_MODEL');
  });

  it('the port asks implementations to validate before returning', () => {
    const port = source('packages/core/src/ports/model-router.ts');
    const core = source('packages/core/src/domain/model-router.ts');
    expect(core).toMatch(/export function validateRecommendation/);
    expect(port).toMatch(/recommend\(request: RouterRequest\)/);
  });
});

describe('N–O. the branded candidate set', () => {
  it('N: only applyHardFilters produces a FilteredCandidateSet, and it is branded', () => {
    const outcome = applyHardFilters(request());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const set: FilteredCandidateSet = outcome.value.candidates;
    expect(assertRankingInput(set).map((model) => model.modelKey)).toEqual(['model-a', 'model-b']);
    // The brand is nominal, not structural: the runtime value is an array-like with no extra copy.
    expect(Array.isArray(set)).toBe(true);
    expect(Object.keys(set)).toEqual(['0', '1']);
    const core = source('packages/core/src/domain/model-router.ts');
    expect(core).toMatch(/declare const FILTERED_CANDIDATE_SET: unique symbol/);
    // @ts-expect-error a raw ModelRecord[] is NOT assignable to the branded set (LOW-2).
    assertRankingInput([MODEL('model-a')]);
  });

  it('O: a rejected model is absent from the branded set (no path back into ranking)', () => {
    const outcome = applyHardFilters(request({ policyView: view({ blockedModels: ['model-b'] }) }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const keys = assertRankingInput(outcome.value.candidates).map((model) => model.modelKey);
    expect(keys).toEqual(['model-a']);
    expect(outcome.value.rejected.map((entry) => entry.modelKey)).toContain('model-b');
    expect(keys.some((key) => outcome.value.rejected.some((entry) => entry.modelKey === key))).toBe(false);
  });
});

describe('P–R. one policy interpretation, the producer catalog and determinism', () => {
  it('P: manual, override and the router all read the same derived view', () => {
    const core = codeOnly(source('packages/core/src/domain/model-router.ts'));
    // Both manual paths now feed the DERIVED view into the shared verdict function.
    expect(core).toMatch(/policy: input\.request\.policyView/);
    expect(core).toMatch(/policy: input\.policyView/);
    // The MANUAL gate lives in assertRouterRequestAllowed (manualOutcome is the MANUAL contract
    // and is *supposed* to succeed for a legal manual choice).
    const gated = assertRouterRequestAllowed(request({ selectionMode: 'AUTO', manualModelKey: 'model-b' }));
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.error.code).toBe('MANUAL_NOT_ROUTED');
    const legalManual = manualOutcome({ request: request({ manualModelKey: 'model-b' }) });
    expect(legalManual.ok).toBe(true);
    // A blocked model in the VIEW is refused for MANUAL too (same verdict function, same view).
    const blocked = manualOutcome({
      request: request({ manualModelKey: 'model-b', policyView: view({ blockedModels: ['model-b'] }) }),
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.details['refusals']).toContain('MODEL_BLOCKED_BY_POLICY');
    // And the port no longer offers a second policy shape to callers.
    const port = source('packages/core/src/ports/model-router.ts');
    expect(port).not.toMatch(/ModelSelectionPolicy/);
  });

  it('Q: every reason code declares exactly one producer', () => {
    const all = [...ROUTER_POSITIVE_REASONS, ...ROUTER_REJECTION_REASONS];
    expect(Object.keys(ROUTER_REASON_PRODUCERS).sort()).toEqual([...all].sort());
    for (const code of all) {
      expect(reasonProducerOf(code)).toBeDefined();
      expect(REASON_CODE_PRODUCERS).toContain(reasonProducerOf(code));
    }
    expect(ROUTER_REASON_PRODUCERS['MODEL_NOT_REGISTERED']).toBe('PROVIDER_LAYER');
    expect(ROUTER_REASON_PRODUCERS['PROVIDER_UNAVAILABLE']).toBe('PROVIDER_LAYER');
    expect(ROUTER_REASON_PRODUCERS['LATENCY_LIMIT_EXCEEDED']).toBe('FUTURE');
    // The codes the hard filters really emit are all attributed to HARD_FILTER.
    for (const code of HARD_FILTER_EMITTED_REASONS) {
      expect(ROUTER_REASON_PRODUCERS[code]).toBe('HARD_FILTER');
    }
  });

  it('R: the same semantic inputs produce the same view and the same outcome', () => {
    const first = view({ blockedModels: ['model-z'] });
    const second = view({ blockedModels: ['model-z'] });
    expect(first.digest).toBe(second.digest);
    expect(first).toEqual(second);

    const a = applyHardFilters(request({ policyView: first }));
    const b = applyHardFilters(request({ policyView: second }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
    // A different generatedAt (provenance only) must NOT change the digest or the outcome.
    const laterTimestamp = deriveRouterPolicyView({
      policy: (() => {
        const built = createPolicy({
          id: 'COMPANY:*',
          scopeType: 'COMPANY',
          scopeId: '*',
          mode: 'AUTO',
          blockedModels: ['model-z'],
          createdBy: 'user_owner',
          now: '2027-01-01T00:00:00.000Z',
        });
        if (!built.ok) throw new Error('unexpected');
        return built.value;
      })(),
      snapshotVersion: 'COMPANY:*@digest-1',
      generatedAt: '2030-12-31T23:59:59.000Z',
    });
    expect(laterTimestamp.digest).toBe(first.digest);
    expect(laterTimestamp.source.generatedAt).not.toBe(first.source.generatedAt);
  });
});
