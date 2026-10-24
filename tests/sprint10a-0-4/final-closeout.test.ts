/**
 * Sprint 10A.0.4 tests A–R: Router Contract Final Closeout.
 *
 * A–D  one authoritative exclusion rule + one fact-code mapping (no drift)
 * E–J  PolicyView shape/enum validation with native-exception containment
 * K–M  typed digest canonicalisation (no null/"null", 0/"0" collisions)
 * N    a REAL `allowFallback` change moves fallback -> digest -> snapshotVersion
 * O–P  ranking missing-semantics asserted semantically; no second ranking directory
 * R    docs and code agree on the reason-code count
 *
 * Still design-only: nothing here selects a model.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  EXCLUSION_TO_MANUAL_REFUSAL,
  ROUTER_POSITIVE_REASONS,
  ROUTER_REASON_PRODUCERS,
  ROUTER_REJECTION_REASONS,
  ROUTER_V1_RANKING,
  SELECTION_EXCLUSION_CODES,
  SELECTION_EXCLUSION_TO_ROUTER_REASON,
  applyHumanOverride,
  assertDerivedPolicyView,
  contentDigestOf,
  createPolicy,
  deriveRouterPolicyView,
  evaluateCandidateAgainstSelectionRules,
  evaluateManualSelection,
  hybridCandidates,
  isCandidateAdmissible,
  rulesExcludeCandidate,
  selectionRulesFromPolicy,
  validateRouterPolicyViewShape,
  type ModelRecord,
  type RouterPolicyView,
} from '@companyos/core';

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

const viewOf = (fields: Record<string, unknown> = {}, generatedAt = '2027-01-01T00:00:00.000Z'): RouterPolicyView =>
  deriveRouterPolicyView({ policy: policyOf(fields), generatedAt });

describe('A–D. one authoritative exclusion rule, one fact mapping', () => {
  const cases: readonly [string, Record<string, unknown>, ModelRecord][] = [
    ['disabled', {}, MODEL('model-a', { enabled: false })],
    ['unavailable', {}, MODEL('model-a', { availability: 'unavailable' })],
    ['blocked', { blockedModels: ['model-a'] }, MODEL('model-a')],
    ['outside the allowed set', { allowedModels: ['model-b'] }, MODEL('model-a')],
    ['provider disallowed', { allowedProviders: ['provider-z'] }, MODEL('model-a')],
    ['capability missing', { requiredCapabilities: ['vision'] }, MODEL('model-a')],
    ['cost exceeded', { maxCost: 0 }, MODEL('model-a', { pricing: { inputPerMillion: 5, outputPerMillion: 5, currency: 'USD' } })],
  ];

  for (const [label, policyFields, candidate] of cases) {
    it(`A: MANUAL verdict, shared rule and Router reason agree on the FACT for ${label}`, () => {
      const rules = selectionRulesFromPolicy(policyOf(policyFields));
      const exclusions = evaluateCandidateAgainstSelectionRules(candidate, rules);
      expect(exclusions.length).toBeGreaterThan(0);
      const fact = exclusions[0]?.code ?? null;
      expect(fact).not.toBeNull();

      // MANUAL verdict reports the mapped refusal…
      const verdict = evaluateManualSelection({ modelKey: candidate.modelKey, policy: rules, records: [candidate] });
      expect(verdict.accepted).toBe(false);
      expect(verdict.refusals).toContain(EXCLUSION_TO_MANUAL_REFUSAL[fact as keyof typeof EXCLUSION_TO_MANUAL_REFUSAL]);
      // …and the wrapper agrees with the rule, with no independent logic.
      expect(rulesExcludeCandidate(candidate, rules)).toBe(
        exclusions.some((exclusion) => exclusion.unknownCapability)
          ? 'UNKNOWN_CAPABILITY'
          : EXCLUSION_TO_MANUAL_REFUSAL[fact as keyof typeof EXCLUSION_TO_MANUAL_REFUSAL],
      );
      // …and the router reason is the mapped rejection code.
      expect(ROUTER_REJECTION_REASONS).toContain(SELECTION_EXCLUSION_TO_ROUTER_REASON[fact as never]);
      expect(SELECTION_EXCLUSION_CODES).toContain(fact);
    });
  }

  it('B: HYBRID exclusions come from the same rule (labels are presentation only)', () => {
    const rules = selectionRulesFromPolicy(policyOf({ blockedModels: ['model-a'], allowedProviders: ['provider-z'] }));
    const records = [MODEL('model-a'), MODEL('model-b')];
    const set = hybridCandidates({ policy: rules, records });
    for (const entry of set.excluded) {
      const record = records.find((candidate) => candidate.modelKey === entry.modelKey);
      expect(record).toBeDefined();
      expect(isCandidateAdmissible(record as ModelRecord, rules)).toBe(false);
      expect(rulesExcludeCandidate(record as ModelRecord, rules)).not.toBeNull();
    }
    // Nothing excluded may appear in the candidate keys.
    for (const entry of set.excluded) expect(set.modelKeys).not.toContain(entry.modelKey);
  });

  it('C: Human Override uses the same rule (blocked stays blocked)', () => {
    const view = viewOf({ blockedModels: ['model-b'] });
    const outcome = applyHumanOverride({
      recommendation: { selectedModelKey: 'model-a', traceId: 'trace_04', routerVersion: 'model-router/v1' },
      userModelKey: 'model-b',
      policyView: view,
      records: [MODEL('model-a'), MODEL('model-b')],
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.refusals).toContain('MODEL_BLOCKED_BY_POLICY');
    expect(rulesExcludeCandidate(MODEL('model-b'), selectionRulesFromPolicy(policyOf({ blockedModels: ['model-b'] })))).toBe(
      'MODEL_BLOCKED_BY_POLICY',
    );
  });

  it('D: the capability reason no longer drifts (unknown vs missing are distinguished from ONE fact)', () => {
    // Built directly: `createPolicy` refuses a policy that names an unknown capability.
    const rules = { ...selectionRulesFromPolicy(null), requiredCapabilities: ['telepathy'] };
    const exclusions = evaluateCandidateAgainstSelectionRules(MODEL('model-a'), rules);
    // The FACT is CAPABILITY_MISSING in both cases; only the MANUAL label distinguishes "unknown".
    expect(exclusions[0]?.code).toBe('CAPABILITY_MISSING');
    expect(exclusions[0]?.unknownCapability).toBe(true);
    expect(rulesExcludeCandidate(MODEL('model-a'), rules)).toBe('UNKNOWN_CAPABILITY');
    const verdict = evaluateManualSelection({ modelKey: 'model-a', policy: rules, records: [MODEL('model-a')] });
    expect(verdict.refusals).toContain('UNKNOWN_CAPABILITY');
    expect(EXCLUSION_TO_MANUAL_REFUSAL['CAPABILITY_MISSING']).toBe('CAPABILITY_MISSING');
  });
});

describe('E–J. shape and enum validation without native exceptions', () => {
  const missingFieldCases: readonly [string, (view: RouterPolicyView) => unknown][] = [
    ['preferredModels', (v) => ({ ...v, preferredModels: undefined })],
    ['blockedModels', (v) => ({ ...v, blockedModels: undefined })],
    ['allowedModels', (v) => ({ ...v, allowedModels: undefined })],
    ['allowedProviders', (v) => ({ ...v, allowedProviders: undefined })],
    ['requiredCapabilities', (v) => ({ ...v, requiredCapabilities: undefined })],
    ['scopeType', (v) => ({ ...v, scopeType: undefined })],
    ['scopeId', (v) => ({ ...v, scopeId: undefined })],
    ['fallback', (v) => ({ ...v, fallback: undefined })],
    ['source.mode', (v) => ({ ...v, source: { ...v.source, mode: undefined } })],
    ['source.policyId', (v) => ({ ...v, source: { ...v.source, policyId: undefined } })],
    ['source.snapshotVersion', (v) => ({ ...v, source: { ...v.source, snapshotVersion: undefined } })],
    ['digest', (v) => ({ ...v, digest: undefined })],
  ];

  for (const [label, mutate] of missingFieldCases) {
    it(`E/F: a view missing ${label} is VALIDATION_FAILED (never a native throw)`, () => {
      const honest = viewOf();
      const broken = mutate(honest) as RouterPolicyView;
      let verdict: ReturnType<typeof assertDerivedPolicyView> | null = null;
      expect(() => {
        verdict = assertDerivedPolicyView(broken);
      }).not.toThrow();
      const outcome = verdict as unknown as ReturnType<typeof assertDerivedPolicyView> | undefined;
      expect(outcome).toBeDefined();
      expect(outcome?.ok).toBe(false);
      if (outcome !== undefined && !outcome.ok) expect(outcome.error.code).toBe('VALIDATION_FAILED');
    });
  }

  const enumCases: readonly [string, unknown, unknown][] = [
    ['G: mode', 'source.mode', 'SOMETIMES'],
    ['H: fallback', 'fallback', 'MAYBE'],
    ['I: scopeType', 'scopeType', 'GALAXY'],
  ];

  for (const [label, path, value] of enumCases) {
    it(`${label} must be an enum member`, () => {
      const honest = viewOf();
      const broken = (
        path === 'source.mode'
          ? { ...honest, source: { ...honest.source, mode: value } }
          : { ...honest, [path as string]: value }
      ) as RouterPolicyView;
      const verdict = assertDerivedPolicyView(broken);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.error.code).toBe('VALIDATION_FAILED');
        expect(verdict.error.message).toContain('shape invalid');
      }
      // The invalid value never reached the digest: no throw, no digest computation.
      expect(validateRouterPolicyViewShape(broken).ok).toBe(false);
    });
  }

  it('J: hostile inputs never escape as native exceptions', () => {
    const hostile: readonly unknown[] = [
      null,
      undefined,
      'not a view',
      42,
      [],
      {},
      { source: null },
      { source: {} },
      { source: { policyId: 1, mode: 2, snapshotVersion: 3, generatedAt: 4 } },
      new Proxy({}, { get: () => { throw new Error('boom'); }, has: () => { throw new Error('boom'); } }),
      { ...viewOf(), allowedModels: 'not-an-array' },
      { ...viewOf(), maxCost: 'free' },
    ];
    for (const candidate of hostile) {
      let verdict: ReturnType<typeof assertDerivedPolicyView> | null = null;
      expect(() => {
        verdict = assertDerivedPolicyView(candidate as RouterPolicyView);
      }).not.toThrow();
      const outcome = verdict as unknown as ReturnType<typeof assertDerivedPolicyView> | undefined;
      expect(outcome?.ok).toBe(false);
    }
  });
});

describe('K–M. typed digest canonicalisation', () => {
  it('K/L/M: null, "null", 0, "0" never collide', () => {
    const base = viewOf({ maxCost: 3 });
    const nullScope = contentDigestOf({ ...base, scopeId: null });
    const stringNullScope = contentDigestOf({ ...base, scopeId: 'null' } as never);
    expect(nullScope).not.toBe(stringNullScope);

    const zeroCost = contentDigestOf({ ...base, maxCost: 0 });
    const stringZeroCost = contentDigestOf({ ...base, maxCost: '0' } as never);
    expect(zeroCost).not.toBe(stringZeroCost);

    const nullCost = contentDigestOf({ ...base, maxCost: null });
    const stringNullCost = contentDigestOf({ ...base, maxCost: 'null' } as never);
    expect(nullCost).not.toBe(stringNullCost);
    expect(zeroCost).not.toBe(nullCost);

    // Length-prefixed strings: concatenation cannot be ambiguous either.
    const a = contentDigestOf({ ...base, scopeId: 'a,b' } as never);
    const b = contentDigestOf({ ...base, scopeId: 'a' } as never);
    expect(a).not.toBe(b);
  });
});

describe('N–P. real tamper, semantic ranking assertions, single directory', () => {
  it('N: changing allowFallback moves fallback -> digest -> snapshotVersion', () => {
    const never = viewOf({ allowFallback: 'NEVER' });
    const ask = viewOf({ allowFallback: 'ASK' });
    const auto = viewOf({ allowFallback: 'AUTO_WITHIN_POLICY' });
    expect(never.fallback).toBe('NEVER');
    expect(ask.fallback).toBe('ASK');
    expect(auto.fallback).toBe('AUTO_WITHIN_POLICY');
    expect(ask.digest).not.toBe(never.digest);
    expect(auto.digest).not.toBe(ask.digest);
    expect(ask.source.snapshotVersion).not.toBe(never.source.snapshotVersion);
    // A derived view with the fallback field switched by hand is refused.
    expect(assertDerivedPolicyView({ ...never, fallback: 'ASK' }).ok).toBe(false);
  });

  it('O: the missing-data semantic is asserted on the DATA, not on source text', () => {
    expect(ROUTER_V1_RANKING.length).toBeGreaterThanOrEqual(6);
    expect(ROUTER_V1_RANKING.every((signal) => signal.missing === 'SKIP_AND_RENORMALISE')).toBe(true);
    expect(ROUTER_V1_RANKING.every((signal) => signal.canBreakHardFilter === false)).toBe(true);
  });

  it('P: there is no second ranking directory on the public surface', () => {
    const index = source('packages/core/src/index.ts');
    const core = source('packages/core/src/domain/model-router.ts');
    expect(index).toMatch(/ROUTER_V1_RANKING/);
    expect(index).not.toMatch(/RANKING_SIGNALS/);
    expect(core).not.toMatch(/export const RANKING_SIGNALS\b/);
    expect(core).not.toMatch(/RANKING_HARD_CONSTRAINTS_LEGACY/);
    // Exactly one exported ranking catalog constant.
    expect((core.match(/export const ROUTER_V1_RANKING/g) ?? []).length).toBe(1);
  });
});

describe('Q–R. engine integration guard and documentation truth', () => {
  it('Q: the engine policy service derives the view without injecting a version', () => {
    const engine = source('packages/engine/src/registry/selection-policy.ts');
    expect(engine).toMatch(/deriveRouterPolicyView\(/);
    expect(engine).toMatch(/generatedAt: nowIso\(\)/);
    // The regression that triggered the 10A.0.3 HIGH: the engine must NOT build a version string.
    expect(engine).not.toMatch(/snapshotVersion:/);
    expect(engine).toMatch(/selectionRulesFromPolicy\(/);
  });

  it('R: the documented reason-code count matches the shipped catalog', () => {
    expect(ROUTER_POSITIVE_REASONS.length).toBe(24);
    expect(ROUTER_REJECTION_REASONS.length).toBe(14);
    expect(Object.keys(ROUTER_REASON_PRODUCERS).length).toBe(38);
    const handoff = source('PROJECT_HANDOFF.md');
    expect(handoff).toMatch(/24 正面 \+ 14 拒绝/);
    expect(handoff).not.toMatch(/23 正面 \+ 14 拒绝/);
    const reference = source('docs/MODEL_ROUTER.md');
    expect(reference).toMatch(/24 正面 \+ 14 拒绝/);
    expect(reference).not.toMatch(/RANKING_SIGNALS/);
    // The ADR must not overstate the unification it now enforces.
    const adr = source('docs/adr/0014-model-router-architecture.md');
    expect(adr).toMatch(/evaluateCandidateAgainstSelectionRules/);
  });
});
