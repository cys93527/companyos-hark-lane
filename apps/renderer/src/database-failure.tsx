/**
 * H12c — the durable database did not open, as the boss sees it.
 *
 * The main process types the bootstrap failure (`databaseStatus().failure`). A
 * `SCHEMA_FROM_NEWER_VERSION` refusal means a newer CompanyOS already upgraded this data
 * directory; this older build refused to open it so nothing is damaged, and the remedy is
 * to install the newer version again. Display-only: nothing here retries, migrates or
 * deletes anything.
 */
import { createElement as h, type ReactElement } from 'react';

export type DatabaseFailureView =
  | { readonly code: 'SCHEMA_FROM_NEWER_VERSION'; readonly unknownMigrations: readonly string[] }
  | { readonly code: 'OPEN_FAILED'; readonly message: string };

export function readDatabaseFailure(value: unknown): DatabaseFailureView | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { code?: unknown; unknownMigrations?: unknown; message?: unknown };
  if (record.code === 'SCHEMA_FROM_NEWER_VERSION') {
    const unknown = Array.isArray(record.unknownMigrations)
      ? record.unknownMigrations.filter((name): name is string => typeof name === 'string')
      : [];
    return { code: 'SCHEMA_FROM_NEWER_VERSION', unknownMigrations: unknown };
  }
  if (record.code === 'OPEN_FAILED') {
    return { code: 'OPEN_FAILED', message: typeof record.message === 'string' ? record.message : '' };
  }
  return null;
}

export function databaseFailureText(failure: DatabaseFailureView): { readonly title: string; readonly body: string } {
  if (failure.code === 'SCHEMA_FROM_NEWER_VERSION') {
    return {
      title: '数据来自更新版本的 CompanyOS',
      body: `这个数据目录已被更新版本升级过（未知迁移：${failure.unknownMigrations.join('、') || '—'}）。当前版本为保护数据拒绝打开，数据未被改动。请重新安装更新版本后再打开。`,
    };
  }
  return {
    title: '数据库无法打开',
    body: `本地数据库打开失败，目标与运行功能不可用。${failure.message === '' ? '' : `原因：${failure.message}`}`,
  };
}

export function DatabaseFailureBanner(props: { readonly failure: DatabaseFailureView | null }): ReactElement | null {
  if (props.failure === null) return null;
  const text = databaseFailureText(props.failure);
  return h(
    'section',
    { className: 'typed-error database-failure', role: 'alert', 'data-failure-code': props.failure.code },
    h('strong', { className: 'typed-error__title' }, text.title),
    h('p', { className: 'typed-error__message' }, text.body),
  );
}
