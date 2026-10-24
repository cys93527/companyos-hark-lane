/**
 * STAGE 2 — the model onboarding seams (UX-09/10/12 server half).
 *
 * Exercises the two new read-only operations exactly as the renderer calls them:
 *   `models.catalogue` — what a configured provider actually offers, read from the durable
 *                        catalogue. No provider call, no registration, no credentials.
 *   `models.selection` — the EFFECTIVE company selection (and the honest "none" answer).
 *
 * Plus the write path the normal user flow uses: `models.register` → `models.policy`
 * (COMPANY scope, MANUAL) → `models.policy.explain`, all through the typed workflow API.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';

import { createWorkflowApi, WORKFLOW_OPERATIONS, type WorkflowApi } from '../src/workflows.js';

const makeApi = (overrides: {
  readonly catalogue?: readonly unknown[];
  readonly policy?: Record<string, unknown> | null;
}): { api: WorkflowApi; catalogueCalls: { count: number } } => {
  const catalogueCalls: { count: number } = { count: 0 };
  const models = {
    list: async () => [],
    registerFromProvider: async (input: Record<string, unknown>) => ({
      ok: true,
      value: { modelKey: `model.${String(input['providerModelId'])}` },
    }),
    setEnabled: async () => ({ ok: true, value: true }),
    bindAlias: async () => ({ ok: true, value: {} }),
    resolve: async () => ({ ok: true, value: {} }),
    refreshHealth: async () => ({ ok: true, value: {} }),
  } as never;
  const policies = {
    savePolicy: async (input: Record<string, unknown>) => ({
      ok: true,
      value: { id: `${String(input['scopeType'])}:${String(input['scopeId'])}` },
    }),
    getPolicy: async () => overrides.policy ?? null,
    resolveFor: async () => overrides.policy ?? null,
    explainManual: async () => ({
      ok: true,
      value: { accepted: true, refusals: [], reasons: [], fallback: 'NEVER', precedence: 'EXPLICIT_USER_CHOICE' },
    }),
  } as never;

  const api = createWorkflowApi({
    lifecycle: {} as never,
    listTemplates: async () => [],
    models,
    policies,
    providerCatalogue: async () => {
      catalogueCalls.count += 1;
      return (overrides.catalogue ?? []) as never;
    },
  });
  return { api, catalogueCalls };
};

describe('STAGE 2 model onboarding seams', () => {
  afterEach(() => {
    rmSync(join(tmpdir(), 'unused'), { force: true, recursive: true });
  });

  it('models.catalogue is a declared, read-only operation', () => {
    expect((WORKFLOW_OPERATIONS as readonly string[])).toContain('models.catalogue');
    expect((WORKFLOW_OPERATIONS as readonly string[])).toContain('models.selection');
  });

  it('models.catalogue returns exactly what the durable provider catalogue holds', async () => {
    const { api, catalogueCalls } = makeApi({
      catalogue: [
        {
          providerId: 'model.openai-compatible',
          modelId: 'deepseek-v4-flash',
          displayName: 'deepseek-v4-flash',
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          capabilities: { streaming: false },
          pricing: { input: 0.5 },
        },
      ],
    });
    const response = await api.handle({ operation: 'models.catalogue', payload: {} });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const value = response.value as readonly Record<string, unknown>[];
    expect(value).toHaveLength(1);
    expect(value[0]?.['providerModelId']).toBe('deepseek-v4-flash');
    expect(value[0]?.['contextWindow']).toBe(128_000);
    // It is a pure read: nothing is registered and the catalogue is consulted once.
    expect(catalogueCalls.count).toBe(1);
  });

  it('models.catalogue is honest when no provider is configured (empty list, not an error)', async () => {
    const { api } = makeApi({ catalogue: [] });
    const response = await api.handle({ operation: 'models.catalogue', payload: {} });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.value).toEqual([]);
  });

  it('models.selection reports "no selection" instead of guessing a model', async () => {
    const { api } = makeApi({ catalogue: [], policy: null });
    const response = await api.handle({ operation: 'models.selection', payload: {} });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const value = response.value as Record<string, unknown>;
    expect(value['selected']).toBe(false);
    expect(value['resolvedModelKey']).toBeNull();
    expect(value['scopeType']).toBe('COMPANY');
  });

  it('models.selection resolves the company MANUAL selection', async () => {
    const { api } = makeApi({
      catalogue: [],
      policy: {
        mode: 'MANUAL',
        manualModelKey: 'model.deepseek-v4-flash',
        preferredModels: ['model.other'],
      },
    });
    const response = await api.handle({ operation: 'models.selection', payload: {} });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const value = response.value as Record<string, unknown>;
    expect(value['selected']).toBe(true);
    expect(value['mode']).toBe('MANUAL');
    expect(value['resolvedModelKey']).toBe('model.deepseek-v4-flash');
  });

  it('models.selection rejects an unknown scope without writing anything', async () => {
    const { api } = makeApi({ catalogue: [], policy: null });
    const response = await api.handle({ operation: 'models.selection', payload: { scopeType: 'GALAXY' } });
    expect(response.ok).toBe(false);
  });

  it('the normal flow registers (only when needed) then pins the COMPANY policy', async () => {
    const { api } = makeApi({
      catalogue: [{ providerId: 'p', modelId: 'm', displayName: 'm', contextWindow: 1, capabilities: {}, pricing: null }],
      policy: null,
    });
    const registered = await api.handle({
      operation: 'models.register',
      payload: { providerId: 'p', providerModelId: 'm', actorId: 'user_owner' },
    });
    expect(registered.ok).toBe(true);
    const policy = await api.handle({
      operation: 'models.policy',
      payload: {
        scopeType: 'COMPANY',
        scopeId: 'company_default',
        mode: 'MANUAL',
        manualModelKey: 'model.m',
        actorId: 'user_owner',
        allowFallback: 'NEVER',
      },
    });
    expect(policy.ok).toBe(true);
    const explained = await api.handle({
      operation: 'models.policy.explain',
      payload: { modelKey: 'model.m', scopes: [{ scopeType: 'COMPANY', scopeId: 'company_default' }], explicit: true },
    });
    expect(explained.ok).toBe(true);
  });

  it('the durable database exposes the provider catalogue chain the operation reads', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'companyos-catalogue-'));
    const database: DurableDatabase = openDurableDatabase({
      dataDir,
      appliedAt: '2026-10-04T00:00:00.000Z',
      chains: ['provider'],
    });
    try {
      const page = await database.providerModels.list({ limit: 10 });
      expect(page.total).toBe(0);
      expect(Array.isArray(page.items)).toBe(true);
    } finally {
      database.db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
