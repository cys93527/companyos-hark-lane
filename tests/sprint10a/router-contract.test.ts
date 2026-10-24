/**
 * Sprint 10A tests A–S: the Model Router CONTRACT.
 *
 * These lock the frozen rules (pipeline order, hard-vs-ranking separation, precedence, fallback,
 * explainability, tie-break, versioning, override) and prove that Sprint 10A shipped **no
 * implementation**: no selection, no ranking, no provider/runtime involvement, no LLM-as-router.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BENCHMARK_WEIGHT_CAP,
  HISTORICAL_MIN_SAMPLE,
  ROUTER_HARD_FILTER_STAGES,
  ROUTER_PIPELINE,
  ROUTER_PRESENTATION_STAGES,
  ROUTER_REJECTION_REASONS,
  ROUTER_VERSION,
  TIE_BREAK_KEYS,
  applyHardFilters,
  applyHumanOverride,
  compareTieBreak,
  createPolicy,
  decideFallback,
  deriveRouterPolicyView,
  effectiveBenchmarkWeight,
  manualOutcome,
  noCandidateOutcome,
  overrideRecord,
  routerAppliesTo,
  routerUnavailableOutcome,
  sampleConfidence,
  tieBreakContract,
  type HardFilterOutcome,
  type ModelRecord,
  type ModelSelectionPolicy,
  type RouterRequest,
} from '@companyos/core';

const repo = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const source = (path: string): string => readFileSync(repo(path), 'utf8');
const codeOnly = (value: string): string =>
  value
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

const MODEL = (overrides: Partial<ModelRecord> & { readonly modelKey: string }): ModelRecord => {
  const key = overrides.modelKey;
  return {
    id: key,
    providerId: 'provider-a',
    providerModelId: key,
    displayName: key,
    description: '',
    capabilities: {
      streaming: true,
      structuredOutput: false,
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
    ...overrides,
    modelKey: key,
  };
};

/** A real (derived) policy: the router never sees a hand-assembled view (STEP 3). */
const policyWith = (fields: Record<string, unknown>): ModelSelectionPolicy => {
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

/** Unwrap a hard-filter Result on the success path (refusals are asserted explicitly). */
const filterOrThrow = (req: RouterRequest): HardFilterOutcome => {
  const outcome = applyHardFilters(req);
  if (!outcome.ok) throw new Error(`unexpected hard-filter refusal: ${outcome.error.message}`);
  return outcome.value;
};

const request = (
  overrides: Partial<RouterRequest> = {},
  policy: ModelSelectionPolicy | null = null,
): RouterRequest => ({
  requestId: 'req_1',
  companyId: 'company_default',
  taskId: 'tsk_1',
  roleId: 'role_developer',
  selectionMode: 'AUTO',
  // STEP 3: the view is DERIVED, never hand-assembled.
  policyView: deriveRouterPolicyView({ policy, snapshotVersion: 'policy-snapshot/1' }),
  estimatedInputTokens: 100,
  candidateModels: [MODEL({ modelKey: 'model-a' }), MODEL({ modelKey: 'model-b' })],
  traceId: 'trace_1',
  ...overrides,
});

/* ------------------------------------------------------------------ A/B/C --- */

describe('A. MANUAL never reaches the router', () => {
  it('the contract says so, and a manual outcome is never a routing decision', () => {
    expect(routerAppliesTo('MANUAL')).toBe(false);
    expect(routerAppliesTo('AUTO')).toBe(true);
    expect(routerAppliesTo('HYBRID')).toBe(true);

    const withoutKey = manualOutcome({ request: request({ selectionMode: 'MANUAL', manualModelKey: null }) });
    expect(withoutKey.ok).toBe(false);
    if (!withoutKey.ok) expect(withoutKey.error.code).toBe('MODEL_SELECTION_REQUIRED');

    const withKey = manualOutcome({
      request: request({ selectionMode: 'MANUAL', manualModelKey: 'model-a' }),
    });
    expect(withKey.ok).toBe(true);
    if (withKey.ok) {
      expect(withKey.value.decision).toBe('MANUAL_NOT_ROUTED');
      expect(withKey.value.selectedModelKey).toBe('model-a');
    }
  });
});

describe('B/C. explicit choice precedence and the hard block', () => {
  it('B: a legal explicit choice wins over the policy range', () => {
    const policy = createPolicy({
      id: 'COMPANY:*',
      scopeType: 'COMPANY',
      scopeId: '*',
      mode: 'HYBRID',
      allowedModels: ['model-a'],
      createdBy: 'user_owner',
      now: '2027-01-01T00:00:00.000Z',
    });
    if (!policy.ok) throw new Error('unexpected');
    const outcome = manualOutcome({
      request: request({ selectionMode: 'MANUAL', manualModelKey: 'model-b' }, policy.value),
      explicit: true,
    });
    // model-b is outside allowedModels, but an explicit choice outranks the policy RANGE.
    expect(outcome.ok).toBe(true);
  });

  it('C: blockedModels is a hard block even for an explicit choice', () => {
    const policy = createPolicy({
      id: 'COMPANY:*',
      scopeType: 'COMPANY',
      scopeId: '*',
      mode: 'HYBRID',
      blockedModels: ['model-b'],
      createdBy: 'user_owner',
      now: '2027-01-01T00:00:00.000Z',
    });
    if (!policy.ok) throw new Error('unexpected');
    const outcome = manualOutcome({
      request: request({ selectionMode: 'MANUAL', manualModelKey: 'model-b' }, policy.value),
      explicit: true,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('POLICY_DENIED');
      expect(outcome.error.details['refusals']).toContain('MODEL_BLOCKED_BY_POLICY');
    }

    // …and the pipeline rejects it too, so it can never become a candidate.
    const filtered = filterOrThrow(request({}, policy.value));
    expect(filtered.candidates.map((model) => model.modelKey)).toEqual(['model-a']);
    expect(filtered.rejected).toEqual([{ modelKey: 'model-b', reasons: ['MODEL_BLOCKED'] }]);
  });
});

/* ------------------------------------------------------------------ D/E/F --- */

describe('D/E/F. hybrid bounds, auto policy and the hard-filter guarantee', () => {
  it('D: HYBRID cannot leave the allowed set, and fallback stays inside it', () => {
    const hybrid = createPolicy({
      id: 'WORKFLOW:wfl_1',
      scopeType: 'WORKFLOW',
      scopeId: 'wfl_1',
      mode: 'HYBRID',
      allowedModels: ['model-a'],
      allowedProviders: ['provider-a'],
      createdBy: 'user_owner',
      now: '2027-01-01T00:00:00.000Z',
    });
    if (!hybrid.ok) throw new Error('unexpected');
    const filtered = filterOrThrow(
      request(
        {
          selectionMode: 'HYBRID',
          candidateModels: [MODEL({ modelKey: 'model-a' }), MODEL({ modelKey: 'model-b', providerId: 'provider-b' })],
        },
        hybrid.value,
      ),
    );
    expect(filtered.candidates.map((model) => model.modelKey)).toEqual(['model-a']);
    const rejection = filtered.rejected.find((entry) => entry.modelKey === 'model-b');
    expect(rejection?.reasons).toContain('PROVIDER_NOT_ALLOWED');

    const fallback = decideFallback({ fallbackPolicy: 'AUTO_WITHIN_POLICY', candidates: filtered.candidates });
    expect(fallback.action).toBe('AUTOMATIC_WITHIN_CANDIDATES');
    expect(fallback.candidateSet).toEqual(['model-a']);
    // Never a cross-policy substitution: the set is exactly what survived the hard filters.
    expect(fallback.candidateSet.every((key) => filtered.candidates.some((model) => model.modelKey === key))).toBe(true);
  });

  it('E: AUTO is still bounded by company/workflow/role/task policy inputs', () => {
    const filtered = filterOrThrow(
      request(
        {
          candidateModels: [
            MODEL({ modelKey: 'model-cheap', pricing: { inputPerMillion: 1, outputPerMillion: 1, currency: 'USD' } }),
            MODEL({ modelKey: 'model-pricey', pricing: { inputPerMillion: 9, outputPerMillion: 9, currency: 'USD' } }),
          ],
        },
        policyWith({ maxCost: 3 }),
      ),
    );
    expect(filtered.candidates.map((model) => model.modelKey)).toEqual(['model-cheap']);
    expect(filtered.rejected[0]?.reasons).toContain('COST_LIMIT_EXCEEDED');
  });

  it('I: the diversity constraint is a hard filter, not a preference', () => {
    const filtered = filterOrThrow(
      request({
        diversity: {
          constraint: 'DIFFERENT_FROM_PRIOR_ROLE_SELECTION',
          previousModelKeys: ['model-a'],
          priorRoleProviderId: null,
        },
      }),
    );
    // The prior role already took model-a, so only model-b is eligible.
    expect(filtered.candidates.map((model) => model.modelKey)).toEqual(['model-b']);
    expect(filtered.rejected[0]?.reasons).toContain('DIVERSITY_CONFLICT');
  });

  it('F: a rejected model can never come back, and ranking only orders survivors', () => {
    // The stage order is frozen…
    expect([...ROUTER_PIPELINE]).toEqual([
      'ALL_REGISTERED_MODELS',
      'ENABLED_FILTER',
      'AVAILABILITY_FILTER',
      'PROVIDER_ALLOWED_FILTER',
      'BLOCKED_MODELS_FILTER',
      'REQUIRED_CAPABILITIES_FILTER',
      'CONTEXT_WINDOW_FILTER',
      'MAX_OUTPUT_FILTER',
      'COST_CONSTRAINT',
      'LATENCY_CONSTRAINT',
      'RISK_ROLE_CONSTRAINTS',
      'CANDIDATE_SET',
      'ROUTER_RANKING',
      'RECOMMENDATION',
    ]);
    // …hard filters end at CANDIDATE_SET, and only the two stages after it may order.
    expect(ROUTER_HARD_FILTER_STAGES[ROUTER_HARD_FILTER_STAGES.length - 1]).toBe('CANDIDATE_SET');
    expect([...ROUTER_PRESENTATION_STAGES]).toEqual(['ROUTER_RANKING', 'RECOMMENDATION']);

    const filtered = filterOrThrow(
      request({
        candidateModels: [
          MODEL({ modelKey: 'model-off', enabled: false }),
          MODEL({ modelKey: 'model-gone', availability: 'unavailable' }),
          MODEL({ modelKey: 'model-weak' }),
          MODEL({
            modelKey: 'model-ok',
            capabilities: {
              streaming: true,
              structuredOutput: true,
              toolCalling: false,
              vision: false,
              reasoning: false,
              audio: false,
            },
          }),
        ],
      },
        policyWith({ requiredCapabilities: ['structuredOutput'] }),
      ),
    );
    const survivorKeys = filtered.candidates.map((model) => model.modelKey);
    const rejectedKeys = filtered.rejected.map((entry) => entry.modelKey);
    expect(survivorKeys).toEqual(['model-ok']);
    expect(rejectedKeys).toEqual(['model-gone', 'model-off', 'model-weak']);
    // No overlap: a hard-filtered model is not in the candidate set, so no ranking can revive it.
    expect(survivorKeys.some((key) => rejectedKeys.includes(key))).toBe(false);
    for (const reason of filtered.rejected.flatMap((entry) => entry.reasons)) {
      expect(ROUTER_REJECTION_REASONS).toContain(reason);
    }
  });
});

/* ------------------------------------------------------------------ G/H --- */

describe('G/H. no candidate and router unavailable', () => {
  it('G: nothing eligible is NO_ELIGIBLE_MODEL with a rejection summary', () => {
    const filtered = filterOrThrow(
      request(
        {
          candidateModels: [
            MODEL({ modelKey: 'model-blocked' }),
            MODEL({ modelKey: 'model-disabled', enabled: false }),
            MODEL({ modelKey: 'model-down', availability: 'unavailable' }),
          ],
        },
        policyWith({ blockedModels: ['model-blocked'] }),
      ),
    );
    const outcome = noCandidateOutcome(filtered);
    expect(outcome.decision).toBe('NO_ELIGIBLE_MODEL');
    expect(outcome.summary.checked).toBe(3);
    expect(outcome.summary.byReason['MODEL_BLOCKED']).toBe(1);
    expect(outcome.summary.byReason['MODEL_DISABLED']).toBe(1);
    expect(outcome.summary.byReason['MODEL_UNAVAILABLE']).toBe(1);
    expect(outcome.summary.summaryText).toContain('3 models checked');
    // It never guesses a model.
    expect(outputLeak(outcome)).toBe(false);
  });

  function outputLeak(outcome: { readonly summary: { readonly summaryText: string } }): boolean {
    return /selectedModelKey|modelKey:/.test(JSON.stringify(outcome));
  }
});

describe('H/I/J/K. availability and fallback semantics', () => {
  it('H: MANUAL survives a missing router; AUTO/HYBRID without a key do not', () => {
    expect(routerUnavailableOutcome({ selectionMode: 'MANUAL' })).toBe('MANUAL_NOT_ROUTED');
    expect(routerUnavailableOutcome({ selectionMode: 'AUTO' })).toBe('ROUTER_NOT_AVAILABLE');
    expect(routerUnavailableOutcome({ selectionMode: 'HYBRID', manualModelKey: null })).toBe('ROUTER_NOT_AVAILABLE');
    // A named model in HYBRID is executable without the router.
    expect(routerUnavailableOutcome({ selectionMode: 'HYBRID', manualModelKey: 'model-a' })).toBe('MANUAL_NOT_ROUTED');
  });

  it('I: NEVER refuses to provide an automatic substitute', () => {
    const decision = decideFallback({ fallbackPolicy: 'NEVER', candidates: [MODEL({ modelKey: 'model-a' })] });
    expect(decision.action).toBe('STOP');
    expect(decision.candidateSet).toEqual([]);
  });

  it('J: ASK requires a human decision before anything runs', () => {
    const decision = decideFallback({ fallbackPolicy: 'ASK', candidates: [MODEL({ modelKey: 'model-a' })] });
    expect(decision.action).toBe('ASK_USER');
    expect(decision.candidateSet).toEqual([]);
  });

  it('K: AUTO_WITHIN_POLICY never leaves the candidate set', () => {
    const decision = decideFallback({
      fallbackPolicy: 'AUTO_WITHIN_POLICY',
      candidates: [MODEL({ modelKey: 'model-b' }), MODEL({ modelKey: 'model-a' })],
    });
    expect(decision.action).toBe('AUTOMATIC_WITHIN_CANDIDATES');
    expect(decision.candidateSet).toEqual(['model-a', 'model-b']);
  });
});

/* ------------------------------------------------------------------ L/M --- */

describe('L/M. benchmark and historical data are optional signals', () => {
  it('L: the router works with no benchmark data, and the signal is capped', () => {
    // No benchmark metadata at all: the hardened pipeline still produces candidates.
    const filtered = filterOrThrow(request());
    expect(filtered.candidates).toHaveLength(2);

    expect(effectiveBenchmarkWeight(undefined, 0.2)).toBe(0);
    expect(effectiveBenchmarkWeight(null, 0.2)).toBe(0);
    const reference = {
      modelKey: 'model-a',
      score: 0.9,
      suiteId: 'suite',
      benchmarkVersion: 'bench/1',
      source: 'harness' as const,
      recordedAt: '2027-01-01T00:00:00.000Z',
      stale: false,
    };
    expect(effectiveBenchmarkWeight(reference, 0.9)).toBe(BENCHMARK_WEIGHT_CAP);
    expect(effectiveBenchmarkWeight({ ...reference, stale: true }, 0.9)).toBeLessThan(BENCHMARK_WEIGHT_CAP);
    expect(effectiveBenchmarkWeight({ ...reference, source: 'external' }, 0.9)).toBeLessThan(BENCHMARK_WEIGHT_CAP);
    // An external, stale number contributes the least.
    const weakest = effectiveBenchmarkWeight({ ...reference, source: 'external', stale: true }, 0.9);
    expect(weakest).toBeLessThan(effectiveBenchmarkWeight(reference, 0.9));
  });

  it('M: historical data is optional, and small samples are down-weighted', () => {
    expect(sampleConfidence(undefined)).toBe(0);
    expect(sampleConfidence(null)).toBe(0);
    expect(sampleConfidence({ modelKey: 'model-a', successRate: 1, reviewPassRate: null, reworkRate: null, failureRate: null, avgLatencyMs: null, avgCost: null, sampleCount: 0 })).toBe(0);
    const small = sampleConfidence({
      modelKey: 'model-a',
      successRate: 1,
      reviewPassRate: null,
      reworkRate: null,
      failureRate: null,
      avgLatencyMs: null,
      avgCost: null,
      sampleCount: HISTORICAL_MIN_SAMPLE - 5,
    });
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(1);
    const enough = sampleConfidence({
      modelKey: 'model-a',
      successRate: 1,
      reviewPassRate: null,
      reworkRate: null,
      failureRate: null,
      avgLatencyMs: null,
      avgCost: null,
      sampleCount: HISTORICAL_MIN_SAMPLE,
    });
    expect(enough).toBe(1);
  });
});

/* ------------------------------------------------------------------ N/O --- */

describe('N/O. stable tie-break and determinism', () => {
  const facts = (overrides: Partial<Parameters<typeof compareTieBreak>[0]> = {}) => ({
    modelKey: 'model-a',
    preferredPosition: null,
    estimatedCost: null,
    estimatedLatencyMs: null,
    providerHealth: 'healthy' as const,
    ...overrides,
  });

  it('N: the tie-break order is declared and total', () => {
    expect([...tieBreakContract()]).toEqual([...TIE_BREAK_KEYS]);
    expect(compareTieBreak(facts({ preferredPosition: 0 }), facts({ modelKey: 'model-b', preferredPosition: 1 }))).toBeLessThan(0);
    expect(compareTieBreak(facts({ estimatedCost: 1 }), facts({ modelKey: 'model-b', estimatedCost: 2 }))).toBeLessThan(0);
    expect(compareTieBreak(facts({ estimatedLatencyMs: 10 }), facts({ modelKey: 'model-b', estimatedLatencyMs: 20 }))).toBeLessThan(0);
    expect(compareTieBreak(facts({ providerHealth: 'healthy' }), facts({ modelKey: 'model-b', providerHealth: 'degraded' }))).toBeLessThan(0);
    // Lexical modelKey is the final key: it decides when everything else ties.
    expect(compareTieBreak(facts({ modelKey: 'model-a' }), facts({ modelKey: 'model-b' }))).toBeLessThan(0);
    expect(compareTieBreak(facts({ modelKey: 'model-b' }), facts({ modelKey: 'model-b' }))).toBe(0);
  });

  it('O: the same input produces the same outcome', () => {
    const first = applyHardFilters(request({}, policyWith({ maxCost: 3 })));
    const second = applyHardFilters(request({}, policyWith({ maxCost: 3 })));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // …and sorting the survivors with the comparator is likewise stable.
    const left = facts({ modelKey: 'model-a', estimatedCost: 2 });
    const right = facts({ modelKey: 'model-b', estimatedCost: 1 });
    const sortedOnce = [left, right].sort(compareTieBreak).map((entry) => entry.modelKey);
    const sortedTwice = [left, right].sort(compareTieBreak).map((entry) => entry.modelKey);
    expect(sortedOnce).toEqual(sortedTwice);
    expect(sortedOnce).toEqual(['model-b', 'model-a']);
  });
});

/* ------------------------------------------------------------------ P/Q --- */

describe('P/Q. human override and provenance', () => {
  it('P: a legitimate override is accepted and both sides are recorded', () => {
    const policy = createPolicy({
      id: 'COMPANY:*',
      scopeType: 'COMPANY',
      scopeId: '*',
      mode: 'AUTO',
      allowedModels: ['model-a'],
      createdBy: 'user_owner',
      now: '2027-01-01T00:00:00.000Z',
    });
    if (!policy.ok) throw new Error('unexpected');
    const input = {
      recommendation: { selectedModelKey: 'model-a', traceId: 'trace_1', routerVersion: ROUTER_VERSION },
      userModelKey: 'model-b',
      // MEDIUM-5: the override reads the SAME derived view as the router would.
      policyView: deriveRouterPolicyView({ policy: policy.value, snapshotVersion: 'policy-snapshot/1' }),
      records: [MODEL({ modelKey: 'model-a' }), MODEL({ modelKey: 'model-b' })],
    };
    const outcome = applyHumanOverride(input);
    expect(outcome.accepted).toBe(true);
    expect(outcome.agreement).toBe('DIFFERENT_FROM_RECOMMENDATION');
    const record = overrideRecord(input, outcome);
    expect(record.routerRecommendation).toBe('model-a');
    expect(record.userFinalSelection).toBe('model-b');
    expect(record.routerVersion).toBe(ROUTER_VERSION);

    // A blocked override is refused, and the router is not the one blocking it.
    const blocking = createPolicy({
      id: 'COMPANY:*',
      scopeType: 'COMPANY',
      scopeId: '*',
      mode: 'AUTO',
      blockedModels: ['model-b'],
      createdBy: 'user_owner',
      now: '2027-01-01T00:00:00.000Z',
    });
    if (!blocking.ok) throw new Error('unexpected');
    const refused = applyHumanOverride({
      ...input,
      policyView: deriveRouterPolicyView({ policy: blocking.value, snapshotVersion: 'policy-snapshot/2' }),
    });
    expect(refused.accepted).toBe(false);
    expect(refused.refusals).toContain('MODEL_BLOCKED_BY_POLICY');
  });

  it('Q: every recommendation carries its provenance', () => {
    expect(ROUTER_VERSION).toBe('model-router/v1');
    const provenance = {
      routerVersion: ROUTER_VERSION,
      policySnapshotVersion: 'policy-snapshot/1',
      modelRegistryRevision: 'registry-rev-7',
      benchmarkVersion: 'bench/1',
      performanceSnapshot: null,
    };
    for (const key of ['routerVersion', 'policySnapshotVersion', 'modelRegistryRevision', 'benchmarkVersion', 'performanceSnapshot']) {
      expect(Object.keys(provenance)).toContain(key);
    }
  });
});

/* ------------------------------------------------------------------ R/S --- */

describe('R/S. the boundary this sprint promises', () => {
  it('R: neither the runtime nor the tool registry takes over routing', () => {
    const runtime = codeOnly(source('packages/engine/src/runtime/agent-runtime.ts'));
    const tools = codeOnly(source('packages/engine/src/tools/registry.ts'));
    for (const code of [runtime, tools]) {
      expect(code).not.toMatch(/ModelRouterPort/);
      expect(code).not.toMatch(/\.recommend\(/);
      expect(code).not.toMatch(/applyHardFilters/);
    }
    // The runtime still requires an explicit model: the router contract changed nothing there.
    expect(source('packages/engine/src/runtime/agent-runtime.ts')).toMatch(/MODEL_SELECTION_REQUIRED/);
  });

  it('S: the contract contains no implementation, no vendor and no LLM-as-router', () => {
    const files = ['packages/core/src/domain/model-router.ts', 'packages/core/src/ports/model-router.ts'];
    const vendors = ['openai', 'anthropic', 'claude', 'deepseek', 'gemini', 'kimi', 'ollama'];
    for (const file of files) {
      const code = codeOnly(source(file));
      for (const forbidden of ['selectModel(', 'rankModels(', 'scoreModel(', 'bestModel(', 'openai', 'fetch(', 'node:http']) {
        expect(code.toLowerCase(), `${file} contains ${forbidden}`).not.toContain(forbidden.toLowerCase());
      }
      // No provider/runtime coupling: the router contract is pure Core.
      expect(code).not.toMatch(/from '\.\.\/\.\.\/engine/);
      expect(code).not.toMatch(/ProviderRegistry|AgentRuntime/);
      for (const vendor of vendors) expect(code.toLowerCase()).not.toContain(vendor);
    }
    // The port has exactly one method, and nothing implements it yet.
    expect(source('packages/core/src/ports/model-router.ts')).toMatch(/recommend\(request: RouterRequest\)/);
    expect(readFileSync(repo('packages/engine/src/index.ts'), 'utf8')).not.toMatch(/ModelRouterPort/);
  });
});
