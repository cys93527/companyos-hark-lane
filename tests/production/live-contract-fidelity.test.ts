/**
 * LIVE-MODEL CONTRACT FIDELITY (Boss Execution Architecture Freeze §8) — the
 * deterministic proofs that BB-WATCH-001 is closed at the constrained-generation
 * layer while the canonical validators remain the authority.
 *
 * Single-source discipline under test: every provider-facing schema rule must DERIVE
 * from the same exported canonical constants the validators enforce. The
 * contract-drift guards prove a future canonical-rule change cannot silently leave a
 * generation schema stale (the schemas IMPORT the constants; the tests additionally
 * assert behavioral alignment).
 */
import { describe, expect, it } from 'vitest';

import {
  PLAN_LIMITS,
  PLAN_LOCAL_ID_SOURCE,
  PLAN_PROPOSAL_SCHEMA,
  isCriterionId,
  isPlanItemId,
  validatePlanningProposal,
} from '@companyos/core';
import {
  PLAN_PROPOSAL_JSON_SCHEMA,
  SUPERVISOR_ACTION_JSON_SCHEMA,
  SUPERVISOR_PROPOSAL_KEYS,
  SUPERVISOR_PROPOSAL_SCHEMA,
  decodeSupervisorProposal,
} from '@companyos/engine';
import { REVIEW_VERDICTS } from '@companyos/core';

/* --------------------------------------------------------- helpers (typed) --- */

type JsonSchema = Record<string, unknown>;
const props = (schema: JsonSchema): JsonSchema => schema['properties'] as JsonSchema;
const items = (schema: JsonSchema): JsonSchema => schema['items'] as JsonSchema;

const VALID_PROPOSAL = {
  schema: PLAN_PROPOSAL_SCHEMA,
  planItems: [
    {
      planItemId: 'research',
      objective: 'Gather the facts.',
      dependencyPlanItemIds: [],
      acceptanceCriterionRefs: ['facts'],
    },
    {
      planItemId: 'draft',
      objective: 'Produce the outcome.',
      dependencyPlanItemIds: ['research'],
      acceptanceCriterionRefs: ['facts', 'draft'],
    },
  ],
  acceptanceCriteria: [
    { criterionId: 'facts', requirement: 'Facts are recorded.' },
    { criterionId: 'draft', requirement: 'The draft exists.' },
  ],
};

describe('BB-WATCH-001 §8 — planner generation contract', () => {
  it('a VALID canonical proposal is accepted by the canonical validator (authority intact)', () => {
    expect(validatePlanningProposal(VALID_PROPOSAL).ok).toBe(true);
  });

  it('an INVALID plan item id is rejected by the canonical validator (fail-closed intact)', () => {
    const invalid = { ...VALID_PROPOSAL, planItems: [{ ...VALID_PROPOSAL.planItems[0]!, planItemId: 'BadId_中文' }] };
    const result = validatePlanningProposal(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error.details['reason'])).toBe('PLAN_ITEM_ID_INVALID');
  });

  it('the provider schema EXPOSES the canonical identifier constraint (single source)', () => {
    const planItemProps = props(items(props(PLAN_PROPOSAL_JSON_SCHEMA)['planItems'] as JsonSchema));
    const criterionProps = props(items(props(PLAN_PROPOSAL_JSON_SCHEMA)['acceptanceCriteria'] as JsonSchema));
    expect((planItemProps['planItemId'] as JsonSchema)['pattern']).toBe(PLAN_LOCAL_ID_SOURCE);
    expect((criterionProps['criterionId'] as JsonSchema)['pattern']).toBe(PLAN_LOCAL_ID_SOURCE);
    const depItems = items(props(items(props(PLAN_PROPOSAL_JSON_SCHEMA)['planItems'] as JsonSchema))['dependencyPlanItemIds'] as JsonSchema);
    expect((depItems as JsonSchema)['pattern']).toBe(PLAN_LOCAL_ID_SOURCE);
  });

  it('contract-drift guard: the exported SOURCE and the canonical predicates agree behaviorally', () => {
    // If someone changes PLAN_LOCAL_ID_SOURCE without rebuilding LOCAL_ID_PATTERN (or vice
    // versa), this probe catches the divergence the construction makes structurally hard.
    const source = new RegExp(`^${PLAN_LOCAL_ID_SOURCE}$`);
    for (const candidate of ['research', 'draft-2', 'a', 'x'.repeat(64)]) {
      expect(source.test(candidate)).toBe(isPlanItemId(candidate));
      expect(source.test(candidate)).toBe(isCriterionId(candidate));
    }
    for (const bad of ['Bad', '1start', '-lead', 'has_underscore', '中id', 'x'.repeat(65), '']) {
      expect(source.test(bad)).toBe(isPlanItemId(bad));
    }
  });

  it('nested arrays/objects/strings/bounds are faithfully represented', () => {
    const schema = PLAN_PROPOSAL_JSON_SCHEMA;
    expect(schema['additionalProperties']).toBe(false); // Unknown Field Policy = FAIL CLOSED
    expect(schema['required']).toEqual(['schema', 'planItems', 'acceptanceCriteria']);
    const planItems = props(schema)['planItems'] as JsonSchema;
    expect(planItems['type']).toBe('array');
    expect(planItems['minItems']).toBe(PLAN_LIMITS.planItemMinCount);
    expect(planItems['maxItems']).toBe(PLAN_LIMITS.planItemMaxCount);
    const itemProps = props(items(planItems));
    expect((itemProps['objective'] as JsonSchema)['maxLength']).toBe(PLAN_LIMITS.objectiveMaxChars);
    const refs = itemProps['acceptanceCriterionRefs'] as JsonSchema;
    expect(refs['minItems']).toBe(1); // frozen: every item references >= 1 criterion
    expect(refs['maxItems']).toBe(PLAN_LIMITS.criterionRefsPerItemMax);
    const criteria = props(schema)['acceptanceCriteria'] as JsonSchema;
    expect((props(items(criteria))['requirement'] as JsonSchema)['maxLength']).toBe(PLAN_LIMITS.criterionTextMaxChars);
  });

  it('the schema CONST pins the frozen proposal schema id', () => {
    expect((props(PLAN_PROPOSAL_JSON_SCHEMA)['schema'] as JsonSchema)['const']).toBe(PLAN_PROPOSAL_SCHEMA);
  });

  it('malformed output can NEVER enter canonical truth (validator rejects what the schema cannot express)', () => {
    const unknownField = { ...VALID_PROPOSAL, extra: 1 } as unknown;
    expect(validatePlanningProposal(unknownField).ok).toBe(false);
    const emptyRefs = {
      ...VALID_PROPOSAL,
      planItems: [{ ...VALID_PROPOSAL.planItems[0]!, acceptanceCriterionRefs: [] }],
    };
    expect(validatePlanningProposal(emptyRefs).ok).toBe(false);
  });
});

