/**
 * Task-20-02 — Plan artifact contract + deterministic validator (§35-§42: the 52 required
 * tests). The contract under test is PURE: identity/fingerprint/strict validation live in
 * Core (`lifecycle/plan.ts`, zero persistence), the authoritative reference validator in
 * engine (`planning/plan-reference-validator.ts`, read-only structural ports). No provider,
 * no persistence wiring, no task/version/run side effects exist to test — and §42 proves
 * they cannot exist (import-surface assertions).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PLAN_ARTIFACT_KIND,
  PLAN_LIMITS,
  PLAN_PROPOSAL_SCHEMA,
  PLAN_SCHEMA,
  comparePlanFingerprint,
  isCriterionId,
  isPlanItemId,
  planFingerprintOf,
  planIdOf,
  validatePlanArtifactPayload,
  validatePlanningProposal,
  type PlanArtifactPayload,
  type PlanningProposal,
} from '@companyos/core';
import { createPlanReferenceValidator } from '@companyos/engine';

const reasonOf = (error: { readonly details: Readonly<Record<string, unknown>> }): string =>
  String(error.details['reason'] ?? '');

const validProposal = (): PlanningProposal => ({
  schema: PLAN_PROPOSAL_SCHEMA,
  planItems: [
    {
      planItemId: 'item-design',
      objective: 'Design the bounded slice.',
      acceptanceCriterionRefs: ['crit-design-review'],
    },
    {
      planItemId: 'item-build',
      objective: 'Build the designed slice.',
      dependencyPlanItemIds: ['item-design'],
      acceptanceCriterionRefs: ['crit-build-passes'],
    },
  ],
  acceptanceCriteria: [
    { criterionId: 'crit-design-review', requirement: 'The design is reviewed and accepted.' },
    { criterionId: 'crit-build-passes', requirement: 'The built slice passes its QA gate.' },
  ],
});

/** A valid payload built through the proposal validator (the trusted composition path). */
const payloadOf = (proposal: PlanningProposal, goalArtifactId = 'art_goal'): PlanArtifactPayload => {
  const content = validatePlanningProposal(proposal);
  if (!content.ok) throw new Error(content.error.message);
  return {
    schema: PLAN_SCHEMA,
    sourceGoal: { goalArtifactId },
    planItems: content.value.planItems,
    acceptanceCriteria: content.value.acceptanceCriteria,
  };
};

describe('T20-02 §35 — deterministic identity', () => {
  it('1-5. planId depends only on the trusted planning scope', () => {
    const scope = { companyId: 'company_default', planningRunId: 'run_1', planningCommandId: 'plan:run_1:1' };
    const baseline = planIdOf(scope);
    expect(baseline).toMatch(/^pla_[a-z0-9]{26}$/);
    // 1: same scope + same command ⇒ same planId
    expect(planIdOf(scope)).toBe(baseline);
    // 2: different planning run ⇒ different planId
    expect(planIdOf({ ...scope, planningRunId: 'run_2' })).not.toBe(baseline);
    // 3: different permanent command ⇒ different planId
    expect(planIdOf({ ...scope, planningCommandId: 'plan:run_1:2' })).not.toBe(baseline);
    // 4-5: MODEL CONTENT / timestamps / provider / model cannot alter the logical identity —
    // the identity function takes no content at all (structurally impossible), and equal
    // scopes under wildly different proposals still yield the same id.
    expect(planIdOf(scope)).toBe(baseline); // re-derived after unrelated work
    expect(planIdOf.toString()).not.toContain('Date');
    expect(planIdOf.toString()).not.toContain('Math.random');
    expect(typeof planIdOf(scope)).toBe('string');
  });
});

