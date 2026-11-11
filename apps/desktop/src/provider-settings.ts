/**
 * UI-AUDIT-3 (user request 2026-11-11: "要我把填 Key 做进设置页" → "需要") — 设置 → 模型服务.
 *
 * The in-app replacement for the Start-menu helper ("CompanyOS 首次配置", which keeps working):
 * the user picks the shipped service profile or any OpenAI-compatible service, types the API key,
 * tests the connection and approves a per-Goal budget, all inside CompanyOS.
 *
 * Security is the H17a boundary, unchanged (docs/hark-lane/H17A_FIRST_RUN_SETUP.md):
 *   - The key travels ONE WAY: renderer password field → the dedicated provider-settings IPC
 *     channel → this MAIN-process service → DPAPI (CurrentUser) → <userData>/provider/
 *     model-api-key.dpapi (the same file the helper writes and readProviderSetup reads).
 *     No result, status, error, log line or audit/event row carries the key; the most the
 *     renderer ever gets back is "****" + its last 4 characters.
 *   - The budget approval (<userData>/budget/approvals.json, the user's per-Goal cap) is only
 *     written after a MAIN-owned native confirm dialog returns the user's "批准" click. The
 *     confirm function is injected by main.ts (dialog.showMessageBox on the app window); the
 *     agent kernel, runtime, tools and the control-plane/workflow channels have no route here
 *     (tests/hark/ui-audit-3-provider-settings.test.ts pins both).
 *   - Non-secret files are written by the SAME writer and read back through the SAME parsers as
 *     the helper (provider-setup-write.ts), so the runtime trust path is unchanged.
 *   - The service names no vendor: the preset is deployment data (resources/setup/provider-profile.json).
 *
 * Apply: the model provider and the budget proof are bound once per composition (startup), and
 * re-composing the single active core under running Goals is not safe, so a change reports
 * restartRequired and the user restarts from 设置 (a main-owned confirm, then app.relaunch).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { readDeploymentBudgetApproval } from './deployment-budget-proof.js';
import {
  PROVIDER_SETUP_DIR,
  PROVIDER_SETUP_KEY_FILE,
  PROVIDER_SETUP_MODEL_FILE,
  parseProviderSetupModel,
  readProviderSetup,
  type ProviderSetupUnprotect,
} from './provider-setup.js';
import type { ProviderSetupProtect } from './provider-setup-dpapi.js';
import {
  ProviderSetupWriteError,
  SETUP_CAP_CNY_MAX,
  SETUP_CAP_CNY_MIN,
  SETUP_CUSTOM_BILLING_ACCOUNT,
  SETUP_PRICE_CNY_PER_M_MAX,
  buildCustomProviderProfile,
  capCnyToMicros,
  removeProviderSetup,
  writeProviderSetup,
  type ProviderSetupProfile,
} from './provider-setup-write.js';

export const PROVIDER_SETTINGS_OPERATIONS = ['status', 'test', 'save', 'remove', 'restart'] as const;
export type ProviderSettingsOperation = (typeof PROVIDER_SETTINGS_OPERATIONS)[number];

/** Printable ASCII without whitespace, 8–512 (the same rule readProviderSetup applies on read). */
const API_KEY = /^[\x21-\x7e]{8,512}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export interface ProviderServiceView {
  readonly kind: 'preset' | 'custom';
  readonly baseUrl: string;
  readonly host: string;
  readonly modelId: string;
  /** CNY per million tokens. */
  readonly inputCnyPerM: number;
  readonly outputCnyPerM: number;
}

