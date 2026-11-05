/**
 * STARTUP-VISIBLE — the core services are not fully usable, as the boss
 * sees it.
 *
 * The main process types it in `databaseStatus().services`: CORE_SERVICES_UNAVAILABLE (the
 * composition failed; goals and runs cannot start) or MODEL_PROVIDER_REFUSED (the app runs
 * without the configured model provider). Display-only: nothing here retries or changes data.
 */
import { createElement as h, type ReactElement } from 'react';

export interface ServicesFailureView {
  readonly code: 'CORE_SERVICES_UNAVAILABLE' | 'MODEL_PROVIDER_REFUSED';
  readonly message: string;
}

export function readServicesFailure(value: unknown): ServicesFailureView | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { code?: unknown; message?: unknown };
  const message = typeof record.message === 'string' ? record.message : '';
  if (record.code === 'CORE_SERVICES_UNAVAILABLE' || record.code === 'MODEL_PROVIDER_REFUSED') {
    return { code: record.code, message };
  }
  return null;
}

export function servicesFailureText(failure: ServicesFailureView): { readonly title: string; readonly body: string } {
  if (failure.code === 'MODEL_PROVIDER_REFUSED') {
    return {
      title: '模型提供商未启用',
      body: `CompanyOS 已启动，但没有启用已配置的模型提供商，暂时无法发送目标。${failure.message === '' ? '' : `原因：${failure.message}`} 请检查模型配置（开始菜单「CompanyOS 首次配置」或 COS_MODEL_* 环境变量）后重新打开 CompanyOS；数据未被改动。`,
    };
  }
  return {
    title: '核心服务未能启动',
    body: `界面可用，但目标与运行功能暂不可用。${failure.message === '' ? '' : `原因：${failure.message}`} 详情见日志 desktop.log；数据未被改动。`,
  };
}

export function ServicesFailureBanner(props: { readonly failure: ServicesFailureView | null }): ReactElement | null {
  if (props.failure === null) return null;
  const text = servicesFailureText(props.failure);
  return h(
    'section',
    { className: 'typed-error services-failure', role: 'alert', 'data-failure-code': props.failure.code },
    h('strong', { className: 'typed-error__title' }, text.title),
    h('p', { className: 'typed-error__message' }, text.body),
  );
}
