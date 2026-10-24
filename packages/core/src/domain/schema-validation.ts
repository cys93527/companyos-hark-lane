/**
 * Deterministic JSON-Schema-subset validation (Sprint 9 §六).
 *
 * Core has zero runtime dependencies, so this is a hand-written validator over the subset a
 * tool contract actually needs. It is intentionally strict and deterministic:
 *  - supported keywords: type · properties · required · additionalProperties · items · enum ·
 *    const · minLength · maxLength · minimum · maximum · minItems · maxItems;
 *  - UNKNOWN keywords are ignored (documented), so a richer schema does not silently fail;
 *  - the first failure (in a deterministic order) is reported with its path.
 *
 * It is used twice per invocation: input BEFORE the adapter is called, output AFTER it returns.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const typeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const typeMatches = (value: unknown, expected: string): boolean => {
  switch (expected) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      // Unknown types are treated as "no constraint" rather than a silent pass-through of junk.
      return true;
  }
};

const equals = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => rightKeys[index] === key && equals(left[key], right[key]));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => equals(entry, right[index]));
  }
  return false;
};

function check(value: unknown, schema: unknown, path: string, issues: SchemaIssue[]): void {
  if (issues.length > 0) return; // report the first failure only: deterministic and cheap
  if (!isRecord(schema)) return;

  const expectedType = schema['type'];
  if (typeof expectedType === 'string' && !typeMatches(value, expectedType)) {
    issues.push({ path, message: `expected ${expectedType}, received ${typeOf(value)}` });
    return;
  }

  if (Array.isArray(schema['enum'])) {
    const allowed = schema['enum'];
    if (!allowed.some((candidate) => equals(candidate, value))) {
      issues.push({ path, message: `must be one of ${JSON.stringify(allowed)}` });
      return;
    }
  }
  if ('const' in schema && !equals(schema['const'], value)) {
    issues.push({ path, message: `must equal ${JSON.stringify(schema['const'])}` });
    return;
  }

  if (typeof value === 'string') {
    const minLength = schema['minLength'];
    const maxLength = schema['maxLength'];
    if (typeof minLength === 'number' && value.length < minLength) {
      issues.push({ path, message: `must be at least ${String(minLength)} characters` });
      return;
    }
    if (typeof maxLength === 'number' && value.length > maxLength) {
      issues.push({ path, message: `must be at most ${String(maxLength)} characters` });
      return;
    }
  }

  if (typeof value === 'number') {
    const minimum = schema['minimum'];
    const maximum = schema['maximum'];
    if (typeof minimum === 'number' && value < minimum) {
      issues.push({ path, message: `must be >= ${String(minimum)}` });
      return;
    }
    if (typeof maximum === 'number' && value > maximum) {
      issues.push({ path, message: `must be <= ${String(maximum)}` });
      return;
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema['minItems'];
    const maxItems = schema['maxItems'];
    if (typeof minItems === 'number' && value.length < minItems) {
      issues.push({ path, message: `must have at least ${String(minItems)} items` });
      return;
    }
    if (typeof maxItems === 'number' && value.length > maxItems) {
      issues.push({ path, message: `must have at most ${String(maxItems)} items` });
      return;
    }
    const items = schema['items'];
    if (items !== undefined) {
      value.forEach((entry, index) => check(entry, items, `${path}[${String(index)}]`, issues));
    }
    return;
  }

  if (isRecord(value)) {
    const properties = isRecord(schema['properties']) ? schema['properties'] : {};
    const required = Array.isArray(schema['required'])
      ? schema['required'].filter((entry): entry is string => typeof entry === 'string').sort()
      : [];
    for (const key of required) {
      if (!(key in value)) {
        issues.push({ path: `${path}.${key}`, message: 'is required' });
        return;
      }
    }
    if (schema['additionalProperties'] === false) {
      const unknown = Object.keys(value)
        .filter((key) => !(key in properties))
        .sort();
      if (unknown.length > 0) {
        issues.push({ path, message: `has unexpected properties: ${unknown.join(', ')}` });
        return;
      }
    }
    for (const key of Object.keys(value).sort()) {
      const propertySchema = properties[key];
      if (propertySchema !== undefined) check(value[key], propertySchema, `${path}.${key}`, issues);
      if (issues.length > 0) return;
    }
  }
}

/** Validate `value` against `schema`. Failure is a domain error carrying the exact path. */
export function validateAgainstSchema(
  value: unknown,
  schema: unknown,
  options: { readonly path?: string; readonly label?: string } = {},
): Result<true, DomainError> {
  const root = options.path ?? '$';
  const issues: SchemaIssue[] = [];
  check(value, schema, root, issues);
  if (issues.length === 0) return ok(true);
  const issue = issues[0]!;
  return err(
    domainError(
      'VALIDATION_FAILED',
      `${options.label ?? 'payload'} does not satisfy the schema: ${issue.path} ${issue.message}`,
      { path: issue.path, reason: issue.message, label: options.label ?? 'payload' },
    ),
  );
}

/** Shape check for the schema itself (a tool must register a usable contract). */
export function isUsableSchema(schema: unknown): boolean {
  return isRecord(schema);
}