export interface ProviderSettingsStatus {
  /** In-app key entry needs DPAPI (Windows x64 with the shipped binding). */
  readonly keyEntrySupported: boolean;
  /** environment = the deployment environment declares the model (it wins; settings are inert). */
  readonly source: 'environment' | 'settings' | 'none';
  readonly state: 'NOT_CONFIGURED' | 'CONFIGURED' | 'INVALID';
  /** Plain Chinese, never a path or a value. */
  readonly problem: string | null;
  readonly service: ProviderServiceView | null;
  /** "****" + the last 4 characters, or null. Never more. */
  readonly keyHint: string | null;
  readonly capCny: number | null;
  readonly preset: ProviderServiceView | null;
  readonly capMinCny: number;
  readonly capMaxCny: number;
  readonly priceMaxCnyPerM: number;
  /** The files differ from what this run applied at startup. */
  readonly restartRequired: boolean;
}

export type ProviderSettingsCode =
  | 'OK'
  | 'CANCELLED'
  | 'INVALID_REQUEST'
  | 'KEY_REQUIRED'
  | 'KEY_INVALID'
  | 'KEY_ENTRY_UNSUPPORTED'
  | 'ENVIRONMENT_MANAGED'
  | 'PROFILE_MISSING'
  | 'SERVICE_INVALID'
  | 'PRICE_INVALID'
  | 'CAP_INVALID'
  | 'WRITE_FAILED'
  | 'NOT_CONFIGURED'
  | 'KEY_REJECTED'
  | 'ENDPOINT_NOT_FOUND'
  | 'HTTP_ERROR'
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'UNTRUSTED_SENDER';

export interface ProviderSettingsResult {
  readonly ok: boolean;
  readonly code: ProviderSettingsCode;
  /** Plain Chinese for the user. Never contains the key. */
  readonly message: string;
  readonly status?: ProviderSettingsStatus;
  readonly restartRequired?: boolean;
  /** test: whether the configured model id appears in the service's model list (null = list not readable). */
  readonly modelListed?: boolean | null;
}

/** What the main-owned confirm dialog shows. Built by main from VALIDATED values only. */
export type ProviderSettingsConfirm =
  | { readonly kind: 'approve-budget'; readonly capCny: number; readonly host: string; readonly modelId: string; readonly inputCnyPerM: number; readonly outputCnyPerM: number; readonly keyChanged: boolean }
  | { readonly kind: 'remove' }
  | { readonly kind: 'restart' };

