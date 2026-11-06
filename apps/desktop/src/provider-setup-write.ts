/**
 * Hark lane H17a — the WRITE half of the ordinary-user provider setup. Runs only inside
 * the trusted setup helper (resources/setup/configure-provider.mjs under
 * ELECTRON_RUN_AS_NODE, started by configure-deepseek.ps1 as the signed-in user); the
 * desktop app itself never calls it and no IPC reaches it.
 *
 * Writes NON-secret files only (the API key is DPAPI-protected by the PowerShell helper
 * and never passes through here):
 *   <userData>/provider/model.json        companyos:provider-setup:1
 *   <userData>/budget/proofs/<sha256>.json companyos:trusted-budget-proof:1 (PRODUCTION_VERIFIED,
 *                                          the user's own attestation of the published price)
 *   <userData>/budget/approvals.json      companyos:budget-approval:1 (the user's per-Goal cap)
 * Same file shapes deployment-budget-proof.ts reads and scripts/hark/make-budget-approval.mjs
 * writes for CI, so the runtime trust path is unchanged.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readDeploymentBudgetApproval } from './deployment-budget-proof.js';
import { PROVIDER_SETUP_DIR, PROVIDER_SETUP_KEY_FILE, PROVIDER_SETUP_MODEL_FILE, PROVIDER_SETUP_SCHEMA, parseProviderSetupModel, type ProviderSetupModel } from './provider-setup.js';

/**
 * The provider profile is DEPLOYMENT DATA, not source: the shipped source names no vendor
 * (sprint6/sprint7 boundary). The profile this build is accepted with ships beside the
 * helper as resources/setup/provider-profile.json and is shape-checked here before use.
 */
export const PROVIDER_SETUP_PROFILE_SCHEMA = 'companyos:provider-setup-profile:1';
export const PROVIDER_SETUP_PROFILE_FILE = 'provider-profile.json';
/** Same identity the runtime binds (vault env name + live scope); not part of the profile. */
export const PROVIDER_SETUP_CREDENTIAL_REF = 'vault://COMPANYOS_MODEL_API_KEY/live';

export interface ProviderSetupProfile {
  readonly schema: typeof PROVIDER_SETUP_PROFILE_SCHEMA;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly upstreamModelIdentity: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly structuredOutput: ProviderSetupModel['structuredOutput'];
  /** LIVE-CONTRACT-FILL: optional thinking control for control-plane calls. */
  readonly thinking?: NonNullable<ProviderSetupModel['thinking']>;
  readonly billingAccount: string;
  readonly pricing: {
    readonly source: string;
    readonly version: string;
    readonly currency: 'CNY';
    readonly units: 'MICROS_PER_MILLION_TOKENS';
    readonly rounding: 'CEIL_TOTAL_PER_REQUEST_MICROS';
    readonly inputRate: number;
    readonly outputRate: number;
  };
  /** Enforced by admission (request body bytes) — see H15d-fix3. */
  readonly inputUpperBound: number;
  /** Runaway guard only; money is bounded by maxCostMicros. */
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly durationMs: number;
  /** The price proof is re-attested by re-running setup (published prices can change). */
  readonly proofValidForMs: number;
}

const PROFILE_KEYS = ['schema', 'providerId', 'baseUrl', 'modelId', 'upstreamModelIdentity', 'maxOutputTokens', 'timeoutMs', 'structuredOutput', 'billingAccount', 'pricing', 'inputUpperBound', 'maxCalls', 'maxTokens', 'durationMs', 'proofValidForMs'] as const;
const PRICING_KEYS = ['source', 'version', 'currency', 'units', 'rounding', 'inputRate', 'outputRate'] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const posInt = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max;
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && ![...v].some((c) => c.charCodeAt(0) < 0x20);
const httpsUrl = (v: unknown): boolean => {
  if (!text(v, 2048)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.username === '' && u.password === '';
  } catch {
    return false;
  }
};

/*
 * AUDIT-D12: the budget fields of the profile become the approval's cap, so they are bounded EXACTLY as the app's
 * approval parser (readDeploymentBudgetApproval) bounds them; a looser profile bound let setup write an approval the
 * app refuses (verify failed, partial files left). Parity is pinned by tests/hark/audit-scripts-provider-profile-bounds.
 */
