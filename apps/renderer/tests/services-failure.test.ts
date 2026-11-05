/**
 * STARTUP-VISIBLE — a failed or degraded core composition is shown to
 * the boss in Chinese with the reason; malformed payloads show nothing.
 */
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ServicesFailureBanner, readServicesFailure, servicesFailureText } from '../src/services-failure.js';

describe('services failure banner', () => {
  it('decodes only the typed codes', () => {
    expect(readServicesFailure(null)).toBeNull();
    expect(readServicesFailure({ code: 'OTHER', message: 'x' })).toBeNull();
    expect(readServicesFailure({ code: 'MODEL_PROVIDER_REFUSED', message: 'kind' })).toEqual({ code: 'MODEL_PROVIDER_REFUSED', message: 'kind' });
    expect(readServicesFailure({ code: 'CORE_SERVICES_UNAVAILABLE', message: 3 })).toEqual({ code: 'CORE_SERVICES_UNAVAILABLE', message: '' });
  });

  it('renders an alert with the reason and the remedy', () => {
    const refused = renderToString(h(ServicesFailureBanner, { failure: { code: 'MODEL_PROVIDER_REFUSED', message: '模型提供商 model.openai-compatible 未启用：…(kind)' } }));
    expect(refused).toContain('role="alert"');
    expect(refused).toContain('data-failure-code="MODEL_PROVIDER_REFUSED"');
    expect(refused).toContain('模型提供商未启用');
    expect(refused).toContain('model.openai-compatible');
    expect(servicesFailureText({ code: 'CORE_SERVICES_UNAVAILABLE', message: 'boom' }).body).toContain('boom');
    expect(renderToString(h(ServicesFailureBanner, { failure: null }))).toBe('');
  });
});