export interface ProviderSettingsFetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export interface ProviderSettingsDeps {
  readonly userDataDir: string;
  /** The shipped profile (resources/setup/provider-profile.json); null = missing/invalid. */
  readonly readShippedProfile: () => ProviderSetupProfile | null;
  readonly protect: ProviderSetupProtect;
  readonly unprotect: ProviderSetupUnprotect;
  /** The deployment environment declares the model (COS_MODEL_* / key): it wins, settings are inert. */
  readonly environmentDeclared: boolean;
  /** providerSettingsFingerprint() at startup (what this run applied). */
  readonly appliedFingerprint: string;
  /** MAIN-owned native confirm dialog. Resolves true ONLY on the user's explicit click. */
  readonly confirm: (request: ProviderSettingsConfirm) => Promise<boolean>;
  readonly fetch: (url: string, init: { readonly method: 'GET'; readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal }) => Promise<ProviderSettingsFetchResponse>;
  /** Local account name (budget approvedBy). */
  readonly approvedBy: string;
  readonly relaunch: () => void;
  /** Operation + code only; never payload values. */
  readonly log: (message: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void;
  readonly testTimeoutMs?: number;
}

const fileBytes = (path: string): Buffer | null => {
  try {
    return existsSync(path) ? readFileSync(path) : null;
  } catch {
    return null;
  }
};

/** Hash of the three files a composition binds (model.json, key file, approvals.json). Not a secret, never sent to the renderer. */
export const providerSettingsFingerprint = (userDataDir: string): string => {
  const hash = createHash('sha256');
  for (const path of [
    join(userDataDir, PROVIDER_SETUP_DIR, PROVIDER_SETUP_MODEL_FILE),
    join(userDataDir, PROVIDER_SETUP_DIR, PROVIDER_SETUP_KEY_FILE),
    join(userDataDir, 'budget', 'approvals.json'),
  ]) {
    const bytes = fileBytes(path);
    hash.update(bytes === null ? 'absent' : createHash('sha256').update(bytes).digest('hex'));
    hash.update('|');
  }
  return hash.digest('hex');
};

const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

const perM = (micros: number): number => Math.round(micros) / 1_000_000;

const viewOfProfile = (profile: ProviderSetupProfile, kind: 'preset' | 'custom'): ProviderServiceView => ({
  kind,
  baseUrl: profile.baseUrl,
  host: hostOf(profile.baseUrl),
  modelId: profile.modelId,
  inputCnyPerM: perM(profile.pricing.inputRate),
  outputCnyPerM: perM(profile.pricing.outputRate),
});

/** "****" + last 4 of a well-formed key; never more of it. */
export const keyHintOf = (key: string): string | null => (API_KEY.test(key) ? `****${key.slice(-4)}` : null);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every((k) => allowed.includes(k));

interface SaveInput {
  readonly mode: 'preset' | 'custom';
  readonly baseUrl?: string;
  readonly modelId?: string;
  readonly inputCnyPerM?: number;
  readonly outputCnyPerM?: number;
  readonly apiKey?: string;
  readonly capCny: number;
}

const SAVE_KEYS = ['mode', 'baseUrl', 'modelId', 'inputCnyPerM', 'outputCnyPerM', 'apiKey', 'capCny'];
const TEST_KEYS = ['mode', 'baseUrl', 'modelId', 'apiKey'];

const parseSave = (payload: unknown): SaveInput | null => {
  if (!isRecord(payload) || !onlyKeys(payload, SAVE_KEYS)) return null;
  if (payload['mode'] !== 'preset' && payload['mode'] !== 'custom') return null;
  if (typeof payload['capCny'] !== 'number') return null;
  for (const k of ['baseUrl', 'modelId', 'apiKey']) if (payload[k] !== undefined && typeof payload[k] !== 'string') return null;
  for (const k of ['inputCnyPerM', 'outputCnyPerM']) if (payload[k] !== undefined && typeof payload[k] !== 'number') return null;
  return payload as unknown as SaveInput;
};

const result = (ok: boolean, code: ProviderSettingsCode, message: string, extra: Partial<ProviderSettingsResult> = {}): ProviderSettingsResult => ({ ok, code, message, ...extra });

/** Validate an https service base URL exactly as the profile parser would (no user/password/query/fragment). */
const httpsBase = (raw: string | undefined): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/u, '');
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return null;
    return trimmed;
  } catch {
    return null;
  }
};

export interface ProviderSettingsService {
  status(): ProviderSettingsStatus;
  handle(operation: ProviderSettingsOperation, payload: unknown): Promise<ProviderSettingsResult>;
}