export const SETUP_PROFILE_CAP_BOUNDS = {
  maxCalls: { min: 1, max: 1_000 },
  maxTokens: { min: 1, max: 100_000_000 },
  durationMs: { min: 1_000, max: 86_400_000 },
} as const;
const inBounds = (v: unknown, b: { readonly min: number; readonly max: number }): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= b.min && v <= b.max;

/** Strict shape check of the deployment profile; null when anything is off (no partial profile is ever used). */
export const parseProviderSetupProfile = (raw: unknown): ProviderSetupProfile | null => {
  if (!isRecord(raw) || raw['schema'] !== PROVIDER_SETUP_PROFILE_SCHEMA) return null;
  if (!exactKeys(raw, Object.hasOwn(raw, 'thinking') ? [...PROFILE_KEYS, 'thinking'] : PROFILE_KEYS)) return null;
  const p = raw['pricing'];
  if (!isRecord(p) || !exactKeys(p, PRICING_KEYS)) return null;
  if (!httpsUrl(p['source']) || !text(p['version']) || p['currency'] !== 'CNY' || p['units'] !== 'MICROS_PER_MILLION_TOKENS' || p['rounding'] !== 'CEIL_TOTAL_PER_REQUEST_MICROS') return null;
  if (!posInt(p['inputRate'], 1_000_000_000) || !posInt(p['outputRate'], 1_000_000_000)) return null;
  if (!text(raw['upstreamModelIdentity']) || !text(raw['billingAccount'])) return null;
  if (!posInt(raw['inputUpperBound'], 10_000_000) || !inBounds(raw['maxCalls'], SETUP_PROFILE_CAP_BOUNDS.maxCalls) || !inBounds(raw['maxTokens'], SETUP_PROFILE_CAP_BOUNDS.maxTokens)) return null;
  if (!inBounds(raw['durationMs'], SETUP_PROFILE_CAP_BOUNDS.durationMs) || !posInt(raw['proofValidForMs'], 366 * 24 * 3_600_000)) return null;
  // The model half must be exactly what the app's own model.json parser accepts.
  const model = parseProviderSetupModel({
    schema: PROVIDER_SETUP_SCHEMA,
    providerId: raw['providerId'],
    baseUrl: raw['baseUrl'],
    modelId: raw['modelId'],
    maxOutputTokens: raw['maxOutputTokens'],
    timeoutMs: raw['timeoutMs'],
    structuredOutput: raw['structuredOutput'],
    ...(raw['thinking'] === undefined ? {} : { thinking: raw['thinking'] }),
    configuredAt: new Date(0).toISOString(),
  });
  if (model === null) return null;
  return raw as unknown as ProviderSetupProfile;
};

/** Read + parse the profile file; typed error when missing or malformed. */
export const readProviderSetupProfile = (path: string): ProviderSetupProfile => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ProviderSetupWriteError('SETUP_PROFILE_INVALID', 'the provider profile is missing or not JSON');
  }
  const profile = parseProviderSetupProfile(raw);
  if (profile === null) throw new ProviderSetupWriteError('SETUP_PROFILE_INVALID', 'the provider profile has an invalid shape');
  return profile;
};

export const SETUP_CAP_CNY_MIN = 0.1;
export const SETUP_CAP_CNY_MAX = 100;

export interface ProviderSetupWriteInput {
  readonly userDataDir: string;
  /** The deployment provider profile (resources/setup/provider-profile.json, parsed). */
  readonly profile: ProviderSetupProfile;
  /** The user's per-Goal spending cap in CNY (0.1 .. 100). */
  readonly capCny: number;
  /** Local account name of the user running setup (approvedBy). */
  readonly approvedBy: string;
  readonly now?: number;
}

export interface ProviderSetupWriteResult {
  readonly modelPath: string;
  readonly approvalPath: string;
  readonly proofRef: string;
  readonly capMicros: number;
  readonly keyFilePresent: boolean;
}

