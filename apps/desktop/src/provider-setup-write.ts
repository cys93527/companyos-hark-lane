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

/** DeepSeek defaults for the ordinary-user setup (the provider this build is accepted with). */
export const DEEPSEEK_SETUP = {
  providerId: 'model.deepseek',
  baseUrl: 'https://api.deepseek.com',
  modelId: 'deepseek-flash',
  upstreamModelIdentity: 'DeepSeek-V4.1-Flash-1017',
  maxOutputTokens: 4096,
  timeoutMs: 120_000,
  structuredOutput: 'json_object',
  /** Same identity the runtime binds (vault env name + live scope). */
  credentialRef: 'vault://COMPANYOS_MODEL_API_KEY/live',
  billingAccount: 'deepseek:user-setup:COMPANYOS_MODEL_API_KEY',
  pricing: {
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    version: '2026-10-25 peak-hour cache-miss rates (worst case)',
    currency: 'CNY',
    units: 'MICROS_PER_MILLION_TOKENS',
    rounding: 'CEIL_TOTAL_PER_REQUEST_MICROS',
    inputRate: 2_000_000,
    outputRate: 8_000_000,
  },
  /** Enforced by admission (request body bytes) — see H15d-fix3. */
  inputUpperBound: 96_000,
  /** Runaway guard only; money is bounded by maxCostMicros. */
  maxCalls: 160,
  maxTokens: 16_015_360,
  durationMs: 3_600_000,
  /** The price proof is re-attested by re-running setup (published prices can change). */
  proofValidForMs: 30 * 24 * 3_600_000,
} as const;

export const SETUP_CAP_CNY_MIN = 0.1;
export const SETUP_CAP_CNY_MAX = 100;

export interface ProviderSetupWriteInput {
  readonly userDataDir: string;
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
  constructor(readonly code: 'SETUP_CAP_INVALID' | 'SETUP_APPROVER_INVALID' | 'SETUP_WRITE_VERIFY_FAILED', message: string) {
    super(message);
  }
}

const atomicWrite = (path: string, bytes: string | Uint8Array): void => {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
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
  if (typeof input.approvedBy !== 'string' || !/^[\p{L}\p{N} ._@$-]{1,128}$/u.test(input.approvedBy)) {
    throw new ProviderSetupWriteError('SETUP_APPROVER_INVALID', 'approvedBy must be the local account name');
  }
  const now = input.now ?? Date.now();
  const providerDir = join(input.userDataDir, PROVIDER_SETUP_DIR);
  const budgetDir = join(input.userDataDir, 'budget');
  mkdirSync(providerDir, { recursive: true });
  mkdirSync(join(budgetDir, 'proofs'), { recursive: true });

  const model: ProviderSetupModel = {
    schema: PROVIDER_SETUP_SCHEMA,
    providerId: DEEPSEEK_SETUP.providerId,
    baseUrl: DEEPSEEK_SETUP.baseUrl,
    modelId: DEEPSEEK_SETUP.modelId,
    maxOutputTokens: DEEPSEEK_SETUP.maxOutputTokens,
    timeoutMs: DEEPSEEK_SETUP.timeoutMs,
    structuredOutput: DEEPSEEK_SETUP.structuredOutput,
    configuredAt: new Date(now).toISOString(),
  };
  const modelPath = join(providerDir, PROVIDER_SETUP_MODEL_FILE);
  atomicWrite(modelPath, JSON.stringify(model, null, 2));

  const attestationRef = `user-setup:${new Date(now).toISOString()}:configure-deepseek:${input.approvedBy}`;
  const proof = {
    schema: 'companyos:trusted-budget-proof:1',
    scope: 'PRODUCTION_VERIFIED',
    identity: {
      providerId: DEEPSEEK_SETUP.providerId,
      modelId: DEEPSEEK_SETUP.modelId,
      upstreamModelIdentity: DEEPSEEK_SETUP.upstreamModelIdentity,
      endpoint: DEEPSEEK_SETUP.baseUrl,
      routingIdentity: `env:${DEEPSEEK_SETUP.modelId}`,
      credentialRef: DEEPSEEK_SETUP.credentialRef,
      billingAccount: DEEPSEEK_SETUP.billingAccount,
      billingOrganization: null,
      attestationRef,
    },
    pricing: DEEPSEEK_SETUP.pricing,
    tokens: {
      inputUpperBound: DEEPSEEK_SETUP.inputUpperBound,
      outputUpperBound: DEEPSEEK_SETUP.maxOutputTokens,
      evidenceRef: 'max_tokens pinned by CompanyOS admission (= COS_MODEL_MAX_OUTPUT_TOKENS from the provider setup); input bound enforced on request body bytes; written by CompanyOS 首次配置 (H17a)',
    },
    validFromMs: now - 60_000,
    validUntilMs: now + DEEPSEEK_SETUP.proofValidForMs,
  };
  const proofBytes = Buffer.from(JSON.stringify(proof));
  const hex = createHash('sha256').update(proofBytes).digest('hex');
  atomicWrite(join(budgetDir, 'proofs', `${hex}.json`), proofBytes);
  const approval = {
    schema: 'companyos:budget-approval:1',
    approvedBy: input.approvedBy,
    approvedAt: new Date(now).toISOString(),
    currency: 'CNY',
    billingScope: { providerId: DEEPSEEK_SETUP.providerId, account: DEEPSEEK_SETUP.billingAccount, organization: null },
    cap: { maxCalls: DEEPSEEK_SETUP.maxCalls, maxTokens: DEEPSEEK_SETUP.maxTokens, maxCostMicros: capMicros, durationMs: DEEPSEEK_SETUP.durationMs },
    proofs: [`sha256:${hex}`],
  };
  const approvalPath = join(budgetDir, 'approvals.json');
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
export const removeProviderSetup = (userDataDir: string): { readonly removed: readonly string[] } => {
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
  if (approval !== null && approval.billingScope.account === DEEPSEEK_SETUP.billingAccount) {
    rmSync(join(budgetDir, 'approvals.json'), { force: true });
    removed.push('budget/approvals.json');
  }
  return { removed };
};
