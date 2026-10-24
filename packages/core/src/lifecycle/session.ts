/**
 * Durable Session kernel contracts (Sprint 19 / Task-19-02).
 *
 * A Session is a BOUNDED MODEL-CONTEXT CONTAINER and nothing else. It is not a Workflow, not
 * a Task, not a Decision, not an AgentExecution, not Memory, not a scheduler, not a retry
 * machine, not evidence, not authority (Boss frozen ruling, T19-02 §1). Canonical business
 * truth stays in the existing stores; an entry may REFERENCE that state, never replace it,
 * and the only copied bytes are conversational residue with no canonical source.
 *
 * Identity (§3): deterministic, tenant-scoped, derived ONLY from the immutable scope
 * (companyId, runId, taskId, roleKey). parentSessionId is deliberately NOT an input — it is
 * lineage/audit metadata and grants nothing (§4). No display names, provider ids, model ids,
 * execution ids, model output, timestamps or random UUIDs participate in identity.
 */
import { createHash } from 'node:crypto';

/** The versioned identity namespace (same convention as the supervisor decision id). */
export const SESSION_ID_NAMESPACE = 'companyos/session/1';

/** Entry kinds (§12 — deliberately minimal; no twenty-category zoo). */
export const SESSION_ENTRY_KINDS = [
  'context_seed',
  'model_input_residue',
  'model_output_residue',
  'canonical_ref',
  'compaction_checkpoint',
] as const;
export type SessionEntryKind = (typeof SESSION_ENTRY_KINDS)[number];

/** Compaction checkpoints may carry ONLY bounded metadata (§29) — never semantic facts. */
export const SESSION_COMPACTION_CHECKPOINT_SCHEMA = 'companyos/session-compaction/1';

/** The ContextSeed payload schema (§33): explicit, bounded, typed, non-authoritative. */
export const SESSION_CONTEXT_SEED_SCHEMA = 'companyos/session-context-seed/1';

/**
 * Canonical reference envelopes (§13): a typed pointer to authoritative state. The kernel
 * stores the pointer; it never copies the record.
 */
export const SESSION_REF_KINDS = [
  'goal',
  'task',
  'decision',
  'artifact',
  'review',
  'validation',
  'tool-invocation',
  'agent-execution',
  'workspace-anchor',
] as const;
export type SessionRefKind = (typeof SESSION_REF_KINDS)[number];

export interface SessionCanonicalRef {
  readonly kind: SessionRefKind;
  /** The canonical id in that store's own grammar (e.g. an artifact id, a decision id). */
  readonly id: string;
  /** Optional stable note for humans; never authority, never content. */
  readonly note?: string;
}

/** Deterministic tenant-scoped session identity from the immutable scope alone. */
export const sessionIdOf = (input: {
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly roleKey: string;
}): string =>
  `ses_${sha256HexUtf8(
    `${SESSION_ID_NAMESPACE}:${input.companyId}:${input.runId}:${input.taskId}:${input.roleKey}`,
  ).slice(0, 26)}`;

/** Bounded entry payload limits (§14 — reject oversize, never truncate). */
export const SESSION_ENTRY_LIMITS = {
  /** Max UTF-8 bytes of textual residue in one entry. */
  maxEntryTextBytes: 65_536,
  /** Max canonical refs carried by one entry. */
  maxRefsPerEntry: 64,
  /** Max bytes of a ContextSeed envelope. */
  maxContextSeedBytes: 65_536,
  /** Max note length on a canonical ref. */
  maxRefNoteChars: 200,
} as const;

/** Token accounting (§24): the two numbers are DISTINCT and never overwrite each other. */
export interface SessionTokenAccounting {
  /**
   * The DETERMINISTIC PRE-INVOCATION ESTIMATE (upper bound, provider-neutral — never the
   * provider's number). Recorded when the entry is appended.
   */
  readonly inputTokenEstimate: number;
  /**
   * The PROVIDER-REPORTED actual output tokens of the attached execution, when known. Null
   * until an execution settles; it is a fact ABOUT the execution, not an estimate.
   */
  readonly outputTokenCount: number | null;
}

/** One append-only session entry (§5 session_entries shape, logical form). */
export interface SessionEntry {
  readonly sessionId: string;
  readonly sequence: number;
  /** Permanent replay identity: same commandId + same fingerprint ⇒ the same entry (§17). */
  readonly commandId: string;
  readonly entryKind: SessionEntryKind;
  /** Bounded textual residue; empty string when the entry carries only refs. */
  readonly text: string;
  readonly refs: readonly SessionCanonicalRef[];
  /** The execution this entry records, when it records one (§18). */
  readonly executionId: string | null;
  readonly tokenAccounting: SessionTokenAccounting;
  readonly createdAt: string;
}

/** A session row (§5 sessions shape, logical form). There is NO status machine (§5). */
export interface SessionRecord {
  readonly sessionId: string;
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly roleKey: string;
  /** Lineage/audit only; influences nothing (§4). */
  readonly parentSessionId: string | null;
  readonly createdAt: string;
}

/** The canonical starting ordinal: sequence is 1-based, never zero. */
export const SESSION_FIRST_SEQUENCE = 1;

/** sha256 hex of a UTF-8 string (the same primitive `kernel/hash` builds on). */
const sha256HexUtf8 = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

/** Validate one canonical ref envelope; refuse anything malformed (§37 invalid ref). */
export const isValidSessionRef = (value: unknown): value is SessionCanonicalRef => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record['kind'] !== 'string' ||
    !(SESSION_REF_KINDS as readonly string[]).includes(record['kind'])
  ) {
    return false;
  }
  if (typeof record['id'] !== 'string' || record['id'].trim().length === 0) return false;
  if (record['note'] !== undefined && typeof record['note'] !== 'string') return false;
  if (
    typeof record['note'] === 'string' &&
    record['note'].length > SESSION_ENTRY_LIMITS.maxRefNoteChars
  ) {
    return false;
  }
  return true;
};

/** Byte size of a string (UTF-8), the bound the entry limits are stated in. */
export const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;
