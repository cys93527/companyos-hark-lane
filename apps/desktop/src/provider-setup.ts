/**
 * Hark lane H17a — ordinary-user provider setup for the INSTALLED app.
 *
 * Gap closed: the installed app read its model endpoint, API key and budget only from
 * the process environment and an operator-written budget file, so an ordinary user had
 * no supported way to configure it. The V1 boundary (docs/product/V1_DESKTOP_SUPPORTED_BOUNDARY.md
 * §2) forbids a renderer-side credential seam, so provisioning stays on the TRUSTED
 * machine path:
 *
 *   resources/setup/configure-deepseek.ps1   (Start menu "CompanyOS 首次配置", runs as the user)
 *     - reads the key with Read-Host -AsSecureString, protects it with DPAPI (CurrentUser)
 *       into <userData>/provider/model-api-key.dpapi (the key never reaches a command line,
 *       an environment block, a log or this module's return values in plain form)
 *     - runs resources/setup/configure-provider.mjs (ELECTRON_RUN_AS_NODE) which writes the
 *       NON-secret <userData>/provider/model.json and the user's budget approval + price
 *       proof (<userData>/budget, the same files deployment-budget-proof.ts trusts).
 *
 *   main process at startup (this module):
 *     - readProviderSetup(): NOT_CONFIGURED | CONFIGURED | INVALID (typed reason, fail closed)
 *     - applyProviderSetupOverlay(): when the deployment environment declares no model
 *       endpoint/key, the configured values are placed in the MAIN process environment
 *       before composition (exactly the shape a CI/operator deployment uses). A deployment
 *       environment that declares ANY model field wins whole; the two are never mixed.
 *
 * The renderer never sees any of it: no IPC reads or writes these files, and the summary
 * this module returns for logging/status carries names and states only — never values.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MODEL_PROVIDER_ENV } from './models/openai-compatible-provider.js';

export const PROVIDER_SETUP_SCHEMA = 'companyos:provider-setup:1';
export const PROVIDER_SETUP_DIR = 'provider';
export const PROVIDER_SETUP_MODEL_FILE = 'model.json';
export const PROVIDER_SETUP_KEY_FILE = 'model-api-key.dpapi';
/** The key file is a DPAPI blob of a short UTF-8 string; anything larger is not ours. */
export const PROVIDER_SETUP_KEY_FILE_MAX_BYTES = 8192;

export interface ProviderSetupModel {
  readonly schema: typeof PROVIDER_SETUP_SCHEMA;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly structuredOutput: 'json_object' | 'json_schema';
  readonly configuredAt: string;
}

export type ProviderSetupReason =
  | 'PROVIDER_SETUP_MODEL_INVALID'
  | 'PROVIDER_SETUP_KEY_MISSING'
  | 'PROVIDER_SETUP_KEY_UNREADABLE'
  | 'PROVIDER_SETUP_UNPROTECT_UNAVAILABLE';

export type ProviderSetupState =
  | { readonly state: 'NOT_CONFIGURED' }
  | { readonly state: 'INVALID'; readonly reasonCode: ProviderSetupReason; readonly detail: string }
  | { readonly state: 'CONFIGURED'; readonly model: ProviderSetupModel; readonly apiKey: string };

/** Decrypts a DPAPI (CurrentUser) blob. Throws on failure. `null` = no unprotect facility on this host. */
export type ProviderSetupUnprotect = ((blob: Uint8Array) => Uint8Array) | null;

const PROVIDER_ID = /^model\.[a-z0-9][a-z0-9._-]{0,62}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
/** Printable ASCII without whitespace: what provider API keys are. A newline or space would be a paste error. */
const API_KEY = /^[\x21-\x7e]{8,512}$/u;

const intIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

/** Validate model.json. Returns null when it is not exactly a provider-setup record. */
export const parseProviderSetupModel = (raw: unknown): ProviderSetupModel | null => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m['schema'] !== PROVIDER_SETUP_SCHEMA) return null;
  if (typeof m['providerId'] !== 'string' || !PROVIDER_ID.test(m['providerId'])) return null;
  if (typeof m['modelId'] !== 'string' || !MODEL_ID.test(m['modelId'])) return null;
  if (typeof m['baseUrl'] !== 'string') return null;
  let url: URL;
  try {
    url = new URL(m['baseUrl']);
  } catch {
    return null;
  }
  // A key typed by an ordinary user only ever travels over TLS; no credentials/query in the URL.
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  if (!intIn(m['maxOutputTokens'], 256, 8192) || !intIn(m['timeoutMs'], 10_000, 600_000)) return null;
  if (m['structuredOutput'] !== 'json_object' && m['structuredOutput'] !== 'json_schema') return null;
  if (typeof m['configuredAt'] !== 'string' || Number.isNaN(Date.parse(m['configuredAt']))) return null;
  return m as unknown as ProviderSetupModel;
};

const invalid = (reasonCode: ProviderSetupReason, detail: string): ProviderSetupState => ({ state: 'INVALID', reasonCode, detail });

