import { createHash } from 'node:crypto';
import type { ArtifactContentStore, BudgetReservation, CostAdmissionBound, InvocationResult } from '@companyos/core';

/** Actual transport binding, supplied by canonical execution/configuration, never a model label. */
export interface ObservedBudgetBinding {
  readonly modelKey: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly endpoint?: string;
  readonly credentialRef?: string;
}

/** Non-secret identity attested by the trusted deployment, not inferred from the proof itself. */
export interface VerifiedBudgetIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly upstreamModelIdentity: string;
  readonly endpoint: string;
  readonly routingIdentity: string;
  readonly credentialRef: string;
  readonly billingAccount: string;
  readonly billingOrganization: string | null;
  readonly attestationRef: string;
}

export interface TrustedBudgetProof {
  readonly schema: 'companyos:trusted-budget-proof:1';
  readonly scope: 'TEST_ONLY' | 'PRODUCTION_VERIFIED';
  readonly identity: VerifiedBudgetIdentity;
  readonly pricing: {
    readonly source: string;
    readonly version: string;
    readonly currency: string;
    readonly units: 'MICROS_PER_MILLION_TOKENS';
    /** Only this exact, attested billing rule is supported; no guessed discounts/extra fees. */
    readonly rounding: 'CEIL_TOTAL_PER_REQUEST_MICROS';
    readonly inputRate: number;
    readonly outputRate: number;
  };
  readonly tokens: { readonly inputUpperBound: number; readonly outputUpperBound: number; readonly evidenceRef: string };
  readonly validFromMs: number;
  readonly validUntilMs: number;
}

/**
 * Trusted application injection ONLY. No env/renderer/proof JSON can grant this trust.
 * identify must resolve the actual registered transport + externally verified billing/model
 * mapping. approved must use durable approval/deployment evidence. get is the EXISTING CAS
 * reader: this module creates neither a proof registry nor a second budget ledger.
 * Missing ports/evidence deny. select is used ONLY before reservation, never at settlement.
 */
export interface TrustedBudgetProofSource {
  readonly scope: TrustedBudgetProof['scope'];
  readonly policyId: string;
  readonly currency: string;
  readonly billingScope: { readonly providerId: string; readonly account: string; readonly organization: string | null };
  readonly store: Pick<ArtifactContentStore, 'get'>;
  readonly identify: (binding: ObservedBudgetBinding) => Promise<VerifiedBudgetIdentity | null>;
  readonly approved: (contentRef: string) => Promise<boolean>;
  readonly select: (identity: VerifiedBudgetIdentity) => Promise<string | null>;
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const identityKeys = ['providerId', 'modelId', 'upstreamModelIdentity', 'endpoint', 'routingIdentity', 'credentialRef', 'billingAccount', 'billingOrganization', 'attestationRef'] as const;

const endpoint = (value: string): string | null => {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash) return null;
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) return null;
    return u.href.replace(/\/+$/u, '');
  } catch { return null; }
};

const isIdentity = (v: unknown): v is VerifiedBudgetIdentity => object(v) && exactKeys(v, identityKeys)
  && identityKeys.every(k => k === 'billingOrganization' ? v[k] === null || text(v[k]) : text(v[k]))
  && endpoint(v['endpoint'] as string) !== null;
const sameIdentity = (a: VerifiedBudgetIdentity, b: VerifiedBudgetIdentity): boolean =>
  identityKeys.every(k => k === 'endpoint' ? endpoint(a.endpoint) === endpoint(b.endpoint) : a[k] === b[k]);

/** Normal deployment policy identity, persisted by the existing Goal policy field. */
export const trustedBudgetPolicyId = (source: TrustedBudgetProofSource): string | null => {
  const b = source.billingScope;
  if (!text(source.policyId) || !['TEST_ONLY', 'PRODUCTION_VERIFIED'].includes(source.scope)
    || !['USD', 'CNY', 'EUR', 'CREDIT'].includes(source.currency) || b === undefined
    || !text(b.providerId) || !text(b.account) || !(b.organization === null || text(b.organization))) return null;
  return `proof-policy:${createHash('sha256').update(JSON.stringify([source.policyId, source.scope, source.currency, b.providerId, b.account, b.organization])).digest('hex')}`;
};