export class ProviderSetupWriteError extends Error {
  constructor(readonly code: 'SETUP_CAP_INVALID' | 'SETUP_APPROVER_INVALID' | 'SETUP_PROFILE_INVALID' | 'SETUP_WRITE_VERIFY_FAILED', message: string) {
    super(message);
  }
}

const atomicWrite = (path: string, bytes: string | Uint8Array): void => {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* the original error is what matters */ }
    throw e;
  }
};

/*
 * AUDIT-S10/D11: approvedBy is the local account name ($env:USERNAME). Windows allows apostrophes, parentheses, '#',
 * '&', '!', '~', '{', '}' and combining marks (e.g. Hindi/Thai names) in it, so the old letters/digits-only pattern made
 * setup fail for those users. Accept exactly what a Windows user name can be: 1-128 characters, no control characters
 * (C0, DEL, C1), none of the characters Windows forbids (" / \ [ ] : ; | = , + * ? < >), and not only dots/spaces.
 * The value only ever goes into JSON (JSON.stringify escapes it).
 */
const APPROVER_FORBIDDEN = new Set(['"', '/', '\\', '[', ']', ':', ';', '|', '=', ',', '+', '*', '?', '<', '>']);
export const isValidSetupApprover = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  const chars = [...v];
  if (chars.length < 1 || chars.length > 128) return false;
  for (const c of chars) {
    const code = c.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || APPROVER_FORBIDDEN.has(c)) return false;
  }
  return !/^[. ]+$/u.test(v);
};

export const capCnyToMicros = (capCny: number): number => {
  if (typeof capCny !== 'number' || !Number.isFinite(capCny) || capCny < SETUP_CAP_CNY_MIN || capCny > SETUP_CAP_CNY_MAX) {
    throw new ProviderSetupWriteError('SETUP_CAP_INVALID', `cap must be between ${SETUP_CAP_CNY_MIN} and ${SETUP_CAP_CNY_MAX} CNY`);
  }
  return Math.round(capCny * 1_000_000);
};

/** Write model.json + the user's budget approval and price proof. Throws typed errors; never touches the key file. */
export const writeProviderSetup = (input: ProviderSetupWriteInput): ProviderSetupWriteResult => {
  const capMicros = capCnyToMicros(input.capCny);
  if (!isValidSetupApprover(input.approvedBy)) {
    throw new ProviderSetupWriteError('SETUP_APPROVER_INVALID', 'approvedBy must be the local account name');
  }
  const profile = parseProviderSetupProfile(input.profile);
  if (profile === null) throw new ProviderSetupWriteError('SETUP_PROFILE_INVALID', 'the provider profile has an invalid shape');
  const now = input.now ?? Date.now();
  const providerDir = join(input.userDataDir, PROVIDER_SETUP_DIR);
  const budgetDir = join(input.userDataDir, 'budget');
  mkdirSync(providerDir, { recursive: true });
  mkdirSync(join(budgetDir, 'proofs'), { recursive: true });

  const model: ProviderSetupModel = {
    schema: PROVIDER_SETUP_SCHEMA,
    providerId: profile.providerId,
    baseUrl: profile.baseUrl,
    modelId: profile.modelId,
    maxOutputTokens: profile.maxOutputTokens,
    timeoutMs: profile.timeoutMs,
    structuredOutput: profile.structuredOutput,
    ...(profile.thinking === undefined ? {} : { thinking: profile.thinking }),
    configuredAt: new Date(now).toISOString(),
  };
  const modelPath = join(providerDir, PROVIDER_SETUP_MODEL_FILE);
  const approvalPath = join(budgetDir, 'approvals.json');
  // AUDIT-D12: a setup that fails part-way (a write error or the read-back verify) leaves the previous setup exactly
  // as it was: the earlier model.json/approvals.json come back (or stay absent) and the new proof is removed.
  const previous = [modelPath, approvalPath].map((path) => ({ path, bytes: existsSync(path) ? readFileSync(path) : null }));
  const written: string[] = [];
  try {
    return writeSetupFiles(input, profile, model, modelPath, approvalPath, budgetDir, now, capMicros, providerDir, written);
  } catch (e) {
    for (const p of written) rmSync(p, { force: true });
    for (const { path, bytes } of previous) {
      if (bytes === null) rmSync(path, { force: true });
      else atomicWrite(path, bytes);
    }
    throw e;
  }
};

