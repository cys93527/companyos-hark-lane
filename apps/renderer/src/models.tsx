/**
 * STAGE 2 — the model-selection ONBOARDING path for a normal user (closes the
 * MODEL_SELECTION_ONBOARDING_GAP that Stage 1 exposed as `MODEL_SELECTION_REQUIRED`).
 *
 * The flow is exactly the product path, no shortcuts:
 *   list what a configured provider actually offers (durable catalogue, no provider call)
 *   → user picks one
 *   → register it through the canonical registration seam if it is not registered yet
 *   → save the canonical COMPANY-level selection policy (MANUAL)
 *   → explain the verdict against the canonical rules
 *
 * Hard rules honoured here:
 *   - the renderer NEVER writes a model row or a policy row itself (UX-12): every write
 *     crosses the typed workflow bridge into the canonical services;
 *   - the renderer never learns a credential and never chooses its own actor (the main
 *     process stamps the session actor on every request);
 *   - a model is never "silently chosen": if no MODEL is selected the panel says so, and
 *     if the provider is not configured it says 尚未配置模型提供商 and points at Settings.
 */
import { createElement as h, type JSX } from 'react';

import type { WorkflowBridge } from './designer.js';
import { TypedErrorLine } from './typed-error.js';

/** One selectable model: either already registered, or offered by a configured provider. */
export interface ModelOptionRow {
  readonly providerId: string;
  readonly providerModelId: string;
  readonly displayName: string;
  readonly contextWindow: number | null;
  readonly registered: boolean;
  /** The canonical model key — present only when the model is registered. */
  readonly modelKey: string | null;
  readonly priceInput: number | null;
  readonly priceOutput: number | null;
  /** LIVE-CONTRACT-FILL: the deployment-configured model (see CatalogueRow.configured). */
  readonly configured?: boolean;
  /**
   * UI-AUDIT-2: main's verdict that this model can run a Goal (its provider is bound in this
   * process and it is a chat model; image / video / embedding / speech models cannot). Absent
   * (an older main) = usable. A registered model must also be enabled.
   */
  readonly goalUsable?: boolean;
  readonly unusableReason?: string | null;
  /** UI-AUDIT-2: what kind of model it is (main's model-modality.ts), for the plain-language reason. */
  readonly modality?: string | null;
  readonly enabled?: boolean;
}

export type ModelSelectionStatus =
  | { readonly kind: 'provider-not-configured' }
  | { readonly kind: 'no-models' }
  | { readonly kind: 'no-selection' }
  | { readonly kind: 'selected'; readonly modelKey: string; readonly displayName: string | null };

export interface CatalogueRow {
  readonly providerId: string;
  readonly providerModelId: string;
  readonly displayName: string;
  readonly contextWindow: number | null;
  /** The model the deployment / first-run setup configured (main-process fact). */
  readonly configured?: boolean;
  readonly goalUsable?: boolean;
  readonly unusableReason?: string | null;
  readonly modality?: string | null;
}

