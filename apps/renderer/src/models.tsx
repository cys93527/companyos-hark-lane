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
}

export interface RegisteredRow {
  readonly modelKey: string;
  readonly providerId: string;
  readonly providerModelId: string;
  readonly displayName: string;
  readonly enabled: boolean;
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
  for (const row of registered) {
    rows.set(`${row.providerId}/${row.providerModelId}`, {
      providerId: row.providerId,
      providerModelId: row.providerModelId,
      displayName: row.displayName,
      contextWindow: null,
      registered: true,
      modelKey: row.modelKey,
      priceInput: null,
      priceOutput: null,
    });
  }
  for (const row of catalogue) {
    const key = `${row.providerId}/${row.providerModelId}`;
    const existing = rows.get(key);
    rows.set(key, {
      providerId: row.providerId,
      providerModelId: row.providerModelId,
      displayName: row.displayName || row.providerModelId,
      contextWindow: row.contextWindow,
      registered: existing?.registered ?? false,
      modelKey: existing?.modelKey ?? null,
      priceInput: existing?.priceInput ?? null,
      priceOutput: existing?.priceOutput ?? null,
    });
  }
  return [...rows.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
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
 * Pure view: the model-selection surface. It renders the canonical selection status and
 * never invents a model, a price or an availability of its own.
 */
export function ModelOnboardingView(props: ModelOnboardingViewProps): JSX.Element {
  const { status } = props;
  if (status.kind === 'provider-not-configured') {
    return h(
      'section',
      { className: 'card model-onboarding', 'aria-label': 'model-onboarding' },
      h('h2', null, '模型'),
      h('p', { className: 'muted' }, '尚未配置模型提供商'),
      h(
        'p',
        { className: 'muted' },
        '配置提供商后才能选择模型并创建目标。',
      ),
      h('button', { type: 'button', onClick: props.onOpenSettings }, '前往设置'),
    );
  }

  return h(
    'section',
    { className: 'card model-onboarding', 'aria-label': 'model-onboarding' },
    h('h2', null, '模型'),
    status.kind === 'selected'
      ? h(
          'p',
          { className: 'model-onboarding__current' },
          `当前公司模型：${status.displayName ?? status.modelKey}`,
        )
      : h('p', { className: 'muted' }, '尚未选择公司模型 — 选择后即可创建目标。'),
    h(
      'ul',
      { className: 'model-onboarding__list', 'aria-label': 'model-options' },
      props.options.map((option) =>
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
                option.registered ? '已注册' : '未注册',
                option.contextWindow === null ? null : `${option.contextWindow.toLocaleString('en-US')} tokens`,
              ]
                .filter((part): part is string => part !== null)
                .join(' · '),
            ),
          ),
        ),
      ),
    ),
    props.explanation === null
      ? null
      : h(
          'p',
          { className: props.explanation.accepted ? 'model-onboarding__ok' : 'model-onboarding__warn', role: 'status' },
          props.explanation.accepted
            ? `已按公司策略固定该模型（${props.explanation.precedence ?? 'MANUAL'}，失败不回退）。`
            : `策略拒绝：${props.explanation.reasons.join('；') || '未说明原因'}`,
        ),
    props.failure === null
      ? null
      : h('p', { className: 'typed-error__message', role: 'alert' }, `${props.failure.code} ${props.failure.message}`),
  );
}