const writeSetupFiles = (
  input: ProviderSetupWriteInput, profile: ProviderSetupProfile, model: ProviderSetupModel, modelPath: string, approvalPath: string,
  budgetDir: string, now: number, capMicros: number, providerDir: string, written: string[],
): ProviderSetupWriteResult => {
  atomicWrite(modelPath, JSON.stringify(model, null, 2));

  const attestationRef = `user-setup:${new Date(now).toISOString()}:configure-provider:${input.approvedBy}`;
  const proof = {
    schema: 'companyos:trusted-budget-proof:1',
    scope: 'PRODUCTION_VERIFIED',
    identity: {
      providerId: profile.providerId,
      modelId: profile.modelId,
      upstreamModelIdentity: profile.upstreamModelIdentity,
      endpoint: profile.baseUrl,
      routingIdentity: 'env:' + profile.modelId,
      credentialRef: PROVIDER_SETUP_CREDENTIAL_REF,
      billingAccount: profile.billingAccount,
      billingOrganization: null,
      attestationRef,
    },
    pricing: profile.pricing,
    tokens: {
      inputUpperBound: profile.inputUpperBound,
      outputUpperBound: profile.maxOutputTokens,
      evidenceRef: 'max_tokens pinned by CompanyOS admission (= COS_MODEL_MAX_OUTPUT_TOKENS from the provider setup); input bound enforced on request body bytes; written by CompanyOS 首次配置 (H17a)',
    },
    validFromMs: now - 60_000,
    validUntilMs: now + profile.proofValidForMs,
  };
  const proofBytes = Buffer.from(JSON.stringify(proof));
  const hex = createHash('sha256').update(proofBytes).digest('hex');
  const proofPath = join(budgetDir, 'proofs', `${hex}.json`);
  if (!existsSync(proofPath)) written.push(proofPath);
  atomicWrite(proofPath, proofBytes);
  const approval = {
    schema: 'companyos:budget-approval:1',
    approvedBy: input.approvedBy,
    approvedAt: new Date(now).toISOString(),
    currency: 'CNY',
    billingScope: { providerId: profile.providerId, account: profile.billingAccount, organization: null },
    cap: { maxCalls: profile.maxCalls, maxTokens: profile.maxTokens, maxCostMicros: capMicros, durationMs: profile.durationMs },
    proofs: [`sha256:${hex}`],
  };
  atomicWrite(approvalPath, JSON.stringify(approval, null, 2));

  // Read back through the SAME parsers the app uses: a record the app would refuse is a failed setup.
  if (parseProviderSetupModel(JSON.parse(readFileSync(modelPath, 'utf8'))) === null || readDeploymentBudgetApproval(budgetDir)?.cap.maxCostMicros !== capMicros) {
    throw new ProviderSetupWriteError('SETUP_WRITE_VERIFY_FAILED', 'the written setup does not read back through the app parsers');
  }
  return { modelPath, approvalPath, proofRef: `sha256:${hex}`, capMicros, keyFilePresent: existsSync(join(providerDir, PROVIDER_SETUP_KEY_FILE)) };
};

/**
 * Remove the user's provider setup: model.json, the key file, and the budget approval
 * ONLY when it is the one setup wrote (billing account of the user setup). An operator
 * approval is never deleted by the user helper.
 */
export const removeProviderSetup = (userDataDir: string, profile: Pick<ProviderSetupProfile, 'billingAccount'>): { readonly removed: readonly string[] } => {
  const removed: string[] = [];
  const providerDir = join(userDataDir, PROVIDER_SETUP_DIR);
  for (const name of [PROVIDER_SETUP_MODEL_FILE, PROVIDER_SETUP_KEY_FILE]) {
    const p = join(providerDir, name);
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed.push(`provider/${name}`);
    }
  }
  const budgetDir = join(userDataDir, 'budget');
  const approval = readDeploymentBudgetApproval(budgetDir);
  if (approval !== null && approval.billingScope.account === profile.billingAccount) {
    rmSync(join(budgetDir, 'approvals.json'), { force: true });
    removed.push('budget/approvals.json');
  }
  return { removed };
};