export const createProviderSettingsService = (deps: ProviderSettingsDeps): ProviderSettingsService => {
  const providerDir = join(deps.userDataDir, PROVIDER_SETUP_DIR);
  const keyPath = join(providerDir, PROVIDER_SETUP_KEY_FILE);
  const modelPath = join(providerDir, PROVIDER_SETUP_MODEL_FILE);
  const budgetDir = join(deps.userDataDir, 'budget');

  /** Decrypt the stored key (main only). Callers never return it. */
  const storedKey = (): string | null => {
    const setup = readProviderSetup(deps.userDataDir, deps.unprotect);
    return setup.state === 'CONFIGURED' ? setup.apiKey : null;
  };

  /** The stored price for the current setup, from the proof the approval names. */
  const storedPricing = (): { readonly inputCnyPerM: number; readonly outputCnyPerM: number } | null => {
    const approval = readDeploymentBudgetApproval(budgetDir);
    const ref = approval?.proofs[0];
    if (ref === undefined || !ref.startsWith('sha256:')) return null;
    try {
      const proof: unknown = JSON.parse(readFileSync(join(budgetDir, 'proofs', `${ref.slice('sha256:'.length)}.json`), 'utf8'));
      if (!isRecord(proof) || !isRecord(proof['pricing'])) return null;
      const p = proof['pricing'];
      if (typeof p['inputRate'] !== 'number' || typeof p['outputRate'] !== 'number') return null;
      return { inputCnyPerM: perM(p['inputRate']), outputCnyPerM: perM(p['outputRate']) };
    } catch {
      return null;
    }
  };

  const status = (): ProviderSettingsStatus => {
    const shipped = deps.readShippedProfile();
    const preset = shipped === null ? null : viewOfProfile(shipped, 'preset');
    const setup = readProviderSetup(deps.userDataDir, deps.unprotect);
    const approval = readDeploymentBudgetApproval(budgetDir);
    let service: ProviderServiceView | null = null;
    let model = null as ReturnType<typeof parseProviderSetupModel>;
    try {
      model = existsSync(modelPath) ? parseProviderSetupModel(JSON.parse(readFileSync(modelPath, 'utf8'))) : null;
    } catch {
      model = null;
    }
    if (model !== null) {
      const isPreset = shipped !== null && model.providerId === shipped.providerId && model.baseUrl === shipped.baseUrl && model.modelId === shipped.modelId;
      const pricing = storedPricing();
      service = {
        kind: isPreset ? 'preset' : 'custom',
        baseUrl: model.baseUrl,
        host: hostOf(model.baseUrl),
        modelId: model.modelId,
        inputCnyPerM: pricing?.inputCnyPerM ?? (isPreset && shipped !== null ? perM(shipped.pricing.inputRate) : 0),
        outputCnyPerM: pricing?.outputCnyPerM ?? (isPreset && shipped !== null ? perM(shipped.pricing.outputRate) : 0),
      };
    }
    const problem =
      setup.state !== 'INVALID'
        ? null
        : setup.reasonCode === 'PROVIDER_SETUP_KEY_MISSING'
          ? '还没有保存 API Key。'
          : setup.reasonCode === 'PROVIDER_SETUP_UNPROTECT_UNAVAILABLE'
            ? '这台电脑无法读取保存的 API Key（需要 Windows）。'
            : setup.reasonCode === 'PROVIDER_SETUP_KEY_UNREADABLE'
              ? '保存的 API Key 无法读取（可能是用别的 Windows 账户保存的），请重新填写。'
              : '模型服务设置已损坏，请重新保存。';
    return {
      keyEntrySupported: deps.protect !== null,
      source: deps.environmentDeclared ? 'environment' : setup.state === 'NOT_CONFIGURED' ? 'none' : 'settings',
      state: setup.state,
      problem,
      service,
      keyHint: setup.state === 'CONFIGURED' ? keyHintOf(setup.apiKey) : null,
      capCny: approval === null ? null : approval.cap.maxCostMicros / 1_000_000,
      preset,
      capMinCny: SETUP_CAP_CNY_MIN,
      capMaxCny: SETUP_CAP_CNY_MAX,
      priceMaxCnyPerM: SETUP_PRICE_CNY_PER_M_MAX,
      restartRequired: providerSettingsFingerprint(deps.userDataDir) !== deps.appliedFingerprint,
    };
  };

  const atomicWrite = (path: string, bytes: Uint8Array): void => {
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* the original error matters */ }
      throw e;
    }
  };

  const profileFor = (input: { readonly mode: 'preset' | 'custom'; readonly baseUrl?: string; readonly modelId?: string; readonly inputCnyPerM?: number; readonly outputCnyPerM?: number }, shipped: ProviderSetupProfile): ProviderSetupProfile | ProviderSettingsResult => {
    if (input.mode === 'preset') return shipped;
    const baseUrl = httpsBase(input.baseUrl);
    const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : '';
    if (baseUrl === null) return result(false, 'SERVICE_INVALID', '服务地址必须以 https:// 开头，不能带用户名、密码、? 或 #。');
    if (!MODEL_ID.test(modelId)) return result(false, 'SERVICE_INVALID', '模型 id 只能包含字母、数字和 . _ : / -（1–128 个字符）。');
    try {
      return buildCustomProviderProfile(shipped, { baseUrl, modelId, inputCnyPerM: input.inputCnyPerM ?? Number.NaN, outputCnyPerM: input.outputCnyPerM ?? Number.NaN });
    } catch (e) {
      if (e instanceof ProviderSetupWriteError && e.code === 'SETUP_PRICE_INVALID') {
        return result(false, 'PRICE_INVALID', `价格要大于 0、不超过每百万 tokens ${String(SETUP_PRICE_CNY_PER_M_MAX)} 元（按服务公布的价格填写）。`);
      }
      return result(false, 'SERVICE_INVALID', '服务地址或模型 id 无效。');
    }
  };

  const save = async (payload: unknown): Promise<ProviderSettingsResult> => {
    const input = parseSave(payload);
    if (input === null) return result(false, 'INVALID_REQUEST', '设置内容无效。');
    if (deps.environmentDeclared) return result(false, 'ENVIRONMENT_MANAGED', '模型服务由部署环境变量提供，这里的设置不会生效。');
    const shipped = deps.readShippedProfile();
    if (shipped === null) return result(false, 'PROFILE_MISSING', '安装包缺少模型服务资料，请重新安装 CompanyOS。');
    const apiKey = typeof input.apiKey === 'string' && input.apiKey !== '' ? input.apiKey.trim() : null;
    if (apiKey !== null && !API_KEY.test(apiKey)) return result(false, 'KEY_INVALID', 'API Key 格式不对：应为 8–512 个可见字符，不能有空格或换行。');
    if (apiKey !== null && deps.protect === null) return result(false, 'KEY_ENTRY_UNSUPPORTED', '这台电脑不能在应用内加密保存 API Key（需要 Windows）。');
    if (apiKey === null && !existsSync(keyPath)) return result(false, 'KEY_REQUIRED', '请填写 API Key。');
    try {
      capCnyToMicros(input.capCny);
    } catch {
      return result(false, 'CAP_INVALID', `每个目标的预算要在 ${String(SETUP_CAP_CNY_MIN)}–${String(SETUP_CAP_CNY_MAX)} 元之间。`);
    }
    const profile = profileFor(input, shipped);
    if ('code' in profile) return profile;

    // The budget approval is a money decision: only the user's click in the MAIN-owned dialog writes it.
    const approved = await deps.confirm({
      kind: 'approve-budget',
      capCny: input.capCny,
      host: hostOf(profile.baseUrl),
      modelId: profile.modelId,
      inputCnyPerM: perM(profile.pricing.inputRate),
      outputCnyPerM: perM(profile.pricing.outputRate),
      keyChanged: apiKey !== null,
    });
    if (approved !== true) return result(false, 'CANCELLED', '已取消，设置没有改动。');

    const approvalsPath = join(budgetDir, 'approvals.json');
    const previous = [keyPath, modelPath, approvalsPath].map((path) => ({ path, bytes: fileBytes(path) }));
    try {
      if (apiKey !== null && deps.protect !== null) {
        mkdirSync(providerDir, { recursive: true });
        const plain = Buffer.from(apiKey, 'utf8');
        try {
          atomicWrite(keyPath, deps.protect(plain));
        } finally {
          plain.fill(0);
        }
      }
      writeProviderSetup({ userDataDir: deps.userDataDir, profile, capCny: input.capCny, approvedBy: deps.approvedBy });
      // Read back through the app's own reader (when this host can decrypt).
      if (deps.unprotect !== null && readProviderSetup(deps.userDataDir, deps.unprotect).state !== 'CONFIGURED') {
        throw new ProviderSetupWriteError('SETUP_WRITE_VERIFY_FAILED', 'read-back');
      }
    } catch {
      // Leave the previous setup exactly as it was: key file, model.json and the approval.
      for (const { path, bytes } of previous) {
        try {
          if (bytes === null) rmSync(path, { force: true });
          else atomicWrite(path, bytes);
        } catch { /* reported below */ }
      }
      return result(false, 'WRITE_FAILED', '保存失败，原来的设置保持不变。');
    }
    const now = status();
    return result(true, 'OK', now.restartRequired ? '已保存。重启 CompanyOS 后生效。' : '已保存。', { status: now, restartRequired: now.restartRequired });
  };

  const test = async (payload: unknown): Promise<ProviderSettingsResult> => {
    if (!isRecord(payload) || !onlyKeys(payload, TEST_KEYS) || (payload['mode'] !== 'preset' && payload['mode'] !== 'custom')) {
      return result(false, 'INVALID_REQUEST', '测试内容无效。');
    }
    for (const k of TEST_KEYS.slice(1)) if (payload[k] !== undefined && typeof payload[k] !== 'string') return result(false, 'INVALID_REQUEST', '测试内容无效。');
    const shipped = deps.readShippedProfile();
    const baseUrl = payload['mode'] === 'preset' ? shipped?.baseUrl ?? null : httpsBase(payload['baseUrl'] as string | undefined);
    if (baseUrl === null) return result(false, payload['mode'] === 'preset' ? 'PROFILE_MISSING' : 'SERVICE_INVALID', payload['mode'] === 'preset' ? '安装包缺少模型服务资料。' : '服务地址必须以 https:// 开头。');
    const modelId = payload['mode'] === 'preset' ? shipped?.modelId ?? null : typeof payload['modelId'] === 'string' ? payload['modelId'].trim() : null;
    const typed = typeof payload['apiKey'] === 'string' && payload['apiKey'] !== '' ? payload['apiKey'].trim() : null;
    if (typed !== null && !API_KEY.test(typed)) return result(false, 'KEY_INVALID', 'API Key 格式不对：应为 8–512 个可见字符，不能有空格或换行。');
    const key = typed ?? storedKey();
    if (key === null) return result(false, 'KEY_REQUIRED', '请先填写 API Key。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.testTimeoutMs ?? 15_000);
    try {
      // GET /models: lists models, costs no tokens — never a model call.
      const response = await deps.fetch(`${baseUrl}/models`, { method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: controller.signal });
      if (response.status === 401 || response.status === 403) return result(false, 'KEY_REJECTED', '服务拒绝了这个 API Key（401/403），请检查 Key 是否正确、是否还有余额。');
      if (response.status === 404) return result(false, 'ENDPOINT_NOT_FOUND', '服务地址不对：找不到 /models（404）。OpenAI 兼容地址通常以 /v1 结尾。');
      if (response.status < 200 || response.status >= 300) return result(false, 'HTTP_ERROR', `服务返回了错误（HTTP ${String(response.status)}），稍后再试。`);
      let listed: boolean | null = null;
      try {
        const body = await response.json();
        const data = isRecord(body) && Array.isArray(body['data']) ? body['data'] : null;
        listed = data === null || modelId === null ? null : data.some((m) => isRecord(m) && m['id'] === modelId);
      } catch {
        listed = null;
      }
      return result(true, 'OK', listed === false ? `连接正常，但服务的模型列表里没有「${modelId ?? ''}」，请确认模型 id。` : '连接正常，API Key 有效。', { modelListed: listed });
    } catch {
      return controller.signal.aborted
        ? result(false, 'TIMEOUT', '连接超时：检查网络或服务地址。')
        : result(false, 'UNREACHABLE', '连不上服务：检查网络或服务地址。');
    } finally {
      clearTimeout(timer);
    }
  };

  const remove = async (): Promise<ProviderSettingsResult> => {
    if (!existsSync(modelPath) && !existsSync(keyPath)) return result(false, 'NOT_CONFIGURED', '还没有配置模型服务。');
    if ((await deps.confirm({ kind: 'remove' })) !== true) return result(false, 'CANCELLED', '已取消，设置没有改动。');
    const shipped = deps.readShippedProfile();
    try {
      removeProviderSetup(deps.userDataDir, { billingAccount: shipped?.billingAccount ?? SETUP_CUSTOM_BILLING_ACCOUNT });
    } catch {
      return result(false, 'WRITE_FAILED', '移除失败，请重试。');
    }
    const now = status();
    return result(true, 'OK', '已移除模型服务和 API Key。重启 CompanyOS 后生效。', { status: now, restartRequired: now.restartRequired });
  };

  const restart = async (): Promise<ProviderSettingsResult> => {
    if ((await deps.confirm({ kind: 'restart' })) !== true) return result(false, 'CANCELLED', '已取消重启。');
    deps.relaunch();
    return result(true, 'OK', '正在重启 CompanyOS…');
  };

  return {
    status,
    async handle(operation, payload) {
      let out: ProviderSettingsResult;
      try {
        out =
          operation === 'status'
            ? result(true, 'OK', '', { status: status() })
            : operation === 'save'
              ? await save(payload)
              : operation === 'test'
                ? await test(payload)
                : operation === 'remove'
                  ? await remove()
                  : await restart();
      } catch {
        out = result(false, 'WRITE_FAILED', '操作失败，请重试。');
      }
      deps.log('provider settings', { operation, code: out.code });
      return out;
    },
  };
};