/** Read the user's provider setup from <userData>/provider. Never throws; never returns a partial setup. */
export const readProviderSetup = (userDataDir: string, unprotect: ProviderSetupUnprotect): ProviderSetupState => {
  const dir = join(userDataDir, PROVIDER_SETUP_DIR);
  const modelPath = join(dir, PROVIDER_SETUP_MODEL_FILE);
  const keyPath = join(dir, PROVIDER_SETUP_KEY_FILE);
  const hasModel = existsSync(modelPath);
  const hasKey = existsSync(keyPath);
  if (!hasModel && !hasKey) return { state: 'NOT_CONFIGURED' };
  if (!hasModel) return invalid('PROVIDER_SETUP_MODEL_INVALID', 'model.json is missing while a key file exists; re-run CompanyOS 首次配置');
  let model: ProviderSetupModel | null;
  try {
    model = parseProviderSetupModel(JSON.parse(readFileSync(modelPath, 'utf8')));
  } catch {
    model = null;
  }
  if (model === null) return invalid('PROVIDER_SETUP_MODEL_INVALID', 'model.json is not a valid provider setup record; re-run CompanyOS 首次配置');
  if (!hasKey) return invalid('PROVIDER_SETUP_KEY_MISSING', 'the API key file is missing; re-run CompanyOS 首次配置');
  if (unprotect === null) return invalid('PROVIDER_SETUP_UNPROTECT_UNAVAILABLE', 'this host cannot decrypt the DPAPI key file (Windows x64 with the shipped native binding required)');
  let blob: Buffer;
  try {
    blob = readFileSync(keyPath);
  } catch {
    return invalid('PROVIDER_SETUP_KEY_UNREADABLE', 'the API key file cannot be read');
  }
  if (blob.length === 0 || blob.length > PROVIDER_SETUP_KEY_FILE_MAX_BYTES) return invalid('PROVIDER_SETUP_KEY_UNREADABLE', 'the API key file has an impossible size');
  let plain: Uint8Array;
  try {
    plain = unprotect(blob);
  } catch {
    // A blob protected by another Windows user (or another machine) lands here.
    return invalid('PROVIDER_SETUP_KEY_UNREADABLE', 'the API key file cannot be decrypted by this Windows user; re-run CompanyOS 首次配置 as this user');
  }
  const apiKey = Buffer.from(plain).toString('utf8');
  Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength).fill(0);
  if (!API_KEY.test(apiKey)) return invalid('PROVIDER_SETUP_KEY_UNREADABLE', 'the decrypted API key is not a well-formed key (8-512 printable characters, no spaces)');
  return { state: 'CONFIGURED', model, apiKey };
};

/** The environment names a deployment uses to declare the model endpoint (any one present = the deployment owns it). */
export const PROVIDER_SETUP_DEPLOYMENT_NAMES: readonly string[] = [
  MODEL_PROVIDER_ENV.providerId,
  MODEL_PROVIDER_ENV.baseUrl,
  MODEL_PROVIDER_ENV.modelId,
  MODEL_PROVIDER_ENV.apiKey,
];

export interface ProviderSetupOverlayResult {
  /** environment = the deployment environment declared the model; provider-setup = the user's setup was applied. */
  readonly source: 'environment' | 'provider-setup' | 'none';
  readonly setupState: ProviderSetupState['state'];
  readonly reasonCode: ProviderSetupReason | null;
  /** Names written into the environment (values are never reported). */
  readonly applied: readonly string[];
}

/** The overlay values for a CONFIGURED setup (names → values). Exposed for tests; never log it. */
export const providerSetupEnvValues = (setup: Extract<ProviderSetupState, { state: 'CONFIGURED' }>): Readonly<Record<string, string>> => ({
  [MODEL_PROVIDER_ENV.providerId]: setup.model.providerId,
  [MODEL_PROVIDER_ENV.baseUrl]: setup.model.baseUrl,
  [MODEL_PROVIDER_ENV.modelId]: setup.model.modelId,
  [MODEL_PROVIDER_ENV.timeoutMs]: String(setup.model.timeoutMs),
  [MODEL_PROVIDER_ENV.maxOutputTokens]: String(setup.model.maxOutputTokens),
  [MODEL_PROVIDER_ENV.structuredOutput]: setup.model.structuredOutput,
  [MODEL_PROVIDER_ENV.apiKey]: setup.apiKey,
});

/**
 * Apply the user's setup to the MAIN process environment. Precedence: a deployment
 * environment that declares any model field wins whole (nothing is merged); otherwise a
 * CONFIGURED setup is written; NOT_CONFIGURED/INVALID write nothing (the app stays
 * "model not configured", fail closed, exactly as before H17a).
 */
export const applyProviderSetupOverlay = (env: NodeJS.ProcessEnv | Record<string, string | undefined>, setup: ProviderSetupState): ProviderSetupOverlayResult => {
  const reasonCode = setup.state === 'INVALID' ? setup.reasonCode : null;
  const deploymentDeclared = PROVIDER_SETUP_DEPLOYMENT_NAMES.some((name) => (env[name] ?? '').trim() !== '');
  if (deploymentDeclared) return { source: 'environment', setupState: setup.state, reasonCode, applied: [] };
  if (setup.state !== 'CONFIGURED') return { source: 'none', setupState: setup.state, reasonCode, applied: [] };
  const values = providerSetupEnvValues(setup);
  const applied: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if ((env[name] ?? '').trim() !== '') continue; // an explicit non-model deployment value (e.g. timeout) still wins
    env[name] = value;
    applied.push(name);
  }
  return { source: 'provider-setup', setupState: setup.state, reasonCode, applied };
};