export interface RegisteredRow {
  readonly modelKey: string;
  readonly providerId: string;
  readonly providerModelId: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly modality?: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Merge the durable catalogue with the registry so the user sees what they can pick. */
export const toModelOptionRows = (
  catalogue: readonly CatalogueRow[],
  registered: readonly RegisteredRow[],
): readonly ModelOptionRow[] => {
  const rows = new Map<string, ModelOptionRow>();
  // UI-AUDIT-2: when main sends a catalogue, a registered row whose provider is NOT in it is
  // from a provider that is not bound now (an earlier setup / endpoint) and cannot run a Goal.
  const catalogueProviders = new Set(catalogue.map((row) => row.providerId));
  for (const row of registered) {
    const nonChat = row.modality !== undefined && row.modality !== null && NON_CHAT.has(row.modality);
    const providerGone = catalogue.length > 0 && !catalogueProviders.has(row.providerId);
    rows.set(`${row.providerId}/${row.providerModelId}`, {
      providerId: row.providerId,
      providerModelId: row.providerModelId,
      displayName: row.displayName,
      contextWindow: null,
      registered: true,
      modelKey: row.modelKey,
      priceInput: null,
      priceOutput: null,
      enabled: row.enabled,
      ...(row.modality === undefined ? {} : { modality: row.modality }),
      goalUsable: !nonChat && !providerGone,
      unusableReason: nonChat ? 'NOT_CHAT_MODEL' : providerGone ? 'PROVIDER_NOT_BOUND' : null,
    });
  }
  for (const row of catalogue) {
    const key = `${row.providerId}/${row.providerModelId}`;
    const existing = rows.get(key);
    const usable = row.goalUsable !== false;
    rows.set(key, {
      providerId: row.providerId,
      providerModelId: row.providerModelId,
      displayName: row.displayName || row.providerModelId,
      contextWindow: row.contextWindow,
      registered: existing?.registered ?? false,
      modelKey: existing?.modelKey ?? null,
      priceInput: existing?.priceInput ?? null,
      priceOutput: existing?.priceOutput ?? null,
      ...(existing?.enabled === undefined ? {} : { enabled: existing.enabled }),
      ...(row.configured === true ? { configured: true } : {}),
      modality: row.modality ?? existing?.modality ?? null,
      goalUsable: usable && (existing?.goalUsable ?? true),
      unusableReason: !usable ? (row.unusableReason ?? 'NOT_CHAT_MODEL') : (existing?.unusableReason ?? null),
    });
  }
  return [...rows.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
};

const NON_CHAT: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'embedding', 'rerank', 'moderation']);

/** Main's model kinds in plain Chinese (model-modality.ts MODALITY_LABELS). */
export const MODALITY_WORDS: Readonly<Record<string, string>> = {
  chat: '对话模型',
  unknown: '对话模型',
  image: '图像模型',
  video: '视频模型',
  audio: '语音模型',
  embedding: '向量模型',
  rerank: '重排序模型',
  moderation: '审核模型',
};

/**
 * UI-AUDIT-2 (user report 2026-11-11: the composer listed the provider's entire catalogue,
 * ~100 image / video / embedding entries tagged 待注册, and the user ran a chat Goal on an
 * image model). A Goal can only run on a model the user actually set up: the configured model
 * (first-run setup / deployment), or one they registered and enabled — and only when main
 * says it can run Goals (chat model, provider bound now). Unregistered catalogue entries are
 * managed in Settings, never offered here.
 */
export const isGoalModel = (option: ModelOptionRow): boolean =>
  option.goalUsable !== false && option.enabled !== false && (option.registered || option.configured === true);

export const goalModelOptions = (options: readonly ModelOptionRow[]): readonly ModelOptionRow[] =>
  options
    .filter(isGoalModel)
    .slice()
    .sort((left, right) => Number(right.configured === true) - Number(left.configured === true) || left.displayName.localeCompare(right.displayName));

/** Why a model cannot run a Goal, in plain Chinese; null when it can. */
export const modelUnusableText = (option: ModelOptionRow | null | undefined): string | null => {
  if (option === null || option === undefined) return null;
  if (option.goalUsable !== false && option.enabled !== false) return null;
  if (option.unusableReason === 'PROVIDER_NOT_BOUND') return `「${option.displayName}」属于当前没有启用的模型服务，不能执行目标`;
  if (option.enabled === false) return `「${option.displayName}」已停用，不能执行目标`;
  const kind = option.modality === null || option.modality === undefined ? null : MODALITY_WORDS[option.modality] ?? null;
  return `「${option.displayName}」是${kind === null || kind === '对话模型' ? '非对话模型' : kind}，不能执行目标（目标需要对话模型）`;
};

/** The canonical truth about which model the company currently runs on — or that none is. */
export const projectModelSelection = (
  options: readonly ModelOptionRow[],
  companyModelKey: string | null,
): ModelSelectionStatus => {
  if (options.length === 0) return { kind: 'provider-not-configured' };
  if (companyModelKey === null) return { kind: 'no-selection' };
  const selected = options.find((row) => row.modelKey === companyModelKey);
  return {
    kind: 'selected',
    modelKey: companyModelKey,
    displayName: selected?.displayName ?? null,
  };
};

