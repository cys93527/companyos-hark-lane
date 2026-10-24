import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';

export const MEMORY_SCOPE_TYPES = ['COMPANY', 'WORKFLOW', 'ROLE', 'TASK'] as const;
export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];
export const MEMORY_KINDS = ['FACT', 'CONSTRAINT', 'PREFERENCE', 'LESSON', 'PROCEDURE_NOTE', 'REFERENCE'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_STATUSES = ['ACTIVE', 'SUPERSEDED', 'STALE', 'RETRACTED', 'EXPIRED'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
// Sprint 13A (ADR-0015/0016): ARTIFACT joins the provenance closed set — additive only.
// The composition-root verifier (Task-13-08) must reject an ARTIFACT source whose ref
// does not exist in the artifacts table; content is never copied into memory.
export const MEMORY_SOURCE_TYPES = ['USER', 'HANDOFF', 'DECISION', 'VALIDATION', 'ARTIFACT', 'WORKFLOW', 'SYSTEM'] as const;
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];
export const MEMORY_TRUST_LEVELS = ['VERIFIED', 'ASSERTED', 'INFERRED'] as const;
export type MemoryTrustLevel = (typeof MEMORY_TRUST_LEVELS)[number];
export const MEMORY_IMPORTANCE = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export type MemoryImportance = (typeof MEMORY_IMPORTANCE)[number];
export const MEMORY_EVENT_TYPES = ['memory.created', 'memory.superseded', 'memory.stale', 'memory.retracted', 'memory.expired'] as const;

export interface MemoryScope { readonly type: MemoryScopeType; readonly id: string; }
export interface MemoryProvenance { readonly sourceType: MemorySourceType; readonly sourceRefs: readonly string[]; readonly trust: MemoryTrustLevel; }
export interface MemoryRecord {
  readonly id: string; readonly memoryId: string; readonly version: number; readonly companyId: string;
  readonly scope: MemoryScope; readonly kind: MemoryKind; readonly subjectKey?: string | null;
  readonly title: string; readonly content: string; readonly status: MemoryStatus;
  readonly importance: MemoryImportance; readonly sourceType: MemorySourceType; readonly sourceRefs: readonly string[];
  readonly trust: MemoryTrustLevel; readonly provenance: MemoryProvenance; readonly supersedes?: string | null;
  readonly staleReason?: string | null; readonly createdBy: string; readonly createdAt: string; readonly updatedAt: string;
  readonly expiresAt?: string | null; readonly traceId: string; readonly metadata: Readonly<Record<string, unknown>>;
}
export type CreateMemoryInput = Omit<MemoryRecord, 'id'|'version'|'status'|'createdAt'|'updatedAt'|'provenance'|'sourceType'|'sourceRefs'|'trust'> & {
  readonly memoryId?: string; readonly sourceType: MemorySourceType; readonly sourceRefs?: readonly string[]; readonly trust?: MemoryTrustLevel; readonly createdAt?: string; readonly version?: number;
};

const has = <T extends readonly string[]>(xs: T, v: unknown): v is T[number] => typeof v === 'string' && xs.includes(v);
export const normalizeSubjectKey = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null || value.trim() === '') return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(normalized) ? normalized : null;
};
const unsafe = (value: unknown): boolean => typeof value === 'string' && /(api[_ -]?key|secret|password|token|credential|private[_ -]?key|BEGIN [A-Z ]+ PRIVATE KEY)/i.test(value);
export const validateMemorySafety = (input: Pick<MemoryRecord, 'title'|'content'|'metadata'>): Result<true, DomainError> => {
  if (unsafe(input.title) || unsafe(input.content) || unsafe(JSON.stringify(input.metadata))) return err(domainError('VALIDATION_FAILED', 'Memory content appears to contain a secret.', { reason: 'SECRET_CONTENT_REJECTED' }));
  return ok(true);
};
export const createMemoryRecord = (input: CreateMemoryInput): Result<MemoryRecord, DomainError> => {
  if (!input.memoryId || !input.companyId || !input.createdBy || !input.traceId || !input.title.trim() || !input.content.trim()) return err(domainError('VALIDATION_FAILED', 'Memory identity and content are required.'));
  if (!has(MEMORY_SCOPE_TYPES, input.scope.type) || !has(MEMORY_KINDS, input.kind) || !has(MEMORY_IMPORTANCE, input.importance) || !has(MEMORY_SOURCE_TYPES, input.sourceType)) return err(domainError('VALIDATION_FAILED', 'Invalid memory enum value.'));
  const subjectKey = normalizeSubjectKey(input.subjectKey);
  if (input.subjectKey && subjectKey === null) return err(domainError('VALIDATION_FAILED', 'subjectKey must be a normalized dot path.'));
  const trust = input.trust ?? 'ASSERTED';
  if (!has(MEMORY_TRUST_LEVELS, trust)) return err(domainError('VALIDATION_FAILED', 'Invalid trust level.'));
  if (!['USER', 'SYSTEM'].includes(input.sourceType) && (input.sourceRefs?.length ?? 0) === 0) return err(domainError('VALIDATION_FAILED', 'Non-user memory requires source references.'));
  const safe = validateMemorySafety(input); if (!safe.ok) return safe;
  const now = input.createdAt ?? new Date(0).toISOString(); const version = input.version ?? 1;
  return ok({ ...input, id: input.memoryId, memoryId: input.memoryId, version, status: 'ACTIVE', createdAt: now, updatedAt: now, subjectKey, sourceRefs: [...(input.sourceRefs ?? [])], trust, provenance: { sourceType: input.sourceType, sourceRefs: [...(input.sourceRefs ?? [])], trust }, metadata: input.metadata ?? {} });
};
export const transitionMemory = (record: MemoryRecord, status: Exclude<MemoryStatus, 'ACTIVE'>, now: string, reason?: string): Result<MemoryRecord, DomainError> => {
  if (record.status === 'RETRACTED' || record.status === 'SUPERSEDED' || record.status === 'EXPIRED') return err(domainError('IMMUTABLE_ENTITY', 'Terminal memory history is immutable.', { memoryId: record.memoryId, version: record.version }));
  if (status === 'STALE' && record.status !== 'ACTIVE') return err(domainError('ILLEGAL_TRANSITION', 'Only active memory may become stale.'));
  return ok({ ...record, status, updatedAt: now, ...(reason === undefined ? {} : { staleReason: reason }) });
};
export const expireMemory = (record: MemoryRecord, now: string): Result<MemoryRecord, DomainError> => transitionMemory(record, 'EXPIRED', now, 'expiration');