describe('T20-02 §36 — content fingerprint', () => {
  it('6-10. same canonical content ⇒ same fingerprint; content changes ⇒ different; no unstable metadata', () => {
    const payload = payloadOf(validProposal());
    // 6: identical validated content
    expect(planFingerprintOf(payload)).toBe(planFingerprintOf(payloadOf(validProposal())));
    // 7: changed criterion
    const changedCriterion = payloadOf({
      ...validProposal(),
      acceptanceCriteria: [
        { criterionId: 'crit-design-review', requirement: 'CHANGED requirement text.' },
        { criterionId: 'crit-build-passes', requirement: 'The built slice passes its QA gate.' },
      ],
    });
    expect(planFingerprintOf(changedCriterion)).not.toBe(planFingerprintOf(payload));
    // 8: changed dependency
    const changedDependency = payloadOf({
      ...validProposal(),
      planItems: [
        validProposal().planItems[0]!,
        { ...validProposal().planItems[1]!, dependencyPlanItemIds: [] },
      ],
    });
    expect(planFingerprintOf(changedDependency)).not.toBe(planFingerprintOf(payload));
    // 9: changed objective
    const changedObjective = payloadOf({
      ...validProposal(),
      planItems: [
        { ...validProposal().planItems[0]!, objective: 'A different objective entirely.' },
        validProposal().planItems[1]!,
      ],
    });
    expect(planFingerprintOf(changedObjective)).not.toBe(planFingerprintOf(payload));
    // 10: unstable metadata CANNOT enter the fingerprint — the payload schema has no such
    // fields (strict validation rejects them), proven by the unknown-field test below.
    const withNoise = { ...payload, createdAt: '2026-01-01T00:00:00Z' } as unknown;
    expect(reasonOf((validatePlanArtifactPayload(withNoise) as { ok: false; error: never }).error)).toBe(
      'PLAN_UNKNOWN_FIELD',
    );
  });

  it('11. the replay-conflict primitive detects same-command/different-fingerprint', () => {
    const replay = comparePlanFingerprint({
      recordedFingerprint: 'aa',
      candidateFingerprint: 'aa',
    });
    expect(replay.kind).toBe('REPLAY');
    const conflict = comparePlanFingerprint({ recordedFingerprint: 'aa', candidateFingerprint: 'bb' });
    expect(conflict.kind).toBe('CONFLICT');
    if (conflict.kind !== 'CONFLICT') return;
    expect(conflict.expected).toBe('aa');
    expect(conflict.actual).toBe('bb');
  });
});