/**
 * LIVE-CONTRACT-FILL (hark-live-goal 42075419348 / 42085454360, UI defect c): with exactly
 * ONE model configured the composer still said "先选择公司模型…" and refused to send. The
 * configured model is selected automatically (through the same canonical company-selection
 * path as a click): the one row the deployment / first-run setup configured — the provider's
 * catalogue also lists models nobody configured — or the only row there is. With several
 * configured candidates the boss still chooses explicitly, and an existing company selection
 * is never replaced.
 */
export const soleModelOption = (
  options: readonly ModelOptionRow[],
  status: ModelSelectionStatus,
): ModelOptionRow | null => {
  // UI-AUDIT-2: a pinned model that cannot run Goals (an image model chosen from the old
  // full-catalogue list) is replaced by the configured chat model the same way as no selection.
  const pinnedUnusable = status.kind === 'selected' && modelUnusableText(options.find((option) => option.modelKey === status.modelKey)) !== null;
  if (status.kind !== 'no-selection' && !pinnedUnusable) return null;
  const usable = options.filter((option) => option.goalUsable !== false && option.enabled !== false);
  const configured = usable.filter((option) => option.configured === true);
  if (configured.length === 1) return configured[0]!;
  if (pinnedUnusable) return null;
  return configured.length === 0 && usable.length === 1 ? usable[0]! : null;
};

export interface SelectionExplanation {
  readonly accepted: boolean;
  readonly precedence: string | null;
  readonly fallback: string | null;
  readonly reasons: readonly string[];
}

/* ------------------------------------------------------------- loaders --- */

const readList = (value: unknown, map: (row: Record<string, unknown>) => unknown): readonly unknown[] =>
  asArray(value).map((entry) => map(asRecord(entry) ?? {}));

export const loadModelCatalogue = async (bridge: WorkflowBridge): Promise<readonly CatalogueRow[]> => {
  const response = (await bridge.workflowRequest({ operation: 'models.catalogue' })) as {
    readonly ok: boolean;
    readonly value?: unknown;
  };
  if (!response.ok || response.value === undefined) return [];
  return readList(response.value, (row) => ({
    providerId: String(row['providerId'] ?? ''),
    providerModelId: String(row['providerModelId'] ?? ''),
    displayName: String(row['displayName'] ?? row['providerModelId'] ?? ''),
    contextWindow: asNumber(row['contextWindow']),
    ...(row['configured'] === true ? { configured: true } : {}),
    ...(typeof row['goalUsable'] === 'boolean' ? { goalUsable: row['goalUsable'] } : {}),
    ...(typeof row['unusableReason'] === 'string' ? { unusableReason: row['unusableReason'] } : {}),
    ...(typeof row['modality'] === 'string' ? { modality: row['modality'] } : {}),
  })) as readonly CatalogueRow[];
};

export const loadRegisteredModels = async (bridge: WorkflowBridge): Promise<readonly RegisteredRow[]> => {
  const response = (await bridge.workflowRequest({
    operation: 'models.list',
    payload: { includeDisabled: true },
  })) as { readonly ok: boolean; readonly value?: unknown };
  if (!response.ok || response.value === undefined) return [];
  return readList(response.value, (row) => ({
    modelKey: String(row['modelKey'] ?? ''),
    providerId: String(row['providerId'] ?? ''),
    providerModelId: String(row['providerModelId'] ?? ''),
    displayName: String(row['displayName'] ?? row['modelKey'] ?? ''),
    enabled: row['enabled'] === true,
    ...(typeof row['modality'] === 'string' ? { modality: row['modality'] } : {}),
  })) as readonly RegisteredRow[];
};

export interface EstablishSelectionInput {
  readonly providerId: string;
  readonly providerModelId: string;
  /** Present when the model is already registered — registration is then skipped. */
  readonly modelKey: string | null;
}

export type EstablishSelectionResult =
  | { readonly ok: true; readonly modelKey: string; readonly explanation: SelectionExplanation }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Register (only if needed) then pin the COMPANY policy. Every step is a canonical call
 * over the typed bridge; the renderer holds no model or policy truth of its own.
 */
