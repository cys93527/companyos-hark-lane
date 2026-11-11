/**
 * UI-AUDIT-3 — 设置 → 模型服务 (docs/hark-lane/UI_AUDIT_3.md).
 *
 * The user picks the shipped service or any OpenAI-compatible service, pastes the API key, tests
 * the connection and sets the per-Goal budget — without the Start-menu helper (which keeps working).
 *
 * Key handling (the H17a boundary, kept): the key lives ONLY in the password field's DOM value.
 * It is never put in React state, props, storage or a message; on 保存 it is read from the field,
 * the field is cleared, and the value goes one way to the MAIN process (providerSettings channel),
 * which encrypts it with DPAPI. Nothing the main process returns carries it — at most
 * "****" + its last 4 characters. The budget approval itself is the user's click in a native
 * confirm dialog owned by the main process; this view cannot approve anything on its own.
 */
import { createElement as h, useCallback, useEffect, useRef, useState, type JSX } from 'react';

export interface ProviderServiceView {
  readonly kind: 'preset' | 'custom';
  readonly baseUrl: string;
  readonly host: string;
  readonly modelId: string;
  readonly inputCnyPerM: number;
  readonly outputCnyPerM: number;
}

export interface ProviderSettingsStatusView {
  readonly keyEntrySupported: boolean;
  readonly source: 'environment' | 'settings' | 'none';
  readonly state: 'NOT_CONFIGURED' | 'CONFIGURED' | 'INVALID';
  readonly problem: string | null;
  readonly service: ProviderServiceView | null;
  readonly keyHint: string | null;
  readonly capCny: number | null;
  readonly preset: ProviderServiceView | null;
  readonly capMinCny: number;
  readonly capMaxCny: number;
  readonly priceMaxCnyPerM: number;
  readonly restartRequired: boolean;
}

export interface ProviderSettingsResultView {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly status?: ProviderSettingsStatusView;
  readonly restartRequired?: boolean;
  readonly modelListed?: boolean | null;
}

export type ProviderSettingsRequest = (operation: 'status' | 'test' | 'save' | 'remove' | 'restart', payload?: unknown) => Promise<ProviderSettingsResultView>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Defensive read of a main-process answer (anything malformed is a plain failure). */
export const parseProviderSettingsResult = (raw: unknown): ProviderSettingsResultView => {
  if (!isRecord(raw) || typeof raw['ok'] !== 'boolean' || typeof raw['code'] !== 'string') {
    return { ok: false, code: 'IPC_FAILED', message: '无法读取模型服务设置（通信失败），请重试。' };
  }
  return raw as unknown as ProviderSettingsResultView;
};

/** Wrap the preload method; a rejected IPC call becomes a typed failure. */
export const providerSettingsRequestOf = (
  call: ((request: { readonly operation: string; readonly payload?: unknown }) => Promise<unknown>) | undefined,
): ProviderSettingsRequest | null =>
  call === undefined
    ? null
    : async (operation, payload) => {
        try {
          return parseProviderSettingsResult(await call(payload === undefined ? { operation } : { operation, payload }));
        } catch {
          return { ok: false, code: 'IPC_FAILED', message: '无法连接主进程，请重试。' };
        }
      };

/** Read the secret field's value and CLEAR the field (the only way the key leaves the DOM). */
export const takeSecretField = (field: { value: string } | null): string => {
  if (field === null) return '';
  const value = field.value;
  field.value = '';
  return value;
};

/** Read without clearing (测试连接 keeps the field so the user can then save). */
export const peekSecretField = (field: { value: string } | null): string => (field === null ? '' : field.value);

export interface ServiceForm {
  readonly mode: 'preset' | 'custom';
  readonly baseUrl: string;
  readonly modelId: string;
  readonly inputCnyPerM: string;
  readonly outputCnyPerM: string;
  readonly capCny: string;
}

