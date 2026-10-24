/**
 * Redaction — the last line of defence before a log line reaches a sink.
 *
 * Planning-document §四十四 (Audit) and §十一原则 11: logs must be able to
 * answer "who did what, with which model, at what cost" WITHOUT ever containing a
 * provider token, password or secret. Any key matching the sensitive pattern is
 * replaced wholesale (never truncated, never partially shown).
 */
export const MASK = '***';

/** Key names that are always masked, regardless of value shape. */
export const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|api[-_]?key|apikey|authorization|cookie|credential|private[-_]?key)/i;

const MAX_DEPTH = 8;

export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY_PATTERN.test(key);

/** Deep-redact an arbitrary value. Cycles and over-deep structures are collapsed. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? MASK : redactValue(item, depth + 1);
  }
  return out;
}

/** Redact a flat log-field bag, returning a new object (never mutates the input). */
export function redactFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = isSensitiveKey(key) ? MASK : redactValue(value);
  }
  return out;
}
