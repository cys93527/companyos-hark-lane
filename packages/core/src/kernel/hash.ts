/**
 * Canonical hashing for workflow content.
 *
 * `contentHash` must be stable across machines, key orderings and formatting,
 * so it is computed over a *canonical* JSON serialization:
 *   - object keys sorted lexicographically (recursively)
 *   - `undefined` members dropped, `null` preserved
 *   - no whitespace
 *   - arrays keep their order (order is semantic in a workflow graph)
 */
import { createHash } from 'node:crypto';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError('canonicalJson: non-finite numbers are not canonical');
    }
    return JSON.stringify(value);
  }
  if (type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (type === 'undefined') return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (type === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${type}`);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** sha256 over the canonical serialization — the workflow version fingerprint. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * The repository's QUALIFIED SHA-256 reference format (`sha256:<64 lowercase hex>`) —
 * the same representation artifact contentRefs use (algorithm-qualified digest, never
 * a bare hex). Built on `sha256Hex` — no second hash implementation.
 */
export const SHA256_REF_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Format a digest as the canonical qualified ref. */
export function sha256Ref(input: string): string {
  return `sha256:${sha256Hex(input)}`;
}

/** True when the value is a canonical qualified SHA-256 ref. */
export function isSha256Ref(value: unknown): value is string {
  return typeof value === 'string' && SHA256_REF_PATTERN.test(value);
}

/** The bare hex of a qualified ref, or `null` when the shape is not canonical. */
export function parseSha256Ref(value: unknown): string | null {
  return isSha256Ref(value) ? value.slice('sha256:'.length) : null;
}

export function shortHash(hash: string, length = 8): string {
  return hash.slice(0, length);
}