/**
 * The IPC entry (main.ts registers it on CHANNELS.providerSettings). Only the app window's own
 * top frame may call it; the request is { operation, payload } and nothing else. The payload
 * object's key field is deleted after the call (the string itself cannot be zeroed in JS).
 */
export const createProviderSettingsIpcHandler = (
  service: Pick<ProviderSettingsService, 'handle'>,
  isTrustedSender: (event: unknown) => boolean,
): ((event: unknown, request: unknown) => Promise<ProviderSettingsResult>) =>
  async (event, request) => {
    if (!isTrustedSender(event)) return result(false, 'UNTRUSTED_SENDER', '请求来源无效。');
    if (!isRecord(request) || !onlyKeys(request, ['operation', 'payload']) || !(PROVIDER_SETTINGS_OPERATIONS as readonly unknown[]).includes(request['operation'])) {
      return result(false, 'INVALID_REQUEST', '设置请求无效。');
    }
    try {
      return await service.handle(request['operation'] as ProviderSettingsOperation, request['payload']);
    } finally {
      if (isRecord(request['payload']) && 'apiKey' in request['payload']) delete request['payload']['apiKey'];
    }
  };

/** The native dialog's text for each confirm (pure; main passes it to dialog.showMessageBox). */
export const providerSettingsConfirmText = (request: ProviderSettingsConfirm): { readonly message: string; readonly detail: string; readonly confirmLabel: string } => {
  if (request.kind === 'remove') {
    return { message: '移除模型服务和 API Key？', detail: '移除后不能再执行目标，直到重新配置。重启 CompanyOS 后生效。', confirmLabel: '移除' };
  }
  if (request.kind === 'restart') {
    return { message: '现在重启 CompanyOS？', detail: '正在执行的步骤会被中断；重启后 CompanyOS 按恢复规则继续或标记为中断，记录不会丢失。', confirmLabel: '重启' };
  }
  return {
    message: `批准每个目标最多花费 ${String(request.capCny)} 元？`,
    detail: [
      `模型服务：${request.host} · ${request.modelId}`,
      `价格（每百万 tokens）：输入 ${String(request.inputCnyPerM)} 元，输出 ${String(request.outputCnyPerM)} 元`,
      request.keyChanged ? 'API Key：使用刚才填写的 Key（加密保存在本机，只有你的 Windows 账户能读取）' : 'API Key：保持不变',
      '这是你对每个目标花费上限的批准；超出上限的模型调用会被拒绝。',
    ].join('\n'),
    confirmLabel: '批准并保存',
  };
};
