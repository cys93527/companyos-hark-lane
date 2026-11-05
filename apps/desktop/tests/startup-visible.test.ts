/**
 * STARTUP-VISIBLE (docs/hark-lane/PROVIDER_DESCRIPTOR_RECONCILE.md) — regression for the
 * 2026-11-05 Windows source-run report: dark empty window, "Failed to load URL
 * file:///…/apps/renderer/dist/index.html with error: ERR_FILE_NOT_FOUND" and an
 * UnhandledPromiseRejectionWarning from loadFile.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  RENDERER_BUILD_COMMAND,
  SOURCE_START_COMMAND,
  rendererIndexPath,
  resolveRendererEntry,
  startupErrorHtml,
  startupErrorUrl,
} from '../src/renderer-entry.js';
import { WINDOW_BACKGROUND, createWindowOptions } from '../src/security.js';

const MAIN_DIR = join('F:', 'ziji', 'apps', 'desktop', 'dist');
const repo = (path: string): string => readFileSync(join(__dirname, '..', '..', '..', path), 'utf8');

describe('renderer entry', () => {
  it('dev server wins; else the built index.html; else missing (never a bare loadFile)', () => {
    expect(resolveRendererEntry(MAIN_DIR, { COMPANYOS_RENDERER_URL: 'http://localhost:5173' }, () => false)).toEqual({ kind: 'dev-server', url: 'http://localhost:5173' });
    expect(resolveRendererEntry(MAIN_DIR, {}, () => true)).toEqual({ kind: 'file', path: rendererIndexPath(MAIN_DIR) });
    expect(resolveRendererEntry(MAIN_DIR, {}, () => false)).toEqual({ kind: 'missing', path: rendererIndexPath(MAIN_DIR) });
    expect(rendererIndexPath(MAIN_DIR).replace(/\\/g, '/')).toBe('F:/ziji/apps/renderer/dist/index.html');
  });

  it('the built-in page names the cause and the exact source command, escapes the path, and has no script', () => {
    const html = startupErrorHtml({ reason: 'RENDERER_MISSING', target: 'F:\\ziji\\<x>\\index.html', detail: null, packaged: false });
    expect(html).toContain('界面文件尚未构建');
    expect(html).toContain(SOURCE_START_COMMAND);
    expect(html).toContain(RENDERER_BUILD_COMMAND);
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toMatch(/<script/iu);
    const failed = startupErrorHtml({ reason: 'RENDERER_LOAD_FAILED', target: 'x', detail: 'ERR_FILE_NOT_FOUND (-6)', packaged: true });
    expect(failed).toContain('界面加载失败');
    expect(failed).toContain('ERR_FILE_NOT_FOUND');
    expect(failed).toContain('重新运行 CompanyOS 安装程序');
    expect(startupErrorUrl({ reason: 'RENDERER_MISSING', target: 'x', detail: null, packaged: false })).toMatch(/^data:text\/html;charset=utf-8,/u);
  });

  it('the source start commands build the renderer (and libs + desktop) before electron', () => {
    const root = JSON.parse(repo('package.json')) as { scripts: Record<string, string> };
    const desktop = JSON.parse(repo('apps/desktop/package.json')) as { scripts: Record<string, string> };
    expect(SOURCE_START_COMMAND).toBe('pnpm dev');
    for (const script of [root.scripts['dev'], root.scripts['start']]) {
      expect(script).toBe('pnpm run build && pnpm --filter @companyos/desktop start');
    }
    expect(root.scripts['build']).toContain('build:renderer');
    expect(desktop.scripts['dev']).toBe('pnpm -w run build && electron .');
    expect(RENDERER_BUILD_COMMAND).toBe('pnpm run build:renderer');
    expect(root.scripts['build:renderer']).toBe('pnpm --filter @companyos/renderer build');
  });

  it('main.ts handles a missing/failed renderer load (no unhandled loadFile rejection)', () => {
    const main = repo('apps/desktop/src/main.ts');
    const body = main.slice(main.indexOf('async function createMainWindow'), main.indexOf('function applyContentSecurityPolicy'));
    expect(body).toContain('resolveRendererEntry(mainDir, process.env, existsSync)');
    expect(body).toMatch(/entry\.kind === 'missing'/u);
    expect(body).toMatch(/try \{\s+if \(entry\.kind === 'dev-server'\) await window\.loadURL\(entry\.url\);\s+else await window\.loadFile\(entry\.path\);\s+\} catch/u);
    expect(body).toContain('startupErrorUrl(page)');
  });
});

describe('window background', () => {
  it('is the paper-ink app background (--paper-1), not the old dark colour', () => {
    expect(createWindowOptions(MAIN_DIR).backgroundColor).toBe(WINDOW_BACKGROUND);
    expect(WINDOW_BACKGROUND).toBe('#f1eee9');
    expect(repo('apps/renderer/src/styles.css')).toMatch(/--paper-1:\s*#f1eee9;/u);
  });
});

describe('services failure reaches the renderer', () => {
  it('databaseStatus carries the typed services failure (composition failed / model provider refused)', () => {
    const main = repo('apps/desktop/src/main.ts');
    expect(main).toContain('services: servicesFailure(),');
    expect(main).toMatch(/code: 'CORE_SERVICES_UNAVAILABLE', message: workflowError/u);
    expect(main).toMatch(/code: 'MODEL_PROVIDER_REFUSED'/u);
  });
});