export interface MemoryRetrievalInput { readonly companyId: string; readonly scopes: readonly MemoryScope[]; readonly subjectKey?: string; readonly includeHistorical?: boolean; readonly limit?: number; readonly maxChars?: number; readonly now: string; }
export interface MemoryRetrievalResult { readonly items: readonly MemoryRecord[]; readonly conflicts: readonly string[]; readonly totalMatched: number; readonly includedCount: number; readonly truncated: boolean; }
const precedence: Record<MemoryScopeType, number> = { COMPANY: 1, WORKFLOW: 2, ROLE: 3, TASK: 4 };
export const retrieveMemories = (records: readonly MemoryRecord[], input: MemoryRetrievalInput): MemoryRetrievalResult => {
  const allowed = new Set(input.scopes.map(s => `${s.type}:${s.id}`)); const active = records.filter(r => r.companyId === input.companyId && allowed.has(`${r.scope.type}:${r.scope.id}`) && (input.includeHistorical || r.status === 'ACTIVE') && (input.includeHistorical || !(r.expiresAt && r.expiresAt <= input.now)) && (input.subjectKey === undefined || r.subjectKey === normalizeSubjectKey(input.subjectKey)));
  if (input.includeHistorical) {
    const limit = Math.max(0, input.limit ?? 100); const maxChars = Math.max(0, input.maxChars ?? 20000); let chars=0; const items: MemoryRecord[]=[];
    for (const r of active.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id))) { const n=r.title.length+r.content.length; if(items.length>=limit||chars+n>maxChars)break; chars+=n; items.push(r); }
    return { items, conflicts: [], totalMatched: active.length, includedCount: items.length, truncated: items.length < active.length };
  }
  const conflicts: string[] = []; const chosen = new Map<string, MemoryRecord>();
  for (const r of [...active].sort((a,b) => precedence[b.scope.type]-precedence[a.scope.type] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const key = r.subjectKey ?? `__${r.kind}:${r.id}`; const prior = chosen.get(key);
    if (prior && prior.scope.type === r.scope.type && prior.scope.id === r.scope.id && prior.supersedes !== r.memoryId) conflicts.push(key);
    else if (!prior || precedence[r.scope.type] > precedence[prior.scope.type]) chosen.set(key, r);
  }
  const sorted = [...chosen.values()].sort((a,b) => precedence[b.scope.type]-precedence[a.scope.type] || a.subjectKey?.localeCompare(b.subjectKey ?? '') || a.id.localeCompare(b.id));
  const limit = Math.max(0, input.limit ?? 100); const maxChars = Math.max(0, input.maxChars ?? 20000); let chars = 0; const items: MemoryRecord[] = [];
  for (const r of sorted.slice(0, limit)) { const n = r.title.length + r.content.length; if (chars + n > maxChars) break; chars += n; items.push(r); }
  return { items, conflicts: [...new Set(conflicts)].sort(), totalMatched: sorted.length, includedCount: items.length, truncated: items.length < sorted.length };
};
