/**
 * Sprint 2 Task 1 — deterministic branch evaluation (Core side).
 */
import { describe, expect, it } from 'vitest';

import {
  BRANCH_OPERATORS,
  evaluateBranch,
  evaluateCondition,
  readField,
  selectBranch,
  validateBranchSet,
  type BranchSet,
} from '@companyos/core';

import { expectErr, expectOk } from './support.js';

const SET: BranchSet = {
  defaultBranch: 'default',
  rules: [
    { id: 'r1', when: [{ field: 'a', op: 'eq', value: 1 }], to: 'one' },
    { id: 'r2', when: [{ field: 'b', op: 'exists' }], to: 'two' },
    { id: 'r3', when: [{ field: 'c', op: 'gt', value: 10 }, { field: 'd', op: 'in', value: ['x'] }], to: 'three' },
  ],
};

describe('branch conditions', () => {
  it('supports every declared operator', () => {
    expect([...BRANCH_OPERATORS]).toEqual(['eq', 'neq', 'in', 'exists', 'gt', 'gte', 'lt', 'lte']);
    expect(evaluateCondition({ field: 'a', op: 'eq', value: 1 }, { a: 1 })).toBe(true);
    expect(evaluateCondition({ field: 'a', op: 'neq', value: 1 }, { a: 2 })).toBe(true);
    expect(evaluateCondition({ field: 'a', op: 'in', value: [1, 2] }, { a: 2 })).toBe(true);
    expect(evaluateCondition({ field: 'a', op: 'exists' }, { a: null })).toBe(false);
    expect(evaluateCondition({ field: 'a', op: 'exists' }, { a: 0 })).toBe(true);
    expect(evaluateCondition({ field: 'a', op: 'gt', value: 1 }, { a: 2 })).toBe(true);
    expect(evaluateCondition({ field: 'a', op: 'gte', value: 2 }, { a: 2 })).toBe(true);
    expect(evaluateCondition({ field: 'a', op: 'lt', value: 1 }, { a: 0 })).toBe(true);
    expect(evaluateCondition({ field: 'a', op: 'lte', value: 0 }, { a: 0 })).toBe(true);
  });

  it('is total: unknown fields, wrong types and NaN never throw', () => {
    expect(evaluateCondition({ field: 'missing', op: 'eq', value: 1 }, {})).toBe(false);
    expect(evaluateCondition({ field: 'a', op: 'gt', value: 1 }, { a: 'two' })).toBe(false);
    expect(evaluateCondition({ field: 'a', op: 'gt', value: 1 }, { a: Number.NaN })).toBe(false);
    expect(evaluateCondition({ field: 'a', op: 'in', value: 'not-an-array' }, { a: 'x' })).toBe(false);
  });

  it('reads dotted paths', () => {
    expect(readField({ a: { b: { c: 3 } } }, 'a.b.c')).toBe(3);
    expect(readField({ a: { b: 2 } }, 'a.b.c')).toBeUndefined();
    expect(readField({ a: null }, 'a.b')).toBeUndefined();
    expect(readField({}, 'a')).toBeUndefined();
  });
});

describe('branch selection', () => {
  it('takes the first matching rule', () => {
    expect(evaluateBranch(SET, { a: 1, b: 1 })).toBe('one');
    expect(evaluateBranch(SET, { b: 1 })).toBe('two');
    expect(evaluateBranch(SET, { c: 11, d: 'x' })).toBe('three');
    expect(evaluateBranch(SET, { c: 11, d: 'y' })).toBe('default');
    expect(evaluateBranch(SET, {})).toBe('default');
  });

  it('reports which rule decided, and is deterministic', () => {
    expect(selectBranch(SET, { b: 1 })).toEqual({ branch: 'two', ruleId: 'r2' });
    expect(selectBranch(SET, {})).toEqual({ branch: 'default', ruleId: null });
    expect(selectBranch(SET, { a: 1 })).toEqual(selectBranch(SET, { a: 1 }));
  });

  it('validates a declarative branch set', () => {
    const valid = expectOk(validateBranchSet(SET));
    expect(valid.rules).toHaveLength(3);

    expect(expectErr(validateBranchSet(null)).code).toBe('INVALID_ARGUMENT');
    expect(expectErr(validateBranchSet({ rules: [] })).code).toBe('INVALID_ARGUMENT');
    expect(expectErr(validateBranchSet({ defaultBranch: 'd', rules: 'x' })).code).toBe('INVALID_ARGUMENT');
    expect(expectErr(validateBranchSet({ defaultBranch: 'd', rules: [{}] })).code).toBe('INVALID_ARGUMENT');
    expect(
      expectErr(
        validateBranchSet({
          defaultBranch: 'd',
          rules: [{ id: 'a', to: 'x', when: [] }, { id: 'a', to: 'y', when: [] }],
        }),
      ).code,
    ).toBe('ALREADY_EXISTS');
    expect(
      expectErr(
        validateBranchSet({ defaultBranch: 'd', rules: [{ id: 'a', to: 'x', when: [{ field: 'f', op: 'nope' }] }] }),
      ).code,
    ).toBe('INVALID_ARGUMENT');
    expect(
      expectErr(validateBranchSet({ defaultBranch: 'd', rules: [{ id: 'a', to: 'x', when: [{ op: 'eq' }] }] })).code,
    ).toBe('INVALID_ARGUMENT');
  });
});