export const establishCompanySelection = async (
  bridge: WorkflowBridge,
  input: EstablishSelectionInput,
): Promise<EstablishSelectionResult> => {
  let modelKey = input.modelKey;
  if (modelKey === null) {
    const registered = (await bridge.workflowRequest({
      operation: 'models.register',
      payload: { providerId: input.providerId, providerModelId: input.providerModelId },
    })) as { readonly ok: boolean; readonly value?: { readonly modelKey?: string }; readonly error?: { readonly code?: string; readonly message?: string } };
    if (!registered.ok || registered.value?.modelKey === undefined) {
      return {
        ok: false,
        code: registered.error?.code ?? 'MODEL_REGISTER_FAILED',
        message: registered.error?.message ?? '无法注册该模型。',
      };
    }
    modelKey = registered.value.modelKey;
  }

  const saved = (await bridge.workflowRequest({
    operation: 'models.policy',
    payload: {
      scopeType: 'COMPANY',
      scopeId: 'company_default',
      mode: 'MANUAL',
      manualModelKey: modelKey,
      allowFallback: 'NEVER',
    },
  })) as { readonly ok: boolean; readonly error?: { readonly code?: string; readonly message?: string } };
  if (!saved.ok) {
    return {
      ok: false,
      code: saved.error?.code ?? 'MODEL_POLICY_FAILED',
      message: saved.error?.message ?? '无法保存模型选择策略。',
    };
  }

  const explained = (await bridge.workflowRequest({
    operation: 'models.policy.explain',
    payload: { modelKey, scopes: [{ scopeType: 'COMPANY', scopeId: 'company_default' }], explicit: true },
  })) as {
    readonly ok: boolean;
    readonly value?: { readonly accepted?: boolean; readonly precedence?: string; readonly fallback?: string; readonly reasons?: unknown };
  };
  const verdict = asRecord(explained.value) ?? {};
  return {
    ok: true,
    modelKey,
    explanation: {
      accepted: verdict['accepted'] === true,
      precedence: typeof verdict['precedence'] === 'string' ? verdict['precedence'] : null,
      fallback: typeof verdict['fallback'] === 'string' ? verdict['fallback'] : null,
      reasons: readList(verdict['reasons'], (row) => String(row ?? '')) as readonly string[],
    },
  };
};

/* ---------------------------------------------------------------- views --- */

/** UI-AUDIT-2: a failed model choice in plain Chinese (the code stays in 详情). */
export const selectionFailureText = (failure: { readonly code: string; readonly message: string }): string => {
  if (/cannot run Goals/u.test(failure.message)) return '这个模型不能执行目标（不是对话模型），请选择对话模型。';
  if (failure.code === 'MODEL_REGISTER_FAILED' || failure.code === 'NOT_FOUND') return '无法注册该模型：模型服务里找不到它，或模型服务暂时不可用。';
  if (failure.code === 'MODEL_POLICY_FAILED') return '无法保存默认模型，请重试。';
  if (failure.code === 'MODEL_SELECTION_FAILED') return '模型选择未完成（读取或保存失败），请重试。';
  return /[\u4e00-\u9fff]/u.test(failure.message) ? failure.message : '模型选择未完成，请重试。';
};

export interface ModelOnboardingViewProps {
  readonly status: ModelSelectionStatus;
  readonly options: readonly ModelOptionRow[];
  readonly selectedProviderModelId: string | null;
  readonly busy: boolean;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly explanation: SelectionExplanation | null;
  readonly onSelect: (option: ModelOptionRow) => void;
  readonly onOpenSettings: () => void;
}

/**
 * Pure view: the model card in the conversation column — shown only when the user must act
 * (no usable model selected). UI-AUDIT-2: it lists ONLY the models the user set up (never
 * the provider's catalogue) and never prints a policy enum.
 */