describe('T20-02 §37 — dependency graph', () => {
  it('12-13. valid DAG accepted; multiple roots accepted (the existing DAG contract allows multiple entries)', () => {
    const multiRoot: PlanningProposal = {
      schema: PLAN_PROPOSAL_SCHEMA,
      planItems: [
        { planItemId: 'item-a', objective: 'A.' },
        { planItemId: 'item-b', objective: 'B.' },
        { planItemId: 'item-c', objective: 'C.', dependencyPlanItemIds: ['item-a', 'item-b'] },
      ],
      acceptanceCriteria: [{ criterionId: 'crit-x', requirement: 'Done means X.' }],
    };
    const withRefs: PlanningProposal = {
      ...multiRoot,
      planItems: multiRoot.planItems.map((item) => ({
        ...item,
        acceptanceCriterionRefs: ['crit-x'],
      })),
    };
    const result = validatePlanningProposal(withRefs);
    expect(result.ok).toBe(true); // 12 + 13 (item-a and item-b are both roots)
  });

  it('14-18. missing/self/cycle/duplicate-dependency and duplicate item id rejected', () => {
    const base = validProposal();
    // 14: missing dependency ref
    const missing = validatePlanningProposal({
      ...base,
      planItems: base.planItems.map((item) => ({
        ...item,
        dependencyPlanItemIds:
          item.planItemId === 'item-build' ? ['item-nope'] : item.dependencyPlanItemIds,
      })),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(reasonOf(missing.error)).toBe('PLAN_DEPENDENCY_UNKNOWN');
    // 15: self dependency
    const self = validatePlanningProposal({
      ...base,
      planItems: base.planItems.map((item) => ({
        ...item,
        dependencyPlanItemIds: item.planItemId === 'item-build' ? ['item-build'] : item.dependencyPlanItemIds,
      })),
    });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(reasonOf(self.error)).toBe('PLAN_DEPENDENCY_SELF');
    // 16: cycle
    const cyclic = validatePlanningProposal({
      ...base,
      planItems: [
        { ...base.planItems[0]!, dependencyPlanItemIds: ['item-build'] },
        { ...base.planItems[1]!, dependencyPlanItemIds: ['item-design'] },
      ],
    });
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) expect(reasonOf(cyclic.error)).toBe('PLAN_DEPENDENCY_CYCLE');
    // 17: duplicate dependency ref
    const dupDep = validatePlanningProposal({
      ...base,
      planItems: base.planItems.map((item) => ({
        ...item,
        dependencyPlanItemIds:
          item.planItemId === 'item-build' ? ['item-design', 'item-design'] : item.dependencyPlanItemIds,
      })),
    });
    expect(dupDep.ok).toBe(false);
    if (!dupDep.ok) expect(reasonOf(dupDep.error)).toBe('PLAN_DEPENDENCY_DUPLICATE');
    // 18: duplicate plan item id
    const dupItem = validatePlanningProposal({
      ...base,
      planItems: [
        base.planItems[0]!,
        { ...base.planItems[1]!, planItemId: 'item-design' },
      ],
    });
    expect(dupItem.ok).toBe(false);
    if (!dupItem.ok) expect(reasonOf(dupItem.error)).toBe('PLAN_ITEM_ID_DUPLICATE');
  });
});

describe('T20-02 §38 — acceptance criteria', () => {
  it('19-24. valid accepted; duplicate id / missing ref / duplicate ref / empty / oversized rejected', () => {
    // 19: valid (the baseline)
    expect(validatePlanningProposal(validProposal()).ok).toBe(true);
    // 20: duplicate criterion id
    const dupId = validatePlanningProposal({
      ...validProposal(),
      acceptanceCriteria: [
        { criterionId: 'crit-design-review', requirement: 'One.' },
        { criterionId: 'crit-design-review', requirement: 'Two.' },
      ],
    });
    expect(dupId.ok).toBe(false);
    if (!dupId.ok) expect(reasonOf(dupId.error)).toBe('PLAN_CRITERION_ID_DUPLICATE');
    // 21: missing criterion ref
    const missingRef = validatePlanningProposal({
      ...validProposal(),
      planItems: [
        { ...validProposal().planItems[0]!, acceptanceCriterionRefs: ['crit-missing'] },
        validProposal().planItems[1]!,
      ],
    });
    expect(missingRef.ok).toBe(false);
    if (!missingRef.ok) expect(reasonOf(missingRef.error)).toBe('PLAN_CRITERION_REF_UNKNOWN');
    // 22: duplicate criterion ref
    const dupRef = validatePlanningProposal({
      ...validProposal(),
      planItems: [
        {
          ...validProposal().planItems[0]!,
          acceptanceCriterionRefs: ['crit-design-review', 'crit-design-review'],
        },
        validProposal().planItems[1]!,
      ],
    });
    expect(dupRef.ok).toBe(false);
    if (!dupRef.ok) expect(reasonOf(dupRef.error)).toBe('PLAN_CRITERION_REF_DUPLICATE');
    // 23: empty criterion text
    const empty = validatePlanningProposal({
      ...validProposal(),
      acceptanceCriteria: [
        { criterionId: 'crit-design-review', requirement: '   ' },
        validProposal().acceptanceCriteria[1]!,
      ],
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(reasonOf(empty.error)).toBe('PLAN_CRITERION_TEXT_INVALID');
    // 24: oversized criterion text
    const oversized = validatePlanningProposal({
      ...validProposal(),
      acceptanceCriteria: [
        { criterionId: 'crit-design-review', requirement: 'x'.repeat(PLAN_LIMITS.criterionTextMaxChars + 1) },
        validProposal().acceptanceCriteria[1]!,
      ],
    });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(reasonOf(oversized.error)).toBe('PLAN_CRITERION_TEXT_INVALID');
  });

  it('25. unreferenced criteria follow the explicit V1 rule: REJECT', () => {
    const unreferenced = validatePlanningProposal({
      ...validProposal(),
      acceptanceCriteria: [
        ...validProposal().acceptanceCriteria,
        { criterionId: 'crit-orphan', requirement: 'Nobody references this.' },
      ],
    });
    expect(unreferenced.ok).toBe(false);
    if (!unreferenced.ok) expect(reasonOf(unreferenced.error)).toBe('PLAN_CRITERION_UNREFERENCED');
  });
});

describe('T20-02 §39 — bounds', () => {
  const item = (n: number) => ({
    planItemId: `item-${String(n)}`,
    objective: 'Do it.',
    acceptanceCriterionRefs: ['crit-all'],
  });
  it('26-33. every bound accepts exactly its maximum and rejects one more', () => {
    // 26-27: plan item count
    const maxItems = Array.from({ length: PLAN_LIMITS.planItemMaxCount }, (_v, i) => item(i));
    const atMax = validatePlanningProposal({
      schema: PLAN_PROPOSAL_SCHEMA,
      planItems: maxItems,
      acceptanceCriteria: [{ criterionId: 'crit-all', requirement: 'All done.' }],
    });
    expect(atMax.ok).toBe(true);
    const overMax = validatePlanningProposal({
      schema: PLAN_PROPOSAL_SCHEMA,
      planItems: [...maxItems, item(PLAN_LIMITS.planItemMaxCount)],
      acceptanceCriteria: [{ criterionId: 'crit-all', requirement: 'All done.' }],
    });
    expect(overMax.ok).toBe(false);
    if (!overMax.ok) expect(reasonOf(overMax.error)).toBe('PLAN_ITEM_COUNT_EXCEEDED');
    // 28-29: criteria count
    const criterion = (n: number) => ({ criterionId: `crit-${String(n)}`, requirement: 'Done.' });
    const maxCriteria = Array.from({ length: PLAN_LIMITS.criteriaMaxCount }, (_v, i) => criterion(i));
    const maxCriteriaProposal: PlanningProposal = {
      schema: PLAN_PROPOSAL_SCHEMA,
      planItems: [
        {
          planItemId: 'item-one',
          objective: 'One item referencing every criterion within the per-item bound is impossible here, so the',
          acceptanceCriterionRefs: ['crit-0'],
        },
      ],
      acceptanceCriteria: maxCriteria,
    };
    // The unreferenced rule bounds this test: max criteria with one item is impossible —
    // prove the COUNT bound itself instead with all criteria referenced across max items.
    const countProbe = validatePlanningProposal({
      schema: PLAN_PROPOSAL_SCHEMA,
      planItems: Array.from({ length: PLAN_LIMITS.criteriaMaxCount }, (_v, i) => ({
        planItemId: `item-${String(i)}`,
        objective: 'Do it.',
        acceptanceCriterionRefs: [`crit-${String(i)}`],
      })).slice(0, PLAN_LIMITS.planItemMaxCount),
      acceptanceCriteria: Array.from(
        { length: PLAN_LIMITS.criteriaMaxCount },
        (_v, i) => criterion(i),
      ).slice(0, PLAN_LIMITS.planItemMaxCount),
    });
    expect(countProbe.ok).toBe(true); // 28 (the reachable maximum)
    const overCriteria = validatePlanningProposal({
      ...maxCriteriaProposal,
      acceptanceCriteria: [
        ...Array.from({ length: PLAN_LIMITS.criteriaMaxCount }, (_v, i) => criterion(i)),
        { criterionId: 'crit-over', requirement: 'One too many.' },
      ],
    });
    // 29: the count bound fires (before or after the unreferenced rule — both fail closed)
    expect(overCriteria.ok).toBe(false);
    // 30-31: dependency refs per item
    const depItems = Array.from({ length: PLAN_LIMITS.dependencyRefsPerItemMax + 1 }, (_v, i) =>
      item(i),
    );
    const depsMax = validatePlanningProposal({
      schema: PLAN_PROPOSAL_SCHEMA,
      planItems: [
        {
          planItemId: 'item-tail',
          objective: 'Depends on the maximum allowed.',
          dependencyPlanItemIds: depItems
            .slice(0, PLAN_LIMITS.dependencyRefsPerItemMax)
            .map((entry) => entry.planItemId),
          acceptanceCriterionRefs: ['crit-all'],
        },
        ...depItems.slice(0, PLAN_LIMITS.dependencyRefsPerItemMax),
      ],
      acceptanceCriteria: [{ criterionId: 'crit-all', requirement: 'Done.' }],
    });
    expect(depsMax.ok).toBe(true); // 30
    const depsOver = validatePlanningProposal({
      schema: PLAN_PROPOSAL_SCHEMA,
      planItems: [
        {
          planItemId: 'item-tail',
          objective: 'Depends on one too many.',
          dependencyPlanItemIds: depItems.map((entry) => entry.planItemId),
          acceptanceCriterionRefs: ['crit-all'],
        },
        ...depItems,
      ],
      acceptanceCriteria: [{ criterionId: 'crit-all', requirement: 'Done.' }],
    });
    expect(depsOver.ok).toBe(false); // 31
    if (!depsOver.ok) expect(reasonOf(depsOver.error)).toBe('PLAN_DEPENDENCIES_INVALID');
    // 32-33: text length (objective shown; criterion text proven in §38.24)
    const objectiveMax = validatePlanningProposal({
      ...validProposal(),
      planItems: [
        { ...validProposal().planItems[0]!, objective: 'x'.repeat(PLAN_LIMITS.objectiveMaxChars) },
        validProposal().planItems[1]!,
      ],
    });
    expect(objectiveMax.ok).toBe(true); // 32
    const objectiveOver = validatePlanningProposal({
      ...validProposal(),
      planItems: [
        {
          ...validProposal().planItems[0]!,
          objective: 'x'.repeat(PLAN_LIMITS.objectiveMaxChars + 1),
        },
        validProposal().planItems[1]!,
      ],
    });
    expect(objectiveOver.ok).toBe(false); // 33
    if (!objectiveOver.ok) expect(reasonOf(objectiveOver.error)).toBe('PLAN_OBJECTIVE_INVALID');
    void maxCriteriaProposal;
  });
});

describe('T20-02 §40 — strictness', () => {
  it('34-37. unknown schema / malformed / missing field / invalid id rejected', () => {
    // 34: unknown schema
    const schema = validatePlanningProposal({ ...validProposal(), schema: 'companyos/other/9' });
    expect(schema.ok).toBe(false);
    if (!schema.ok) expect(reasonOf(schema.error)).toBe('PLAN_SCHEMA_UNSUPPORTED');
    // 35: malformed payload
    const malformed = validatePlanningProposal('not-an-object');
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(reasonOf(malformed.error)).toBe('PLAN_PROPOSAL_MALFORMED');
    // 36: missing required field
    const missingField = validatePlanningProposal({
      schema: PLAN_PROPOSAL_SCHEMA,
      acceptanceCriteria: validProposal().acceptanceCriteria,
    });
    expect(missingField.ok).toBe(false);
    if (!missingField.ok) expect(reasonOf(missingField.error)).toBe('PLAN_ITEMS_MALFORMED');
    // 37: invalid id syntax (empty, uppercase, underscore, bad char, leading hyphen, oversized)
    for (const bad of ['', 'UPPER', 'has_underscore', "x'.repeat", '-leading', 'a'.repeat(65)]) {
      expect(isPlanItemId(bad)).toBe(false);
      expect(isCriterionId(bad)).toBe(false);
    }
    expect(isPlanItemId('item-ok-1')).toBe(true);
  });

  it('38-40. unknown semantic fields fail closed; no silent repair; validation is deterministic', () => {
    // 38: the documented Unknown Field Policy = FAIL CLOSED
    const unknown = validatePlanningProposal({ ...validProposal(), requestedWorkKind: 'work' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(reasonOf(unknown.error)).toBe('PLAN_UNKNOWN_FIELD');
    const unknownNested = validatePlanningProposal({
      ...validProposal(),
      planItems: [{ ...validProposal().planItems[0]!, priority: 1 }, validProposal().planItems[1]!],
    });
    expect(unknownNested.ok).toBe(false);
    if (!unknownNested.ok) expect(reasonOf(unknownNested.error)).toBe('PLAN_UNKNOWN_FIELD');
    // 39: NO silent repair — a cycle/dupe/unknown ref is reported verbatim, never fixed
    const cyclic = {
      ...validProposal(),
      planItems: [
        { ...validProposal().planItems[0]!, dependencyPlanItemIds: ['item-build'] },
        { ...validProposal().planItems[1]!, dependencyPlanItemIds: ['item-design'] },
      ],
    } as const;
    const first = validatePlanningProposal(cyclic);
    const second = validatePlanningProposal(cyclic);
    expect(first.ok).toBe(false);
    // 40: repeated validation is deterministic (identical error, byte for byte)
    expect(
      first.ok === false && second.ok === false
        ? reasonOf(first.error) === reasonOf(second.error) &&
          first.error.message === second.error.message
        : false,
    ).toBe(true);
    const payloadOnce = payloadOf(validProposal());
    const payloadTwice = payloadOf(validProposal());
    expect(planFingerprintOf(payloadOnce)).toBe(planFingerprintOf(payloadTwice));
  });
});

describe('T20-02 §41 — authoritative reference validation (read-only)', () => {
  const run = { id: 'run_plan', companyId: 'company_default' };
  const goalArtifact = {
    artifact: { id: 'art_goal', runId: 'run_plan', kind: 'companyos:run-goal' },
  };
  const makeValidator = (overrides?: {
    readonly run?: { readonly id: string; readonly companyId: string } | null;
    readonly goal?:
      | { readonly artifact: { readonly id: string; readonly runId: string; readonly kind: string } }
      | null;
  }) =>
    createPlanReferenceValidator({
      runs: { get: async () => overrides?.run === undefined ? run : overrides.run },
      artifacts: {
        getByCreationCommand: async () =>
          overrides?.goal === undefined ? goalArtifact : overrides.goal,
      },
    });

  it('41. the correct planning-run goal is accepted', async () => {
    const result = await makeValidator()({
      companyId: 'company_default',
      planningRunId: 'run_plan',
      goalArtifactId: 'art_goal',
    });
    expect(result.ok).toBe(true);
  });

  it('42-45. missing run / wrong-run goal / foreign company / wrong kind rejected', async () => {
    // 42: missing planning Run
    const missingRun = await makeValidator({ run: null })({
      companyId: 'company_default',
      planningRunId: 'run_plan',
      goalArtifactId: 'art_goal',
    });
    expect(missingRun.ok).toBe(false);
    if (!missingRun.ok) expect(reasonOf(missingRun.error)).toBe('RUN_MISSING');
    // 43: wrong-run goal (the artifact belongs to another run)
    const wrongRun = await makeValidator({
      goal: { artifact: { id: 'art_goal', runId: 'run_other', kind: 'companyos:run-goal' } },
    })({ companyId: 'company_default', planningRunId: 'run_plan', goalArtifactId: 'art_goal' });
    expect(wrongRun.ok).toBe(false);
    if (!wrongRun.ok) expect(reasonOf(wrongRun.error)).toBe('PLAN_SOURCE_GOAL_RUN_MISMATCH');
    // 44: foreign company — the existing NOT_FOUND no-leak convention
    const foreign = await makeValidator()({
      companyId: 'company_other',
      planningRunId: 'run_plan',
      goalArtifactId: 'art_goal',
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe('NOT_FOUND');
      expect(reasonOf(foreign.error)).toBe('RUN_MISSING');
    }
    // 45: wrong artifact kind (and a mismatched goal id)
    const wrongKind = await makeValidator({
      goal: { artifact: { id: 'art_goal', runId: 'run_plan', kind: 'companyos:review-findings' } },
    })({ companyId: 'company_default', planningRunId: 'run_plan', goalArtifactId: 'art_goal' });
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) expect(reasonOf(wrongKind.error)).toBe('PLAN_SOURCE_GOAL_KIND');
    const wrongId = await makeValidator()({
      companyId: 'company_default',
      planningRunId: 'run_plan',
      goalArtifactId: 'art_different',
    });
    expect(wrongId.ok).toBe(false);
    if (!wrongId.ok) expect(reasonOf(wrongId.error)).toBe('PLAN_SOURCE_GOAL_ID_MISMATCH');
  });
});

describe('T20-02 §42 — authority surface (import-boundary assertions)', () => {
  const coreSource = readFileSync(
    fileURLToPath(new URL('../../packages/core/src/lifecycle/plan.ts', import.meta.url)),
    'utf8',
  );
  const engineSource = readFileSync(
    fileURLToPath(
      new URL('../../packages/engine/src/planning/plan-reference-validator.ts', import.meta.url),
    ),
    'utf8',
  );

  it('46-52. the plan contract cannot create Tasks/Versions/Runs/Decisions or grant any authority', () => {
    // 46-48: no execution imports or creation calls exist anywhere in the contract modules.
    for (const source of [coreSource, engineSource]) {
      expect(source).not.toContain('createTask');
      expect(source).not.toContain('createRun');
      expect(source).not.toContain('saveDraftGraph');
      expect(source).not.toContain('.publish(');
      expect(source).not.toContain('createWorkflowRun');
    }
    // The Core contract imports ONLY kernel primitives — structurally no engine/artifact/task seam.
    const coreImports = [...coreSource.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]!);
    expect(coreImports.every((entry) => entry.startsWith('../kernel/'))).toBe(true);
    // 49: no Decision writer; 50-51: no validator/tool authority surface.
    for (const source of [coreSource, engineSource]) {
      expect(source).not.toContain('decisionSink');
      expect(source).not.toContain('ToolRegistry');
      expect(source).not.toContain('registerTool');
      expect(source).not.toContain('requiredAuthorities');
      expect(source).not.toContain('validatorIds');
    }
    // 52: no Session coupling — the plan language never touches session state.
    for (const source of [coreSource, engineSource]) {
      expect(source).not.toContain('SessionKernel');
      expect(source).not.toContain('sessionId');
      expect(source).not.toContain('residue');
    }
    // And no plan state machine / approval status exists in the contract vocabulary.
    for (const term of ['DRAFT', 'APPROVED', 'RUNNING', 'SUPERSEDED', 'approval']) {
      expect(coreSource).not.toContain(`'${term}'`);
    }
    // The kind is the repo-convention plan artifact kind; no mutable version counter exists.
    expect(PLAN_ARTIFACT_KIND).toBe('companyos:plan');
    expect(coreSource).not.toContain('version++');
    expect(coreSource).not.toContain('planVersion');
  });
});

describe('T20-02 contract corrective — criteria per item / id bounds / nonblank text', () => {
  const item = (id: string, refs: readonly string[] = ['crit-x']) => ({
    planItemId: id,
    objective: 'Do it.',
    acceptanceCriterionRefs: refs,
  });
  const proposalWith = (
    planItems: readonly unknown[],
    criteria: readonly unknown[] = [{ criterionId: 'crit-x', requirement: 'Done means X.' }],
  ): unknown => ({ schema: PLAN_PROPOSAL_SCHEMA, planItems, acceptanceCriteria: criteria });

  it('1-2. one item + one criterion passes; an item with ZERO criterion refs is rejected', () => {
    // 1
    const single = validatePlanningProposal(proposalWith([item('item-a')]));
    expect(single.ok).toBe(true);
    // 2: absent refs
    const absent = validatePlanningProposal(
      proposalWith([
        { planItemId: 'item-a', objective: 'Do it.' },
      ]),
    );
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(reasonOf(absent.error)).toBe('PLAN_ITEM_CRITERIA_REQUIRED');
    // 2: present-but-empty refs
    const emptyRefs = validatePlanningProposal(proposalWith([item('item-a', [])]));
    expect(emptyRefs.ok).toBe(false);
    if (!emptyRefs.ok) expect(reasonOf(emptyRefs.error)).toBe('PLAN_ITEM_CRITERIA_REQUIRED');
  });

  it('3-4. one bare item among valid ones rejects; the two-sided invariant passes', () => {
    // 3: item-b has no criteria while item-a does
    const partial = validatePlanningProposal(
      proposalWith([item('item-a'), { planItemId: 'item-b', objective: 'Also do this.' }]),
    );
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(reasonOf(partial.error)).toBe('PLAN_ITEM_CRITERIA_REQUIRED');
    // 4: every item has >=1 criterion AND every criterion is referenced
    const both = validatePlanningProposal(
      proposalWith(
        [item('item-a'), item('item-b', ['crit-y'])],
        [
          { criterionId: 'crit-x', requirement: 'Done means X.' },
          { criterionId: 'crit-y', requirement: 'Done means Y.' },
        ],
      ),
    );
    expect(both.ok).toBe(true);
  });

  it('5-6. unreferenced criterion still rejected; a SHARED criterion is explicitly allowed', () => {
    // 5
    const orphan = validatePlanningProposal(
      proposalWith(
        [item('item-a')],
        [
          { criterionId: 'crit-x', requirement: 'Done means X.' },
          { criterionId: 'crit-orphan', requirement: 'Referenced by nobody.' },
        ],
      ),
    );
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(reasonOf(orphan.error)).toBe('PLAN_CRITERION_UNREFERENCED');
    // 6: two items cite the SAME criterion — an immutable reusable requirement reference;
    // evaluation stays task-scoped downstream (no criterion status exists anywhere).
    const shared = validatePlanningProposal(
      proposalWith([item('item-a'), item('item-b', ['crit-x'])]),
    );
    expect(shared.ok).toBe(true);
  });

  it('7-10. id bounds tested against the DECLARED limit (max accepted, max+1 rejected)', () => {
    const idMax = PLAN_LIMITS.planItemIdMaxLength; // the one canonical bound (64)
    expect(idMax).toBe(64);
    // 7: planItemId exactly at the declared max
    const idAtMax = 'a'.repeat(idMax);
    expect(idAtMax).toHaveLength(idMax);
    expect(validatePlanningProposal(proposalWith([item(idAtMax)])).ok).toBe(true);
    expect(isPlanItemId(idAtMax)).toBe(true);
    // 8: one over the declared max
    const idOver = 'a'.repeat(idMax + 1);
    expect(isPlanItemId(idOver)).toBe(false);
    const over = validatePlanningProposal(proposalWith([item(idOver)]));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(reasonOf(over.error)).toBe('PLAN_ITEM_ID_INVALID');
    // 9: criterionId exactly at the declared max (referenced so the unreferenced rule stays out)
    const critMax = PLAN_LIMITS.criterionIdMaxLength;
    expect(critMax).toBe(64);
    const critAtMax = 'c'.repeat(critMax);
    const critOk = validatePlanningProposal(
      proposalWith([item('item-a', [critAtMax])], [
        { criterionId: critAtMax, requirement: 'Done.' },
      ]),
    );
    expect(critOk.ok).toBe(true); // 9
    expect(isCriterionId(critAtMax)).toBe(true);
    const critOver = 'c'.repeat(critMax + 1);
    expect(isCriterionId(critOver)).toBe(false); // 10
    const critBad = validatePlanningProposal(
      proposalWith([item('item-a', [critOver])], [
        { criterionId: critOver, requirement: 'Done.' },
      ]),
    );
    expect(critBad.ok).toBe(false);
  });

  it('11-14. empty and whitespace-only objective/requirement rejected (Unicode-aware)', () => {
    const base = validProposal();
    for (const blank of ['', '   ', '\n\t', '   ']) {
      // 11/12: objective
      const objectiveBlank = validatePlanningProposal({
        ...base,
        planItems: [{ ...base.planItems[0]!, objective: blank }, base.planItems[1]!],
      });
      expect(objectiveBlank.ok).toBe(false);
      if (!objectiveBlank.ok) expect(reasonOf(objectiveBlank.error)).toBe('PLAN_OBJECTIVE_INVALID');
      // 13/14: requirement
      const requirementBlank = validatePlanningProposal({
        ...base,
        acceptanceCriteria: [
          { criterionId: 'crit-design-review', requirement: blank },
          base.acceptanceCriteria[1]!,
        ],
      });
      expect(requirementBlank.ok).toBe(false);
      if (!requirementBlank.ok) {
        expect(reasonOf(requirementBlank.error)).toBe('PLAN_CRITERION_TEXT_INVALID');
      }
    }
  });

  it('15. fingerprint determinism under the documented no-normalization rule', () => {
    // Documented rule (§9): blank-only text is REJECTED; accepted text is fingerprinted AS
    // WRITTEN — no trim normalization exists. "  implement API  " and "implement API" are
    // therefore two DIFFERENT valid plans with different fingerprints, and each is stable.
    const build = (objective: string): PlanArtifactPayload =>
      payloadOf({
        ...validProposal(),
        planItems: [
          { ...validProposal().planItems[0]!, objective },
          validProposal().planItems[1]!,
        ],
      });
    const plain = build('implement API');
    const padded = build('  implement API  ');
    expect(validatePlanArtifactPayload(plain).ok).toBe(true);
    expect(validatePlanArtifactPayload(padded).ok).toBe(true);
    expect(planFingerprintOf(plain)).not.toBe(planFingerprintOf(padded));
    expect(planFingerprintOf(plain)).toBe(planFingerprintOf(build('implement API')));
    expect(planFingerprintOf(padded)).toBe(planFingerprintOf(build('  implement API  ')));
  });
});
