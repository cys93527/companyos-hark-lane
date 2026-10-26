/**
 * Hark lane H15c — wire compatibility of a model route, judged from the REAL upstream.
 *
 * The embedded kernel only ever sees the loopback broker URL, so its own provider
 * detection (by baseURL) cannot recognise DeepSeek and falls back to OpenAI defaults:
 * `max_completion_tokens` (which the DeepSeek Chat Completions API does not list — its
 * output cap is `max_tokens`, default 64K in thinking mode), `store`, and the
 * `developer` role. The budget admission bounds output by the request's token cap, so
 * the cap must be the field the upstream actually honours.
 */
export interface RouteWireCompat {
  readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';
  readonly supportsStore: boolean;
  readonly supportsDeveloperRole: boolean;
  readonly requiresReasoningContentOnAssistantMessages: boolean;
}

const hostOf = (baseURL: string): string | null => {
  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** Known upstream families; null = no override (the kernel's own detection applies). */
export const routeWireCompat = (upstreamBaseURL: string): RouteWireCompat | null => {
  const host = hostOf(upstreamBaseURL);
  if (host !== null && (host === 'deepseek.com' || host.endsWith('.deepseek.com'))) {
    return { maxTokensField: 'max_tokens', supportsStore: false, supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true };
  }
  return null;
};

/** The single YAML line the kernel profile carries for the route (a comment when none). */
export const routeWireCompatYamlLine = (upstreamBaseURL: string): string => {
  const compat = routeWireCompat(upstreamBaseURL);
  return compat === null ? '# compat: kernel detection (no known upstream override)' : `compat: ${JSON.stringify(compat)}`;
};
