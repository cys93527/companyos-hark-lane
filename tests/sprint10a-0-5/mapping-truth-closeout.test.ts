/**
 * Sprint 10A.0.5 tests A–T: Mapping & Docs Truth Closeout.
 *
 * A–G  allowed-range vs hard-block are DIFFERENT facts, verified across the REAL paths
 *      (`evaluateCandidateAgainstSelectionRules`, `evaluateManualSelection`, `hybridCandidates`,
 *      `applyHumanOverride` and `applyHardFilters`) - a mapping table alone is never enough.
 * H    hostile stateful Proxy cannot escape as a native exception
 * I–L  shape tightening: scopeId type/blank, finite numbers
 * M/N  structural digest collisions (sets and ordered lists, not just scalars)
 * O–R  runtime freeze of the view, its source and all five arrays
 * S/T  documentation truth: counts and the review records
 *
 * Still design-only: nothing here selects a model.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  EXCLUSION_TO_MANUAL_REFUSAL,
  ROUTER_POSITIVE_REASONS,
  ROUTER_REJECTION_REASONS,
  SELECTION_EXCLUSION_CODES,
  SELECTION_EXCLUSION_TO_ROUTER_REASON,
  applyHardFilters,
  applyHumanOverride,
  assertDerivedPolicyView,
  contentDigestOf,
  createPolicy,
  deriveRouterPolicyView,
  evaluateCandidateAgainstSelectionRules,
  evaluateManualSelection,
  hybridCandidates,
  selectionRulesFromPolicy,
  validateRouterPolicyViewShape,
  type ModelRecord,
  type RouterPolicyView,
  type RouterRequest,
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

const viewOf = (fields: Record<string, unknown> = {}): RouterPolicyView =>
  deriveRouterPolicyView({ policy: policyOf(fields), generatedAt: '2027-01-01T00:00:00.000Z' });

const requestWith = (view: RouterPolicyView, candidates: readonly ModelRecord[]): RouterRequest => ({
  requestId: 'req_05',
  companyId: 'company_default',
  taskId: 'tsk_1',
  roleId: 'role_developer',
  selectionMode: 'AUTO',
  policyView: view,
  estimatedInputTokens: 100,
  candidateModels: candidates,
  traceId: 'trace_05',
});

const rejectedReasons = (view: RouterPolicyView, candidates: readonly ModelRecord[]): readonly string[] => {
  const outcome = applyHardFilters(requestWith(view, candidates));
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.value.rejected.flatMap((entry) => entry.reasons);
};

describe('A–G. allowed range vs hard block: different facts, consistent across every path', () => {
  it('A/B/C: the range case is NOT_IN_ALLOWED_RANGE and the router says NOT_IN_CANDIDATE_SET', () => {
    const rules = selectionRulesFromPolicy(policyOf({ allowedModels: ['model-a'] }));
    const facts = evaluateCandidateAgainstSelectionRules(MODEL('model-b'), rules);
    expect(facts.map((fact) => fact.code)).toEqual(['NOT_IN_ALLOWED_RANGE']);
    expect(SELECTION_EXCLUSION_TO_ROUTER_REASON['NOT_IN_ALLOWED_RANGE']).toBe('NOT_IN_CANDIDATE_SET');

    const view = viewOf({ allowedModels: ['model-a'] });
    const reasons = rejectedReasons(view, [MODEL('model-a'), MODEL('model-b')]);
    expect(reasons).toContain('NOT_IN_CANDIDATE_SET');
    // The wrong mapping must be impossible: a range exclusion is never a hard block.
    expect(reasons).not.toContain('MODEL_BLOCKED');
  });

  it('C: a blocked model is MODEL_BLOCKED_BY_POLICY and the router says MODEL_BLOCKED', () => {
    const rules = selectionRulesFromPolicy(policyOf({ allowedModels: ['model-a', 'model-b'], blockedModels: ['model-b'] }));
    const facts = evaluateCandidateAgainstSelectionRules(MODEL('model-b'), rules);
    expect(facts.map((fact) => fact.code)).toEqual(['MODEL_BLOCKED_BY_POLICY']);
    expect(SELECTION_EXCLUSION_TO_ROUTER_REASON['MODEL_BLOCKED_BY_POLICY']).toBe('MODEL_BLOCKED');

    const reasons = rejectedReasons(viewOf({ allowedModels: ['model-a', 'model-b'], blockedModels: ['model-b'] }), [
      MODEL('model-a'),
      MODEL('model-b'),
    ]);
    expect(reasons).toContain('MODEL_BLOCKED');
    expect(reasons).not.toContain('NOT_IN_CANDIDATE_SET');
  });

  it('D: explicit choice crosses the RANGE but never the BLOCK', () => {
    const rangeOnly = selectionRulesFromPolicy(policyOf({ allowedModels: ['model-a'] }));
    const explicitRange = evaluateCandidateAgainstSelectionRules(MODEL('model-b'), rangeOnly, { explicit: true });
    expect(explicitRange).toEqual([]);
    expect(evaluateManualSelection({ modelKey: 'model-b', policy: rangeOnly, records: [MODEL('model-b')], explicit: true }).accepted).toBe(
      true,
    );

    const blocked = selectionRulesFromPolicy(policyOf({ allowedModels: ['model-a', 'model-b'], blockedModels: ['model-b'] }));
    expect(
      evaluateCandidateAgainstSelectionRules(MODEL('model-b'), blocked, { explicit: true }).map((fact) => fact.code),
    ).toEqual(['MODEL_BLOCKED_BY_POLICY']);
    const verdict = evaluateManualSelection({
      modelKey: 'model-b',
      policy: blocked,
      records: [MODEL('model-b')],
      explicit: true,
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.refusals).toContain('MODEL_BLOCKED_BY_POLICY');
  });

  it('E: the MANUAL refusal label stays compatible for BOTH facts, but the facts differ', () => {
    expect(EXCLUSION_TO_MANUAL_REFUSAL['NOT_IN_ALLOWED_RANGE']).toBe('MODEL_BLOCKED_BY_POLICY');
    expect(EXCLUSION_TO_MANUAL_REFUSAL['MODEL_BLOCKED_BY_POLICY']).toBe('MODEL_BLOCKED_BY_POLICY');
    expect(SELECTION_EXCLUSION_CODES).toContain('NOT_IN_ALLOWED_RANGE');
    expect(SELECTION_EXCLUSION_CODES.length).toBe(8);
    // Both mapping tables cover every fact, 1:1.
    for (const code of SELECTION_EXCLUSION_CODES) {
      expect(EXCLUSION_TO_MANUAL_REFUSAL[code]).toBeDefined();
      expect(SELECTION_EXCLUSION_TO_ROUTER_REASON[code]).toBeDefined();
      expect(ROUTER_REJECTION_REASONS).toContain(SELECTION_EXCLUSION_TO_ROUTER_REASON[code]);
    }
  });

  it('F: MANUAL / HYBRID / Override agree on the FACT for the same candidate and rules', () => {
    const blockedRules = selectionRulesFromPolicy(policyOf({ blockedModels: ['model-b'] }));
    const fact = evaluateCandidateAgainstSelectionRules(MODEL('model-b'), blockedRules)[0]?.code;
    expect(fact).toBe('MODEL_BLOCKED_BY_POLICY');
    // MANUAL
    expect(
      evaluateManualSelection({ modelKey: 'model-b', policy: blockedRules, records: [MODEL('model-b')] }).refusals,
    ).toContain('MODEL_BLOCKED_BY_POLICY');
    // HYBRID
    const set = hybridCandidates({ policy: blockedRules, records: [MODEL('model-a'), MODEL('model-b')] });
    expect(set.excluded.find((entry) => entry.modelKey === 'model-b')?.reason).toBe('blocked_by_policy');
    expect(set.modelKeys).not.toContain('model-b');
    // Override
    expect(
      applyHumanOverride({
        recommendation: { selectedModelKey: 'model-a', traceId: 'trace_05', routerVersion: 'model-router/v1' },
        userModelKey: 'model-b',
        policyView: viewOf({ blockedModels: ['model-b'] }),
        records: [MODEL('model-a'), MODEL('model-b')],
      }).refusals,
    ).toContain('MODEL_BLOCKED_BY_POLICY');
    // Range-only exclusion keeps the "not in allowed set" label in HYBRID.
    const rangeRules = selectionRulesFromPolicy(policyOf({ allowedModels: ['model-a'] }));
    const rangeSet = hybridCandidates({ policy: rangeRules, records: [MODEL('model-a'), MODEL('model-b')] });
    expect(rangeSet.excluded.find((entry) => entry.modelKey === 'model-b')?.reason).toBe('not_in_allowed_set');
  });

  it('G: applyHardFilters is the real cross-path check (this test fails if the mapping regresses)', () => {
    // Regression guard: were NOT_IN_ALLOWED_RANGE mapped to MODEL_BLOCKED, this would fail.
    expect(SELECTION_EXCLUSION_TO_ROUTER_REASON['NOT_IN_ALLOWED_RANGE']).not.toBe('MODEL_BLOCKED');
    const rangeReasons = rejectedReasons(viewOf({ allowedModels: ['model-a'] }), [MODEL('model-b')]);
    const blockReasons = rejectedReasons(viewOf({ allowedModels: ['model-b'], blockedModels: ['model-b'] }), [
      MODEL('model-b'),
    ]);
    expect(rangeReasons).toEqual(['NOT_IN_CANDIDATE_SET']);
    expect(blockReasons).toEqual(['MODEL_BLOCKED']);
    expect(rangeReasons).not.toEqual(blockReasons);
  });
});

describe('H–L. exception containment and shape tightening', () => {
  it('H: a stateful Proxy (normal reads first, throws later) cannot escape as a native error', () => {
    const honest = viewOf();
    let reads = 0;
    const hostile = new Proxy(
      { ...honest },
      {
        get(target, property, receiver) {
          reads += 1;
          if (reads > 4) throw new TypeError('getter exploded');
          return Reflect.get(target, property, receiver) as unknown;
        },
        has(target, property) {
          reads += 1;
          if (reads > 6) throw new Error('has exploded');
          return Reflect.has(target, property);
        },
      },
    ) as RouterPolicyView;
    let verdict: ReturnType<typeof assertDerivedPolicyView> | undefined;
    expect(() => {
      verdict = assertDerivedPolicyView(hostile);
    }).not.toThrow();
    const outcome = verdict as unknown as ReturnType<typeof assertDerivedPolicyView> | undefined;
    expect(outcome?.ok).toBe(false);
    if (outcome !== undefined && !outcome.ok) expect(outcome.error.code).toBe('VALIDATION_FAILED');
  });

  const shapeCases: readonly [string, unknown][] = [
    ['I: numeric scopeId', 42],
    ['J: blank scopeId', '   '],
  ];
  for (const [label, value] of shapeCases) {
    it(`${label} is VALIDATION_FAILED`, () => {
      const broken = { ...viewOf(), scopeId: value } as RouterPolicyView;
      expect(validateRouterPolicyViewShape(broken).ok).toBe(false);
      const verdict = assertDerivedPolicyView(broken);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.error.code).toBe('VALIDATION_FAILED');
    });
  }

  it('K/L: NaN and Infinity are rejected for maxCost / maxLatency', () => {
    for (const broken of [
      { ...viewOf(), maxCost: Number.NaN },
      { ...viewOf(), maxLatency: Number.POSITIVE_INFINITY },
      { ...viewOf(), maxCost: Number.NEGATIVE_INFINITY },
    ] as readonly RouterPolicyView[]) {
      const verdict = assertDerivedPolicyView(broken);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('M–N. structural digest collisions', () => {
  it('M: a set list cannot collide with a split value', () => {
    const base = viewOf();
    const joined = contentDigestOf({ ...base, blockedModels: ['a,b'] } as never);
    const split = contentDigestOf({ ...base, blockedModels: ['a', 'b'] } as never);
    expect(joined).not.toBe(split);
    const capsJoined = contentDigestOf({ ...base, requiredCapabilities: ['x,y'] } as never);
    const capsSplit = contentDigestOf({ ...base, requiredCapabilities: ['x', 'y'] } as never);
    expect(capsJoined).not.toBe(capsSplit);
  });

  it('N: an ordered list cannot collide with a split value, and order still matters', () => {
    const base = viewOf();
    const joined = contentDigestOf({ ...base, preferredModels: ['a|b'] } as never);
    const split = contentDigestOf({ ...base, preferredModels: ['a', 'b'] } as never);
    expect(joined).not.toBe(split);
    const forward = contentDigestOf({ ...base, preferredModels: ['a', 'b'] } as never);
    const reversed = contentDigestOf({ ...base, preferredModels: ['b', 'a'] } as never);
    expect(forward).not.toBe(reversed);
  });
});

describe('O–R. runtime freeze', () => {
  it('O/P/Q: the view, its source and all five arrays are really frozen', () => {
    const view = viewOf();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.source)).toBe(true);
    for (const field of [
      'allowedModels',
      'preferredModels',
      'blockedModels',
      'allowedProviders',
      'requiredCapabilities',
    ] as const) {
      expect(Object.isFrozen(view[field]), `${field} must be frozen`).toBe(true);
    }
  });

  it('R: mutation attempts cannot change a derived view', () => {
    const view = viewOf({ allowedModels: ['model-a'] });
    const before = contentDigestOf(view);
    expect(() => {
      (view.allowedModels as string[]).push('model-z');
    }).toThrow();
    expect(() => {
      (view as { scopeId: string }).scopeId = 'hacked';
    }).toThrow();
    expect(view.allowedModels).toEqual(['model-a']);
    expect(contentDigestOf(view)).toBe(before);
    expect(assertDerivedPolicyView(view).ok).toBe(true);
  });
});

describe('S–T. documentation truth', () => {
  it('S: the documented catalog count matches the shipped 24 + 14 = 38', () => {
    expect(ROUTER_POSITIVE_REASONS.length).toBe(24);
    expect(ROUTER_REJECTION_REASONS.length + ROUTER_POSITIVE_REASONS.length).toBe(38);
    const adr = source('docs/adr/0014-model-router-architecture.md');
    const reference = source('docs/MODEL_ROUTER.md');
    const handoff = source('PROJECT_HANDOFF.md');
    expect(adr).not.toMatch(/23 正面/);
    expect(adr).toMatch(/24 正面 \+ 14 拒绝/);
    expect(reference).toMatch(/24 正面 \+ 14 拒绝/);
    // The removed 10-key catalog must not be presented as the v1 ranking order anywhere.
    // The reference doc must not present the removed 10-key catalog at all (the ADR may mention it
    // only as history, which is truthful).
    expect(reference).not.toMatch(/RANKING_SIGNALS/);
    expect(reference).not.toMatch(/reviewPassRate → reworkRate/);
    expect(adr).not.toMatch(/reviewPassRate → reworkRate/);
    expect(reference).toMatch(/ROUTER_V1_RANKING/);
    expect(reference).toMatch(/V1_NOT_RANKED_SIGNALS/);
    expect(handoff).toMatch(/16 个必需字段|16 个字段/);
    // The overstatement is gone: the router MAPPING is documented, not a false delegation claim.
    expect(adr).toMatch(/NOT_IN_ALLOWED_RANGE/);
    expect(handoff).not.toMatch(/Router 硬过滤全部经由它/);
  });

  it('T: the handoff records the 10A.0.3 and 10A.0.4 review outcomes with verdicts', () => {
    const handoff = source('PROJECT_HANDOFF.md');
    expect(handoff).toMatch(/Sprint 10A\.0\.3[\s\S]{0,4000}?ALLOW 10B|ALLOW 10B[\s\S]{0,4000}?Sprint 10A\.0\.3/);
    expect(handoff).toMatch(/10A\.0\.4/);
    expect(handoff).toMatch(/PASS WITH CONDITIONS/);
    expect(handoff).toMatch(/HIGH/);
    expect(handoff).toMatch(/未关闭/);
  });
});
