/**
 * AUDIT-D9 — the ONE Content-Security-Policy string for the renderer, dependency-free so the
 * renderer build (apps/renderer/vite.config.ts) can embed it as a `<meta http-equiv>` in the
 * built index.html. The packaged app loads the renderer over file://, where a response-header
 * CSP (session.webRequest.onHeadersReceived) is not delivered; the meta tag is the mechanism
 * that applies there. main.ts still sets the header for any http(s) response.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** The build-time head tag (Vite HtmlTagDescriptor shape) carrying CSP; prepended so it governs everything after it. */
export const cspMetaTag = (): { readonly tag: 'meta'; readonly attrs: Readonly<Record<string, string>>; readonly injectTo: 'head-prepend' } => ({
  tag: 'meta',
  attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
  injectTo: 'head-prepend',
});