const validProof = (v: unknown): v is TrustedBudgetProof => {
  if (!object(v) || !exactKeys(v, ['schema', 'scope', 'identity', 'pricing', 'tokens', 'validFromMs', 'validUntilMs'])
    || v['schema'] !== 'companyos:trusted-budget-proof:1' || !['TEST_ONLY', 'PRODUCTION_VERIFIED'].includes(String(v['scope']))
    || !isIdentity(v['identity']) || !integer(v['validFromMs']) || !integer(v['validUntilMs']) || v['validUntilMs'] <= v['validFromMs']) return false;
  const p = v['pricing'], t = v['tokens'];
  return object(p) && exactKeys(p, ['source', 'version', 'currency', 'units', 'rounding', 'inputRate', 'outputRate'])
    && text(p['source']) && text(p['version']) && ['USD', 'CNY', 'EUR', 'CREDIT'].includes(String(p['currency']))
    && p['units'] === 'MICROS_PER_MILLION_TOKENS' && p['rounding'] === 'CEIL_TOTAL_PER_REQUEST_MICROS'
    && integer(p['inputRate']) && integer(p['outputRate'])
    && object(t) && exactKeys(t, ['inputUpperBound', 'outputUpperBound', 'evidenceRef'])
    && integer(t['inputUpperBound']) && integer(t['outputUpperBound']) && t['outputUpperBound'] > 0 && text(t['evidenceRef']);
};

/** Digest and durable approval are checked on EVERY read, including after restart. */
export async function readTrustedBudgetProof(source: TrustedBudgetProofSource, ref: string): Promise<TrustedBudgetProof | null> {
  try {
    if (!/^sha256:[0-9a-f]{64}$/u.test(ref) || trustedBudgetPolicyId(source) === null
      || (source.scope === 'TEST_ONLY' && process.env['COMPANYOS_TEST_MODE'] !== 'OFFLINE')
      || !(await source.approved(ref))) return null;
    const bytes = await source.store.get(ref);
    if (bytes.byteLength > 32768 || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== ref) return null;
    const proof: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!validProof(proof) || proof.scope !== source.scope || proof.pricing.currency !== source.currency
      || proof.identity.providerId !== source.billingScope.providerId || proof.identity.billingAccount !== source.billingScope.account
      || proof.identity.billingOrganization !== source.billingScope.organization) return null;
    return proof;
  } catch { return null; }
}

const price = (proof: TrustedBudgetProof, input: number, output: number): number | null => {
  if (!integer(input) || !integer(output) || input > proof.tokens.inputUpperBound || output > proof.tokens.outputUpperBound) return null;
  const numerator = BigInt(input) * BigInt(proof.pricing.inputRate) + BigInt(output) * BigInt(proof.pricing.outputRate);
  const result = (numerator + 999999n) / 1000000n;
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
};

export async function trustedBudgetBound(source: TrustedBudgetProofSource, binding: ObservedBudgetBinding, maxOutput: number | null, now: number): Promise<CostAdmissionBound | null> {
  try {
    const observed = Object.freeze({ ...binding });
    const identified = await source.identify(observed);
    if (!isIdentity(identified)) return null;
    const actual = Object.freeze({ ...identified });
    if (!isIdentity(actual) || actual.providerId !== binding.providerId || actual.modelId !== binding.modelId
      || (binding.endpoint !== undefined && endpoint(binding.endpoint) !== endpoint(actual.endpoint))
      || (binding.credentialRef !== undefined && binding.credentialRef !== actual.credentialRef)) return null;
    const ref = await source.select(actual);
    const proof = ref === null ? null : await readTrustedBudgetProof(source, ref);
    if (proof === null || ref === null || !sameIdentity(actual, proof.identity)
      || now < proof.validFromMs || now >= proof.validUntilMs
      || (maxOutput !== null && (!integer(maxOutput) || maxOutput < 1 || maxOutput > proof.tokens.outputUpperBound))) return null;
    const cost = price(proof, proof.tokens.inputUpperBound, proof.tokens.outputUpperBound);
    if (cost === null) return null;
    return { modelKey: binding.modelKey, inputTokens: proof.tokens.inputUpperBound, outputTokens: proof.tokens.outputUpperBound,
      costMicros: cost, evidenceRef: ref, validUntilMs: proof.validUntilMs };
  } catch { return null; }
}

/**
 * No select(), no latest-price lookup, no process-local pin map. The reservation's
 * persisted content hash is the sole lookup key. Expiry blocks NEW calls, not accounting
 * for a call already admitted under this proof. Revoked/missing/corrupt proof => UNKNOWN.
 */
export async function pinnedBudgetCost(source: TrustedBudgetProofSource, reservation: BudgetReservation, usage: InvocationResult['usage']): Promise<number | null> {
  const proof = await readTrustedBudgetProof(source, reservation.bound.evidenceRef);
  if (proof === null || reservation.bound.validUntilMs !== proof.validUntilMs
    || reservation.bound.inputTokens !== proof.tokens.inputUpperBound || reservation.bound.outputTokens !== proof.tokens.outputUpperBound
    || reservation.bound.costMicros !== price(proof, proof.tokens.inputUpperBound, proof.tokens.outputUpperBound)) return null;
  // totalCost has no currency/identity guarantee in the old port; never substitute it.
  return price(proof, usage.inputTokens, usage.outputTokens);
}