export function ModelOnboardingView(props: ModelOnboardingViewProps): JSX.Element {
  const { status } = props;
  const goalOptions = goalModelOptions(props.options);
  if (status.kind === 'provider-not-configured' || (props.options.length > 0 && goalOptions.length === 0 && status.kind !== 'selected')) {
    return h(
      'section',
      { className: 'card model-onboarding', 'data-testid': 'model-onboarding', 'aria-label': '模型设置' },
      h('h2', null, '模型'),
      h('p', null, status.kind === 'provider-not-configured' ? '尚未配置模型提供商' : '还没有可以执行目标的对话模型'),
      h(
        'p',
        { className: 'muted' },
        '在 设置 → 模型服务 里选择服务、粘贴 API Key 并填写每个目标的预算，保存后重启 CompanyOS。',
      ),
      h('button', { type: 'button', className: 'btn btn--quiet', onClick: props.onOpenSettings }, '查看设置'),
      props.failure === null ? null : h(TypedErrorLine, { failure: props.failure, text: selectionFailureText(props.failure) }),
    );
  }
  const selected = status.kind === 'selected' ? props.options.find((option) => option.modelKey === status.modelKey) ?? null : null;
  const unusable = modelUnusableText(selected);
  return h(
    'section',
    { className: 'card model-onboarding', 'data-testid': 'model-onboarding', 'aria-label': '模型设置' },
    h('h2', null, '模型'),
    status.kind === 'selected'
      ? h('p', { className: unusable === null ? 'model-onboarding__current' : 'model-onboarding__warn' }, unusable ?? `当前模型：${status.displayName ?? selected?.displayName ?? '已选择'}`)
      : h('p', { className: 'muted' }, '还没有选择执行目标用的模型。'),
    goalOptions.length === 0
      ? null
      : h(
          'ul',
          { className: 'model-onboarding__list', 'data-testid': 'model-options', 'aria-label': '可用模型' },
          goalOptions.map((option) =>
            h(
              'li',
              { key: `${option.providerId}/${option.providerModelId}` },
              h(
                'button',
                {
                  type: 'button',
                  className:
                    props.selectedProviderModelId === option.providerModelId ? 'model-option model-option--active' : 'model-option',
                  disabled: props.busy,
                  onClick: () => props.onSelect(option),
                },
                h('span', { className: 'model-option__name' }, option.displayName),
                h(
                  'span',
                  { className: 'model-option__meta' },
                  [
                    option.configured === true ? '模型服务的模型' : '已添加',
                    option.contextWindow === null ? null : `${option.contextWindow.toLocaleString('en-US')} tokens`,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(' · '),
                ),
              ),
            ),
          ),
        ),
    h('button', { type: 'button', className: 'btn btn--text', onClick: props.onOpenSettings }, '管理模型'),
    props.explanation === null || props.explanation.accepted
      ? null
      : h('p', { className: 'model-onboarding__warn', role: 'status' }, '这个模型不符合公司的模型规则，没有设为默认。'),
    props.failure === null ? null : h(TypedErrorLine, { failure: props.failure, text: selectionFailureText(props.failure) }),
  );
}


/* ------------------------------------------------- UI-AUDIT-2: model management --- */

type BridgeAnswer = { readonly ok: boolean; readonly value?: { readonly modelKey?: string }; readonly error?: { readonly code?: string; readonly message?: string } };

/** Register a provider model so it can run Goals (Settings → 添加). Never pins it as default. */
export const registerModel = async (
  bridge: WorkflowBridge,
  option: Pick<ModelOptionRow, 'providerId' | 'providerModelId'>,
): Promise<{ readonly ok: true; readonly modelKey: string } | { readonly ok: false; readonly code: string; readonly message: string }> => {
  const answer = (await bridge.workflowRequest({
    operation: 'models.register',
    payload: { providerId: option.providerId, providerModelId: option.providerModelId },
  })) as BridgeAnswer;
  if (!answer.ok || answer.value?.modelKey === undefined) {
    return { ok: false, code: answer.error?.code ?? 'MODEL_REGISTER_FAILED', message: answer.error?.message ?? '无法注册该模型。' };
  }
  return { ok: true, modelKey: answer.value.modelKey };
};

/** Enable / disable a registered model (Settings → 启用 / 停用). */
export const setModelEnabled = async (
  bridge: WorkflowBridge,
  modelKey: string,
  enabled: boolean,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }> => {
  const answer = (await bridge.workflowRequest({ operation: enabled ? 'models.enable' : 'models.disable', payload: { modelKey } })) as BridgeAnswer;
  return answer.ok ? { ok: true } : { ok: false, code: answer.error?.code ?? 'MODEL_ENABLE_FAILED', message: answer.error?.message ?? '无法更改模型状态。' };
};
