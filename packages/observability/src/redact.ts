/**
 * Redaction — the last line of defence before a log line reaches a sink.
 *
 * Planning-document §四十四 (Audit) and §十一原则 11: logs must be able to
 * answer "who did what, with which model, at what cost" WITHOUT ever containing a
 * provider token, password or secret.
 *
 * Two layers (AUDIT-P2 / AUDIT-P3):
 *   1. KEY level — a field whose NAME is credential-shaped is replaced wholesale
 *      (never truncated, never partially shown). Names are split into words
 *      (camelCase / snake_case / kebab-case) and matched on whole words, so a
 *      credential name (`accessToken`, `refresh_token`, `X-Api-Key`) is masked while
 *      a usage counter (`inputTokens`, `maxTokens`, `tokenCount`) is kept: those
 *      counters ARE the "at what cost" half of the audit goal.
 *   2. VALUE level — every string that reaches a sink (the message, every string
 *      leaf, every `Error.message`) is scrubbed for credential-shaped substrings:
 *      `Bearer <x>` / `Basic <x>` authorization values, secret-key-prefixed keys
 *      (`sk-…`), JWT-shaped tokens, and `name=value` / `name: value` /
 *      `"name":"value"` pairs whose name is credential-shaped. Header tuples
 *      (`[['Authorization', '…']]`) are treated as key/value pairs.
 *
 * The patterns are vendor-independent shapes, never a list of vendors.
 */
export const MASK = '***';

/**
 * Credential stems that are masked wherever they appear inside a key name
 * (substring match, case-insensitive). `token` is deliberately NOT here: it is
 * matched on whole words by `isSensitiveKey` so usage counters survive (AUDIT-P3).
 */
export const SENSITIVE_KEY_PATTERN =
  /(secret|password|passwd|passphrase|api[-_]?key|apikey|authorization|cookie|credential|private[-_]?key|privatekey|access[-_]?key)/i;

/** Words that, as the LAST word of a key name, make it a credential (`proxyAuth`, `bearer`). */
const SENSITIVE_LAST_WORDS = new Set(['auth', 'bearer', 'jwt', 'otp']);

/**
 * Words that, following `token`, turn the name into a counter / descriptor rather
 * than a credential (`tokenCount`, `token_usage`, `tokenLimit`, `tokenType`).
 */
const TOKEN_NON_SECRET_SUFFIX = new Set([
  'count',
  'counts',
  'usage',
  'limit',
  'limits',
  'budget',
  'estimate',
  'estimates',
  'total',
  'totals',
  'number',
  'num',
  'cost',
  'costs',
  'index',
  'type',
  'kind',
  'in',
  'out',
]);

const MAX_DEPTH = 8;

/** Split a key name into lower-case words: `X-Api-Key` → x,api,key; `maxTokens` → max,tokens. */
const wordsOf = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());

/**
 * True when a key NAME is credential-shaped.
 *
 *   - any substring stem from `SENSITIVE_KEY_PATTERN` (password, secret, api key, …);
 *   - the whole word `token` (singular), unless the next word makes it a counter /
 *     descriptor (`tokenCount`, `token_type`). Plural `tokens` (`inputTokens`,
 *     `maxTokens`, `usage.tokens`) is a count, never a credential;
 *   - a credential last word (`auth`, `proxyAuth`, `bearer`).
 */
export const isSensitiveKey = (key: string): boolean => {
  if (SENSITIVE_KEY_PATTERN.test(key)) return true;
  const words = wordsOf(key);
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== 'token') continue;
    const next = words[index + 1];
    if (next === undefined || !TOKEN_NON_SECRET_SUFFIX.has(next)) return true;
  }
  const last = words[words.length - 1];
  return last !== undefined && SENSITIVE_LAST_WORDS.has(last);
};

/* ----------------------------------------------------------- value scrubbing */

/** Authorization scheme + credential (`Bearer abc.def`, `Basic dXNlcjpw`). */
const AUTH_SCHEME_VALUE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}/gi;
/** Secret-key-prefixed credentials (`sk-…`, `sk_live_…`) — a common vendor-neutral shape. */
const SECRET_KEY_PREFIX = /\bsk[-_][A-Za-z0-9_-]{8,}/g;
/** JWT shape: base64url header starting `eyJ` + payload + signature. */
const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
/**
 * `name=value`, `name: value`, `"name":"value"` where `name` contains a credential
 * stem. The name is re-checked with `isSensitiveKey`, so `inputTokens: 120` stays.
 */
const NAMED_PAIR =
  /(["']?)([A-Za-z0-9_.-]*(?:token|secret|password|passwd|passphrase|api[-_]?key|apikey|authorization|auth|cookie|credential|private[-_]?key|access[-_]?key)[A-Za-z0-9_-]*)\1(\s*[:=]\s*)(["']?)((?:(?:Bearer|Basic|Token)\s+)?[^\s"',;&}\]]+)/gi;

/** Remove credential-shaped substrings from free text (log message, string leaf, error text). */
export function scrubString(input: string): string {
  if (input.length === 0) return input;
  let out = input.replace(NAMED_PAIR, (whole, quote: string, name: string, sep: string, valueQuote: string, value: string) => {
    if (!isSensitiveKey(name)) return whole;
    if (value === MASK) return whole;
    return `${quote}${name}${quote}${sep}${valueQuote}${MASK}`;
  });
  out = out.replace(AUTH_SCHEME_VALUE, (_whole, scheme: string) => `${scheme} ${MASK}`);
  out = out.replace(SECRET_KEY_PREFIX, MASK);
  out = out.replace(JWT_SHAPE, MASK);
  return out;
}

/** Deep-redact an arbitrary value. Cycles and over-deep structures are collapsed. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') return scrubString(value);
  // JSON.stringify throws on bigint; a log line must never fail to serialize.
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    // A header tuple `['Authorization', 'Bearer …']` is a key/value pair.
    if (value.length === 2 && typeof value[0] === 'string' && isSensitiveKey(value[0])) {
      return [value[0], MASK];
    }
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message) };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactEntry(key, item, depth + 1);
  }
  return out;
}

/** One key/value pair: a credential-named key is masked wholesale, anything else recursed. */
const redactEntry = (key: string, value: unknown, depth: number): unknown =>
  isSensitiveKey(key) ? MASK : redactValue(value, depth);

/** Redact a flat log-field bag, returning a new object (never mutates the input). */
export function redactFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = redactEntry(key, value, 0);
  }
  return out;
}
