/**
 * H12c — a downgrade refusal is shown to the boss in Chinese with the remedy; a
 * malformed payload shows nothing (never a fake failure).
 */
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DatabaseFailureBanner, databaseFailureText, readDatabaseFailure } from '../src/database-failure.js';

describe('H12c database failure banner', () => {
  it('decodes only the typed failures', () => {
    expect(readDatabaseFailure(null)).toBeNull();
    expect(readDatabaseFailure(undefined)).toBeNull();
    expect(readDatabaseFailure({ code: 'SOMETHING' })).toBeNull();
    expect(readDatabaseFailure({ code: 'SCHEMA_FROM_NEWER_VERSION', unknownMigrations: ['0010_x', 3] })).toEqual({
      code: 'SCHEMA_FROM_NEWER_VERSION',
      unknownMigrations: ['0010_x'],
    });
    expect(readDatabaseFailure({ code: 'OPEN_FAILED', message: 'disk' })).toEqual({ code: 'OPEN_FAILED', message: 'disk' });
  });

  it('renders the newer-version refusal with the remedy and an alert role', () => {
    const html = renderToString(
      h(DatabaseFailureBanner, { failure: { code: 'SCHEMA_FROM_NEWER_VERSION', unknownMigrations: ['0010_x'] } }),
    );
    expect(html).toContain('数据来自更新版本的 CompanyOS');
    expect(html).toContain('0010_x');
    expect(html).toContain('请重新安装更新版本');
    expect(html).toContain('role="alert"');
    expect(databaseFailureText({ code: 'OPEN_FAILED', message: '' }).title).toBe('数据库无法打开');
    expect(renderToString(h(DatabaseFailureBanner, { failure: null }))).toBe('');
  });

  it('App reads the typed failure from databaseStatus (main-process source only)', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('readDatabaseFailure(database?.failure)');
    const main = readFileSync(new URL('../../desktop/src/main.ts', import.meta.url), 'utf8');
    expect(main).toContain('isMigrationFromNewerVersionError(error)');
    expect(main).toContain('failure: databaseFailure');
  });
});
