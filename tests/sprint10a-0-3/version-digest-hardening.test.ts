/**
 * Sprint 10A.0.3 tests A–T: Router Version & Digest Hardening.
 *
 * A–C  snapshotVersion is content-bound and clock-independent (the review HIGH)
 * D–H  the canonical digest covers order and every safety-relevant field (MEDIUM-1/2)
 * I–J  the view cannot omit policy fields, and no consumer may invent a fallback (MEDIUM-3)
 * K    NO_ELIGIBLE_MODEL needs real evidence (MEDIUM-4)
 * L–M  only the branded candidate set exists, and it is the only ranking input (§六)
 * N–Q  one policy interpretation, marked not-ranked signals, no dead constants (§七/§八/§九/§十)
 * R    the 38-code catalog and its producers (§十一)
 * S    the two formerly vacuous assertions are now discriminating (§十二)
 * T    the same semantic policy under different clocks yields the same router semantics
 *
 * Still design-only: nothing here selects a model.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ROUTER_POSITIVE_REASONS,
  ROUTER_REASON_PRODUCERS,
  ROUTER_REJECTION_REASONS,
  ROUTER_V1_RANKING,
  V1_NOT_RANKED_MARKER,
  V1_NOT_RANKED_SIGNALS,
  applyHardFilters,
  assertDerivedPolicyView,
  assertRankingInput,
  contentDigestOf,
  createPolicy,
  deriveRouterPolicyView,
  rulesExcludeCandidate,
  selectionRulesFromPolicy,
  validateRecommendation,
  type ModelRecommendation,
  type ModelRecord,
  type ModelSelectionPolicy,
  type RouterPolicyView,
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

const policyOf = (fields: Record<string, unknown> = {}): ModelSelectionPolicy => {
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

const viewOf = (fields: Record<string, unknown> = {}, generatedAt = '2027-01-01T00:00:00.000Z'): RouterPolicyView =>
  deriveRouterPolicyView({ policy: policyOf(fields), generatedAt });

const requestWith = (view: RouterPolicyView): RouterRequest => ({
  requestId: 'req_v3',
  companyId: 'company_default',
  taskId: 'tsk_1',
  roleId: 'role_developer',
  selectionMode: 'AUTO',
  policyView: view,
  estimatedInputTokens: 100,
  candidateModels: [MODEL('model-a'), MODEL('model-b')],
  traceId: 'trace_v3',
});

describe('A–C. snapshotVersion is content-bound, never clock-bound', () => {
  it('A: the same policy derived twice yields the same snapshotVersion and digest', () => {
    const first = viewOf({ blockedModels: ['model-z'] });
    const second = viewOf({ blockedModels: ['model-z'] });
    expect(first.source.snapshotVersion).toBe(second.source.snapshotVersion);
    expect(first.digest).toBe(second.digest);
    expect(first).toEqual(second);
    // …and the version is verifiably `<policyId>@<contentDigest>`.
    expect(first.source.snapshotVersion).toBe(`${first.source.policyId}@${first.digest}`);
    expect(contentDigestOf(first)).toBe(first.digest);
  });

  it('B: a different clock changes generatedAt only - never the version or the digest', () => {
    const early = viewOf({ preferredModels: ['model-a'] }, '2027-01-01T00:00:00.000Z');
    const late = viewOf({ preferredModels: ['model-a'] }, '2031-12-31T23:59:59.000Z');
    expect(late.source.generatedAt).not.toBe(early.source.generatedAt);
    expect(late.source.snapshotVersion).toBe(early.source.snapshotVersion);
    expect(late.digest).toBe(early.digest);
  });

  it('C: changing policy CONTENT changes the digest and the version', () => {
    const base = viewOf({ allowedModels: ['model-a', 'model-b'] });
    const changed = viewOf({ allowedModels: ['model-a'] });
    expect(changed.digest).not.toBe(base.digest);
    expect(changed.source.snapshotVersion).not.toBe(base.source.snapshotVersion);
  });

  it('a caller-supplied snapshotVersion is ignored, not honored', () => {
    const honest = deriveRouterPolicyView({ policy: policyOf(), generatedAt: 'x' });
    const spoofed = deriveRouterPolicyView({
      policy: policyOf(),
      generatedAt: 'x',
      snapshotVersion: 'COMPANY:*@1700000000000',
    });
    expect(spoofed.source.snapshotVersion).toBe(honest.source.snapshotVersion);
    expect(spoofed.source.snapshotVersion.endsWith(honest.digest)).toBe(true);
  });
});

describe('D–H. the canonical digest covers order and every safety field', () => {
  it('D: preferredModels ORDER changes the digest (0.25-weight signal)', () => {
    const forward = viewOf({ preferredModels: ['model-a', 'model-b'] });
    const reversed = viewOf({ preferredModels: ['model-b', 'model-a'] });
    expect(forward.preferredModels).toEqual(['model-a', 'model-b']);
    expect(reversed.preferredModels).toEqual(['model-b', 'model-a']);
    expect(reversed.digest).not.toBe(forward.digest);
    // Set-semantics lists are order-insensitive on purpose.
    const setA = viewOf({ blockedModels: ['model-a', 'model-b'] });
    const setB = viewOf({ blockedModels: ['model-b', 'model-a'] });
    expect(setB.digest).toBe(setA.digest);
  });

  const tamperCases: readonly [string, (view: RouterPolicyView) => RouterPolicyView][] = [
    ['mode', (v) => ({ ...v, source: { ...v.source, mode: 'MANUAL' } })],
    ['fallback', (v) => ({ ...v, fallback: 'AUTO_WITHIN_POLICY' })],
    ['scopeType', (v) => ({ ...v, scopeType: 'ROLE' })],
    ['scopeId', (v) => ({ ...v, scopeId: 'role_other' })],
    ['policyId', (v) => ({ ...v, source: { ...v.source, policyId: 'ROLE:other' } })],
    ['snapshotVersion', (v) => ({ ...v, source: { ...v.source, snapshotVersion: 'forged@0' } })],
    ['allowedModels', (v) => ({ ...v, allowedModels: ['model-z'] })],
    ['preferredModels', (v) => ({ ...v, preferredModels: ['model-b', 'model-a'] })],
    ['maxCost', (v) => ({ ...v, maxCost: 99 })],
  ];

  for (const [label, mutate] of tamperCases) {
    it(`E–H: tampering ${label} is refused`, () => {
      const honest = viewOf({ mode: 'HYBRID', allowFallback: 'ASK', preferredModels: ['model-a', 'model-b'], maxCost: 3 } as never);
      expect(assertDerivedPolicyView(honest).ok).toBe(true);
      const broken = mutate(honest);
      const verdict = assertDerivedPolicyView(broken);
      expect(verdict.ok, `tampering ${label} must be refused`).toBe(false);
      if (!verdict.ok) expect(verdict.error.code).toBe('VALIDATION_FAILED');
      const filtered = applyHardFilters(requestWith(broken));
      expect(filtered.ok).toBe(false);
    });
  }

  it('I: a view missing a required policy field is refused (no silent defaults)', () => {
    const view = viewOf();
    const withoutFallback = { ...view, fallback: undefined } as unknown as RouterPolicyView;
    const verdict = assertDerivedPolicyView(withoutFallback);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.message).toContain('shape invalid');
    const withoutScope = { ...view, scopeType: undefined } as unknown as RouterPolicyView;
    expect(assertDerivedPolicyView(withoutScope).ok).toBe(false);
  });

  it('J: fallback is read from the single authoritative field, with no `?? NEVER` fill-in', () => {
    const asking = viewOf({ allowFallback: 'ASK' } as never);
    expect(asking.fallback).toBe('ASK');
    const rules = selectionRulesFromPolicy(policyOf({ allowFallback: 'ASK' } as never));
    expect(rules.fallback).toBe('ASK');
    const raw = source('packages/core/src/domain/model-selection-policy.ts');
    const core = codeOnly(raw);
    // The evaluation path reads the AUTHORITATIVE field with one documented "no policy" default…
    expect(raw).toMatch(/const fallback: FallbackMode = policy === null \? 'NEVER' : policy\.fallback;/);
    // …and exactly one adapter turns a stored policy into rules (itself labelled as the only one).
    expect(raw).toMatch(
      /export function selectionRulesFromPolicy[\s\S]{0,400}fallback: policy\?\.allowFallback \?\? 'NEVER',/,
    );
    // The router contract reads the legacy field name exactly ONCE - inside its own derivation
    // (it consumes the stored policy); a second read anywhere else would turn this red.
    const routerCode = codeOnly(source('packages/core/src/domain/model-router.ts'));
    expect((routerCode.match(/allowFallback/g) ?? []).length).toBe(1);
    expect(core).toMatch(/readonly fallback: FallbackMode/);
  });
});

describe('K. NO_ELIGIBLE_MODEL needs real no-candidate evidence', () => {
  const recommendation = (overrides: Partial<ModelRecommendation> = {}): ModelRecommendation => ({
    selectedModelKey: null,
    decision: 'NO_ELIGIBLE_MODEL',
    reasonCodes: [],
    rejectedCandidates: [],
    candidateEvaluations: [],
    rejectionSummary: null,
    policySource: viewOf().source,
    selectionMode: 'AUTO',
    fallbackPolicy: 'NEVER',
    estimatedCost: null,
    estimatedLatency: null,
    confidence: null,
    routerVersion: 'model-router/v1',
    traceId: 'trace_v3',
    provenance: {
      routerVersion: 'model-router/v1',
      policySnapshotVersion: viewOf().source.snapshotVersion,
      modelRegistryRevision: 'rev-1',
      benchmarkVersion: null,
      performanceSnapshot: null,
    },
    ...overrides,
  });

  it('K: evaluations alone are NOT evidence - the review counterexample now fails', () => {
    const counterexample = recommendation({
      candidateEvaluations: [
        {
          modelKey: 'model-a',
          eligible: true,
          reasons: [],
          rejections: [],
          signalScores: [],
          availableWeights: 0,
          normalisedScore: 0,
          reasonCodes: [],
          tieBreakFacts: {
            modelKey: 'model-a',
            preferredPosition: null,
            estimatedCost: null,
            estimatedLatencyMs: null,
            providerHealth: 'unknown' as const,
          },
        },
      ],
    });
    const verdict = validateRecommendation(counterexample);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe('RECOMMENDATION_INVALID');

    // Real evidence in either form is accepted.
    expect(
      validateRecommendation(
        recommendation({ rejectedCandidates: [{ modelKey: 'model-a', reasons: ['MODEL_DISABLED'] }] }),
      ).ok,
    ).toBe(true);
    expect(
      validateRecommendation(
        recommendation({ rejectionSummary: { checked: 0, byReason: {}, summaryText: 'No models are registered.' } }),
      ).ok,
    ).toBe(true);
    // A selected model is still forbidden for this decision.
    expect(validateRecommendation(recommendation({ selectedModelKey: 'model-a' })).ok).toBe(false);
  });
});

describe('L–M. the branded candidate set is the only ranking input', () => {
  it('L: HardFilterOutcome exposes exactly one candidate list, and it is branded', () => {
    const outcome = applyHardFilters(requestWith(viewOf()));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.keys(outcome.value).sort()).toEqual(['candidates', 'checked', 'evaluations', 'latencyFilter', 'rejected']);
    expect(assertRankingInput(outcome.value.candidates).map((model) => model.modelKey)).toEqual(['model-a', 'model-b']);
    // The branded array is still array-like, so no consumer needs an unbranded copy.
    expect(outcome.value.candidates.map((model) => model.modelKey)).toEqual(['model-a', 'model-b']);
  });

  it('M: a raw ModelRecord[] cannot be handed to the ranking entry point', () => {
    const core = source('packages/core/src/domain/model-router.ts');
    expect(core).toMatch(/export type FilteredCandidateSet = readonly ModelRecord\[\] & \{/);
    expect(core).toMatch(/declare const FILTERED_CANDIDATE_SET: unique symbol/);
    expect(core).not.toMatch(/export const FILTERED_CANDIDATE_SET/);
    // @ts-expect-error a plain ModelRecord[] is not assignable to the branded FilteredCandidateSet.
    assertRankingInput([MODEL('model-a')]);
  });
});

describe('N–Q. one interpreter, marked signals, no dead constants', () => {
  it('N: SelectionRules is the single exported interpretation contract', () => {
    const core = source('packages/core/src/domain/model-selection-policy.ts');
    const index = source('packages/core/src/index.ts');
    expect(index).toMatch(/SelectionRules/);
    expect(index).toMatch(/selectionRulesFromPolicy/);
    expect(core).toMatch(/export function selectionRulesFromPolicy/);
    // Every consumer takes the shared shape.
    expect(core).toMatch(/export function evaluateManualSelection\(input: ManualEvaluationInput\)/);
    expect(core).toMatch(/readonly policy: SelectionRules \| null;/);
    expect(core).toMatch(/export function hybridCandidates\(input: \{\s*readonly policy: SelectionRules;/);
  });

  it('O: Hybrid/Auto no longer re-implement exclusion rules, and Runtime/Policy service use the adapter', () => {
    const core = codeOnly(source('packages/core/src/domain/model-selection-policy.ts'));
    const hybridBody = core.slice(core.indexOf('export function hybridCandidates'), core.indexOf('export const AUTO_POLICY_STATEMENT'));
    expect(hybridBody).toMatch(/rulesExcludeCandidate\(record, policy\)/);
    // The exclusion DECISION is shared; only presentation labels may look at rule fields.
    expect((hybridBody.match(/rulesExcludeCandidate\(record, policy\)/g) ?? []).length).toBe(1);
    expect(hybridBody).not.toMatch(/policy\.maxCost !== null/);
    expect(hybridBody).not.toMatch(/policy\.allowedProviders\.length/);
    const engine = source('packages/engine/src/registry/selection-policy.ts');
    expect(engine).toMatch(/selectionRulesFromPolicy\(/);
    expect(engine).not.toMatch(/hybridCandidates\(\{ policy: policy\.value/);
    const runtime = source('packages/engine/src/runtime/agent-runtime.ts');
    expect(runtime).toMatch(/selectionRulesFromPolicy\(policy\)/);
    // The shared rule function is reachable from the public surface.
    expect(
      rulesExcludeCandidate(MODEL('model-a'), selectionRulesFromPolicy(policyOf({ blockedModels: ['model-a'] }))),
    ).toBe('MODEL_BLOCKED_BY_POLICY');
  });

  it('P: every V1_NOT_RANKED entry carries the marker and is disjoint from the ranked keys', () => {
    const ranked = ROUTER_V1_RANKING.map((signal) => signal.key as string);
    expect(V1_NOT_RANKED_SIGNALS.length).toBe(3);
    for (const entry of V1_NOT_RANKED_SIGNALS) {
      expect(entry.marker).toBe(V1_NOT_RANKED_MARKER);
      expect(ranked).not.toContain(entry.key);
      expect(entry.note.length).toBeGreaterThan(10);
    }
  });

  it('Q: dead ranking constants are gone', () => {
    const core = source('packages/core/src/domain/model-router.ts');
    expect(core).not.toMatch(/RANKING_HARD_CONSTRAINTS_LEGACY/);
    expect(core).not.toMatch(/export const RANKING_SIGNALS\b/);
    expect(codeOnly(core)).not.toMatch(/NEUTRAL/);
  });
});

describe('R–T. catalog, discriminative tests and cross-clock semantics', () => {
  it('R: the catalog is 38 codes, each with a producer from the allowed closed set', () => {
    expect(ROUTER_POSITIVE_REASONS.length).toBe(24);
    expect(ROUTER_REJECTION_REASONS.length).toBe(14);
    const all = [...ROUTER_POSITIVE_REASONS, ...ROUTER_REJECTION_REASONS];
    expect(all.length).toBe(38);
    expect(Object.keys(ROUTER_REASON_PRODUCERS).length).toBe(38);
    expect(Object.keys(ROUTER_REASON_PRODUCERS).sort()).toEqual([...all].sort());
    for (const code of all) {
      expect(ROUTER_REASON_PRODUCERS[code]).toBeDefined();
    }
  });

  it('S: the former vacuous assertions are now discriminating', () => {
    // (1) The port must REQUIRE the two entry rules; if either sentence disappears this fails.
    const port = source('packages/core/src/ports/model-router.ts');
    expect(port).toMatch(/FIRST rule an implementation must run is `assertRouterRequestAllowed/);
    expect(port).toMatch(/validateRecommendation\(recommendation\)/);
    // (2) The ADR must freeze the entrance order and the validation duty.
    const adr = source('docs/adr/0014-model-router-architecture.md');
    expect(adr).toMatch(/assertRouterRequestAllowed/);
    expect(adr).toMatch(/validateRecommendation/);
    // (3) Reordering content really changes the digest (a constant could not fake this).
    expect(viewOf({ preferredModels: ['model-a', 'model-b'] }).digest).not.toBe(
      viewOf({ preferredModels: ['model-b', 'model-a'] }).digest,
    );
    // (4) A forged digest really fails (a constant could not fake this either).
    const honest = viewOf();
    expect(assertDerivedPolicyView({ ...honest, digest: honest.digest.slice(0, -1) + 'X' }).ok).toBe(false);
  });

  it('T: the same semantic policy under different clocks yields identical router semantics', () => {
    const morning = viewOf({ allowedModels: ['model-a', 'model-b'], preferredModels: ['model-b'] }, '2027-03-01T06:00:00.000Z');
    const night = viewOf({ allowedModels: ['model-a', 'model-b'], preferredModels: ['model-b'] }, '2029-11-30T22:15:00.000Z');
    const semantics = (view: RouterPolicyView): string =>
      JSON.stringify({
        version: view.source.snapshotVersion,
        digest: view.digest,
        mode: view.source.mode,
        fallback: view.fallback,
        scopeType: view.scopeType,
        scopeId: view.scopeId,
        allowedModels: view.allowedModels,
        blockedModels: view.blockedModels,
        allowedProviders: view.allowedProviders,
        preferredModels: view.preferredModels,
        requiredCapabilities: view.requiredCapabilities,
        maxCost: view.maxCost,
        maxLatency: view.maxLatency,
      });
    expect(semantics(night)).toBe(semantics(morning));
    expect(night.source.generatedAt).not.toBe(morning.source.generatedAt);
    const first = applyHardFilters(requestWith(morning));
    const second = applyHardFilters(requestWith(night));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.candidates.map((model) => model.modelKey)).toEqual(
      second.value.candidates.map((model) => model.modelKey),
    );
  });
});
