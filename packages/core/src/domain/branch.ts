/**
 * Deterministic branch evaluation (Sprint 2 requirement 10: "Branch 的最小确定性语义").
 *
 * Deliberately NOT an expression language: a branch set is declared data, so it can
 * be stored inside a `WorkflowVersion` graph, content-hashed (规划书 §十一) and
 * replayed bit-for-bit. Evaluation rules:
 *
 *   1. rules are evaluated **in declaration order**;
 *   2. the FIRST rule whose conditions ALL hold wins;
 *   3. if none matches, `defaultBranch` is selected (never "undefined behaviour");
 *   4. a missing/unknown field makes a condition false, except `exists`;
 *   5. no rule may be selected by side effect — evaluation is pure.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';

export const BRANCH_OPERATORS = ['eq', 'neq', 'in', 'exists', 'gt', 'gte', 'lt', 'lte'] as const;
export type BranchOperator = (typeof BRANCH_OPERATORS)[number];

export interface BranchCondition {
  /** Dotted path into the flat/dotted context, e.g. `risk.level`. */
  readonly field: string;
  readonly op: BranchOperator;
  readonly value?: unknown;
}

export interface BranchRule {
  readonly id: string;
  readonly when: readonly BranchCondition[];
  /** Branch target id (opaque; the engine maps it to the next stage/command). */
  readonly to: string;
}

export interface BranchSet {
  readonly rules: readonly BranchRule[];
  /** Selected when no rule matches. Must be non-empty. */
  readonly defaultBranch: string;
}

export type BranchContext = Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Resolve a dotted path; returns `undefined` when any segment is missing. */
export function readField(context: BranchContext, field: string): unknown {
  const segments = field.split('.');
  let current: unknown = context;
  for (const segment of segments) {
    const record = asRecord(current);
    if (record === null || !(segment in record)) return undefined;
    current = record[segment];
  }
  return current;
}

const compareOrdered = (
  actual: unknown,
  expected: unknown,
  op: 'gt' | 'gte' | 'lt' | 'lte',
): boolean => {
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  if (Number.isNaN(actual) || Number.isNaN(expected)) return false;
  if (op === 'gt') return actual > expected;
  if (op === 'gte') return actual >= expected;
  if (op === 'lt') return actual < expected;
  return actual <= expected;
};

/** Pure, total: never throws, never returns "maybe". */
export function evaluateCondition(condition: BranchCondition, context: BranchContext): boolean {
  const actual = readField(context, condition.field);
  switch (condition.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return actual === condition.value;
    case 'neq':
      return actual !== condition.value;
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(actual);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareOrdered(actual, condition.value, condition.op);
    default:
      return false;
  }
}

export const evaluateRule = (rule: BranchRule, context: BranchContext): boolean =>
  rule.when.every((condition) => evaluateCondition(condition, context));

/** First matching rule wins; otherwise the declared default. */
export function evaluateBranch(branchSet: BranchSet, context: BranchContext): string {
  for (const rule of branchSet.rules) {
    if (evaluateRule(rule, context)) return rule.to;
  }
  return branchSet.defaultBranch;
}

/** Which rule produced the decision — needed for audit and for deterministic tests. */
export const selectBranch = (
  branchSet: BranchSet,
  context: BranchContext,
): { readonly branch: string; readonly ruleId: string | null } => {
  for (const rule of branchSet.rules) {
    if (evaluateRule(rule, context)) return { branch: rule.to, ruleId: rule.id };
  }
  return { branch: branchSet.defaultBranch, ruleId: null };
};

export function validateBranchSet(value: unknown): Result<BranchSet, DomainError> {
  const record = asRecord(value);
  if (record === null) {
    return err(domainError('INVALID_ARGUMENT', 'A branch set must be an object.', {}));
  }
  const defaultBranch = record['defaultBranch'];
  if (typeof defaultBranch !== 'string' || defaultBranch.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'defaultBranch is required.', {}));
  }
  const rawRules = record['rules'];
  if (!Array.isArray(rawRules)) {
    return err(domainError('INVALID_ARGUMENT', 'rules must be an array.', {}));
  }
  const rules: BranchRule[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawRules.entries()) {
    const rule = asRecord(raw);
    if (rule === null) {
      return err(domainError('INVALID_ARGUMENT', `rules[${index}] must be an object.`, { index }));
    }
    const id = rule['id'];
    const to = rule['to'];
    if (typeof id !== 'string' || id.trim().length === 0) {
      return err(domainError('INVALID_ARGUMENT', `rules[${index}].id is required.`, { index }));
    }
    if (seen.has(id)) {
      return err(domainError('ALREADY_EXISTS', `Duplicate branch rule id "${id}".`, { id }));
    }
    seen.add(id);
    if (typeof to !== 'string' || to.trim().length === 0) {
      return err(domainError('INVALID_ARGUMENT', `rules[${index}].to is required.`, { id }));
    }
    const when = rule['when'];
    if (!Array.isArray(when)) {
      return err(domainError('INVALID_ARGUMENT', `rules[${index}].when must be an array.`, { id }));
    }
    const conditions: BranchCondition[] = [];
    for (const [cIndex, rawCondition] of when.entries()) {
      const condition = asRecord(rawCondition);
      if (condition === null) {
        return err(
          domainError('INVALID_ARGUMENT', `rules[${index}].when[${cIndex}] must be an object.`, { id }),
        );
      }
      const field = condition['field'];
      const op = condition['op'];
      if (typeof field !== 'string' || field.trim().length === 0) {
        return err(domainError('INVALID_ARGUMENT', `when[${cIndex}].field is required.`, { id }));
      }
      if (typeof op !== 'string' || !(BRANCH_OPERATORS as readonly string[]).includes(op)) {
        return err(
          domainError('INVALID_ARGUMENT', `when[${cIndex}].op must be one of ${BRANCH_OPERATORS.join(', ')}.`, {
            id,
            op: String(op),
          }),
        );
      }
      conditions.push({
        field,
        op: op as BranchOperator,
        ...(condition['value'] === undefined ? {} : { value: condition['value'] }),
      });
    }
    rules.push({ id, when: conditions, to });
  }
  return ok({ rules, defaultBranch });
}
