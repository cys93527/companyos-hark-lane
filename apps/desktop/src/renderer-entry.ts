/**
 * STARTUP-VISIBLE — which page the main window loads, and the built-in page it shows when
 * the renderer cannot be loaded.
 *
 * Root cause this closes (2026-11-05, source checkout on Windows): `pnpm dev` built only the
 * desktop package, so apps/renderer/dist/index.html did not exist; `loadFile` rejected with
 * ERR_FILE_NOT_FOUND, nothing handled the rejection, and the user saw an empty window in the
 * window background colour. Now a missing or failed renderer load is answered with a small
 * self-contained page (data: URL, no script, no network) that says what is wrong and the
 * exact command that fixes it.
 */
import { join } from 'node:path';

export type RendererEntry =
  | { readonly kind: 'dev-server'; readonly url: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'missing'; readonly path: string };

/** The one-command source start (root package.json "dev"/"start": build everything, then electron). */
export const SOURCE_START_COMMAND = 'pnpm dev';
/** The renderer-only rebuild, when the rest is already built. */
export const RENDERER_BUILD_COMMAND = 'pnpm run build:renderer';

export const rendererIndexPath = (mainDir: string): string =>
  join(mainDir, '..', '..', 'renderer', 'dist', 'index.html');

export function resolveRendererEntry(
  mainDir: string,
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean,
): RendererEntry {
  const devServerUrl = env['COMPANYOS_RENDERER_URL'];
  if (devServerUrl !== undefined && devServerUrl.length > 0) return { kind: 'dev-server', url: devServerUrl };
  const path = rendererIndexPath(mainDir);
  return exists(path) ? { kind: 'file', path } : { kind: 'missing', path };
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);

export interface StartupErrorPage {
  readonly reason: 'RENDERER_MISSING' | 'RENDERER_LOAD_FAILED';
  /** The renderer path or URL that could not be loaded. */
  readonly target: string;
  /** The load error (e.g. ERR_FILE_NOT_FOUND), when there was one. */
  readonly detail: string | null;
  readonly packaged: boolean;
}

/** The built-in page's HTML (zh-CN; inline styles only, no script). */
export function startupErrorHtml(page: StartupErrorPage): string {
  const title = page.reason === 'RENDERER_MISSING' ? '界面文件尚未构建' : '界面加载失败';
  const remedy = page.packaged
    ? '<p>安装包缺少界面文件。请重新运行 CompanyOS 安装程序（你的数据保存在 %APPDATA%\\@companyos\\desktop，重新安装不会删除）。</p>'
    : `<p>从源码运行时，请在仓库根目录执行下面的命令（会先构建 packages、界面和桌面端，再启动）：</p>
<pre>${escapeHtml(SOURCE_START_COMMAND)}</pre>
<p>只需重建界面时：</p>
<pre>${escapeHtml(RENDERER_BUILD_COMMAND)}</pre>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>CompanyOS — ${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f1eee9;color:#1c1b19;font-family:'Segoe UI','Microsoft YaHei UI',sans-serif;">
<main style="max-width:720px;margin:72px auto;padding:0 32px;line-height:1.6;">
<h1 style="font-size:22px;font-weight:600;margin:0 0 12px;">CompanyOS：${escapeHtml(title)}</h1>
<p>无法加载：<code>${escapeHtml(page.target)}</code>${page.detail === null ? '' : `（${escapeHtml(page.detail)}）`}</p>
${remedy.replace(/<pre>/g, '<pre style="background:#fffefc;border:1px solid #ddd8cf;padding:10px 14px;font-family:Consolas,monospace;">')}
<p style="color:#77736b;font-size:13px;">详情见日志 desktop.log。</p>
</main></body></html>`;
}

export const startupErrorUrl = (page: StartupErrorPage): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(startupErrorHtml(page))}`;
