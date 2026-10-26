/**
 * Hark lane H10 — the DEPLOYMENT trusted-budget-proof source (operator-attested).
 *
 * Trust model (documented in docs/hark-lane/H10_TRUSTED_BUDGET.md):
 *   - The trust root is a LOCAL OPERATOR DEPLOYMENT FILE under the app's userData:
 *       <userData>/budget/approvals.json      — the operator's durable approval record
 *       <userData>/budget/proofs/<hex>.json   — immutable proof bytes, addressed by sha256
 *     Neither the renderer nor the model can write them (no IPC exposes this directory);
 *     env vars are NOT consulted, so no environment can grant this trust.
 *   - `approved(ref)` is re-read from disk on EVERY call (revocation = delete the entry).
 *   - `identify` returns an identity ONLY when the observed transport binding matches an
 *     approved proof's identity exactly; it never infers a price or an account.
 *   - `select` returns the newest approved, currently valid proof for that exact identity.
 *   - The approval also carries the operator's Goal budget cap (calls / tokens / cost),
 *     which REPLACES the fail-closed default (maxCostMicros 0) only when a valid approval
 *     exists. No approval file => this module returns undefined and nothing changes.
 *
 * This module creates neither a second ledger nor a price lookup: pricing lives only in
 * the attested proof bytes, and settlement still uses the reservation's pinned proof.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TrustedBudgetProof, TrustedBudgetProofSource, VerifiedBudgetIdentity } from './trusted-budget-proof.js';

export const DEPLOYMENT_BUDGET_POLICY_ID = 'v1-bounded-execution-1';

export interface DeploymentBudgetCap {
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly maxCostMicros: number;
  readonly durationMs: number;
}

export interface DeploymentBudgetApproval {
  readonly schema: 'companyos:budget-approval:1';
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly currency: 'USD' | 'CNY' | 'EUR' | 'CREDIT';
  readonly billingScope: { readonly providerId: string; readonly account: string; readonly organization: string | null };
  readonly cap: DeploymentBudgetCap;
  readonly proofs: readonly string[];
}

const HEX_REF = /^sha256:([0-9a-f]{64})$/u;
/*
 * H15d-fix3: the token cap is a sanity bound on operator input, not the money limit
 * (maxCostMicros is). 10M could not express 120 admissions of a 96 000-byte working window
 * plus 4 096 output (12.0M), and a 1M-context route makes ten calls; 100M keeps a typo
 * (an extra digit group) out while letting the cost cap do its job.
 */
const MAX_APPROVED_TOKENS = 100_000_000;
const int = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;

const parseApproval = (raw: unknown): DeploymentBudgetApproval | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const scope = a['billingScope'] as Record<string, unknown> | undefined;
  const cap = a['cap'] as Record<string, unknown> | undefined;
  if (a['schema'] !== 'companyos:budget-approval:1' || !str(a['approvedBy']) || !str(a['approvedAt'])
    || !['USD', 'CNY', 'EUR', 'CREDIT'].includes(String(a['currency']))
    || typeof scope !== 'object' || scope === null || !str(scope['providerId']) || !str(scope['account'])
    || !(scope['organization'] === null || str(scope['organization']))
    || typeof cap !== 'object' || cap === null
    || !int(cap['maxCalls'], 1, 1000) || !int(cap['maxTokens'], 1, MAX_APPROVED_TOKENS)
    || !int(cap['maxCostMicros'], 1, 1_000_000_000) || !int(cap['durationMs'], 1_000, 86_400_000)
    || !Array.isArray(a['proofs']) || a['proofs'].length === 0 || a['proofs'].length > 64
    || !a['proofs'].every((p) => typeof p === 'string' && HEX_REF.test(p))) return null;
  return a as unknown as DeploymentBudgetApproval;
};

/** Reads the approval fresh. Missing / malformed => null (fail closed, never a default). */
export const readDeploymentBudgetApproval = (budgetDir: string): DeploymentBudgetApproval | null => {
  try {
    return parseApproval(JSON.parse(readFileSync(join(budgetDir, 'approvals.json'), 'utf8')));
  } catch {
    return null;
  }
};

const readProofFile = (budgetDir: string, ref: string): Uint8Array => {
  const m = HEX_REF.exec(ref);
  if (m === null) throw new Error('invalid proof reference');
  return readFileSync(join(budgetDir, 'proofs', `${m[1]!}.json`));
};

const parseProof = (budgetDir: string, ref: string): TrustedBudgetProof | null => {
  try {
    const bytes = readProofFile(budgetDir, ref);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== ref) return null;
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as TrustedBudgetProof;
  } catch {
    return null;
  }
};

const normEndpoint = (v: string): string => v.replace(/\/+$/u, '');

/**
 * Build the deployment source + cap, or undefined when no valid operator approval exists.
 * The approval snapshot taken here fixes the billing scope/currency for this process; the
 * per-call `approved()` check still re-reads the file, so a revocation takes effect at once.
 */
export const createDeploymentBudgetProofSource = (
  budgetDir: string,
  now: () => number = Date.now,
): { readonly source: TrustedBudgetProofSource; readonly cap: DeploymentBudgetCap } | undefined => {
  const approval = readDeploymentBudgetApproval(budgetDir);
  if (approval === null) return undefined;
  const approvedRefs = (): readonly string[] => readDeploymentBudgetApproval(budgetDir)?.proofs ?? [];
  const candidates = (): readonly { ref: string; proof: TrustedBudgetProof }[] =>
    approvedRefs().flatMap((ref) => {
      const proof = parseProof(budgetDir, ref);
      return proof === null || proof.scope !== 'PRODUCTION_VERIFIED' ? [] : [{ ref, proof }];
    });
  const source: TrustedBudgetProofSource = {
    scope: 'PRODUCTION_VERIFIED',
    policyId: DEPLOYMENT_BUDGET_POLICY_ID,
    currency: approval.currency,
    billingScope: approval.billingScope,
    store: {
      get: async (ref: string) => readProofFile(budgetDir, ref),
    } as TrustedBudgetProofSource['store'],
    identify: async (binding) => {
      const t = now();
      const match = candidates().find(({ proof }) => proof.identity.providerId === binding.providerId
        && proof.identity.modelId === binding.modelId
        && (binding.endpoint === undefined || normEndpoint(binding.endpoint) === normEndpoint(proof.identity.endpoint))
        && (binding.credentialRef === undefined || binding.credentialRef === proof.identity.credentialRef)
        && t >= proof.validFromMs && t < proof.validUntilMs);
      return match === undefined ? null : ({ ...match.proof.identity } as VerifiedBudgetIdentity);
    },
    approved: async (ref) => approvedRefs().includes(ref),
    select: async (identity) => {
      const t = now();
      const valid = candidates()
        .filter(({ proof }) => JSON.stringify(proof.identity) === JSON.stringify(identity) && t >= proof.validFromMs && t < proof.validUntilMs)
        .sort((a, b) => b.proof.validFromMs - a.proof.validFromMs);
      return valid[0]?.ref ?? null;
    },
  };
  return { source, cap: approval.cap };
};
