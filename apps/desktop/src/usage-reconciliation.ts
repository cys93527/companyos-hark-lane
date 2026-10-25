/**
 * Hark lane H12c — operator reconciliation of UNKNOWN model-call charges.
 *
 * An UNKNOWN reservation (a call that may have been charged, but whose usage was never
 * proven — e.g. the process died mid-call) blocks the Goal (GOAL_USAGE_UNKNOWN) and is
 * counted at its full trusted bound. It is never replayed and never silently zeroed.
 * The ONLY way it becomes KNOWN is an operator attestation with evidence:
 *
 *   <userData>/budget/reconciliations.json      — companyos:usage-reconciliation:1
 *   <userData>/budget/evidence/<sha256 hex>     — the evidence bytes (invoice line, export…)
 *
 * Same trust root as the H10 budget approval: a local operator deployment directory that
 * no IPC channel exposes, so neither the renderer nor the model can write it, and env vars
 * are not consulted. The main process applies the file once per composition start, after
 * crash recovery; every entry is verified (shape, evidence hash, bound) and applied through
 * the canonical budget store transaction. A bad entry is refused and logged, never guessed;
 * re-applying an identical entry is a no-op.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { UsageReconciliation } from '@companyos/core';

export const USAGE_RECONCILIATION_SCHEMA = 'companyos:usage-reconciliation:1';

export interface UsageReconciliationEntry {
  readonly reconciliationId: string;
  readonly goalRunId: string;
  readonly callId: string;
  readonly tokens: number;
  readonly costMicros: number;
  readonly attestedBy: string;
  readonly attestedAt: string;
  readonly evidence: string;
}

export interface UsageReconciliationOutcome {
  readonly reconciliationId: string | null;
  readonly goalRunId: string | null;
  readonly callId: string | null;
  readonly outcome: 'APPLIED' | 'ALREADY_APPLIED' | 'REFUSED';
  readonly reason: string | null;
}

export interface UsageReconciliationReport {
  readonly file: 'ABSENT' | 'INVALID' | 'READ';
  readonly outcomes: readonly UsageReconciliationOutcome[];
}

type Reconcile = (
  goalRunId: string,
  callId: string,
  usage: { readonly tokens: number; readonly costMicros: number },
  reconciliation: UsageReconciliation,
) => Promise<'APPLIED' | 'ALREADY_APPLIED'>;

const HEX_REF = /^sha256:([0-9a-f]{64})$/u;
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const parseEntry = (raw: unknown): UsageReconciliationEntry | null => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (!str(e['reconciliationId']) || !str(e['goalRunId']) || !str(e['callId']) || !int(e['tokens']) || !int(e['costMicros'])
    || !str(e['attestedBy']) || !str(e['attestedAt']) || Number.isNaN(Date.parse(String(e['attestedAt'])))
    || typeof e['evidence'] !== 'string' || !HEX_REF.test(e['evidence'])) return null;
  return e as unknown as UsageReconciliationEntry;
};

const evidenceMatches = (budgetDir: string, ref: string): boolean => {
  const m = HEX_REF.exec(ref);
  if (m === null) return false;
  try {
    const bytes = readFileSync(join(budgetDir, 'evidence', m[1]!));
    return bytes.length > 0 && `sha256:${createHash('sha256').update(bytes).digest('hex')}` === ref;
  } catch {
    return false;
  }
};

const reasonOf = (error: unknown): string => {
  const details = (error as { details?: { reason?: unknown } } | null)?.details;
  if (typeof details?.reason === 'string') return details.reason;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'RECONCILIATION_FAILED';
};

/** Read + apply the operator file. Never throws: the shell must still open. */
export async function applyOperatorUsageReconciliations(budgetDir: string, reconcile: Reconcile): Promise<UsageReconciliationReport> {
  let text: string;
  try {
    text = readFileSync(join(budgetDir, 'reconciliations.json'), 'utf8');
  } catch {
    return { file: 'ABSENT', outcomes: [] };
  }
  let root: unknown;
  try { root = JSON.parse(text); } catch { return { file: 'INVALID', outcomes: [] }; }
  const r = root as { schema?: unknown; entries?: unknown } | null;
  if (r === null || typeof r !== 'object' || r.schema !== USAGE_RECONCILIATION_SCHEMA || !Array.isArray(r.entries) || r.entries.length > 1000) {
    return { file: 'INVALID', outcomes: [] };
  }
  const outcomes: UsageReconciliationOutcome[] = [];
  const seen = new Set<string>();
  for (const raw of r.entries) {
    const entry = parseEntry(raw);
    const rec = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const ids = {
      reconciliationId: str(rec['reconciliationId']) ? rec['reconciliationId'] : null,
      goalRunId: str(rec['goalRunId']) ? rec['goalRunId'] : null,
      callId: str(rec['callId']) ? rec['callId'] : null,
    };
    if (entry === null) { outcomes.push({ ...ids, outcome: 'REFUSED', reason: 'RECONCILIATION_ENTRY_INVALID' }); continue; }
    if (seen.has(entry.reconciliationId)) { outcomes.push({ ...ids, outcome: 'REFUSED', reason: 'RECONCILIATION_ID_DUPLICATE' }); continue; }
    seen.add(entry.reconciliationId);
    if (!evidenceMatches(budgetDir, entry.evidence)) { outcomes.push({ ...ids, outcome: 'REFUSED', reason: 'RECONCILIATION_EVIDENCE_MISSING_OR_MISMATCHED' }); continue; }
    try {
      const outcome = await reconcile(entry.goalRunId, entry.callId, { tokens: entry.tokens, costMicros: entry.costMicros }, {
        reconciliationId: entry.reconciliationId,
        attestedBy: entry.attestedBy,
        attestedAt: entry.attestedAt,
        evidenceRef: entry.evidence,
      });
      outcomes.push({ ...ids, outcome, reason: null });
    } catch (error) {
      outcomes.push({ ...ids, outcome: 'REFUSED', reason: reasonOf(error) });
    }
  }
  return { file: 'READ', outcomes };
}