export const formFromStatus = (status: ProviderSettingsStatusView | null): ServiceForm => {
  const service = status?.service ?? null;
  const custom = service !== null && service.kind === 'custom';
  return {
    mode: custom || (status !== null && status.preset === null) ? 'custom' : 'preset',
    baseUrl: custom ? service.baseUrl : '',
    modelId: custom ? service.modelId : '',
    inputCnyPerM: custom && service.inputCnyPerM > 0 ? String(service.inputCnyPerM) : '',
    outputCnyPerM: custom && service.outputCnyPerM > 0 ? String(service.outputCnyPerM) : '',
    capCny: status?.capCny === null || status?.capCny === undefined ? '' : String(status.capCny),
  };
};

const num = (text: string): number => (text.trim() === '' ? Number.NaN : Number(text.trim()));

/** The save payload (the key is added only when typed; an empty field keeps the stored key). */
export const savePayloadOf = (form: ServiceForm, key: string): Record<string, unknown> => ({
  mode: form.mode,
  ...(form.mode === 'custom'
    ? { baseUrl: form.baseUrl.trim(), modelId: form.modelId.trim(), inputCnyPerM: num(form.inputCnyPerM), outputCnyPerM: num(form.outputCnyPerM) }
    : {}),
  ...(key.trim() === '' ? {} : { apiKey: key }),
  capCny: num(form.capCny),
});

export const testPayloadOf = (form: ServiceForm, key: string): Record<string, unknown> => ({
  mode: form.mode,
  ...(form.mode === 'custom' ? { baseUrl: form.baseUrl.trim(), modelId: form.modelId.trim() } : {}),
  ...(key.trim() === '' ? {} : { apiKey: key }),
});

