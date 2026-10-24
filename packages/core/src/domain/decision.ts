import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { MemoryScope } from './memory.js';
export const DECISION_STATUSES = ['ACTIVE', 'SUPERSEDED', 'REVOKED'] as const; export type DecisionStatus = (typeof DECISION_STATUSES)[number];
export const DECISION_EVENT_TYPES = ['decision.created', 'decision.superseded', 'decision.revoked'] as const;
export interface DecisionProvenance { readonly sourceType: 'USER'|'HANDOFF'|'DECISION'|'VALIDATION'|'WORKFLOW'|'SYSTEM'; readonly sourceRefs: readonly string[]; }
export interface DecisionRecord { readonly id: string; readonly decisionId: string; readonly version: number; readonly companyId: string; readonly scope: MemoryScope; readonly subjectKey?: string|null; readonly title: string; readonly question: string; readonly decision: string; readonly rationale: string; readonly alternativesConsidered: readonly string[]; readonly constraints: readonly string[]; readonly consequences: readonly string[]; readonly status: DecisionStatus; readonly supersedes?: string|null; readonly relatedMemoryRefs: readonly string[]; readonly relatedHandoffRefs: readonly string[]; readonly relatedArtifactRefs: readonly string[]; readonly decidedBy: string; readonly decidedAt: string; readonly traceId: string; readonly provenance: DecisionProvenance; readonly metadata?: Readonly<Record<string, unknown>>; }
export type CreateDecisionInput = Omit<DecisionRecord,'id'|'version'|'status'|'decidedAt'> & { readonly decisionId?: string; readonly version?: number; readonly decidedAt?: string; };
const unsafe = (v: unknown): boolean => typeof v === 'string' && /(api[_ -]?key|secret|password|token|credential|private[_ -]?key|BEGIN [A-Z ]+ PRIVATE KEY)/i.test(v);
export const validateDecisionSafety = (input: Pick<DecisionRecord,'title'|'question'|'decision'|'rationale'>): Result<true, DomainError> => unsafe(input.title)||unsafe(input.question)||unsafe(input.decision)||unsafe(input.rationale) ? err(domainError('VALIDATION_FAILED','Decision content appears to contain a secret.')) : ok(true);
export const createDecisionRecord = (input: CreateDecisionInput): Result<DecisionRecord, DomainError> => {
  if (!input.decisionId || !input.companyId || !input.title.trim() || !input.question.trim() || !input.decision.trim() || !input.decidedBy || !input.traceId) return err(domainError('VALIDATION_FAILED','Decision identity and content are required.'));
  const safe = validateDecisionSafety(input); if (!safe.ok) return safe;
  const now = input.decidedAt ?? new Date(0).toISOString(); return ok({ ...input, id: input.decisionId, decisionId: input.decisionId, version: input.version ?? 1, status:'ACTIVE', decidedAt: now, provenance: { sourceType: input.provenance?.sourceType ?? 'USER', sourceRefs: input.provenance?.sourceRefs ?? [] } });
};
export const transitionDecision = (record: DecisionRecord, status: 'SUPERSEDED'|'REVOKED'): Result<DecisionRecord, DomainError> => record.status !== 'ACTIVE' ? err(domainError('IMMUTABLE_ENTITY','Terminal decision history is immutable.')) : ok({ ...record, status });

export interface DecisionContextView { readonly items: readonly DecisionRecord[]; readonly totalMatched: number; readonly includedCount: number; readonly truncated: boolean; readonly conflicts: readonly string[]; }
export const projectDecisionContext = (records: readonly DecisionRecord[], input: { readonly companyId: string; readonly scopes: readonly MemoryScope[]; readonly now: string; readonly limit?: number; readonly maxChars?: number }): DecisionContextView => {
  const allowed = new Set(input.scopes.map(s => `${s.type}:${s.id}`));
  const active = records.filter(r => r.companyId === input.companyId && r.status === 'ACTIVE' && allowed.has(`${r.scope.type}:${r.scope.id}`) && (!r.decidedAt || r.decidedAt <= input.now));
  const precedence: Record<MemoryScope['type'], number> = { COMPANY:1, WORKFLOW:2, ROLE:3, TASK:4 };
  const conflicts: string[] = []; const chosen = new Map<string, DecisionRecord>();
  for (const r of active.slice().sort((a,b)=>precedence[b.scope.type]-precedence[a.scope.type]||a.decisionId.localeCompare(b.decisionId))) { const key = r.subjectKey ?? `__${r.title.toLowerCase()}`; const prior=chosen.get(key); if(prior && prior.scope.type===r.scope.type) conflicts.push(key); else if(!prior || precedence[r.scope.type]>precedence[prior.scope.type]) chosen.set(key,r); }
  const effective = [...chosen.values()];
  const max = Math.max(0, input.limit ?? 100); const chars = Math.max(0, input.maxChars ?? 20000); let used=0; const items: DecisionRecord[]=[];
  for (const r of effective.slice().sort((a,b)=>b.decidedAt.localeCompare(a.decidedAt)||a.decisionId.localeCompare(b.decisionId)).slice(0,max)) { const n=r.title.length+r.decision.length+r.rationale.length; if(used+n>chars)break; used+=n; items.push(r); }
  return {items,totalMatched:effective.length,includedCount:items.length,truncated:items.length<effective.length,conflicts:[...new Set(conflicts)].sort()};
};