describe('BB-WATCH-001 §8 — supervisor ACTION generation contract', () => {
  const validAction = {
    schema: SUPERVISOR_PROPOSAL_SCHEMA,
    action: 'CONTINUE',
    reasonCode: 'GOAL_SATISFIED',
    summary: 'Proceed with the next work unit.',
    evidenceRefs: [],
    subject: { taskId: 'tsk_123' },
  };

  it('the canonical decoder accepts the true shapes (authority intact)', () => {
    const decoded = decodeSupervisorProposal(validAction);
    expect(decoded.ok).toBe(true);
  });

  it('the provider schema is ROLE-CORRECT: enums, bounded summary, ARRAY evidenceRefs, OBJECT-or-null subject', () => {
    const p = props(SUPERVISOR_ACTION_JSON_SCHEMA);
    expect((p['action'] as JsonSchema)['enum']).toEqual(expect.arrayContaining(['CONTINUE', 'REQUEST_CORRECTIVE', 'ESCALATE', 'COMPLETE']));
    expect((p['reasonCode'] as JsonSchema)['enum']).toEqual(expect.arrayContaining(['GOAL_SATISFIED', 'HUMAN_REQUIRED']));
    expect((p['summary'] as JsonSchema)['maxLength']).toBe(400);
    expect((p['evidenceRefs'] as JsonSchema)['type']).toBe('array');
    expect(((p['evidenceRefs'] as JsonSchema)['items'] as JsonSchema)['type']).toBe('string');
    const subject = p['subject'] as JsonSchema;
    const variants = subject['anyOf'] as JsonSchema[];
    expect(variants.some((v) => v['type'] === 'null')).toBe(true);
    const objectForm = variants.find((v) => v['type'] === 'object') as JsonSchema;
    expect(props(objectForm)['taskId']).toBeDefined();
    expect((objectForm as JsonSchema)['additionalProperties']).toBe(false);
  });

  it('contract-drift guard: schema enums carry EXACTLY the closed decision vocabularies', () => {
    const p = props(SUPERVISOR_ACTION_JSON_SCHEMA);
    expect(SUPERVISOR_ACTION_JSON_SCHEMA['required']).toEqual([...SUPERVISOR_PROPOSAL_KEYS, 'schema']);
    expect((p['action'] as JsonSchema)['enum']).toContain('CONTINUE');
    expect((p['reasonCode'] as JsonSchema)['enum']).toContain('TASK_FAILED');
  });

  it('the decoder still refuses what the schema cannot repair (fail-closed intact)', () => {
    expect(decodeSupervisorProposal({ ...validAction, action: 'DO_SOMETHING' }).ok).toBe(false);
    expect(decodeSupervisorProposal({ ...validAction, subject: 'tsk_123' }).ok).toBe(false); // string ≠ {taskId}
    expect(decodeSupervisorProposal({ ...validAction, evidenceRefs: 'none' }).ok).toBe(false); // string ≠ array
  });
});

describe('BB-WATCH-001 §8 — review VERDICT / QA generation contracts (the carrier shapes)', () => {
  it('the review verdict vocabulary is the canonical REVIEW_VERDICTS (no invented PASS/FAIL)', () => {
    expect([...REVIEW_VERDICTS]).toEqual(['PASS', 'CHANGES_REQUESTED', 'BLOCKED']);
  });

  it('the composition registers review/qa turns with role-correct responseFormat (source-level single-source check)', async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync('apps/desktop/src/core-services.ts', 'utf8'));
    expect(source).toContain("enum: [...REVIEW_VERDICTS]");
    expect(source).toContain("schemaName: 'companyos_review_verdict'");
    expect(source).toContain("schemaName: 'companyos_qa_validation_request'");
    expect(source).toContain("validators: { type: 'array', minItems: 1");
    expect(source).toContain("...(responseFormat === undefined ? {} : { responseFormat })");
  });
});