/** Validate what the renderer can before asking main (main validates again). Null = fine. */
export const formProblem = (form: ServiceForm, status: ProviderSettingsStatusView | null, keyTyped: boolean): string | null => {
  if (!keyTyped && status?.keyHint == null) return '请填写 API Key。';
  if (form.mode === 'custom') {
    if (!/^https:\/\//u.test(form.baseUrl.trim())) return '服务地址要以 https:// 开头。';
    if (form.modelId.trim() === '') return '请填写对话模型 id。';
    const i = num(form.inputCnyPerM);
    const o = num(form.outputCnyPerM);
    const max = status?.priceMaxCnyPerM ?? 1000;
    if (!(i > 0 && i <= max) || !(o > 0 && o <= max)) return `请按服务公布的价格填写输入、输出价格（每百万 tokens，0–${String(max)} 元）。`;
  }
  const cap = num(form.capCny);
  const min = status?.capMinCny ?? 0.1;
  const max = status?.capMaxCny ?? 100;
  if (!(cap >= min && cap <= max)) return `每个目标的预算要在 ${String(min)}–${String(max)} 元之间。`;
  return null;
};

/** The summary lines of a configured service (pure, tested without a DOM). */
export const serviceSummaryRows = (status: ProviderSettingsStatusView): readonly (readonly [string, string])[] => {
  const rows: (readonly [string, string])[] = [];
  if (status.service !== null) {
    rows.push(['服务', `${status.service.host} · ${status.service.modelId}${status.service.kind === 'preset' ? '（推荐）' : ''}`]);
  }
  rows.push(['API Key', status.keyHint === null ? '未保存' : `已保存 · ${status.keyHint}`]);
  if (status.service !== null && status.service.inputCnyPerM > 0) {
    rows.push(['价格', `输入 ${String(status.service.inputCnyPerM)} 元 / 输出 ${String(status.service.outputCnyPerM)} 元（每百万 tokens）`]);
  }
  rows.push(['每个目标最多花费', status.capCny === null ? '未设置（预算为 0，目标无法执行）' : `${String(status.capCny)} 元`]);
  return rows;
};

export interface ModelServiceSectionProps {
  readonly request: ProviderSettingsRequest | null;
  /** Called after a successful save/remove (the app re-reads models and budget). */
  readonly onChanged?: () => void;
}

export function ModelServiceSection(props: ModelServiceSectionProps): JSX.Element {
  const { request, onChanged } = props;
  const [status, setStatus] = useState<ProviderSettingsStatusView | null>(null);
  const [form, setForm] = useState<ServiceForm>(formFromStatus(null));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  // The key field is UNCONTROLLED: its value never enters React state.
  const keyField = useRef<{ value: string } | null>(null);

  const load = useCallback(async () => {
    if (request === null) return;
    const answer = await request('status');
    if (answer.ok && answer.status !== undefined) {
      setStatus(answer.status);
      setForm(formFromStatus(answer.status));
      setEditing(answer.status.state !== 'CONFIGURED' && answer.status.source !== 'environment');
    } else {
      setNotice({ ok: false, text: answer.message });
    }
  }, [request]);
  useEffect(() => {
    void load();
  }, [load]);

  if (request === null) {
    return h('div', { 'data-testid': 'settings-service' }, h('p', { className: 'muted' }, '模型服务设置只在 CompanyOS 桌面应用里可用。'));
  }
  if (status === null) {
    return h('div', { 'data-testid': 'settings-service' }, h('p', { className: 'muted' }, notice?.text ?? '读取中…'));
  }

  const run = async (operation: 'test' | 'save' | 'remove' | 'restart', payload?: unknown) => {
    setBusy(true);
    setNotice(null);
    try {
      const answer = await request(operation, payload);
      setNotice(answer.code === 'CANCELLED' ? { ok: true, text: answer.message } : { ok: answer.ok, text: answer.message });
      if (answer.ok && answer.status !== undefined) {
        setStatus(answer.status);
        setForm(formFromStatus(answer.status));
        if (operation === 'save' || operation === 'remove') {
          setEditing(operation === 'remove');
          onChanged?.();
        }
      }
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const keyTyped = peekSecretField(keyField.current).trim() !== '';
    const problem = formProblem(form, status, keyTyped);
    if (problem !== null) {
      setNotice({ ok: false, text: problem });
      return;
    }
    void run('save', savePayloadOf(form, takeSecretField(keyField.current)));
  };
  const test = () => void run('test', testPayloadOf(form, peekSecretField(keyField.current)));
  const set = (patch: Partial<ServiceForm>) => setForm((current) => ({ ...current, ...patch }));
  const environment = status.source === 'environment';

  const restartBanner = status.restartRequired
    ? h(
        'div',
        { className: 'settings-service__restart', role: 'status', 'data-testid': 'settings-service-restart' },
        h('span', null, '设置已保存，重启 CompanyOS 后生效。'),
        h('button', { type: 'button', className: 'btn btn--quiet btn--small', disabled: busy, onClick: () => void run('restart') }, '立即重启'),
      )
    : null;

  const summary = h(
    'dl',
    { className: 'kv', 'data-testid': 'settings-service-summary' },
    serviceSummaryRows(status).flatMap(([k, v]) => [h('dt', { key: `${k}-k` }, k), h('dd', { key: `${k}-v` }, v)]),
  );

  const field = (label: string, input: JSX.Element, hint?: string) =>
    h('label', { className: 'settings-field' }, h('span', { className: 'settings-field__label' }, label), input, hint === undefined ? null : h('span', { className: 'settings-field__hint muted' }, hint));

  const formView = h(
    'form',
    {
      className: 'settings-service__form',
      'data-testid': 'settings-service-form',
      onSubmit: (event: { preventDefault: () => void }) => {
        event.preventDefault();
        save();
      },
    },
    h(
      'fieldset',
      { className: 'settings-service__mode', disabled: busy },
      h('legend', { className: 'settings-field__label' }, '选择服务'),
      status.preset === null
        ? null
        : h(
            'label',
            { className: 'settings-radio' },
            h('input', { type: 'radio', name: 'service-mode', checked: form.mode === 'preset', onChange: () => set({ mode: 'preset' }) }),
            h('span', null, `推荐：${status.preset.host} · ${status.preset.modelId}`),
            h('span', { className: 'muted' }, `价格已填好（输入 ${String(status.preset.inputCnyPerM)} 元 / 输出 ${String(status.preset.outputCnyPerM)} 元，每百万 tokens）`),
          ),
      h(
        'label',
        { className: 'settings-radio' },
        h('input', { type: 'radio', name: 'service-mode', checked: form.mode === 'custom', onChange: () => set({ mode: 'custom' }) }),
        h('span', null, '其他 OpenAI 兼容服务'),
        h('span', { className: 'muted' }, '填写服务地址、对话模型 id 和服务公布的价格'),
      ),
    ),
    form.mode === 'custom'
      ? h(
          'div',
          { className: 'settings-service__custom' },
          field('服务地址', h('input', { type: 'url', value: form.baseUrl, placeholder: 'https://…/v1', disabled: busy, 'data-testid': 'service-base-url', onChange: (e: { target: { value: string } }) => set({ baseUrl: e.target.value }) })),
          field('对话模型 id', h('input', { value: form.modelId, disabled: busy, 'data-testid': 'service-model-id', onChange: (e: { target: { value: string } }) => set({ modelId: e.target.value }) })),
          field('输入价格（元 / 每百万 tokens）', h('input', { inputMode: 'decimal', value: form.inputCnyPerM, disabled: busy, 'data-testid': 'service-input-price', onChange: (e: { target: { value: string } }) => set({ inputCnyPerM: e.target.value }) })),
          field('输出价格（元 / 每百万 tokens）', h('input', { inputMode: 'decimal', value: form.outputCnyPerM, disabled: busy, 'data-testid': 'service-output-price', onChange: (e: { target: { value: string } }) => set({ outputCnyPerM: e.target.value }) })),
        )
      : null,
    field(
      'API Key',
      h('input', {
        type: 'password',
        ref: (element: { value: string } | null) => {
          keyField.current = element;
        },
        autoComplete: 'off',
        spellCheck: false,
        disabled: busy || !status.keyEntrySupported,
        placeholder: status.keyHint === null ? '粘贴 API Key' : `已保存 ${status.keyHint}，留空则保持不变`,
        'data-testid': 'service-api-key',
        'aria-label': 'API Key',
      }),
      status.keyEntrySupported ? 'Key 只交给本机 CompanyOS 主进程，用 Windows 加密保存；界面不会再显示它。' : '这台电脑不能在应用内保存 Key（需要 Windows）。',
    ),
    field(
      '每个目标最多花费（元）',
      h('input', { inputMode: 'decimal', value: form.capCny, disabled: busy, 'data-testid': 'service-cap', onChange: (e: { target: { value: string } }) => set({ capCny: e.target.value }) }),
      `${String(status.capMinCny)}–${String(status.capMaxCny)} 元。超过上限的模型调用会被拒绝。保存时会弹出确认。`,
    ),
    h(
      'div',
      { className: 'settings-service__actions' },
      h('button', { type: 'submit', className: 'btn btn--primary', disabled: busy || !status.keyEntrySupported }, busy ? '处理中…' : '保存'),
      h('button', { type: 'button', className: 'btn btn--quiet', disabled: busy, onClick: test }, '测试连接'),
      status.state === 'CONFIGURED' ? h('button', { type: 'button', className: 'btn btn--text', disabled: busy, onClick: () => { setEditing(false); setForm(formFromStatus(status)); takeSecretField(keyField.current); setNotice(null); } }, '取消') : null,
    ),
  );

  return h(
    'div',
    { className: 'settings-service', 'data-testid': 'settings-service' },
    restartBanner,
    environment ? h('p', { className: 'muted' }, '模型服务由部署环境提供，这里的设置不会生效。') : null,
    status.problem === null ? null : h('p', { className: 'model-onboarding__warn' }, status.problem),
    status.state === 'CONFIGURED' || environment ? summary : null,
    editing && !environment
      ? formView
      : environment
        ? null
        : h(
            'div',
            { className: 'settings-service__actions' },
            h('button', { type: 'button', className: 'btn btn--quiet', disabled: busy, onClick: () => { setEditing(true); setNotice(null); } }, '修改服务、Key 或预算'),
            h('button', { type: 'button', className: 'btn btn--text', disabled: busy, onClick: test }, '测试连接'),
            h('button', { type: 'button', className: 'btn btn--text', disabled: busy, onClick: () => void run('remove') }, '移除'),
          ),
    notice === null ? null : h('p', { className: notice.ok ? 'settings-service__notice' : 'settings-service__notice model-onboarding__warn', role: notice.ok ? 'status' : 'alert', 'data-testid': 'settings-service-notice' }, notice.text),
  );
}
